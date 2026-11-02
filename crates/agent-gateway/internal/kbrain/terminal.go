package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func (r *Relay) Terminal(ctx context.Context, request *gatewayv2.TerminalRequest) (*gatewayv2.TerminalResponse, error) {
	if request == nil {
		return nil, errors.New("terminal request is required")
	}
	r.mu.Lock()
	state := r.runs[strings.TrimSpace(request.GetRunId())]
	if state == nil || state.conversationID != strings.TrimSpace(request.GetConversationId()) || state.kbrainSessionID == "" || state.kbrainRunID == "" {
		r.mu.Unlock()
		return nil, errors.New("terminal request must identify an accepted Gateway canonical run")
	}
	sessionID, runID := state.kbrainSessionID, state.kbrainRunID
	r.mu.Unlock()
	mapped := proto.Clone(request).(*gatewayv2.TerminalRequest)
	mapped.ConversationId, mapped.RunId = sessionID, runID
	return r.client.Terminal(ctx, mapped)
}

func (c *Client) Terminal(ctx context.Context, request *gatewayv2.TerminalRequest) (*gatewayv2.TerminalResponse, error) {
	if request == nil {
		return nil, errors.New("terminal request is required")
	}
	conversationID, runID := strings.TrimSpace(request.GetConversationId()), strings.TrimSpace(request.GetRunId())
	if conversationID == "" || runID == "" {
		return nil, errors.New("terminal request requires conversation_id and run_id")
	}
	// Explicit local fields keep SSH/SFTP credentials out of the backend adapter.
	body := map[string]any{
		"action": request.GetAction(), "conversation_id": conversationID, "run_id": runID,
		"session_id": request.GetSessionId(), "project_path_key": request.GetProjectPathKey(),
		"cwd": request.GetCwd(), "shell": request.GetShell(), "title": request.GetTitle(),
		"data": request.GetData(), "cols": request.GetCols(), "rows": request.GetRows(), "max_bytes": request.GetMaxBytes(),
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode terminal request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/v1/terminal", strings.NewReader(string(encoded)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("kbrain terminal request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read kbrain terminal response: %w", err)
	}
	var payload map[string]json.RawMessage
	if len(strings.TrimSpace(string(raw))) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				return nil, fmt.Errorf("kbrain terminal request: %s: %s", resp.Status, strings.TrimSpace(string(raw)))
			}
			return nil, fmt.Errorf("decode terminal response: %w", err)
		}
	} else {
		payload = make(map[string]json.RawMessage)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := terminalErrorMessage(payload, raw)
		return nil, fmt.Errorf("kbrain terminal request: %s: %s", resp.Status, message)
	}
	var returnedConversation, returnedRun string
	if json.Unmarshal(payload["conversation_id"], &returnedConversation) != nil || json.Unmarshal(payload["run_id"], &returnedRun) != nil || returnedConversation != conversationID || returnedRun != runID {
		return nil, errors.New("kbrain terminal response identity mismatch")
	}
	delete(payload, "conversation_id")
	delete(payload, "run_id")
	responseJSON, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	response := &gatewayv2.TerminalResponse{}
	if err = protojson.Unmarshal(responseJSON, response); err != nil {
		return nil, fmt.Errorf("decode terminal response: %w", err)
	}
	return response, nil
}

func terminalErrorMessage(payload map[string]json.RawMessage, raw []byte) string {
	for _, key := range []string{"error", "message", "detail"} {
		var message string
		if json.Unmarshal(payload[key], &message) == nil && strings.TrimSpace(message) != "" {
			return strings.TrimSpace(message)
		}
	}
	if message := strings.TrimSpace(string(raw)); message != "" {
		return message
	}
	return "empty error response"
}
