package session

import (
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

const workspaceActivityChannelDepth = 16

// workspaceActivityHub tracks which (agent, workdir) pairs /ws clients are
// interested in and fans agent-reported activity events out to them. Per
// agent, the union of watched workdirs is pushed as a declarative full set
// whenever it changes (and on that agent's reconnect), so the agent owns zero
// subscription state.
type workspaceActivityHub struct {
	mu          sync.Mutex
	watchCounts map[workspaceWatchKey]int
	nextSubID   int
	subscribers map[int]*workspaceActivitySubscriber
}

// workspaceWatchKey 按明确的 agentID + workdir 标识一个订阅目标。
type workspaceWatchKey struct {
	agentID string
	workdir string
}

type workspaceActivitySubscriber struct {
	key workspaceWatchKey
	ch  chan *gatewayv2.WorkspaceActivityEvent
}

func newWorkspaceActivityHub() *workspaceActivityHub {
	return &workspaceActivityHub{
		watchCounts: make(map[workspaceWatchKey]int),
		subscribers: make(map[int]*workspaceActivitySubscriber),
	}
}

// SubscribeWorkspaceActivity registers interest in one workdir on one agent.
// The returned cleanup drops the subscription; when the pair's refcount
// reaches zero it leaves that agent's watch set on the next push.
func (m *Manager) SubscribeWorkspaceActivity(
	agentID string,
	workdir string,
) (<-chan *gatewayv2.WorkspaceActivityEvent, func()) {
	key := workspaceWatchKey{
		agentID: strings.TrimSpace(agentID),
		workdir: strings.TrimSpace(workdir),
	}
	sub := &workspaceActivitySubscriber{
		key: key,
		ch:  make(chan *gatewayv2.WorkspaceActivityEvent, workspaceActivityChannelDepth),
	}

	m.workspaceHub.mu.Lock()
	subID := m.workspaceHub.nextSubID
	m.workspaceHub.nextSubID += 1
	m.workspaceHub.subscribers[subID] = sub
	m.workspaceHub.watchCounts[key] += 1
	watchSetChanged := m.workspaceHub.watchCounts[key] == 1
	m.workspaceHub.mu.Unlock()

	if watchSetChanged {
		m.pushWorkspaceWatchSet(key.agentID)
	}

	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			m.workspaceHub.mu.Lock()
			// Do not close the channel: broadcastWorkspaceActivity sends after
			// copying subscribers, so closing can race with an in-flight send.
			delete(m.workspaceHub.subscribers, subID)
			changed := false
			if count := m.workspaceHub.watchCounts[key]; count > 1 {
				m.workspaceHub.watchCounts[key] = count - 1
			} else {
				delete(m.workspaceHub.watchCounts, key)
				changed = true
			}
			m.workspaceHub.mu.Unlock()
			if changed {
				m.pushWorkspaceWatchSet(key.agentID)
			}
		})
	}
	return sub.ch, cleanup
}

// broadcastWorkspaceActivity fans one agent event out to the subscribers of
// its workdir on that agent. Runs on the agent read loop, so it must never
// block: a full subscriber channel drops the event (consumers converge on the
// next one, and revision gaps are already tolerated client-side).
func (m *Manager) broadcastWorkspaceActivity(agentID string, event *gatewayv2.WorkspaceActivityEvent) {
	if event == nil {
		return
	}
	workdir := strings.TrimSpace(event.GetWorkdir())
	if workdir == "" {
		return
	}
	agentID = strings.TrimSpace(agentID)
	m.workspaceHub.mu.Lock()
	targets := make([]chan *gatewayv2.WorkspaceActivityEvent, 0, len(m.workspaceHub.subscribers))
	for _, sub := range m.workspaceHub.subscribers {
		if sub.key.workdir != workdir {
			continue
		}
		if sub.key.agentID == agentID {
			targets = append(targets, sub.ch)
		}
	}
	m.workspaceHub.mu.Unlock()

	for _, ch := range targets {
		select {
		case ch <- event:
		default:
		}
	}
}

// hasWorkspaceWatchInterest 报告 agent_id 是否有工作区订阅。
func (m *Manager) hasWorkspaceWatchInterest(agentID string) bool {
	agentID = strings.TrimSpace(agentID)
	m.workspaceHub.mu.Lock()
	defer m.workspaceHub.mu.Unlock()
	for key := range m.workspaceHub.watchCounts {
		if key.agentID == agentID {
			return true
		}
	}
	return false
}

// pushWorkspaceWatchSet 把 agentID 的完整工作区订阅集合推送给该 Agent。
// 此操作为 best-effort 且不阻塞：
// the set is re-pushed on every change and on agent reconnect, so a dropped
// push heals itself.
func (m *Manager) pushWorkspaceWatchSet(agentID string) {
	agentID = strings.TrimSpace(agentID)
	m.workspaceHub.mu.Lock()
	workdirSet := make(map[string]bool)
	for key := range m.workspaceHub.watchCounts {
		if key.agentID == agentID {
			workdirSet[key.workdir] = true
		}
	}
	m.workspaceHub.mu.Unlock()
	workdirs := make([]string, 0, len(workdirSet))
	for workdir := range workdirSet {
		workdirs = append(workdirs, workdir)
	}
	sort.Strings(workdirs)

	session, err := m.resolveSession(agentID)
	if err != nil {
		return
	}
	_, _ = session.TrySendToAgent(&gatewayv2.GatewayEnvelope{
		RequestId: "workspace-watch-" + uuid.NewString(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv2.GatewayEnvelope_WorkspaceWatch{
			WorkspaceWatch: &gatewayv2.WorkspaceWatchRequest{Workdirs: workdirs},
		},
	})
}
