package session

import (
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (m *Manager) SubscribeChatQueueEvents() (<-chan *gatewayv1.ChatQueueEvent, func()) {
	ch := make(chan *gatewayv1.ChatQueueEvent, 64)

	m.syncHub.chatQueueMu.Lock()
	subID := m.syncHub.nextChatQueueSubID
	m.syncHub.nextChatQueueSubID += 1
	m.syncHub.chatQueueSubscribers[subID] = ch
	m.syncHub.chatQueueMu.Unlock()

	cleanup := func() {
		m.syncHub.chatQueueMu.Lock()
		if _, ok := m.syncHub.chatQueueSubscribers[subID]; ok {
			delete(m.syncHub.chatQueueSubscribers, subID)
		}
		m.syncHub.chatQueueMu.Unlock()
	}

	return ch, cleanup
}

func (m *Manager) broadcastChatQueueEvent(event *gatewayv1.ChatQueueEvent) {
	if event == nil {
		return
	}

	m.syncHub.chatQueueMu.Lock()
	subscribers := make([]chan *gatewayv1.ChatQueueEvent, 0, len(m.syncHub.chatQueueSubscribers))
	for _, ch := range m.syncHub.chatQueueSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.syncHub.chatQueueMu.Unlock()

	for _, ch := range subscribers {
		select {
		case ch <- event:
		case <-time.After(50 * time.Millisecond):
		}
	}
}
