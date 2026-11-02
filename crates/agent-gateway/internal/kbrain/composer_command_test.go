package kbrain

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestComposerCommandNeverUsesBackendQueue(t *testing.T) {
	var queueRequests atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch req.URL.Path {
		case "/v1/health":
			w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1"}`))
		case "/v1/sessions":
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte(`{"id":"session"}`))
		case "/v1/sessions/session/runs":
			w.WriteHeader(http.StatusConflict)
			w.Write([]byte(`{"error":"session is already running"}`))
		default:
			queueRequests.Add(1)
			http.NotFound(w, req)
		}
	}))
	defer backend.Close()
	client, err := New(backend.URL, "", backend.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "kbrain", ModelRef{Model: "fixture"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	relay.backendQueue = true
	controls := make(chan *gatewayv2.ChatControlEvent, 4)
	queued, err := relay.StartWithCWD(context.Background(), "run", "conv", "request", "", PromptRequest{Prompt: "/plan inspect"}, "append", Callbacks{OnControl: func(_ string, control *gatewayv2.ChatControlEvent) { controls <- control }}, true)
	if err != nil || queued {
		t.Fatalf("queued=%v err=%v", queued, err)
	}
	select {
	case control := <-controls:
		if control.Type != "failed" || control.ErrorCode != "conversation_busy" {
			t.Fatalf("control=%+v", control)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("missing busy rejection")
	}
	if queueRequests.Load() != 0 {
		t.Fatal("composer command submitted to backend queue")
	}
}
