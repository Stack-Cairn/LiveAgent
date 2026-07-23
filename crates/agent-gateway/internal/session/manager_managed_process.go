package session

import (
	"sync"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// managedProcessHub caches the latest ManagedProcess snapshot published by
// each agent and fans it out to websocket subscribers. Delivery is
// latest-wins and non-blocking: a congested subscriber just skips ahead to
// the next snapshot.
type managedProcessHub struct {
	mu          sync.Mutex
	latest      map[string]*gatewayv2.ManagedProcessSnapshot
	subscribers map[uint64]chan Tagged[*gatewayv2.ManagedProcessSnapshot]
	nextSubID   uint64
}

func newManagedProcessHub() *managedProcessHub {
	return &managedProcessHub{
		latest:      make(map[string]*gatewayv2.ManagedProcessSnapshot),
		subscribers: make(map[uint64]chan Tagged[*gatewayv2.ManagedProcessSnapshot]),
	}
}

// ManagedProcessSnapshotCached returns the last snapshot seen from a named agentID
// (nil before the first publish), so webui clients can render the latest known state
// even while that Agent is offline.
func (m *Manager) ManagedProcessSnapshotCached(agentID string) *gatewayv2.ManagedProcessSnapshot {
	agentID = normalizeAgentKey(agentID)
	if agentID == "" {
		return nil
	}
	m.managedProcesses.mu.Lock()
	defer m.managedProcesses.mu.Unlock()
	return m.managedProcesses.latest[agentID]
}

func (m *Manager) SubscribeManagedProcessState() (<-chan Tagged[*gatewayv2.ManagedProcessSnapshot], func()) {
	hub := m.managedProcesses
	ch := make(chan Tagged[*gatewayv2.ManagedProcessSnapshot], 16)

	hub.mu.Lock()
	subID := hub.nextSubID
	hub.nextSubID += 1
	hub.subscribers[subID] = ch
	hub.mu.Unlock()

	cleanup := func() {
		hub.mu.Lock()
		// Do not close the channel: the broadcast sends after copying the
		// subscriber list, so closing can race with an in-flight send.
		delete(hub.subscribers, subID)
		hub.mu.Unlock()
	}
	return ch, cleanup
}

func (m *Manager) broadcastManagedProcessSnapshot(agentID string, snapshot *gatewayv2.ManagedProcessSnapshot) {
	if snapshot == nil {
		return
	}
	key := normalizeAgentKey(agentID)
	hub := m.managedProcesses
	hub.mu.Lock()
	// Agent-side publishes are spawned per change and can arrive reordered;
	// revisions are agent-stamped and restart-safe, so drop strictly older
	// snapshots (equal ones still flow for agent-online re-stamps).
	if latest := hub.latest[key]; latest != nil && snapshot.GetRevision() < latest.GetRevision() {
		hub.mu.Unlock()
		return
	}
	hub.latest[key] = snapshot
	subscribers := make([]chan Tagged[*gatewayv2.ManagedProcessSnapshot], 0, len(hub.subscribers))
	for _, ch := range hub.subscribers {
		subscribers = append(subscribers, ch)
	}
	hub.mu.Unlock()

	tagged := Tagged[*gatewayv2.ManagedProcessSnapshot]{AgentID: agentID, Event: snapshot}
	for _, ch := range subscribers {
		select {
		case ch <- tagged:
		default:
		}
	}
}

// rebroadcastManagedProcessState replays agentID's cached snapshot so
// subscribers re-render with the current agent-online flag (stamped at write
// time).
func (m *Manager) rebroadcastManagedProcessState(agentID string) {
	m.managedProcesses.mu.Lock()
	latest := m.managedProcesses.latest[normalizeAgentKey(agentID)]
	m.managedProcesses.mu.Unlock()
	if latest == nil {
		return
	}
	m.broadcastManagedProcessSnapshot(agentID, latest)
}
