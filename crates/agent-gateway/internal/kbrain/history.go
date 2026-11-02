package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// HistoryList retains live Gateway aliases and registers backend-owned sessions
// so a resumed conversation cannot accidentally create a new backend session.
func (r *Relay) HistoryList(ctx context.Context, req *gatewayv2.HistoryListRequest) (*gatewayv2.HistoryListResponse, error) {
	if req == nil {
		return nil, errors.New("history list request is required")
	}
	page, size := int(req.GetPage()), int(req.GetPageSize())
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 80
	}
	if size > 200 {
		size = 200
	}
	result, err := r.client.ListSessions(ctx, page, size, strings.TrimSpace(req.GetCwd()), req.GetCwdEmpty(), false)
	if err != nil {
		return nil, err
	}
	for _, session := range result.Sessions {
		if strings.TrimSpace(session.ID) == "" {
			return nil, errors.New("kbrain history session has no id")
		}
	}
	out := &gatewayv2.HistoryListResponse{Conversations: make([]*gatewayv2.ConversationSummary, 0, len(result.Sessions)), TotalCount: result.TotalCount}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, session := range result.Sessions {
		id := r.historyConversationIDLocked(session.ID)
		out.Conversations = append(out.Conversations, sessionSummary(id, session))
	}
	return out, nil
}

func (r *Relay) HistoryWorkdirs(ctx context.Context, _ *gatewayv2.HistoryWorkdirsRequest) (*gatewayv2.HistoryWorkdirsResponse, error) {
	const pageSize = 200

	byPath := map[string]*gatewayv2.HistoryWorkdirSummary{}
	page := 1
	for {
		result, err := r.client.ListSessions(ctx, page, pageSize, "", false, false)
		if err != nil {
			return nil, err
		}
		for _, session := range result.Sessions {
			path := strings.TrimSpace(session.CWD)
			if path == "" {
				continue
			}
			item := byPath[path]
			if item == nil {
				item = &gatewayv2.HistoryWorkdirSummary{Path: path}
				byPath[path] = item
			}
			item.ConversationCount++
			updatedAt := session.UpdatedAt
			if updatedAt.IsZero() {
				updatedAt = session.CreatedAt
			}
			if value := updatedAt.UnixMilli(); value > item.UpdatedAt {
				item.UpdatedAt = value
			}
		}
		if len(result.Sessions) == 0 || int64(page*pageSize) >= int64(result.TotalCount) {
			break
		}
		page++
	}

	workdirs := make([]*gatewayv2.HistoryWorkdirSummary, 0, len(byPath))
	for _, item := range byPath {
		workdirs = append(workdirs, item)
	}
	sort.Slice(workdirs, func(i, j int) bool {
		if workdirs[i].UpdatedAt != workdirs[j].UpdatedAt {
			return workdirs[i].UpdatedAt > workdirs[j].UpdatedAt
		}
		return workdirs[i].Path < workdirs[j].Path
	})
	return &gatewayv2.HistoryWorkdirsResponse{Workdirs: workdirs}, nil
}

func (r *Relay) historyConversationIDLocked(sessionID string) string {
	for localID, backendID := range r.sessions {
		if backendID == sessionID {
			return localID
		}
	}
	// Backend ids survive a relay restart; pre-existing browser aliases do not.
	r.sessions[sessionID] = sessionID
	return sessionID
}

func (r *Relay) HistoryRename(ctx context.Context, req *gatewayv2.HistoryRenameRequest) (*gatewayv2.HistoryRenameResponse, error) {
	if req == nil {
		return nil, errors.New("history rename request is required")
	}
	id := strings.TrimSpace(req.GetConversationId())
	if id == "" {
		return nil, errors.New("conversation_id is required")
	}
	backendID := r.backendSessionID(id)
	session, err := r.client.UpdateSession(ctx, backendID, map[string]any{"title": strings.TrimSpace(req.GetTitle())})
	if err != nil {
		return nil, err
	}
	return &gatewayv2.HistoryRenameResponse{Conversation: sessionSummary(id, session)}, nil
}

func (r *Relay) HistoryPin(ctx context.Context, req *gatewayv2.HistoryPinRequest) (*gatewayv2.HistoryPinResponse, error) {
	if req == nil {
		return nil, errors.New("history pin request is required")
	}
	id := strings.TrimSpace(req.GetConversationId())
	if id == "" {
		return nil, errors.New("conversation_id is required")
	}
	session, err := r.client.UpdateSession(ctx, r.backendSessionID(id), map[string]any{"pinned": req.GetIsPinned()})
	if err != nil {
		return nil, err
	}
	return &gatewayv2.HistoryPinResponse{Conversation: sessionSummary(id, session)}, nil
}

