package kbrain

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPermissionModeCapabilityBeforeSubmission(t *testing.T) {
	for _, mode := range []string{"always", "auto_edit", "auto_review"} {
		t.Run(mode, func(t *testing.T) {
			supported := false
			posts := 0
			input := PromptRequest{ConversationID: "session", ClientRequestID: "stable-request", Prompt: "hello", Options: &RunOptions{Mode: "agent", PermissionMode: mode}}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer token" {
					t.Error("missing backend authorization")
				}
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v1/health":
					modes := []string{}
					if supported {
						modes = append(modes, mode)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "version": protocolVersion, "capabilities": map[string]any{"permission_modes": modes}})
				case "/v1/sessions/session/runs":
					posts++
					var got PromptRequest
					if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
						t.Error(err)
					}
					if got.ConversationID != input.ConversationID || got.ClientRequestID != input.ClientRequestID || got.Options == nil || got.Options.PermissionMode != mode {
						t.Errorf("request changed: %+v", got)
					}
					w.WriteHeader(http.StatusAccepted)
					_ = json.NewEncoder(w).Encode(RunAccepted{Version: protocolVersion, ConversationID: "session", RunID: "run", AcceptedSeq: 1})
				default:
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()
			client, err := New(srv.URL, "token", srv.Client())
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := client.StartRun(context.Background(), "session", input); err == nil || !strings.Contains(err.Error(), "update the backend") {
				t.Fatalf("unsupported mode accepted: %v", err)
			}
			if posts != 0 {
				t.Fatal("unsupported mode submitted a run")
			}
			supported = true
			if _, status, err := client.StartRun(context.Background(), "session", input); err != nil || status != http.StatusAccepted {
				t.Fatalf("supported mode rejected: %d %v", status, err)
			}
			if posts != 1 {
				t.Fatalf("submitted %d runs", posts)
			}
		})
	}
}
