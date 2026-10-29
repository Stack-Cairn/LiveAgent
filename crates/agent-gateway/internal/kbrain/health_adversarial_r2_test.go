package kbrain

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Round 2, byte level: the same base64 bodies go through the TS
// (kbrain-health-adversarial-r2.test.mjs) and Rust
// (src-tauri/tests/kbrain_health_adversarial_r2.rs) hosts.
func TestR2HealthByteEncodingMatchesOtherHosts(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "agent-gui", "test", "chat", "kbrain-health-adversarial-r2-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Bodies []struct {
			Name   string `json:"name"`
			Base64 string `json:"base64"`
			Expect string `json:"expect"`
		} `json:"bodies"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, vector := range doc.Bodies {
		t.Run(vector.Name, func(t *testing.T) {
			body, err := base64.StdEncoding.DecodeString(vector.Base64)
			if err != nil {
				t.Fatal(err)
			}
			health, err := ParseHealth(body)
			if vector.Expect == "reject" && err == nil {
				t.Fatalf("Gateway accepted a body Rust rejects: %+v", health)
			}
		})
	}
}

// verifiedHealth keeps handshakeMu locked across the network request, and
// sync.Mutex cannot observe a context. A run whose own context is cancelled (or
// times out) while another run's health probe is slow stays blocked until that
// probe returns. The default New(..., nil) client has no timeout.
func TestR2WaitingRunIgnoresItsCancellationWhileAnotherProbeHoldsHandshake(t *testing.T) {
	release := make(chan struct{})
	var healthCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/health":
			if healthCalls.Add(1) == 1 {
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
			}
			_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1","capabilities":{}}`))
		default:
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","conversation_id":"session","run_id":"run","accepted_seq":1}`))
		}
	}))
	defer server.Close()
	client, err := New(server.URL, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	defer func() { close(release); wg.Wait() }()
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _, _ = client.StartRun(context.Background(), "session", PromptRequest{ConversationID: "session", ClientRequestID: "slow", Prompt: "a"})
	}()
	for healthCalls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, _, err := client.StartRun(ctx, "session", PromptRequest{ConversationID: "session", ClientRequestID: "cancelled", Prompt: "b"})
		done <- err
	}()
	select {
	case err := <-done:
		// The run must not queue behind the hung probe: it either finishes its
		// own handshake in time or reports its own deadline.
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("run behind a hung probe returned %v, want success or its own context error", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run with a 50ms deadline is still blocked after 2s behind another run's health probe")
	}
}

// The S1 fix enforces the handshake in StartRun, but compatible backends (the
// production path since session_queue) submit through startBackendQueuedRun,
// which never handshakes. A Gateway whose persisted queue state says
// backend-owned keeps that ownership when EnableBackendQueue fails with
// ErrHealthContract, so it keeps posting prompts to a backend that declares
// protocol major 2.
func TestR2PersistedBackendQueueSubmitsToContradictingBackend(t *testing.T) {
	var contradict atomic.Bool
	var mu sync.Mutex
	var queuePosts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/health":
			if contradict.Load() {
				_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1","protocol":{"name":"kbrain.agent","major":2,"minor":0},"capabilities":{"session_queue":1}}`))
				return
			}
			_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1","capabilities":{"session_queue":1}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sessions":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"session"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sessions/session/queue":
			mu.Lock()
			queuePosts++
			mu.Unlock()
			_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","accepted":true,"snapshot":{"conversationId":"session","revision":1,"items":[]},"receipt":{"id":"item","state":"queued"}}`))
		default:
			_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","accepted":true,"snapshot":{"conversationId":"session","revision":1,"items":[]},"receipt":{"id":"item","state":"queued"}}`))
		}
	}))
	defer server.Close()
	queuePath := filepath.Join(t.TempDir(), "queue.json")

	client, _ := New(server.URL, "", server.Client())
	first, err := NewRelayWithQueueState(client, "target", ModelRef{Model: "m"}, "", queuePath, Callbacks{})
	if err != nil {
		t.Fatal(err)
	}
	if err := first.EnableBackendQueue(context.Background(), Callbacks{}); err != nil || !first.usesBackendQueue() {
		t.Fatalf("precondition: K0 backend takes queue ownership, err=%v", err)
	}
	first.Close()

	contradict.Store(true)
	client2, _ := New(server.URL, "", server.Client())
	relay, err := NewRelayWithQueueState(client2, "target", ModelRef{Model: "m"}, "", queuePath, Callbacks{})
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	if err := relay.EnableBackendQueue(context.Background(), Callbacks{}); !errors.Is(err, ErrHealthContract) {
		t.Fatalf("precondition: startup negotiation reports the contract violation, got %v", err)
	}
	_, err = relay.Start(context.Background(), "gateway-run", "conv", "request", PromptRequest{Prompt: "hello"}, "append", Callbacks{})
	mu.Lock()
	posts := queuePosts
	mu.Unlock()
	if posts != 0 || !errors.Is(err, ErrHealthContract) {
		t.Fatalf("%s", fmt.Sprintf("prompt reached a protocol-major-2 backend through the backend queue: queue POSTs=%d err=%v", posts, err))
	}
}
