package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

type healthVector struct {
	Name               string          `json:"name"`
	Body               json.RawMessage `json:"body"`
	Legacy             bool            `json:"legacy"`
	Minor              int64           `json:"minor"`
	BuildVersion       string          `json:"buildVersion"`
	InstanceID         string          `json:"instanceId"`
	CapabilityRevision *int64          `json:"capabilityRevision"`
}

func loadHealthVectors(t *testing.T) (accept, reject []healthVector) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "agent-ui", "src", "lib", "kbrain", "health-contract-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Accept []healthVector `json:"accept"`
		Reject []healthVector `json:"reject"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Accept, doc.Reject
}

func TestParseHealthSharedVectors(t *testing.T) {
	accept, reject := loadHealthVectors(t)
	for _, vector := range accept {
		health, err := ParseHealth(vector.Body)
		if err != nil {
			t.Fatalf("%s should be accepted: %v", vector.Name, err)
		}
		if health.Legacy != vector.Legacy || health.ProtocolMinor != vector.Minor {
			t.Fatalf("%s parsed as legacy=%v minor=%d", vector.Name, health.Legacy, health.ProtocolMinor)
		}
		if vector.BuildVersion != "" && health.BuildVersion != vector.BuildVersion {
			t.Fatalf("%s build = %q", vector.Name, health.BuildVersion)
		}
		if vector.InstanceID != "" && health.InstanceID != vector.InstanceID {
			t.Fatalf("%s instance = %q", vector.Name, health.InstanceID)
		}
		if vector.CapabilityRevision != nil && (health.CapabilityRevision == nil || *health.CapabilityRevision != *vector.CapabilityRevision) {
			t.Fatalf("%s capabilityRevision = %v", vector.Name, health.CapabilityRevision)
		}
	}
	for _, vector := range reject {
		if _, err := ParseHealth(vector.Body); !errors.Is(err, ErrHealthContract) {
			t.Fatalf("%s should be rejected as a contract violation, got %v", vector.Name, err)
		}
	}
}

func TestHealthCapabilityComparisons(t *testing.T) {
	health := Health{Capabilities: map[string]any{
		"session_queue":    json.Number("1"),
		"session_exists":   json.Number("2"),
		"session_changes":  json.Number("3"),
		"memory_switch":    "1",
		"permission_modes": []any{"normal", "auto_review"},
	}}
	if !health.FrozenCapability("session_queue") || health.FrozenCapability("session_exists") || health.FrozenCapability("memory_switch") {
		t.Fatal("frozen capabilities must be exactly integer 1")
	}
	if !health.CapabilityAtLeast("session_changes", 2) || health.CapabilityAtLeast("missing", 2) {
		t.Fatal("monotonic capability comparison is wrong")
	}
	if !health.SupportsPermissionMode("auto_review") || health.SupportsPermissionMode("always") {
		t.Fatal("permission mode membership is wrong")
	}
}

// A03: a health body whose protocol contradicts kbrain.agent.v1 stops an
// elevated-permission run before anything is posted.
func TestStartRunRejectsContradictingHealthBeforePosting(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1","protocol":{"name":"kbrain.agent","major":2,"minor":0},"capabilities":{"permission_modes":["auto_review"]}}`))
	}))
	defer server.Close()
	client := &Client{BaseURL: server.URL, HTTP: server.Client()}
	_, _, err := client.StartRun(context.Background(), "session", PromptRequest{ConversationID: "session", ClientRequestID: "stable", Prompt: "hi", Options: &RunOptions{Mode: "agent", PermissionMode: "auto_review"}})
	if !errors.Is(err, ErrHealthContract) {
		t.Fatalf("StartRun error = %v, want health contract violation", err)
	}
	if len(paths) != 1 || paths[0] != "/v1/health" {
		t.Fatalf("requests = %v, want only the health probe", paths)
	}
}

// A broken handshake is reported to the relay (history unavailable + backoff)
// instead of silently downgrading to the five-minute legacy poll.
func TestSessionChangesReportsBrokenHealth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1","protocol":null,"capabilities":{"session_changes":2}}`))
	}))
	defer server.Close()
	client := &Client{BaseURL: server.URL, HTTP: server.Client()}
	supported, err := client.supportsSessionChanges(context.Background())
	if !errors.Is(err, ErrHealthContract) || supported {
		t.Fatalf("broken health: supported=%v err=%v, want ErrHealthContract", supported, err)
	}
}

// Relays that 404 /v1/health claim no contract: normal runs proceed as before,
// elevated modes are refused because no capability can be proven.
func TestStartRunWithoutHealthEndpointKeepsNormalModeOnly(t *testing.T) {
	var mu sync.Mutex
	var posts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/health" {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		posts++
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","conversation_id":"session","run_id":"run","accepted_seq":1}`))
	}))
	defer server.Close()
	client := &Client{BaseURL: server.URL, HTTP: server.Client()}
	if _, _, err := client.StartRun(context.Background(), "session", PromptRequest{ConversationID: "session", Prompt: "hi", Options: &RunOptions{PermissionMode: "auto_review"}}); err == nil {
		t.Fatal("elevated mode accepted without a provable capability")
	}
	if _, _, err := client.StartRun(context.Background(), "session", PromptRequest{ConversationID: "session", Prompt: "hi"}); err != nil {
		t.Fatalf("normal run without health endpoint: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if posts != 1 {
		t.Fatalf("posts = %d, want only the normal-mode run", posts)
	}
}

// Positive handshakes are reused inside the cache window; endpoint changes
// always trigger a fresh probe.
func TestStartRunCachesHandshakePerEndpoint(t *testing.T) {
	var healthCalls atomic.Int32
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/health" {
			healthCalls.Add(1)
			_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1","capabilities":{"permission_modes":["auto_review"]}}`))
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","conversation_id":"session","run_id":"run","accepted_seq":1}`))
	})
	first := httptest.NewServer(handler)
	defer first.Close()
	second := httptest.NewServer(handler)
	defer second.Close()
	client := &Client{BaseURL: first.URL, HTTP: first.Client()}
	input := PromptRequest{ConversationID: "session", Prompt: "hi", Options: &RunOptions{PermissionMode: "auto_review"}}
	for i := 0; i < 3; i++ {
		if _, _, err := client.StartRun(context.Background(), "session", input); err != nil {
			t.Fatal(err)
		}
	}
	if got := healthCalls.Load(); got != 1 {
		t.Fatalf("health calls = %d, want 1 inside the cache window", got)
	}
	client.BaseURL = second.URL
	if _, _, err := client.StartRun(context.Background(), "session", input); err != nil {
		t.Fatal(err)
	}
	if got := healthCalls.Load(); got != 2 {
		t.Fatalf("health calls = %d after endpoint change, want 2", got)
	}
}

// The BOM check must reject exactly EF BB BF, independent of JSON decoding.
func TestParseHealthRejectsByteOrderMarkExplicitly(t *testing.T) {
	_, err := ParseHealth(append([]byte{0xef, 0xbb, 0xbf}, []byte(`{"status":"ok","version":"kbrain.agent.v1"}`)...))
	if err == nil || !errors.Is(err, ErrHealthContract) || !strings.Contains(err.Error(), "byte order mark") {
		t.Fatalf("BOM body error = %v, want the explicit byte order mark violation", err)
	}
}
