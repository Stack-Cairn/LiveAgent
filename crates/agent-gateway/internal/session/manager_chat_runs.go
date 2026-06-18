package session

import (
	"encoding/json"
	"log"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (m *Manager) StartPendingChatCommandRun(
	requestID string,
	conversationID string,
	clientRequestID string,
	workdirInput ...string,
) (ChatRunSnapshot, bool, error) {
	return m.startPendingChatCommandRun(requestID, conversationID, clientRequestID, workdirInput...)
}

func (m *Manager) StartAcceptedChatCommandRun(
	requestID string,
	conversationID string,
	clientRequestID string,
	workdir string,
	initialPayloads []map[string]any,
) (ChatRunSnapshot, bool, int64, error) {
	m.chatStore.chatCommandMu.Lock()
	defer m.chatStore.chatCommandMu.Unlock()

	snapshot, created, err := m.startPendingChatCommandRun(
		requestID,
		conversationID,
		clientRequestID,
		workdir,
	)
	if err != nil || !created {
		return snapshot, created, snapshot.LatestSeq, err
	}

	m.MarkChatRunControl(snapshot.RequestID, conversationID, "accepted", "", "")
	acceptedSeq := snapshot.LatestSeq
	if acceptedSnapshot, ok := m.ChatRunSnapshot(snapshot.RequestID, conversationID); ok {
		snapshot = acceptedSnapshot
		acceptedSeq = acceptedSnapshot.LatestSeq
	}
	if len(initialPayloads) > 0 {
		m.MarkChatRunPayloads(snapshot.RequestID, conversationID, initialPayloads)
		if nextSnapshot, ok := m.ChatRunSnapshot(snapshot.RequestID, conversationID); ok {
			snapshot = nextSnapshot
		}
	}
	return snapshot, true, acceptedSeq, nil
}

func (m *Manager) startPendingChatCommandRun(
	requestID string,
	conversationID string,
	clientRequestID string,
	workdirInput ...string,
) (ChatRunSnapshot, bool, error) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return ChatRunSnapshot{}, false, ErrChatRunNotFound
	}

	now := time.Now()
	conversationID = strings.TrimSpace(conversationID)
	clientRequestID = strings.TrimSpace(clientRequestID)
	workdir := ""
	if len(workdirInput) > 0 {
		workdir = strings.TrimSpace(workdirInput[0])
	}
	sessionEpoch := m.currentSessionEpoch()
	if store := m.chatStore.eventStore; store != nil {
		snapshot, created, err := store.StartRun(ChatRunStoreStart{
			RequestID:       requestID,
			ConversationID:  conversationID,
			ClientRequestID: clientRequestID,
			Workdir:         workdir,
			CreatedAt:       now,
		})
		if err != nil {
			return ChatRunSnapshot{}, false, err
		}
		m.chatStore.chatMu.Lock()
		defer m.chatStore.chatMu.Unlock()
		m.pruneExpiredChatRunsLocked(now)
		if created {
			if latestSeq := m.latestConversationSeqLocked(conversationID); latestSeq > snapshot.LatestSeq {
				snapshot.LatestSeq = latestSeq
			}
		}
		run := m.upsertChatRunSnapshotLocked(snapshot, sessionEpoch, now)
		if run == nil {
			return snapshot, created, nil
		}
		return run.snapshot(), created, nil
	}

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	m.pruneExpiredChatRunsLocked(now)

	if clientRequestID != "" {
		if existingRequestID := m.chatStore.chatRunByClientRequest[clientRequestID]; existingRequestID != "" {
			if existing := m.chatStore.chatRuns[existingRequestID]; existing != nil {
				if !existing.done {
					if workdir != "" && existing.workdir == "" {
						existing.workdir = workdir
					}
					return existing.snapshot(), false, nil
				}
				m.releaseCompletedChatRunLocked(existingRequestID, existing)
			}
			delete(m.chatStore.chatRunByClientRequest, clientRequestID)
		}
	}

	if existing := m.chatStore.chatRuns[requestID]; existing != nil {
		m.removeChatRunLocked(requestID, existing)
	}

	m.chatStore.nextChatRunEpoch += 1
	latestSeq := m.latestConversationSeqLocked(conversationID)
	run := &chatRun{
		requestID:       requestID,
		conversationID:  conversationID,
		clientRequestID: clientRequestID,
		workdir:         workdir,
		sessionEpoch:    sessionEpoch,
		runEpoch:        m.chatStore.nextChatRunEpoch,
		state:           ChatRunStateQueued,
		nextSeq:         latestSeq,
		updatedAt:       now,
		subscribers:     make(map[int]*chatRunSubscriber),
	}
	run.applyState(ChatRunStateQueued)
	m.chatStore.chatRuns[requestID] = run
	if conversationID != "" {
		m.chatStore.chatRunByConversation[conversationID] = requestID
	}
	if clientRequestID != "" {
		m.chatStore.chatRunByClientRequest[clientRequestID] = requestID
	}

	return run.snapshot(), true, nil
}

func (m *Manager) latestConversationSeqLocked(conversationID string) int64 {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return 0
	}
	var latestSeq int64
	for _, run := range m.chatStore.chatRuns {
		if run == nil || strings.TrimSpace(run.conversationID) != conversationID {
			continue
		}
		if run.nextSeq > latestSeq {
			latestSeq = run.nextSeq
		}
	}
	return latestSeq
}

func (m *Manager) upsertChatRunSnapshotLocked(
	snapshot ChatRunSnapshot,
	sessionEpoch uint64,
	now time.Time,
) *chatRun {
	requestID := strings.TrimSpace(snapshot.RequestID)
	if requestID == "" {
		return nil
	}
	if existing := m.chatStore.chatRuns[requestID]; existing != nil {
		m.applyChatRunSnapshotLocked(existing, snapshot, now)
		return existing
	}
	if snapshot.RunEpoch > m.chatStore.nextChatRunEpoch {
		m.chatStore.nextChatRunEpoch = snapshot.RunEpoch
	}
	run := &chatRun{
		requestID:       requestID,
		conversationID:  strings.TrimSpace(snapshot.ConversationID),
		clientRequestID: strings.TrimSpace(snapshot.ClientRequestID),
		workdir:         strings.TrimSpace(snapshot.Workdir),
		sessionEpoch:    sessionEpoch,
		runEpoch:        snapshot.RunEpoch,
		state:           normalizeChatRunState(snapshot.State),
		errorCode:       strings.TrimSpace(snapshot.ErrorCode),
		nextSeq:         snapshot.LatestSeq,
		updatedAt:       now,
		subscribers:     make(map[int]*chatRunSubscriber),
	}
	if run.runEpoch <= 0 {
		m.chatStore.nextChatRunEpoch += 1
		run.runEpoch = m.chatStore.nextChatRunEpoch
	}
	run.applyState(run.state)
	if snapshot.Done {
		run.applyState(ChatRunStateCompleted)
		if snapshot.State == ChatRunStateFailed {
			run.applyState(ChatRunStateFailed)
			run.errorCode = strings.TrimSpace(snapshot.ErrorCode)
		} else if snapshot.State == ChatRunStateCancelled {
			run.applyState(ChatRunStateCancelled)
		}
	}
	m.chatStore.chatRuns[requestID] = run
	if run.conversationID != "" {
		m.chatStore.chatRunByConversation[run.conversationID] = requestID
	}
	if run.clientRequestID != "" {
		m.chatStore.chatRunByClientRequest[run.clientRequestID] = requestID
	}
	return run
}

