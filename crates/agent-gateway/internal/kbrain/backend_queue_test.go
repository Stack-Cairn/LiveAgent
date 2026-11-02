package kbrain

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestBackendQueueRelayAgainstRealKBrain(t *testing.T) {
	binary := os.Getenv("LIVEAGENT_KBRAIN_BINARY")
	if binary == "" {
		t.Skip("set LIVEAGENT_KBRAIN_BINARY to exercise the real backend")
	}
	firstStarted := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Stream   bool                             `json:"stream"`
			Messages []struct{ Role, Content string } `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if !body.Stream {
			fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"[]"}}]}`)
			return
		}
		prompt := ""
		for _, message := range body.Messages {
			if message.Role == "user" {
				prompt = message.Content
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if strings.Contains(prompt, "hold-first") {
			once.Do(func() { close(firstStarted) })
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(provider.Close)
	root := t.TempDir()
	home := filepath.Join(root, "home")
	os.MkdirAll(home, 0700)
	config, _ := json.Marshal(map[string]any{"defaultModel": "fixture-model", "providers": map[string]any{"fixture": map[string]any{"api": "openai-completions", "baseUrl": provider.URL, "apiKey": "fixture", "models": []map[string]any{{"id": "fixture-model", "contextWindow": 32768, "maxTokens": 256}}}}})
	configPath := filepath.Join(home, "config.json")
	if err := os.WriteFile(configPath, config, 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "backend", "-listen", "127.0.0.1:0", "-token", "queue-test", "-config", configPath, "-session-dir", filepath.Join(root, "sessions"))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "LIVEAGENT_HOME="+home, "K_BRAIN_HOME=")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	address := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			if index := strings.Index(line, "k-brain backend listening on "); index >= 0 {
				select {
				case address <- strings.TrimSpace(line[index+len("k-brain backend listening on "):]):
				default:
				}
			}
		}
	}()
	var base string
	select {
	case base = <-address:
	case <-time.After(10 * time.Second):
		t.Fatal("backend did not start")
	}
	client, err := New(base, "queue-test", nil)
	if err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(root, "relay.json")
	controls := make(chan *gatewayv2.ChatControlEvent, 32)
	queues := make(chan backendQueueSnapshot, 512)
	cb := Callbacks{OnControl: func(_ string, event *gatewayv2.ChatControlEvent) { controls <- event }, OnQueue: func(_ string, raw string, _ uint64) {
		var snapshot backendQueueSnapshot
		if err := json.Unmarshal([]byte(raw), &snapshot); err != nil {
			t.Error(err)
			return
		}
		queues <- snapshot
	}}
	relay, err := NewRelayWithQueueState(client, "target", ModelRef{Provider: "fixture", Model: "fixture-model"}, root, statePath, cb)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	if err = relay.EnableBackendQueue(context.Background(), cb); err != nil {
		t.Fatal(err)
	}
	if !relay.usesBackendQueue() {
		t.Fatal("backend queue not enabled")
	}
	if _, err = relay.Start(context.Background(), "gateway-first", "conv", "request-first", PromptRequest{Prompt: "hold-first"}, "append", cb); err != nil {
		t.Fatal(err)
	}
	select {
	case <-firstStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("first model request did not start")
	}
	if _, err = relay.Start(context.Background(), "gateway-second", "conv", "request-second", PromptRequest{Prompt: "queued-second"}, "append", cb); err != nil {
		t.Fatal(err)
	}
	if _, err = relay.Start(context.Background(), "gateway-third", "conv", "request-third", PromptRequest{Prompt: "queued-third"}, "append", cb); err != nil {
		t.Fatal(err)
	}
	get := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{ConversationId: "conv", Action: "get"})
	var snapshot queueSnapshot
	if err = json.Unmarshal([]byte(get.SnapshotJSON), &snapshot); err != nil || len(snapshot.Items) != 2 || snapshot.Items[0].ID != "gateway-second" {
		t.Fatalf("backend snapshot=%+v err=%v", get, err)
	}
	stale := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{ConversationId: "conv", Action: "pause", Revision: 0})
	if stale.Accepted || stale.ErrorCode != "conflict" {
		t.Fatalf("explicit zero revision was silently replaced: %+v", stale)
	}
	paused := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{ConversationId: "conv", Action: "pause", Revision: get.Revision}, cb)
	if !paused.Accepted {
		t.Fatalf("pause=%+v", paused)
	}
	begin := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{ConversationId: "conv", Action: "edit_begin", ItemId: "gateway-second"})
	if !begin.Accepted {
		t.Fatalf("edit begin=%+v", begin)
	}
	commit := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{ConversationId: "conv", Action: "edit_commit", ItemId: "gateway-second", Revision: begin.Revision, DraftJson: `{"text":"edited-second","segments":[]}`, UploadedFilesJson: "[]"})
	if !commit.Accepted {
		t.Fatalf("edit commit=%+v", commit)
	}
	removed := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{ConversationId: "conv", Action: "remove", ItemId: "gateway-third"})
	if !removed.Accepted {
		t.Fatalf("remove=%+v", removed)
	}
	relay.mu.Lock()
	sessionID := relay.sessions["conv"]
	localItems := len(relay.queues["conv"])
	relay.mu.Unlock()
	if localItems != 0 {
		t.Fatal("relay retained an executable queue")
	}
	relay.Close()
	// Closing the transport must not cancel the model or delete queued work.
	durable, err := client.sessionQueue(context.Background(), http.MethodGet, sessionID, "", nil)
	if err != nil || len(durable.Snapshot.Items) != 1 || durable.Snapshot.Items[0].PreviewText != "edited-second" {
		t.Fatalf("work not owned by backend: %+v %v", durable, err)
	}
	restored, err := NewRelayWithQueueState(client, "target", ModelRef{Provider: "fixture", Model: "fixture-model"}, root, statePath, cb)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if !restored.usesBackendQueue() {
		t.Fatal("restored transport fell back to a local queue")
	}
	// The accepted run has an SSE reader even with no pending watcher mutation.
	// A second client changes pause state directly; the original reader must
	// propagate queue.updated instead of waiting for another queued receipt.
	current, err := client.sessionQueue(context.Background(), http.MethodGet, sessionID, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	resumed, err := client.sessionQueue(context.Background(), http.MethodPost, sessionID, "/actions", map[string]any{"action": "resume", "revision": current.Snapshot.Revision})
	if err != nil || !resumed.Accepted {
		t.Fatalf("resume=%+v %v", resumed, err)
	}
	deadlineQueue := time.After(3 * time.Second)
	waitingQueue := true
	for waitingQueue {
		select {
		case update := <-queues:
			waitingQueue = update.Revision != resumed.Snapshot.Revision || update.Paused
		case <-deadlineQueue:
			t.Fatal("external resume was not forwarded")
		}
	}
	releaseOnce.Do(func() { close(release) })
	finished := map[string]bool{}
	deadline := time.After(8 * time.Second)
	for len(finished) < 2 {
		select {
		case event := <-controls:
			if event.Type == "completed" {
				finished[event.RequestId] = true
			}
		case <-deadline:
			t.Fatalf("restored queued runs did not finish: %v", finished)
		}
	}
	if !finished["gateway-first"] || !finished["gateway-second"] {
		t.Fatalf("incorrect gateway identities: %v", finished)
	}
	final, err := client.GetSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	var prompts []string
	for _, message := range final.Messages {
		if message.Role == "user" {
			for _, part := range message.Content {
				if part.Type == "text" {
					prompts = append(prompts, part.Text)
				}
			}
		}
	}
	if fmt.Sprint(prompts) != "[hold-first edited-second]" {
		t.Fatalf("replayed or deleted request executed: %v", prompts)
	}
}

