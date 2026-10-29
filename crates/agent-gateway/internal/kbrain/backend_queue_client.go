package kbrain

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

type backendQueueRun struct {
	GatewayRunID    string       `json:"gateway_run_id"`
	ConversationID  string       `json:"conversation_id"`
	SessionID       string       `json:"session_id"`
	ClientRequestID string       `json:"client_request_id"`
	ItemID          string       `json:"item_id,omitempty"`
	Run             *RunAccepted `json:"run,omitempty"`
	LastSeq         int64        `json:"last_seq,omitempty"`
}

type backendQueueItem struct {
	ID                string         `json:"id"`
	ClientRequestID   string         `json:"clientRequestId"`
	PreviewText       string         `json:"previewText"`
	FileCount         int            `json:"fileCount"`
	CreatedAt         int64          `json:"createdAt"`
	Source            string         `json:"source"`
	Editable          bool           `json:"editable"`
	Request           *PromptRequest `json:"request,omitempty"`
	DraftJSON         string         `json:"draftJson,omitempty"`
	UploadedFilesJSON string         `json:"uploadedFilesJson,omitempty"`
}

type backendQueueSnapshot struct {
	ConversationID string             `json:"conversationId"`
	Revision       uint64             `json:"revision"`
	Paused         bool               `json:"paused"`
	Items          []backendQueueItem `json:"items"`
}

type backendQueueReceipt struct {
	ID    string       `json:"id"`
	State string       `json:"state"`
	Error string       `json:"error,omitempty"`
	Run   *RunAccepted `json:"run,omitempty"`
}

type backendQueueResponse struct {
	httpStatus int
	Version    string               `json:"version"`
	Accepted   bool                 `json:"accepted"`
	ErrorCode  string               `json:"errorCode"`
	Message    string               `json:"message"`
	Error      string               `json:"error"`
	Snapshot   backendQueueSnapshot `json:"snapshot"`
	Item       *backendQueueItem    `json:"item,omitempty"`
	Receipt    *backendQueueReceipt `json:"receipt,omitempty"`
}

func (c *Client) sessionQueue(ctx context.Context, method, sessionID, suffix string, input any) (backendQueueResponse, error) {
	var out backendQueueResponse
	resp, err := c.request(ctx, method, "/v1/sessions/"+url.PathEscape(sessionID)+"/queue"+suffix, input, &out)
	if resp != nil {
		out.httpStatus = resp.StatusCode
	}
	if err != nil {
		return out, err
	}
	if resp.StatusCode >= 400 && out.ErrorCode == "" {
		return out, fmt.Errorf("kbrain queue: %s: %s", resp.Status, out.Error)
	}
	if out.Version != protocolVersion {
		return out, fmt.Errorf("unsupported K-brain queue protocol %q", out.Version)
	}
	if out.Snapshot.ConversationID != sessionID {
		return out, fmt.Errorf("kbrain queue identity mismatch")
	}
	return out, nil
}

// EnableBackendQueue selects backend ownership only when explicitly advertised.
// Existing relay-owned work drains through its original executor before migration.
func (r *Relay) EnableBackendQueue(ctx context.Context, callbacks Callbacks) error {
	health, resp, err := readHealth(ctx, r.client.HTTP, r.client.BaseURL, r.client.Token)
	if resp != nil && resp.StatusCode == http.StatusNotFound {
		if r.usesBackendQueue() {
			return fmt.Errorf("backend-owned queue requires a compatible K-brain")
		}
		return nil
	}
	if err != nil {
		return err
	}
	r.mu.Lock()
	if !health.FrozenCapability("session_queue") {
		if r.backendQueue {
			r.mu.Unlock()
			return fmt.Errorf("backend-owned queue requires a compatible K-brain")
		}
		r.mu.Unlock()
		return nil
	}
	if len(r.activeRuns) > 0 || len(r.queueEdits) > 0 {
		r.mu.Unlock()
		return nil
	}
	for _, items := range r.queues {
		if len(items) > 0 {
			r.mu.Unlock()
			return nil
		}
	}
	r.backendQueue = true
	if err := r.persistQueueLocked(); err != nil {
		r.mu.Unlock()
		return err
	}
	bindings := make([]backendQueueRun, 0, len(r.backendRuns))
	for _, run := range r.backendRuns {
		bindings = append(bindings, run)
	}
	r.mu.Unlock()
	for _, binding := range bindings {
		r.watchBackendQueuedRun(binding, callbacks)
	}
	return nil
}

func (r *Relay) usesBackendQueue() bool { r.mu.Lock(); defer r.mu.Unlock(); return r.backendQueue }
