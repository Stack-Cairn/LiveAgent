package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

type historySnapshotStart struct {
	Epoch            string                  `json:"epoch"`
	Revision         string                  `json:"revision"`
	SnapshotID       string                  `json:"snapshot_id"`
	ExpiresInSeconds int                     `json:"expires_in_seconds"`
	TotalCount       int                     `json:"total_count"`
	Workdirs         []historyWorkdirSummary `json:"workdirs"`
}

type historySnapshotPage struct {
	Epoch      string    `json:"epoch"`
	Revision   string    `json:"revision"`
	SnapshotID string    `json:"snapshot_id"`
	TotalCount int       `json:"total_count"`
	Sessions   []Session `json:"sessions"`
	NextOffset *int      `json:"next_offset"`
}

type historyWorkdirSummary struct {
	CWD       string    `json:"cwd"`
	Count     int32     `json:"count"`
	UpdatedAt time.Time `json:"updated_at"`
}

type historyChange struct {
	ID       string   `json:"id"`
	Revision string   `json:"revision"`
	Kind     string   `json:"kind"`
	Listed   bool     `json:"listed"`
	Session  *Session `json:"session"`
}

type historyChanges struct {
	Epoch        string          `json:"epoch"`
	HeadRevision string          `json:"head_revision"`
	MinSince     string          `json:"min_since"`
	NextSince    *string         `json:"next_since"`
	Reset        bool            `json:"reset"`
	ResetReason  string          `json:"reset_reason"`
	More         bool            `json:"more"`
	Changes      []historyChange `json:"changes"`
}

const maxHistorySnapshotSessions = 100_000
const maxPendingHistoryDeletes = 10_000

type relayHistoryState struct {
	available      bool
	resetRequired  bool
	pendingDeletes map[string]struct{}
	callbacks      Callbacks
}

func parseHistoryRevision(value string) (uint64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, errors.New("kbrain history revision is required")
	}
	return strconv.ParseUint(value, 10, 64)
}

func (c *Client) supportsSessionChanges(ctx context.Context) (bool, error) {
	var raw json.RawMessage
	resp, err := c.request(ctx, http.MethodGet, "/v1/health", nil, &raw)
	if err != nil {
		return false, err
	}
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("kbrain health: %s", resp.Status)
	}
	var health struct {
		Capabilities map[string]json.RawMessage `json:"capabilities"`
	}
	if err := json.Unmarshal(raw, &health); err != nil {
		// Older test and deployment endpoints can expose a non-object health
		// body. They simply do not negotiate session_changes v2.
		return false, nil
	}
	var version int
	if raw := health.Capabilities["session_changes"]; len(raw) > 0 {
		_ = json.Unmarshal(raw, &version)
	}
	return version >= 2, nil
}

func (c *Client) createHistorySnapshot(ctx context.Context) (historySnapshotStart, error) {
	var out historySnapshotStart
	resp, err := c.request(ctx, http.MethodPost, "/v1/sessions/snapshots", nil, &out)
	if err != nil {
		return out, err
	}
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("kbrain create history snapshot: %s", resp.Status)
	}
	return out, nil
}

func (c *Client) historySnapshotPage(ctx context.Context, snapshotID string, offset int) (historySnapshotPage, error) {
	var out historySnapshotPage
	path := "/v1/sessions/snapshots/" + url.PathEscape(snapshotID) + "?offset=" + strconv.Itoa(offset) + "&limit=500"
	resp, err := c.request(ctx, http.MethodGet, path, nil, &out)
	if err != nil {
		return out, err
	}
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("kbrain get history snapshot: %s", resp.Status)
	}
	return out, nil
}

func (c *Client) deleteHistorySnapshot(ctx context.Context, snapshotID string) {
	_, _ = c.request(ctx, http.MethodDelete, "/v1/sessions/snapshots/"+url.PathEscape(snapshotID), nil, nil)
}