func TestBackendQueueProjectionAndFanoutPreserveCanonicalIdentity(t *testing.T) {
	client, _ := New("http://backend.test", "", nil)
	relay, _ := NewRelay(client, "target", ModelRef{}, "")
	defer relay.Close()
	relay.sessions["browser-alias"] = "canonical"
	relay.backendRuns["request"] = backendQueueRun{ConversationID: "browser-alias", SessionID: "canonical", ItemID: "item", GatewayRunID: "gateway-run"}
	out := backendQueueResponse{Accepted: true, Snapshot: backendQueueSnapshot{ConversationID: "canonical", Revision: 4, Paused: true, Items: []backendQueueItem{{ID: "item", PreviewText: "pending"}}}}
	seen := map[string]bool{}
	relay.emitBackendQueue(Callbacks{OnQueue: func(id, raw string, revision uint64) {
		var snapshot backendQueueSnapshot
		if err := json.Unmarshal([]byte(raw), &snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.ConversationID != id || snapshot.Items[0].ID != "gateway-run" || !snapshot.Paused || revision != 4 {
			t.Fatalf("invalid projection: %s", raw)
		}
		seen[id] = true
	}}, out)
	if !seen["canonical"] || !seen["browser-alias"] || out.Snapshot.Items[0].ID != "item" {
		t.Fatalf("fanout or original mutated: %v %+v", seen, out)
	}
}

func TestBackendQueueCanonicalReloadCanOperateBeforeHistoryMapping(t *testing.T) {
	reads, actions := 0, 0
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/sessions/canonical/queue/actions":
			actions++
			var input map[string]any
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
			}
			if input["item_id"] != "backend-item" || input["revision"] != float64(4) {
				t.Errorf("canonical action lost identity: %v", input)
			}
		case "/v1/sessions/canonical/queue":
			reads++
		case "/v1/health":
			fmt.Fprint(w, `{"status":"ok","version":"kbrain.agent.v1","capabilities":{"session_queue":1}}`)
			return
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		fmt.Fprint(w, `{"version":"kbrain.agent.v1","accepted":true,"snapshot":{"conversationId":"canonical","revision":4,"paused":true,"items":[]}}`)
	}))
	defer h.Close()
	client, _ := New(h.URL, "", h.Client())
	relay, _ := NewRelay(client, "target", ModelRef{}, "")
	defer relay.Close()
	relay.backendQueue = true
	relay.sessions["old-alias"] = "canonical"
	relay.backendRuns["request"] = backendQueueRun{ConversationID: "old-alias", SessionID: "canonical", ItemID: "backend-item", GatewayRunID: "gateway-item"}
	response := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{ConversationId: "canonical", Action: "remove", ItemId: "gateway-item", Revision: 4})
	if !response.Accepted || reads != 1 || actions != 1 || relay.sessions["canonical"] != "canonical" {
		t.Fatalf("canonical queue restoration failed: %+v reads=%d actions=%d", response, reads, actions)
	}
}

