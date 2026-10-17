package kbrain

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestQueueEditDispatchesWhenActiveFinishesDuringEdit(t *testing.T) {
	for _, action := range []string{"edit_commit", "edit_cancel"} {
		for _, failPersistence := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/persistence_failure=%t", action, failPersistence), func(t *testing.T) {
				firstStreaming := make(chan struct{})
				releaseFirst := make(chan struct{})
				var releaseOnce sync.Once
				release := func() { releaseOnce.Do(func() { close(releaseFirst) }) }
				defer release()
				requests := make(chan PromptRequest, 4)
				terminals := make(chan string, 4)
				var starts atomic.Int32
				backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					switch {
					case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions":
						w.WriteHeader(http.StatusCreated)
						fmt.Fprint(w, `{"id":"session-edit"}`)
					case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions/session-edit/runs":
						var prompt PromptRequest
						if err := json.NewDecoder(req.Body).Decode(&prompt); err != nil {
							t.Error(err)
							http.Error(w, "bad request", 400)
							return
						}
						n := starts.Add(1)
						requests <- prompt
						w.WriteHeader(http.StatusAccepted)
						fmt.Fprintf(w, `{"version":"kbrain.agent.v1","conversation_id":"session-edit","run_id":"backend-%d","accepted_seq":%d}`, n, n*2-1)
					case req.Method == http.MethodGet && req.URL.Path == "/v1/sessions/session-edit/events":
						after, _ := strconv.Atoi(req.URL.Query().Get("after_seq"))
						n := after/2 + 1
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprintf(w, "data: {\"version\":\"kbrain.agent.v1\",\"conversation_id\":\"session-edit\",\"run_id\":\"backend-%d\",\"seq\":%d,\"type\":\"run.accepted\"}\n\n", n, n*2-1)
						w.(http.Flusher).Flush()
						if n == 1 {
							close(firstStreaming)
							select {
							case <-releaseFirst:
							case <-req.Context().Done():
								return
							}
						}
						fmt.Fprintf(w, "data: {\"version\":\"kbrain.agent.v1\",\"conversation_id\":\"session-edit\",\"run_id\":\"backend-%d\",\"seq\":%d,\"type\":\"run.completed\"}\n\n", n, n*2)
					default:
						http.NotFound(w, req)
					}
				}))
				defer backend.Close()
				defer release()
				client, err := New(backend.URL, "", backend.Client())
				if err != nil {
					t.Fatal(err)
				}
				queuePath := filepath.Join(t.TempDir(), "queue.json")
				relay, err := NewRelayWithQueueState(client, "target", ModelRef{Provider: "fixture", Model: "model"}, "/workspace", queuePath, Callbacks{})
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				cb := Callbacks{OnControl: func(id string, c *gatewayv2.ChatControlEvent) {
					if c.Type == "completed" {
						terminals <- id
					}
				}}
				if queued, err := relay.Start(ctx, "first", "conv", "request-first", PromptRequest{Prompt: "first"}, "auto", cb); err != nil || queued {
					t.Fatalf("start first: %v %v", queued, err)
				}
				select {
				case <-firstStreaming:
				case <-time.After(2 * time.Second):
					t.Fatal("first stream did not start")
				}
				<-requests
				if queued, err := relay.Start(ctx, "second", "conv", "request-second", PromptRequest{Prompt: "original"}, "append", cb); err != nil || !queued {
					t.Fatalf("queue second: %v %v", queued, err)
				}
				begin := relay.Queue(ctx, &gatewayv2.ChatQueueRequest{Action: "edit_begin", ConversationId: "conv", ItemId: "second"})
				if !begin.Accepted {
					t.Fatalf("begin: %#v", begin)
				}
				release()
				select {
				case id := <-terminals:
					if id != "first" {
						t.Fatalf("first terminal: %s", id)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("first did not complete")
				}
				deadline := time.Now().Add(2 * time.Second)
				for {
					relay.mu.Lock()
					idle := relay.activeRuns["conv"] == ""
					relay.mu.Unlock()
					if idle {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("first owner not released")
					}
					time.Sleep(time.Millisecond)
				}
				request := &gatewayv2.ChatQueueRequest{Action: action, ConversationId: "conv", ItemId: "second", Revision: begin.Revision, DraftJson: `{"text":"edited"}`, UploadedFilesJson: `[]`}
				if failPersistence {
					// A regular file cannot serve as the parent directory for the state file.
					blocker := filepath.Join(t.TempDir(), "blocker")
					if err := os.WriteFile(blocker, []byte("block"), 0600); err != nil {
						t.Fatal(err)
					}
					relay.mu.Lock()
					relay.queuePath = filepath.Join(blocker, "queue.json")
					relay.mu.Unlock()
					failed := relay.Queue(ctx, request)
					if failed.Accepted || failed.ErrorCode != "persistence_error" {
						t.Fatalf("failed save: %#v", failed)
					}
					relay.mu.Lock()
					_, editRestored := relay.queueEdits["conv\x00second"]
					rollbackOK := editRestored && relay.activeRuns["conv"] == "" && relay.runs["second"] == nil && len(relay.queues["conv"]) == 0
					relay.queuePath = queuePath
					relay.mu.Unlock()
					if !rollbackOK {
						t.Fatal("failed persistence did not restore edit and idle owner")
					}
					if starts.Load() != 1 {
						t.Fatal("failed persistence dispatched the queued run")
					}
				}
				result := relay.Queue(ctx, request)
				if !result.Accepted {
					t.Fatalf("finish edit: %#v", result)
				}
				select {
				case prompt := <-requests:
					expected := "original"
					if action == "edit_commit" {
						expected = "edited"
					}
					if prompt.Prompt != expected || prompt.ClientRequestID != "request-second" {
						t.Fatalf("resumed request: %#v", prompt)
					}
					t.Logf("%s accepted; resumed prompt=%q request_id=%q", action, prompt.Prompt, prompt.ClientRequestID)
				case <-time.After(time.Second):
					relay.mu.Lock()
					active, queued := relay.activeRuns["conv"], len(relay.queues["conv"])
					relay.mu.Unlock()
					t.Fatalf("edit accepted but no second backend request: active=%q queued=%d starts=%d", active, queued, starts.Load())
				}
				select {
				case id := <-terminals:
					if id != "second" {
						t.Fatalf("second terminal: %s", id)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("resumed run did not complete")
				}
				if starts.Load() != 2 {
					t.Fatalf("backend starts=%d, want exactly two", starts.Load())
				}
			})
		}
	}
}
