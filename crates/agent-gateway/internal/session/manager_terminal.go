package session

import (
	"context"
	"sort"
	"strings"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func (m *Manager) SubscribeTerminalEvents() (<-chan Tagged[*gatewayv2.TerminalEvent], func()) {
	ch := make(chan Tagged[*gatewayv2.TerminalEvent], 4096)

	m.syncHub.terminalMu.Lock()
	subID := m.syncHub.nextTerminalSubID
	m.syncHub.nextTerminalSubID += 1
	m.syncHub.terminalSubscribers[subID] = ch
	m.syncHub.terminalMu.Unlock()

	cleanup := func() {
		m.syncHub.terminalMu.Lock()
		// Do not close the channel here: broadcastTerminalEvent sends after
		// copying subscribers, so closing can race with an in-flight send.
		delete(m.syncHub.terminalSubscribers, subID)
		m.syncHub.terminalMu.Unlock()
	}

	return ch, cleanup
}

// RegisterTerminalStreamToAgentIfCurrent 把终端数据面鉴权结果与连接作为一个注册
// 动作提交。isCurrent 在 registry 写锁内执行，凭证已轮换或删除时不会留下登记项。
// 同 Agent 重连会撤销旧终端连接；不同 Agent 互不影响。
func (m *Manager) RegisterTerminalStreamToAgentIfCurrent(
	agentID string,
	ch chan *gatewayv2.TerminalStreamFrame,
	revoke func(),
	isCurrent func() bool,
) (func(), bool) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" || ch == nil || revoke == nil {
		return func() {}, false
	}

	m.registry.mu.Lock()
	if isCurrent != nil && !isCurrent() {
		m.registry.mu.Unlock()
		return func() {}, false
	}
	entry := m.registry.entryLocked(agentID)
	entry.terminalStreamMu.Lock()
	previousRevoke := entry.terminalStreamRevoke
	entry.terminalStreamToAgent = ch
	entry.terminalStreamRevoke = revoke
	entry.terminalStreamMu.Unlock()
	m.registry.mu.Unlock()

	if previousRevoke != nil {
		previousRevoke()
	}

	return func() {
		entry.terminalStreamMu.Lock()
		if entry.terminalStreamToAgent == ch {
			entry.terminalStreamToAgent = nil
			entry.terminalStreamRevoke = nil
		}
		entry.terminalStreamMu.Unlock()
	}, true
}

// SendTerminalFrameToAgent 把浏览器终端帧送往目标 Agent 的数据面连接。
// 终端数据面独立于控制会话：只要求通道已登记，不要求控制会话在线
// （终端数据面是独立连接，两者的建立顺序不定）。
func (m *Manager) SendTerminalFrameToAgent(ctx context.Context, agentID string, frame *gatewayv2.TerminalStreamFrame) error {
	if frame == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	entry := m.entryFor(agentID)
	if entry == nil {
		return ErrAgentOffline
	}
	entry.terminalStreamMu.Lock()
	ch := entry.terminalStreamToAgent
	entry.terminalStreamMu.Unlock()
	if ch == nil {
		return ErrAgentOffline
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case ch <- frame:
		return nil
	}
}

func (m *Manager) SubscribeTerminalStreamFrames() (<-chan Tagged[*gatewayv2.TerminalStreamFrame], func()) {
	ch := make(chan Tagged[*gatewayv2.TerminalStreamFrame], 4096)

	m.syncHub.terminalStreamMu.Lock()
	subID := m.syncHub.nextTerminalStreamSubID
	m.syncHub.nextTerminalStreamSubID += 1
	m.syncHub.terminalStreamSubscribers[subID] = ch
	m.syncHub.terminalStreamMu.Unlock()

	cleanup := func() {
		m.syncHub.terminalStreamMu.Lock()
		delete(m.syncHub.terminalStreamSubscribers, subID)
		m.syncHub.terminalStreamMu.Unlock()
	}

	return ch, cleanup
}

func (m *Manager) BroadcastTerminalStreamFrame(agentID string, frame *gatewayv2.TerminalStreamFrame) {
	if frame == nil {
		return
	}
	tagged := Tagged[*gatewayv2.TerminalStreamFrame]{AgentID: agentID, Event: frame}
	m.syncHub.terminalStreamMu.Lock()
	for id, ch := range m.syncHub.terminalStreamSubscribers {
		select {
		case ch <- tagged:
		default:
			delete(m.syncHub.terminalStreamSubscribers, id)
			close(ch)
		}
	}
	m.syncHub.terminalStreamMu.Unlock()
}

