package kbrain

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestRelayQueueActionsUseRealHTTPAndSSE(t *testing.T) {
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	var startOnce sync.Once
	var mu sync.Mutex
	runCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions":
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(w, `{"id":"session-queue-http"}`)
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions/session-queue-http/runs":
			mu.Lock()
			runCount++
			run := runCount
			mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			_, _ = fmt.Fprintf(w, `{"version":"kbrain.agent.v1","conversation_id":"session-queue-http","run_id":"backend-%d","accepted_seq":%d}`, run, 1+3*(run-1))
		case req.Method == http.MethodGet && req.URL.Path == "/v1/sessions/session-queue-http/events":
			w.Header().Set("Content-Type", "text/event-stream")
			flusher := w.(http.Flusher)
			_, _ = fmt.Fprint(w, `data: {"version":"kbrain.agent.v1","seq":1,"conversation_id":"session-queue-http","run_id":"backend-1","type":"run.accepted"}`+"\n\n")
			flusher.Flush()
			startOnce.Do(func() { close(firstStarted) })
			select {
			case <-releaseFirst:
			case <-req.Context().Done():
				return
			}
			_, _ = fmt.Fprint(w, `data: {"version":"kbrain.agent.v1","seq":2,"conversation_id":"session-queue-http","run_id":"backend-1","type":"run.completed"}`+"\n\n")
			flusher.Flush()
		default:
			http.NotFound(w, req)
		}
	}))
	defer server.Close()

	client, err := New(server.URL, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "kbrain", ModelRef{Provider: "fixture", Model: "model"}, "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	callbacks := Callbacks{OnQueue: func(string, string, uint64) {}}
	_, err = relay.Start(context.Background(), "active", "conv-http", "client-active", PromptRequest{Prompt: "active"}, "auto", callbacks)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-firstStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("first SSE run did not start")
	}
	for _, item := range []struct{ id, request, text string }{
		{"queued-1", "client-1", "one"},
		{"queued-2", "client-2", "two"},
	} {
		queued, err := relay.Start(context.Background(), item.id, "conv-http", item.request, PromptRequest{Prompt: item.text}, "append", callbacks)
		if err != nil || !queued {
			t.Fatalf("queue %s = %v, %v", item.id, queued, err)
		}
	}

	inspect := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "inspect", ConversationId: "conv-http"})
	if !inspect.Accepted || inspect.Revision != 2 {
		t.Fatalf("inspect = %#v", inspect)
	}
	moved := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "reorder", ConversationId: "conv-http", ItemId: "queued-2", Direction: "up", Revision: inspect.Revision})
	if !moved.Accepted || moved.Revision != 3 {
		t.Fatalf("reorder = %#v", moved)
	}
	if stale := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "delete", ConversationId: "conv-http", ItemId: "queued-1", Revision: inspect.Revision}); stale.Accepted || stale.ErrorCode != "conflict" {
		t.Fatalf("stale delete = %#v", stale)
	}
	begin := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "edit_begin", ConversationId: "conv-http", ItemId: "queued-1"})
	if !begin.Accepted || begin.Revision != 4 || begin.ItemJSON == "" {
		t.Fatalf("edit begin = %#v", begin)
	}
	commit := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "edit_commit", ConversationId: "conv-http", ItemId: "queued-1", Revision: begin.Revision, DraftJson: `{"text":"edited"}`, UploadedFilesJson: `[]`})
	if !commit.Accepted || commit.Revision != 5 {
		t.Fatalf("edit commit = %#v", commit)
	}
	deleted := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "delete", ConversationId: "conv-http", ItemId: "queued-1", Revision: commit.Revision})
	if !deleted.Accepted || deleted.Revision != 6 {
		t.Fatalf("delete = %#v", deleted)
	}
	if active := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "delete", ConversationId: "conv-http", ItemId: "active"}); active.Accepted || active.ErrorCode != "active" {
		t.Fatalf("active delete = %#v", active)
	}
	close(releaseFirst)
	deadline := time.After(2 * time.Second)
	for {
		mu.Lock()
		count := runCount
		mu.Unlock()
		if count == 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("queued deletion started an extra run: %d", count)
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}
}

