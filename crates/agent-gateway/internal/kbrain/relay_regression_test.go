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

func TestRelayReusesSessionAndAdvancesAcceptedSequenceAcrossTurns(t *testing.T) {
	var mu sync.Mutex
	runCount := 0
	var after []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch {
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(w, `{"version":"kbrain.agent.v1","id":"session-1"}`)
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions/session-1/runs":
			mu.Lock()
			runCount++
			run := runCount
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_, _ = fmt.Fprintf(w, `{"version":"kbrain.agent.v1","conversation_id":"session-1","run_id":"run-%d","accepted_seq":%d}`, run, 1+3*(run-1))
		case req.Method == http.MethodGet && req.URL.Path == "/v1/sessions/session-1/events":
			mu.Lock()
			after = append(after, req.URL.Query().Get("after_seq"))
			run := runCount
			mu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			for i, typ := range []string{"run.accepted", "assistant.text.delta", "run.completed"} {
				seq := 1 + 3*(run-1) + i
				payload := `{"text":"turn"}`
				if typ == "run.completed" {
					payload = `{}`
				}
				_, _ = fmt.Fprintf(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":%d,\"conversation_id\":\"session-1\",\"run_id\":\"run-%d\",\"type\":\"%s\",\"payload\":%s}\n\n", seq, run, typ, payload)
			}
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
	for i := 0; i < 2; i++ {
		done := make(chan struct{})
		_, err = relay.Start(context.Background(), fmt.Sprintf("gateway-%d", i), "conversation-1", fmt.Sprintf("request-%d", i), PromptRequest{Prompt: "hello"}, "auto", Callbacks{OnControl: func(_ string, control *gatewayv2.ChatControlEvent) {
			if control.Type == "completed" {
				close(done)
			}
		}})
		if err != nil {
			t.Fatal(err)
		}
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("relay turn did not complete")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if runCount != 2 {
		t.Fatalf("run count=%d, want 2", runCount)
	}
	if len(after) != 2 || after[0] != "0" || after[1] != "3" {
		t.Fatalf("after_seq=%v, want [0 3]", after)
	}
}