func TestBackendQueueCapabilityKeepsLegacyWorkOwnedByRelay(t *testing.T) {
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"status":"ok","version":"kbrain.agent.v1","capabilities":{"session_queue":1}}`)
	}))
	defer h.Close()
	client, _ := New(h.URL, "", h.Client())
	relay, _ := NewRelay(client, "target", ModelRef{}, "")
	defer relay.Close()
	relay.queues["conv"] = []queuedRun{{RunID: "legacy"}}
	if err := relay.EnableBackendQueue(context.Background(), Callbacks{}); err != nil {
		t.Fatal(err)
	}
	if relay.usesBackendQueue() {
		t.Fatal("ownership changed while legacy queue exists")
	}
}

func TestBackendQueueDefinitiveRejectionDropsBinding(t *testing.T) {
	for _, status := range []int{400, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/sessions":
					w.WriteHeader(http.StatusCreated)
					fmt.Fprint(w, `{"id":"session"}`)
				case "/v1/sessions/session/queue":
					w.WriteHeader(status)
					fmt.Fprint(w, `{"error":"rejected"}`)
				default:
					http.NotFound(w, r)
				}
			}))
			defer h.Close()
			client, _ := New(h.URL, "", h.Client())
			relay, _ := NewRelay(client, "target", ModelRef{Model: "m"}, "")
			defer relay.Close()
			relay.backendQueue = true
			if _, err := relay.Start(context.Background(), "run", "conv", "request", PromptRequest{Prompt: "hello"}, "append", Callbacks{}); err == nil {
				t.Fatal("rejection accepted")
			}
			if got, want := len(relay.backendRuns), map[int]int{400: 0, 500: 1}[status]; got != want {
				t.Fatalf("bindings=%d want=%d", got, want)
			}
		})
	}
}

func TestBackendQueueConversationCancelTargetsActiveRun(t *testing.T) {
	var cancelled string
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			state, run := "queued", ""
			if r.URL.Query().Get("client_request_id") == "active" {
				state, run = "running", `,"run":{"run_id":"canonical-run"}`
			}
			fmt.Fprintf(w, `{"version":"kbrain.agent.v1","accepted":true,"snapshot":{"conversationId":"session"},"receipt":{"id":"item","state":%q%s}}`, state, run)
			return
		}
		cancelled = r.URL.Path
		fmt.Fprint(w, `{}`)
	}))
	defer h.Close()
	client, _ := New(h.URL, "", h.Client())
	relay, _ := NewRelay(client, "target", ModelRef{}, "")
	defer relay.Close()
	relay.backendQueue = true
	for _, id := range []string{"pending", "active"} {
		relay.backendRuns[id] = backendQueueRun{ConversationID: "conv", SessionID: "session", ClientRequestID: id, GatewayRunID: id}
	}
	if ok, err := relay.Cancel(context.Background(), "conv", ""); !ok || err != nil {
		t.Fatalf("cancel=%v %v", ok, err)
	}
	if cancelled != "/v1/sessions/session/runs/canonical-run/cancel" {
		t.Fatalf("wrong target: %s", cancelled)
	}
}

func TestBackendQueueOwnershipCannotFallBackOnMissingHealth(t *testing.T) {
	h := httptest.NewServer(http.NotFoundHandler())
	defer h.Close()
	client, _ := New(h.URL, "", h.Client())
	relay, _ := NewRelay(client, "target", ModelRef{}, "")
	defer relay.Close()
	relay.backendQueue = true
	if err := relay.EnableBackendQueue(context.Background(), Callbacks{}); err == nil || !relay.usesBackendQueue() {
		t.Fatal("backend ownership silently fell back")
	}
}
