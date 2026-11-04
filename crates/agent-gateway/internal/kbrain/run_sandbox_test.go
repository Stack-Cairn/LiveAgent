package kbrain

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A sandboxed run reaches the backend only when /v1/health says the sandbox can
// be enforced; otherwise it is refused before any POST, never sent unconfined.
func TestRunSandboxCapabilityBeforeSubmission(t *testing.T) {
	for _, tc := range []struct {
		name       string
		network    bool
		capability any
		want       string
	}{
		{"backend without capability", true, nil, "update the backend"},
		{"unsupported machine", true, map[string]any{"supported": false, "network_control": false}, "cannot sandbox commands"},
		{"offline without network control", false, map[string]any{"supported": true, "network_control": false}, "offline sandbox"},
		{"networked sandbox", true, map[string]any{"supported": true, "network_control": false}, ""},
		{"offline sandbox", false, map[string]any{"supported": true, "network_control": true}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			posts := 0
			input := PromptRequest{ConversationID: "session", ClientRequestID: "request", Prompt: "hello", Options: &RunOptions{
				Mode: "agent", PermissionMode: "auto_edit", Sandbox: &RunSandbox{Mode: "workspace", Network: tc.network},
			}}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v1/health":
					capabilities := map[string]any{"permission_modes": []string{"auto_edit"}}
					if tc.capability != nil {
						capabilities["run_sandbox"] = tc.capability
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "version": protocolVersion, "capabilities": capabilities})
				case "/v1/sessions/session/runs":
					posts++
					var got PromptRequest
					if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
						t.Error(err)
					}
					if got.Options == nil || got.Options.Sandbox == nil || got.Options.Sandbox.Network != tc.network || got.Options.Sandbox.Mode != "workspace" {
						t.Errorf("sandbox not forwarded: %+v", got.Options)
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
			_, _, err = client.StartRun(context.Background(), "session", input)
			if tc.want != "" {
				if err == nil || !strings.Contains(err.Error(), tc.want) || posts != 0 {
					t.Fatalf("err=%v posts=%d, want refusal %q before POST", err, posts, tc.want)
				}
				return
			}
			if err != nil || posts != 1 {
				t.Fatalf("err=%v posts=%d, want one accepted run", err, posts)
			}
		})
	}
}
