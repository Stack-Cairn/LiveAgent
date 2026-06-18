package server

import (
	"strings"
	"sync"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

type websocketTerminalInterestTracker struct {
	mu       sync.RWMutex
	projects map[string]struct{}
	sessions map[string]struct{}
}

func newWebsocketTerminalInterestTracker() *websocketTerminalInterestTracker {
	return &websocketTerminalInterestTracker{
		projects: make(map[string]struct{}),
		sessions: make(map[string]struct{}),
	}
}

func (t *websocketTerminalInterestTracker) rememberProject(projectPathKey string) {
	projectPathKey = strings.TrimSpace(projectPathKey)
	if projectPathKey == "" {
		return
	}
	t.mu.Lock()
	t.projects[projectPathKey] = struct{}{}
	t.mu.Unlock()
}

func (t *websocketTerminalInterestTracker) rememberSession(sessionID string, projectPathKey string) {
	sessionID = strings.TrimSpace(sessionID)
	projectPathKey = strings.TrimSpace(projectPathKey)
	if sessionID == "" && projectPathKey == "" {
		return
	}
	t.mu.Lock()
	if sessionID != "" {
		t.sessions[sessionID] = struct{}{}
	}
	if projectPathKey != "" {
		t.projects[projectPathKey] = struct{}{}
	}
	t.mu.Unlock()
}

func (t *websocketTerminalInterestTracker) forget(sessionID string, projectPathKey string) {
	sessionID = strings.TrimSpace(sessionID)
	projectPathKey = strings.TrimSpace(projectPathKey)
	t.mu.Lock()
	if sessionID != "" {
		delete(t.sessions, sessionID)
	}
	if sessionID == "" && projectPathKey != "" {
		delete(t.projects, projectPathKey)
	}
	t.mu.Unlock()
}

func (t *websocketTerminalInterestTracker) shouldForward(event *gatewayv1.TerminalEvent) bool {
	if event == nil {
		return false
	}
	sessionID := strings.TrimSpace(event.GetSessionId())
	projectPathKey := strings.TrimSpace(event.GetProjectPathKey())
	kind := strings.TrimSpace(event.GetKind())

	// Terminal metadata changes are broadcast so each browser tab can keep its
	// project list fresh; raw output remains gated behind explicit attachment.
	if kind != "output" {
		return sessionID != "" || projectPathKey != ""
	}

	t.mu.RLock()
	_, sessionSubscribed := t.sessions[sessionID]
	t.mu.RUnlock()

	return sessionID != "" && sessionSubscribed
}