// queueHTTPBackend keeps acceptance and terminal delivery independently gated.
type queueHTTPBackend struct {
	startRequests chan string
	acceptFirst   chan struct{}
	cancelSeen    chan struct{}
	terminals     []chan struct{}
	stop          chan struct{}
}

func newQueueHTTPBackend(t *testing.T) (*Relay, *queueHTTPBackend) {
	t.Helper()
	return newQueueHTTPBackendWithQueueState(t, "")
}

func newQueueHTTPBackendWithQueueState(t *testing.T, path string) (*Relay, *queueHTTPBackend) {
	t.Helper()
	backend := &queueHTTPBackend{
		startRequests: make(chan string, 10),
		acceptFirst:   make(chan struct{}),
		cancelSeen:    make(chan struct{}, 10),
		terminals:     []chan struct{}{make(chan struct{}), make(chan struct{}), make(chan struct{})},
		stop:          make(chan struct{}),
	}
	var mu sync.Mutex
	runCount, busy := 0, false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch {
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions":
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(w, `{"id":"queue-regression"}`)
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions/queue-regression/runs":
			var prompt PromptRequest
			if err := json.NewDecoder(req.Body).Decode(&prompt); err != nil {
				t.Errorf("decode prompt: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			backend.startRequests <- prompt.Prompt
			mu.Lock()
			if busy {
				mu.Unlock()
				w.WriteHeader(http.StatusConflict)
				return
			}
			runCount++
			run := runCount
			busy = true
			mu.Unlock()
			if run == 1 {
				select {
				case <-backend.acceptFirst:
				case <-backend.stop:
					return
				case <-req.Context().Done():
					return
				}
			}
			w.WriteHeader(http.StatusAccepted)
			_, _ = fmt.Fprintf(w, `{"version":"kbrain.agent.v1","conversation_id":"queue-regression","run_id":"backend-%d","accepted_seq":%d}`, run, 2*run-1)
		case req.Method == http.MethodGet && req.URL.Path == "/v1/health":
			_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1"}`))
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions/queue-regression/runs/backend-1/cancel":
			backend.cancelSeen <- struct{}{}
			w.WriteHeader(http.StatusOK)
		case req.Method == http.MethodGet && req.URL.Path == "/v1/sessions/queue-regression/events":
			after, err := strconv.Atoi(req.URL.Query().Get("after_seq"))
			if err != nil || after/2 >= len(backend.terminals) {
				t.Errorf("unexpected SSE cursor %q", req.URL.RawQuery)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			run := after/2 + 1
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprintf(w, "data: {\"version\":\"kbrain.agent.v1\",\"conversation_id\":\"queue-regression\",\"run_id\":\"backend-%d\",\"seq\":%d,\"type\":\"run.accepted\"}\n\n", run, 2*run-1)
			w.(http.Flusher).Flush()
			select {
			case <-backend.terminals[run-1]:
			case <-backend.stop:
				return
			case <-req.Context().Done():
				return
			}
			mu.Lock()
			busy = false
			mu.Unlock()
			typ := "run.completed"
			if run == 1 {
				typ = "run.cancelled"
			}
			_, _ = fmt.Fprintf(w, "data: {\"version\":\"kbrain.agent.v1\",\"conversation_id\":\"queue-regression\",\"run_id\":\"backend-%d\",\"seq\":%d,\"type\":\"%s\"}\n\n", run, 2*run, typ)
		default:
			t.Errorf("unexpected backend request: %s %s", req.Method, req.URL.Path)
			http.NotFound(w, req)
		}
	}))
	client, err := New(server.URL, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelayWithQueueState(client, "target", ModelRef{Provider: "fixture", Model: "model"}, "/workspace", path, Callbacks{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		relay.mu.Lock()
		delete(relay.queues, "conv-regression")
		for _, state := range relay.runs {
			state.cancel()
		}
		relay.mu.Unlock()
		close(backend.stop)
		server.Close()
	})
	return relay, backend
}

func awaitQueueValue[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for queue HTTP/SSE event")
		var zero T
		return zero
	}
}

