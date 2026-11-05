package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	v2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// Synthetic tool-call arguments the WebUI reads to render approval and question
// cards (crates/agent-ui/src/lib/chat/toolApprovalArgs.ts, askUserQuestion.ts,
// planMode.ts). Only the relay may set them: a model writing the same keys into
// its own arguments could otherwise fake an approval card, so they are dropped
// from every model tool call before it is forwarded.
const (
	argApprovalPending     = "__toolApprovalPending"
	argApprovalSummary     = "__toolApprovalSummary"
	argApprovalAllowAlways = "__toolApprovalAllowSession"
	argApprovalScope       = "__toolApprovalSessionScope"
	argApprovalSessionWide = "__toolApprovalSessionWide"
	argApprovalRules       = "__toolApprovalRememberRules"
	argApprovalDefault     = "__toolApprovalDefaultScope"
	argApprovalNotice      = "__toolApprovalNotice"
	argApprovalPreview     = "__toolApprovalPreview"
	argAutoResolved        = "__toolPermissionAutoResolved"
	argQuestionPending     = "__askUserQuestionPending"
	argQuestionDeadline    = "__askUserQuestionDeadlineAt"

	askUserQuestionTool = "AskUserQuestion"
	// syntheticPermissionPrefix names the card of a permission K-brain did not tie
	// to a model tool call, so WebUI still has something to answer.
	syntheticPermissionPrefix = "kbrain-permission:"
	subagentCallPrefix        = "kbrain-subagent:"

	approvalTextMax  = 2000
	approvalScopeMax = 300
	// approvalPreviewMax bounds the synced diff, as K-brain bounds its own (32 KiB).
	approvalPreviewMax = 32 * 1024
)

var syntheticArgPrefixes = []string{"__toolApproval", "__toolPermission", "__askUserQuestion", "__exitPlanMode"}

// interactiveState holds what WebUI needs to answer a direct K-brain run: the
// model tool calls seen so far (to redraw a card with or without its pending
// marker) and the permissions and questions still waiting for an answer.
type interactiveState struct {
	mu           sync.Mutex
	calls        map[string]*recordedCall
	pending      map[string]*pendingInteraction
	autoResolved map[string]map[string]any
}

type recordedCall struct {
	runID     string
	name      string
	arguments map[string]any
	settled   bool
}

type pendingInteraction struct {
	kind           string // "permission" or "question"
	conversationID string
	sessionID      string
	runID          string
	requestID      string
	toolCallID     string
	synthetic      bool
	overlay        map[string]any
	rememberRules  []string
	emit           func(*v2.ChatEvent)
}

func newInteractiveState() *interactiveState {
	return &interactiveState{
		calls:        map[string]*recordedCall{},
		pending:      map[string]*pendingInteraction{},
		autoResolved: map[string]map[string]any{},
	}
}

func interactionKey(conversationID, toolCallID string) string {
	return conversationID + "\x00" + toolCallID
}