func cloneTerminalSession(session *gatewayv2.TerminalSession) *gatewayv2.TerminalSession {
	if session == nil {
		return nil
	}
	return &gatewayv2.TerminalSession{
		Id:             session.GetId(),
		ProjectPathKey: session.GetProjectPathKey(),
		Cwd:            session.GetCwd(),
		Shell:          session.GetShell(),
		Title:          session.GetTitle(),
		Pid:            session.GetPid(),
		Cols:           session.GetCols(),
		Rows:           session.GetRows(),
		CreatedAt:      session.GetCreatedAt(),
		UpdatedAt:      session.GetUpdatedAt(),
		FinishedAt:     session.GetFinishedAt(),
		ExitCode:       session.GetExitCode(),
		Running:        session.GetRunning(),
		Kind:           session.GetKind(),
		Ssh:            cloneTerminalSshMetadata(session.GetSsh()),
	}
}

func cloneTerminalSshMetadata(ssh *gatewayv2.TerminalSshMetadata) *gatewayv2.TerminalSshMetadata {
	if ssh == nil {
		return nil
	}
	return &gatewayv2.TerminalSshMetadata{
		HostId:               ssh.GetHostId(),
		HostName:             ssh.GetHostName(),
		Username:             ssh.GetUsername(),
		Host:                 ssh.GetHost(),
		Port:                 ssh.GetPort(),
		AuthType:             ssh.GetAuthType(),
		Status:               ssh.GetStatus(),
		ReconnectAttempt:     ssh.GetReconnectAttempt(),
		ReconnectMaxAttempts: ssh.GetReconnectMaxAttempts(),
		SftpEnabled:          ssh.GetSftpEnabled(),
	}
}

func (m *Manager) TerminalSessionKind(agentID, sessionID string) string {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return ""
	}
	entry := m.entryFor(agentID)
	if entry == nil {
		return ""
	}
	entry.terminalSessionsMu.Lock()
	defer entry.terminalSessionsMu.Unlock()
	session := entry.terminalSessions[sessionID]
	if session == nil {
		return ""
	}
	if strings.TrimSpace(session.GetKind()) == "ssh" {
		return "ssh"
	}
	return "local"
}

func terminalSessionSortKey(session *gatewayv2.TerminalSession) (string, uint64, string) {
	if session == nil {
		return "", 0, ""
	}
	return strings.TrimSpace(session.GetProjectPathKey()), session.GetCreatedAt(), strings.TrimSpace(session.GetId())
}

func sortTerminalSessions(sessions []*gatewayv2.TerminalSession) {
	sort.Slice(sessions, func(i, j int) bool {
		leftProject, leftCreatedAt, leftID := terminalSessionSortKey(sessions[i])
		rightProject, rightCreatedAt, rightID := terminalSessionSortKey(sessions[j])
		if leftProject != rightProject {
			return leftProject < rightProject
		}
		if leftCreatedAt != rightCreatedAt {
			return leftCreatedAt < rightCreatedAt
		}
		return leftID < rightID
	})
}

func terminalSessionMatchesProject(session *gatewayv2.TerminalSession, projectPathKey string) bool {
	projectPathKey = strings.TrimSpace(projectPathKey)
	if projectPathKey == "" {
		return true
	}
	if session == nil {
		return false
	}
	return strings.TrimSpace(session.GetProjectPathKey()) == projectPathKey
}

// clearTerminalSessionSnapshot 清空 agent_id 的终端会话快照（该 Agent 会话更替时，
// 旧连接的终端进程已随桌面端断开失效）。
func (m *Manager) clearTerminalSessionSnapshot(agentID string) {
	entry := m.entryFor(agentID)
	if entry == nil {
		return
	}
	entry.terminalSessionsMu.Lock()
	entry.terminalSessions = make(map[string]*gatewayv2.TerminalSession)
	entry.terminalSessionsMu.Unlock()
}

