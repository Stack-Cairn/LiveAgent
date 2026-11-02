package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
)

// The legacy WebUI transport has no permission-response RPC. Fail closed instead
// of leaving a remote run waiting forever for an approval the client cannot send.
func (c *Client) rejectUnsupportedPermission(ctx context.Context, event Event) error {
	var request struct {
		PermissionID string `json:"permission_id"`
	}
	if err := json.Unmarshal(event.Payload, &request); err != nil {
		return err
	}
	if request.PermissionID == "" {
		return errors.New("permission request has no identity")
	}
	_, err := c.settingsRequest(ctx, http.MethodPost, "/v1/sessions/"+url.PathEscape(event.ConversationID)+"/permissions/"+url.PathEscape(request.PermissionID), map[string]any{
		"conversation_id": event.ConversationID, "run_id": event.RunID,
		"decision": map[string]string{"permission_id": request.PermissionID, "decision": "reject", "reason": "This WebUI transport cannot confirm tool permissions. Retry in LiveAgent desktop or K-brain TUI."},
	})
	return err
}