func (m *Manager) applyChatRunSnapshotLocked(run *chatRun, snapshot ChatRunSnapshot, now time.Time) {
	if run == nil {
		return
	}
	requestID := strings.TrimSpace(snapshot.RequestID)
	if requestID == "" {
		requestID = run.requestID
	}
	conversationID := strings.TrimSpace(snapshot.ConversationID)
	if conversationID != "" {
		if run.conversationID != "" && run.conversationID != conversationID {
			if m.chatStore.chatRunByConversation[run.conversationID] == requestID {
				delete(m.chatStore.chatRunByConversation, run.conversationID)
			}
		}
		run.conversationID = conversationID
		m.chatStore.chatRunByConversation[conversationID] = requestID
	}
	if clientRequestID := strings.TrimSpace(snapshot.ClientRequestID); clientRequestID != "" {
		run.clientRequestID = clientRequestID
		m.chatStore.chatRunByClientRequest[clientRequestID] = requestID
	}
	if workdir := strings.TrimSpace(snapshot.Workdir); workdir != "" {
		run.workdir = workdir
	}
	if snapshot.RunEpoch > 0 {
		run.runEpoch = snapshot.RunEpoch
		if snapshot.RunEpoch > m.chatStore.nextChatRunEpoch {
			m.chatStore.nextChatRunEpoch = snapshot.RunEpoch
		}
	}
	if snapshot.LatestSeq > run.nextSeq {
		run.nextSeq = snapshot.LatestSeq
	}
	if state := normalizeChatRunState(snapshot.State); state != "" {
		run.applyState(state)
	}
	if snapshot.Done && !run.done {
		run.applyState(ChatRunStateCompleted)
	}
	if snapshot.ErrorCode != "" {
		run.errorCode = strings.TrimSpace(snapshot.ErrorCode)
	}
	run.updatedAt = now
}

func (m *Manager) RemoveChatRun(requestID string) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		return
	}
	m.removeChatRunLocked(requestID, run)
}

func (m *Manager) RemoveChatRunByConversation(conversationID string) {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return
	}

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	requestID := m.chatStore.chatRunByConversation[conversationID]
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		for candidateRequestID, candidateRun := range m.chatStore.chatRuns {
			if strings.TrimSpace(candidateRun.conversationID) == conversationID {
				requestID = candidateRequestID
				run = candidateRun
				break
			}
		}
	}
	if run == nil {
		return
	}
	m.removeChatRunLocked(requestID, run)
}

func (m *Manager) ActiveChatRunSummaries() []ActiveChatRunSummary {
	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	now := time.Now()
	m.pruneExpiredChatRunsLocked(now)

	seen := make(map[string]int, len(m.chatStore.chatRuns)+len(m.chatStore.historyActiveRuns))
	summaries := make([]ActiveChatRunSummary, 0, len(m.chatStore.chatRuns)+len(m.chatStore.historyActiveRuns))
	for _, run := range m.chatStore.chatRuns {
		if run == nil || run.done || normalizeChatRunState(run.state) != ChatRunStateRunning {
			continue
		}
		conversationID := strings.TrimSpace(run.conversationID)
		if conversationID == "" {
			continue
		}
		summary := ActiveChatRunSummary{
			ConversationID: conversationID,
			RequestID:      strings.TrimSpace(run.requestID),
			Workdir:        strings.TrimSpace(run.workdir),
			FirstSeq:       run.snapshot().FirstSeq,
			LatestSeq:      run.nextSeq,
			RunEpoch:       run.runEpoch,
			UpdatedAt:      run.updatedAt.UnixMilli(),
		}
		if index, ok := seen[conversationID]; ok {
			if summaries[index].Workdir == "" {
				summaries[index].Workdir = summary.Workdir
			}
			if summary.UpdatedAt > summaries[index].UpdatedAt {
				summaries[index].RequestID = summary.RequestID
				summaries[index].FirstSeq = summary.FirstSeq
				summaries[index].LatestSeq = summary.LatestSeq
				summaries[index].RunEpoch = summary.RunEpoch
				summaries[index].UpdatedAt = summary.UpdatedAt
			}
			continue
		}
		seen[conversationID] = len(summaries)
		summaries = append(summaries, summary)
	}

	for conversationID, run := range m.chatStore.historyActiveRuns {
		conversationID = strings.TrimSpace(conversationID)
		if conversationID == "" {
			continue
		}
		if now.Sub(run.updatedAt) > chatRunStaleRetention {
			delete(m.chatStore.historyActiveRuns, conversationID)
			continue
		}
		workdir := strings.TrimSpace(run.workdir)
		updatedAt := run.updatedAt.UnixMilli()
		if index, ok := seen[conversationID]; ok {
			if summaries[index].Workdir == "" {
				summaries[index].Workdir = workdir
			}
			if updatedAt > summaries[index].UpdatedAt {
				summaries[index].UpdatedAt = updatedAt
			}
			continue
		}
		seen[conversationID] = len(summaries)
		summaries = append(summaries, ActiveChatRunSummary{
			ConversationID: conversationID,
			Workdir:        workdir,
			UpdatedAt:      updatedAt,
		})
	}

	sort.Slice(summaries, func(i, j int) bool {
		return summaries[i].ConversationID < summaries[j].ConversationID
	})
	return summaries
}

func (m *Manager) ActiveChatRunConversationIDs() []string {
	summaries := m.ActiveChatRunSummaries()
	ids := make([]string, 0, len(summaries))
	for _, summary := range summaries {
		if conversationID := strings.TrimSpace(summary.ConversationID); conversationID != "" {
			ids = append(ids, conversationID)
		}
	}
	return ids
}

