package kbrain

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	v2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// MCP form elicitations (Stack-Cairn/K-brain#174): an MCP server asks the user
// to fill in a form while its tool runs. The relay shows the form on the tool
// call's card through synthetic arguments the WebUI reads
// (crates/agent-ui/src/lib/chat/mcpElicitation.ts) and forwards the answer
// from chat_queue mcp_elicitation. Typed values pass straight to K-brain; only
// K-brain's redacted copy of an accepted answer is kept or forwarded.
const (
	argElicitationPending = "__mcpElicitationPending"
	argElicitationRecords = "__mcpElicitations"
	// elicitationDetailsKey carries a tool result's elicitations, as the desktop does.
	elicitationDetailsKey = "kbrainElicitations"
	// mcpElicitationCapability (Stack-Cairn/K-brain#174) accepts options.mcp_elicitation.
	mcpElicitationCapability = "mcp_elicitation"
	// elicitationContentMax bounds an answer forwarded to K-brain.
	elicitationContentMax = 256 * 1024
)

// callElicitations are the forms of one tool call: requests still waiting and
// the resolutions seen during the run, in order.
type callElicitations struct {
	runID   string
	pending []map[string]any
	records []map[string]any
}

type elicitationRequest struct {
	ElicitationID string `json:"elicitation_id"`
	ToolCallID    string `json:"tool_call_id"`
	RunID         string `json:"run_id"`
	Tool          string `json:"tool"`
}

func elicitationPendingKey(conversationID, elicitationID string) string {
	return interactionKey(conversationID, "elicitation:"+elicitationID)
}

// elicitationArgs adds a call's forms to its redrawn arguments.
func (s *interactiveState) elicitationArgsLocked(key string, args map[string]any) {
	state := s.elicitations[key]
	if state == nil {
		return
	}
	if len(state.pending) > 0 {
		pending := make([]any, 0, len(state.pending))
		for _, request := range state.pending {
			pending = append(pending, request)
		}
		args[argElicitationPending] = pending
	}
	if len(state.records) > 0 {
		records := make([]any, 0, len(state.records))
		for _, record := range state.records {
			records = append(records, record)
		}
		args[argElicitationRecords] = records
	}
}

func (s *interactiveState) requestElicitation(conversationID, sessionID, runID string, raw json.RawMessage, emit func(*v2.ChatEvent)) []*v2.ChatEvent {
	var request elicitationRequest
	var payload map[string]any
	if json.Unmarshal(raw, &request) != nil || json.Unmarshal(raw, &payload) != nil {
		return nil
	}
	request.ElicitationID = strings.TrimSpace(request.ElicitationID)
	request.ToolCallID = strings.TrimSpace(request.ToolCallID)
	if request.ElicitationID == "" || request.ToolCallID == "" {
		return nil
	}
	if request.RunID != "" && runID != "" && request.RunID != runID {
		return nil
	}
	if runID == "" {
		runID = request.RunID
	}
	key := interactionKey(conversationID, request.ToolCallID)
	pendingKey := elicitationPendingKey(conversationID, request.ElicitationID)
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.elicitations[key]
	if state == nil {
		state = &callElicitations{runID: runID}
		s.elicitations[key] = state
	}
	// A replayed request (reconnect) is shown once; a resolved one stays closed.
	if s.pending[pendingKey] != nil || elicitationListHas(state.records, request.ElicitationID) {
		return nil
	}
	state.pending = append(state.pending, payload)
	s.pending[pendingKey] = &pendingInteraction{
		kind: "elicitation", conversationID: conversationID, sessionID: sessionID, runID: runID,
		requestID: request.ElicitationID, toolCallID: request.ToolCallID, emit: emit,
	}
	if s.calls[key] == nil {
		// K-brain publishes the tool call first; keep the form visible if it was missed.
		name := strings.TrimSpace(request.Tool)
		if name == "" {
			name = "mcp"
		}
		s.calls[key] = &recordedCall{runID: runID, name: name, arguments: map[string]any{}}
	}
	return []*v2.ChatEvent{s.callEventLocked(conversationID, request.ToolCallID), statusEvent(conversationID, "Waiting for your answer…", false)}
}