// relayRunEvent translates one event of a direct run into Gateway chat events.
// Interactive events are kept here so WebUI can answer them later through
// chat_queue tool_approval / tool_answer; everything else goes through ToChatEvent.
func (r *Relay) relayRunEvent(ctx context.Context, event Event, conversationID string, emit func(*v2.ChatEvent)) (*v2.ChatControlEvent, error) {
	s := r.interactive
	sessionID := event.ConversationID
	payload := event.Payload
	switch strings.TrimSpace(event.Type) {
	case "tool.call":
		var body struct {
			ToolCall *ToolCall `json:"tool_call"`
		}
		if err := json.Unmarshal(payload, &body); err != nil {
			return nil, fmt.Errorf("decode kbrain tool call: %w", err)
		}
		if body.ToolCall == nil || strings.TrimSpace(body.ToolCall.ID) == "" {
			return nil, nil
		}
		emit(s.recordCall(conversationID, event.RunID, *body.ToolCall))
		return nil, nil
	case "tool.result":
		var body struct {
			ToolResult *struct {
				ID string `json:"id"`
			} `json:"tool_result"`
		}
		if json.Unmarshal(payload, &body) == nil && body.ToolResult != nil {
			s.settleCall(conversationID, body.ToolResult.ID)
		}
	case "tool.status":
		var status struct {
			ToolCallID string  `json:"tool_call_id"`
			Status     string  `json:"status"`
			Message    *string `json:"message"`
			Compaction bool    `json:"compaction"`
		}
		if err := json.Unmarshal(payload, &status); err != nil {
			return nil, fmt.Errorf("decode kbrain tool status: %w", err)
		}
		// A running status naming a tool call is that command's output so far:
		// it belongs on the tool card, not in the run status line.
		if status.ToolCallID != "" && status.Status == "running" && status.Message != nil {
			if s.callIsLive(conversationID, status.ToolCallID) {
				emit(chatEvent(conversationID, v2.ChatEvent_TOOL_CALL, map[string]any{"type": "tool_output", "id": status.ToolCallID, "output": *status.Message}))
			}
			return nil, nil
		}
		if status.Compaction {
			text := "Compacting context…"
			if status.Message != nil && strings.TrimSpace(*status.Message) != "" {
				text = strings.TrimSpace(*status.Message)
			}
			emit(statusEvent(conversationID, text, true))
			return nil, nil
		}
	case "compaction.started":
		emit(statusEvent(conversationID, "Compacting context…", true))
		return nil, nil
	case "compaction.completed":
		var done struct {
			Status string `json:"status"`
			Error  string `json:"error"`
		}
		_ = json.Unmarshal(payload, &done)
		if done.Error != "" {
			emit(statusEvent(conversationID, "Compaction failed: "+done.Error, false))
		} else {
			emit(statusEvent(conversationID, "", false))
		}
		return nil, nil
	case "hook.warning":
		var warning struct {
			HookName string `json:"hookName"`
			HookType string `json:"hookType"`
			Event    string `json:"event"`
			Message  string `json:"message"`
		}
		_ = json.Unmarshal(payload, &warning)
		name := strings.TrimSpace(warning.HookName)
		if name == "" {
			name = "hook"
		}
		if warning.Event != "" {
			name += " (" + warning.Event + ")"
		}
		emit(statusEvent(conversationID, clampText("Hook "+name+" warning: "+strings.TrimSpace(warning.Message), approvalTextMax), false))
		return nil, nil
	case "history.updated":
		// History sync (history_sync.go) already turns the session change into a
		// history upsert, and WebUI reloads the displayed conversation on it.
		return nil, nil
	case "goal.updated":
		var goal map[string]any
		if err := json.Unmarshal(payload, &goal); err != nil {
			return nil, fmt.Errorf("decode kbrain goal: %w", err)
		}
		emit(chatEvent(conversationID, v2.ChatEvent_TOOL_CALL, map[string]any{"type": "goal_updated", "goal": goal}))
		return nil, nil
	case "subagent.started", "subagent.updated", "subagent.completed", "subagent.failed":
		for _, chat := range subagentEvents(conversationID, payload) {
			emit(chat)
		}
		return nil, nil
	case "permission.requested":
		var request permissionRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, fmt.Errorf("decode kbrain permission request: %w", err)
		}
		if strings.TrimSpace(request.PermissionID) == "" {
			return nil, errors.New("permission request has no identity")
		}
		for _, chat := range s.requestPermission(conversationID, sessionID, event.RunID, request, emit) {
			emit(chat)
		}
		return nil, nil
	case "permission.resolved":
		var resolved struct {
			PermissionID string `json:"permission_id"`
			Decision     string `json:"decision"`
			Reason       string `json:"reason"`
		}
		_ = json.Unmarshal(payload, &resolved)
		for _, chat := range s.resolvePermission(conversationID, resolved.PermissionID, resolved.Decision, resolved.Reason) {
			emit(chat)
		}
		return nil, nil
	case "permission.auto_resolved":
		var resolved struct {
			ToolCallID string `json:"tool_call_id"`
			Source     string `json:"source"`
			Rule       string `json:"rule"`
			Scope      string `json:"scope"`
		}
		_ = json.Unmarshal(payload, &resolved)
		if resolved.ToolCallID != "" && (resolved.Source == "rule" || resolved.Source == "read_only") {
			marker := map[string]any{"source": resolved.Source}
			if resolved.Rule != "" {
				marker["rule"] = resolved.Rule
			}
			if resolved.Scope != "" {
				marker["scope"] = resolved.Scope
			}
			if chat := s.markAutoResolved(conversationID, resolved.ToolCallID, marker); chat != nil {
				emit(chat)
			}
		}
		return nil, nil
	case "question.requested":
		var request questionRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, fmt.Errorf("decode kbrain question: %w", err)
		}
		if request.QuestionID == "" || request.ToolCallID == "" {
			return nil, errors.New("question request has no identity")
		}
		for _, chat := range s.requestQuestion(conversationID, sessionID, event.RunID, request, emit) {
			emit(chat)
		}
		return nil, nil
	case "question.resolved":
		var resolved struct {
			QuestionID string `json:"question_id"`
			ToolCallID string `json:"tool_call_id"`
		}
		_ = json.Unmarshal(payload, &resolved)
		for _, chat := range s.resolveQuestion(conversationID, resolved.ToolCallID) {
			emit(chat)
		}
		return nil, nil
	case "client_tool.requested":
		// Direct runs offer no client tools; answer like the desktop does so a
		// stray request fails fast instead of waiting for its deadline.
		var request struct {
			CallID string `json:"call_id"`
			RunID  string `json:"run_id"`
			Tool   string `json:"tool"`
		}
		if json.Unmarshal(payload, &request) == nil && request.CallID != "" {
			callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			// A 409 means the call already settled; nothing is left to do.
			_ = r.client.resolveClientTool(callCtx, sessionID, request.CallID, event.RunID, request.Tool+" must execute in K-brain; the Gateway does not execute client tools.")
			cancel()
		}
		return nil, nil
	case "run.completed", "run.failed", "run.cancelled":
		for _, chat := range s.finishRun(conversationID, event.RunID) {
			emit(chat)
		}
	}
	mapped := event
	mapped.ConversationID = conversationID
	chat, control, err := toChatEvent(mapped, func(id string) map[string]any { return s.callArguments(conversationID, id) })
	if err != nil {
		return nil, err
	}
	if chat != nil {
		emit(chat)
	}
	return control, nil
}

