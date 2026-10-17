package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

type queueSnapshot struct {
	ConversationID string        `json:"conversationId"`
	Revision       uint64        `json:"revision"`
	Items          []queueItem   `json:"items"`
	Current        *queueCurrent `json:"current,omitempty"`
}

type queueItem struct {
	ID                string `json:"id"`
	PreviewText       string `json:"previewText"`
	FileCount         int    `json:"fileCount"`
	CreatedAt         int64  `json:"createdAt"`
	Source            string `json:"source"`
	Editable          bool   `json:"editable"`
	DraftJSON         string `json:"draftJson,omitempty"`
	UploadedFilesJSON string `json:"uploadedFilesJson,omitempty"`
}

// Queue handles the shipped chat_queue contract for remote K-brain targets.
// K-brain owns execution and its event journal; Gateway persists queue identity,
// CAS revisions, and only accepted run cursors needed for restart recovery.
func (r *Relay) Queue(ctx context.Context, req *gatewayv2.ChatQueueRequest, callbacks ...Callbacks) (response QueueResponse) {
	mutating := false
	var afterCommit func()
	var rollbackRun func()
	defer func() {
		if response.Accepted && afterCommit != nil {
			afterCommit()
		}
	}()
	if len(callbacks) > 0 && callbacks[0].OnQueue != nil {
		defer func() {
			if !mutating || !response.Accepted || response.SnapshotJSON == "" {
				return
			}
			var snapshot queueSnapshot
			if json.Unmarshal([]byte(response.SnapshotJSON), &snapshot) == nil {
				callbacks[0].OnQueue(snapshot.ConversationID, response.SnapshotJSON, snapshot.Revision)
			}
		}()
	}
	if req == nil {
		return queueError("invalid_request", "chat queue request is required")
	}
	conversationID := strings.TrimSpace(req.GetConversationId())
	if conversationID == "" {
		return queueError("invalid_request", "conversation_id is required")
	}
	action := strings.TrimSpace(req.GetAction())
	if action == "inspect" {
		action = "get"
	}
	if action == "reorder" {
		action = "move"
	}
	if action == "edit" {
		action = "edit_commit"
	}
	if action == "delete" {
		action = "remove"
	}
	mutating = action == "move" || action == "remove" || action == "run_now" || action == "edit_begin" || action == "edit_commit" || action == "edit_cancel"
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ctx.Done():
		return queueError("cancelled", ctx.Err().Error())
	default:
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if len(callbacks) > 0 {
		r.attachCallbacksLocked(conversationID, callbacks[0])
	}
	before := r.queueStateCopyLocked()
	defer func() {
		if !mutating || !response.Accepted {
			return
		}
		if err := r.persistQueueLocked(); err != nil {
			r.restoreQueueStateLocked(before)
			if rollbackRun != nil {
				rollbackRun()
			}
			response = queueError("persistence_error", err.Error())
		}
	}()
	items := r.queues[conversationID]
	currentRevision := r.queueRevisions[conversationID]
	if action != "get" && action != "get_item" && strings.TrimSpace(req.GetItemId()) != "" && strings.TrimSpace(req.GetItemId()) == r.activeRuns[conversationID] {
		return queueError("active", "active run cannot be edited or deleted")
	}
	if action == "get" {
		return r.queueResponseLocked(conversationID, items, currentRevision, "", nil)
	}
	if action == "get_item" {
		index := queueIndex(items, req.GetItemId())
		if index < 0 {
			return queueError("not_found", "queued item not found")
		}
		return r.queueResponseLocked(conversationID, items, currentRevision, "", &items[index])
	}
	if action == "edit_begin" {
		index := queueIndex(items, req.GetItemId())
		if index < 0 {
			return queueError("not_found", "queued item not found")
		}
		item := items[index]
		key := conversationID + "\x00" + item.RunID
		if _, exists := r.queueEdits[key]; exists {
			return queueError("conflict", "queued item is already being edited")
		}
		remaining := append([]queuedRun(nil), items[:index]...)
		remaining = append(remaining, items[index+1:]...)
		r.queues[conversationID] = remaining
		newRevision := r.bumpQueueRevisionLocked(conversationID)
		r.queueEdits[key] = queueEdit{Item: item, ConversationID: conversationID, Index: index, Revision: newRevision}
		return r.queueResponseLocked(conversationID, r.queues[conversationID], newRevision, "", &item)
	}
	// Restoring an edit can happen after the previous active run has finished.
	// Reserve the oldest queued run while locked, but dispatch only after the
	// updated queue state has been persisted successfully.
	restoreEditedRun := func(edited queueEdit) QueueResponse {
		queued := r.queues[conversationID]
		index := edited.Index
		if index > len(queued) {
			index = len(queued)
		}
		queued = insertQueueItem(queued, index, edited.Item)
		r.queues[conversationID] = queued
		if r.activeRuns[conversationID] == "" {
			next := queued[0]
			r.queues[conversationID] = queued[1:]
			state, runCtx := r.newRunLocked(context.Background(), next.RunID, conversationID, next.ClientRequestID, next.Callbacks)
			r.activeRuns[conversationID] = next.RunID
			rollbackRun = func() {
				state.cancel()
				delete(r.runs, next.RunID)
				delete(r.activeRuns, conversationID)
			}
			afterCommit = func() { go r.execute(runCtx, state, next.CWD, next.Prompt) }
		}
		newRevision := r.bumpQueueRevisionLocked(conversationID)
		return r.queueResponseLocked(conversationID, r.queues[conversationID], newRevision, "", nil)
	}
	if action == "edit_cancel" {
		key := conversationID + "\x00" + strings.TrimSpace(req.GetItemId())
		edited, ok := r.queueEdits[key]
		if !ok {
			return queueError("not_found", "queued edit session not found")
		}
		delete(r.queueEdits, key)
		return restoreEditedRun(edited)
	}
	if action == "edit_commit" {
		key := conversationID + "\x00" + strings.TrimSpace(req.GetItemId())
		edited, ok := r.queueEdits[key]
		if !ok {
			return queueError("not_found", "queued edit session not found")
		}
		if req.GetRevision() == 0 || req.GetRevision() != edited.Revision || currentRevision != edited.Revision {
			return r.queueConflictLocked(conversationID, r.queues[conversationID], currentRevision)
		}
		prompt, draft, uploads, err := editedPrompt(req.GetDraftJson(), req.GetUploadedFilesJson(), edited.Item.Prompt.Prompt)
		if err != nil {
			return queueError("invalid_payload", err.Error())
		}
		edited.Item.Prompt.Prompt = prompt
		edited.Item.Prompt.ClientRequestID = edited.Item.ClientRequestID
		edited.Item.DraftJSON, edited.Item.UploadedFilesJSON = draft, uploads
		delete(r.queueEdits, key)
		return restoreEditedRun(edited)
	}
	if strings.TrimSpace(req.GetItemId()) == r.activeRuns[conversationID] {
		return queueError("active", "active run cannot be edited or deleted")
	}
	index := queueIndex(items, req.GetItemId())
	if index < 0 {
		return queueError("not_found", "queued item not found")
	}
	if req.GetRevision() != 0 && req.GetRevision() != currentRevision {
		return r.queueConflictLocked(conversationID, items, currentRevision)
	}
	switch action {
	case "move":
		direction := strings.TrimSpace(req.GetDirection())
		if direction != "up" && direction != "down" {
			return queueError("invalid_request", "direction must be up or down")
		}
		swap := index - 1
		if direction == "down" {
			swap = index + 1
		}
		if swap < 0 || swap >= len(items) {
			return r.queueResponseLocked(conversationID, items, currentRevision, "queued item is already at the edge", nil)
		}
		items[index], items[swap] = items[swap], items[index]
		newRevision := r.bumpQueueRevisionLocked(conversationID)
		return r.queueResponseLocked(conversationID, items, newRevision, "", nil)
	case "remove":
		item := items[index]
		r.queues[conversationID] = append(items[:index], items[index+1:]...)
		if item.ClientRequestID != "" {
			delete(r.dedupe, conversationKey(conversationID, item.ClientRequestID))
		}
		newRevision := r.bumpQueueRevisionLocked(conversationID)
		response := r.queueResponseLocked(conversationID, r.queues[conversationID], newRevision, "", nil)
		afterCommit = func() {
			r.emitTerminal(item.RunID, conversationID, item.Callbacks, "cancelled", "", "queued run cancelled")
		}
		return response
	case "run_now":
		item := items[index]
		r.queues[conversationID] = append(items[:index], items[index+1:]...)
		if activeID := r.activeRuns[conversationID]; activeID != "" {
			// Keep the active owner until its canonical terminal releases the queue.
			r.queues[conversationID] = insertQueueItem(r.queues[conversationID], 0, item)
			newRevision := r.bumpQueueRevisionLocked(conversationID)
			if active := r.runs[activeID]; active != nil {
				wasRequested := active.cancelRequested
				active.cancelRequested = true
				rollbackRun = func() { active.cancelRequested = wasRequested }
				afterCommit = func() { r.requestCancel(context.Background(), active) }
			}
			return r.queueResponseLocked(conversationID, r.queues[conversationID], newRevision, "", nil)
		}
		state, runCtx := r.newRunLocked(context.Background(), item.RunID, conversationID, item.ClientRequestID, item.Callbacks)
		r.activeRuns[conversationID] = item.RunID
		newRevision := r.bumpQueueRevisionLocked(conversationID)
		response := r.queueResponseLocked(conversationID, r.queues[conversationID], newRevision, "", nil)
		rollbackRun = func() {
			state.cancel()
			delete(r.runs, item.RunID)
			delete(r.activeRuns, conversationID)
		}
		afterCommit = func() { go r.execute(runCtx, state, item.CWD, item.Prompt) }
		return response
	default:
		return queueError("unsupported_action", fmt.Sprintf("unsupported chat queue action: %s", action))
	}
}