func assertQueueSnapshot(t *testing.T, relay *Relay, revision uint64, ids ...string) {
	t.Helper()
	response := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "get", ConversationId: "conv-regression"})
	var snapshot queueSnapshot
	if !response.Accepted || response.Revision != revision || json.Unmarshal([]byte(response.SnapshotJSON), &snapshot) != nil {
		t.Fatalf("queue snapshot = %#v, want revision %d", response, revision)
	}
	if snapshot.Revision != revision || len(snapshot.Items) != len(ids) {
		t.Fatalf("queue snapshot = %#v, want revision %d, items %v", snapshot, revision, ids)
	}
	for i, id := range ids {
		if snapshot.Items[i].ID != id {
			t.Fatalf("queue item %d = %s, want %s", i, snapshot.Items[i].ID, id)
		}
	}
}

func awaitQueueIdle(t *testing.T, relay *Relay) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		response := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "get", ConversationId: "conv-regression"})
		var snapshot queueSnapshot
		if response.Accepted && json.Unmarshal([]byte(response.SnapshotJSON), &snapshot) == nil && snapshot.Current == nil && len(snapshot.Items) == 0 {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("queue did not become idle: %#v", response)
		case <-ticker.C:
		}
	}
}

func TestRelayRunNowWaitsForCanonicalCancelHTTP(t *testing.T) {
	for _, beforeAcceptance := range []bool{false, true} {
		t.Run(fmt.Sprintf("before_acceptance=%t", beforeAcceptance), func(t *testing.T) {
			relay, backend := newQueueHTTPBackend(t)
			controls := make(chan *gatewayv2.ChatControlEvent, 10)
			queueEvents := make(chan queueSnapshot, 10)
			cb := Callbacks{OnControl: func(_ string, control *gatewayv2.ChatControlEvent) { controls <- control }}
			if beforeAcceptance {
				cb.OnQueue = func(_ string, raw string, revision uint64) {
					var snapshot queueSnapshot
					if err := json.Unmarshal([]byte(raw), &snapshot); err != nil || snapshot.Revision != revision {
						t.Errorf("queue event = %s, revision %d, error %v", raw, revision, err)
					}
					queueEvents <- snapshot
				}
			}
			for _, id := range []string{"active", "one", "two"} {
				queued, err := relay.Start(context.Background(), id, "conv-regression", "request-"+id, PromptRequest{Prompt: id}, "append", cb)
				if err != nil || queued != (id != "active") {
					t.Fatalf("start %s = %t, %v", id, queued, err)
				}
			}
			if got := awaitQueueValue(t, backend.startRequests); got != "active" {
				t.Fatalf("first backend prompt = %s", got)
			}
			if !beforeAcceptance {
				close(backend.acceptFirst)
				if got := awaitQueueValue(t, controls); got.Type != "started" {
					t.Fatalf("first control = %#v", got)
				}
			}
			assertQueueSnapshot(t, relay, 2, "one", "two")
			runNow := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "run_now", ConversationId: "conv-regression", ItemId: "two", Revision: 2}, cb)
			if !runNow.Accepted || runNow.Revision != 3 {
				t.Fatalf("run_now = %#v", runNow)
			}
			assertQueueSnapshot(t, relay, 3, "two", "one")
			if duplicate, err := relay.Start(context.Background(), "duplicate", "conv-regression", "request-two", PromptRequest{Prompt: "duplicate"}, "append", cb); err != nil || !duplicate {
				t.Fatalf("dedupe after run_now = %t, %v", duplicate, err)
			}
			if beforeAcceptance {
				close(backend.acceptFirst)
				if got := awaitQueueValue(t, controls); got.Type != "started" {
					t.Fatalf("first control = %#v", got)
				}
			}
			awaitQueueValue(t, backend.cancelSeen)
			select {
			case prompt := <-backend.startRequests:
				t.Fatalf("StartRun before canonical cancellation: %s", prompt)
			case control := <-controls:
				t.Fatalf("local terminal before canonical cancellation: %#v", control)
			case <-time.After(100 * time.Millisecond):
			}
			close(backend.terminals[0])
			if got := awaitQueueValue(t, controls); got.RequestId != "active" || got.Type != "cancelled" || got.ErrorCode != "" {
				t.Fatalf("canonical terminal = %#v", got)
			}
			for i, id := range []string{"two", "one"} {
				if got := awaitQueueValue(t, backend.startRequests); got != id {
					t.Fatalf("backend prompt = %s, want %s", got, id)
				}
				if got := awaitQueueValue(t, controls); got.RequestId != id || got.Type != "started" {
					t.Fatalf("started control = %#v", got)
				}
				if i == 0 {
					assertQueueSnapshot(t, relay, 4, "one")
				} else {
					assertQueueSnapshot(t, relay, 5)
				}
				close(backend.terminals[i+1])
				if got := awaitQueueValue(t, controls); got.RequestId != id || got.Type != "completed" {
					t.Fatalf("completion = %#v", got)
				}
			}
			if beforeAcceptance {
				for revision := uint64(1); revision <= 5; revision++ {
					if event := awaitQueueValue(t, queueEvents); event.Revision != revision {
						t.Fatalf("event revision = %d, want %d", event.Revision, revision)
					}
				}
			}
			select {
			case extra := <-controls:
				t.Fatalf("duplicate control: %#v", extra)
			case <-backend.cancelSeen:
				t.Fatal("duplicate canonical cancel")
			case <-time.After(100 * time.Millisecond):
			}
			assertQueueSnapshot(t, relay, 5)
		})
	}
}

