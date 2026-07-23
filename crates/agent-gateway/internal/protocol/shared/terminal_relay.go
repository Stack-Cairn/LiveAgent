package shared

import (
	"strings"

	"google.golang.org/protobuf/proto"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

// 终端转发域逻辑（权限门控、列表合并/过滤、兴趣登记）：沿用既有处理器实现、行为不变，
// v2 共用以免各自复制一份门控规则。

// TerminalFeaturesEnabled 判断任一 Web 终端功能是否开启。
func TerminalFeaturesEnabled(sm session.AgentView) bool {
	return sm.WebTerminalEnabled() || sm.WebSshTerminalEnabled()
}

// TerminalSessionAllowed 按会话类型（local/ssh）检查其对 Web 端是否可见。
func TerminalSessionAllowed(sm session.AgentView, ts *gatewayv2.TerminalSession) bool {
	if ts == nil {
		return false
	}
	if TerminalSessionKindOf(ts) == "ssh" {
		return sm.WebSshTerminalEnabled()
	}
	return sm.WebTerminalEnabled()
}

// TerminalSessionKindOf 归一化会话类型（空值按 local 处理）。
func TerminalSessionKindOf(ts *gatewayv2.TerminalSession) string {
	if strings.TrimSpace(ts.GetKind()) == "ssh" {
		return "ssh"
	}
	return "local"
}

// TerminalEventAllowed 判断终端事件是否允许推送给 Web 端。
func TerminalEventAllowed(sm session.AgentView, event *gatewayv2.TerminalEvent) bool {
	if event == nil {
		return false
	}
	if strings.TrimSpace(event.GetKind()) == "ssh_tabs_updated" {
		return sm.WebSshTerminalEnabled()
	}
	if ts := event.GetSession(); ts != nil {
		return TerminalSessionAllowed(sm, ts)
	}
	sessionID := strings.TrimSpace(event.GetSessionId())
	if sessionID != "" && sm.TerminalSessionKind(sessionID) == "ssh" {
		return sm.WebSshTerminalEnabled()
	}
	return sm.WebTerminalEnabled()
}

// TerminalRequestAllowed 按动作与目标会话类型做权限门控。
func TerminalRequestAllowed(sm session.AgentView, action string, sessionID string) bool {
	switch action {
	case "create_ssh", "answer_ssh_prompt", "cancel_ssh_prompt", "ssh_latency",
		"ssh_tabs_list", "ssh_tab_open", "ssh_tab_close":
		return sm.WebSshTerminalEnabled()
	case "list", "close_project":
		return sm.WebTerminalEnabled() || sm.WebSshTerminalEnabled()
	case "rename", "close":
		if sm.TerminalSessionKind(sessionID) == "ssh" {
			return sm.WebSshTerminalEnabled()
		}
		return sm.WebTerminalEnabled()
	default:
		return sm.WebTerminalEnabled()
	}
}

// TerminalPermissionError 返回动作被拒时的用户可读错误信息。
func TerminalPermissionError(action string) string {
	switch action {
	case "create_ssh", "answer_ssh_prompt", "cancel_ssh_prompt", "ssh_latency",
		"ssh_tabs_list", "ssh_tab_open", "ssh_tab_close":
		return "web SSH terminal is disabled in desktop Remote settings"
	default:
		return "web terminal is disabled in desktop Remote settings"
	}
}

// FinalizeTerminalResponse 统一后处理：list 结果与缓存快照合并、快照回写、按权限过滤并登记项目兴趣。
func FinalizeTerminalResponse(
	sm session.AgentView,
	tracker *TerminalInterestTracker,
	action string,
	projectPathKey string,
	resp *gatewayv2.TerminalResponse,
) *gatewayv2.TerminalResponse {
	resp = MergeTerminalListWithCachedSnapshot(sm, action, projectPathKey, resp)
	sm.ApplyTerminalResponseSnapshot(action, projectPathKey, resp)
	resp = FilterTerminalResponseForPermissions(sm, action, resp)
	RememberTerminalInterest(tracker, action, projectPathKey, resp)
	return resp
}

// MergeTerminalListWithCachedSnapshot 把桌面端 list 响应缺失、网关缓存尚存的会话并入结果
// （桌面端重连早期列表可能不全）。
func MergeTerminalListWithCachedSnapshot(
	sm session.AgentView,
	action string,
	projectPathKey string,
	resp *gatewayv2.TerminalResponse,
) *gatewayv2.TerminalResponse {
	if resp == nil || strings.TrimSpace(action) != "list" {
		return resp
	}
	cachedSessions := sm.TerminalSessionSnapshot(projectPathKey)
	if len(cachedSessions) == 0 {
		return resp
	}
	seen := make(map[string]struct{}, len(resp.GetSessions()))
	for _, ts := range resp.GetSessions() {
		id := strings.TrimSpace(ts.GetId())
		if id != "" {
			seen[id] = struct{}{}
		}
	}
	merged := make([]*gatewayv2.TerminalSession, 0, len(resp.GetSessions())+len(cachedSessions))
	merged = append(merged, resp.GetSessions()...)
	changed := false
	for _, ts := range cachedSessions {
		id := strings.TrimSpace(ts.GetId())
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		merged = append(merged, ts)
		changed = true
	}
	if !changed {
		return resp
	}
	clone := proto.CloneOf(resp)
	clone.Sessions = merged
	return clone
}

// FilterTerminalResponseForPermissions 过滤掉 Web 端无权看到的会话。
func FilterTerminalResponseForPermissions(
	sm session.AgentView,
	action string,
	resp *gatewayv2.TerminalResponse,
) *gatewayv2.TerminalResponse {
	if resp == nil || action != "list" {
		return resp
	}
	filtered := make([]*gatewayv2.TerminalSession, 0, len(resp.GetSessions()))
	changed := false
	for _, ts := range resp.GetSessions() {
		if TerminalSessionAllowed(sm, ts) {
			filtered = append(filtered, ts)
		} else {
			changed = true
		}
	}
	if !changed {
		return resp
	}
	clone := proto.CloneOf(resp)
	clone.Sessions = filtered
	return clone
}

// RememberTerminalInterest 在列表/创建类动作后登记项目兴趣，供终端事件过滤使用。
func RememberTerminalInterest(
	tracker *TerminalInterestTracker,
	action string,
	projectPathKey string,
	resp *gatewayv2.TerminalResponse,
) {
	if tracker == nil {
		return
	}
	projectPathKey = strings.TrimSpace(projectPathKey)
	if respSession := resp.GetSession(); respSession != nil {
		if projectPathKey == "" {
			projectPathKey = strings.TrimSpace(respSession.GetProjectPathKey())
		}
	}

	switch action {
	case "list", "create", "create_ssh", "answer_ssh_prompt", "close_project":
		tracker.RememberProject(projectPathKey)
	}
}
