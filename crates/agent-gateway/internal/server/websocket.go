package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/websocket"

	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

type websocketRequest struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type websocketEnvelope struct {
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Payload any    `json:"payload,omitempty"`
	Error   string `json:"error,omitempty"`
}

type websocketAuthPayload struct {
	Token string `json:"token"`
}

type websocketChatResumePayload struct {
	RequestID      string `json:"request_id"`
	ConversationID string `json:"conversation_id"`
	AfterSeq       int64  `json:"after_seq"`
}

type websocketChatAttachPayload struct {
	ConversationID string `json:"conversation_id"`
	AfterSeq       int64  `json:"after_seq"`
}

type websocketChatDetachPayload struct {
	RequestID string `json:"request_id"`
}

type websocketChatState struct {
	cancel          context.CancelFunc
	conversationID  string
	sourceRequestID string
}

type websocketConnection struct {
	cfg *config.Config
	sm  *session.Manager

	conn *websocket.Conn

	writeMu    sync.Mutex
	closeOnce  sync.Once
	done       chan struct{}
	authorized bool

	historyEvents         <-chan *gatewayv1.HistorySyncEvent
	historyEventsCleanup  func()
	settingsEvents        <-chan *gatewayv1.SettingsSyncEvent
	settingsEventsCleanup func()
	chatEvents            <-chan *session.ChatBroadcastEvent
	chatEventsCleanup     func()
	heartbeatOnce         sync.Once

	activeChatsMu sync.RWMutex
	activeChats   map[string]*websocketChatState
	recentChats   map[string]time.Time

	activeChatAttachmentsMu sync.Mutex
	activeChatAttachments   map[string]context.CancelFunc
}

const recentActiveChatRetention = 5 * time.Second

func NewWebSocketServer(cfg *config.Config, sm *session.Manager) http.Handler {
	server := &websocket.Server{
		Handshake: func(_ *websocket.Config, _ *http.Request) error {
			return nil
		},
		Handler: websocket.Handler(func(conn *websocket.Conn) {
			state := &websocketConnection{
				cfg:                   cfg,
				sm:                    sm,
				conn:                  conn,
				done:                  make(chan struct{}),
				activeChats:           make(map[string]*websocketChatState),
				recentChats:           make(map[string]time.Time),
				activeChatAttachments: make(map[string]context.CancelFunc),
			}
			defer state.close()
			state.serve()
		}),
	}
	return server
}

func (c *websocketConnection) serve() {
	for {
		var req websocketRequest
		if err := websocket.JSON.Receive(c.conn, &req); err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			return
		}

		req.ID = strings.TrimSpace(req.ID)
		req.Type = strings.TrimSpace(req.Type)
		if req.Type == "pong" {
			continue
		}
		if req.ID == "" {
			_ = c.writeError("", "request id is required")
			continue
		}
		if req.Type == "" {
			_ = c.writeError(req.ID, "request type is required")
			continue
		}

		if req.Type == "auth" {
			c.handleAuth(req)
			continue
		}

		if !c.authorized {
			_ = c.writeError(req.ID, "unauthorized")
			continue
		}

		go c.dispatch(req)
	}
}

func (c *websocketConnection) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		if c.historyEventsCleanup != nil {
			c.historyEventsCleanup()
			c.historyEventsCleanup = nil
		}
		if c.settingsEventsCleanup != nil {
			c.settingsEventsCleanup()
			c.settingsEventsCleanup = nil
		}
		if c.chatEventsCleanup != nil {
			c.chatEventsCleanup()
			c.chatEventsCleanup = nil
		}
		activeAttachments := c.releaseAllActiveChatAttachments()
		for _, cancel := range activeAttachments {
			cancel()
		}
		activeChats := c.releaseAllActiveChats()
		for _, chat := range activeChats {
			chat.cancel()
		}
		_ = c.conn.Close()
	})
}

func (c *websocketConnection) handleAuth(req websocketRequest) {
	var payload websocketAuthPayload
	if err := decodeWebSocketPayload(req.Payload, &payload); err != nil {
		_ = c.writeError(req.ID, "invalid auth payload")
		c.close()
		return
	}

	expectedToken := strings.TrimSpace(c.cfg.Token)
	if expectedToken == "" || strings.TrimSpace(payload.Token) != expectedToken {
		_ = c.writeError(req.ID, "unauthorized")
		c.close()
		return
	}

	c.authorized = true
	c.startHistorySyncForwarder()
	c.startSettingsSyncForwarder()
	c.startChatEventForwarder()
	c.startWebSocketHeartbeat()
	_ = c.writeResponse(req.ID, map[string]any{"ok": true})
}

