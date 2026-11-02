package session

import (
	"sort"
	"strings"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"google.golang.org/protobuf/proto"
)

const historySubscriberBuffer = 128
const maxHistorySnapshotBytes = 64 << 20
const maxHistoryConversations = 100_000

type historySyncState struct {
	sourceID          string
	generation        string
	latestSeq         uint64
	available         bool
	conversations     map[string]*gatewayv2.ConversationSummary
	conversationBytes int
}

type historyPendingCut struct {
	generation string
	cut        uint64
}

// HistorySyncSubscription separates lossy data events from recovery status.
// A full data queue always emits needs_resync on the status channel.
type HistorySyncSubscription struct {
	Events      <-chan Tagged[*gatewayv2.HistorySyncEvent]
	Status      <-chan Tagged[*gatewayv2.HistorySyncStatus]
	Acknowledge func(agentID, generation string, appliedSeq uint64)
	Cleanup     func()
}

func cloneConversation(summary *gatewayv2.ConversationSummary) *gatewayv2.ConversationSummary {
	if summary == nil {
		return nil
	}
	return proto.Clone(summary).(*gatewayv2.ConversationSummary)
}

func cloneHistoryEvent(event *gatewayv2.HistorySyncEvent) *gatewayv2.HistorySyncEvent {
	if event == nil {
		return nil
	}
	return proto.Clone(event).(*gatewayv2.HistorySyncEvent)
}

func cloneHistoryStatus(status *gatewayv2.HistorySyncStatus) *gatewayv2.HistorySyncStatus {
	if status == nil {
		return nil
	}
	return proto.Clone(status).(*gatewayv2.HistorySyncStatus)
}

func cloneHistorySnapshot(snapshot *gatewayv2.HistorySyncSnapshot) *gatewayv2.HistorySyncSnapshot {
	if snapshot == nil {
		return nil
	}
	return proto.Clone(snapshot).(*gatewayv2.HistorySyncSnapshot)
}

func (m *Manager) SubscribeHistorySync() (<-chan Tagged[*gatewayv2.HistorySyncEvent], func()) {
	sub := m.SubscribeHistorySyncRecovery()
	return sub.Events, sub.Cleanup
}

func (m *Manager) SubscribeHistorySyncRecovery() *HistorySyncSubscription {
	events := make(chan Tagged[*gatewayv2.HistorySyncEvent], historySubscriberBuffer)
	status := make(chan Tagged[*gatewayv2.HistorySyncStatus], 8)

	m.syncHub.historyMu.Lock()
	subID := m.syncHub.nextHistorySubID
	m.syncHub.nextHistorySubID++
	m.syncHub.historySubscribers[subID] = events
	m.syncHub.historyStatusSubs[subID] = status
	m.syncHub.historyMu.Unlock()

	cleanup := func() {
		m.syncHub.historyMu.Lock()
		// Channels are deliberately not closed: a broadcaster can retain a
		// copied channel briefly after this subscription is removed.
		delete(m.syncHub.historySubscribers, subID)
		delete(m.syncHub.historyStatusSubs, subID)
		delete(m.syncHub.historyResyncPending, subID)
		m.syncHub.historyMu.Unlock()
	}

	acknowledge := func(agentID, generation string, appliedSeq uint64) {
		m.syncHub.historyMu.Lock()
		if pending := m.syncHub.historyResyncPending[subID]; pending != nil {
			agentID = strings.TrimSpace(agentID)
			cut, ok := pending[agentID]
			if ok && cut.generation == strings.TrimSpace(generation) && appliedSeq >= cut.cut {
				delete(pending, agentID)
			}
			if len(pending) == 0 {
				delete(m.syncHub.historyResyncPending, subID)
			}
		}
		m.syncHub.historyMu.Unlock()
	}
	return &HistorySyncSubscription{Events: events, Status: status, Acknowledge: acknowledge, Cleanup: cleanup}
}

func (m *Manager) historyStateLocked(agentID string) *historySyncState {
	state := m.syncHub.historyStates[agentID]
	if state == nil {
		state = &historySyncState{conversations: make(map[string]*gatewayv2.ConversationSummary)}
		m.syncHub.historyStates[agentID] = state
	}
	return state
}

