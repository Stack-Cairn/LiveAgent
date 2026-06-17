package session

import (
	"sort"
	"strings"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (m *Manager) SubscribeTerminalEvents() (<-chan *gatewayv1.TerminalEvent, func()) {
	ch := make(chan *gatewayv1.TerminalEvent, 4096)

	m.syncHub.terminalMu.Lock()
	subID := m.syncHub.nextTerminalSubID
	m.syncHub.nextTerminalSubID += 1
	m.syncHub.terminalSubscribers[subID] = ch
	m.syncHub.terminalMu.Unlock()

	cleanup := func() {
		m.syncHub.terminalMu.Lock()
		if _, ok := m.syncHub.terminalSubscribers[subID]; ok {
			// Do not close the channel here: broadcastTerminalEvent sends after
			// copying subscribers, so closing can race with an in-flight send.
			delete(m.syncHub.terminalSubscribers, subID)
		}
		m.syncHub.terminalMu.Unlock()
	}

	return ch, cleanup
}

func cloneTerminalSession(session *gatewayv1.TerminalSession) *gatewayv1.TerminalSession {
	if session == nil {
		return nil
	}
	return &gatewayv1.TerminalSession{
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

func cloneTerminalSshMetadata(ssh *gatewayv1.TerminalSshMetadata) *gatewayv1.TerminalSshMetadata {
	if ssh == nil {
		return nil
	}
	return &gatewayv1.TerminalSshMetadata{
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

func (m *Manager) TerminalSessionKind(sessionID string) string {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return ""
	}
	m.syncHub.terminalMu.Lock()
	defer m.syncHub.terminalMu.Unlock()
	session := m.syncHub.terminalSessions[sessionID]
	if session == nil {
		return ""
	}
	if strings.TrimSpace(session.GetKind()) == "ssh" {
		return "ssh"
	}
	return "local"
}

func terminalSessionSortKey(session *gatewayv1.TerminalSession) (string, uint64, string) {
	if session == nil {
		return "", 0, ""
	}
	return strings.TrimSpace(session.GetProjectPathKey()), session.GetCreatedAt(), strings.TrimSpace(session.GetId())
}

func sortTerminalSessions(sessions []*gatewayv1.TerminalSession) {
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

func terminalSessionMatchesProject(session *gatewayv1.TerminalSession, projectPathKey string) bool {
	projectPathKey = strings.TrimSpace(projectPathKey)
	if projectPathKey == "" {
		return true
	}
	if session == nil {
		return false
	}
	return strings.TrimSpace(session.GetProjectPathKey()) == projectPathKey
}

func (m *Manager) clearTerminalSessionSnapshot() {
	m.syncHub.terminalMu.Lock()
	m.syncHub.terminalSessions = make(map[string]*gatewayv1.TerminalSession)
	m.syncHub.terminalMu.Unlock()
}

func (m *Manager) TerminalSessionSnapshot(projectPathKey string) []*gatewayv1.TerminalSession {
	projectPathKey = strings.TrimSpace(projectPathKey)
	m.syncHub.terminalMu.Lock()
	sessions := make([]*gatewayv1.TerminalSession, 0, len(m.syncHub.terminalSessions))
	for _, session := range m.syncHub.terminalSessions {
		if !terminalSessionMatchesProject(session, projectPathKey) {
			continue
		}
		if cloned := cloneTerminalSession(session); cloned != nil {
			sessions = append(sessions, cloned)
		}
	}
	m.syncHub.terminalMu.Unlock()
	sortTerminalSessions(sessions)
	return sessions
}

func (m *Manager) ReplaceTerminalSessionSnapshot(
	projectPathKey string,
	sessions []*gatewayv1.TerminalSession,
) {
	projectPathKey = strings.TrimSpace(projectPathKey)
	m.syncHub.terminalMu.Lock()
	if projectPathKey == "" {
		m.syncHub.terminalSessions = make(map[string]*gatewayv1.TerminalSession)
	} else {
		for id, session := range m.syncHub.terminalSessions {
			if terminalSessionMatchesProject(session, projectPathKey) {
				delete(m.syncHub.terminalSessions, id)
			}
		}
	}
	for _, session := range sessions {
		id := strings.TrimSpace(session.GetId())
		if id == "" {
			continue
		}
		m.syncHub.terminalSessions[id] = cloneTerminalSession(session)
	}
	m.syncHub.terminalMu.Unlock()
}

func (m *Manager) ApplyTerminalResponseSnapshot(
	action string,
	projectPathKey string,
	resp *gatewayv1.TerminalResponse,
) {
	if resp == nil {
		return
	}
	action = strings.TrimSpace(action)
	projectPathKey = strings.TrimSpace(projectPathKey)

	switch action {
	case "list":
		m.ReplaceTerminalSessionSnapshot(projectPathKey, resp.GetSessions())
	case "close_project":
		m.ReplaceTerminalSessionSnapshot(projectPathKey, nil)
	case "close":
		if sessionID := strings.TrimSpace(resp.GetSession().GetId()); sessionID != "" {
			m.syncHub.terminalMu.Lock()
			delete(m.syncHub.terminalSessions, sessionID)
			m.syncHub.terminalMu.Unlock()
		}
	case "create", "create_ssh", "answer_ssh_prompt", "attach", "snapshot", "input", "resize", "rename":
		session := resp.GetSession()
		sessionID := strings.TrimSpace(session.GetId())
		if sessionID == "" {
			return
		}
		m.syncHub.terminalMu.Lock()
		m.syncHub.terminalSessions[sessionID] = cloneTerminalSession(session)
		m.syncHub.terminalMu.Unlock()
	}
}

func (m *Manager) applyTerminalEventSnapshot(event *gatewayv1.TerminalEvent) {
	if event == nil {
		return
	}
	kind := strings.TrimSpace(event.GetKind())
	sessionID := strings.TrimSpace(event.GetSessionId())
	if sessionID == "" && event.GetSession() != nil {
		sessionID = strings.TrimSpace(event.GetSession().GetId())
	}
	if sessionID == "" {
		return
	}

	m.syncHub.terminalMu.Lock()
	if kind == "closed" {
		delete(m.syncHub.terminalSessions, sessionID)
	} else if session := cloneTerminalSession(event.GetSession()); session != nil {
		m.syncHub.terminalSessions[sessionID] = session
	}
	m.syncHub.terminalMu.Unlock()
}

func (m *Manager) broadcastTerminalEvent(event *gatewayv1.TerminalEvent) {
	if event == nil {
		return
	}

	m.applyTerminalEventSnapshot(event)

	m.syncHub.terminalMu.Lock()
	subscribers := make([]chan *gatewayv1.TerminalEvent, 0, len(m.syncHub.terminalSubscribers))
	for _, ch := range m.syncHub.terminalSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.syncHub.terminalMu.Unlock()

	for _, ch := range subscribers {
		select {
		case ch <- event:
		case <-time.After(50 * time.Millisecond):
		}
	}
}
