package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/session"
)

// Agent 目录与凭证管理 API（挂在管理 token 中间件下）：
//   GET    /api/agents?page=&page_size=&status=all|online|offline — Agent 筛选分页目录
//   POST   /api/agents/{id}/token         — 签发/轮换凭证并立即踢下线（明文仅出现在本次响应）
//   PATCH  /api/agents/{id}               — 修改可选名称
//   DELETE /api/agents/{id}               — 删除整条记录并断开活跃会话

// agentDirectoryEntry 合并持久化登记、独立凭证信息与实时会话状态。
type agentDirectoryEntry struct {
	AgentID        string `json:"agent_id"`
	Online         bool   `json:"online"`
	HasToken       bool   `json:"has_token"`
	RegisteredAt   string `json:"registered_at"`
	TokenCreatedAt string `json:"token_created_at,omitempty"`
	Name           string `json:"name"`

	AgentVersion   string `json:"agent_version,omitempty"`
	ConnectedSince int64  `json:"connected_since,omitempty"`
}

// ListAgents 按状态筛选并分页返回持久化 Agent 目录，同时合并当前页实时状态。
func ListAgents(sm *session.Manager, tokens *agenttoken.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		statusFilter, err := agenttoken.ParseStatusFilter(r.URL.Query().Get("status"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid status filter")
			return
		}

		// 同一次状态快照同时用于数据库筛选和当前页状态合并，避免两次读取间的竞态。
		statusesByAgentID, onlineAgentIDs := sm.AgentDirectoryStatusSnapshot()

		page, err := tokens.List(agenttoken.PageParams{
			Page:           atoiDefault(r.URL.Query().Get("page"), 0),
			PageSize:       atoiDefault(r.URL.Query().Get("page_size"), 0),
			Status:         statusFilter,
			OnlineAgentIDs: onlineAgentIDs,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "list agents failed")
			return
		}

		agents := make([]agentDirectoryEntry, 0, len(page.Entries))
		for _, entry := range page.Entries {
			row := agentDirectoryEntry{
				AgentID:      entry.AgentID,
				HasToken:     entry.HasToken,
				RegisteredAt: entry.RegisteredAt.UTC().Format(time.RFC3339),
				Name:         entry.Name,
			}
			if entry.HasToken {
				row.TokenCreatedAt = entry.TokenCreatedAt.UTC().Format(time.RFC3339)
			}
			if status, ok := statusesByAgentID[entry.AgentID]; ok {
				row.Online = status.Online
				row.AgentVersion = status.AgentVersion
				row.ConnectedSince = status.ConnectedSince
			}
			agents = append(agents, row)
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"agents":    agents,
			"page":      page.Page,
			"page_size": page.PageSize,
			"total":     page.Total,
			"has_more":  page.HasMore,
		})
	}
}

// atoiDefault 解析非负整数查询参数，非法/缺省回落到 fallback（钳制交给 Store）。
func atoiDefault(raw string, fallback int) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	if n, err := strconv.Atoi(raw); err == nil && n >= 0 {
		return n
	}
	return fallback
}

func IssueAgentToken(sm *session.Manager, tokens *agenttoken.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		agentID, err := agenttoken.NormalizeAgentID(r.PathValue("id"))
		if err != nil {
			writeAgentStoreError(w, err)
			return
		}
		name, err := decodeAgentName(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		token, err := tokens.Issue(agentID, name)
		if err != nil {
			writeAgentStoreError(w, err)
			return
		}
		disconnected := sm != nil && sm.DisconnectAgent(agentID)
		// 明文只出现在本次响应；轮换后旧凭证立即不可用于下一次连接。
		writeJSON(w, http.StatusOK, map[string]any{
			"agent_id":     agentID,
			"token":        token,
			"disconnected": disconnected,
		})
	}
}

func UpdateAgentName(tokens *agenttoken.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		agentID := strings.TrimSpace(r.PathValue("id"))
		if agentID == "" {
			writeAgentStoreError(w, agenttoken.ErrAgentIDRequired)
			return
		}
		name, err := decodeAgentName(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		if err := tokens.UpdateName(agentID, name); err != nil {
			writeAgentStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"agent_id": agentID, "name": strings.TrimSpace(name)})
	}
}

func DeleteAgent(sm *session.Manager, tokens *agenttoken.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		agentID := strings.TrimSpace(r.PathValue("id"))
		if agentID == "" {
			writeAgentStoreError(w, agenttoken.ErrAgentIDRequired)
			return
		}
		deleted, err := tokens.Delete(agentID)
		if err != nil {
			writeAgentStoreError(w, err)
			return
		}
		if !deleted {
			writeAgentStoreError(w, agenttoken.ErrAgentNotFound)
			return
		}
		disconnected := sm.ForgetAgent(agentID)
		writeJSON(w, http.StatusOK, map[string]any{
			"agent_id":     agentID,
			"deleted":      true,
			"disconnected": disconnected,
		})
	}
}

type agentNameRequest struct {
	Name string `json:"name"`
}

func decodeAgentName(r *http.Request) (string, error) {
	if r.Body == nil || r.ContentLength == 0 {
		return "", nil
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 4097))
	decoder.DisallowUnknownFields()
	var payload agentNameRequest
	if err := decoder.Decode(&payload); err != nil {
		if errors.Is(err, io.EOF) {
			return "", nil
		}
		return "", errors.New("invalid request body")
	}
	return payload.Name, nil
}

func writeAgentStoreError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, agenttoken.ErrAgentIDRequired),
		errors.Is(err, agenttoken.ErrInvalidAgentID),
		errors.Is(err, agenttoken.ErrAgentNameTooLong):
		status = http.StatusBadRequest
	case errors.Is(err, agenttoken.ErrAgentNotFound):
		status = http.StatusNotFound
	}
	writeJSON(w, status, map[string]any{"error": err.Error()})
}
