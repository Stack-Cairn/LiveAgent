package session

import "sync"

// statusSubscriberHub fans out agent Status snapshots to /ws connections so
// clients learn about agent connect/disconnect by push instead of polling.
type statusSubscriberHub struct {
	mu          sync.Mutex
	nextSubID   uint64
	subscribers map[uint64]chan Tagged[Status]
}

func newStatusSubscriberHub() *statusSubscriberHub {
	return &statusSubscriberHub{
		subscribers: make(map[uint64]chan Tagged[Status]),
	}
}

func (m *Manager) SubscribeStatus() (<-chan Tagged[Status], func()) {
	ch := make(chan Tagged[Status], 8)

	m.statusSubs.mu.Lock()
	subID := m.statusSubs.nextSubID
	m.statusSubs.nextSubID += 1
	m.statusSubs.subscribers[subID] = ch
	m.statusSubs.mu.Unlock()

	cleanup := func() {
		m.statusSubs.mu.Lock()
		// Do not close the channel: broadcastStatus sends after copying
		// subscribers, so closing can race with an in-flight send.
		delete(m.statusSubs.subscribers, subID)
		m.statusSubs.mu.Unlock()
	}
	return ch, cleanup
}

// broadcastStatus pushes agentID's status snapshot to /ws subscribers.
// Sends are non-blocking: a stalled subscriber misses intermediate snapshots
// and reconciles from its fallback status poll.
func (m *Manager) broadcastStatus(agentID string) {
	snapshot := m.Status(agentID)
	if snapshot.AgentID == "" {
		return
	}

	m.statusSubs.mu.Lock()
	subscribers := make([]chan Tagged[Status], 0, len(m.statusSubs.subscribers))
	for _, ch := range m.statusSubs.subscribers {
		subscribers = append(subscribers, ch)
	}
	m.statusSubs.mu.Unlock()

	tagged := Tagged[Status]{AgentID: agentID, Event: snapshot}
	for _, ch := range subscribers {
		select {
		case ch <- tagged:
		default:
		}
	}
}
