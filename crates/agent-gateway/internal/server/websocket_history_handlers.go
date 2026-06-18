package server

import (
	"encoding/json"
	"strings"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (c *websocketConnection) handleHistoryList(req websocketRequest) {
	type payload struct {
		Page     int    `json:"page"`
		PageSize int    `json:"page_size"`
		Cwd      string `json:"cwd"`
		CwdEmpty bool   `json:"cwd_empty"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.list payload")
		return
	}
	page := body.Page
	if page <= 0 {
		page = defaultHistoryListPage
	}
	pageSize := body.PageSize
	if pageSize <= 0 {
		pageSize = defaultHistoryListPageSize
	} else if pageSize > maxHistoryListLimit {
		pageSize = maxHistoryListLimit
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryList{
			HistoryList: &gatewayv1.HistoryListRequest{
				Page:     int32(page),
				PageSize: int32(pageSize),
				Cwd:      strings.TrimSpace(body.Cwd),
				CwdEmpty: body.CwdEmpty,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryListResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	conversations := make([]map[string]any, 0, len(resp.GetConversations()))
	for _, conversation := range resp.GetConversations() {
		conversations = append(conversations, websocketConversationSummaryPayload(conversation))
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"conversations":            conversations,
		"total_count":              resp.GetTotalCount(),
		"running_conversation_ids": c.sm.ActiveChatRunConversationIDs(),
		"running_conversations":    websocketActiveChatRunSummariesPayload(c.sm.ActiveChatRunSummaries()),
	})
}

func (c *websocketConnection) handleHistoryWorkdirs(req websocketRequest) {
	var body struct{}
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.workdirs payload")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryWorkdirs{
			HistoryWorkdirs: &gatewayv1.HistoryWorkdirsRequest{},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryWorkdirsResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	workdirs := make([]map[string]any, 0, len(resp.GetWorkdirs()))
	for _, workdir := range resp.GetWorkdirs() {
		workdirs = append(workdirs, map[string]any{
			"path":               workdir.GetPath(),
			"conversation_count": workdir.GetConversationCount(),
			"updated_at":         workdir.GetUpdatedAt(),
		})
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"workdirs": workdirs,
	})
}

func (c *websocketConnection) handleHistorySharedList(req websocketRequest) {
	type payload struct {
		Page     int `json:"page"`
		PageSize int `json:"page_size"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.shared_list payload")
		return
	}
	page := body.Page
	if page <= 0 {
		page = defaultHistoryListPage
	}
	pageSize := body.PageSize
	if pageSize <= 0 {
		pageSize = defaultHistoryListPageSize
	} else if pageSize > maxHistoryListLimit {
		pageSize = maxHistoryListLimit
	}

	argsJSON, err := json.Marshal(map[string]any{
		"page":      page,
		"page_size": pageSize,
	})
	if err != nil {
		_ = c.writeError(req.ID, "invalid history.shared_list payload")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_MemoryManage{
			MemoryManage: &gatewayv1.MemoryManageRequest{
				Command:  "history_shared_list",
				ArgsJson: string(argsJSON),
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetMemoryManageResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	var result struct {
		Conversations []map[string]any `json:"conversations"`
		TotalCount    int              `json:"total_count"`
	}
	if err := json.Unmarshal([]byte(resp.GetResultJson()), &result); err != nil {
		_ = c.writeError(req.ID, "invalid history.shared_list response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"conversations": result.Conversations,
		"total_count":   result.TotalCount,
	})
}

func (c *websocketConnection) handleHistoryGet(req websocketRequest) {
	type payload struct {
		ConversationID string `json:"conversation_id"`
		MaxMessages    int32  `json:"max_messages"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.get payload")
		return
	}
	conversationID, err := requireTrimmedWebSocketString(body.ConversationID, "conversation_id")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryGet{
			HistoryGet: &gatewayv1.HistoryGetRequest{
				ConversationId: conversationID,
				MaxMessages:    body.MaxMessages,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryGetResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"conversation_id":        resp.GetConversationId(),
		"messages_json":          resp.GetMessagesJson(),
		"total_message_count":    resp.GetTotalMessageCount(),
		"returned_message_count": resp.GetReturnedMessageCount(),
		"has_more":               resp.GetHasMore(),
		"conversation":           websocketConversationSummaryPayload(resp.GetConversation()),
	})
}

func (c *websocketConnection) handleHistoryRename(req websocketRequest) {
	type payload struct {
		ConversationID string `json:"conversation_id"`
		Title          string `json:"title"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.rename payload")
		return
	}
	conversationID, err := requireTrimmedWebSocketString(body.ConversationID, "conversation_id")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	title, err := requireTrimmedWebSocketString(body.Title, "title")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryRename{
			HistoryRename: &gatewayv1.HistoryRenameRequest{
				ConversationId: conversationID,
				Title:          title,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryRenameResp()
	if resp == nil || resp.GetConversation() == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	conversation := resp.GetConversation()
	_ = c.writeResponse(req.ID, websocketConversationSummaryPayload(conversation))
}

func (c *websocketConnection) handleHistoryPin(req websocketRequest) {
	type payload struct {
		ConversationID string `json:"conversation_id"`
		IsPinned       bool   `json:"is_pinned"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.pin payload")
		return
	}
	conversationID, err := requireTrimmedWebSocketString(body.ConversationID, "conversation_id")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryPin{
			HistoryPin: &gatewayv1.HistoryPinRequest{
				ConversationId: conversationID,
				IsPinned:       body.IsPinned,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryPinResp()
	if resp == nil || resp.GetConversation() == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, websocketConversationSummaryPayload(resp.GetConversation()))
}

func (c *websocketConnection) handleHistoryShareGet(req websocketRequest) {
	type payload struct {
		ConversationID string `json:"conversation_id"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.share.get payload")
		return
	}
	conversationID, err := requireTrimmedWebSocketString(body.ConversationID, "conversation_id")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryShareGet{
			HistoryShareGet: &gatewayv1.HistoryShareGetRequest{
				ConversationId: conversationID,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryShareGetResp()
	if resp == nil || resp.GetShare() == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, websocketHistoryShareStatusPayload(resp.GetShare()))
}

func (c *websocketConnection) handleHistoryShareSet(req websocketRequest) {
	type payload struct {
		ConversationID    string `json:"conversation_id"`
		Enabled           bool   `json:"enabled"`
		RedactToolContent *bool  `json:"redact_tool_content,omitempty"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.share.set payload")
		return
	}
	conversationID, err := requireTrimmedWebSocketString(body.ConversationID, "conversation_id")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryShareSet{
			HistoryShareSet: &gatewayv1.HistoryShareSetRequest{
				ConversationId:    conversationID,
				Enabled:           body.Enabled,
				RedactToolContent: body.RedactToolContent,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetHistoryShareSetResp()
	if resp == nil || resp.GetShare() == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, websocketHistoryShareStatusPayload(resp.GetShare()))
}

func (c *websocketConnection) handleHistoryDelete(req websocketRequest) {
	type payload struct {
		ConversationID string `json:"conversation_id"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.delete payload")
		return
	}
	conversationID, err := requireTrimmedWebSocketString(body.ConversationID, "conversation_id")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryDelete{
			HistoryDelete: &gatewayv1.HistoryDeleteRequest{
				ConversationId: conversationID,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}
	if response.GetHistoryDeleteResp() == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{"ok": true})
}
