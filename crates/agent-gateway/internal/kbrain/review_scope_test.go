package kbrain

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// K-brain with capability ai_review_per_run accepts review_scope "per_run" (the composer's
// permission mode alone decides AI review). Older backends reject unknown run options, so the
// field is added only when the handshake proves the capability, without touching the
// caller's options.
func TestStartRunOptsIntoPerRunReviewOnlyWithCapability(t *testing.T) {
	for name, tc := range map[string]struct {
		health string
		want   string
	}{
		"per-run backend": {`{"status":"ok","version":"kbrain.agent.v1","capabilities":{"permission_modes":["auto_review"],"ai_review_per_run":1}}`, "per_run"},
		"older backend":   {`{"status":"ok","version":"kbrain.agent.v1","capabilities":{"permission_modes":["auto_review"]}}`, ""},
		"no health":       {"", ""},
	} {
		t.Run(name, func(t *testing.T) {
			var mu sync.Mutex
			var scope *string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/health" {
					if tc.health == "" {
						http.NotFound(w, r)
						return
					}
					_, _ = io.WriteString(w, tc.health)
					return
				}
				var body struct {
					Options map[string]any `json:"options"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				value, _ := body.Options["review_scope"].(string)
				mu.Lock()
				scope = &value
				mu.Unlock()
				w.WriteHeader(http.StatusAccepted)
				_, _ = io.WriteString(w, `{"version":"kbrain.agent.v1","conversation_id":"session","run_id":"run","accepted_seq":1}`)
			}))
			defer server.Close()
			client := &Client{BaseURL: server.URL, HTTP: server.Client()}
			options := &RunOptions{Mode: "agent", PermissionMode: "normal"}
			if _, _, err := client.StartRun(context.Background(), "session", PromptRequest{ConversationID: "session", Prompt: "hi", Options: options}); err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			defer mu.Unlock()
			if scope == nil || *scope != tc.want {
				t.Fatalf("review_scope = %v, want %q", scope, tc.want)
			}
			if options.ReviewScope != "" {
				t.Fatalf("caller options mutated: %+v", options)
			}
		})
	}
}