func (s *interactiveState) resolveElicitation(conversationID string, raw json.RawMessage) []*v2.ChatEvent {
	var resolved elicitationRequest
	var record map[string]any
	if json.Unmarshal(raw, &resolved) != nil || json.Unmarshal(raw, &record) != nil {
		return nil
	}
	resolved.ElicitationID = strings.TrimSpace(resolved.ElicitationID)
	resolved.ToolCallID = strings.TrimSpace(resolved.ToolCallID)
	if resolved.ElicitationID == "" || resolved.ToolCallID == "" {
		return nil
	}
	key := interactionKey(conversationID, resolved.ToolCallID)
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.pending, elicitationPendingKey(conversationID, resolved.ElicitationID))
	state := s.elicitations[key]
	if state == nil {
		state = &callElicitations{runID: resolved.RunID}
		s.elicitations[key] = state
	}
	if elicitationListHas(state.records, resolved.ElicitationID) {
		return nil
	}
	// elicitation.resolved has no fields; the summary labels values with the request's.
	kept := state.pending[:0]
	for _, request := range state.pending {
		if elicitationID(request) == resolved.ElicitationID {
			if _, ok := record["fields"]; !ok {
				record["fields"] = request["fields"]
			}
			continue
		}
		kept = append(kept, request)
	}
	state.pending = kept
	state.records = append(state.records, sanitizeElicitationRecord(record))
	out := []*v2.ChatEvent{}
	if chat := s.callEventLocked(conversationID, resolved.ToolCallID); chat != nil {
		out = append(out, chat)
	}
	return append(out, statusEvent(conversationID, "", false))
}

// dropElicitationsLocked forgets the forms of a finished run.
func (s *interactiveState) dropElicitationsLocked(conversationID, runID string) {
	prefix := conversationID + "\x00"
	for key, state := range s.elicitations {
		if strings.HasPrefix(key, prefix) && (state.runID == runID || state.runID == "") {
			delete(s.elicitations, key)
		}
	}
}

func elicitationID(entry map[string]any) string {
	id, _ := entry["elicitation_id"].(string)
	return strings.TrimSpace(id)
}

func elicitationListHas(list []map[string]any, id string) bool {
	for _, entry := range list {
		if elicitationID(entry) == id {
			return true
		}
	}
	return false
}

// sanitizeElicitationRecord drops the value of every sensitive field from a
// record's content and names it in redacted. K-brain already redacts them;
// this keeps a value from ever reaching WebUI storage if it did not.
func sanitizeElicitationRecord(record map[string]any) map[string]any {
	content, _ := record["content"].(map[string]any)
	fields, _ := record["fields"].([]any)
	if len(content) == 0 || len(fields) == 0 {
		return record
	}
	redacted := map[string]bool{}
	var names []any
	if list, ok := record["redacted"].([]any); ok {
		for _, name := range list {
			if text, ok := name.(string); ok && !redacted[text] {
				redacted[text] = true
				names = append(names, text)
			}
		}
	}
	cleaned := make(map[string]any, len(content))
	for name, value := range content {
		cleaned[name] = value
	}
	for _, raw := range fields {
		field, _ := raw.(map[string]any)
		name, _ := field["name"].(string)
		if field["sensitive"] != true || name == "" {
			continue
		}
		if _, ok := cleaned[name]; ok {
			delete(cleaned, name)
			if !redacted[name] {
				redacted[name] = true
				names = append(names, name)
			}
		}
	}
	out := make(map[string]any, len(record))
	for k, v := range record {
		out[k] = v
	}
	out["content"] = cleaned
	if len(names) > 0 {
		out["redacted"] = names
	}
	return out
}

