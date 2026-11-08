package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// WebUI archive commands. They ride the generic memory_manage passthrough so the
// desktop bridge and this direct relay answer the same commands with the same JSON.
const (
	historyArchiveSupportedCommand = "history_archive_supported"
	historyArchivedListCommand     = "history_archived_list"
	historyArchiveSetCommand       = "history_archive_set"
)

func (r *Relay) supportsSessionArchive(ctx context.Context) (bool, error) {
	health, err := r.client.verifiedHealth(ctx, handshakeMaxAge)
	if err != nil {
		return false, err
	}
	return health.CapabilityAtLeast("session_archive", 1), nil
}

func (r *Relay) historyArchiveSupported(ctx context.Context) (json.RawMessage, error) {
	supported, err := r.supportsSessionArchive(ctx)
	if err != nil {
		// An unreachable backend hides archive actions instead of failing the sidebar.
		supported = false
	}
	return json.Marshal(map[string]bool{"supported": supported})
}

func (r *Relay) historyArchivedList(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
	var input struct {
		Page     int `json:"page"`
		PageSize int `json:"page_size"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return nil, errors.New("invalid history_archived_list args")
	}
	if supported, err := r.supportsSessionArchive(ctx); err != nil {
		return nil, err
	} else if !supported {
		return nil, errors.New("kbrain does not support archived sessions")
	}
	size := input.PageSize
	if size < 1 {
		size = 30
	}
	if size > 200 {
		size = 200
	}
	result, err := r.client.ListArchivedSessions(ctx, input.Page, size)
	if err != nil {
		return nil, err
	}
	conversations := make([]map[string]any, 0, len(result.Sessions))
	r.mu.Lock()
	for _, session := range result.Sessions {
		if strings.TrimSpace(session.ID) == "" {
			r.mu.Unlock()
			return nil, errors.New("kbrain history session has no id")
		}
		conversations = append(conversations, archivedSummaryJSON(r.historyConversationIDLocked(session.ID), session))
	}
	r.mu.Unlock()
	return json.Marshal(map[string]any{"conversations": conversations, "total_count": result.TotalCount})
}

// archivedSummaryJSON is the WebUI's ConversationSummary shape (snake_case, epoch ms).
func archivedSummaryJSON(id string, session Session) map[string]any {
	summary := sessionSummary(id, session)
	return map[string]any{
		"id":                  summary.GetId(),
		"title":               summary.GetTitle(),
		"created_at":          summary.GetCreatedAt(),
		"updated_at":          summary.GetUpdatedAt(),
		"message_count":       summary.GetMessageCount(),
		"provider_id":         summary.GetProviderId(),
		"model":               summary.GetModel(),
		"session_id":          summary.GetSessionId(),
		"cwd":                 summary.GetCwd(),
		"selected_model_json": summary.GetSelectedModelJson(),
		"is_pinned":           summary.GetIsPinned(),
		"is_shared":           summary.GetIsShared(),
		"is_archived":         true,
	}
}

func (r *Relay) historyArchiveSet(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
	var input struct {
		ConversationID string `json:"conversation_id"`
		Archived       *bool  `json:"archived"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return nil, errors.New("invalid history_archive_set args")
	}
	id := strings.TrimSpace(input.ConversationID)
	if id == "" {
		return nil, errors.New("conversation_id is required")
	}
	if input.Archived == nil {
		return nil, errors.New("archived is required")
	}
	if supported, err := r.supportsSessionArchive(ctx); err != nil {
		return nil, err
	} else if !supported {
		return nil, errors.New("kbrain does not support archived sessions")
	}
	session, err := r.client.UpdateSession(ctx, r.backendSessionID(id), map[string]any{"archived": *input.Archived})
	if err != nil {
		return nil, err
	}
	if session.Archived != *input.Archived {
		return nil, errors.New("kbrain did not apply the archive change")
	}
	return json.RawMessage(`{}`), nil
}
