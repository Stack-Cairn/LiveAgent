package kbrain

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestRelayStartsCanonicalRunAndEmitsOrderedGatewayEvents(t *testing.T) {
	var mu sync.Mutex
	seenAfter := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/sessions":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"kb-session"}`))
		case "/v1/sessions/kb-session/runs":
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","conversation_id":"kb-session","run_id":"kb-run","accepted_seq":1}`))
		case "/v1/sessions/kb-session/events":
			mu.Lock()
			seenAfter = append(seenAfter, r.URL.Query().Get("after_seq"))
			mu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":1,\"conversation_id\":\"kb-session\",\"run_id\":\"kb-run\",\"type\":\"run.accepted\"}\n\n")
			fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":2,\"conversation_id\":\"kb-session\",\"run_id\":\"kb-run\",\"type\":\"assistant.text.delta\",\"payload\":{\"text\":\"hello\"}}\n\n")
			fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":3,\"conversation_id\":\"kb-session\",\"run_id\":\"kb-run\",\"type\":\"run.completed\",\"payload\":{\"state\":\"completed\"}}\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	client, err := New(srv.URL, "", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "kbrain", ModelRef{Provider: "fixture", Model: "fixture-model"}, "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	var muEvents sync.Mutex
	var events []*gatewayv2.ChatEvent
	var controls []*gatewayv2.ChatControlEvent
	done := make(chan struct{})
	_, err = relay.StartWithCWD(context.Background(), "gw-run", "conv-1", "client-1", "/workspace", PromptRequest{Prompt: "hello"}, "auto", Callbacks{
		OnEvent: func(_ string, event *gatewayv2.ChatEvent) {
			muEvents.Lock()
			events = append(events, event)
			muEvents.Unlock()
		},
		OnControl: func(_ string, control *gatewayv2.ChatControlEvent) {
			muEvents.Lock()
			controls = append(controls, control)
			if control.Type == "completed" {
				close(done)
			}
			muEvents.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("relay did not complete")
	}
	muEvents.Lock()
	defer muEvents.Unlock()
	if len(events) != 1 || events[0].Type != gatewayv2.ChatEvent_TOKEN {
		t.Fatalf("events=%+v", events)
	}
	if len(controls) < 2 || controls[0].Type != "started" || controls[len(controls)-1].Type != "completed" {
		t.Fatalf("controls=%+v", controls)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seenAfter) != 1 || seenAfter[0] != "0" {
		t.Fatalf("SSE cursors=%v, want accepted_seq-1", seenAfter)
	}
	_ = json.RawMessage{}
}