type permissionRequest struct {
	PermissionID string `json:"permission_id"`
	Tool         string `json:"tool"`
	Command      string `json:"command"`
	Rule         string `json:"rule"`
	Description  string `json:"description"`
	Options      []struct {
		ID string `json:"id"`
	} `json:"options"`
	Suggestion *struct {
		Rules        []string `json:"rules"`
		DefaultScope string   `json:"default_scope"`
	} `json:"suggestion"`
	Scope      string `json:"scope"`
	ToolCallID string `json:"tool_call_id"`
	// Preview is the change a file tool will make, as diff rows.
	Preview *struct {
		Path      string `json:"path"`
		Diff      string `json:"diff"`
		NewFile   bool   `json:"new_file"`
		Truncated bool   `json:"truncated"`
	} `json:"preview"`
}

type questionRequest struct {
	QuestionID string            `json:"question_id"`
	ToolCallID string            `json:"tool_call_id"`
	RunID      string            `json:"run_id"`
	DeadlineAt int64             `json:"deadline_at"`
	Questions  []json.RawMessage `json:"questions"`
}

func (s *interactiveState) recordCall(conversationID, runID string, call ToolCall) *v2.ChatEvent {
	args := map[string]any{}
	if len(call.Arguments) != 0 {
		// Arguments that are not an object are forwarded as an empty object; the
		// card only reads named fields.
		_ = json.Unmarshal(call.Arguments, &args)
		if args == nil {
			args = map[string]any{}
		}
	}
	for key := range args {
		if isSyntheticArg(key) {
			delete(args, key)
		}
	}
	if call.Name == kbrainQuestionTool {
		// K-brain's question tool is answered on the AskUserQuestion card.
		call.Name, args = askUserQuestionTool, normalizeQuestionToolArgs(args)
	}
	key := interactionKey(conversationID, call.ID)
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing := s.calls[key]; existing != nil && existing.name == askUserQuestionTool && call.Name == askUserQuestionTool {
		// The question already registered; keep its normalized questions and marker.
		return s.callEventLocked(conversationID, call.ID)
	}
	if call.Name == askUserQuestionTool {
		// The card stays closed until K-brain registers the question.
		args[argQuestionPending] = false
	}
	s.calls[key] = &recordedCall{runID: runID, name: call.Name, arguments: args}
	if marker := s.autoResolved[key]; marker != nil {
		delete(s.autoResolved, key)
		s.calls[key].arguments[argAutoResolved] = marker
	}
	return s.callEventLocked(conversationID, call.ID)
}

