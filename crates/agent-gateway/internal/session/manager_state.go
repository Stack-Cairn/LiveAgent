package session

import (
	"strings"
	"sync"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// sessionRegistry 按 agent_id 维护多个桌面 Agent 的登记项。entry 断线后保留
// （auth/runtime 快照跨重连存活），同 id 重连只顶掉该 id 的旧会话。
type sessionRegistry struct {
	mu     sync.RWMutex
	agents map[string]*agentEntry
}

// agentEntry 是单个 Agent 的登记项；session 为 nil 表示当前离线。
// epoch 在每次会话更替时自增，用于把探活结果绑定到具体一次连接。
// 各快照按 Agent 隔离并跨断线存活（重连后浏览器无需等待全量重推）。
type agentEntry struct {
	id           string
	session      *AgentSession
	sessionEpoch uint64
	lastAuth     AuthSnapshot
	authValid    bool

	runtimeState          string
	runtimeWorkerID       string
	runtimeLastHeartbeat  time.Time
	runtimeVisible        bool
	runtimeActiveRunCount uint32
	chatRuntimeProbeAt    time.Time

	// settingsSnapshot 缓存该 Agent 最近一次 settings 同步（功能门控依据）。
	settingsSnapshotMu sync.RWMutex
	settingsSnapshot   map[string]any

	// terminalSessions 缓存该 Agent 的终端会话快照（浏览器接入时回放）。
	terminalSessionsMu sync.Mutex
	terminalSessions   map[string]*gatewayv2.TerminalSession

	// chatQueueSnapshots 缓存该 Agent 各会话的提示队列快照。
	chatQueueSnapshotsMu sync.Mutex
	chatQueueSnapshots   map[string]chatQueueSnapshotRecord

	// terminalStreamToAgent 是该 Agent 终端数据面连接的入站通道；revoke
	// 关闭通道所属连接，使凭证轮换和删除能同时撤销控制面与终端数据面。
	terminalStreamMu      sync.Mutex
	terminalStreamToAgent chan *gatewayv2.TerminalStreamFrame
	terminalStreamRevoke  func()
}

func newAgentEntry(id string) *agentEntry {
	return &agentEntry{
		id:                 id,
		terminalSessions:   make(map[string]*gatewayv2.TerminalSession),
		chatQueueSnapshots: make(map[string]chatQueueSnapshotRecord),
	}
}

func newSessionRegistry() *sessionRegistry {
	return &sessionRegistry{agents: make(map[string]*agentEntry)}
}

// normalizeAgentKey 统一 agent_id 的 map 键形态（去空白）。
func normalizeAgentKey(agentID string) string {
	return strings.TrimSpace(agentID)
}

// entryLocked 取或建 agent_id 的登记项；空 id 不创建登记项。调用方需持有写锁。
func (r *sessionRegistry) entryLocked(agentID string) *agentEntry {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return nil
	}
	entry := r.agents[agentID]
	if entry == nil {
		entry = newAgentEntry(agentID)
		r.agents[agentID] = entry
	}
	return entry
}

// resolveOnlineLocked 按非空 agent_id 精确解析在线登记项。
// 调用方需持锁（读锁即可）。
func (r *sessionRegistry) resolveOnlineLocked(agentID string) (*agentEntry, error) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return nil, ErrAgentIDRequired
	}
	if entry := r.agents[agentID]; entry != nil && entry.session != nil {
		return entry, nil
	}
	return nil, ErrAgentOffline
}

// entryForSessionLocked 反查 session 所属的登记项；session 已被顶替/清除时返回 nil，
// 使旧连接迟到的心跳与运行时上报不会污染新会话。
func (r *sessionRegistry) entryForSessionLocked(session *AgentSession) *agentEntry {
	if session == nil {
		return nil
	}
	entry := r.agents[strings.TrimSpace(session.AgentID)]
	if entry == nil || entry.session != session {
		return nil
	}
	return entry
}

// entryFor 返回非空 agent_id 的登记项（可能离线）；不存在或 id 为空返回 nil。
// 快照读写走 entry 自身的细粒度锁，注册表锁只保护 map 查找。
func (m *Manager) entryFor(agentID string) *agentEntry {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return nil
	}
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	return m.registry.agents[agentID]
}

// entryOrCreate 按非空 agent_id 取或建登记项；空 id 返回 nil。
func (m *Manager) entryOrCreate(agentID string) *agentEntry {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return nil
	}
	m.registry.mu.Lock()
	defer m.registry.mu.Unlock()
	return m.registry.entryLocked(agentID)
}

// resolveEntry 按非空 agent_id 精确解析在线登记项。
func (m *Manager) resolveEntry(agentID string) (*agentEntry, error) {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	return m.registry.resolveOnlineLocked(agentID)
}

// ResolveAgentID 返回请求明确指向的在线 agent_id；空 id 返回 ErrAgentIDRequired。
func (m *Manager) ResolveAgentID(agentID string) (string, error) {
	entry, err := m.resolveEntry(agentID)
	if err != nil {
		return "", err
	}
	return entry.id, nil
}

// Tagged 给广播事件附加来源 agent_id。hub 订阅保持全局（每浏览器连接一份订阅），
// 事件按标签由消费端过滤/盖帧；标签一律取自已认证会话的 AgentID，是跨 Agent
// 隔离的唯一事实源。
type Tagged[T any] struct {
	AgentID string
	Event   T
}

type syncHub struct {
	historyMu          sync.Mutex
	nextHistorySubID   int
	historySubscribers map[int]chan Tagged[*gatewayv2.HistorySyncEvent]

	settingsMu          sync.Mutex
	nextSettingsSubID   int
	settingsSubscribers map[int]chan Tagged[*gatewayv2.SettingsSyncEvent]

	terminalMu          sync.Mutex
	nextTerminalSubID   int
	terminalSubscribers map[int]chan Tagged[*gatewayv2.TerminalEvent]

	terminalStreamMu          sync.Mutex
	nextTerminalStreamSubID   int
	terminalStreamSubscribers map[int]chan Tagged[*gatewayv2.TerminalStreamFrame]

	sftpMu          sync.Mutex
	nextSftpSubID   int
	sftpSubscribers map[int]chan Tagged[*gatewayv2.SftpEvent]

	chatQueueMu          sync.Mutex
	nextChatQueueSubID   int
	chatQueueSubscribers map[int]chan Tagged[*gatewayv2.ChatQueueEvent]
}

func newSyncHub() *syncHub {
	return &syncHub{
		historySubscribers:        make(map[int]chan Tagged[*gatewayv2.HistorySyncEvent]),
		settingsSubscribers:       make(map[int]chan Tagged[*gatewayv2.SettingsSyncEvent]),
		terminalSubscribers:       make(map[int]chan Tagged[*gatewayv2.TerminalEvent]),
		terminalStreamSubscribers: make(map[int]chan Tagged[*gatewayv2.TerminalStreamFrame]),
		sftpSubscribers:           make(map[int]chan Tagged[*gatewayv2.SftpEvent]),
		chatQueueSubscribers:      make(map[int]chan Tagged[*gatewayv2.ChatQueueEvent]),
	}
}
