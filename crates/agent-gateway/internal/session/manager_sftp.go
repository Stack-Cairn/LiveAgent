package session

import (
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func (m *Manager) SubscribeSftpEvents() (<-chan Tagged[*gatewayv2.SftpEvent], func()) {
	ch := make(chan Tagged[*gatewayv2.SftpEvent], 4096)

	m.syncHub.sftpMu.Lock()
	subID := m.syncHub.nextSftpSubID
	m.syncHub.nextSftpSubID += 1
	m.syncHub.sftpSubscribers[subID] = ch
	m.syncHub.sftpMu.Unlock()

	cleanup := func() {
		m.syncHub.sftpMu.Lock()
		// Do not close the channel here: broadcastSftpEvent sends after
		// copying subscribers, so closing can race with an in-flight send.
		delete(m.syncHub.sftpSubscribers, subID)
		m.syncHub.sftpMu.Unlock()
	}

	return ch, cleanup
}

func (m *Manager) broadcastSftpEvent(agentID string, event *gatewayv2.SftpEvent) {
	if event == nil {
		return
	}

	m.syncHub.sftpMu.Lock()
	subscribers := make([]chan Tagged[*gatewayv2.SftpEvent], 0, len(m.syncHub.sftpSubscribers))
	for _, ch := range m.syncHub.sftpSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.syncHub.sftpMu.Unlock()

	tagged := Tagged[*gatewayv2.SftpEvent]{AgentID: agentID, Event: event}
	for _, ch := range subscribers {
		select {
		case ch <- tagged:
		case <-time.After(50 * time.Millisecond):
		}
	}
}