func (m *Manager) failOpenChatRunsForSessionEpoch(sessionEpoch uint64, message string) {
	message = strings.TrimSpace(message)
	if message == "" {
		message = agentDisconnectedChatRunMessage
	}

	data, err := json.Marshal(map[string]string{"message": message})
	if err != nil {
		data = []byte(`{"message":"Desktop agent disconnected. Please retry."}`)
	}
	now := time.Now()

	type broadcastTarget struct {
		events      []*ChatBroadcastEvent
		subscribers []*chatRunSubscriber
		persist     ChatRunEventAppend
	}
	targets := make([]broadcastTarget, 0)

	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	for requestID, run := range m.chatStore.chatRuns {
		if run == nil || run.done || run.sessionEpoch != sessionEpoch {
			continue
		}

		run.nextSeq += 1
		run.updatedAt = now
		run.applyState(ChatRunStateFailed)
		run.errorCode = "agent_disconnected"
		run.expiresAt = now.Add(chatRunDoneRetention)

		chatEvent := &gatewayv1.ChatEvent{
			Type:           gatewayv1.ChatEvent_ERROR,
			ConversationId: strings.TrimSpace(run.conversationID),
			Data:           string(data),
		}
		broadcast := &ChatBroadcastEvent{
			RequestID: requestID,
			Event:     chatEvent,
			Seq:       run.nextSeq,
			Workdir:   strings.TrimSpace(run.workdir),
		}
		run.appendEvent(broadcast)
		persist := chatRunEventAppendSnapshot(run, broadcast, now)

		subscribers := make([]*chatRunSubscriber, 0, len(run.subscribers))
		for _, subscriber := range run.subscribers {
			subscribers = append(subscribers, subscriber)
		}
		targets = append(targets, broadcastTarget{
			events:      []*ChatBroadcastEvent{broadcast},
			subscribers: subscribers,
			persist:     persist,
		})
	}
	m.chatStore.chatMu.Unlock()

	for _, target := range targets {
		m.persistChatBroadcast(target.persist)
		for _, subscriber := range target.subscribers {
			for _, event := range target.events {
				select {
				case <-subscriber.done:
				case subscriber.ch <- cloneChatBroadcastEvent(event):
				}
			}
		}
	}
}

func (m *Manager) FailStartingChatRun(requestID string, message string) bool {
	failed, sessionEpoch := m.failChatRunIf(
		requestID,
		message,
		"Desktop backend did not accept the remote chat request. Please retry.",
		func(run *chatRun) bool {
			if run == nil || run.done {
				return false
			}
			state := normalizeChatRunState(run.state)
			return state == ChatRunStateQueued
		},
	)
	if failed {
		m.ClearSessionForEpoch(sessionEpoch)
	}
	return failed
}

func (m *Manager) FailUnstartedChatRun(requestID string, message string) bool {
	failed, _ := m.failChatRunIf(
		requestID,
		message,
		"Desktop app accepted the remote chat request but did not start it. Please retry.",
		func(run *chatRun) bool {
			if run == nil || run.done {
				return false
			}
			state := normalizeChatRunState(run.state)
			return state != ChatRunStateQueued &&
				state != ChatRunStateRunning &&
				!isTerminalChatRunState(state)
		},
	)
	return failed
}

func (m *Manager) failChatRunIf(
	requestID string,
	message string,
	defaultMessage string,
	shouldFail func(*chatRun) bool,
) (bool, uint64) {
	requestID = strings.TrimSpace(requestID)
	message = strings.TrimSpace(message)
	if requestID == "" {
		return false, 0
	}
	if message == "" {
		message = defaultMessage
	}

	data, err := json.Marshal(map[string]string{"message": message})
	if err != nil {
		fallback, marshalErr := json.Marshal(map[string]string{"message": defaultMessage})
		if marshalErr != nil {
			fallback = []byte(`{"message":"Remote chat request failed. Please retry."}`)
		}
		data = fallback
	}

	now := time.Now()
	var broadcast *ChatBroadcastEvent
	var persist ChatRunEventAppend
	var runSubscribers []*chatRunSubscriber

	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	run := m.chatStore.chatRuns[requestID]
	if shouldFail == nil || !shouldFail(run) {
		m.chatStore.chatMu.Unlock()
		return false, 0
	}
	sessionEpoch := run.sessionEpoch

	run.nextSeq += 1
	run.updatedAt = now
	run.applyState(ChatRunStateFailed)
	run.errorCode = "desktop_runtime_unavailable"
	run.expiresAt = now.Add(chatRunDoneRetention)
	chatEvent := &gatewayv1.ChatEvent{
		Type:           gatewayv1.ChatEvent_ERROR,
		ConversationId: strings.TrimSpace(run.conversationID),
		Data:           string(data),
	}
	broadcast = &ChatBroadcastEvent{
		RequestID: requestID,
		Event:     chatEvent,
		Seq:       run.nextSeq,
		Workdir:   strings.TrimSpace(run.workdir),
	}
	run.appendEvent(broadcast)
	persist = chatRunEventAppendSnapshot(run, broadcast, now)
	runSubscribers = make([]*chatRunSubscriber, 0, len(run.subscribers))
	for _, subscriber := range run.subscribers {
		runSubscribers = append(runSubscribers, subscriber)
	}
	m.chatStore.chatMu.Unlock()

	m.persistChatBroadcast(persist)
	for _, subscriber := range runSubscribers {
		select {
		case <-subscriber.done:
		case subscriber.ch <- cloneChatBroadcastEvent(broadcast):
		}
	}
	return true, sessionEpoch
}