func TestRelayQueueRevisionWithoutCallbackHTTP(t *testing.T) {
	relay, backend := newQueueHTTPBackend(t)
	close(backend.acceptFirst)
	started := make(chan struct{}, 1)
	cb := Callbacks{OnControl: func(_ string, event *gatewayv2.ChatControlEvent) {
		if event.Type == "started" {
			started <- struct{}{}
		}
	}}
	for _, id := range []string{"active", "edited"} {
		if _, err := relay.Start(context.Background(), id, "conv-regression", "request-"+id, PromptRequest{Prompt: id}, "append", cb); err != nil {
			t.Fatal(err)
		}
	}
	awaitQueueValue(t, started)
	assertQueueSnapshot(t, relay, 1, "edited")
	begin := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "edit_begin", ConversationId: "conv-regression", ItemId: "edited"})
	if !begin.Accepted || begin.Revision != 2 {
		t.Fatalf("edit_begin = %#v", begin)
	}
	if _, err := relay.Start(context.Background(), "appended", "conv-regression", "request-appended", PromptRequest{Prompt: "appended"}, "append", cb); err != nil {
		t.Fatal(err)
	}
	assertQueueSnapshot(t, relay, 3, "appended")
	commit := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "edit_commit", ConversationId: "conv-regression", ItemId: "edited", Revision: begin.Revision, DraftJson: `{"text":"changed"}`})
	if commit.Accepted || commit.ErrorCode != "conflict" || commit.Revision != 3 {
		t.Fatalf("stale edit after append = %#v", commit)
	}
	if cancelled, err := relay.Cancel(context.Background(), "conv-regression", "appended"); err != nil || !cancelled {
		t.Fatalf("queued cancel = %t, %v", cancelled, err)
	}
	assertQueueSnapshot(t, relay, 4)
	if cancelled, err := relay.Cancel(context.Background(), "conv-regression", "appended"); err != nil || cancelled {
		t.Fatalf("repeat cancel = %t, %v", cancelled, err)
	}
	assertQueueSnapshot(t, relay, 4)
	if _, err := relay.Start(context.Background(), "retry", "conv-regression", "request-appended", PromptRequest{Prompt: "retry"}, "append", cb); err != nil {
		t.Fatal(err)
	}
	assertQueueSnapshot(t, relay, 5, "retry")
	stale := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "remove", ConversationId: "conv-regression", ItemId: "retry", Revision: 3})
	if stale.Accepted || stale.ErrorCode != "conflict" || stale.Revision != 5 {
		t.Fatalf("stale removal after cancel = %#v", stale)
	}
}