func (r *Relay) bumpQueueRevisionLocked(conversationID string) uint64 {
	r.queueRevisions[conversationID]++
	return r.queueRevisions[conversationID]
}

func (r *Relay) queueResponseLocked(conversationID string, items []queuedRun, revision uint64, message string, detail *queuedRun) QueueResponse {
	snapshot := queueSnapshot{ConversationID: conversationID, Revision: revision, Items: make([]queueItem, 0, len(items))}
	for _, item := range items {
		snapshot.Items = append(snapshot.Items, queueItemFor(item, false))
	}
	snapshot.Current = r.queueCurrentLocked(conversationID)
	snapshotJSON, _ := json.Marshal(snapshot)
	response := QueueResponse{Accepted: true, Message: message, SnapshotJSON: string(snapshotJSON), Revision: revision}
	if detail != nil {
		detailJSON, _ := json.Marshal(queueItemFor(*detail, true))
		response.ItemJSON = string(detailJSON)
	}
	return response
}

func (r *Relay) queueConflictLocked(conversationID string, items []queuedRun, revision uint64) QueueResponse {
	response := r.queueResponseLocked(conversationID, items, revision, "queued revision conflict", nil)
	response.Accepted, response.ErrorCode = false, "conflict"
	return response
}

func queueError(code, message string) QueueResponse {
	return QueueResponse{Accepted: false, ErrorCode: code, Message: message}
}