func (m *Manager) TerminalSessionSnapshot(agentID, projectPathKey string) []*gatewayv2.TerminalSession {
	projectPathKey = strings.TrimSpace(projectPathKey)
	entry := m.entryFor(agentID)
	if entry == nil {
		return nil
	}
	entry.terminalSessionsMu.Lock()
	sessions := make([]*gatewayv2.TerminalSession, 0, len(entry.terminalSessions))
	for _, session := range entry.terminalSessions {
		if !terminalSessionMatchesProject(session, projectPathKey) {
			continue
		}
		if cloned := cloneTerminalSession(session); cloned != nil {
			sessions = append(sessions, cloned)
		}
	}
	entry.terminalSessionsMu.Unlock()
	sortTerminalSessions(sessions)
	return sessions
}

func (m *Manager) replaceTerminalSessionSnapshot(
	entry *agentEntry,
	projectPathKey string,
	sessions []*gatewayv2.TerminalSession,
) {
	projectPathKey = strings.TrimSpace(projectPathKey)
	entry.terminalSessionsMu.Lock()
	if projectPathKey == "" {
		entry.terminalSessions = make(map[string]*gatewayv2.TerminalSession)
	} else {
		for id, session := range entry.terminalSessions {
			if terminalSessionMatchesProject(session, projectPathKey) {
				delete(entry.terminalSessions, id)
			}
		}
	}
	for _, session := range sessions {
		id := strings.TrimSpace(session.GetId())
		if id == "" {
			continue
		}
		entry.terminalSessions[id] = cloneTerminalSession(session)
	}
	entry.terminalSessionsMu.Unlock()
}

func (m *Manager) ApplyTerminalResponseSnapshot(
	agentID string,
	action string,
	projectPathKey string,
	resp *gatewayv2.TerminalResponse,
) {
	if resp == nil {
		return
	}
	action = strings.TrimSpace(action)
	projectPathKey = strings.TrimSpace(projectPathKey)
	entry := m.entryOrCreate(agentID)
	if entry == nil {
		return
	}

	switch action {
	case "list":
		m.replaceTerminalSessionSnapshot(entry, projectPathKey, resp.GetSessions())
	case "close_project":
		m.replaceTerminalSessionSnapshot(entry, projectPathKey, nil)
	case "close":
		if sessionID := strings.TrimSpace(resp.GetSession().GetId()); sessionID != "" {
			entry.terminalSessionsMu.Lock()
			delete(entry.terminalSessions, sessionID)
			entry.terminalSessionsMu.Unlock()
		}
	case "create", "create_ssh", "answer_ssh_prompt", "attach", "snapshot", "input", "resize", "rename":
		session := resp.GetSession()
		sessionID := strings.TrimSpace(session.GetId())
		if sessionID == "" {
			return
		}
		entry.terminalSessionsMu.Lock()
		entry.terminalSessions[sessionID] = cloneTerminalSession(session)
		entry.terminalSessionsMu.Unlock()
	}
}

func (m *Manager) applyTerminalEventSnapshot(entry *agentEntry, event *gatewayv2.TerminalEvent) {
	kind := strings.TrimSpace(event.GetKind())
	sessionID := strings.TrimSpace(event.GetSessionId())
	if sessionID == "" && event.GetSession() != nil {
		sessionID = strings.TrimSpace(event.GetSession().GetId())
	}
	if sessionID == "" {
		return
	}

	entry.terminalSessionsMu.Lock()
	if kind == "closed" {
		delete(entry.terminalSessions, sessionID)
	} else if session := cloneTerminalSession(event.GetSession()); session != nil {
		entry.terminalSessions[sessionID] = session
	}
	entry.terminalSessionsMu.Unlock()
}

func (m *Manager) broadcastTerminalEvent(agentID string, event *gatewayv2.TerminalEvent) {
	if event == nil {
		return
	}
	entry := m.entryOrCreate(agentID)
	if entry == nil {
		return
	}

	m.applyTerminalEventSnapshot(entry, event)

	m.syncHub.terminalMu.Lock()
	subscribers := make([]chan Tagged[*gatewayv2.TerminalEvent], 0, len(m.syncHub.terminalSubscribers))
	for _, ch := range m.syncHub.terminalSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.syncHub.terminalMu.Unlock()

	tagged := Tagged[*gatewayv2.TerminalEvent]{AgentID: agentID, Event: event}
	for _, ch := range subscribers {
		select {
		case ch <- tagged:
		case <-time.After(50 * time.Millisecond):
		}
	}
}