// sanitizeElicitationRecords reads a tool's recorded elicitations (tool.result
// or history) for the result details; nil when there are none.
func sanitizeElicitationRecords(raw any) []any {
	list, ok := raw.([]any)
	if !ok || len(list) == 0 {
		return nil
	}
	out := make([]any, 0, len(list))
	for _, entry := range list {
		if record, ok := entry.(map[string]any); ok {
			out = append(out, sanitizeElicitationRecord(record))
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// withElicitationDetails adds a tool's elicitations to its result details.
func withElicitationDetails(details map[string]any, raw any) map[string]any {
	records := sanitizeElicitationRecords(raw)
	if records == nil {
		return details
	}
	if details == nil {
		details = map[string]any{}
	}
	details[elicitationDetailsKey] = records
	return details
}

// decodeElicitations reads history's recorded elicitations of a call.
func decodeElicitations(raw []json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	out := make([]any, 0, len(raw))
	for _, item := range raw {
		var record map[string]any
		if json.Unmarshal(item, &record) == nil && record != nil {
			out = append(out, record)
		}
	}
	return out
}

// answerElicitation forwards a WebUI form answer to K-brain. requestJSON is
// {"elicitationId","action":"accept"|"decline"|"cancel","content"?}. A refused
// answer (400) keeps the form open and returns K-brain's field_errors in ItemJSON.
func (r *Relay) answerElicitation(ctx context.Context, conversationID, toolCallID, requestJSON string) QueueResponse {
	if len(requestJSON) > elicitationContentMax {
		return queueError("invalid_request", "form answer is too large")
	}
	var answer struct {
		ElicitationID string          `json:"elicitationId"`
		Action        string          `json:"action"`
		Content       json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(requestJSON)), &answer); err != nil {
		return queueError("invalid_request", "form answer is invalid")
	}
	pending := r.interactive.lookupElicitation(conversationID, strings.TrimSpace(answer.ElicitationID))
	if pending == nil || pending.toolCallID != toolCallID {
		return queueError("not_found", "This form is no longer pending.")
	}
	body := map[string]any{
		"conversation_id": pending.sessionID, "run_id": pending.runID,
		"elicitation_id": pending.requestID, "action": answer.Action,
	}
	switch answer.Action {
	case "accept":
		var content map[string]any
		if json.Unmarshal(answer.Content, &content) != nil || content == nil {
			return queueError("invalid_request", "an accepted answer needs content")
		}
		body["content"] = content
	case "decline", "cancel":
	default:
		return queueError("invalid_request", "form answer action is invalid")
	}
	status, message, fieldErrors, err := r.client.postInteractionErrors(ctx, "/v1/sessions/"+url.PathEscape(pending.sessionID)+"/elicitations/"+url.PathEscape(pending.requestID), body)
	switch {
	case err != nil:
		return queueError("kbrain_error", err.Error())
	case status == http.StatusNotFound || status == http.StatusConflict:
		r.interactive.drop(pending)
		return queueError("not_found", "This form is no longer pending.")
	case status == http.StatusBadRequest:
		response := queueError("invalid_content", message)
		if len(fieldErrors) > 0 {
			data, _ := json.Marshal(map[string]any{"field_errors": fieldErrors})
			response.ItemJSON = string(data)
		}
		return response
	case status < 200 || status >= 300:
		return queueError("kbrain_error", message)
	}
	return QueueResponse{Accepted: true}
}

func (s *interactiveState) lookupElicitation(conversationID, elicitationID string) *pendingInteraction {
	if elicitationID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	pending := s.pending[elicitationPendingKey(conversationID, elicitationID)]
	if pending == nil || pending.kind != "elicitation" {
		return nil
	}
	copied := *pending
	return &copied
}

// postInteractionErrors is postInteraction that also returns K-brain's
// field_errors (a refused elicitation answer).
func (c *Client) postInteractionErrors(ctx context.Context, path string, input any) (int, string, map[string]string, error) {
	resp, err := c.request(ctx, http.MethodPost, path, input, nil)
	if err != nil {
		return 0, "", nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp.StatusCode, "", nil, nil
	}
	var failure struct {
		Error       string            `json:"error"`
		FieldErrors map[string]string `json:"field_errors"`
	}
	message := resp.Status
	if json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&failure) == nil && strings.TrimSpace(failure.Error) != "" {
		message = strings.TrimSpace(failure.Error)
	}
	return resp.StatusCode, message, failure.FieldErrors, nil
}

// withMCPElicitation asks the run to show MCP forms (options.mcp_elicitation)
// on backends with capability mcp_elicitation; older backends reject unknown
// run options, and without the option K-brain declines every form itself.
func (c *Client) withMCPElicitation(ctx context.Context, in PromptRequest) PromptRequest {
	if in.Options == nil {
		return in
	}
	health, err := c.verifiedHealth(ctx, handshakeCapabilityMaxAge)
	if err != nil || !health.FrozenCapability(mcpElicitationCapability) {
		return in
	}
	options := *in.Options
	options.MCPElicitation = true
	in.Options = &options
	return in
}