func queueIndex(items []queuedRun, id string) int {
	id = strings.TrimSpace(id)
	for i := range items {
		if items[i].RunID == id {
			return i
		}
	}
	return -1
}

func insertQueueItem(items []queuedRun, index int, item queuedRun) []queuedRun {
	if index < 0 {
		index = 0
	}
	if index > len(items) {
		index = len(items)
	}
	items = append(items, queuedRun{})
	copy(items[index+1:], items[index:])
	items[index] = item
	return items
}

func queueItemFor(item queuedRun, detail bool) queueItem {
	out := queueItem{ID: item.RunID, PreviewText: item.Prompt.Prompt, CreatedAt: item.CreatedAt, Source: "webui", Editable: true}
	if detail {
		out.DraftJSON, out.UploadedFilesJSON = item.DraftJSON, item.UploadedFilesJSON
		if out.UploadedFilesJSON == "" {
			out.UploadedFilesJSON = "[]"
		}
	}
	if item.UploadedFilesJSON != "" {
		var files []any
		if json.Unmarshal([]byte(item.UploadedFilesJSON), &files) == nil {
			out.FileCount = len(files)
		}
	}
	return out
}

func defaultDraftJSON(prompt string) string {
	data, _ := json.Marshal(map[string]any{"text": prompt, "segments": []any{map[string]string{"type": "text", "text": prompt}}})
	return string(data)
}

