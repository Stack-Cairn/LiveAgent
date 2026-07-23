// Package shared 存放 v2 协议层共用、且不属于 session 或 wscore 的连接级构件。
package shared

import (
	"strings"
	"sync"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// TerminalInterestTracker 记录单条连接的终端会话/项目关注集，决定事件是否转发：
// 元数据事件广播，原始输出仅推给显式附着的连接。沿用既有实现，行为不变；并发安全。
type TerminalInterestTracker struct {
	mu       sync.RWMutex
	projects map[string]struct{}
	sessions map[string]struct{}
}

// NewTerminalInterestTracker 构造空关注集。
func NewTerminalInterestTracker() *TerminalInterestTracker {
	return &TerminalInterestTracker{
		projects: make(map[string]struct{}),
		sessions: make(map[string]struct{}),
	}
}

// RememberProject 登记对某项目终端列表的关注。
func (t *TerminalInterestTracker) RememberProject(projectPathKey string) {
	projectPathKey = strings.TrimSpace(projectPathKey)
	if projectPathKey == "" {
		return
	}
	t.mu.Lock()
	t.projects[projectPathKey] = struct{}{}
	t.mu.Unlock()
}

// RememberSession 登记对某终端会话（及其项目）的附着。
func (t *TerminalInterestTracker) RememberSession(sessionID string, projectPathKey string) {
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

// Forget 解除会话附着；仅给出项目键时解除项目关注。
func (t *TerminalInterestTracker) Forget(sessionID string, projectPathKey string) {
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

// ShouldForward 判定终端事件是否应推送给本连接。
func (t *TerminalInterestTracker) ShouldForward(event *gatewayv2.TerminalEvent) bool {
	if event == nil {
		return false
	}
	sessionID := strings.TrimSpace(event.GetSessionId())
	projectPathKey := strings.TrimSpace(event.GetProjectPathKey())
	kind := strings.TrimSpace(event.GetKind())

	// 元数据变化广播给所有标签页保持列表新鲜；原始输出只推给显式附着的连接。
	if kind != "output" {
		return sessionID != "" || projectPathKey != ""
	}

	t.mu.RLock()
	_, sessionSubscribed := t.sessions[sessionID]
	t.mu.RUnlock()

	return sessionID != "" && sessionSubscribed
}