func (m *Manager) SubscribeChatRun(
	requestID string,
	conversationID string,
	afterSeq int64,
) (<-chan *ChatBroadcastEvent, <-chan struct{}, func(), ChatRunSnapshot, error) {
	requestID = strings.TrimSpace(requestID)
	conversationID = strings.TrimSpace(conversationID)
	if afterSeq < 0 {
		afterSeq = 0
	}
	conversationReplayRequested := requestID == "" && conversationID != ""

	var persistedReplay []*ChatBroadcastEvent
	var persistedSnapshot ChatRunSnapshot
	persistedFound := false
	if store := m.chatStore.eventStore; store != nil {
		snapshot, replay, ok, err := store.Replay(requestID, conversationID, afterSeq, maxBufferedChatRunEvents)
		if err != nil {
			done := make(chan struct{})
			close(done)
			return nil, done, func() {}, ChatRunSnapshot{}, err
		}
		if ok {
			persistedFound = true
			persistedSnapshot = snapshot
			persistedReplay = replay
			requestID = strings.TrimSpace(snapshot.RequestID)
			if conversationID == "" {
				conversationID = strings.TrimSpace(snapshot.ConversationID)
			}
		}
	}

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	now := time.Now()
	m.pruneExpiredChatRunsLocked(now)

	if conversationReplayRequested && conversationID != "" {
		if liveRequestID := strings.TrimSpace(m.chatStore.chatRunByConversation[conversationID]); liveRequestID != "" {
			requestID = liveRequestID
		}
	} else if requestID == "" && conversationID != "" {
		requestID = m.chatStore.chatRunByConversation[conversationID]
	}
	run := m.chatStore.chatRuns[requestID]
	if run == nil && persistedFound {
		run = m.upsertChatRunSnapshotLocked(persistedSnapshot, m.currentSessionEpoch(), now)
		if run != nil {
			for _, event := range persistedReplay {
				if strings.TrimSpace(event.RequestID) == strings.TrimSpace(run.requestID) {
					run.appendEvent(event)
				}
			}
		}
	} else if run != nil && persistedFound && strings.TrimSpace(run.requestID) == strings.TrimSpace(persistedSnapshot.RequestID) {
		m.applyChatRunSnapshotLocked(run, persistedSnapshot, now)
	}
	if run == nil {
		done := make(chan struct{})
		close(done)
		return nil, done, func() {}, ChatRunSnapshot{}, ErrChatRunNotFound
	}

	replay := make([]*ChatBroadcastEvent, 0)
	if persistedFound {
		for _, event := range persistedReplay {
			replay = append(replay, cloneChatBroadcastEvent(event))
		}
		replay = mergeChatReplayEvents(replay, m.collectBufferedChatReplayLocked(run, conversationID, afterSeq, conversationReplayRequested))
	} else if conversationReplayRequested {
		for _, candidate := range m.chatStore.chatRuns {
			if candidate == nil || strings.TrimSpace(candidate.conversationID) != conversationID {
				continue
			}
			for _, event := range candidate.events {
				if event.Seq > afterSeq {
					replay = append(replay, cloneChatBroadcastEvent(event))
				}
			}
		}
		sort.SliceStable(replay, func(i, j int) bool {
			return replay[i].Seq < replay[j].Seq
		})
	} else {
		for _, event := range run.events {
			if event.Seq > afterSeq {
				replay = append(replay, cloneChatBroadcastEvent(event))
			}
		}
	}

	bufferSize := len(replay) + 128
	if bufferSize < 128 {
		bufferSize = 128
	}
	ch := make(chan *ChatBroadcastEvent, bufferSize)
	done := make(chan struct{})
	for _, event := range replay {
		ch <- event
	}

	subID := -1
	var subscriber *chatRunSubscriber
	doneClosed := false
	if !run.done {
		subID = m.chatStore.nextChatRunSubID
		m.chatStore.nextChatRunSubID += 1
		subscriber = &chatRunSubscriber{
			ch:   ch,
			done: done,
		}
		run.subscribers[subID] = subscriber
	} else if len(replay) == 0 {
		close(done)
		doneClosed = true
	}

	var cleanupOnce sync.Once
	cleanup := func() {
		cleanupOnce.Do(func() {
			m.chatStore.chatMu.Lock()
			if subID >= 0 {
				if current := m.chatStore.chatRuns[requestID]; current != nil {
					delete(current.subscribers, subID)
				}
			}
			m.chatStore.chatMu.Unlock()
			if subscriber != nil {
				subscriber.close()
			} else if !doneClosed {
				close(done)
			}
		})
	}

	return ch, done, cleanup, run.snapshot(), nil
}

func (m *Manager) collectBufferedChatReplayLocked(
	run *chatRun,
	conversationID string,
	afterSeq int64,
	conversationReplayRequested bool,
) []*ChatBroadcastEvent {
	if conversationReplayRequested {
		conversationID = strings.TrimSpace(conversationID)
		if conversationID == "" {
			return nil
		}
		replay := make([]*ChatBroadcastEvent, 0)
		for _, candidate := range m.chatStore.chatRuns {
			if candidate == nil || strings.TrimSpace(candidate.conversationID) != conversationID {
				continue
			}
			for _, event := range candidate.events {
				if event.Seq > afterSeq {
					replay = append(replay, cloneChatBroadcastEvent(event))
				}
			}
		}
		return replay
	}
	if run == nil {
		return nil
	}
	replay := make([]*ChatBroadcastEvent, 0, len(run.events))
	for _, event := range run.events {
		if event.Seq > afterSeq {
			replay = append(replay, cloneChatBroadcastEvent(event))
		}
	}
	return replay
}

func mergeChatReplayEvents(
	persisted []*ChatBroadcastEvent,
	buffered []*ChatBroadcastEvent,
) []*ChatBroadcastEvent {
	if len(persisted) == 0 && len(buffered) == 0 {
		return nil
	}
	merged := make([]*ChatBroadcastEvent, 0, len(persisted)+len(buffered))
	seen := make(map[string]struct{}, len(persisted)+len(buffered))
	appendEvent := func(event *ChatBroadcastEvent) {
		if event == nil || event.Seq <= 0 {
			return
		}
		key := strings.TrimSpace(event.RequestID) + "\x00" + strconv.FormatInt(event.Seq, 10)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		merged = append(merged, cloneChatBroadcastEvent(event))
	}
	for _, event := range persisted {
		appendEvent(event)
	}
	for _, event := range buffered {
		appendEvent(event)
	}
	sort.SliceStable(merged, func(i, j int) bool {
		if merged[i].Seq == merged[j].Seq {
			return strings.TrimSpace(merged[i].RequestID) < strings.TrimSpace(merged[j].RequestID)
		}
		return merged[i].Seq < merged[j].Seq
	})
	return merged
}

func (m *Manager) ChatRunSnapshot(
	requestID string,
	conversationID string,
) (ChatRunSnapshot, bool) {
	requestID = strings.TrimSpace(requestID)
	conversationID = strings.TrimSpace(conversationID)

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	m.pruneExpiredChatRunsLocked(time.Now())

	if requestID == "" && conversationID != "" {
		requestID = m.chatStore.chatRunByConversation[conversationID]
	}
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		return ChatRunSnapshot{}, false
	}
	return run.snapshot(), true
}

func (m *Manager) MarkChatRunControl(
	requestID string,
	conversationID string,
	controlType string,
	errorCode string,
	message string,
) {
	m.markChatRunControl(
		strings.TrimSpace(requestID),
		strings.TrimSpace(conversationID),
		strings.TrimSpace(controlType),
		"",
		strings.TrimSpace(errorCode),
		strings.TrimSpace(message),
		time.Now(),
	)
}

func (m *Manager) MarkChatRunPayload(
	requestID string,
	conversationID string,
	payload map[string]any,
) int64 {
	seqs := m.MarkChatRunPayloads(requestID, conversationID, []map[string]any{payload})
	if len(seqs) == 0 {
		return 0
	}
	return seqs[0]
}