// callArguments is a copy of a recorded call's arguments; nil when unknown.
func (s *interactiveState) callArguments(conversationID, toolCallID string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	call := s.calls[interactionKey(conversationID, toolCallID)]
	if call == nil {
		return nil
	}
	args := make(map[string]any, len(call.arguments))
	for key, value := range call.arguments {
		args[key] = value
	}
	return args
}

func (s *interactiveState) settleCall(conversationID, toolCallID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if call := s.calls[interactionKey(conversationID, toolCallID)]; call != nil {
		call.settled = true
	}
}

func (s *interactiveState) callIsLive(conversationID, toolCallID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	call := s.calls[interactionKey(conversationID, toolCallID)]
	return call != nil && !call.settled
}

// callEventLocked redraws a recorded call, with the overlay of the interaction
// pending on it.
func (s *interactiveState) callEventLocked(conversationID, toolCallID string) *v2.ChatEvent {
	key := interactionKey(conversationID, toolCallID)
	call := s.calls[key]
	if call == nil {
		return nil
	}
	args := make(map[string]any, len(call.arguments))
	for k, v := range call.arguments {
		args[k] = v
	}
	if pending := s.pending[key]; pending != nil {
		for k, v := range pending.overlay {
			args[k] = v
		}
	}
	return chatEvent(conversationID, v2.ChatEvent_TOOL_CALL, map[string]any{"id": toolCallID, "name": call.name, "arguments": args})
}

func (s *interactiveState) requestPermission(conversationID, sessionID, runID string, request permissionRequest, emit func(*v2.ChatEvent)) []*v2.ChatEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	toolCallID := strings.TrimSpace(request.ToolCallID)
	key := interactionKey(conversationID, toolCallID)
	synthetic := toolCallID == "" || s.calls[key] == nil || s.pending[key] != nil
	if synthetic {
		toolCallID = syntheticPermissionPrefix + request.PermissionID
		key = interactionKey(conversationID, toolCallID)
		args := map[string]any{}
		if request.Command != "" {
			args["command"] = request.Command
		}
		if request.Description != "" {
			args["description"] = request.Description
		}
		name := strings.TrimSpace(request.Tool)
		if name == "" {
			name = "Permission"
		}
		s.calls[key] = &recordedCall{runID: runID, name: name, arguments: args}
	}
	allowAlways := false
	for _, option := range request.Options {
		if option.ID == "allow_always" {
			allowAlways = true
		}
	}
	summary := strings.TrimSpace(strings.Join(nonEmpty(request.Command, request.Description), "\n\n"))
	if summary == "" {
		summary = request.Tool
	}
	overlay := map[string]any{
		argApprovalPending:     true,
		argApprovalSummary:     clampText(summary, approvalTextMax),
		argApprovalAllowAlways: allowAlways,
		argApprovalSessionWide: request.Scope == "session",
	}
	var rules []string
	if request.Suggestion != nil {
		rules = nonEmpty(request.Suggestion.Rules...)
	}
	if len(rules) > 0 {
		overlay[argApprovalScope] = clampText(strings.Join(rules, ", "), approvalScopeMax)
		overlay[argApprovalRules] = clampRules(rules, approvalTextMax)
		overlay[argApprovalDefault] = request.Suggestion.DefaultScope
	} else if request.Rule != "" {
		overlay[argApprovalScope] = clampText(request.Rule, approvalTextMax)
	}
	if preview := request.Preview; preview != nil && (preview.Diff != "" || preview.Truncated) {
		// WebUI shows K-brain's diff rows instead of diffing the call's arguments.
		diff, cut := clampDiffRows(preview.Diff, approvalPreviewMax)
		overlay[argApprovalPreview] = map[string]any{
			"path": preview.Path, "before": "", "after": "", "diff": diff,
			"newFile": preview.NewFile, "truncated": preview.Truncated || cut,
		}
	}
	s.pending[key] = &pendingInteraction{
		kind: "permission", conversationID: conversationID, sessionID: sessionID, runID: runID,
		requestID: request.PermissionID, toolCallID: toolCallID, synthetic: synthetic,
		overlay: overlay, rememberRules: rules, emit: emit,
	}
	return []*v2.ChatEvent{s.callEventLocked(conversationID, toolCallID), statusEvent(conversationID, "Waiting for permission…", false)}
}

