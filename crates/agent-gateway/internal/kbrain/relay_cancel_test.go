package kbrain

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestRelayQueuedCancelEmitsOneTerminalAndDoesNotStartQueuedRun(t *testing.T) {
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	var releaseOnce sync.Once
	var mu sync.Mutex
	runs := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch {
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(w, `{"id":"session-queue"}`)
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions/session-queue/runs":
			mu.Lock()
			runs++
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_, _ = fmt.Fprint(w, `{"version":"kbrain.agent.v1","conversation_id":"session-queue","run_id":"backend-first","accepted_seq":1}`)
		case req.Method == http.MethodGet && req.URL.Path == "/v1/sessions/session-queue/events":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":1,\"conversation_id\":\"session-queue\",\"run_id\":\"backend-first\",\"type\":\"run.accepted\"}\n\n")
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			closeOnce(firstStarted)
			<-releaseFirst
			_, _ = fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":2,\"conversation_id\":\"session-queue\",\"run_id\":\"backend-first\",\"type\":\"run.completed\"}\n\n")
		default:
			http.NotFound(w, req)
		}
	}))
	defer srv.Close()
	client, err := New(srv.URL, "", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "target", ModelRef{Provider: "fixture", Model: "model"}, "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	firstDone := make(chan struct{})
	_, err = relay.Start(context.Background(), "gateway-first", "conversation-queue", "request-first", PromptRequest{Prompt: "first"}, "auto", Callbacks{OnControl: func(_ string, control *gatewayv2.ChatControlEvent) {
		if control.Type == "completed" {
			closeOnce(firstDone)
		}
	}})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-firstStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("first run did not start")
	}

	queuedTerminals := 0
	queuedTerminal := make(chan struct{})
	_, err = relay.Start(context.Background(), "gateway-queued", "conversation-queue", "request-queued", PromptRequest{Prompt: "queued"}, "append", Callbacks{OnControl: func(_ string, control *gatewayv2.ChatControlEvent) {
		if control.Type == "cancelled" {
			queuedTerminals++
			closeOnce(queuedTerminal)
		}
	}})
	if err != nil {
		t.Fatal(err)
	}
	cancelled, err := relay.Cancel(context.Background(), "conversation-queue", "gateway-queued")
	if err != nil || !cancelled {
		t.Fatalf("queued cancel = %v, %v", cancelled, err)
	}
	select {
	case <-queuedTerminal:
	case <-time.After(2 * time.Second):
		t.Fatal("queued cancel terminal not emitted")
	}
	if queuedTerminals != 1 {
		t.Fatalf("queued terminal count=%d, want 1", queuedTerminals)
	}
	if cancelled, _ := relay.Cancel(context.Background(), "conversation-queue", "gateway-queued"); cancelled {
		t.Fatal("second queued cancel unexpectedly matched")
	}
	mu.Lock()
	if runs != 1 {
		t.Fatalf("backend run count=%d, want 1", runs)
	}
	mu.Unlock()
	releaseOnce.Do(func() { close(releaseFirst) })
	select {
	case <-firstDone:
	case <-time.After(2 * time.Second):
		t.Fatal("first run did not complete")
	}
}

func TestRelayCancelKeepsSSEUntilBackendTerminal(t *testing.T) {
	cancelSeen := make(chan struct{})
	cancelOnce := sync.Once{}
	accepted := make(chan struct{})
	terminal := make(chan *gatewayv2.ChatControlEvent, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch {
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions":
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(w, `{"id":"session-cancel"}`)
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions/session-cancel/runs":
			w.WriteHeader(http.StatusAccepted)
			_, _ = fmt.Fprint(w, `{"version":"kbrain.agent.v1","conversation_id":"session-cancel","run_id":"backend-cancel","accepted_seq":1}`)
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions/session-cancel/runs/backend-cancel/cancel":
			cancelOnce.Do(func() { close(cancelSeen) })
			w.WriteHeader(http.StatusOK)
		case req.Method == http.MethodGet && req.URL.Path == "/v1/sessions/session-cancel/events":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":1,\"conversation_id\":\"session-cancel\",\"run_id\":\"backend-cancel\",\"type\":\"run.accepted\"}\n\n")
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			closeOnce(accepted)
			<-cancelSeen
			_, _ = fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":2,\"conversation_id\":\"session-cancel\",\"run_id\":\"backend-cancel\",\"type\":\"run.cancelled\"}\n\n")
		default:
			http.NotFound(w, req)
		}
	}))
	defer srv.Close()
	client, err := New(srv.URL, "", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "target", ModelRef{Provider: "fixture", Model: "model"}, "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	_, err = relay.Start(context.Background(), "gateway-cancel", "conversation-cancel", "request-cancel", PromptRequest{Prompt: "cancel me"}, "auto", Callbacks{OnControl: func(_ string, control *gatewayv2.ChatControlEvent) { terminal <- control }})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("run was not accepted")
	}
	matched, err := relay.Cancel(context.Background(), "conversation-cancel", "gateway-cancel")
	if err != nil || !matched {
		t.Fatalf("cancel = %v, %v", matched, err)
	}
	select {
	case got := <-terminal:
		if got.Type != "started" {
			t.Fatalf("first control=%#v, want started", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("started control not observed")
	}
	select {
	case got := <-terminal:
		if got.Type != "cancelled" || got.ErrorCode != "" {
			t.Fatalf("terminal=%#v, want backend cancelled without timeout", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("backend cancellation terminal not observed")
	}
	select {
	case extra := <-terminal:
		t.Fatalf("duplicate terminal/control=%#v", extra)
	case <-time.After(100 * time.Millisecond):
	}
}

func closeOnce(ch chan struct{}) {
	select {
	case <-ch:
	default:
		close(ch)
	}
}