func (m *Manager) MarkChatRunPayloads(
	requestID string,
	conversationID string,
	payloads []map[string]any,
) []int64 {
	requestID = strings.TrimSpace(requestID)
	conversationID = strings.TrimSpace(conversationID)
	if requestID == "" || len(payloads) == 0 {
		return nil
	}

	now := time.Now()
	persists := make([]ChatRunEventAppend, 0, len(payloads))
	broadcasts := make([]*ChatBroadcastEvent, 0, len(payloads))
	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		m.chatStore.nextChatRunEpoch += 1
		latestSeq := m.latestConversationSeqLocked(conversationID)
		run = &chatRun{
			requestID:      requestID,
			conversationID: conversationID,
			sessionEpoch:   m.currentSessionEpoch(),
			runEpoch:       m.chatStore.nextChatRunEpoch,
			state:          ChatRunStateQueued,
			nextSeq:        latestSeq,
			updatedAt:      now,
			subscribers:    make(map[int]*chatRunSubscriber),
		}
		run.applyState(ChatRunStateQueued)
		m.chatStore.chatRuns[requestID] = run
	}
	if run.done {
		m.chatStore.chatMu.Unlock()
		return nil
	}
	if conversationID != "" {
		if run.conversationID != "" && run.conversationID != conversationID {
			if m.chatStore.chatRunByConversation[run.conversationID] == requestID {
				delete(m.chatStore.chatRunByConversation, run.conversationID)
			}
		}
		run.conversationID = conversationID
		m.chatStore.chatRunByConversation[conversationID] = requestID
	}
	for _, payload := range payloads {
		broadcast := m.appendChatPayloadLocked(run, payload, now)
		if broadcast == nil {
			continue
		}
		broadcasts = append(broadcasts, broadcast)
		persists = append(persists, chatRunEventAppendSnapshot(run, broadcast, now))
	}
	runSubscribers := make([]*chatRunSubscriber, 0, len(run.subscribers))
	for _, subscriber := range run.subscribers {
		runSubscribers = append(runSubscribers, subscriber)
	}
	m.chatStore.chatMu.Unlock()

	if len(broadcasts) == 0 {
		return nil
	}
	m.persistChatBroadcasts(persists)
	for _, subscriber := range runSubscribers {
		for _, broadcast := range broadcasts {
			select {
			case <-subscriber.done:
			case subscriber.ch <- cloneChatBroadcastEvent(broadcast):
			}
		}
	}
	seqs := make([]int64, 0, len(broadcasts))
	for _, broadcast := range broadcasts {
		seqs = append(seqs, broadcast.Seq)
	}
	return seqs
}

func (m *Manager) broadcastChatEvent(requestID string, event *gatewayv1.ChatEvent) {
	if event == nil {
		return
	}

	requestID = strings.TrimSpace(requestID)
	conversationID := strings.TrimSpace(event.GetConversationId())
	now := time.Now()
	sessionEpoch := m.currentSessionEpoch()

	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	broadcast := &ChatBroadcastEvent{
		RequestID: requestID,
		Event:     event,
	}
	var persist ChatRunEventAppend
	var runSubscribers []*chatRunSubscriber
	var firstDelta *ChatBroadcastEvent
	run := m.chatStore.chatRuns[requestID]
	if run == nil && requestID != "" {
		m.chatStore.nextChatRunEpoch += 1
		latestSeq := m.latestConversationSeqLocked(conversationID)
		run = &chatRun{
			requestID:      requestID,
			conversationID: conversationID,
			sessionEpoch:   sessionEpoch,
			runEpoch:       m.chatStore.nextChatRunEpoch,
			state:          ChatRunStateQueued,
			nextSeq:        latestSeq,
			updatedAt:      now,
			subscribers:    make(map[int]*chatRunSubscriber),
		}
		run.applyState(ChatRunStateQueued)
		m.chatStore.chatRuns[requestID] = run
		if conversationID != "" {
			m.chatStore.chatRunByConversation[conversationID] = requestID
		}
	}
	if run != nil {
		if run.done {
			m.chatStore.chatMu.Unlock()
			return
		}
		if conversationID != "" {
			if run.conversationID != "" && run.conversationID != conversationID {
				if m.chatStore.chatRunByConversation[run.conversationID] == requestID {
					delete(m.chatStore.chatRunByConversation, run.conversationID)
				}
			}
			run.conversationID = conversationID
			m.chatStore.chatRunByConversation[conversationID] = requestID
			if run.workdir == "" {
				if activeRun, ok := m.chatStore.historyActiveRuns[conversationID]; ok {
					run.workdir = strings.TrimSpace(activeRun.workdir)
				}
			}
		}
		if !run.done && normalizeChatRunState(run.state) != ChatRunStateRunning && !isTerminalChatEvent(event) {
			run.applyState(ChatRunStateRunning)
		}
		run.nextSeq += 1
		run.updatedAt = now
		broadcast.Seq = run.nextSeq
		broadcast.Workdir = strings.TrimSpace(run.workdir)
		if isTerminalChatEvent(event) {
			if event.GetType() == gatewayv1.ChatEvent_DONE {
				run.applyState(ChatRunStateCompleted)
			} else {
				run.applyState(ChatRunStateFailed)
				if run.errorCode == "" {
					run.errorCode = "desktop_error"
				}
			}
			run.expiresAt = now.Add(chatRunDoneRetention)
		}
		run.appendEvent(broadcast)
		persist = chatRunEventAppendSnapshot(run, broadcast, now)
		if isFirstDeltaChatEvent(event) && !run.firstDeltaLogged {
			run.firstDeltaLogged = true
			firstDelta = cloneChatBroadcastEvent(broadcast)
		}
		runSubscribers = make([]*chatRunSubscriber, 0, len(run.subscribers))
		for _, subscriber := range run.subscribers {
			runSubscribers = append(runSubscribers, subscriber)
		}
	}
	m.chatStore.chatMu.Unlock()

	if firstDelta != nil {
		logChatRunSpan("first_delta", firstDelta)
	}
	m.persistChatBroadcast(persist)
	for _, subscriber := range runSubscribers {
		select {
		case <-subscriber.done:
		case subscriber.ch <- cloneChatBroadcastEvent(broadcast):
		}
	}
}

