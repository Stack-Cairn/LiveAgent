package session

import (
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func (m *Manager) SubscribeHistorySync() (<-chan Tagged[*gatewayv2.HistorySyncEvent], func()) {
	ch := make(chan Tagged[*gatewayv2.HistorySyncEvent], 128)

	m.syncHub.historyMu.Lock()
	subID := m.syncHub.nextHistorySubID
	m.syncHub.nextHistorySubID += 1
	m.syncHub.historySubscribers[subID] = ch
	m.syncHub.historyMu.Unlock()

	cleanup := func() {
		m.syncHub.historyMu.Lock()
		// Do not close the channel here: broadcastHistorySync sends after
		// copying subscribers, so closing can race with an in-flight send.
		delete(m.syncHub.historySubscribers, subID)
		m.syncHub.historyMu.Unlock()
	}

	return ch, cleanup
}

func (m *Manager) broadcastHistorySync(agentID string, event *gatewayv2.HistorySyncEvent) {
	if event == nil {
		return
	}

	m.syncHub.historyMu.Lock()
	subscribers := make([]chan Tagged[*gatewayv2.HistorySyncEvent], 0, len(m.syncHub.historySubscribers))
	for _, ch := range m.syncHub.historySubscribers {
		subscribers = append(subscribers, ch)
	}
	m.syncHub.historyMu.Unlock()

	tagged := Tagged[*gatewayv2.HistorySyncEvent]{AgentID: agentID, Event: event}
	for _, ch := range subscribers {
		select {
		case ch <- tagged:
		default:
		}
	}
}