func (c *websocketConnection) startHistorySyncForwarder() {
	if c.historyEvents != nil || c.historyEventsCleanup != nil {
		return
	}

	historyEvents, cleanup := c.sm.SubscribeHistorySync()
	c.historyEvents = historyEvents
	c.historyEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-historyEvents:
				if !ok {
					return
				}
				if err := c.writeHistoryEvent(websocketHistorySyncPayload(event)); err != nil {
					c.close()
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startChatEventForwarder() {
	if c.chatEvents != nil || c.chatEventsCleanup != nil {
		return
	}

	chatEvents, cleanup := c.sm.SubscribeChatEvents()
	c.chatEvents = chatEvents
	c.chatEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-chatEvents:
				if !ok {
					return
				}
				if c.hasActiveChatRequest(event.RequestID) {
					continue
				}
				if err := c.writeConversationEvent(websocketChatEventPayload(event.Event, event.Seq)); err != nil {
					c.close()
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startSettingsSyncForwarder() {
	if c.settingsEvents != nil || c.settingsEventsCleanup != nil {
		return
	}

	settingsEvents, cleanup := c.sm.SubscribeSettingsSync()
	c.settingsEvents = settingsEvents
	c.settingsEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-settingsEvents:
				if !ok {
					return
				}
				payload, err := websocketSettingsSyncPayload(event)
				if err != nil {
					return
				}
				if err := c.writeSettingsEvent(payload); err != nil {
					c.close()
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startWebSocketHeartbeat() {
	c.heartbeatOnce.Do(func() {
		period := c.cfg.WebSocketHeartbeatPeriod
		if period <= 0 {
			period = 15 * time.Second
		}
		go func() {
			ticker := time.NewTicker(period)
			defer ticker.Stop()
			for {
				select {
				case <-c.done:
					return
				case <-ticker.C:
					if err := c.writeEnvelope(websocketEnvelope{
						Type: "ping",
						Payload: map[string]any{
							"timestamp": time.Now().Unix(),
						},
					}); err != nil {
						c.close()
						return
					}
				}
			}
		}()
	})
}

func (c *websocketConnection) dispatch(req websocketRequest) {
	switch req.Type {
	case "status.get":
		_ = c.writeResponse(req.ID, c.sm.Status())
	case "fs.roots":
		c.handleFsRoots(req)
	case "fs.list_dirs":
		c.handleFsListDirs(req)
	case "history.list":
		c.handleHistoryList(req)
	case "history.get":
		c.handleHistoryGet(req)
	case "history.rename":
		c.handleHistoryRename(req)
	case "history.pin":
		c.handleHistoryPin(req)
	case "history.share.get":
		c.handleHistoryShareGet(req)
	case "history.share.set":
		c.handleHistoryShareSet(req)
	case "history.delete":
		c.handleHistoryDelete(req)
	case "history.truncate":
		c.handleHistoryTruncate(req)
	case "providers.list":
		c.handleProviderList(req)
	case "settings.get":
		c.handleSettingsGet(req)
	case "settings.update":
		c.handleSettingsUpdate(req)
	case "skills.list":
		c.handleSkillFilesList(req)
	case "mentions.list":
		c.handleFileMentionList(req)
	case "skills.read-metadata":
		c.handleSkillMetadataRead(req)
	case "skills.read-text":
		c.handleSkillTextRead(req)
	case "skills.manage":
		c.handleSkillManage(req)
	case "chat.start":
		c.handleChatStart(req)
	case "chat.resume":
		c.handleChatResume(req)
	case "chat.attach":
		c.handleChatAttach(req)
	case "chat.detach":
		c.handleChatDetach(req)
	case "chat.cancel":
		c.handleChatCancel(req)
	case "files.preview":
		c.handleUploadedImagePreview(req)
	case "memory.manage":
		c.handleMemoryManage(req)
	case "cron.manage":
		c.handleCronManage(req)
	case "provider.models":
		c.handleProviderModels(req)
	default:
		_ = c.writeError(req.ID, "unsupported request type")
	}
}

func (c *websocketConnection) handleFsRoots(req websocketRequest) {
	// Payload is intentionally empty; we still decode to reject unexpected fields.
	var body struct{}
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid fs.roots payload")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FsRoots{
			FsRoots: &gatewayv1.FsRootsRequest{},
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

	resp := response.GetFsRootsResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	rootPayload := make([]map[string]any, 0, len(resp.GetRoots()))
	for _, root := range resp.GetRoots() {
		rootPayload = append(rootPayload, map[string]any{
			"id":    root.GetId(),
			"path":  root.GetPath(),
			"kind":  root.GetKind(),
			"label": root.GetLabel(),
		})
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"roots": rootPayload,
	})
}

func (c *websocketConnection) handleFsListDirs(req websocketRequest) {
	type payload struct {
		Path       string `json:"path"`
		MaxResults *int   `json:"max_results"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid fs.list_dirs payload")
		return
	}

	dir := strings.TrimSpace(body.Path)
	if dir == "" {
		_ = c.writeError(req.ID, "path is required")
		return
	}

	maxResults, err := websocketOptionalUint32(body.MaxResults, "max_results")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FsListDirs{
			FsListDirs: &gatewayv1.FsListDirsRequest{
				Path:       dir,
				MaxResults: maxResults,
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

	resp := response.GetFsListDirsResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	entryPayload := make([]map[string]any, 0, len(resp.GetEntries()))
	for _, entry := range resp.GetEntries() {
		entryPayload = append(entryPayload, map[string]any{
			"path": entry.GetPath(),
			"name": entry.GetName(),
		})
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"path":      strings.TrimSpace(resp.GetPath()),
		"entries":   entryPayload,
		"truncated": resp.GetTruncated(),
	})
}

func (c *websocketConnection) handleHistoryList(req websocketRequest) {
	type payload struct {
		Limit  int `json:"limit"`
		Offset int `json:"offset"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.list payload")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryList{
			HistoryList: &gatewayv1.HistoryListRequest{
				Limit:  int32(body.Limit),
				Offset: int32(body.Offset),
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
		"total":                    resp.GetTotal(),
		"running_conversation_ids": c.sm.ActiveChatRunConversationIDs(),
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
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryGet{
			HistoryGet: &gatewayv1.HistoryGetRequest{
				ConversationId: body.ConversationID,
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
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		_ = c.writeError(req.ID, "title is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryRename{
			HistoryRename: &gatewayv1.HistoryRenameRequest{
				ConversationId: body.ConversationID,
				Title:          body.Title,
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
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryPin{
			HistoryPin: &gatewayv1.HistoryPinRequest{
				ConversationId: body.ConversationID,
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
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryShareGet{
			HistoryShareGet: &gatewayv1.HistoryShareGetRequest{
				ConversationId: body.ConversationID,
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
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryShareSet{
			HistoryShareSet: &gatewayv1.HistoryShareSetRequest{
				ConversationId:    body.ConversationID,
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
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryDelete{
			HistoryDelete: &gatewayv1.HistoryDeleteRequest{
				ConversationId: body.ConversationID,
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

func (c *websocketConnection) handleHistoryTruncate(req websocketRequest) {
	type payload struct {
		ConversationID   string `json:"conversation_id"`
		SegmentIndex     int    `json:"segment_index"`
		MessageIndex     int    `json:"message_index"`
		OmitMessagesJSON bool   `json:"omit_messages_json"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid history.truncate payload")
		return
	}
	if strings.TrimSpace(body.ConversationID) == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}
	if body.SegmentIndex < 0 {
		_ = c.writeError(req.ID, "segment_index must be >= 0")
		return
	}
	if body.MessageIndex < 0 {
		_ = c.writeError(req.ID, "message_index must be >= 0")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_HistoryTruncate{
			HistoryTruncate: &gatewayv1.HistoryTruncateRequest{
				ConversationId:   body.ConversationID,
				SegmentIndex:     int32(body.SegmentIndex),
				MessageIndex:     int32(body.MessageIndex),
				OmitMessagesJson: body.OmitMessagesJSON,
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

	resp := response.GetHistoryTruncateResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	payloadMap := map[string]any{
		"conversation_id": resp.GetConversationId(),
		"messages_json":   resp.GetMessagesJson(),
	}
	if conversation := resp.GetConversation(); conversation != nil {
		payloadMap["conversation"] = websocketConversationSummaryPayload(conversation)
	}

	_ = c.writeResponse(req.ID, payloadMap)
}

func (c *websocketConnection) handleProviderList(req websocketRequest) {
	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_ProviderList{
			ProviderList: &gatewayv1.ProviderListRequest{},
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

	resp := response.GetProviderListResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	var payload any
	raw := strings.TrimSpace(resp.GetProvidersJson())
	if raw == "" {
		payload = []any{}
	} else if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		_ = c.writeError(req.ID, "provider list response is not valid JSON")
		return
	}

	_ = c.writeResponse(req.ID, payload)
}

func (c *websocketConnection) handleChatStart(req websocketRequest) {
	var body handler.ChatRequestBody
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid chat.start payload")
		return
	}
	body.Message = strings.TrimSpace(body.Message)
	body.ConversationID = strings.TrimSpace(body.ConversationID)
	body.ClientRequestID = strings.TrimSpace(body.ClientRequestID)
	body.ExecutionMode = handler.NormalizeExecutionMode(body.ExecutionMode)
	body.Workdir = handler.NormalizeWorkdir(body.Workdir)
	body.SelectedSystemTools = handler.NormalizeSelectedSystemTools(body.SelectedSystemTools)
	body.UploadedFiles = handler.NormalizeChatUploadedFiles(body.UploadedFiles)
	body.RuntimeControls = handler.NormalizeChatRuntimeControls(body.RuntimeControls)
	selectedModel, err := handler.NormalizeChatSelectedModel(body.SelectedModel)
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	body.SelectedModel = selectedModel
	if body.Message == "" && len(body.UploadedFiles) == 0 {
		_ = c.writeError(req.ID, "message is required")
		return
	}
	if !c.sm.IsOnline() {
		_ = c.writeError(req.ID, "agent offline")
		return
	}

	snapshot, created, err := c.sm.StartChatRunWithClientRequest(
		req.ID,
		body.ConversationID,
		body.ClientRequestID,
	)
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	sourceRequestID := snapshot.RequestID
	if sourceRequestID == "" {
		sourceRequestID = req.ID
	}
	eventCh, eventDone, cleanup, snapshot, err := c.sm.SubscribeChatRun(
		sourceRequestID,
		snapshot.ConversationID,
		0,
	)
	if err != nil {
		if created {
			c.sm.RemoveChatRun(sourceRequestID)
		}
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	defer cleanup()

	// Register before sending so the broadcast forwarder can skip the copy that
	// this same connection already receives through the recoverable chat stream.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	responseID := req.ID
	c.registerActiveChat(responseID, sourceRequestID, snapshot.ConversationID, cancel)
	defer c.releaseActiveChat(responseID)

	if created {
		if err := c.sm.SendToAgent(&gatewayv1.GatewayEnvelope{
			RequestId: sourceRequestID,
			Timestamp: time.Now().Unix(),
			Payload: &gatewayv1.GatewayEnvelope_ChatRequest{
				ChatRequest: &gatewayv1.ChatRequest{
					ConversationId:      body.ConversationID,
					ClientRequestId:     body.ClientRequestID,
					Message:             body.Message,
					SelectedModel:       handler.ToProtoChatSelectedModel(body.SelectedModel),
					RuntimeControls:     handler.ToProtoChatRuntimeControls(body.RuntimeControls),
					ExecutionMode:       body.ExecutionMode,
					Workdir:             body.Workdir,
					SelectedSystemTools: body.SelectedSystemTools,
					UploadedFiles:       handler.ToProtoChatUploadedFiles(body.UploadedFiles),
				},
			},
		}); err != nil {
			c.sm.RemoveChatRun(sourceRequestID)
			_ = c.writeError(req.ID, websocketErrorMessage(err))
			return
		}
	}

	// Do not enforce a hard timeout for streaming chat requests. The GUI path can run
	// multiple compaction rounds stably; WebUI should behave the same and only stop
	// when the user cancels, the connection closes, or the agent returns done/error.
	for {
		select {
		case <-c.done:
			return
		case <-ctx.Done():
			_ = c.writeError(responseID, websocketErrorMessage(ctx.Err()))
			return
		case <-eventDone:
			return
		case event, ok := <-eventCh:
			if !ok {
				return
			}
			chatEvent := event.Event
			if chatEvent == nil {
				continue
			}
			if chatEvent.GetConversationId() != "" {
				body.ConversationID = strings.TrimSpace(chatEvent.GetConversationId())
				c.updateActiveChatConversationID(responseID, body.ConversationID)
			}
			if err := c.writeChatEvent(responseID, websocketChatEventPayload(chatEvent, event.Seq)); err != nil {
				c.close()
				return
			}
			if chatEvent.GetType() == gatewayv1.ChatEvent_DONE || chatEvent.GetType() == gatewayv1.ChatEvent_ERROR {
				return
			}
		}
	}
}

func (c *websocketConnection) handleChatResume(req websocketRequest) {
	var body websocketChatResumePayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid chat.resume payload")
		return
	}
	body.RequestID = strings.TrimSpace(body.RequestID)
	body.ConversationID = strings.TrimSpace(body.ConversationID)
	if body.RequestID == "" && body.ConversationID == "" {
		_ = c.writeError(req.ID, "request_id or conversation_id is required")
		return
	}
	if body.AfterSeq < 0 {
		body.AfterSeq = 0
	}

	eventCh, eventDone, cleanup, snapshot, err := c.sm.SubscribeChatRun(
		body.RequestID,
		body.ConversationID,
		body.AfterSeq,
	)
	if err != nil {
		responseID := body.RequestID
		if responseID == "" {
			responseID = req.ID
		}
		_ = c.writeError(responseID, websocketErrorMessage(err))
		return
	}
	defer cleanup()

	responseID := snapshot.RequestID
	if responseID == "" {
		responseID = body.RequestID
	}
	if responseID == "" {
		responseID = req.ID
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.registerActiveChat(responseID, snapshot.RequestID, snapshot.ConversationID, cancel)
	defer c.releaseActiveChat(responseID)

	if snapshot.Done && snapshot.LatestSeq <= body.AfterSeq {
		payload := map[string]any{
			"type": "done",
			"seq":  snapshot.LatestSeq,
		}
		if snapshot.ConversationID != "" {
			payload["conversation_id"] = snapshot.ConversationID
		}
		if err := c.writeChatEvent(responseID, payload); err != nil {
			c.close()
		}
		return
	}

	for {
		select {
		case <-c.done:
			return
		case <-ctx.Done():
			_ = c.writeError(responseID, websocketErrorMessage(ctx.Err()))
			return
		case <-eventDone:
			return
		case event, ok := <-eventCh:
			if !ok {
				return
			}
			chatEvent := event.Event
			if chatEvent == nil {
				continue
			}
			if chatEvent.GetConversationId() != "" {
				c.updateActiveChatConversationID(responseID, strings.TrimSpace(chatEvent.GetConversationId()))
			}
			if err := c.writeChatEvent(responseID, websocketChatEventPayload(chatEvent, event.Seq)); err != nil {
				c.close()
				return
			}
			if chatEvent.GetType() == gatewayv1.ChatEvent_DONE || chatEvent.GetType() == gatewayv1.ChatEvent_ERROR {
				return
			}
		}
	}
}

func (c *websocketConnection) handleChatAttach(req websocketRequest) {
	var body websocketChatAttachPayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid chat.attach payload")
		return
	}
	body.ConversationID = strings.TrimSpace(body.ConversationID)
	if body.ConversationID == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}
	if body.AfterSeq < 0 {
		body.AfterSeq = 0
	}

	eventCh, eventDone, cleanup, snapshot, err := c.sm.SubscribeChatRun(
		"",
		body.ConversationID,
		body.AfterSeq,
	)
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	defer cleanup()

	ctx, cancel := context.WithCancel(context.Background())
	c.registerActiveChatAttachment(req.ID, cancel)
	defer c.releaseActiveChatAttachment(req.ID)

	if snapshot.Done && snapshot.LatestSeq <= body.AfterSeq {
		payload := map[string]any{
			"type": "done",
			"seq":  snapshot.LatestSeq,
		}
		if snapshot.ConversationID != "" {
			payload["conversation_id"] = snapshot.ConversationID
		}
		if err := c.writeChatEvent(req.ID, payload); err != nil {
			c.close()
		}
		return
	}

	for {
		select {
		case <-c.done:
			return
		case <-ctx.Done():
			return
		case <-eventDone:
			return
		case event, ok := <-eventCh:
			if !ok {
				return
			}
			chatEvent := event.Event
			if chatEvent == nil {
				continue
			}
			if err := c.writeChatEvent(req.ID, websocketChatEventPayload(chatEvent, event.Seq)); err != nil {
				c.close()
				return
			}
			if chatEvent.GetType() == gatewayv1.ChatEvent_DONE || chatEvent.GetType() == gatewayv1.ChatEvent_ERROR {
				return
			}
		}
	}
}

func (c *websocketConnection) handleChatDetach(req websocketRequest) {
	var body websocketChatDetachPayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid chat.detach payload")
		return
	}
	targetRequestID := strings.TrimSpace(body.RequestID)
	if targetRequestID == "" {
		targetRequestID = req.ID
	}
	if targetRequestID == "" {
		_ = c.writeError(req.ID, "request_id is required")
		return
	}
	c.cancelActiveChatAttachment(targetRequestID)
	_ = c.writeResponse(req.ID, map[string]any{"ok": true})
}

func (c *websocketConnection) handleChatCancel(req websocketRequest) {
	var body handler.CancelChatRequestBody
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid chat.cancel payload")
		return
	}
	body.ConversationID = strings.TrimSpace(body.ConversationID)
	if body.ConversationID == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}
	if !c.sm.IsOnline() {
		_ = c.writeError(req.ID, "agent offline")
		return
	}

	if err := c.sm.SendToAgent(&gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_CancelChat{
			CancelChat: &gatewayv1.CancelChatRequest{
				ConversationId: body.ConversationID,
			},
		},
	}); err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}

	c.cancelActiveChatsByConversation(body.ConversationID)
	c.sm.RemoveChatRunByConversation(body.ConversationID)
	_ = c.writeResponse(req.ID, map[string]any{"ok": true})
}

func (c *websocketConnection) handleUploadedImagePreview(req websocketRequest) {
	var body handler.UploadedImagePreviewRequestBody
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid files.preview payload")
		return
	}
	body.Workdir = strings.TrimSpace(body.Workdir)
	body.AbsolutePath = strings.TrimSpace(body.AbsolutePath)
	if body.Workdir == "" {
		_ = c.writeError(req.ID, "workdir is required")
		return
	}
	if body.AbsolutePath == "" {
		_ = c.writeError(req.ID, "absolute_path is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_UploadedImagePreview{
			UploadedImagePreview: &gatewayv1.UploadedImagePreviewRequest{
				Workdir:      body.Workdir,
				AbsolutePath: body.AbsolutePath,
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

	resp := response.GetUploadedImagePreviewResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"mimeType": resp.GetMimeType(),
		"data":     resp.GetData(),
	})
}

func (c *websocketConnection) handleMemoryManage(req websocketRequest) {
	type payload struct {
		Command string          `json:"command"`
		Args    json.RawMessage `json:"args"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid memory.manage payload")
		return
	}

	command := strings.TrimSpace(body.Command)
	if command == "" {
		_ = c.writeError(req.ID, "command is required")
		return
	}
	if !strings.HasPrefix(command, "memory_") {
		_ = c.writeError(req.ID, "unsupported memory command")
		return
	}

	argsJSON := strings.TrimSpace(string(body.Args))
	if argsJSON == "" {
		argsJSON = "{}"
	}
	if !json.Valid([]byte(argsJSON)) {
		_ = c.writeError(req.ID, "memory args must be valid JSON")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_MemoryManage{
			MemoryManage: &gatewayv1.MemoryManageRequest{
				Command:  command,
				ArgsJson: argsJSON,
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

	payloadValue, err := websocketMemoryResultPayload(resp.GetResultJson())
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	_ = c.writeResponse(req.ID, payloadValue)
}

func (c *websocketConnection) handleCronManage(req websocketRequest) {
	var body handler.CronManageRequestBody
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid cron.manage payload")
		return
	}
	if !c.sm.IsOnline() {
		_ = c.writeError(req.ID, "agent offline")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_CronManage{
			CronManage: &gatewayv1.CronManageRequest{
				Action:   body.Action,
				TaskId:   body.TaskID,
				TaskJson: body.TaskJSON,
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

	resp := response.GetCronManageResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"action":      resp.GetAction(),
		"result_json": resp.GetResultJson(),
	})
}

func (c *websocketConnection) handleProviderModels(req websocketRequest) {
	var body handler.ProviderModelsRequestBody
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid provider.models payload")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), c.cfg.RequestTimeout)
	defer cancel()

	result, err := handler.FetchProviderModels(ctx, body)
	if err != nil {
		var statusErr *handler.HTTPStatusError
		if errors.As(err, &statusErr) {
			_ = c.writeError(req.ID, statusErr.Message)
			return
		}
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}

	var payload any
	if err := json.Unmarshal(result.Body, &payload); err != nil {
		_ = c.writeError(req.ID, "provider model response is not valid JSON")
		return
	}

	_ = c.writeResponse(req.ID, payload)
}

func (c *websocketConnection) handleSettingsGet(req websocketRequest) {
	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_SettingsGet{
			SettingsGet: &gatewayv1.SettingsGetRequest{},
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

	settingsResp := response.GetSettingsGetResp()
	if settingsResp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	payload, err := websocketSettingsJSONPayload(settingsResp.GetSettingsJson())
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	_ = c.writeResponse(req.ID, payload)
}

func (c *websocketConnection) handleSettingsUpdate(req websocketRequest) {
	payloadJSON, err := websocketRawPayloadJSON(req.Payload)
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_SettingsUpdate{
			SettingsUpdate: &gatewayv1.SettingsUpdateRequest{
				SettingsJson: payloadJSON,
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

	settingsResp := response.GetSettingsUpdateResp()
	if settingsResp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"accepted": settingsResp.GetAccepted(),
		"message":  strings.TrimSpace(settingsResp.GetMessage()),
	})
}

func (c *websocketConnection) handleSkillFilesList(req websocketRequest) {
	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_SkillFilesList{
			SkillFilesList: &gatewayv1.SkillFilesListRequest{},
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

	resp := response.GetSkillFilesListResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"rootDir":   resp.GetRootDir(),
		"paths":     resp.GetPaths(),
		"truncated": resp.GetTruncated(),
	})
}

func (c *websocketConnection) handleFileMentionList(req websocketRequest) {
	type payload struct {
		Workdir    string `json:"workdir"`
		MaxResults *int   `json:"max_results"`
		Query      string `json:"query"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid mentions.list payload")
		return
	}

	workdir := strings.TrimSpace(body.Workdir)
	if workdir == "" {
		_ = c.writeError(req.ID, "workdir is required")
		return
	}
	query := strings.TrimSpace(body.Query)

	maxResults, err := websocketOptionalUint32(body.MaxResults, "max_results")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FileMentionList{
			FileMentionList: &gatewayv1.FileMentionListRequest{
				Workdir:    workdir,
				MaxResults: maxResults,
				Query:      query,
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

	resp := response.GetFileMentionListResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	entries := make([]map[string]any, 0, len(resp.GetEntries()))
	for _, entry := range resp.GetEntries() {
		entries = append(entries, map[string]any{
			"path": entry.GetPath(),
			"kind": entry.GetKind(),
		})
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"entries":   entries,
		"truncated": resp.GetTruncated(),
	})
}

func (c *websocketConnection) handleSkillMetadataRead(req websocketRequest) {
	type payload struct {
		Path string `json:"path"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid skills.read-metadata payload")
		return
	}

	path := strings.TrimSpace(body.Path)
	if path == "" {
		_ = c.writeError(req.ID, "path is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_SkillMetadataRead{
			SkillMetadataRead: &gatewayv1.SkillMetadataReadRequest{
				Path: path,
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

	resp := response.GetSkillMetadataReadResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"name":        nullableTrimmedString(resp.GetName()),
		"description": nullableTrimmedString(resp.GetDescription()),
	})
}

func (c *websocketConnection) handleSkillTextRead(req websocketRequest) {
	type payload struct {
		Path   string `json:"path"`
		Offset *int   `json:"offset"`
		Length *int   `json:"length"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid skills.read-text payload")
		return
	}

	path := strings.TrimSpace(body.Path)
	if path == "" {
		_ = c.writeError(req.ID, "path is required")
		return
	}

	offset, err := websocketOptionalUint32(body.Offset, "offset")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	length, err := websocketOptionalUint32(body.Length, "length")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_SkillTextRead{
			SkillTextRead: &gatewayv1.SkillTextReadRequest{
				Path:   path,
				Offset: offset,
				Length: length,
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

	resp := response.GetSkillTextReadResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"content":   resp.GetContent(),
		"truncated": resp.GetTruncated(),
	})
}

func (c *websocketConnection) handleSkillManage(req websocketRequest) {
	payloadJSON := strings.TrimSpace(string(req.Payload))
	if payloadJSON == "" || payloadJSON == "null" {
		payloadJSON = "{}"
	}
	if !json.Valid([]byte(payloadJSON)) {
		_ = c.writeError(req.ID, "invalid skills.manage payload")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_SkillManage{
			SkillManage: &gatewayv1.SkillManageRequest{
				PayloadJson: payloadJSON,
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

	resp := response.GetSkillManageResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	var payload any
	raw := strings.TrimSpace(resp.GetResultJson())
	if raw == "" {
		payload = map[string]any{}
	} else if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		_ = c.writeError(req.ID, "skill manage response is not valid JSON")
		return
	}

	_ = c.writeResponse(req.ID, payload)
}

func nullableTrimmedString(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func websocketOptionalUint32(value *int, field string) (uint32, error) {
	if value == nil {
		return 0, nil
	}
	if *value < 0 {
		return 0, errors.New(field + " must be >= 0")
	}
	return uint32(*value), nil
}

func (c *websocketConnection) awaitAgentResponse(
	requestID string,
	envelope *gatewayv1.GatewayEnvelope,
) (*gatewayv1.AgentEnvelope, error) {
	ctx, cancel := context.WithTimeout(context.Background(), c.cfg.RequestTimeout)
	defer cancel()

	go func() {
		select {
		case <-c.done:
			cancel()
		case <-ctx.Done():
		}
	}()

	return awaitAgentUnaryResponse(ctx, c.sm, requestID, envelope)
}

func (c *websocketConnection) writeResponse(requestID string, payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:      requestID,
		Type:    "response",
		Payload: payload,
	})
}

func (c *websocketConnection) writeError(requestID string, message string) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:    requestID,
		Type:  "error",
		Error: message,
	})
}

func (c *websocketConnection) writeChatEvent(requestID string, payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:      requestID,
		Type:    "chat.event",
		Payload: payload,
	})
}

func (c *websocketConnection) writeHistoryEvent(payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		Type:    "history.event",
		Payload: payload,
	})
}

func (c *websocketConnection) writeConversationEvent(payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		Type:    "conversation.event",
		Payload: payload,
	})
}

func (c *websocketConnection) writeSettingsEvent(payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		Type:    "settings.event",
		Payload: payload,
	})
}

func (c *websocketConnection) writeEnvelope(envelope websocketEnvelope) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.cfg.WebSocketWriteTimeout > 0 {
		if err := c.conn.SetWriteDeadline(time.Now().Add(c.cfg.WebSocketWriteTimeout)); err != nil {
			return err
		}
		defer func() {
			_ = c.conn.SetWriteDeadline(time.Time{})
		}()
	}
	return websocket.JSON.Send(c.conn, envelope)
}

func websocketConversationSummaryPayload(conversation *gatewayv1.ConversationSummary) map[string]any {
	if conversation == nil {
		return nil
	}

	return map[string]any{
		"id":            conversation.GetId(),
		"title":         conversation.GetTitle(),
		"created_at":    conversation.GetCreatedAt(),
		"updated_at":    conversation.GetUpdatedAt(),
		"message_count": conversation.GetMessageCount(),
		"provider_id":   conversation.GetProviderId(),
		"model":         conversation.GetModel(),
		"session_id":    conversation.GetSessionId(),
		"cwd":           conversation.GetCwd(),
		"is_pinned":     conversation.GetIsPinned(),
		"pinned_at":     conversation.GetPinnedAt(),
		"is_shared":     conversation.GetIsShared(),
	}
}

func websocketHistoryShareStatusPayload(share *gatewayv1.HistoryShareStatus) map[string]any {
	if share == nil {
		return nil
	}

	return map[string]any{
		"conversation_id":     share.GetConversationId(),
		"enabled":             share.GetEnabled(),
		"token":               share.GetToken(),
		"created_at":          share.GetCreatedAt(),
		"updated_at":          share.GetUpdatedAt(),
		"redact_tool_content": share.GetRedactToolContent(),
	}
}

func websocketHistorySyncPayload(event *gatewayv1.HistorySyncEvent) map[string]any {
	payload := map[string]any{
		"kind":            strings.TrimSpace(event.GetKind()),
		"conversation_id": strings.TrimSpace(event.GetConversationId()),
	}

	if conversation := event.GetConversation(); conversation != nil {
		payload["conversation"] = websocketConversationSummaryPayload(conversation)
	}

	return payload
}

func websocketSettingsSyncPayload(event *gatewayv1.SettingsSyncEvent) (map[string]any, error) {
	return websocketSettingsJSONPayload(event.GetSettingsJson())
}

func websocketSettingsJSONPayload(raw string) (map[string]any, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return map[string]any{}, nil
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return nil, errors.New("gateway settings payload is not valid JSON")
	}
	if payload == nil {
		return map[string]any{}, nil
	}
	return payload, nil
}

func websocketMemoryResultPayload(raw string) (any, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return map[string]any{}, nil
	}

	var payload any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return nil, errors.New("gateway memory response is not valid JSON")
	}
	if payload == nil {
		return map[string]any{}, nil
	}
	return payload, nil
}

func websocketRawPayloadJSON(raw json.RawMessage) (string, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return "{}", nil
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return "", errors.New("invalid settings.update payload")
	}
	if payload == nil {
		return "{}", nil
	}

	normalized, err := json.Marshal(payload)
	if err != nil {
		return "", errors.New("invalid settings.update payload")
	}
	return string(normalized), nil
}

func (c *websocketConnection) registerActiveChat(
	requestID string,
	sourceRequestID string,
	conversationID string,
	cancel context.CancelFunc,
) {
	requestID = strings.TrimSpace(requestID)
	sourceRequestID = strings.TrimSpace(sourceRequestID)
	c.activeChatsMu.Lock()
	defer c.activeChatsMu.Unlock()
	c.activeChats[requestID] = &websocketChatState{
		cancel:          cancel,
		conversationID:  strings.TrimSpace(conversationID),
		sourceRequestID: sourceRequestID,
	}
	delete(c.recentChats, requestID)
	delete(c.recentChats, sourceRequestID)
}

func (c *websocketConnection) registerActiveChatAttachment(requestID string, cancel context.CancelFunc) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}
	c.activeChatAttachmentsMu.Lock()
	defer c.activeChatAttachmentsMu.Unlock()
	if existing := c.activeChatAttachments[requestID]; existing != nil {
		existing()
	}
	c.activeChatAttachments[requestID] = cancel
}

func (c *websocketConnection) releaseActiveChatAttachment(requestID string) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}
	c.activeChatAttachmentsMu.Lock()
	delete(c.activeChatAttachments, requestID)
	c.activeChatAttachmentsMu.Unlock()
}

func (c *websocketConnection) releaseAllActiveChatAttachments() []context.CancelFunc {
	c.activeChatAttachmentsMu.Lock()
	defer c.activeChatAttachmentsMu.Unlock()

	cancels := make([]context.CancelFunc, 0, len(c.activeChatAttachments))
	for requestID, cancel := range c.activeChatAttachments {
		delete(c.activeChatAttachments, requestID)
		cancels = append(cancels, cancel)
	}
	return cancels
}

func (c *websocketConnection) cancelActiveChatAttachment(requestID string) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}
	c.activeChatAttachmentsMu.Lock()
	cancel := c.activeChatAttachments[requestID]
	delete(c.activeChatAttachments, requestID)
	c.activeChatAttachmentsMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (c *websocketConnection) hasActiveChatRequest(requestID string) bool {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return false
	}
	c.activeChatsMu.Lock()
	defer c.activeChatsMu.Unlock()
	if _, ok := c.activeChats[requestID]; ok {
		return true
	}
	for _, chat := range c.activeChats {
		if chat.sourceRequestID == requestID {
			return true
		}
	}
	now := time.Now()
	for recentRequestID, expiresAt := range c.recentChats {
		if now.After(expiresAt) {
			delete(c.recentChats, recentRequestID)
		}
	}
	if expiresAt, ok := c.recentChats[requestID]; ok && now.Before(expiresAt) {
		return true
	}
	return false
}

func (c *websocketConnection) updateActiveChatConversationID(requestID string, conversationID string) {
	c.activeChatsMu.Lock()
	defer c.activeChatsMu.Unlock()
	if chat, ok := c.activeChats[requestID]; ok {
		chat.conversationID = strings.TrimSpace(conversationID)
	}
}

func (c *websocketConnection) releaseActiveChat(requestID string) *websocketChatState {
	c.activeChatsMu.Lock()
	defer c.activeChatsMu.Unlock()
	chat := c.activeChats[requestID]
	delete(c.activeChats, requestID)
	expiresAt := time.Now().Add(recentActiveChatRetention)
	if strings.TrimSpace(requestID) != "" {
		c.recentChats[strings.TrimSpace(requestID)] = expiresAt
	}
	if chat != nil && chat.sourceRequestID != "" {
		c.recentChats[chat.sourceRequestID] = expiresAt
	}
	return chat
}

func (c *websocketConnection) releaseAllActiveChats() []*websocketChatState {
	c.activeChatsMu.Lock()
	defer c.activeChatsMu.Unlock()

	chats := make([]*websocketChatState, 0, len(c.activeChats))
	expiresAt := time.Now().Add(recentActiveChatRetention)
	for requestID, chat := range c.activeChats {
		delete(c.activeChats, requestID)
		if strings.TrimSpace(requestID) != "" {
			c.recentChats[strings.TrimSpace(requestID)] = expiresAt
		}
		if chat != nil && chat.sourceRequestID != "" {
			c.recentChats[chat.sourceRequestID] = expiresAt
		}
		chats = append(chats, chat)
	}
	return chats
}

func (c *websocketConnection) cancelActiveChatsByConversation(conversationID string) {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return
	}

	c.activeChatsMu.Lock()
	chats := make([]*websocketChatState, 0, len(c.activeChats))
	expiresAt := time.Now().Add(recentActiveChatRetention)
	for requestID, chat := range c.activeChats {
		if chat.conversationID == conversationID {
			delete(c.activeChats, requestID)
			if strings.TrimSpace(requestID) != "" {
				c.recentChats[strings.TrimSpace(requestID)] = expiresAt
			}
			if chat.sourceRequestID != "" {
				c.recentChats[chat.sourceRequestID] = expiresAt
			}
			chats = append(chats, chat)
		}
	}
	c.activeChatsMu.Unlock()

	for _, chat := range chats {
		chat.cancel()
	}
}

func decodeWebSocketPayload(raw json.RawMessage, target any) error {
	if len(raw) == 0 {
		return json.Unmarshal([]byte("{}"), target)
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func waitForAgentEnvelope(
	ctx context.Context,
	ch <-chan *gatewayv1.AgentEnvelope,
	done <-chan struct{},
) (*gatewayv1.AgentEnvelope, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-done:
		return nil, session.ErrAgentOffline
	case env, ok := <-ch:
		if !ok {
			return nil, session.ErrAgentOffline
		}
		return env, nil
	}
}

func awaitAgentUnaryResponse(
	ctx context.Context,
	sm *session.Manager,
	requestID string,
	envelope *gatewayv1.GatewayEnvelope,
) (*gatewayv1.AgentEnvelope, error) {
	if !sm.IsOnline() {
		return nil, session.ErrAgentOffline
	}

	ch, done, cleanup, err := sm.RegisterStream(requestID)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	if err := sm.SendToAgent(envelope); err != nil {
		return nil, err
	}

	return waitForAgentEnvelope(ctx, ch, done)
}

func websocketErrorMessage(err error) string {
	if err == nil {
		return "request failed"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "request timed out"
	}
	if errors.Is(err, context.Canceled) {
		return "request canceled"
	}
	if errors.Is(err, session.ErrAgentOffline) {
		return "agent offline"
	}
	if errors.Is(err, session.ErrChatRunNotFound) {
		return "chat stream not available"
	}
	return err.Error()
}

func websocketChatEventPayload(event *gatewayv1.ChatEvent, seq int64) map[string]any {
	payload := map[string]any{
		"type": websocketChatEventType(event.GetType()),
	}
	if seq > 0 {
		payload["seq"] = seq
	}

	raw := strings.TrimSpace(event.GetData())
	if raw == "" {
		raw = "{}"
	}

	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err == nil {
		for key, value := range decoded {
			payload[key] = value
		}
	}

	if conversationID := strings.TrimSpace(event.GetConversationId()); conversationID != "" {
		payload["conversation_id"] = conversationID
	}

	return payload
}

func websocketChatEventType(eventType gatewayv1.ChatEvent_ChatEventType) string {
	switch eventType {
	case gatewayv1.ChatEvent_TOKEN:
		return "token"
	case gatewayv1.ChatEvent_THINKING:
		return "thinking"
	case gatewayv1.ChatEvent_TOOL_CALL:
		return "tool_call"
	case gatewayv1.ChatEvent_TOOL_RESULT:
		return "tool_result"
	case gatewayv1.ChatEvent_DONE:
		return "done"
	case gatewayv1.ChatEvent_ERROR:
		return "error"
	case gatewayv1.ChatEvent_TOOL_STATUS:
		return "tool_status"
	case gatewayv1.ChatEvent_HOSTED_SEARCH:
		return "hosted_search"
	default:
		return "message"
	}
}
