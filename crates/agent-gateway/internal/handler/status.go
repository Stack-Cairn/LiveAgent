package handler

import (
	"net/http"

	"github.com/liveagent/agent-gateway/internal/observability"
	"github.com/liveagent/agent-gateway/internal/session"
)

// statusResponse 是全局鉴权检查与 Agent 目录响应，不承担具体 Agent 寻址。
type statusResponse struct {
	Agents        []session.Status `json:"agents"`
	ProtocolUsage map[string]int64 `json:"protocol_usage"`
}

func Status(sm *session.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, statusResponse{
			Agents:        sm.AgentStatuses(),
			ProtocolUsage: observability.Usage.Snapshot(),
		})
	}
}
