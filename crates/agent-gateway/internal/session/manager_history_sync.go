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

	m.updateActiveHistoryRun(event)
	m.releaseCompletedChatRunAfterHistoryUpsert(event)

	m.syncHub.historyMu.Lock()
	subscribers := make([]chan *gatewayv1.HistorySyncEvent, 0, len(m.syncHub.historySubscribers))
	for _, ch := range m.syncHub.historySubscribers {
		subscribers = append(subscribers, ch)
	}
	m.syncHub.historyMu.Unlock()

	for _, ch := range subscribers {
		select {
		case ch <- event:
		default:
		}
	}
}

func historySyncConversationID(event *gatewayv1.HistorySyncEvent) string {
	conversationID := strings.TrimSpace(event.GetConversationId())
	if conversationID == "" && event.GetConversation() != nil {
		conversationID = strings.TrimSpace(event.GetConversation().GetId())
	}
	return conversationID
}

func historySyncWorkdir(event *gatewayv1.HistorySyncEvent) string {
	if event == nil || event.GetConversation() == nil {
		return ""
	}
	return strings.TrimSpace(event.GetConversation().GetCwd())
}

func (m *Manager) updateActiveHistoryRun(event *gatewayv1.HistorySyncEvent) {
	kind := strings.TrimSpace(event.GetKind())
	conversationID := historySyncConversationID(event)
	if conversationID == "" {
		return
	}

	workdir := historySyncWorkdir(event)
	now := time.Now()

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	m.pruneExpiredChatRunsLocked(now)

	switch kind {
	case "running":
		existing := m.chatStore.historyActiveRuns[conversationID]
		if workdir == "" {
			workdir = existing.workdir
		}
		m.chatStore.historyActiveRuns[conversationID] = activeHistoryRun{
			conversationID: conversationID,
			workdir:        workdir,
			updatedAt:      now,
		}
		if requestID := m.chatStore.chatRunByConversation[conversationID]; requestID != "" {
			if run := m.chatStore.chatRuns[requestID]; run != nil && workdir != "" {
				run.workdir = workdir
			}
		}
	case "idle", "delete":
		delete(m.chatStore.historyActiveRuns, conversationID)
	case "upsert":
		if workdir == "" {
			return
		}
		if existing, ok := m.chatStore.historyActiveRuns[conversationID]; ok {
			existing.workdir = workdir
			existing.updatedAt = now
			m.chatStore.historyActiveRuns[conversationID] = existing
		}
		if requestID := m.chatStore.chatRunByConversation[conversationID]; requestID != "" {
			if run := m.chatStore.chatRuns[requestID]; run != nil {
				run.workdir = workdir
			}
		}
	}
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