func normalizeHistoryIdentity(agentID, sourceID, generation string) (string, string) {
	sourceID = strings.TrimSpace(sourceID)
	if sourceID == "" {
		sourceID = strings.TrimSpace(agentID)
	}
	generation = strings.TrimSpace(generation)
	if generation == "" {
		generation = "legacy"
	}
	return sourceID, generation
}

func (m *Manager) broadcastHistorySync(agentID string, incoming *gatewayv2.HistorySyncEvent) {
	if incoming == nil {
		return
	}

	m.syncHub.historyMu.Lock()
	state := m.historyStateLocked(agentID)
	event := cloneHistoryEvent(incoming)
	event.SourceId, event.Generation = normalizeHistoryIdentity(agentID, event.SourceId, event.Generation)
	// Legacy SQLite mutation broadcasts can race with the v2 K-brain
	// coordinator for the same desktop Agent. Once a complete v2 authority is
	// installed, only that producer may advance its generation and sequence.
	if event.Generation == "legacy" && state.available && state.generation != "" && state.generation != "legacy" {
		m.syncHub.historyMu.Unlock()
		return
	}
	if event.DeliverySeq == 0 {
		event.DeliverySeq = state.latestSeq + 1
	}
	if event.Generation != "legacy" && (state.generation == "" || state.generation != event.Generation || !state.available) {
		m.syncHub.historyMu.Unlock()
		return
	}
	if event.DeliverySeq <= state.latestSeq {
		m.syncHub.historyMu.Unlock()
		return
	}
	if event.Generation != "legacy" && event.DeliverySeq != state.latestSeq+1 {
		state.available = false
		state.conversations = make(map[string]*gatewayv2.ConversationSummary)
		state.conversationBytes = 0
		for subID := range m.syncHub.historySubscribers {
			m.signalHistoryResetLocked(subID, agentID, state, event.SourceId)
		}
		m.syncHub.historyMu.Unlock()
		go m.DisconnectAgent(agentID)
		return
	}
	state.generation = event.Generation
	state.sourceID = event.SourceId
	state.latestSeq = event.DeliverySeq
	conversationID := strings.TrimSpace(event.GetConversationId())
	switch strings.TrimSpace(event.GetKind()) {
	case "delete":
		state.conversationBytes -= proto.Size(state.conversations[conversationID])
		if state.conversationBytes < 0 {
			state.conversationBytes = 0
		}
		delete(state.conversations, conversationID)
	case "upsert":
		if conversationID != "" && event.GetConversation() != nil {
			previous := state.conversations[conversationID]
			nextBytes := state.conversationBytes - proto.Size(previous) + proto.Size(event.GetConversation())
			_, exists := state.conversations[conversationID]
			if nextBytes > maxHistorySnapshotBytes || (!exists && len(state.conversations) >= maxHistoryConversations) {
				state.available = false
				state.conversations = make(map[string]*gatewayv2.ConversationSummary)
				state.conversationBytes = 0
				for subID := range m.syncHub.historySubscribers {
					m.signalHistoryResetLocked(subID, agentID, state, event.SourceId)
				}
				m.syncHub.historyMu.Unlock()
				go m.DisconnectAgent(agentID)
				return
			}
			state.conversations[conversationID] = cloneConversation(event.GetConversation())
			state.conversationBytes = nextBytes
		}
	}

	tagged := Tagged[*gatewayv2.HistorySyncEvent]{AgentID: agentID, Event: event}
	for subID, ch := range m.syncHub.historySubscribers {
		select {
		case ch <- tagged:
		default:
			m.signalHistoryResetLocked(subID, agentID, state, event.SourceId)
		}
	}
	m.syncHub.historyMu.Unlock()
}

func (m *Manager) signalHistoryResetLocked(subID int, agentID string, state *historySyncState, sourceID string) {
	ch := m.syncHub.historyStatusSubs[subID]
	if ch == nil {
		return
	}
	status := &gatewayv2.HistorySyncStatus{
		SourceId:          sourceID,
		Generation:        state.generation,
		LatestDeliverySeq: state.latestSeq,
		Available:         state.available,
		NeedsResync:       true,
	}
	if m.syncHub.historyResyncPending[subID] == nil {
		m.syncHub.historyResyncPending[subID] = make(map[string]historyPendingCut)
	}
	m.syncHub.historyResyncPending[subID][agentID] = historyPendingCut{generation: state.generation, cut: state.latestSeq}
	enqueueLatestHistoryStatus(ch, Tagged[*gatewayv2.HistorySyncStatus]{AgentID: agentID, Event: status})
}