func (s *interactiveState) resolvePermission(conversationID, permissionID, decision, reason string) []*v2.ChatEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, pending := range s.pending {
		if pending.kind != "permission" || pending.conversationID != conversationID || pending.requestID != permissionID {
			continue
		}
		delete(s.pending, key)
		out := []*v2.ChatEvent{s.callEventLocked(conversationID, pending.toolCallID)}
		if pending.synthetic {
			out = append(out, syntheticPermissionResult(conversationID, pending.toolCallID, s.calls[key].name, decision, reason))
			delete(s.calls, key)
		}
		return append(out, statusEvent(conversationID, "", false))
	}
	return []*v2.ChatEvent{statusEvent(conversationID, "", false)}
}

func (s *interactiveState) markAutoResolved(conversationID, toolCallID string, marker map[string]any) *v2.ChatEvent {
	key := interactionKey(conversationID, toolCallID)
	s.mu.Lock()
	defer s.mu.Unlock()
	call := s.calls[key]
	if call == nil {
		// The marker can arrive before the call; recordCall applies it.
		s.autoResolved[key] = marker
		return nil
	}
	call.arguments[argAutoResolved] = marker
	return s.callEventLocked(conversationID, toolCallID)
}

func (s *interactiveState) requestQuestion(conversationID, sessionID, runID string, request questionRequest, emit func(*v2.ChatEvent)) []*v2.ChatEvent {
	key := interactionKey(conversationID, request.ToolCallID)
	s.mu.Lock()
	defer s.mu.Unlock()
	questions := make([]any, 0, len(request.Questions))
	for _, raw := range request.Questions {
		var question any
		if json.Unmarshal(raw, &question) == nil {
			questions = append(questions, question)
		}
	}
	args := map[string]any{"questions": questions, argQuestionPending: true}
	if request.DeadlineAt > 0 {
		args[argQuestionDeadline] = request.DeadlineAt
	}
	if existing := s.calls[key]; existing != nil {
		if marker, ok := existing.arguments[argAutoResolved]; ok {
			args[argAutoResolved] = marker
		}
	}
	s.calls[key] = &recordedCall{runID: runID, name: askUserQuestionTool, arguments: args}
	s.pending[interactionKey(conversationID, "question:"+request.ToolCallID)] = &pendingInteraction{
		kind: "question", conversationID: conversationID, sessionID: sessionID, runID: runID,
		requestID: request.QuestionID, toolCallID: request.ToolCallID, emit: emit,
	}
	return []*v2.ChatEvent{s.callEventLocked(conversationID, request.ToolCallID), statusEvent(conversationID, "Waiting for your answer…", false)}
}

func (s *interactiveState) resolveQuestion(conversationID, toolCallID string) []*v2.ChatEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.pending, interactionKey(conversationID, "question:"+toolCallID))
	out := []*v2.ChatEvent{}
	if call := s.calls[interactionKey(conversationID, toolCallID)]; call != nil {
		call.arguments[argQuestionPending] = false
		out = append(out, s.callEventLocked(conversationID, toolCallID))
	}
	return append(out, statusEvent(conversationID, "", false))
}

// finishRun drops what the run left behind and redraws any card still marked
// pending, so WebUI never offers to answer a finished run.
func (s *interactiveState) finishRun(conversationID, runID string) []*v2.ChatEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*v2.ChatEvent
	for key, pending := range s.pending {
		if pending.conversationID != conversationID || pending.runID != runID {
			continue
		}
		delete(s.pending, key)
		if pending.kind == "question" {
			if call := s.calls[interactionKey(conversationID, pending.toolCallID)]; call != nil {
				call.arguments[argQuestionPending] = false
			}
		}
		if chat := s.callEventLocked(conversationID, pending.toolCallID); chat != nil {
			out = append(out, chat)
		}
		if pending.synthetic {
			out = append(out, syntheticPermissionResult(conversationID, pending.toolCallID, s.calls[key].name, "cancelled", ""))
		}
	}
	prefix := conversationID + "\x00"
	for key, call := range s.calls {
		if strings.HasPrefix(key, prefix) && call.runID == runID {
			delete(s.calls, key)
		}
	}
	for key := range s.autoResolved {
		if strings.HasPrefix(key, prefix) {
			delete(s.autoResolved, key)
		}
	}
	return out
}

func (s *interactiveState) lookup(conversationID, toolCallID, kind string) *pendingInteraction {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := interactionKey(conversationID, toolCallID)
	if kind == "question" {
		key = interactionKey(conversationID, "question:"+toolCallID)
	}
	pending := s.pending[key]
	if pending == nil || pending.kind != kind {
		return nil
	}
	copied := *pending
	return &copied
}