func (c *Client) historyChanges(ctx context.Context, epoch string, since uint64, wait int, rescan bool) (historyChanges, error) {
	query := url.Values{}
	query.Set("epoch", epoch)
	query.Set("since", strconv.FormatUint(since, 10))
	query.Set("wait", strconv.Itoa(wait))
	if rescan {
		query.Set("rescan", "1")
	}
	var out historyChanges
	resp, err := c.request(ctx, http.MethodGet, "/v1/sessions/changes?"+query.Encode(), nil, &out)
	if err != nil {
		return out, err
	}
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("kbrain history changes: %s", resp.Status)
	}
	return out, nil
}

func (r *Relay) StartHistorySync(callbacks Callbacks) error {
	r.mu.Lock()
	if r.historyWatching {
		r.mu.Unlock()
		return nil
	}
	r.historyWatching = true
	r.historyState = &relayHistoryState{
		pendingDeletes: make(map[string]struct{}), callbacks: callbacks,
	}
	r.backendWorkers.Add(1)
	r.mu.Unlock()
	go func() {
		defer r.backendWorkers.Done()
		r.historySyncLoop(callbacks)
	}()
	return nil
}

func (r *Relay) historySyncLoop(callbacks Callbacks) {
	backoff := time.Second
	for {
		ctx, cancel := context.WithTimeout(r.backendContext, 5*time.Second)
		supported, negotiationErr := r.client.supportsSessionChanges(ctx)
		cancel()
		if r.backendContext.Err() != nil {
			return
		}
		if negotiationErr == nil && !supported {
			select {
			case <-r.backendContext.Done():
				return
			case <-time.After(5 * time.Minute):
			}
			continue
		}
		var syncErr error
		if negotiationErr == nil {
			backoff = time.Second
			syncErr = r.syncHistoryGeneration(callbacks)
		} else {
			syncErr = negotiationErr
		}
		if syncErr == nil {
			return
		}
		if callbacks.OnHistoryStatus != nil {
			callbacks.OnHistoryStatus(&gatewayv2.HistorySyncStatus{
				SourceId: "kbrain:" + r.target, Available: false, NeedsResync: true,
			})
		}
		select {
		case <-r.backendContext.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (r *Relay) syncHistoryGeneration(callbacks Callbacks) error {
	defer func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		if state := r.historyState; state != nil {
			state.available = false
			state.resetRequired = false
			for id := range state.pendingDeletes {
				delete(r.sessions, id)
			}
			clear(state.pendingDeletes)
		}
	}()
	initializationContext, cancelInitialization := context.WithTimeout(r.backendContext, 45*time.Second)
	start, snapshotSessions, err := r.readHistorySnapshot(initializationContext)
	cancelInitialization()
	if err != nil {
		return err
	}
	since, err := parseHistoryRevision(start.Revision)
	if err != nil {
		return err
	}
	sessions := make(map[string]Session, len(snapshotSessions))
	for _, session := range snapshotSessions {
		if strings.TrimSpace(session.ID) == "" {
			return errors.New("kbrain history snapshot contains an empty session id")
		}
		if _, exists := sessions[session.ID]; exists {
			return errors.New("kbrain history snapshot contains duplicate session ids")
		}
		sessions[session.ID] = session
	}

	// The first wait=0 response fixes a finite head H. Publish nothing until
	// all batches through H have been validated and applied to the temporary map.
	var target *uint64
	for target == nil || since < *target {
		requestContext, cancel := context.WithTimeout(r.backendContext, 45*time.Second)
		changes, err := r.client.historyChanges(requestContext, start.Epoch, since, 0, false)
		cancel()
		if err != nil {
			return err
		}
		next, validated, err := validateHistoryChanges(changes, start.Epoch, since)
		if err != nil {
			return err
		}
		if target == nil {
			head, _ := parseHistoryRevision(changes.HeadRevision)
			target = &head
		}
		applyHistoryChanges(sessions, validated)
		if next == since && since < *target {
			return errors.New("kbrain history catch-up did not advance to its head")
		}
		since = next
	}

	sourceID := "kbrain:" + r.target
	generation := start.Epoch + ":" + strconv.FormatInt(time.Now().UnixNano(), 36)
	conversations := make([]*gatewayv2.ConversationSummary, 0, len(sessions))
	r.mu.Lock()
	if r.historyState != nil {
		r.historyState.available = true
	}
	for _, item := range sessions {
		id := r.historyConversationIDLocked(item.ID)
		conversations = append(conversations, sessionSummary(id, item))
	}
	r.mu.Unlock()
	workdirs := historyWorkdirsForSessions(sessions)
	if callbacks.OnHistorySnapshot != nil {
		callbacks.OnHistorySnapshot(&gatewayv2.HistorySyncSnapshot{
			SourceId: sourceID, Generation: generation, CutDeliverySeq: 0,
			Conversations: conversations, Workdirs: workdirs, TotalCount: uint32(len(conversations)),
		})
	}

	deliverySeq := uint64(0)
	rescan := true
	wait := 30
	for {
		select {
		case <-r.backendContext.Done():
			return nil
		default:
		}
		requestContext, cancel := context.WithTimeout(r.backendContext, 45*time.Second)
		changes, err := r.client.historyChanges(requestContext, start.Epoch, since, wait, rescan)
		cancel()
		if err != nil {
			return err
		}
		rescan = false
		next, validated, err := validateHistoryChanges(changes, start.Epoch, since)
		if err != nil {
			return err
		}
		for _, item := range validated {
			change := item.change
			if deliverySeq >= 1<<53-1 {
				return errors.New("gateway history delivery sequence exhausted")
			}
			r.mu.Lock()
			if r.historyState != nil && r.historyState.resetRequired {
				r.mu.Unlock()
				return errors.New("kbrain history deletion budget requires a new snapshot")
			}
			id, known := r.historyConversationIDExistingLocked(change.ID)
			if change.Kind == "upsert" && change.Listed && change.Session != nil {
				id = r.historyConversationIDLocked(change.ID)
				known = true
			}
			r.mu.Unlock()
			if !known {
				continue
			}
			deliverySeq++
			event := &gatewayv2.HistorySyncEvent{
				ConversationId: id, SourceId: sourceID, Generation: generation, DeliverySeq: deliverySeq,
			}
			if change.Kind == "upsert" && change.Listed && change.Session != nil {
				event.Kind = "upsert"
				event.Conversation = sessionSummary(id, *change.Session)
			} else {
				event.Kind = "delete"
			}
			if callbacks.OnHistoryEvent != nil {
				callbacks.OnHistoryEvent(event)
			}
			if change.Kind == "delete" {
				r.mu.Lock()
				r.deleteHistoryConversationIDLocked(change.ID)
				r.mu.Unlock()
			}
		}
		r.mu.Lock()
		resetRequired := r.historyState != nil && r.historyState.resetRequired
		r.mu.Unlock()
		if resetRequired {
			return errors.New("kbrain history deletion budget requires a new snapshot")
		}
		since = next
		wait = 30
		if changes.More {
			wait = 0
		}
		if callbacks.OnHistoryStatus != nil {
			callbacks.OnHistoryStatus(&gatewayv2.HistorySyncStatus{
				SourceId: sourceID, Generation: generation, LatestDeliverySeq: deliverySeq, Available: true,
			})
		}
	}
}

type validatedHistoryChange struct {
	change   historyChange
	revision uint64
}

func validateHistoryChanges(response historyChanges, epoch string, since uint64) (uint64, []validatedHistoryChange, error) {
	if response.Reset || response.Epoch != epoch || response.NextSince == nil {
		return since, nil, errors.New("kbrain history synchronization reset")
	}
	head, err := parseHistoryRevision(response.HeadRevision)
	if err != nil {
		return since, nil, err
	}
	next, err := parseHistoryRevision(*response.NextSince)
	if err != nil || next < since || head < next {
		return since, nil, errors.New("kbrain history synchronization cursor is invalid")
	}
	if len(response.Changes) > 500 {
		return since, nil, errors.New("kbrain history synchronization batch exceeds capacity")
	}
	last := since
	validated := make([]validatedHistoryChange, 0, len(response.Changes))
	for _, change := range response.Changes {
		revision, err := parseHistoryRevision(change.Revision)
		if err != nil || revision <= last || revision > head || strings.TrimSpace(change.ID) == "" {
			return since, nil, errors.New("kbrain history synchronization sequence is invalid")
		}
		if change.Kind != "upsert" && change.Kind != "delete" {
			return since, nil, errors.New("kbrain history synchronization kind is invalid")
		}
		if change.Kind == "upsert" && (change.Session == nil || change.Session.ID != change.ID) {
			return since, nil, errors.New("kbrain history synchronization summary is invalid")
		}
		last = revision
		validated = append(validated, validatedHistoryChange{change: change, revision: revision})
	}
	if next != last || (len(validated) == 0 && response.More) || (!response.More && head > next) {
		return since, nil, errors.New("kbrain history synchronization skipped an undelivered revision")
	}
	return next, validated, nil
}

func applyHistoryChanges(sessions map[string]Session, changes []validatedHistoryChange) {
	for _, item := range changes {
		change := item.change
		if change.Kind == "delete" || !change.Listed {
			delete(sessions, change.ID)
		} else {
			sessions[change.ID] = *change.Session
		}
	}
}

func historyWorkdirsForSessions(sessions map[string]Session) []*gatewayv2.HistoryWorkdirSummary {
	byPath := make(map[string]*gatewayv2.HistoryWorkdirSummary)
	for _, session := range sessions {
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
		updated := session.UpdatedAt
		if updated.IsZero() {
			updated = session.CreatedAt
		}
		if updated.UnixMilli() > item.UpdatedAt {
			item.UpdatedAt = updated.UnixMilli()
		}
	}
	out := make([]*gatewayv2.HistoryWorkdirSummary, 0, len(byPath))
	for _, item := range byPath {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].GetUpdatedAt() != out[j].GetUpdatedAt() {
			return out[i].GetUpdatedAt() > out[j].GetUpdatedAt()
		}
		return out[i].GetPath() < out[j].GetPath()
	})
	return out
}