func enqueueLatestHistoryStatus(ch chan Tagged[*gatewayv2.HistorySyncStatus], status Tagged[*gatewayv2.HistorySyncStatus]) {
	select {
	case ch <- status:
		return
	default:
	}
	select {
	case <-ch:
	default:
	}
	select {
	case ch <- status:
	default:
	}
}

func (m *Manager) updateHistorySyncStatus(agentID string, incoming *gatewayv2.HistorySyncStatus) {
	if incoming == nil {
		return
	}
	m.syncHub.historyMu.Lock()
	state := m.historyStateLocked(agentID)
	status := cloneHistoryStatus(incoming)
	status.SourceId, status.Generation = normalizeHistoryIdentity(agentID, status.SourceId, status.Generation)
	if state.generation != "" && state.generation != status.Generation {
		if status.Available {
			m.syncHub.historyMu.Unlock()
			return
		}
		state.generation = status.Generation
		state.sourceID = status.SourceId
		state.latestSeq = status.LatestDeliverySeq
		state.available = false
		state.conversations = make(map[string]*gatewayv2.ConversationSummary)
		state.conversationBytes = 0
	}
	if status.Available && state.available && status.LatestDeliverySeq > state.latestSeq {
		state.available = false
		state.conversations = make(map[string]*gatewayv2.ConversationSummary)
		state.conversationBytes = 0
		for subID := range m.syncHub.historySubscribers {
			m.signalHistoryResetLocked(subID, agentID, state, status.SourceId)
		}
		m.syncHub.historyMu.Unlock()
		go m.DisconnectAgent(agentID)
		return
	}
	if status.LatestDeliverySeq < state.latestSeq {
		m.syncHub.historyMu.Unlock()
		return
	}
	state.generation = status.Generation
	state.sourceID = status.SourceId
	if status.LatestDeliverySeq > state.latestSeq {
		state.latestSeq = status.LatestDeliverySeq
	}
	if !status.Available {
		state.available = false
		state.conversations = make(map[string]*gatewayv2.ConversationSummary)
		state.conversationBytes = 0
	}
	// A heartbeat cannot make a partial projection authoritative.
	status.Available = status.Available && state.available
	for subID, ch := range m.syncHub.historyStatusSubs {
		out := cloneHistoryStatus(status)
		if status.NeedsResync {
			if m.syncHub.historyResyncPending[subID] == nil {
				m.syncHub.historyResyncPending[subID] = make(map[string]historyPendingCut)
			}
			m.syncHub.historyResyncPending[subID][agentID] = historyPendingCut{generation: status.Generation, cut: status.LatestDeliverySeq}
		}
		if _, pending := m.syncHub.historyResyncPending[subID][agentID]; pending {
			out.NeedsResync = true
		}
		enqueueLatestHistoryStatus(ch, Tagged[*gatewayv2.HistorySyncStatus]{AgentID: agentID, Event: out})
	}
	m.syncHub.historyMu.Unlock()
}

func (m *Manager) updateHistorySyncSnapshot(agentID string, incoming *gatewayv2.HistorySyncSnapshot) {
	if incoming == nil {
		return
	}
	if proto.Size(incoming) > maxHistorySnapshotBytes || len(incoming.GetConversations()) > maxHistoryConversations {
		m.updateHistorySyncStatus(agentID, &gatewayv2.HistorySyncStatus{
			SourceId: incoming.GetSourceId(), Generation: incoming.GetGeneration(),
			LatestDeliverySeq: incoming.GetCutDeliverySeq(), NeedsResync: true,
		})
		return
	}
	snapshot := cloneHistorySnapshot(incoming)
	snapshot.SourceId, snapshot.Generation = normalizeHistoryIdentity(agentID, snapshot.SourceId, snapshot.Generation)

	m.syncHub.historyMu.Lock()
	state := m.historyStateLocked(agentID)
	if state.generation == snapshot.Generation && snapshot.CutDeliverySeq < state.latestSeq {
		m.syncHub.historyMu.Unlock()
		return
	}
	state.generation = snapshot.Generation
	state.sourceID = snapshot.SourceId
	state.latestSeq = snapshot.CutDeliverySeq
	state.available = true
	state.conversations = make(map[string]*gatewayv2.ConversationSummary, len(snapshot.Conversations))
	state.conversationBytes = 0
	for _, summary := range snapshot.Conversations {
		id := strings.TrimSpace(summary.GetId())
		if id != "" {
			state.conversations[id] = cloneConversation(summary)
			state.conversationBytes += proto.Size(summary)
		}
	}
	status := &gatewayv2.HistorySyncStatus{
		SourceId:          snapshot.SourceId,
		Generation:        snapshot.Generation,
		LatestDeliverySeq: snapshot.CutDeliverySeq,
		Available:         true,
		NeedsResync:       true,
	}
	for subID, ch := range m.syncHub.historyStatusSubs {
		if m.syncHub.historyResyncPending[subID] == nil {
			m.syncHub.historyResyncPending[subID] = make(map[string]historyPendingCut)
		}
		m.syncHub.historyResyncPending[subID][agentID] = historyPendingCut{generation: snapshot.Generation, cut: snapshot.CutDeliverySeq}
		enqueueLatestHistoryStatus(ch, Tagged[*gatewayv2.HistorySyncStatus]{AgentID: agentID, Event: cloneHistoryStatus(status)})
	}
	m.syncHub.historyMu.Unlock()
}