func getDraftText(raw string) (string, error) {
	var draft struct {
		Text     string `json:"text"`
		Segments []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"segments"`
	}
	if err := json.Unmarshal([]byte(raw), &draft); err != nil {
		return "", err
	}
	if strings.TrimSpace(draft.Text) != "" {
		return draft.Text, nil
	}
	var parts []string
	for _, segment := range draft.Segments {
		if segment.Type == "text" {
			parts = append(parts, segment.Text)
		}
	}
	return strings.Join(parts, ""), nil
}

func getUploadedFiles(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "[]", nil
	}
	var files []any
	if err := json.Unmarshal([]byte(raw), &files); err != nil {
		return "", err
	}
	data, err := json.Marshal(files)
	return string(data), err
}

func editedPrompt(draftJSON, uploadedFilesJSON, fallback string) (string, string, string, error) {
	if strings.TrimSpace(draftJSON) == "" {
		return "", "", "", errors.New("draft_json is required")
	}
	prompt, err := getDraftText(draftJSON)
	if err != nil {
		return "", "", "", fmt.Errorf("invalid draft_json: %w", err)
	}
	if strings.TrimSpace(prompt) == "" && strings.TrimSpace(fallback) == "" {
		return "", "", "", errors.New("queued prompt must not be empty")
	}
	if strings.TrimSpace(prompt) == "" {
		prompt = fallback
	}
	files, err := getUploadedFiles(uploadedFilesJSON)
	if err != nil {
		return "", "", "", fmt.Errorf("invalid uploaded_files_json: %w", err)
	}
	return prompt, draftJSON, files, nil
}

type queueCurrent struct {
	RunID             string `json:"runId"`
	ClientRequestID   string `json:"clientRequestId,omitempty"`
	SessionID         string `json:"sessionId,omitempty"`
	BackendRunID      string `json:"backendRunId,omitempty"`
	AcceptedSeq       int64  `json:"acceptedSeq,omitempty"`
	LastSeq           int64  `json:"lastSeq,omitempty"`
	CanonicalTerminal bool   `json:"canonicalTerminal,omitempty"`
	CancelRequested   bool   `json:"cancelRequested,omitempty"`
	RecoveryRequired  bool   `json:"recoveryRequired,omitempty"`
}

type queueStateDocument struct {
	Version   int                      `json:"version"`
	Target    string                   `json:"target"`
	Backend   string                   `json:"backend"`
	Sessions  map[string]string        `json:"sessions"`
	Items     map[string][]queuedRun   `json:"items"`
	Revisions map[string]uint64        `json:"revisions"`
	Edits     map[string]queueEdit     `json:"edits"`
	Dedupe    map[string]string        `json:"dedupe"`
	Current   map[string]*queueCurrent `json:"current"`
}

func (r *Relay) restoreQueue(cb Callbacks) error {
	data, err := os.ReadFile(r.queuePath)
	if errors.Is(err, os.ErrNotExist) {
		return r.persistQueue()
	}
	if err != nil {
		return fmt.Errorf("read kbrain queue state: %w", err)
	}
	var document queueStateDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return fmt.Errorf("decode kbrain queue state: %w", err)
	}
	if document.Version != 1 || document.Target != r.target || document.Backend != r.client.BaseURL ||
		document.Sessions == nil || document.Items == nil || document.Revisions == nil || document.Edits == nil || document.Dedupe == nil {
		return errors.New("invalid kbrain queue state or target mismatch")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessions, r.queues, r.queueRevisions = document.Sessions, document.Items, document.Revisions
	r.queueEdits, r.dedupe = document.Edits, document.Dedupe
	for conversationID, items := range r.queues {
		for i := range items {
			items[i].Callbacks = cb
		}
		r.queues[conversationID] = items
	}
	for key, edit := range r.queueEdits {
		edit.Item.Callbacks = cb
		r.queueEdits[key] = edit
	}
	for conversationID, current := range document.Current {
		// A process can stop after Gateway acceptance but before K-brain
		// returns canonical identity. Such a run is intentionally not
		// recoverable; it must not prevent the rest of the queue state from
		// loading after restart.
		if current == nil || current.RunID == "" || current.SessionID == "" || current.BackendRunID == "" || current.AcceptedSeq < 1 {
			if current != nil && current.ClientRequestID != "" {
				delete(r.dedupe, conversationKey(conversationID, current.ClientRequestID))
			}
			continue
		}
		state, _ := r.newRunLocked(context.Background(), current.RunID, conversationID, current.ClientRequestID, cb)
		state.kbrainSessionID, state.kbrainRunID = current.SessionID, current.BackendRunID
		// Older documents have no cursor and replay from run.accepted.
		state.acceptedSeq = current.AcceptedSeq
		state.lastSeq = current.LastSeq
		if state.lastSeq < current.AcceptedSeq-1 {
			state.lastSeq = current.AcceptedSeq - 1
		}
		state.replaySeq = state.lastSeq
		state.cancelRequested = current.CancelRequested
		state.canonicalTerminal = current.CanonicalTerminal
		state.restored = !current.CanonicalTerminal
		r.activeRuns[conversationID] = current.RunID
	}
	// Dedupe is derived from durable queue/edit/current identities. Discard
	// entries left by a pre-acceptance request or an interrupted mutation.
	r.dedupe = make(map[string]string)
	for conversationID, items := range r.queues {
		for _, item := range items {
			if item.ClientRequestID != "" {
				r.dedupe[conversationKey(conversationID, item.ClientRequestID)] = item.RunID
			}
		}
	}
	for _, edit := range r.queueEdits {
		if edit.Item.ClientRequestID != "" {
			r.dedupe[conversationKey(edit.ConversationID, edit.Item.ClientRequestID)] = edit.Item.RunID
		}
	}
	for conversationID, runID := range r.activeRuns {
		if state := r.runs[runID]; state != nil && state.clientRequestID != "" {
			r.dedupe[conversationKey(conversationID, state.clientRequestID)] = runID
		}
	}
	return nil
}

func (r *Relay) persistQueue() error {
	if r.queuePath == "" {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.persistQueueLocked()
}

func (r *Relay) persistQueueLocked() error {
	if r.queuePath == "" {
		return nil
	}
	dedupe := make(map[string]string, len(r.dedupe))
	for key, runID := range r.dedupe {
		dedupe[key] = runID
	}
	current := make(map[string]*queueCurrent, len(r.activeRuns))
	for conversationID, runID := range r.activeRuns {
		state := r.runs[runID]
		if state == nil || state.kbrainSessionID == "" || state.kbrainRunID == "" || state.acceptedSeq < 1 {
			// A pre-acceptance run has no recoverable identity. Do not persist
			// a dedupe entry that would silently swallow its retry.
			if state != nil && state.clientRequestID != "" {
				delete(dedupe, conversationKey(conversationID, state.clientRequestID))
			}
			continue
		}
		current[conversationID] = &queueCurrent{
			RunID:             runID,
			ClientRequestID:   state.clientRequestID,
			SessionID:         state.kbrainSessionID,
			BackendRunID:      state.kbrainRunID,
			AcceptedSeq:       state.acceptedSeq,
			LastSeq:           state.replaySeq,
			CanonicalTerminal: state.canonicalTerminal,
			CancelRequested:   state.cancelRequested,
			RecoveryRequired:  state.restored,
		}
	}
	document := queueStateDocument{Version: 1, Target: r.target, Backend: r.client.BaseURL, Sessions: r.sessions, Items: r.queues, Revisions: r.queueRevisions, Edits: r.queueEdits, Dedupe: dedupe, Current: current}
	data, err := json.Marshal(document)
	if err != nil {
		return fmt.Errorf("encode kbrain queue state: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(r.queuePath), 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(r.queuePath), ".kbrain-queue-*")
	if err != nil {
		return fmt.Errorf("create kbrain queue state: %w", err)
	}
	name := file.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, r.queuePath)
	}
	if err != nil {
		return fmt.Errorf("write kbrain queue state: %w", err)
	}
	return nil
}

func (r *Relay) queueCurrentLocked(conversationID string) *queueCurrent {
	runID := r.activeRuns[conversationID]
	if runID == "" {
		return nil
	}
	state := r.runs[runID]
	out := &queueCurrent{RunID: runID, SessionID: r.sessions[conversationID]}
	if state != nil {
		out.ClientRequestID, out.BackendRunID = state.clientRequestID, state.kbrainRunID
		out.AcceptedSeq, out.LastSeq, out.CancelRequested, out.RecoveryRequired = state.acceptedSeq, state.lastSeq, state.cancelRequested, state.restored
	}
	return out
}

// queueStateCopyLocked returns a rollback-safe copy of the mutable queue maps.
// Callers hold r.mu; callbacks and cancellation functions are intentionally
// retained because this snapshot is used only for an in-memory rollback.
func (r *Relay) queueStateCopyLocked() queueStateDocument {
	items := make(map[string][]queuedRun, len(r.queues))
	for conversationID, runs := range r.queues {
		items[conversationID] = append([]queuedRun(nil), runs...)
	}
	edits := make(map[string]queueEdit, len(r.queueEdits))
	for key, edit := range r.queueEdits {
		edits[key] = edit
	}
	sessions := make(map[string]string, len(r.sessions))
	for key, value := range r.sessions {
		sessions[key] = value
	}
	revisions := make(map[string]uint64, len(r.queueRevisions))
	for key, value := range r.queueRevisions {
		revisions[key] = value
	}
	dedupe := make(map[string]string, len(r.dedupe))
	for key, value := range r.dedupe {
		dedupe[key] = value
	}
	return queueStateDocument{Version: 1, Target: r.target, Backend: r.client.BaseURL, Sessions: sessions, Items: items, Revisions: revisions, Edits: edits, Dedupe: dedupe}
}

func (r *Relay) restoreQueueStateLocked(snapshot queueStateDocument) {
	r.sessions = snapshot.Sessions
	r.queues = snapshot.Items
	r.queueRevisions = snapshot.Revisions
	r.queueEdits = snapshot.Edits
	r.dedupe = snapshot.Dedupe
}

func (r *Relay) attachCallbacksLocked(conversationID string, callbacks Callbacks) {
	for index := range r.queues[conversationID] {
		r.queues[conversationID][index].Callbacks = callbacks
	}
	for key, edit := range r.queueEdits {
		if edit.ConversationID == conversationID {
			edit.Item.Callbacks = callbacks
			r.queueEdits[key] = edit
		}
	}
	if runID := r.activeRuns[conversationID]; runID != "" {
		if state := r.runs[runID]; state != nil {
			state.callbacks = callbacks
		}
	}
}