func TestRelayStaleCancelDoesNotAffectNextRunHTTP(t *testing.T) {
	relay, backend := newQueueHTTPBackend(t)
	close(backend.acceptFirst)
	controls := make(chan *gatewayv2.ChatControlEvent, 10)
	cb := Callbacks{OnControl: func(_ string, event *gatewayv2.ChatControlEvent) { controls <- event }}
	for _, id := range []string{"active", "continue", "tail"} {
		queued, err := relay.Start(context.Background(), id, "conv-regression", "request-"+id, PromptRequest{Prompt: id}, "auto", cb)
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
	if cancelled, err := relay.Cancel(context.Background(), "conv-regression", "active"); err != nil || !cancelled {
		t.Fatalf("active cancel = %t, %v", cancelled, err)
	}
	awaitQueueValue(t, backend.cancelSeen)
	close(backend.terminals[0])
	if got := awaitQueueValue(t, controls); got.RequestId != "active" || got.Type != "cancelled" || got.ErrorCode != "" {
		t.Fatalf("canonical cancellation = %#v", got)
	}
	if got := awaitQueueValue(t, backend.startRequests); got != "continue" {
		t.Fatalf("next backend prompt = %q", got)
	}
	if got := awaitQueueValue(t, controls); got.RequestId != "continue" || got.Type != "started" {
		t.Fatalf("next control = %#v", got)
	}
	assertQueueSnapshot(t, relay, 3, "tail")
	for _, request := range []struct{ conversation, run string }{
		{"conv-regression", "active"},
		{"conv-regression", "backend-1"},
		{"conv-regression", "missing"},
		{"other-conversation", "continue"},
		{"other-conversation", "tail"},
	} {
		if cancelled, err := relay.Cancel(context.Background(), request.conversation, request.run); err != nil || cancelled {
			t.Fatalf("stale/mismatched cancel %#v = %t, %v", request, cancelled, err)
		}
	}
	response := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "get", ConversationId: "conv-regression"})
	var snapshot queueSnapshot
	if err := json.Unmarshal([]byte(response.SnapshotJSON), &snapshot); err != nil || snapshot.Current == nil || snapshot.Current.RunID != "continue" || snapshot.Current.CancelRequested {
		t.Fatalf("stale cancel changed current identity: %s, error %v", response.SnapshotJSON, err)
	}
	assertQueueSnapshot(t, relay, 3, "tail")
	select {
	case <-backend.cancelSeen:
		t.Fatal("stale cancel reached backend")
	case got := <-controls:
		t.Fatalf("stale cancel emitted a control: %#v", got)
	case got := <-backend.startRequests:
		t.Fatalf("stale cancel dispatched a run: %q", got)
	case <-time.After(100 * time.Millisecond):
	}
	close(backend.terminals[1])
	if got := awaitQueueValue(t, controls); got.RequestId != "continue" || got.Type != "completed" {
		t.Fatalf("continued completion = %#v", got)
	}
	if got := awaitQueueValue(t, backend.startRequests); got != "tail" {
		t.Fatalf("FIFO tail prompt = %q", got)
	}
	if got := awaitQueueValue(t, controls); got.RequestId != "tail" || got.Type != "started" {
		t.Fatalf("FIFO tail start = %#v", got)
	}
	assertQueueSnapshot(t, relay, 4)
	close(backend.terminals[2])
	if got := awaitQueueValue(t, controls); got.RequestId != "tail" || got.Type != "completed" {
		t.Fatalf("FIFO tail completion = %#v", got)
	}
}

