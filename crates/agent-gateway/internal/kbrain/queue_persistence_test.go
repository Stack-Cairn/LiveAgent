package kbrain

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestRelayQueueStateRestoresQueuedItemsAndCurrentRun(t *testing.T) {
	var mu sync.Mutex
	runCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch req.URL.Path {
		case "/v1/sessions/session-1/runs":
			mu.Lock()
			runCount++
			mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","conversation_id":"session-1","run_id":"backend-2","accepted_seq":7}`))
		case "/v1/sessions":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"session-1"}`))
		case "/v1/sessions/session-1/events":
			w.Header().Set("Content-Type", "text/event-stream")
			after := req.URL.Query().Get("after_seq")
			if after == "4" {
				_, _ = w.Write([]byte(`data: {"version":"kbrain.agent.v1","seq":5,"conversation_id":"session-1","run_id":"backend-1","type":"run.accepted"}` + "\n\n"))
				_, _ = w.Write([]byte(`data: {"version":"kbrain.agent.v1","seq":6,"conversation_id":"session-1","run_id":"backend-1","type":"run.completed"}` + "\n\n"))
			} else {
				_, _ = w.Write([]byte(`data: {"version":"kbrain.agent.v1","seq":7,"conversation_id":"session-1","run_id":"backend-2","type":"run.accepted"}` + "\n\n"))
				_, _ = w.Write([]byte(`data: {"version":"kbrain.agent.v1","seq":8,"conversation_id":"session-1","run_id":"backend-2","type":"run.completed"}` + "\n\n"))
			}
		default:
			http.NotFound(w, req)
		}
	}))
	defer server.Close()

	path := filepath.Join(t.TempDir(), "queue.json")
	client, err := New(server.URL, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	cb := Callbacks{}
	first, err := NewRelayWithQueueState(client, "target", ModelRef{Provider: "fixture", Model: "model"}, "/workspace", path, cb)
	if err != nil {
		t.Fatal(err)
	}
	first.mu.Lock()
	first.sessions["conv"] = "session-1"
	first.activeRuns["conv"] = "active"
	first.runs["active"] = &runState{gatewayRunID: "active", conversationID: "conv", clientRequestID: "req-active", kbrainSessionID: "session-1", kbrainRunID: "backend-1", acceptedSeq: 5, lastSeq: 5, done: make(chan struct{}), callbacks: cb}
	first.queues["conv"] = []queuedRun{{RunID: "queued", ConversationID: "conv", ClientRequestID: "req-queued", Prompt: PromptRequest{Prompt: "queued"}, CWD: "/workspace", DraftJSON: defaultDraftJSON("queued")}}
	first.queueRevisions["conv"] = 1
	if err := first.persistQueueLocked(); err != nil {
		first.mu.Unlock()
		t.Fatal(err)
	}
	first.mu.Unlock()

	controls := make(chan *gatewayv2.ChatControlEvent, 4)
	second, err := NewRelayWithQueueState(client, "target", ModelRef{}, "/workspace", path, Callbacks{OnControl: func(_ string, event *gatewayv2.ChatControlEvent) { controls <- event }})
	if err != nil {
		t.Fatal(err)
	}
	got := second.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "get", ConversationId: "conv"})
	if !got.Accepted || got.Revision != 1 {
		t.Fatalf("restored queue = %#v", got)
	}
	var snapshot queueSnapshot
	if err := json.Unmarshal([]byte(got.SnapshotJSON), &snapshot); err != nil || len(snapshot.Items) != 1 || snapshot.Current == nil || snapshot.Current.BackendRunID != "backend-1" {
		t.Fatalf("restored snapshot = %#v, err=%v", snapshot, err)
	}
	select {
	case event := <-controls:
		if event.Type != "started" || event.RequestId != "active" {
			t.Fatalf("restored start = %#v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("restored run did not replay start")
	}
	select {
	case event := <-controls:
		if event.Type != "completed" || event.RequestId != "active" {
			t.Fatalf("restored terminal = %#v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("restored run did not replay terminal")
	}
	select {
	case event := <-controls:
		if event.Type != "started" || event.RequestId != "queued" {
			t.Fatalf("queued run was not dispatched after restore: %#v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("queued run did not start after restored completion")
	}
	select {
	case event := <-controls:
		if event.Type != "completed" || event.RequestId != "queued" {
			t.Fatalf("queued completion = %#v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("queued run did not complete after restore")
	}
	waitRelayIdle(t, second, "conv")
	mu.Lock()
	defer mu.Unlock()
	if runCount != 1 {
		t.Fatalf("restored queue unexpectedly started an extra backend run: %d", runCount)
	}
}

func TestRelayRestoreUsesDurableReplayCursorAndDispatchesCanonicalTerminal(t *testing.T) {
	var mu sync.Mutex
	var after []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/v1/sessions/session-replay/runs":
			w.WriteHeader(http.StatusAccepted)
			_, _ = fmt.Fprint(w, `{"version":"kbrain.agent.v1","conversation_id":"session-replay","run_id":"backend-queued","accepted_seq":9}`)
		case "/v1/sessions/session-replay/events":
			mu.Lock()
			after = append(after, req.URL.Query().Get("after_seq"))
			cursor := req.URL.Query().Get("after_seq")
			mu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			if cursor == "7" {
				_, _ = fmt.Fprint(w, `data: {"version":"kbrain.agent.v1","seq":8,"conversation_id":"session-replay","run_id":"backend-replay","type":"run.completed"}`+"\n\n")
			} else {
				_, _ = fmt.Fprint(w, `data: {"version":"kbrain.agent.v1","seq":9,"conversation_id":"session-replay","run_id":"backend-queued","type":"run.accepted"}`+"\n\n")
				_, _ = fmt.Fprint(w, `data: {"version":"kbrain.agent.v1","seq":10,"conversation_id":"session-replay","run_id":"backend-queued","type":"run.completed"}`+"\n\n")
			}
		default:
			http.NotFound(w, req)
		}
	}))
	defer server.Close()

	client, err := New(server.URL, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "queue.json")
	first, err := NewRelayWithQueueState(client, "target", ModelRef{}, "/workspace", path, Callbacks{})
	if err != nil {
		t.Fatal(err)
	}
	first.mu.Lock()
	first.sessions["conv"] = "session-replay"
	first.activeRuns["conv"] = "active"
	first.runs["active"] = &runState{
		gatewayRunID: "active", conversationID: "conv", kbrainSessionID: "session-replay", kbrainRunID: "backend-replay",
		acceptedSeq: 5, lastSeq: 8, replaySeq: 7, done: make(chan struct{}), callbacks: Callbacks{}, canonicalTerminal: false,
	}
	first.queues["conv"] = []queuedRun{{RunID: "queued", ConversationID: "conv", Prompt: PromptRequest{Prompt: "queued"}, DraftJSON: defaultDraftJSON("queued")}}
	if err := first.persistQueueLocked(); err != nil {
		first.mu.Unlock()
		t.Fatal(err)
	}
	first.mu.Unlock()

	controls := make(chan *gatewayv2.ChatControlEvent, 4)
	second, err := NewRelayWithQueueState(client, "target", ModelRef{}, "/workspace", path, Callbacks{OnControl: func(_ string, event *gatewayv2.ChatControlEvent) { controls <- event }})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-controls:
		if event.Type != "completed" || event.RequestId != "active" {
			t.Fatalf("terminal = %#v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("restored terminal was not dispatched")
	}
	select {
	case event := <-controls:
		if event.Type != "started" || event.RequestId != "queued" {
			t.Fatalf("next dispatch = %#v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("queued run was not dispatched")
	}
	select {
	case event := <-controls:
		if event.Type != "completed" || event.RequestId != "queued" {
			t.Fatalf("queued completion = %#v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("queued run did not complete")
	}
	waitRelayIdle(t, second, "conv")
	mu.Lock()
	defer mu.Unlock()
	if len(after) != 2 || after[0] != "7" || after[1] != "8" {
		t.Fatalf("replay cursors = %v, want [7 8]", after)
	}
}

func TestRelayRestartReissuesRunNowCancelAndRestoresDedupeHTTP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.json")
	first, backend := newQueueHTTPBackendWithQueueState(t, path)
	close(backend.acceptFirst)
	controls := make(chan *gatewayv2.ChatControlEvent, 10)
	cb := Callbacks{OnControl: func(_ string, event *gatewayv2.ChatControlEvent) { controls <- event }}
	ctx, stopFirst := context.WithCancel(context.Background())
	t.Cleanup(stopFirst)
	for _, id := range []string{"active", "removed", "queued"} {
		queued, err := first.Start(ctx, id, "conv-regression", "request-"+id, PromptRequest{Prompt: id}, "append", cb)
		if err != nil || queued != (id != "active") {
			t.Fatalf("start %s = %t, %v", id, queued, err)
		}
	}
	if got := awaitQueueValue(t, backend.startRequests); got != "active" {
		t.Fatalf("first backend prompt = %q", got)
	}
	if got := awaitQueueValue(t, controls); got.RequestId != "active" || got.Type != "started" {
		t.Fatalf("first control = %#v", got)
	}
	if cancelled, err := first.Cancel(context.Background(), "conv-regression", "removed"); err != nil || !cancelled {
		t.Fatalf("queued cancel = %t, %v", cancelled, err)
	}
	if got := awaitQueueValue(t, controls); got.RequestId != "removed" || got.Type != "cancelled" {
		t.Fatalf("queued cancellation = %#v", got)
	}
	runNow := first.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "run_now", ConversationId: "conv-regression", ItemId: "queued", Revision: 3})
	if !runNow.Accepted || runNow.Revision != 4 {
		t.Fatalf("run_now = %#v", runNow)
	}
	awaitQueueValue(t, backend.cancelSeen)

	// Recover the real persisted snapshot with cancellation still awaiting SSE confirmation.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var document queueStateDocument
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	current := document.Current["conv-regression"]
	if current == nil || current.RunID != "active" || current.BackendRunID != "backend-1" || current.LastSeq != 1 || !current.CancelRequested || current.CanonicalTerminal {
		t.Fatalf("durable current = %#v", current)
	}
	if document.Dedupe[conversationKey("conv-regression", "request-removed")] != "" {
		t.Fatalf("cancelled queued request retained durable dedupe: %#v", document.Dedupe)
	}
	recoveryPath := filepath.Join(t.TempDir(), "queue.json")
	if err := os.WriteFile(recoveryPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	stopFirst()
	if got := awaitQueueValue(t, controls); got.RequestId != "active" || got.Type != "cancelled" {
		t.Fatalf("stopped original reader = %#v", got)
	}
	recoveredControls := make(chan *gatewayv2.ChatControlEvent, 10)
	recoveredCB := Callbacks{OnControl: func(_ string, event *gatewayv2.ChatControlEvent) { recoveredControls <- event }}
	second, err := NewRelayWithQueueState(first.client, "target", ModelRef{Provider: "fixture", Model: "model"}, "/workspace", recoveryPath, recoveredCB)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		second.mu.Lock()
		delete(second.queues, "conv-regression")
		for _, state := range second.runs {
			state.cancel()
		}
		second.mu.Unlock()
	})
	awaitQueueValue(t, backend.cancelSeen)
	assertQueueSnapshot(t, second, 4, "queued")
	for _, id := range []string{"active", "queued"} {
		duplicate, err := second.Start(context.Background(), "duplicate-"+id, "conv-regression", "request-"+id, PromptRequest{Prompt: "duplicate-" + id}, "append", recoveredCB)
		if err != nil || !duplicate {
			t.Fatalf("recovered dedupe %s = %t, %v", id, duplicate, err)
		}
	}
	assertQueueSnapshot(t, second, 4, "queued")
	if queued, err := second.Start(context.Background(), "retry", "conv-regression", "request-removed", PromptRequest{Prompt: "retry"}, "append", recoveredCB); err != nil || !queued {
		t.Fatalf("cancelled request retry = %t, %v", queued, err)
	}
	assertQueueSnapshot(t, second, 5, "queued", "retry")
	if duplicate, err := second.Start(context.Background(), "duplicate-retry", "conv-regression", "request-removed", PromptRequest{Prompt: "duplicate-retry"}, "append", recoveredCB); err != nil || !duplicate {
		t.Fatalf("retry dedupe = %t, %v", duplicate, err)
	}
	if cancelled, err := second.Cancel(context.Background(), "conv-regression", "removed"); err != nil || cancelled {
		t.Fatalf("old queued identity matched retry = %t, %v", cancelled, err)
	}
	assertQueueSnapshot(t, second, 5, "queued", "retry")
	select {
	case got := <-backend.startRequests:
		t.Fatalf("restart dispatched before canonical cancellation: %q", got)
	case got := <-recoveredControls:
		t.Fatalf("restart emitted a premature/duplicate control: %#v", got)
	case <-backend.cancelSeen:
		t.Fatal("restart issued more than one cancel")
	case <-time.After(100 * time.Millisecond):
	}
	close(backend.terminals[0])
	if got := awaitQueueValue(t, recoveredControls); got.RequestId != "active" || got.Type != "cancelled" || got.ErrorCode != "" {
		t.Fatalf("recovered canonical cancellation = %#v", got)
	}
	for index, id := range []string{"queued", "retry"} {
		if got := awaitQueueValue(t, backend.startRequests); got != id {
			t.Fatalf("recovered backend prompt = %q, want %q", got, id)
		}
		if got := awaitQueueValue(t, recoveredControls); got.RequestId != id || got.Type != "started" {
			t.Fatalf("recovered start = %#v", got)
		}
		if index == 0 {
			assertQueueSnapshot(t, second, 6, "retry")
		} else {
			assertQueueSnapshot(t, second, 7)
		}
		close(backend.terminals[index+1])
		if got := awaitQueueValue(t, recoveredControls); got.RequestId != id || got.Type != "completed" {
			t.Fatalf("recovered completion = %#v", got)
		}
	}
	deadline := time.After(2 * time.Second)
	for {
		response := second.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "get", ConversationId: "conv-regression"})
		var snapshot queueSnapshot
		if err := json.Unmarshal([]byte(response.SnapshotJSON), &snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.Current == nil {
			break
		}
		select {
		case <-deadline:
			t.Fatal("recovered queue did not become idle")
		case <-time.After(time.Millisecond):
		}
	}
	assertQueueSnapshot(t, second, 7)
	select {
	case got := <-backend.startRequests:
		t.Fatalf("duplicate backend submission after recovery: %q", got)
	case got := <-recoveredControls:
		t.Fatalf("duplicate recovered control: %#v", got)
	case <-backend.cancelSeen:
		t.Fatal("duplicate backend cancellation after recovery")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestRelayStartPersistenceFailureDoesNotLeaveDedupeOrRun(t *testing.T) {
	r, err := NewRelay(mustQueueClient(t), "target", ModelRef{}, "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	badParent := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(badParent, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	r.queuePath = filepath.Join(badParent, "queue.json")
	if _, err := r.Start(context.Background(), "gateway", "conv", "request", PromptRequest{Prompt: "retry"}, "auto", Callbacks{}); err == nil {
		t.Fatal("start unexpectedly succeeded with unwritable queue path")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.runs) != 0 || len(r.activeRuns) != 0 || len(r.dedupe) != 0 {
		t.Fatalf("failed start left state: runs=%v active=%v dedupe=%v", r.runs, r.activeRuns, r.dedupe)
	}
}

func TestRelayRestoreDropsPreacceptanceOrphanDedupe(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		http.NotFound(w, req)
	}))
	defer server.Close()
	client, err := New(server.URL, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "queue.json")
	document := queueStateDocument{
		Version: 1, Target: "target", Backend: server.URL,
		Sessions: map[string]string{}, Items: map[string][]queuedRun{}, Revisions: map[string]uint64{}, Edits: map[string]queueEdit{},
		Dedupe:  map[string]string{"conv\x00request": "orphan"},
		Current: map[string]*queueCurrent{"conv": {RunID: "orphan", ClientRequestID: "request"}},
	}
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelayWithQueueState(client, "target", ModelRef{}, "/workspace", path, Callbacks{})
	if err != nil {
		t.Fatal(err)
	}
	relay.mu.Lock()
	defer relay.mu.Unlock()
	if _, ok := relay.dedupe["conv\x00request"]; ok {
		t.Fatalf("orphan dedupe survived restore: %#v", relay.dedupe)
	}
	if len(relay.runs) != 0 || len(relay.activeRuns) != 0 {
		t.Fatalf("orphan run survived restore: runs=%v active=%v", relay.runs, relay.activeRuns)
	}
}

// waitRelayIdle waits until the conversation has no active run. The terminal control is
// emitted before finish() persists the queue, so returning earlier races TempDir cleanup.
func waitRelayIdle(t *testing.T, relay *Relay, conversationID string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		relay.mu.Lock()
		idle := relay.activeRuns[conversationID] == ""
		relay.mu.Unlock()
		if idle {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("run did not finish after completion")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