func (r *Relay) HistorySetCwd(ctx context.Context, req *gatewayv2.HistorySetCwdRequest) (*gatewayv2.HistorySetCwdResponse, error) {
	if req == nil {
		return nil, errors.New("history cwd request is required")
	}
	id := strings.TrimSpace(req.GetConversationId())
	if id == "" {
		return nil, errors.New("conversation_id is required")
	}
	session, err := r.client.UpdateSession(ctx, r.backendSessionID(id), map[string]any{"cwd": strings.TrimSpace(req.GetCwd())})
	if err != nil {
		return nil, err
	}
	return &gatewayv2.HistorySetCwdResponse{Conversation: sessionSummary(id, session)}, nil
}

func (r *Relay) HistoryDelete(ctx context.Context, req *gatewayv2.HistoryDeleteRequest) (*gatewayv2.HistoryDeleteResponse, error) {
	if req == nil {
		return nil, errors.New("history delete request is required")
	}
	id := strings.TrimSpace(req.GetConversationId())
	if id == "" {
		return nil, errors.New("conversation_id is required")
	}
	if err := r.client.DeleteSession(ctx, r.backendSessionID(id)); err != nil {
		return nil, err
	}
	r.mu.Lock()
	var invalidate func(*gatewayv2.HistorySyncStatus)
	if state := r.historyState; state != nil && state.available {
		// The ordered stream still needs the original alias to publish delete.
		// A failed stream releases these aliases before rebuilding its snapshot.
		if len(state.pendingDeletes) >= maxPendingHistoryDeletes {
			state.available = false
			state.resetRequired = true
			for pending := range state.pendingDeletes {
				delete(r.sessions, pending)
			}
			clear(state.pendingDeletes)
			delete(r.sessions, id)
			invalidate = state.callbacks.OnHistoryStatus
		} else if _, known := r.sessions[id]; known {
			state.pendingDeletes[id] = struct{}{}
		}
	} else {
		delete(r.sessions, id)
	}
	r.mu.Unlock()
	if invalidate != nil {
		invalidate(&gatewayv2.HistorySyncStatus{SourceId: "kbrain:" + r.target, Available: false, NeedsResync: true})
	}
	return &gatewayv2.HistoryDeleteResponse{}, nil
}

func (r *Relay) backendSessionID(id string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if backendID := r.sessions[id]; backendID != "" {
		return backendID
	}
	return id
}

func (r *Relay) HistoryGet(ctx context.Context, req *gatewayv2.HistoryGetRequest) (*gatewayv2.HistoryGetResponse, error) {
	if req == nil {
		return nil, errors.New("history get request is required")
	}
	id := strings.TrimSpace(req.GetConversationId())
	if id == "" {
		return nil, errors.New("conversation_id is required")
	}
	if req.GetMaxMessages() < 0 {
		return nil, errors.New("max_messages must not be negative")
	}
	r.mu.Lock()
	backendID := r.sessions[id]
	r.mu.Unlock()
	if backendID == "" {
		backendID = id
	}
	// The legacy zero limit means full history; canonical history uses bounded pages.
	limit := int(req.GetMaxMessages())
	pageSize := limit
	if pageSize == 0 || pageSize > 10000 {
		pageSize = 10000
	}
	result, err := r.client.GetHistory(ctx, backendID, pageSize, nil)
	if err != nil {
		return nil, err
	}
	if err := validateHistoryPage(result, backendID); err != nil {
		return nil, err
	}
	messages := result.Session.Messages
	oldest, more := result.OldestOffset, result.HasMoreBefore
	for more && (limit == 0 || len(messages) < limit) {
		count := 10000
		if limit > 0 && limit-len(messages) < count {
			count = limit - len(messages)
		}
		previous, err := r.client.getHistoryPage(ctx, backendID, count, &oldest, result.Revision)
		if err != nil {
			return nil, err
		}
		if err := validateHistoryPage(previous, backendID); err != nil {
			return nil, err
		}
		if previous.Revision != result.Revision || previous.TotalMessageCount != result.TotalMessageCount {
			return nil, errors.New("kbrain history revision conflict; reload the conversation")
		}
		if previous.OldestOffset >= oldest {
			return nil, errors.New("kbrain history pagination did not advance")
		}
		messages = append(previous.Session.Messages, messages...)
		oldest, more = previous.OldestOffset, previous.HasMoreBefore
	}
	raw, err := historyMessagesJSON(messages, oldest)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	// Only a successful canonical read may establish a recovered mapping.
	if r.sessions[id] == "" {
		r.sessions[id] = backendID
	}
	r.mu.Unlock()
	summary := sessionSummary(id, result.Session)
	summary.MessageCount = result.TotalMessageCount
	return &gatewayv2.HistoryGetResponse{ConversationId: id, Conversation: summary, MessagesJson: raw,
		TotalMessageCount: result.TotalMessageCount, ReturnedMessageCount: int32(len(messages)), HasMore: more}, nil
}

