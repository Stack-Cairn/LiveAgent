package session

import (
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func (m *Manager) SubscribePlanningChanged() (<-chan Tagged[*gatewayv2.PlanningChanged], func()) {
	ch := make(chan Tagged[*gatewayv2.PlanningChanged], 128)

	m.syncHub.planningMu.Lock()
	subID := m.syncHub.nextPlanningSubID
	m.syncHub.nextPlanningSubID += 1
	m.syncHub.planningSubscribers[subID] = ch
	m.syncHub.planningMu.Unlock()

	cleanup := func() {
		m.syncHub.planningMu.Lock()
		// Do not close the channel here: broadcastPlanningChanged sends after
		// copying subscribers, so closing can race with an in-flight send.
		delete(m.syncHub.planningSubscribers, subID)
		m.syncHub.planningMu.Unlock()
	}

	return ch, cleanup
}

func (m *Manager) broadcastPlanningChanged(agentID string, event *gatewayv2.PlanningChanged) {
	if event == nil {
		return
	}

	m.syncHub.planningMu.Lock()
	subscribers := make([]chan Tagged[*gatewayv2.PlanningChanged], 0, len(m.syncHub.planningSubscribers))
	for _, ch := range m.syncHub.planningSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.syncHub.planningMu.Unlock()

	tagged := Tagged[*gatewayv2.PlanningChanged]{AgentID: agentID, Event: event}
	for _, ch := range subscribers {
		select {
		case ch <- tagged:
		default:
		}
	}
}