func (r *Relay) historyConversationIDExistingLocked(sessionID string) (string, bool) {
	for localID, backendID := range r.sessions {
		if backendID == sessionID {
			return localID, true
		}
	}
	return "", false
}

func (r *Relay) deleteHistoryConversationIDLocked(sessionID string) {
	for localID, backendID := range r.sessions {
		if backendID == sessionID {
			delete(r.sessions, localID)
			if r.historyState != nil {
				delete(r.historyState.pendingDeletes, localID)
			}
		}
	}
}

func (r *Relay) readHistorySnapshot(ctx context.Context) (historySnapshotStart, []Session, error) {
	start, err := r.client.createHistorySnapshot(ctx)
	if err != nil {
		return start, nil, err
	}
	defer func() {
		releaseContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		r.client.deleteHistorySnapshot(releaseContext, start.SnapshotID)
	}()
	if start.TotalCount < 0 || start.TotalCount > maxHistorySnapshotSessions {
		return start, nil, errors.New("kbrain history snapshot exceeds capacity")
	}
	var sessions []Session
	offset := 0
	for {
		page, err := r.client.historySnapshotPage(ctx, start.SnapshotID, offset)
		if err != nil {
			return start, nil, err
		}
		if page.Epoch != start.Epoch || page.Revision != start.Revision || page.SnapshotID != start.SnapshotID || page.TotalCount != start.TotalCount {
			return start, nil, errors.New("kbrain history snapshot changed while paging")
		}
		if len(page.Sessions) > 500 || len(sessions)+len(page.Sessions) > start.TotalCount {
			return start, nil, errors.New("kbrain history snapshot page exceeds capacity")
		}
		sessions = append(sessions, page.Sessions...)
		if page.NextOffset == nil {
			break
		}
		if *page.NextOffset != offset+len(page.Sessions) || *page.NextOffset <= offset || *page.NextOffset > start.TotalCount {
			return start, nil, errors.New("kbrain history snapshot pagination did not advance")
		}
		offset = *page.NextOffset
	}
	if len(sessions) != start.TotalCount {
		return start, nil, errors.New("kbrain history snapshot count mismatch")
	}
	return start, sessions, nil
}
