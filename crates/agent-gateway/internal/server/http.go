package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	gateway "github.com/liveagent/agent-gateway"
	"github.com/liveagent/agent-gateway/internal/auth"
	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

// NewHTTPServer 构造 HTTP 路由；生产启动时 tokens 始终是已初始化的 Agent 目录与凭证存储。
func NewHTTPServer(cfg *config.Config, sm *session.Manager, tokens *agenttoken.Store) http.Handler {
	rootMux := http.NewServeMux()
	rootMux.HandleFunc("GET /healthz", handler.Health())

	// v2 统一协议（WebSocket+Protobuf）三链路。
	v2 := pbws.NewServer(cfg, sm, tokens)
	rootMux.Handle("/ws/v2", v2.BrowserHandler())
	rootMux.Handle("/ws/v2/agent", v2.AgentHandler())
	rootMux.Handle("/ws/v2/terminal", v2.TerminalHandler())

	rootMux.HandleFunc("/t/", publicTunnelProxy(sm))
	rootMux.HandleFunc("GET /image-proxy", handler.ImageProxy(cfg.RequestTimeout))
	rootMux.HandleFunc("GET /api/public/history-shares/{token}", publicHistoryShare(cfg, sm))

	apiMux := http.NewServeMux()
	apiMux.HandleFunc("GET /api/status", handler.Status(sm))
	apiMux.HandleFunc("POST /api/files/import", handler.ImportReadableFiles(sm, cfg.RequestTimeout))
	// Agent 目录与凭证管理，仅管理 token 可访问。
	apiMux.HandleFunc("GET /api/agents", handler.ListAgents(sm, tokens))
	apiMux.HandleFunc("POST /api/agents/{id}/token", handler.IssueAgentToken(sm, tokens))
	apiMux.HandleFunc("PATCH /api/agents/{id}", handler.UpdateAgentName(tokens))
	apiMux.HandleFunc("DELETE /api/agents/{id}", handler.DeleteAgent(sm, tokens))
	rootMux.Handle("/api/", auth.HTTPMiddleware(cfg.Token, apiMux))

	webFS, err := fs.Sub(gateway.WebUIAssets, "web/dist")
	if err != nil {
		panic(err)
	}
	indexHTML, err := fs.ReadFile(webFS, "index.html")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(webFS))
	serveIndex := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(indexHTML))
	}

	rootMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		cleanPath := path.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if cleanPath == "." || cleanPath == "" || cleanPath == "index.html" {
			serveIndex(w, r)
			return
		}

		file, err := webFS.Open(cleanPath)
		if err == nil {
			if stat, statErr := file.Stat(); statErr == nil && !stat.IsDir() {
				_ = file.Close()
				if strings.HasPrefix(cleanPath, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				fileServer.ServeHTTP(w, r)
				return
			}
			_ = file.Close()
		}

		if isWebUIStaticAssetPath(cleanPath) {
			http.NotFound(w, r)
			return
		}

		serveIndex(w, r)
	})

	return rootMux
}

func isWebUIStaticAssetPath(cleanPath string) bool {
	cleanPath = strings.TrimSpace(cleanPath)
	if cleanPath == "" || cleanPath == "." || cleanPath == "index.html" {
		return false
	}
	return strings.HasPrefix(cleanPath, "assets/") || path.Ext(cleanPath) != ""
}

func publicHistoryShare(cfg *config.Config, sm *session.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimSpace(r.PathValue("token"))
		if token == "" {
			writePublicHistoryShareError(w, http.StatusNotFound, "share not found")
			return
		}

		timeout := cfg.RequestTimeout
		if timeout <= 0 {
			timeout = 2 * time.Minute
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()

		requestID := "public-history-share-" + uuid.NewString()
		response, err := resolveHistoryShareAcrossAgents(ctx, sm, requestID, token)
		if err != nil {
			switch {
			case errors.Is(err, session.ErrAgentOffline):
				writePublicHistoryShareError(w, http.StatusServiceUnavailable, "agent offline")
			case errors.Is(err, context.DeadlineExceeded):
				writePublicHistoryShareError(w, http.StatusGatewayTimeout, "request timed out")
			default:
				writePublicHistoryShareError(w, http.StatusInternalServerError, "share request failed")
			}
			return
		}
		if errResp := response.GetError(); errResp != nil {
			writePublicHistoryShareError(w, handler.GatewayErrorStatus(errResp), errResp.GetMessage())
			return
		}

		share := response.GetHistoryShareResolveResp()
		if share == nil {
			writePublicHistoryShareError(w, http.StatusBadGateway, "unexpected agent response")
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"conversation_id":     share.GetConversationId(),
			"messages_json":       share.GetMessagesJson(),
			"total_message_count": share.GetTotalMessageCount(),
			"conversation":        conversationSummaryPayload(share.GetConversation()),
			"redact_tool_content": share.GetRedactToolContent(),
		})
	}
}

func writePublicHistoryShareError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"error": strings.TrimSpace(message),
	})
}

// resolveHistoryShareAcrossAgents 依次向各在线 Agent 解析公开分享 token（分享属于
// 某一台桌面端，URL 不携带 agent 信息）：首个成功命中者胜；全部未命中返回最后一个
// 分享层错误（error=99 臂）以保留 not-found 语义。≤10 Agent 且是公开低频端点，
// 串行短超时探询已足够。
func resolveHistoryShareAcrossAgents(
	ctx context.Context,
	sm *session.Manager,
	requestID string,
	token string,
) (*gatewayv2.AgentEnvelope, error) {
	agentIDs := sm.ConnectedAgentIDs()
	if len(agentIDs) == 0 {
		return nil, session.ErrAgentOffline
	}
	var lastResponse *gatewayv2.AgentEnvelope
	var lastErr error
	for index, agentID := range agentIDs {
		probeCtx := ctx
		var cancel context.CancelFunc
		if len(agentIDs) > 1 {
			// 均分剩余时限，避免第一个无响应的 Agent 吃满整个窗口。
			probeCtx, cancel = context.WithTimeout(ctx, perAgentShareTimeout(ctx, len(agentIDs)-index))
		}
		response, err := sm.AwaitUnaryResponse(probeCtx, agentID, requestID+"-"+agentID, &gatewayv2.GatewayEnvelope{
			RequestId: requestID + "-" + agentID,
			Timestamp: time.Now().Unix(),
			Payload: &gatewayv2.GatewayEnvelope_HistoryShareResolve{
				HistoryShareResolve: &gatewayv2.HistoryShareResolveRequest{
					Token: token,
				},
			},
		})
		if cancel != nil {
			cancel()
		}
		if err != nil {
			lastErr = err
			continue
		}
		if response.GetError() == nil && response.GetHistoryShareResolveResp() != nil {
			return response, nil
		}
		lastResponse = response
	}
	if lastResponse != nil {
		return lastResponse, nil
	}
	return nil, lastErr
}

func perAgentShareTimeout(ctx context.Context, remaining int) time.Duration {
	deadline, ok := ctx.Deadline()
	if !ok || remaining <= 0 {
		return 5 * time.Second
	}
	share := time.Until(deadline) / time.Duration(remaining)
	if share < time.Second {
		return time.Second
	}
	return share
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