// HistorySyncSnapshot returns a deterministic authoritative projection for a
// browser recovery. Workdir summaries are recomputed from the same cut.
func (m *Manager) HistorySyncSnapshot(agentID, token string) (*gatewayv2.HistorySyncSnapshot, bool) {
	m.syncHub.historyMu.Lock()
	defer m.syncHub.historyMu.Unlock()
	state := m.syncHub.historyStates[strings.TrimSpace(agentID)]
	if state == nil || !state.available {
		return nil, false
	}

	conversations := make([]*gatewayv2.ConversationSummary, 0, len(state.conversations))
	for _, summary := range state.conversations {
		conversations = append(conversations, cloneConversation(summary))
	}
	sort.Slice(conversations, func(i, j int) bool {
		if conversations[i].GetUpdatedAt() != conversations[j].GetUpdatedAt() {
			return conversations[i].GetUpdatedAt() > conversations[j].GetUpdatedAt()
		}
		return conversations[i].GetId() < conversations[j].GetId()
	})

	type aggregate struct {
		count int32
		at    int64
	}
	workdirMap := make(map[string]aggregate)
	for _, summary := range conversations {
		cwd := strings.TrimSpace(summary.GetCwd())
		if cwd == "" {
			continue
		}
		item := workdirMap[cwd]
		item.count++
		if summary.GetUpdatedAt() > item.at {
			item.at = summary.GetUpdatedAt()
		}
		workdirMap[cwd] = item
	}
	workdirs := make([]*gatewayv2.HistoryWorkdirSummary, 0, len(workdirMap))
	for path, item := range workdirMap {
		workdirs = append(workdirs, &gatewayv2.HistoryWorkdirSummary{Path: path, ConversationCount: item.count, UpdatedAt: item.at})
	}
	sort.Slice(workdirs, func(i, j int) bool { return workdirs[i].GetPath() < workdirs[j].GetPath() })

	return &gatewayv2.HistorySyncSnapshot{
		SourceId:       state.sourceID,
		Generation:     state.generation,
		CutDeliverySeq: state.latestSeq,
		ResyncToken:    strings.TrimSpace(token),
		Conversations:  conversations,
		Workdirs:       workdirs,
		TotalCount:     uint32(len(conversations)),
	}, true
}

func (m *Manager) IngestRemoteHistoryEvent(agentID string, event *gatewayv2.HistorySyncEvent) {
	m.broadcastHistorySync(agentID, event)
}

func (m *Manager) IngestRemoteHistoryStatus(agentID string, status *gatewayv2.HistorySyncStatus) {
	m.updateHistorySyncStatus(agentID, status)
}

func (m *Manager) IngestRemoteHistorySnapshot(agentID string, snapshot *gatewayv2.HistorySyncSnapshot) {
	m.updateHistorySyncSnapshot(agentID, snapshot)
}

func (m *Manager) ClearHistorySyncState(agentID string) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return
	}
	m.syncHub.historyMu.Lock()
	delete(m.syncHub.historyStates, agentID)
	for _, pending := range m.syncHub.historyResyncPending {
		delete(pending, agentID)
	}
	m.syncHub.historyMu.Unlock()
}