func (m *Manager) broadcastChatControl(requestID string, control *gatewayv1.ChatControlEvent) {
	if control == nil {
		return
	}
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		requestID = strings.TrimSpace(control.GetRequestId())
	}
	conversationID := strings.TrimSpace(control.GetConversationId())
	controlType := strings.TrimSpace(control.GetType())
	state := normalizeChatRunState(control.GetState())
	if state == "" {
		state = chatRunStateForControlType(controlType)
	}
	errorCode := strings.TrimSpace(control.GetErrorCode())
	message := strings.TrimSpace(control.GetMessage())
	m.markChatRunControl(requestID, conversationID, controlType, state, errorCode, message, time.Now())
}

func (m *Manager) markChatRunStateSilent(
	requestID string,
	conversationID string,
	state string,
	now time.Time,
) {
	requestID = strings.TrimSpace(requestID)
	conversationID = strings.TrimSpace(conversationID)
	state = normalizeChatRunState(state)
	if requestID == "" || state == "" {
		return
	}
	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	m.pruneExpiredChatRunsLocked(now)
	run := m.chatStore.chatRuns[requestID]
	if run == nil || run.done {
		return
	}
	if conversationID != "" {
		if run.conversationID != "" && run.conversationID != conversationID {
			if m.chatStore.chatRunByConversation[run.conversationID] == requestID {
				delete(m.chatStore.chatRunByConversation, run.conversationID)
			}
		}
		run.conversationID = conversationID
		m.chatStore.chatRunByConversation[conversationID] = requestID
	}
	run.applyState(state)
	run.updatedAt = now
	if isTerminalChatRunState(state) {
		run.expiresAt = now.Add(chatRunDoneRetention)
	}
}

func (m *Manager) markChatRunControl(
	requestID string,
	conversationID string,
	controlType string,
	state string,
	errorCode string,
	message string,
	now time.Time,
) {
	requestID = strings.TrimSpace(requestID)
	conversationID = strings.TrimSpace(conversationID)
	if requestID == "" {
		return
	}

	state = normalizeChatRunState(state)
	controlType = strings.TrimSpace(controlType)
	if controlType == "" {
		controlType = chatControlTypeForState(state)
	}

	var persist ChatRunEventAppend
	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		m.chatStore.nextChatRunEpoch += 1
		latestSeq := m.latestConversationSeqLocked(conversationID)
		run = &chatRun{
			requestID:      requestID,
			conversationID: conversationID,
			sessionEpoch:   m.currentSessionEpoch(),
			runEpoch:       m.chatStore.nextChatRunEpoch,
			state:          ChatRunStateQueued,
			nextSeq:        latestSeq,
			updatedAt:      now,
			subscribers:    make(map[int]*chatRunSubscriber),
		}
		run.applyState(ChatRunStateQueued)
		m.chatStore.chatRuns[requestID] = run
	}
	if run.done {
		m.chatStore.chatMu.Unlock()
		return
	}
	if conversationID != "" {
		if run.conversationID != "" && run.conversationID != conversationID {
			if m.chatStore.chatRunByConversation[run.conversationID] == requestID {
				delete(m.chatStore.chatRunByConversation, run.conversationID)
			}
		}
		run.conversationID = conversationID
		m.chatStore.chatRunByConversation[conversationID] = requestID
	}
	broadcast := m.appendChatControlLocked(run, controlType, errorCode, message, now)
	persist = chatRunEventAppendSnapshot(run, broadcast, now)
	runSubscribers := make([]*chatRunSubscriber, 0, len(run.subscribers))
	for _, subscriber := range run.subscribers {
		runSubscribers = append(runSubscribers, subscriber)
	}
	m.chatStore.chatMu.Unlock()

	if broadcast == nil {
		return
	}
	if span := chatControlSpanName(broadcast.Control); span != "" {
		logChatRunSpan(span, broadcast)
	}
	m.persistChatBroadcast(persist)
	for _, subscriber := range runSubscribers {
		select {
		case <-subscriber.done:
		case subscriber.ch <- cloneChatBroadcastEvent(broadcast):
		}
	}
}

func (m *Manager) DispatchFromAgent(env *gatewayv1.AgentEnvelope) {
	m.dispatchFromAgent(nil, env)
}

func (m *Manager) DispatchFromAgentForSession(session *AgentSession, env *gatewayv1.AgentEnvelope) {
	m.dispatchFromAgent(session, env)
}

func (m *Manager) dispatchFromAgent(expected *AgentSession, env *gatewayv1.AgentEnvelope) {
	m.registry.mu.RLock()
	session := m.registry.session
	m.registry.mu.RUnlock()
	if session == nil || (expected != nil && session != expected) {
		return
	}

	if runtimeStatus := env.GetRuntimeStatus(); runtimeStatus != nil {
		m.UpdateRuntimeStatus(session, runtimeStatus)
		return
	}

	if chatEvent := env.GetChatEvent(); chatEvent != nil {
		m.broadcastChatEvent(env.GetRequestId(), chatEvent)
	}

	if chatControl := env.GetChatControl(); chatControl != nil {
		m.broadcastChatControl(env.GetRequestId(), chatControl)
	}

	if historySync := env.GetHistorySync(); historySync != nil {
		m.broadcastHistorySync(historySync)
		return
	}

	if settingsSync := env.GetSettingsSync(); settingsSync != nil {
		m.broadcastSettingsSync(settingsSync)
		return
	}

	if terminalEvent := env.GetTerminalEvent(); terminalEvent != nil {
		m.broadcastTerminalEvent(terminalEvent)
		return
	}

	if sftpEvent := env.GetSftpEvent(); sftpEvent != nil {
		m.broadcastSftpEvent(sftpEvent)
		return
	}

	if tunnelFrame := env.GetTunnelFrame(); tunnelFrame != nil {
		m.dispatchTunnelFrame(tunnelFrame)
		return
	}

	if tunnelControl := env.GetTunnelControl(); tunnelControl != nil {
		m.handleAgentTunnelControl(session, env.GetRequestId(), tunnelControl)
		return
	}

	session.dispatch(env)
}

func (r *chatRun) snapshot() ChatRunSnapshot {
	firstSeq := int64(0)
	if len(r.events) > 0 {
		firstSeq = r.events[0].Seq
	}
	state := normalizeChatRunState(r.state)
	return ChatRunSnapshot{
		RequestID:       r.requestID,
		ConversationID:  r.conversationID,
		ClientRequestID: r.clientRequestID,
		Workdir:         r.workdir,
		FirstSeq:        firstSeq,
		LatestSeq:       r.nextSeq,
		RunEpoch:        r.runEpoch,
		State:           state,
		ErrorCode:       strings.TrimSpace(r.errorCode),
		Done:            r.done,
	}
}

