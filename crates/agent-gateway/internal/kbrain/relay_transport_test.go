package kbrain

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestRelayRetriesTruncatedStreamBeforeDispatchingQueue(t *testing.T) {
	for _, restored := range []bool{false, true} {
		t.Run(fmt.Sprintf("restored=%t", restored), func(t *testing.T) {
			var streams, starts atomic.Int32
			firstRead := make(chan struct{})
			release := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch req.URL.Path {
				case "/v1/sessions":
					w.WriteHeader(201)
					fmt.Fprint(w, `{"id":"session-1"}`)
				case "/v1/sessions/session-1/runs":
					n := starts.Add(1)
					w.WriteHeader(202)
					fmt.Fprintf(w, `{"version":"kbrain.agent.v1","conversation_id":"session-1","run_id":"run-%d","accepted_seq":%d}`, n, n)
				case "/v1/sessions/session-1/events":
					w.Header().Set("Content-Type", "text/event-stream")
					if streams.Add(1) == 1 {
						close(firstRead)
						select {
						case <-release:
						case <-req.Context().Done():
							return
						}
						w.Header().Set("Content-Length", "9999")
						fmt.Fprint(w, ": truncated\n\n")
						return
					}
					n := starts.Load()
					fmt.Fprintf(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":%d,\"conversation_id\":\"session-1\",\"run_id\":\"run-%d\",\"type\":\"run.completed\",\"payload\":{}}\n\n", n, n)
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
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan string, 4)
			cb := Callbacks{OnControl: func(id string, c *gatewayv2.ChatControlEvent) {
				if c.Type == "failed" || c.Type == "completed" {
					done <- id + ":" + c.Type
				}
			}}
			if restored {
				starts.Store(1)
				relay.mu.Lock()
				state, _ := relay.newRunLocked(ctx, "gateway-1", "conversation-1", "request-1", cb)
				state.kbrainSessionID = "session-1"
				state.kbrainRunID = "run-1"
				state.restored = true
				relay.activeRuns["conversation-1"] = "gateway-1"
				relay.sessions["conversation-1"] = "session-1"
				relay.mu.Unlock()
				go relay.resumeRun(state)
			} else {
				if _, err = relay.Start(ctx, "gateway-1", "conversation-1", "request-1", PromptRequest{Prompt: "first"}, "auto", cb); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-firstRead:
			case <-time.After(3 * time.Second):
				t.Fatal("stream did not open")
			}
			if _, err = relay.Start(ctx, "gateway-2", "conversation-1", "request-2", PromptRequest{Prompt: "next"}, "append", cb); err != nil {
				t.Fatal(err)
			}
			if starts.Load() != 1 {
				t.Fatal("queued run started before canonical completion")
			}
			close(release)
			for _, want := range []string{"gateway-1:completed", "gateway-2:completed"} {
				select {
				case got := <-done:
					if got != want {
						t.Fatalf("terminal=%q want %q", got, want)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("conversation queue stalled after transport error")
				}
			}
			if streams.Load() != 3 || starts.Load() != 2 {
				t.Fatalf("streams=%d starts=%d", streams.Load(), starts.Load())
			}
		})
	}
}

func TestRetryableEventStreamError(t *testing.T) {
	for _, err := range []error{io.EOF, io.ErrUnexpectedEOF, context.DeadlineExceeded, &net.OpError{Op: "read", Net: "tcp", Err: errors.New("connection reset")}} {
		if !retryableEventStreamError(err) {
			t.Errorf("transport failure is not retryable: %v", err)
		}
	}
	for _, err := range []error{context.Canceled, errors.New("event sequence gap"), errors.New("invalid event protocol")} {
		if retryableEventStreamError(err) {
			t.Errorf("permanent failure is retryable: %v", err)
		}
	}
}
