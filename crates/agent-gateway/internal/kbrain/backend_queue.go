package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func (r *Relay) backendQueueProjection(conversationID string, out backendQueueResponse) QueueResponse {
	// Gateway persists transport identities, not a second executable queue.
	r.mu.Lock()
	aliases := map[string]string{}
	for _, binding := range r.backendRuns {
		if binding.SessionID == out.Snapshot.ConversationID && binding.ItemID != "" {
			aliases[binding.ItemID] = binding.GatewayRunID
		}
	}
	r.mu.Unlock()
	out.Snapshot.Items = append([]backendQueueItem{}, out.Snapshot.Items...)
	for i := range out.Snapshot.Items {
		if alias := aliases[out.Snapshot.Items[i].ID]; alias != "" {
			out.Snapshot.Items[i].ID = alias
		}
	}
	if out.Item != nil {
		item := *out.Item
		out.Item = &item
		if alias := aliases[out.Item.ID]; alias != "" {
			out.Item.ID = alias
		}
	}
	out.Snapshot.ConversationID = conversationID
	data, _ := json.Marshal(out.Snapshot)
	result := QueueResponse{Accepted: out.Accepted, ErrorCode: out.ErrorCode, Message: out.Message, Revision: out.Snapshot.Revision, SnapshotJSON: string(data)}
	if out.Item != nil {
		item, _ := json.Marshal(out.Item)
		result.ItemJSON = string(item)
	}
	return result
}

func (r *Relay) emitBackendQueue(cb Callbacks, out backendQueueResponse) {
	// Reloaded WebUI pages restore canonical backend IDs while live pages may
	// still use durable Gateway aliases. Publish the same revision to both.
	ids := map[string]bool{out.Snapshot.ConversationID: true}
	r.mu.Lock()
	for alias, sessionID := range r.sessions {
		if sessionID == out.Snapshot.ConversationID {
			ids[alias] = true
		}
	}
	r.mu.Unlock()
	for id := range ids {
		r.emitQueue(cb, id, r.backendQueueProjection(id, out))
	}
}

func (r *Relay) startBackendQueuedRun(ctx context.Context, gatewayRunID, conversationID, requestID, cwd string, prompt PromptRequest, policy string, cb Callbacks) (bool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if strings.TrimSpace(gatewayRunID) == "" || strings.TrimSpace(conversationID) == "" || strings.TrimSpace(requestID) == "" || strings.TrimSpace(prompt.Prompt) == "" {
		return false, errors.New("queue run identity and prompt are required")
	}
	if policy == "" || policy == "auto" {
		policy = "append"
	}
	if policy != "append" && policy != "interrupt" {
		return false, errors.New("invalid queue policy")
	}
	if prompt.Model == nil || prompt.Model.Model == "" {
		model := r.defaultModel
		prompt.Model = &model
	}
	// Verify the handshake before any backend write or persisted binding, so a
	// refused backend leaves no session or recovery record behind.
	mode := ""
	if prompt.Options != nil {
		mode = prompt.Options.PermissionMode
	}
	if err := r.client.requireHandshake(ctx, mode); err != nil {
		return false, err
	}
	prompt = r.client.withReviewScope(ctx, prompt)
	// Serialize session mapping before the backend acceptance; no local FIFO is created.
	r.backendSubmitMu.Lock()
	defer r.backendSubmitMu.Unlock()
	sessionID, err := r.session(ctx, conversationID, prompt.Model, cwd)
	if err != nil {
		return false, err
	}
	prompt.ConversationID = sessionID
	prompt.ClientRequestID = requestID
	r.mu.Lock()
	key := conversationKey(conversationID, requestID)
	previous, exists := r.backendRuns[key]
	binding := previous
	if !exists {
		binding = backendQueueRun{GatewayRunID: gatewayRunID, ConversationID: conversationID, SessionID: sessionID, ClientRequestID: requestID}
		r.backendRuns[key] = binding
	}
	if err = r.persistQueueLocked(); err != nil {
		if !exists {
			delete(r.backendRuns, key)
		}
		r.mu.Unlock()
		return false, err
	}
	r.mu.Unlock()
	out, err := r.client.sessionQueue(ctx, http.MethodPost, sessionID, "", map[string]any{"request": prompt, "policy": policy, "source": "webui"})
	// A definitive rejection creates no backend work. Ambiguous transport/server
	// failures retain the binding so recovery can attach without resubmitting.
	if !exists && (out.httpStatus >= 400 && out.httpStatus < 500 || err == nil && !out.Accepted) {
		r.mu.Lock()
		delete(r.backendRuns, key)
		persistErr := r.persistQueueLocked()
		r.mu.Unlock()
		if persistErr != nil {
			return false, persistErr
		}
	}
	if err != nil {
		return false, err
	}
	if !out.Accepted || out.Receipt == nil {
		return false, fmt.Errorf("kbrain queue rejected: %s", out.Message)
	}
	r.mu.Lock()
	current, pending := r.backendRuns[key]
	if !pending {
		// A concurrent reader may already have observed the terminal event.
		r.mu.Unlock()
		return true, nil
	}
	binding = current
	binding.ItemID = out.Receipt.ID
	r.backendRuns[key] = binding
	err = r.persistQueueLocked()
	r.mu.Unlock()
	if err != nil {
		return false, err
	}
	r.emitBackendQueue(cb, out)
	r.watchBackendQueuedRun(binding, cb)
	return true, nil
}

