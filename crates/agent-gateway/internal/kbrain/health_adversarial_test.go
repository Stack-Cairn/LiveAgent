package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

type adversarialHealthBody struct {
	Name      string `json:"name"`
	Raw       string `json:"raw"`
	Expect    string `json:"expect"`
	Minor     int64  `json:"minor"`
	Transport bool   `json:"transport"`
}

type adversarialCapability struct {
	Name    string           `json:"name"`
	Raw     string           `json:"raw"`
	AtLeast map[string]int64 `json:"atLeast"`
	Frozen  string           `json:"frozen"`
	Expect  bool             `json:"expect"`
}

func loadAdversarialHealth(t *testing.T) ([]adversarialHealthBody, []adversarialCapability) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "agent-gui", "test", "chat", "kbrain-health-adversarial-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Bodies       []adversarialHealthBody `json:"bodies"`
		Capabilities []adversarialCapability `json:"capabilities"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Bodies, doc.Capabilities
}

// The same raw bodies go through the TS parser (kbrain-health-adversarial.test.mjs)
// and the Rust parser (src-tauri/tests/kbrain_health_adversarial.rs). Every row
// must get the same verdict on all three hosts.
func TestAdversarialHealthBodiesMatchOtherHosts(t *testing.T) {
	bodies, _ := loadAdversarialHealth(t)
	for _, vector := range bodies {
		t.Run(vector.Name, func(t *testing.T) {
			health, err := ParseHealth([]byte(vector.Raw))
			switch vector.Expect {
			case "accept":
				if err != nil {
					t.Fatalf("Gateway rejected a body the TS host accepts: %v", err)
				}
				if health.ProtocolMinor != vector.Minor {
					t.Fatalf("minor = %d, want %d", health.ProtocolMinor, vector.Minor)
				}
			case "reject":
				if err == nil {
					t.Fatalf("Gateway accepted a body the other hosts reject: %+v", health)
				}
			}
		})
	}
}

func TestAdversarialCapabilityComparisonsMatchTS(t *testing.T) {
	_, capabilities := loadAdversarialHealth(t)
	for _, vector := range capabilities {
		t.Run(vector.Name, func(t *testing.T) {
			health, err := ParseHealth([]byte(vector.Raw))
			if err != nil {
				t.Fatal(err)
			}
			got := false
			if vector.Frozen != "" {
				got = health.FrozenCapability(vector.Frozen)
			}
			for name, minimum := range vector.AtLeast {
				got = health.CapabilityAtLeast(name, minimum)
			}
			if got != vector.Expect {
				t.Fatalf("Gateway capability check = %v, TS hasFrozenCapability/capabilityAtLeast = %v", got, vector.Expect)
			}
		})
	}
}

// history_sync.go justifies `false, nil` on a broken handshake with "runs on the
// same backend are rejected by StartRun's handshake instead". StartRun only probes
// health for always/auto_edit/auto_review, so a backend that declares protocol
// major 2 still accepts every normal-mode prompt through the Gateway while the
// desktop (Rust wait_for_health, TS bootstrap) refuses to connect to it at all.
func TestAdversarialContradictingHealthStillRunsNormalModePrompts(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/health":
			_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1","protocol":{"name":"kbrain.agent","major":2,"minor":0},"capabilities":{"session_changes":2,"permission_modes":["normal","auto_review"]}}`))
		case "/v1/sessions/session/runs":
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","conversation_id":"session","run_id":"run-1","accepted_seq":1}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := &Client{BaseURL: server.URL, HTTP: server.Client()}

	supported, err := client.supportsSessionChanges(context.Background())
	if !errors.Is(err, ErrHealthContract) || supported {
		t.Fatalf("broken health must be reported to history sync, got supported=%v err=%v", supported, err)
	}
	_, _, err = client.StartRun(context.Background(), "session", PromptRequest{
		ConversationID: "session", ClientRequestID: "normal-mode", Prompt: "hi",
		Options: &RunOptions{Mode: "agent", PermissionMode: "normal"},
	})
	mu.Lock()
	defer mu.Unlock()
	if !errors.Is(err, ErrHealthContract) {
		t.Fatalf("normal-mode run against a protocol-major-2 backend: err=%v requests=%v; want ErrHealthContract before POST /runs", err, paths)
	}
}