func validateHistoryPage(page HistoryResponse, backendID string) error {
	if page.Session.ID != backendID {
		return errors.New("kbrain history session identity mismatch")
	}
	if page.Revision == "" || page.TotalMessageCount < 0 || page.OldestOffset < 0 || int32(len(page.Session.Messages)) > page.TotalMessageCount {
		return errors.New("invalid kbrain history window")
	}
	return nil
}

func sessionSummary(id string, session Session) *gatewayv2.ConversationSummary {
	created, updated := int64(0), int64(0)
	if !session.CreatedAt.IsZero() {
		created = session.CreatedAt.UnixMilli()
	}
	if !session.UpdatedAt.IsZero() {
		updated = session.UpdatedAt.UnixMilli()
	} else {
		updated = created
	}
	title := strings.TrimSpace(session.Title)
	if title == "" {
		title = "K-brain session"
	}
	model, _ := json.Marshal(map[string]string{"customProviderId": session.Model.Provider, "model": session.Model.Model})
	count := session.MessageCount
	if session.TotalMessageCount > count {
		count = session.TotalMessageCount
	}
	return &gatewayv2.ConversationSummary{Id: id, Title: title, CreatedAt: created, UpdatedAt: updated, MessageCount: count,
		ProviderId: session.Model.Provider, Model: session.Model.Model, SessionId: session.ID, Cwd: session.CWD,
		IsPinned: session.Pinned, IsShared: session.Shared, SelectedModelJson: string(model)}
}

// The WebUI history parser consumes LiveAgent messages, not canonical messages.
// Each entry carries its canonical offset (firstOffset + slice index) so the
// WebUI can match search hits, which report whole-session offsets.
func historyMessagesJSON(messages []Message, firstOffset int32) (string, error) {
	out := make([]map[string]any, 0, len(messages))
	for i, message := range messages {
		if message.Role != "user" && message.Role != "assistant" && message.Role != "tool" {
			continue
		}
		content := make([]map[string]any, 0, len(message.Content))
		for _, block := range message.Content {
			switch block.Type {
			case "text":
				content = append(content, map[string]any{"type": "text", "text": block.Text})
			case "thinking":
				content = append(content, map[string]any{"type": "thinking", "thinking": block.Text})
			case "image":
				content = append(content, map[string]any{"type": "image", "data": block.ImageURL, "mimeType": block.MIMEType})
			case "file":
				content = append(content, map[string]any{"type": "file", "data": block.FileURL, "mimeType": block.MIMEType, "filename": block.Filename})
			}
		}
		entry := map[string]any{"role": message.Role, "content": content, "messageIndex": int(firstOffset) + i}
		if message.ID != "" {
			entry["id"] = message.ID
		}
		if !message.CreatedAt.IsZero() {
			entry["timestamp"] = message.CreatedAt.UnixMilli()
		}
		if message.Role == "tool" {
			entry["role"], entry["toolCallId"], entry["toolName"] = "toolResult", message.ToolCallID, message.Name
			entry["isError"] = message.StopReason == "error" || message.StopReason == "cancelled"
		}
		if message.Role == "assistant" {
			for _, search := range message.HostedSearch {
				var block map[string]any
				if err := json.Unmarshal(search, &block); err != nil {
					return "", err
				}
				block["type"] = "hostedSearch"
				content = append(content, block)
			}
			for _, call := range message.ToolCalls {
				var args any = map[string]any{}
				if len(call.Arguments) > 0 {
					if err := json.Unmarshal(call.Arguments, &args); err != nil {
						return "", fmt.Errorf("invalid history tool arguments at %d: %w", i, err)
					}
				}
				content = append(content, map[string]any{"type": "toolCall", "id": call.ID, "name": call.Name, "arguments": args})
			}
			entry["content"], entry["api"], entry["provider"], entry["model"] = content, protocolVersion, message.Provider, message.Model
			stop := message.StopReason
			switch stop {
			case "", "end_turn":
				stop = "stop"
			case "cancelled":
				stop = "aborted"
			case "tool_use":
				stop = "toolUse"
			}
			entry["stopReason"] = stop
			if message.Usage != nil {
				u := message.Usage
				entry["usage"] = map[string]any{"input": u.InputTokens, "output": u.OutputTokens, "cacheRead": u.CachedTokens, "cacheWrite": u.CacheWriteTokens, "totalTokens": int64(u.InputTokens) + int64(u.OutputTokens)}
			}
		}
		out = append(out, entry)
	}
	data, err := json.Marshal(out)
	return string(data), err
}