func TestRelayCanonicalIdentityRunNowCancelContinueAndStaleIDHTTP(t *testing.T) {
	relay, backend := newQueueHTTPBackend(t)
	close(backend.acceptFirst)
	controls := make(chan *gatewayv2.ChatControlEvent, 10)
	cb := Callbacks{OnControl: func(_ string, event *gatewayv2.ChatControlEvent) { controls <- event }}

	for _, id := range []string{"active", "continue"} {
		queued, err := relay.Start(context.Background(), id, "conv-regression", "request-"+id, PromptRequest{Prompt: id}, "append", cb)
		if err != nil || queued != (id != "active") {
			t.Fatalf("start %s = %t, %v", id, queued, err)
		}
	}
	if got := awaitQueueValue(t, backend.startRequests); got != "active" {
		t.Fatalf("active backend prompt = %q", got)
	}
	if got := awaitQueueValue(t, controls); got.RequestId != "active" || got.Type != "started" {
		t.Fatalf("active started = %#v", got)
	}

	before := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "get", ConversationId: "conv-regression"})
	var beforeSnapshot queueSnapshot
	if err := json.Unmarshal([]byte(before.SnapshotJSON), &beforeSnapshot); err != nil || beforeSnapshot.Current == nil || beforeSnapshot.Current.RunID != "active" || beforeSnapshot.Current.BackendRunID != "backend-1" || beforeSnapshot.Current.CancelRequested {
		t.Fatalf("active canonical identity = %#v, error %v", beforeSnapshot, err)
	}

	runNow := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "run_now", ConversationId: "conv-regression", ItemId: "continue", Revision: before.Revision})
	if !runNow.Accepted || runNow.Revision != before.Revision+1 {
		t.Fatalf("run_now = %#v", runNow)
	}
	awaitQueueValue(t, backend.cancelSeen)
	pending := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "get", ConversationId: "conv-regression"})
	var pendingSnapshot queueSnapshot
	if err := json.Unmarshal([]byte(pending.SnapshotJSON), &pendingSnapshot); err != nil || pendingSnapshot.Current == nil || pendingSnapshot.Current.RunID != "active" || pendingSnapshot.Current.BackendRunID != "backend-1" || !pendingSnapshot.Current.CancelRequested || len(pendingSnapshot.Items) != 1 || pendingSnapshot.Items[0].ID != "continue" {
		t.Fatalf("run_now pending identity = %#v, error %v", pendingSnapshot, err)
	}
	select {
	case got := <-controls:
		t.Fatalf("terminal before canonical cancellation = %#v", got)
	case <-time.After(100 * time.Millisecond):
	}

	close(backend.terminals[0])
	if got := awaitQueueValue(t, controls); got.RequestId != "active" || got.Type != "cancelled" || got.ErrorCode != "" {
		t.Fatalf("active canonical cancellation = %#v", got)
	}
	if got := awaitQueueValue(t, backend.startRequests); got != "continue" {
		t.Fatalf("continue backend prompt = %q", got)
	}
	if got := awaitQueueValue(t, controls); got.RequestId != "continue" || got.Type != "started" {
		t.Fatalf("continue started = %#v", got)
	}

	after := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "get", ConversationId: "conv-regression"})
	var afterSnapshot queueSnapshot
	if err := json.Unmarshal([]byte(after.SnapshotJSON), &afterSnapshot); err != nil || afterSnapshot.Current == nil || afterSnapshot.Current.RunID != "continue" || afterSnapshot.Current.BackendRunID != "backend-2" || afterSnapshot.Current.CancelRequested || len(afterSnapshot.Items) != 0 {
		t.Fatalf("successor canonical identity = %#v, error %v", afterSnapshot, err)
	}
	for _, stale := range []struct {
		conversation string
		run          string
	}{
		{"conv-regression", "active"},
		{"conv-regression", "backend-1"},
		{"other-conversation", "continue"},
	} {
		if cancelled, err := relay.Cancel(context.Background(), stale.conversation, stale.run); err != nil || cancelled {
			t.Fatalf("stale cancel %#v = %t, %v", stale, cancelled, err)
		}
	}
	stable := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "get", ConversationId: "conv-regression"})
	var stableSnapshot queueSnapshot
	if err := json.Unmarshal([]byte(stable.SnapshotJSON), &stableSnapshot); err != nil || stableSnapshot.Current == nil || stableSnapshot.Current.RunID != "continue" || stableSnapshot.Current.BackendRunID != "backend-2" || stableSnapshot.Current.CancelRequested {
		t.Fatalf("stale cancel changed successor identity = %#v, error %v", stableSnapshot, err)
	}
	select {
	case <-backend.cancelSeen:
		t.Fatal("stale cancel reached the backend")
	case got := <-controls:
		t.Fatalf("stale cancel emitted a control = %#v", got)
	case <-time.After(100 * time.Millisecond):
	}

	close(backend.terminals[1])
	if got := awaitQueueValue(t, controls); got.RequestId != "continue" || got.Type != "completed" {
		t.Fatalf("continue completion = %#v", got)
	}
	awaitQueueIdle(t, relay)
}

