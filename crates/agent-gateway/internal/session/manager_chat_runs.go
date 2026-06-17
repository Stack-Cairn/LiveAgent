package session

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (m *Manager) SubscribeChatEvents() (<-chan *ChatBroadcastEvent, func()) {
	ch := make(chan *ChatBroadcastEvent, 128)

	m.chatStore.chatMu.Lock()
	subID := m.chatStore.nextChatSubID
	m.chatStore.nextChatSubID += 1
	m.chatStore.chatSubscribers[subID] = ch
	m.chatStore.chatMu.Unlock()

	cleanup := func() {
		m.chatStore.chatMu.Lock()
		if _, ok := m.chatStore.chatSubscribers[subID]; ok {
			// Do not close the channel here: broadcastChatEvent sends after
			// copying subscribers, so closing can race with an in-flight send.
			delete(m.chatStore.chatSubscribers, subID)
		}
		m.chatStore.chatMu.Unlock()
	}

	return ch, cleanup
}

func (m *Manager) StartChatRun(requestID string, conversationID string) (ChatRunSnapshot, error) {
	snapshot, _, err := m.StartChatRunWithClientRequest(requestID, conversationID, "", "")
	return snapshot, err
}

func (m *Manager) StartChatRunWithClientRequest(
	requestID string,
	conversationID string,
	clientRequestID string,
	workdirInput ...string,
) (ChatRunSnapshot, bool, error) {
	return m.startChatRunWithClientRequest(requestID, conversationID, clientRequestID, true, workdirInput...)
}

func (m *Manager) StartPendingChatRunWithClientRequest(
	requestID string,
	conversationID string,
	clientRequestID string,
	workdirInput ...string,
) (ChatRunSnapshot, bool, error) {
	return m.startChatRunWithClientRequest(requestID, conversationID, clientRequestID, false, workdirInput...)
}

