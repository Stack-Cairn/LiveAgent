package kbrain

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// Review: against any K-brain with session_queue (EnableBackendQueue), every WebUI run that is
// not a composer command goes StartWithCWD -> startBackendQueuedRun -> POST /queue, never
// through StartRun. The queued request must still opt into per-run review on a backend with
// ai_review_per_run, or WebUI runs keep following the global setting the UI now hides.
func TestBackendQueuedRunOptsIntoPerRunReview(t *testing.T) {
	var mu sync.Mutex
	var scope *string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch req.URL.Path {
		case "/v1/health":
			w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1","capabilities":{"session_queue":1,"ai_review_per_run":1,"permission_modes":["normal","auto_review"]}}`))
		case "/v1/sessions":
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte(`{"id":"session"}`))
		case "/v1/sessions/session/queue":
			var body struct {
				Request struct {
					Options map[string]any `json:"options"`
				} `json:"request"`
			}
			_ = json.NewDecoder(req.Body).Decode(&body)
			value, _ := body.Request.Options["review_scope"].(string)
			mu.Lock()
			scope = &value
			mu.Unlock()
			// Reject definitively so no recovery watcher is left running.
			w.WriteHeader(http.StatusConflict)
			w.Write([]byte(`{"accepted":false,"error_code":"queue_full","message":"stop here"}`))
		default:
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
	options := &RunOptions{Mode: "agent", ApprovalPolicy: "ask", PermissionMode: "normal"}
	_, _ = relay.StartWithCWD(context.Background(), "gateway-run", "conversation", "request", t.TempDir(), PromptRequest{Prompt: "hi", Options: options}, "append", Callbacks{})
	mu.Lock()
	defer mu.Unlock()
	if scope == nil {
		t.Fatal("queued run never reached /queue")
	}
	if *scope != "per_run" {
		t.Fatalf("queued WebUI run review_scope = %q, want per_run", *scope)
	}
}