func TestRelayRunNowCancelTimeoutDoesNotDispatchHTTP(t *testing.T) {
	relay, backend := newQueueHTTPBackend(t)
	close(backend.acceptFirst)
	controls := make(chan *gatewayv2.ChatControlEvent, 10)
	cb := Callbacks{OnControl: func(_ string, event *gatewayv2.ChatControlEvent) { controls <- event }}
	for _, id := range []string{"active", "queued"} {
		if _, err := relay.Start(context.Background(), id, "conv-regression", "request-"+id, PromptRequest{Prompt: id}, "append", cb); err != nil {
			t.Fatal(err)
		}
	}
	awaitQueueValue(t, backend.startRequests)
	if got := awaitQueueValue(t, controls); got.Type != "started" {
		t.Fatalf("first control = %#v", got)
	}
	response := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "run_now", ConversationId: "conv-regression", ItemId: "queued", Revision: 1})
	if !response.Accepted {
		t.Fatalf("run_now = %#v", response)
	}
	awaitQueueValue(t, backend.cancelSeen)
	select {
	case got := <-controls:
		if got.RequestId != "active" || got.Type != "cancelled" || got.ErrorCode != "cancel_timeout" {
			t.Fatalf("timeout terminal = %#v", got)
		}
	case prompt := <-backend.startRequests:
		t.Fatalf("StartRun before cancellation confirmation: %s", prompt)
	case <-time.After(7 * time.Second):
		t.Fatal("cancel watchdog did not report timeout")
	}
	select {
	case prompt := <-backend.startRequests:
		t.Fatalf("StartRun after unconfirmed cancel timeout: %s", prompt)
	case got := <-controls:
		t.Fatalf("unexpected control after cancel timeout: %#v", got)
	case <-time.After(100 * time.Millisecond):
	}
	assertQueueSnapshot(t, relay, 2, "queued")
	relay.mu.Lock()
	active := relay.activeRuns["conv-regression"]
	relay.mu.Unlock()
	if active != "active" {
		t.Fatalf("unconfirmed active owner = %q", active)
	}
}