// drop forgets an interaction K-brain no longer waits for; it reports whether
// the entry was still the one answered.
func (s *interactiveState) drop(p *pendingInteraction) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := interactionKey(p.conversationID, p.toolCallID)
	if p.kind == "question" {
		key = interactionKey(p.conversationID, "question:"+p.toolCallID)
	}
	if current := s.pending[key]; current != nil && current.requestID == p.requestID {
		delete(s.pending, key)
	}
}

// refuse keeps a permission waiting and redraws it with K-brain's refusal, as
// the desktop does when "allow and remember" cannot store its rules.
func (s *interactiveState) refuse(p *pendingInteraction, notice string) *v2.ChatEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := interactionKey(p.conversationID, p.toolCallID)
	current := s.pending[key]
	if current == nil || current.requestID != p.requestID {
		return nil
	}
	current.overlay[argApprovalNotice] = clampText(notice, approvalTextMax)
	return s.callEventLocked(p.conversationID, p.toolCallID)
}

// AnswerToolApproval forwards a WebUI approval decision to K-brain. requestJSON
// is {"decision":"approve"|"approve_session"|"deny","scope"?,"reason"?}.
func (r *Relay) answerToolApproval(ctx context.Context, conversationID, toolCallID, requestJSON string) QueueResponse {
	pending := r.interactive.lookup(conversationID, toolCallID, "permission")
	if pending == nil {
		return queueError("not_found", "This approval is no longer pending.")
	}
	var answer struct {
		Decision string `json:"decision"`
		Scope    string `json:"scope"`
		Reason   string `json:"reason"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(requestJSON)), &answer); err != nil {
		// Older WebUI builds send the bare decision string.
		if json.Unmarshal([]byte(requestJSON), &answer.Decision) != nil {
			return queueError("invalid_request", "approval decision is invalid")
		}
	}
	decision, scope, reason := "", "", ""
	switch answer.Decision {
	case "approve":
		decision = "allow_once"
	case "approve_session":
		decision = "allow_always"
		scope = strings.TrimSpace(answer.Scope)
		if scope != "session" && scope != "project" && scope != "user" {
			scope = ""
		}
		if scope == "" && len(pending.rememberRules) > 0 {
			scope = "session"
		}
	case "deny":
		decision = "reject"
		reason = clampText(strings.TrimSpace(answer.Reason), approvalTextMax)
	default:
		return queueError("invalid_request", "approval decision is invalid")
	}
	status, message, err := r.client.resolvePermission(ctx, pending.sessionID, pending.requestID, pending.runID, decision, scope, reason)
	switch {
	case err != nil:
		return queueError("kbrain_error", err.Error())
	case status == http.StatusNotFound:
		// Already settled (a session grant or another client answered it).
		r.interactive.drop(pending)
		return QueueResponse{Accepted: true}
	case status == http.StatusBadRequest:
		if chat := r.interactive.refuse(pending, message); chat != nil && pending.emit != nil {
			pending.emit(chat)
		}
		return queueError("rejected", message)
	case status < 200 || status >= 300:
		return queueError("kbrain_error", fmt.Sprintf("kbrain permission answer: %d %s", status, message))
	}
	return QueueResponse{Accepted: true}
}

// answerQuestion forwards WebUI AskUserQuestion answers to K-brain. requestJSON
// is the card's [{questionId, prompt, selectedLabel, custom?}].
func (r *Relay) answerQuestion(ctx context.Context, conversationID, toolCallID, requestJSON string) QueueResponse {
	pending := r.interactive.lookup(conversationID, toolCallID, "question")
	if pending == nil {
		return queueError("not_found", "This question is no longer pending.")
	}
	var answers []struct {
		QuestionID     string   `json:"questionId"`
		Prompt         string   `json:"prompt"`
		SelectedLabel  string   `json:"selectedLabel"`
		SelectedLabels []string `json:"selectedLabels"`
		Custom         bool     `json:"custom"`
	}
	if err := json.Unmarshal([]byte(requestJSON), &answers); err != nil || len(answers) == 0 {
		return queueError("invalid_request", "question answers are invalid")
	}
	out := make([]map[string]any, 0, len(answers))
	for _, answer := range answers {
		item := map[string]any{"question_id": answer.QuestionID, "selected_label": answer.SelectedLabel}
		if answer.Prompt != "" {
			item["prompt"] = answer.Prompt
		}
		// K-brain takes one label per answer: several picks of a multi-select
		// question arrive as their joined labels, which it only accepts as custom.
		if answer.Custom || len(answer.SelectedLabels) > 1 {
			item["custom"] = true
		}
		out = append(out, item)
	}
	status, message, err := r.client.postInteraction(ctx, "/v1/sessions/"+url.PathEscape(pending.sessionID)+"/questions/"+url.PathEscape(pending.requestID), map[string]any{
		"conversation_id": pending.sessionID, "question_id": pending.requestID, "run_id": pending.runID, "answers": out,
	})
	switch {
	case err != nil:
		return queueError("kbrain_error", err.Error())
	case status == http.StatusNotFound || status == http.StatusConflict:
		r.interactive.drop(pending)
		return queueError("not_found", "This question is no longer pending.")
	case status < 200 || status >= 300:
		return queueError("rejected", message)
	}
	return QueueResponse{Accepted: true}
}

func (c *Client) resolvePermission(ctx context.Context, sessionID, permissionID, runID, decision, scope, reason string) (int, string, error) {
	body := map[string]any{"permission_id": permissionID, "decision": decision}
	if scope != "" {
		body["scope"] = scope
	}
	if reason != "" {
		body["reason"] = reason
	}
	return c.postInteraction(ctx, "/v1/sessions/"+url.PathEscape(sessionID)+"/permissions/"+url.PathEscape(permissionID), map[string]any{
		"conversation_id": sessionID, "run_id": runID, "decision": body,
	})
}

func (c *Client) resolveClientTool(ctx context.Context, sessionID, callID, runID, text string) error {
	_, _, err := c.postInteraction(ctx, "/v1/sessions/"+url.PathEscape(sessionID)+"/client-tools/"+url.PathEscape(callID), map[string]any{
		"conversation_id": sessionID, "run_id": runID, "text": text, "is_error": true,
	})
	return err
}

// postInteraction posts an answer and returns K-brain's status with its error
// text, so callers can tell a settled request (404) from a refused one (400).
func (c *Client) postInteraction(ctx context.Context, path string, input any) (int, string, error) {
	resp, err := c.request(ctx, http.MethodPost, path, input, nil)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp.StatusCode, "", nil
	}
	var failure struct {
		Error string `json:"error"`
	}
	message := resp.Status
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&failure) == nil && strings.TrimSpace(failure.Error) != "" {
		message = strings.TrimSpace(failure.Error)
	}
	return resp.StatusCode, message, nil
}

func subagentEvents(conversationID string, payload json.RawMessage) []*v2.ChatEvent {
	var body struct {
		Subagent *subagentPayload `json:"subagent"`
	}
	var subagent *subagentPayload
	if json.Unmarshal(payload, &body) == nil && body.Subagent != nil {
		subagent = body.Subagent
	} else {
		var flat subagentPayload
		if json.Unmarshal(payload, &flat) == nil {
			subagent = &flat
		}
	}
	if subagent == nil || strings.TrimSpace(subagent.ID) == "" {
		return nil
	}
	// Same projection as the desktop (runKBrainConversationTurn onSubagent): one
	// "subagent" tool card per task, settled by its report.
	id := subagentCallPrefix + subagent.ID
	out := []*v2.ChatEvent{chatEvent(conversationID, v2.ChatEvent_TOOL_CALL, map[string]any{"id": id, "name": "subagent", "arguments": map[string]any{
		"id": subagent.ID, "description": subagent.Description, "status": subagent.Status, "model": subagent.Model,
	}})}
	switch subagent.Status {
	case "done", "completed", "error", "failed", "cancelled":
		text := subagent.Status
		if subagent.Error != "" {
			text = subagent.Error
		} else if subagent.Report != "" {
			text = subagent.Report
		}
		out = append(out, chatEvent(conversationID, v2.ChatEvent_TOOL_RESULT, map[string]any{
			"id": id, "name": "subagent", "content": []any{map[string]any{"type": "text", "text": text}},
			"isError": subagent.Status != "done" && subagent.Status != "completed",
		}))
	}
	return out
}

type subagentPayload struct {
	ID          string   `json:"id"`
	Description string   `json:"description"`
	Status      string   `json:"status"`
	Model       ModelRef `json:"model"`
	Report      string   `json:"report"`
	Error       string   `json:"error"`
}

func syntheticPermissionResult(conversationID, toolCallID, name, decision, reason string) *v2.ChatEvent {
	text := "Allowed"
	isError := false
	switch decision {
	case "reject":
		text, isError = "Rejected", true
		if reason != "" {
			text += ": " + reason
		}
	case "cancelled":
		text, isError = "Cancelled", true
	}
	return chatEvent(conversationID, v2.ChatEvent_TOOL_RESULT, map[string]any{
		"id": toolCallID, "name": name, "content": []any{map[string]any{"type": "text", "text": text}}, "isError": isError,
	})
}

func chatEvent(conversationID string, kind v2.ChatEvent_ChatEventType, payload map[string]any) *v2.ChatEvent {
	data, _ := json.Marshal(payload)
	return &v2.ChatEvent{Type: kind, ConversationId: conversationID, Data: string(data)}
}

// statusEvent sets the run status line; an empty text clears it.
func statusEvent(conversationID, text string, compaction bool) *v2.ChatEvent {
	payload := map[string]any{"status": nil}
	if text != "" {
		payload["status"] = text
		if compaction {
			payload["isCompaction"] = true
		}
	}
	return chatEvent(conversationID, v2.ChatEvent_TOOL_STATUS, payload)
}

func isSyntheticArg(key string) bool {
	for _, prefix := range syntheticArgPrefixes {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

func nonEmpty(values ...string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			out = append(out, value)
		}
	}
	return out
}

// clampDiffRows cuts diff rows to max bytes at a row boundary.
func clampDiffRows(diff string, max int) (string, bool) {
	if len(diff) <= max {
		return diff, false
	}
	end := strings.LastIndexByte(diff[:max], '\n')
	if end <= 0 {
		end = max
		for end > 0 && !utf8.RuneStart(diff[end]) {
			end--
		}
	}
	return diff[:end], true
}

func clampText(text string, max int) string {
	if utf8.RuneCountInString(text) <= max {
		return text
	}
	runes := []rune(text)
	return string(runes[:max-1]) + "…"
}

// clampRules keeps whole rules within max characters in all.
func clampRules(rules []string, max int) []string {
	out := []string{}
	total := 0
	for _, rule := range rules {
		size := utf8.RuneCountInString(rule)
		if total+size > max {
			if len(out) == 0 {
				out = append(out, clampText(rule, max))
			}
			break
		}
		out = append(out, rule)
		total += size
	}
	return out
}

// resultDetails is the question card's details for a question or
// AskUserQuestion result; nil for other tools.
func resultDetails(name, output string, args map[string]any, isError bool) map[string]any {
	if name == kbrainQuestionTool {
		return questionToolResultDetails(args, output, isError)
	}
	return questionResultDetails(name, output)
}

// questionResultDetails turns K-brain's AskUserQuestion result text into the
// tool-result details the WebUI question card reads to show the chosen answers
// (the desktop does the same in crates/agent-gui/src/lib/kbrain/questions.ts).
func questionResultDetails(name, output string) map[string]any {
	if name != askUserQuestionTool {
		return nil
	}
	start := strings.IndexByte(output, '{')
	if start < 0 {
		return nil
	}
	var result struct {
		Kind      string `json:"kind"`
		Questions []any  `json:"questions"`
		Answers   []struct {
			QuestionID    string `json:"question_id"`
			Prompt        string `json:"prompt"`
			SelectedLabel string `json:"selected_label"`
			Custom        bool   `json:"custom"`
		} `json:"answers"`
		TimedOut  bool `json:"timed_out"`
		Cancelled bool `json:"cancelled"`
	}
	if json.Unmarshal([]byte(output[start:]), &result) != nil || result.Kind != "ask_user_question" || result.Questions == nil || result.Answers == nil {
		return nil
	}
	answers := make([]any, 0, len(result.Answers))
	for _, answer := range result.Answers {
		item := map[string]any{"questionId": answer.QuestionID, "prompt": answer.Prompt, "selectedLabel": answer.SelectedLabel}
		if answer.Custom {
			item["custom"] = true
		}
		answers = append(answers, item)
	}
	return map[string]any{"kind": "ask_user_question", "questions": result.Questions, "answers": answers, "timedOut": result.TimedOut, "cancelled": result.Cancelled}
}

func historyText(message Message) string {
	var text strings.Builder
	for _, block := range message.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}
	return text.String()
}
