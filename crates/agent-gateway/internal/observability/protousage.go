package observability

import "sync/atomic"

// ProtoUsage 统计 v2 协议链路使用量：进程内原子计数，经 /api/status 的
// protocol_usage 字段暴露。
type ProtoUsage struct {
	V2BrowserConnectionsTotal  atomic.Int64
	V2BrowserConnectionsActive atomic.Int64
	V2BrowserRequestsTotal     atomic.Int64
	V2AgentConnectsTotal       atomic.Int64
	V2AgentActive              atomic.Int64
	V2TerminalConnectsTotal    atomic.Int64
}

// Usage 是进程级单例；各协议层直接打点。
var Usage ProtoUsage

// Snapshot 导出当前计数（键名即对外 JSON 字段名）。
func (u *ProtoUsage) Snapshot() map[string]int64 {
	return map[string]int64{
		"v2_browser_connections_total":  u.V2BrowserConnectionsTotal.Load(),
		"v2_browser_connections_active": u.V2BrowserConnectionsActive.Load(),
		"v2_browser_requests_total":     u.V2BrowserRequestsTotal.Load(),
		"v2_agent_connects_total":       u.V2AgentConnectsTotal.Load(),
		"v2_agent_active":               u.V2AgentActive.Load(),
		"v2_terminal_connects_total":    u.V2TerminalConnectsTotal.Load(),
	}
}