func (r *Relay) backendQueueAction(ctx context.Context, req *gatewayv2.ChatQueueRequest, callbacks ...Callbacks) QueueResponse {
	if req == nil || strings.TrimSpace(req.GetConversationId()) == "" {
		return queueError("invalid_request", "conversation_id is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	conversationID := req.GetConversationId()
	r.mu.Lock()
	sessionID := r.sessions[conversationID]
	itemID := req.GetItemId()
	for _, binding := range r.backendRuns {
		if (binding.ConversationID == conversationID || binding.SessionID == conversationID || binding.SessionID == sessionID) && binding.GatewayRunID == itemID {
			itemID = binding.ItemID
			break
		}
	}
	r.mu.Unlock()
	if sessionID == "" {
		// A restored page may address the canonical session before history GET
		// has established its alias. A successful backend read validates it.
		if _, err := r.client.sessionQueue(ctx, http.MethodGet, conversationID, "", nil); err != nil {
			return queueError("not_found", err.Error())
		}
		sessionID = conversationID
		r.mu.Lock()
		r.sessions[conversationID] = sessionID
		err := r.persistQueueLocked()
		r.mu.Unlock()
		if err != nil {
			return queueError("persistence_error", err.Error())
		}
	}
	action := req.GetAction()
	switch action {
	case "inspect":
		action = "get"
	case "reorder":
		action = "move"
	case "delete":
		action = "remove"
	case "edit":
		action = "edit_commit"
	}
	var out backendQueueResponse
	var err error
	if action == "get" {
		out, err = r.client.sessionQueue(ctx, http.MethodGet, sessionID, "", nil)
	} else {
		// Older WebUI actions omit revision except edit_commit. Resolve their
		// revision once; the backend still rejects a concurrent mutation.
		revision := req.GetRevision()
		if revision == 0 && action != "edit_commit" && action != "pause" && action != "resume" {
			current, readErr := r.client.sessionQueue(ctx, http.MethodGet, sessionID, "", nil)
			if readErr != nil {
				return queueError("backend_error", readErr.Error())
			}
			revision = current.Snapshot.Revision
		}
		input := map[string]any{"action": action, "item_id": itemID, "revision": req.GetRevision(), "direction": req.GetDirection()}
		input["revision"] = revision
		if action == "edit_commit" {
			detail, readErr := r.client.sessionQueue(ctx, http.MethodPost, sessionID, "/actions", map[string]any{"action": "get_item", "item_id": itemID})
			if readErr != nil {
				return queueError("backend_error", readErr.Error())
			}
			if !detail.Accepted || detail.Item == nil || detail.Item.Request == nil {
				return queueError("not_found", "queue edit not found")
			}
			prompt, draft, uploads, editErr := editedPrompt(req.GetDraftJson(), req.GetUploadedFilesJson(), detail.Item.Request.Prompt)
			if editErr != nil {
				return queueError("invalid_payload", editErr.Error())
			}
			request := *detail.Item.Request
			request.Prompt = prompt
			if !strings.HasPrefix(strings.TrimSpace(prompt), "/") {
				request.PromptCommand = false
			}
			input["request"], input["draft_json"], input["uploaded_files_json"] = request, draft, uploads
		}
		if queueActionAdvancesWork(action) {
			if err := r.client.requireHandshake(ctx, ""); err != nil {
				return queueError("backend_error", err.Error())
			}
		}
		out, err = r.client.sessionQueue(ctx, http.MethodPost, sessionID, "/actions", input)
	}
	if err != nil {
		return queueError("backend_error", err.Error())
	}
	result := r.backendQueueProjection(conversationID, out)
	if len(callbacks) > 0 && out.Accepted {
		r.emitBackendQueue(callbacks[0], out)
		if action == "get" {
			r.mu.Lock()
			var bindings []backendQueueRun
			for _, binding := range r.backendRuns {
				if binding.SessionID == sessionID {
					bindings = append(bindings, binding)
				}
			}
			r.mu.Unlock()
			for _, binding := range bindings {
				r.watchBackendQueuedRun(binding, callbacks[0])
			}
		}
	}
	return result
}

// queueActionAdvancesWork reports queue actions that hand new or changed work
// to the backend. Actions that stop or inspect work (remove, pause, edit
// begin/cancel, get_item) stay available when the handshake is broken so users
// can still halt what the backend would otherwise run.
func queueActionAdvancesWork(action string) bool {
	switch action {
	case "remove", "pause", "edit_begin", "edit_cancel", "get_item":
		return false
	}
	return true
}

func (r *Relay) cancelBackendQueuedRun(ctx context.Context, conversationID, gatewayRunID string) (bool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	r.mu.Lock()
	var candidates []backendQueueRun
	for _, run := range r.backendRuns {
		if (run.ConversationID == conversationID || run.SessionID == conversationID || run.SessionID == r.sessions[conversationID]) && (gatewayRunID == "" || run.GatewayRunID == gatewayRunID) {
			candidates = append(candidates, run)
		}
	}
	r.mu.Unlock()
	if len(candidates) == 0 {
		return false, nil
	}
	var binding backendQueueRun
	var out backendQueueResponse
	var err error
	for _, candidate := range candidates {
		out, err = r.client.sessionQueue(ctx, http.MethodGet, candidate.SessionID, "?client_request_id="+url.QueryEscape(candidate.ClientRequestID), nil)
		if err != nil {
			return false, err
		}
		if gatewayRunID != "" || out.Receipt != nil && out.Receipt.State == "running" {
			binding = candidate
			break
		}
	}
	if binding.SessionID == "" {
		return false, nil
	}
	if out.Receipt == nil {
		return false, errors.New("queue receipt missing")
	}
	if out.Receipt.Run != nil {
		return true, r.client.CancelRun(ctx, binding.SessionID, out.Receipt.Run.RunID)
	}
	if out.Receipt.State == "cancelled" {
		return true, nil
	}
	result, err := r.client.sessionQueue(ctx, http.MethodPost, binding.SessionID, "/actions", map[string]any{"action": "remove", "item_id": out.Receipt.ID, "revision": out.Snapshot.Revision})
	if err != nil {
		return false, err
	}
	if !result.Accepted {
		return false, fmt.Errorf("queue cancellation: %s", result.Message)
	}
	return true, nil
}

func (r *Relay) watchBackendQueuedRun(binding backendQueueRun, cb Callbacks) {
	key := conversationKey(binding.ConversationID, binding.ClientRequestID)
	r.mu.Lock()
	if r.backendContext.Err() != nil {
		r.mu.Unlock()
		return
	}
	if r.backendWatching[key] {
		r.mu.Unlock()
		return
	}
	r.backendWatching[key] = true
	r.backendWorkers.Add(1)
	r.mu.Unlock()
	go func() {
		defer r.backendWorkers.Done()
		defer func() { r.mu.Lock(); delete(r.backendWatching, key); r.mu.Unlock() }()
		ctx, cancel := context.WithCancel(r.backendContext)
		defer cancel()
		finish := func(status, message string) {
			r.mu.Lock()
			delete(r.backendRuns, key)
			persistErr := r.persistQueueLocked()
			r.mu.Unlock()
			if persistErr != nil {
				message = persistErr.Error()
				status = "failed"
			}
			r.emitTerminal(binding.GatewayRunID, binding.ConversationID, cb, status, "", message)
		}
		for {
			out, err := r.client.sessionQueue(ctx, http.MethodGet, binding.SessionID, "?client_request_id="+url.QueryEscape(binding.ClientRequestID), nil)
			if err != nil {
				if ctx.Err() == nil {
					r.emitTerminal(binding.GatewayRunID, binding.ConversationID, cb, "failed", "queue_recovery_required", err.Error())
				}
				return
			}
			if out.Receipt == nil {
				r.emitTerminal(binding.GatewayRunID, binding.ConversationID, cb, "failed", "queue_recovery_required", "backend queue receipt is missing")
				return
			}
			r.emitBackendQueue(cb, out)
			if out.Receipt.State == "cancelled" || out.Receipt.State == "failed" || out.Receipt.State == "interrupted" {
				status := out.Receipt.State
				if status == "interrupted" {
					status = "failed"
				}
				finish(status, out.Receipt.Error)
				return
			}
			if out.Receipt.Run != nil {
				run := out.Receipt.Run
				if run.ConversationID != binding.SessionID || run.RunID == "" || run.AcceptedSeq < 1 {
					finish("failed", "invalid queued run identity")
					return
				}
				if binding.Run == nil {
					binding.Run = run
					binding.LastSeq = run.AcceptedSeq - 1
				}
				for {
					terminal := false
					err = r.client.EventsForRun(ctx, binding.SessionID, binding.LastSeq, run.RunID, func(event Event) error {
						if event.ConversationID != binding.SessionID {
							return errors.New("queue event identity mismatch")
						}
						if event.Seq <= binding.LastSeq {
							return nil
						}
						if event.Seq != binding.LastSeq+1 {
							return errors.New("queue event sequence gap")
						}
						if event.Type == "queue.updated" {
							var snapshot backendQueueSnapshot
							if err := json.Unmarshal(event.Payload, &snapshot); err != nil {
								return err
							}
							if snapshot.ConversationID != binding.SessionID {
								return errors.New("queue snapshot identity mismatch")
							}
							r.emitBackendQueue(cb, backendQueueResponse{Accepted: true, Snapshot: snapshot})
						}
						if event.RunID == run.RunID {
							if event.Type == "permission.requested" {
								if err := r.client.rejectUnsupportedPermission(ctx, event); err != nil {
									return err
								}
							}
							mapped := event
							mapped.ConversationID = binding.ConversationID
							chat, control, mapErr := ToChatEvent(mapped)
							if mapErr != nil {
								return mapErr
							}
							if chat != nil && cb.OnEvent != nil {
								cb.OnEvent(binding.GatewayRunID, chat)
							}
							if control != nil {
								control.RequestId = binding.GatewayRunID
								if isRunTerminal(event, run.RunID) {
									terminal = true
									finish(control.Type, control.Message)
								} else {
									r.emitControl(binding.GatewayRunID, cb, control)
								}
							}
						}
						binding.LastSeq = event.Seq
						if !terminal {
							r.mu.Lock()
							// The POST acknowledgement may fill ItemID after the reader
							// started. Preserve it when advancing the stream cursor.
							if current, ok := r.backendRuns[key]; ok && binding.ItemID == "" {
								binding.ItemID = current.ItemID
							}
							r.backendRuns[key] = binding
							persistErr := r.persistQueueLocked()
							r.mu.Unlock()
							if persistErr != nil {
								return persistErr
							}
						}
						return nil
					})
					if terminal || ctx.Err() != nil {
						return
					}
					if err != nil && !retryableEventStreamError(err) {
						r.emitTerminal(binding.GatewayRunID, binding.ConversationID, cb, "failed", "queue_recovery_required", err.Error())
						return
					}
					select {
					case <-ctx.Done():
						return
					case <-time.After(100 * time.Millisecond):
					}
				}
			}
			_, err = r.client.sessionQueue(ctx, http.MethodGet, binding.SessionID, fmt.Sprintf("?wait=1&after_revision=%d", out.Snapshot.Revision), nil)
			if err != nil {
				if ctx.Err() == nil {
					r.emitTerminal(binding.GatewayRunID, binding.ConversationID, cb, "failed", "queue_recovery_required", err.Error())
				}
				return
			}
		}
	}()
}

// Close stops transport readers without cancelling backend-owned work.
func (r *Relay) Close() { r.mu.Lock(); r.backendCancel(); r.mu.Unlock(); r.backendWorkers.Wait() }