func (m *Manager) startChatRunWithClientRequest(
	requestID string,
	conversationID string,
	clientRequestID string,
	started bool,
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
					if started && existing.state != ChatRunStateRunning {
						existing.applyState(ChatRunStateRunning)
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
	initialState := ChatRunStateQueued
	if started {
		initialState = ChatRunStateRunning
	}
	run := &chatRun{
		requestID:       requestID,
		conversationID:  conversationID,
		clientRequestID: clientRequestID,
		workdir:         workdir,
		sessionEpoch:    sessionEpoch,
		runEpoch:        m.chatStore.nextChatRunEpoch,
		state:           initialState,
		updatedAt:       now,
		subscribers:     make(map[int]*chatRunSubscriber),
	}
	run.applyState(initialState)
	m.chatStore.chatRuns[requestID] = run
	if conversationID != "" {
		m.chatStore.chatRunByConversation[conversationID] = requestID
	}
	if clientRequestID != "" {
		m.chatStore.chatRunByClientRequest[clientRequestID] = requestID
	}

	return run.snapshot(), true, nil
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
			Workdir:        strings.TrimSpace(run.workdir),
			UpdatedAt:      run.updatedAt.UnixMilli(),
		}
		if index, ok := seen[conversationID]; ok {
			if summaries[index].Workdir == "" {
				summaries[index].Workdir = summary.Workdir
			}
			if summary.UpdatedAt > summaries[index].UpdatedAt {
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
	}
	targets := make([]broadcastTarget, 0)
	globalSubscribers := make([]chan *ChatBroadcastEvent, 0)

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
		run.events = append(run.events, cloneChatBroadcastEvent(broadcast))
		if len(run.events) > maxBufferedChatRunEvents {
			copy(run.events, run.events[len(run.events)-maxBufferedChatRunEvents:])
			run.events = run.events[:maxBufferedChatRunEvents]
		}

		subscribers := make([]*chatRunSubscriber, 0, len(run.subscribers))
		for _, subscriber := range run.subscribers {
			subscribers = append(subscribers, subscriber)
		}
		targets = append(targets, broadcastTarget{
			events:      []*ChatBroadcastEvent{broadcast},
			subscribers: subscribers,
		})
	}
	for _, ch := range m.chatStore.chatSubscribers {
		globalSubscribers = append(globalSubscribers, ch)
	}
	m.chatStore.chatMu.Unlock()

	for _, target := range targets {
		for _, subscriber := range target.subscribers {
			for _, event := range target.events {
				select {
				case <-subscriber.done:
				case subscriber.ch <- cloneChatBroadcastEvent(event):
				}
			}
		}
		for _, ch := range globalSubscribers {
			for _, event := range target.events {
				select {
				case ch <- cloneChatBroadcastEvent(event):
				default:
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
	var runSubscribers []*chatRunSubscriber
	var subscribers []chan *ChatBroadcastEvent

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
	run.events = append(run.events, cloneChatBroadcastEvent(broadcast))
	if len(run.events) > maxBufferedChatRunEvents {
		copy(run.events, run.events[len(run.events)-maxBufferedChatRunEvents:])
		run.events = run.events[:maxBufferedChatRunEvents]
	}
	runSubscribers = make([]*chatRunSubscriber, 0, len(run.subscribers))
	for _, subscriber := range run.subscribers {
		runSubscribers = append(runSubscribers, subscriber)
	}
	subscribers = make([]chan *ChatBroadcastEvent, 0, len(m.chatStore.chatSubscribers))
	for _, ch := range m.chatStore.chatSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.chatStore.chatMu.Unlock()

	for _, subscriber := range runSubscribers {
		select {
		case <-subscriber.done:
		case subscriber.ch <- cloneChatBroadcastEvent(broadcast):
		}
	}
	for _, ch := range subscribers {
		select {
		case ch <- cloneChatBroadcastEvent(broadcast):
		default:
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

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	m.pruneExpiredChatRunsLocked(time.Now())

	if requestID == "" && conversationID != "" {
		requestID = m.chatStore.chatRunByConversation[conversationID]
	}
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		done := make(chan struct{})
		close(done)
		return nil, done, func() {}, ChatRunSnapshot{}, ErrChatRunNotFound
	}

	replay := make([]*ChatBroadcastEvent, 0)
	for _, event := range run.events {
		if event.Seq > afterSeq {
			replay = append(replay, cloneChatBroadcastEvent(event))
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
	if !run.done {
		subID = m.chatStore.nextChatRunSubID
		m.chatStore.nextChatRunSubID += 1
		subscriber = &chatRunSubscriber{
			ch:   ch,
			done: done,
		}
		run.subscribers[subID] = subscriber
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
			} else {
				close(done)
			}
		})
	}

	return ch, done, cleanup, run.snapshot(), nil
}

func (m *Manager) broadcastChatEvent(requestID string, event *gatewayv1.ChatEvent) {
	if event == nil {
		return
	}

	requestID = strings.TrimSpace(requestID)
	conversationID := strings.TrimSpace(event.GetConversationId())
	now := time.Now()
	sessionEpoch := m.currentSessionEpoch()
	if isChatAcceptedControlEvent(event) {
		m.markChatRunStateSilent(requestID, conversationID, ChatRunStateDelivered, now)
		return
	}
	if isChatStartedControlEvent(event) {
		m.markChatRunStateSilent(requestID, conversationID, ChatRunStateRunning, now)
		return
	}

	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	broadcast := &ChatBroadcastEvent{
		RequestID: requestID,
		Event:     event,
	}
	var runSubscribers []*chatRunSubscriber
	run := m.chatStore.chatRuns[requestID]
	if run == nil && requestID != "" {
		m.chatStore.nextChatRunEpoch += 1
		run = &chatRun{
			requestID:      requestID,
			conversationID: conversationID,
			sessionEpoch:   sessionEpoch,
			runEpoch:       m.chatStore.nextChatRunEpoch,
			state:          ChatRunStateQueued,
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
		run.events = append(run.events, cloneChatBroadcastEvent(broadcast))
		if len(run.events) > maxBufferedChatRunEvents {
			copy(run.events, run.events[len(run.events)-maxBufferedChatRunEvents:])
			run.events = run.events[:maxBufferedChatRunEvents]
		}
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
		runSubscribers = make([]*chatRunSubscriber, 0, len(run.subscribers))
		for _, subscriber := range run.subscribers {
			runSubscribers = append(runSubscribers, subscriber)
		}
	}
	subscribers := make([]chan *ChatBroadcastEvent, 0, len(m.chatStore.chatSubscribers))
	for _, ch := range m.chatStore.chatSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.chatStore.chatMu.Unlock()

	for _, subscriber := range runSubscribers {
		select {
		case <-subscriber.done:
		case subscriber.ch <- cloneChatBroadcastEvent(broadcast):
		}
	}
	for _, ch := range subscribers {
		select {
		case ch <- broadcast:
		default:
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

	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		m.chatStore.nextChatRunEpoch += 1
		run = &chatRun{
			requestID:      requestID,
			conversationID: conversationID,
			sessionEpoch:   m.currentSessionEpoch(),
			runEpoch:       m.chatStore.nextChatRunEpoch,
			state:          ChatRunStateQueued,
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
	runSubscribers := make([]*chatRunSubscriber, 0, len(run.subscribers))
	for _, subscriber := range run.subscribers {
		runSubscribers = append(runSubscribers, subscriber)
	}
	subscribers := make([]chan *ChatBroadcastEvent, 0, len(m.chatStore.chatSubscribers))
	for _, ch := range m.chatStore.chatSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.chatStore.chatMu.Unlock()

	if broadcast == nil {
		return
	}
	for _, subscriber := range runSubscribers {
		select {
		case <-subscriber.done:
		case subscriber.ch <- cloneChatBroadcastEvent(broadcast):
		}
	}
	for _, ch := range subscribers {
		select {
		case ch <- cloneChatBroadcastEvent(broadcast):
		default:
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
		if run.done {
			if !run.expiresAt.IsZero() && now.After(run.expiresAt) {
				m.removeChatRunLocked(requestID, run)
			}
			continue
		}
		if normalizeChatRunState(run.state) != ChatRunStateRunning && !run.updatedAt.IsZero() && now.Sub(run.updatedAt) > chatRunStartRetention {
			m.removeChatRunLocked(requestID, run)
			continue
		}
		if !run.updatedAt.IsZero() && now.Sub(run.updatedAt) > chatRunStaleRetention {
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
		Seq:       event.Seq,
		Workdir:   event.Workdir,
	}
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
	run.events = append(run.events, cloneChatBroadcastEvent(broadcast))
	if len(run.events) > maxBufferedChatRunEvents {
		copy(run.events, run.events[len(run.events)-maxBufferedChatRunEvents:])
		run.events = run.events[:maxBufferedChatRunEvents]
	}
	return broadcast
}

func isTerminalChatEvent(event *gatewayv1.ChatEvent) bool {
	if event == nil {
		return false
	}
	return event.GetType() == gatewayv1.ChatEvent_DONE || event.GetType() == gatewayv1.ChatEvent_ERROR
}

func isChatStartedControlEvent(event *gatewayv1.ChatEvent) bool {
	return chatControlEventType(event) == "started"
}

func isChatAcceptedControlEvent(event *gatewayv1.ChatEvent) bool {
	return chatControlEventType(event) == "accepted"
}

func chatControlEventType(event *gatewayv1.ChatEvent) string {
	if event == nil || event.GetType() != gatewayv1.ChatEvent_TOKEN {
		return ""
	}
	raw := strings.TrimSpace(event.GetData())
	if raw == "" {
		return ""
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return ""
	}
	value, _ := decoded["type"].(string)
	return strings.TrimSpace(value)
}
