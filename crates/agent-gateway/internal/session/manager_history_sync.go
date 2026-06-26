package session

import (
	"strings"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (m *Manager) SubscribeHistorySync() (<-chan *gatewayv1.HistorySyncEvent, func()) {
	ch := make(chan *gatewayv1.HistorySyncEvent, 32)

	m.syncHub.historyMu.Lock()
	subID := m.syncHub.nextHistorySubID
	m.syncHub.nextHistorySubID += 1
	m.syncHub.historySubscribers[subID] = ch
	m.syncHub.historyMu.Unlock()

	cleanup := func() {
		m.syncHub.historyMu.Lock()
		if _, ok := m.syncHub.historySubscribers[subID]; ok {
			// Do not close the channel here: broadcastHistorySync sends after
			// copying subscribers, so closing can race with an in-flight send.
			delete(m.syncHub.historySubscribers, subID)
		}
		m.syncHub.historyMu.Unlock()
	}

	return ch, cleanup
}

func (m *Manager) broadcastHistorySync(event *gatewayv1.HistorySyncEvent) {
	if event == nil {
		return
	}

	m.releaseCompletedChatRunAfterHistoryUpsert(event)

	m.syncHub.historyMu.Lock()
	subscribers := make([]chan *gatewayv1.HistorySyncEvent, 0, len(m.syncHub.historySubscribers))
	for _, ch := range m.syncHub.historySubscribers {
		subscribers = append(subscribers, ch)
	}
	m.syncHub.historyMu.Unlock()

	for _, ch := range subscribers {
		publishHistorySyncToSubscriber(ch, event)
	}
}

func publishHistorySyncToSubscriber(ch chan *gatewayv1.HistorySyncEvent, event *gatewayv1.HistorySyncEvent) {
	if ch == nil || event == nil {
		return
	}
	select {
	case ch <- event:
		return
	default:
	}
	if !isCriticalHistorySyncEvent(event) {
		return
	}
	retained := drainCriticalHistorySyncEvents(ch)
	if maxRetained := cap(ch) - 1; maxRetained > 0 && len(retained) > maxRetained {
		retained = retained[len(retained)-maxRetained:]
	}
	retained = append(retained, event)
	for _, retainedEvent := range retained {
		select {
		case ch <- retainedEvent:
		default:
			return
		}
	}
}

func drainCriticalHistorySyncEvents(ch chan *gatewayv1.HistorySyncEvent) []*gatewayv1.HistorySyncEvent {
	retained := make([]*gatewayv1.HistorySyncEvent, 0)
	for {
		select {
		case pending := <-ch:
			if isCriticalHistorySyncEvent(pending) {
				retained = append(retained, pending)
			}
		default:
			return retained
		}
	}
}

func isCriticalHistorySyncEvent(event *gatewayv1.HistorySyncEvent) bool {
	if event == nil {
		return false
	}
	switch strings.TrimSpace(event.GetKind()) {
	case "running", "idle", "queue_drained":
		return true
	default:
		return false
	}
}

func (m *Manager) broadcastChatRunActivity(
	kind string,
	conversationID string,
	workdir string,
	runID string,
	firstSeq int64,
	latestSeq int64,
	runEpoch int64,
	state string,
	updatedAt time.Time,
) {
	kind = strings.TrimSpace(kind)
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return
	}
	if kind != "running" && kind != "idle" && kind != "queue_drained" {
		return
	}
	if updatedAt.IsZero() {
		updatedAt = time.Now()
	}

	event := &gatewayv1.HistorySyncEvent{
		Kind:           kind,
		ConversationId: conversationID,
		RunId:          strings.TrimSpace(runID),
		FirstSeq:       firstSeq,
		LatestSeq:      latestSeq,
		RunEpoch:       runEpoch,
		UpdatedAt:      updatedAt.UnixMilli(),
		State:          normalizeChatRunState(state),
	}
	if workdir = strings.TrimSpace(workdir); workdir != "" {
		event.Conversation = &gatewayv1.ConversationSummary{
			Id:        conversationID,
			Cwd:       workdir,
			UpdatedAt: updatedAt.UnixMilli(),
		}
	}
	m.broadcastHistorySync(event)
}

func historySyncConversationID(event *gatewayv1.HistorySyncEvent) string {
	conversationID := strings.TrimSpace(event.GetConversationId())
	if conversationID == "" && event.GetConversation() != nil {
		conversationID = strings.TrimSpace(event.GetConversation().GetId())
	}
	return conversationID
}

func (m *Manager) releaseCompletedChatRunAfterHistoryUpsert(event *gatewayv1.HistorySyncEvent) {
	if strings.TrimSpace(event.GetKind()) != "upsert" {
		return
	}

	conversationID := historySyncConversationID(event)
	if conversationID == "" {
		return
	}

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	requestID := m.chatStore.chatRunByConversation[conversationID]
	run := m.chatStore.chatRuns[requestID]
	if run == nil || !run.done {
		return
	}
	m.releaseCompletedChatRunLocked(requestID, run)
}