func (r *chatRun) applyState(state string) {
	state = normalizeChatRunState(state)
	if state == "" {
		state = ChatRunStateQueued
	}
	r.state = state
	r.accepted = state != ChatRunStateQueued
	r.started = state == ChatRunStateRunning || state == ChatRunStateCompleted
	r.done = isTerminalChatRunState(state)
	if state != ChatRunStateFailed {
		r.errorCode = ""
	}
}

func (r *chatRun) appendEvent(event *ChatBroadcastEvent) {
	if r == nil || event == nil {
		return
	}
	r.events = appendCappedChatRunEvent(r.events, event, maxBufferedChatRunEvents)
}

func appendCappedChatRunEvent(
	events []*ChatBroadcastEvent,
	event *ChatBroadcastEvent,
	limit int,
) []*ChatBroadcastEvent {
	if event == nil {
		return events
	}
	if limit <= 0 {
		return events[:0]
	}
	cloned := cloneChatBroadcastEvent(event)
	if len(events) < limit {
		return append(events, cloned)
	}
	if len(events) > limit {
		events = events[len(events)-limit:]
	}
	copy(events, events[1:])
	events[len(events)-1] = cloned
	return events
}

func (r *chatRun) shouldPrune(now time.Time) bool {
	if r == nil {
		return true
	}
	if r.done {
		return !r.expiresAt.IsZero() && now.After(r.expiresAt)
	}
	if chatRunUpdatedBefore(r.updatedAt, now, chatRunStaleRetention) {
		return true
	}
	return normalizeChatRunState(r.state) != ChatRunStateRunning &&
		chatRunUpdatedBefore(r.updatedAt, now, chatRunStartRetention)
}

func chatRunUpdatedBefore(updatedAt time.Time, now time.Time, retention time.Duration) bool {
	return !updatedAt.IsZero() && retention > 0 && now.Sub(updatedAt) > retention
}

func (s *chatRunSubscriber) close() {
	s.closeOnce.Do(func() {
		close(s.done)
	})
}

func (m *Manager) pruneExpiredChatRunsLocked(now time.Time) {
	for requestID, run := range m.chatStore.chatRuns {
		if run == nil {
			delete(m.chatStore.chatRuns, requestID)
			continue
		}
		if run.shouldPrune(now) {
			m.removeChatRunLocked(requestID, run)
		}
	}
}

func (m *Manager) removeChatRunLocked(requestID string, run *chatRun) {
	if run.conversationID != "" && m.chatStore.chatRunByConversation[run.conversationID] == requestID {
		delete(m.chatStore.chatRunByConversation, run.conversationID)
	}
	if run.clientRequestID != "" && m.chatStore.chatRunByClientRequest[run.clientRequestID] == requestID {
		delete(m.chatStore.chatRunByClientRequest, run.clientRequestID)
	}
	delete(m.chatStore.chatRuns, requestID)
	for _, subscriber := range run.subscribers {
		subscriber.close()
	}
}

func (m *Manager) releaseCompletedChatRunLocked(requestID string, run *chatRun) {
	if run.conversationID != "" && m.chatStore.chatRunByConversation[run.conversationID] == requestID {
		delete(m.chatStore.chatRunByConversation, run.conversationID)
	}
	if run.clientRequestID != "" && m.chatStore.chatRunByClientRequest[run.clientRequestID] == requestID {
		delete(m.chatStore.chatRunByClientRequest, run.clientRequestID)
	}
	delete(m.chatStore.chatRuns, requestID)
}

func cloneChatBroadcastEvent(event *ChatBroadcastEvent) *ChatBroadcastEvent {
	if event == nil {
		return nil
	}
	return &ChatBroadcastEvent{
		RequestID: event.RequestID,
		Event:     event.Event,
		Control:   event.Control,
		Payload:   cloneChatPayloadMap(event.Payload),
		Seq:       event.Seq,
		Workdir:   event.Workdir,
	}
}

func cloneChatPayloadMap(input map[string]any) map[string]any {
	if len(input) == 0 {
		return nil
	}
	raw, err := json.Marshal(input)
	if err != nil {
		out := make(map[string]any, len(input))
		for key, value := range input {
			out[key] = value
		}
		return out
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		out = make(map[string]any, len(input))
		for key, value := range input {
			out[key] = value
		}
	}
	return out
}

func normalizeChatRunState(state string) string {
	switch strings.TrimSpace(state) {
	case ChatRunStateQueued:
		return ChatRunStateQueued
	case ChatRunStateDelivered:
		return ChatRunStateDelivered
	case ChatRunStateClaimed:
		return ChatRunStateClaimed
	case ChatRunStateStarting:
		return ChatRunStateStarting
	case ChatRunStateRunning:
		return ChatRunStateRunning
	case ChatRunStateCompleted:
		return ChatRunStateCompleted
	case ChatRunStateFailed:
		return ChatRunStateFailed
	case ChatRunStateCancelled:
		return ChatRunStateCancelled
	default:
		return ""
	}
}

func isTerminalChatRunState(state string) bool {
	switch normalizeChatRunState(state) {
	case ChatRunStateCompleted, ChatRunStateFailed, ChatRunStateCancelled:
		return true
	default:
		return false
	}
}

func ChatRunStateIsActive(state string) bool {
	switch normalizeChatRunState(state) {
	case ChatRunStateQueued, ChatRunStateDelivered, ChatRunStateClaimed, ChatRunStateStarting, ChatRunStateRunning:
		return true
	default:
		return false
	}
}

func chatRunStateForControlType(controlType string) string {
	switch strings.TrimSpace(controlType) {
	case "accepted":
		return ChatRunStateQueued
	case "delivered":
		return ChatRunStateDelivered
	case "claimed":
		return ChatRunStateClaimed
	case "starting":
		return ChatRunStateStarting
	case "started":
		return ChatRunStateRunning
	case "completed":
		return ChatRunStateCompleted
	case "failed":
		return ChatRunStateFailed
	case "cancelled":
		return ChatRunStateCancelled
	default:
		return ""
	}
}

func chatControlTypeForState(state string) string {
	switch normalizeChatRunState(state) {
	case ChatRunStateQueued:
		return "accepted"
	case ChatRunStateDelivered:
		return "delivered"
	case ChatRunStateClaimed:
		return "claimed"
	case ChatRunStateStarting:
		return "starting"
	case ChatRunStateRunning:
		return "started"
	case ChatRunStateCompleted:
		return "completed"
	case ChatRunStateFailed:
		return "failed"
	case ChatRunStateCancelled:
		return "cancelled"
	default:
		return "progress"
	}
}

