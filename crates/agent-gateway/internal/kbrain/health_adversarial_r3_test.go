package kbrain

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

const r3ContradictingHealth = `{"status":"ok","version":"kbrain.agent.v1","protocol":{"name":"kbrain.agent","major":2,"minor":0},"capabilities":{"session_queue":1}}`

type r3Backend struct {
	mu       sync.Mutex
	requests []string
}

func (b *r3Backend) record(r *http.Request) {
	b.mu.Lock()
	b.requests = append(b.requests, r.Method+" "+r.URL.Path)
	b.mu.Unlock()
}

func (b *r3Backend) list() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.requests...)
}

func (b *r3Backend) saw(prefix string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, request := range b.requests {
		if strings.HasPrefix(request, prefix) {
			return true
		}
	}
	return false
}

// sessionQueue gates every non-GET with requireHandshake, which also blocks
// requests that stop work. Against a backend whose health turned contradictory,
// a running run can still be cancelled (CancelRun has no gate), but a queued
// item cannot be removed and the queue cannot be paused, so K-brain will still
// dequeue and execute work the user tried to stop.
func TestR3StoppingQueuedWorkIsRefusedOnContradictingBackend(t *testing.T) {
	backend := &r3Backend{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backend.record(r)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/health":
			_, _ = w.Write([]byte(r3ContradictingHealth))
		default:
			_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","accepted":true,"snapshot":{"conversationId":"session","revision":3,"items":[{"id":"item"}]},"receipt":{"id":"item","state":"queued"}}`))
		}
	}))
	defer server.Close()
	client, _ := New(server.URL, "", server.Client())
	relay, _ := NewRelay(client, "target", ModelRef{Model: "m"}, "")
	defer relay.Close()
	relay.backendQueue = true
	relay.sessions["conv"] = "session"
	relay.backendRuns[conversationKey("conv", "request")] = backendQueueRun{GatewayRunID: "gateway-run", ConversationID: "conv", SessionID: "session", ClientRequestID: "request"}

	t.Run("cancel a queued item", func(t *testing.T) {
		ok, err := relay.Cancel(context.Background(), "conv", "gateway-run")
		if !ok || err != nil || !backend.saw("POST /v1/sessions/session/queue/actions") {
			t.Fatalf("queued item was not removed: ok=%v err=%v requests=%v", ok, err, backend.list())
		}
	})
	t.Run("pause the queue", func(t *testing.T) {
		response := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{ConversationId: "conv", Action: "pause"})
		if !response.Accepted {
			t.Fatalf("pause refused: %+v", response)
		}
	})
}

// Requests that start new agent work outside StartRun/queue are not gated:
// cron run-now and /loop creation both reach a protocol-major-2 backend.
func TestR3OtherNewWorkPathsSkipHandshake(t *testing.T) {
	backend := &r3Backend{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backend.record(r)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/health":
			_, _ = w.Write([]byte(r3ContradictingHealth))
		case "/v1/sessions/session/loops":
			_, _ = w.Write([]byte(`{"id":"loop-1","prompt":"check","interval":"5m"}`))
		default:
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer server.Close()
	client, _ := New(server.URL, "", server.Client())
	relay, _ := NewRelay(client, "target", ModelRef{Model: "m"}, "")
	defer relay.Close()
	relay.sessions["conv"] = "session"

	t.Run("cron run_now", func(t *testing.T) {
		_, err := client.CronManage(context.Background(), "run_now", "task", "")
		if !errors.Is(err, ErrHealthContract) || backend.saw("POST /v1/cron/task/run-now") {
			t.Fatalf("cron run-now reached a contradicting backend: err=%v requests=%v", err, backend.list())
		}
	})
	t.Run("loop create", func(t *testing.T) {
		_, err := relay.Loops(context.Background(), &gatewayv2.LoopManageRequest{ConversationId: "conv", Action: "create", Interval: "5m", Prompt: "check"})
		if !errors.Is(err, ErrHealthContract) || backend.saw("POST /v1/sessions/session/loops") {
			t.Fatalf("loop creation reached a contradicting backend: err=%v requests=%v", err, backend.list())
		}
	})
}

// Out-of-order probes: a probe that started before the backend turned
// contradictory finishes after a newer probe observed the contract violation.
// The late success is cached with its completion time and the newer violation
// is forgotten, so the next 30s of runs are posted to the contradicting backend.
func TestR3LateSuccessfulProbeOverridesNewerContractViolation(t *testing.T) {
	releaseFirst := make(chan struct{})
	var healthCalls atomic.Int32
	var runPosts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/health":
			if healthCalls.Add(1) == 1 {
				<-releaseFirst
				_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1","capabilities":{}}`))
				return
			}
			_, _ = w.Write([]byte(r3ContradictingHealth))
		default:
			runPosts.Add(1)
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","conversation_id":"session","run_id":"run","accepted_seq":1}`))
		}
	}))
	defer server.Close()
	client, _ := New(server.URL, "", server.Client())
	run := func(id string) error {
		_, _, err := client.StartRun(context.Background(), "session", PromptRequest{ConversationID: "session", ClientRequestID: id, Prompt: "x"})
		return err
	}

	firstDone := make(chan struct{})
	go func() { _ = run("first"); close(firstDone) }()
	for healthCalls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	if err := run("second"); !errors.Is(err, ErrHealthContract) {
		t.Fatalf("precondition: newer probe sees the contract violation, got %v", err)
	}
	close(releaseFirst)
	<-firstDone
	postsBefore := runPosts.Load()
	err := run("third")
	if !errors.Is(err, ErrHealthContract) || runPosts.Load() != postsBefore {
		t.Fatalf("run after an observed contract violation was accepted from a stale cached probe: err=%v", err)
	}
}