func (m *Manager) appendChatControlLocked(
	run *chatRun,
	controlType string,
	errorCode string,
	message string,
	now time.Time,
) *ChatBroadcastEvent {
	if run == nil {
		return nil
	}
	controlType = strings.TrimSpace(controlType)
	state := chatRunStateForControlType(controlType)
	if state == "" {
		state = normalizeChatRunState(run.state)
	}
	if state == "" {
		state = ChatRunStateQueued
	}
	run.applyState(state)
	if errorCode = strings.TrimSpace(errorCode); errorCode != "" {
		run.errorCode = errorCode
	}
	run.updatedAt = now
	if isTerminalChatRunState(state) {
		run.expiresAt = now.Add(chatRunDoneRetention)
	}
	run.nextSeq += 1
	seq := run.nextSeq
	if controlType == "" {
		controlType = chatControlTypeForState(state)
	}
	control := &gatewayv1.ChatControlEvent{
		RequestId:       strings.TrimSpace(run.requestID),
		ClientRequestId: strings.TrimSpace(run.clientRequestID),
		ConversationId:  strings.TrimSpace(run.conversationID),
		RunEpoch:        run.runEpoch,
		Type:            controlType,
		State:           normalizeChatRunState(run.state),
		ErrorCode:       strings.TrimSpace(run.errorCode),
		Message:         strings.TrimSpace(message),
		Seq:             seq,
	}
	broadcast := &ChatBroadcastEvent{
		RequestID: strings.TrimSpace(run.requestID),
		Control:   control,
		Seq:       seq,
		Workdir:   strings.TrimSpace(run.workdir),
	}
	run.appendEvent(broadcast)
	return broadcast
}

func (m *Manager) appendChatPayloadLocked(
	run *chatRun,
	payload map[string]any,
	now time.Time,
) *ChatBroadcastEvent {
	if run == nil || len(payload) == 0 {
		return nil
	}
	run.updatedAt = now
	run.nextSeq += 1
	seq := run.nextSeq
	nextPayload := cloneChatPayloadMap(payload)
	if nextPayload == nil {
		nextPayload = make(map[string]any)
	}
	if eventType, _ := nextPayload["type"].(string); strings.TrimSpace(eventType) != "" {
		nextPayload["type"] = strings.TrimSpace(eventType)
	}
	nextPayload["request_id"] = strings.TrimSpace(run.requestID)
	nextPayload["client_request_id"] = strings.TrimSpace(run.clientRequestID)
	nextPayload["conversation_id"] = strings.TrimSpace(run.conversationID)
	nextPayload["run_epoch"] = run.runEpoch
	nextPayload["state"] = normalizeChatRunState(run.state)
	nextPayload["seq"] = seq
	broadcast := &ChatBroadcastEvent{
		RequestID: strings.TrimSpace(run.requestID),
		Payload:   nextPayload,
		Seq:       seq,
		Workdir:   strings.TrimSpace(run.workdir),
	}
	run.appendEvent(broadcast)
	return broadcast
}

func chatRunEventAppendSnapshot(
	run *chatRun,
	broadcast *ChatBroadcastEvent,
	now time.Time,
) ChatRunEventAppend {
	if run == nil || broadcast == nil {
		return ChatRunEventAppend{}
	}
	return ChatRunEventAppend{
		RequestID:       strings.TrimSpace(run.requestID),
		ConversationID:  strings.TrimSpace(run.conversationID),
		ClientRequestID: strings.TrimSpace(run.clientRequestID),
		Workdir:         strings.TrimSpace(run.workdir),
		RunEpoch:        run.runEpoch,
		State:           normalizeChatRunState(run.state),
		ErrorCode:       strings.TrimSpace(run.errorCode),
		Done:            run.done,
		Event:           cloneChatBroadcastEvent(broadcast),
		CreatedAt:       now,
	}
}

func (m *Manager) persistChatBroadcast(input ChatRunEventAppend) {
	m.persistChatBroadcasts([]ChatRunEventAppend{input})
}

func (m *Manager) persistChatBroadcasts(inputs []ChatRunEventAppend) {
	if m.chatStore.eventStore == nil {
		return
	}
	validInputs := make([]ChatRunEventAppend, 0, len(inputs))
	for _, input := range inputs {
		if input.Event != nil {
			validInputs = append(validInputs, input)
		}
	}
	if len(validInputs) == 0 || m.chatStore.eventStore == nil {
		return
	}
	if err := m.chatStore.eventStore.AppendEvents(validInputs); err != nil {
		first := validInputs[0]
		log.Printf("persist chat events failed: run_id=%s count=%d first_seq=%d err=%v", first.RequestID, len(validInputs), first.Event.Seq, err)
	}
}

func isTerminalChatEvent(event *gatewayv1.ChatEvent) bool {
	if event == nil {
		return false
	}
	return event.GetType() == gatewayv1.ChatEvent_DONE || event.GetType() == gatewayv1.ChatEvent_ERROR
}

func isFirstDeltaChatEvent(event *gatewayv1.ChatEvent) bool {
	if event == nil {
		return false
	}
	switch event.GetType() {
	case gatewayv1.ChatEvent_TOKEN,
		gatewayv1.ChatEvent_THINKING,
		gatewayv1.ChatEvent_TOOL_CALL,
		gatewayv1.ChatEvent_TOOL_STATUS,
		gatewayv1.ChatEvent_HOSTED_SEARCH:
		return true
	default:
		return false
	}
}

func chatControlSpanName(control *gatewayv1.ChatControlEvent) string {
	if control == nil {
		return ""
	}
	switch strings.TrimSpace(control.GetType()) {
	case "claimed":
		return "runtime_claimed"
	case "started":
		return "runtime_started"
	case "completed":
		return "run_completed"
	case "failed":
		return "run_failed"
	case "cancelled":
		return "run_cancelled"
	default:
		return ""
	}
}

func logChatRunSpan(span string, event *ChatBroadcastEvent) {
	if event == nil {
		return
	}
	runID := strings.TrimSpace(event.RequestID)
	conversationID := ""
	clientRequestID := ""
	if event.Control != nil {
		conversationID = strings.TrimSpace(event.Control.GetConversationId())
		clientRequestID = strings.TrimSpace(event.Control.GetClientRequestId())
	} else if event.Payload != nil {
		if value, ok := event.Payload["conversation_id"].(string); ok {
			conversationID = strings.TrimSpace(value)
		}
		if value, ok := event.Payload["client_request_id"].(string); ok {
			clientRequestID = strings.TrimSpace(value)
		}
	} else if event.Event != nil {
		conversationID = strings.TrimSpace(event.Event.GetConversationId())
	}
	log.Printf(
		"chat_run_span span=%s run_id=%q conversation_id=%q client_request_id=%q seq=%d",
		strings.TrimSpace(span),
		runID,
		conversationID,
		clientRequestID,
		event.Seq,
	)
}
