package websocket_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

// TestV2KBrainRelayBrowserReconnect exercises the shipped browser WebSocket
// path against a real HTTP/SSE K-brain boundary. It covers submit, duplicate
// client request suppression, disconnect, after_seq replay, and one terminal.
func TestV2KBrainRelayBrowserReconnect(t *testing.T) {
	firstEventWritten := make(chan struct{})
	releaseFirstEvents := make(chan struct{})
	var firstReleaseOnce sync.Once
	releaseEvents := make(chan struct{})
	eventsDone := make(chan struct{})
	sseHandlerDone := make(chan struct{})
	var releaseOnce sync.Once
	var doneOnce sync.Once
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(releaseEvents) })
	})
	var mu sync.Mutex
	runRequests := 0

	kbrainServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sessions":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(w, `{"version":"kbrain.agent.v1","id":"session-ws"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sessions/session-ws/runs":
			mu.Lock()
			runRequests++
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_, _ = fmt.Fprint(w, `{"version":"kbrain.agent.v1","conversation_id":"session-ws","run_id":"kb-run-ws","accepted_seq":1}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/sessions/session-ws/events":
			defer closeOnce(sseHandlerDone)
			if got := r.URL.Query().Get("after_seq"); got != "0" {
				t.Errorf("first K-brain SSE cursor = %q, want accepted_seq-1", got)
			}
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			flusher, ok := w.(http.Flusher)
			if !ok {
				t.Fatal("K-brain test server does not support streaming flush")
			}
			// 提交确认收帧器会跳过无关帧，确认去重完成后才发送首批事件。
			select {
			case <-releaseFirstEvents:
			case <-r.Context().Done():
				return
			}
			_, _ = fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":1,\"conversation_id\":\"session-ws\",\"run_id\":\"kb-run-ws\",\"type\":\"run.accepted\"}\n\n")
			_, _ = fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":2,\"conversation_id\":\"session-ws\",\"run_id\":\"kb-run-ws\",\"type\":\"assistant.text.delta\",\"payload\":{\"text\":\"first\"}}\n\n")
			flusher.Flush()
			closeOnce(firstEventWritten)
			select {
			case <-releaseEvents:
			case <-r.Context().Done():
				return
			}
			_, _ = fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":3,\"conversation_id\":\"session-ws\",\"run_id\":\"kb-run-ws\",\"type\":\"assistant.text.delta\",\"payload\":{\"text\":\"second\"}}\n\n")
			_, _ = fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":4,\"conversation_id\":\"session-ws\",\"run_id\":\"kb-run-ws\",\"type\":\"run.completed\",\"payload\":{\"state\":\"completed\"}}\n\n")
			flusher.Flush()
			doneOnce.Do(func() { close(eventsDone) })
		default:
			http.NotFound(w, r)
		}
	}))
	defer func() {
		// 先释放夹具再关闭服务器，断言失败也不会留住 SSE 处理器。
		firstReleaseOnce.Do(func() { close(releaseFirstEvents) })
		releaseOnce.Do(func() { close(releaseEvents) })
		kbrainServer.Close()
	}()

	cfg := newV2TestConfig()
	cfg.KBrainURL = kbrainServer.URL
	cfg.KBrainAgentID = "kbrain"
	cfg.KBrainProvider = "fixture"
	cfg.KBrainModel = "fixture-model"
	sm := session.NewManager()
	srv := pbws.NewServer(cfg, sm, nil)
	mux := http.NewServeMux()
	mux.Handle("/ws/v2", srv.BrowserHandler())

	browserConn, browserCleanup := dialV2Path(t, mux, "/ws/v2")
	defer browserCleanup()
	helloV2(t, browserConn, cfg.Token)

	conversationID := "conv-ws"
	sendProtoFrame(t, browserConn, &gatewayv2.WebClientFrame{
		RequestId: "subscribe-1",
		AgentId:   cfg.KBrainAgentID,
		Payload: &gatewayv2.WebClientFrame_ChatSubscribe{
			ChatSubscribe: &gatewayv2.ChatSubscribeRequest{ConversationId: conversationID},
		},
	})
	subscription := receiveWebFrameWithID(t, browserConn, "subscribe-1").GetChatSubscribed()
	if subscription == nil || subscription.GetStreamEpoch() == "" {
		t.Fatalf("initial subscription = %#v, want stream epoch", subscription)
	}
	streamEpoch := subscription.GetStreamEpoch()

	command := &gatewayv2.WebClientFrame{
		RequestId: "command-1",
		AgentId:   cfg.KBrainAgentID,
		Payload: &gatewayv2.WebClientFrame_ChatCommand{
			ChatCommand: &gatewayv2.ChatCommandRequest{
				Type: "chat.submit",
				Request: &gatewayv2.ChatRequest{
					ConversationId:  conversationID,
					ClientRequestId: "client-request-ws-1",
					Message:         "hello through gateway",
					Workdir:         "/workspace",
					SelectedModel:   &gatewayv2.ChatSelectedModel{CustomProviderId: "fixture", ProviderType: "gemini", Model: "fixture-model"},
					RuntimeControls: &gatewayv2.ChatRuntimeControls{NativeWebSearchEnabled: false},
				},
			},
		},
	}
	sendProtoFrame(t, browserConn, command)
	accepted := receiveWebFrameWithID(t, browserConn, "command-1").GetChatAccepted()
	if accepted == nil || accepted.GetDeduped() || accepted.GetConversationId() != conversationID {
		t.Fatalf("initial chat accepted = %#v, want non-deduped conv-ws", accepted)
	}

	// The same client_request_id is submitted through the same shipped command
	// path. The Gateway must acknowledge the existing run without another POST.
	duplicate := proto.Clone(command).(*gatewayv2.WebClientFrame)
	duplicate.RequestId = "command-duplicate"
	sendProtoFrame(t, browserConn, duplicate)
	duplicateAccepted := receiveWebFrameWithID(t, browserConn, "command-duplicate").GetChatAccepted()
	if duplicateAccepted == nil || !duplicateAccepted.GetDeduped() || duplicateAccepted.GetRunId() != accepted.GetRunId() {
		t.Fatalf("duplicate chat accepted = %#v, want deduped run %q", duplicateAccepted, accepted.GetRunId())
	}

	firstReleaseOnce.Do(func() { close(releaseFirstEvents) })
	select {
	case <-firstEventWritten:
	case <-time.After(2 * time.Second):
		t.Fatal("K-brain SSE did not emit first token after submit acknowledgements")
	}
	var firstTokenSeq int64
	for {
		frame := receiveWebFrame(t, browserConn)
		chatEvent := frame.GetChatEvent()
		if chatEvent == nil {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(chatEvent.GetPayloadJson(), &payload); err != nil {
			t.Fatalf("initial chat event payload: %v", err)
		}
		if payload["type"] == "token" && payload["text"] == "first" {
			firstTokenSeq = chatEvent.GetSeq()
			break
		}
	}
	if firstTokenSeq <= 0 {
		t.Fatalf("first token seq = %d, want positive sequence", firstTokenSeq)
	}

	// 浏览器断开后，独立观察 Gateway 接收事件的边界。
	// SSE Flush 或处理器返回只表示生产端已发送，不能证明中继已写入重放缓冲区。
	ingested := sm.SubscribeConversationStream(cfg.KBrainAgentID, conversationID, firstTokenSeq, streamEpoch)
	if ingested == nil {
		t.Fatal("Gateway ingestion subscription is nil")
	}
	defer ingested.Cleanup()

	// Close only the browser connection. Relay and K-brain continue on their
	// own context, so the later events remain in the Gateway replay ring.
	_ = browserConn.Close()
	releaseOnce.Do(func() { close(releaseEvents) })
	select {
	case <-eventsDone:
	case <-time.After(2 * time.Second):
		t.Fatal("K-brain SSE did not emit terminal event")
	}
	select {
	case <-sseHandlerDone:
	case <-time.After(2 * time.Second):
		t.Fatal("K-brain SSE handler did not return after release")
	}

	ingestionTimeout := time.NewTimer(2 * time.Second)
	defer ingestionTimeout.Stop()
waitForTerminal:
	for {
		select {
		case event, ok := <-ingested.EventCh:
			if !ok {
				t.Fatal("Gateway ingestion subscription closed before terminal event")
			}
			if event.Type == "run_finished" {
				break waitForTerminal
			}
		case <-ingestionTimeout.C:
			t.Fatal("Gateway did not ingest terminal event after browser disconnect")
		}
	}

	reconnected, reconnectCleanup := dialV2Path(t, mux, "/ws/v2")
	defer reconnectCleanup()
	helloV2(t, reconnected, cfg.Token)
	sendProtoFrame(t, reconnected, &gatewayv2.WebClientFrame{
		RequestId: "subscribe-2",
		AgentId:   cfg.KBrainAgentID,
		Payload: &gatewayv2.WebClientFrame_ChatSubscribe{
			ChatSubscribe: &gatewayv2.ChatSubscribeRequest{
				ConversationId: conversationID,
				AfterSeq:       firstTokenSeq,
				StreamEpoch:    streamEpoch,
			},
		},
	})
	replayed := receiveWebFrameWithID(t, reconnected, "subscribe-2").GetChatSubscribed()
	if replayed == nil || replayed.GetReset_() || replayed.GetLatestSeq() < firstTokenSeq+2 {
		t.Fatalf("reconnect subscription = %#v, want replay after seq %d", replayed, firstTokenSeq)
	}

	terminalCount := 0
	secondTokenSeen := false
	for _, raw := range replayed.GetEventsJson() {
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("replayed event payload: %v", err)
		}
		switch payload["type"] {
		case "token":
			if payload["text"] == "second" {
				secondTokenSeen = true
			}
		case "run_finished":
			terminalCount++
		}
	}
	if !secondTokenSeen || terminalCount != 1 {
		t.Fatalf("replayed events = %s, want second token and exactly one terminal", formatJSON(replayed.GetEventsJson()))
	}

	mu.Lock()
	gotRuns := runRequests
	mu.Unlock()
	if gotRuns != 1 {
		t.Fatalf("K-brain /runs requests = %d, want exactly one after duplicate submit", gotRuns)
	}
}

func closeOnce(ch chan struct{}) {
	select {
	case <-ch:
	default:
		close(ch)
	}
}

func formatJSON(values [][]byte) string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		parts = append(parts, string(value))
	}
	return strings.Join(parts, ",")
}

func TestV2KBrainCronManageHydratesAndCancelsActiveRun(t *testing.T) {
	var cancelSeen bool
	kbrainServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cron":
			_, _ = fmt.Fprint(w, `{"revision":3,"tasks":[{"id":"task/1","name":"cron","type":"bash"}]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/hooks":
			_, _ = fmt.Fprint(w, `{"revision":1,"hooks":[]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cron/task/1/runs":
			_, _ = fmt.Fprint(w, `{"runs":[{"id":"run-1","taskId":"task/1","state":"leased","startedAt":1}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cron/task/1/cancel":
			cancelSeen = true
			_, _ = fmt.Fprint(w, `{"ok":true}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer kbrainServer.Close()

	cfg := newV2TestConfig()
	cfg.KBrainURL = kbrainServer.URL
	cfg.KBrainAgentID = "kbrain"
	cfg.KBrainProvider = "fixture"
	cfg.KBrainModel = "fixture-model"
	srv := pbws.NewServer(cfg, session.NewManager(), nil)
	mux := http.NewServeMux()
	mux.Handle("/ws/v2", srv.BrowserHandler())
	browserConn, cleanup := dialV2Path(t, mux, "/ws/v2")
	defer cleanup()
	helloV2(t, browserConn, cfg.Token)

	sendCron := func(requestID, action, taskID, taskJSON string) *gatewayv2.CronManageResponse {
		sendProtoFrame(t, browserConn, &gatewayv2.WebClientFrame{
			RequestId: requestID,
			AgentId:   cfg.KBrainAgentID,
			Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_CronManage{CronManage: &gatewayv2.CronManageRequest{Action: action, TaskId: taskID, TaskJson: taskJSON}},
			}},
		})
		return receiveWebFrameWithID(t, browserConn, requestID).GetAgentResponse().GetCronManageResp()
	}

	snapshot := sendCron("cron-snapshot", "snapshot", "", "")
	if snapshot == nil || !strings.Contains(snapshot.GetResultJson(), `"revision":3`) || !strings.Contains(snapshot.GetResultJson(), `"hooks"`) {
		t.Fatalf("snapshot response = %#v", snapshot)
	}
	runs := sendCron("cron-runs", "list_runs", "task/1", `{"limit":500}`)
	if runs == nil || !strings.Contains(runs.GetResultJson(), `"state":"leased"`) {
		t.Fatalf("active run response = %#v", runs)
	}
	cancel := sendCron("cron-cancel", "cancel_run", "task/1", "")
	if cancel == nil || !strings.Contains(cancel.GetResultJson(), `"ok":true`) || !cancelSeen {
		t.Fatalf("cancel response = %#v, cancelSeen=%v", cancel, cancelSeen)
	}
}

// Keep the direct websocket package reference in this integration test's
// compilation unit as a guard that the test uses the real Gorilla connection.
var _ *websocket.Conn

func TestV2KBrainEmptyConversationIdentityAndRetries(t *testing.T) {
	stop := make(chan struct{})
	releaseEvents := []chan struct{}{make(chan struct{}), make(chan struct{})}
	var mu sync.Mutex
	sessionRequests, runRequests := 0, 0
	var clientRequests []string
	kbrainServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/health":
			_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sessions":
			mu.Lock()
			sessionRequests++
			mu.Unlock()
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(w, `{"id":"session-empty-ws"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sessions/session-empty-ws/runs":
			var prompt struct {
				ConversationID  string `json:"conversation_id"`
				ClientRequestID string `json:"client_request_id"`
			}
			if err := json.NewDecoder(r.Body).Decode(&prompt); err != nil {
				t.Errorf("decode run prompt: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if prompt.ConversationID != "session-empty-ws" {
				t.Errorf("backend conversation = %q, want canonical session ID", prompt.ConversationID)
			}
			mu.Lock()
			runRequests++
			run := runRequests
			clientRequests = append(clientRequests, prompt.ClientRequestID)
			mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			_, _ = fmt.Fprintf(w, `{"version":"kbrain.agent.v1","conversation_id":"session-empty-ws","run_id":"backend-%d","accepted_seq":%d}`, run, 3*run-2)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/sessions/session-empty-ws/events":
			after, err := strconv.Atoi(r.URL.Query().Get("after_seq"))
			if err != nil || after < 0 || after%3 != 0 || after/3 >= len(releaseEvents) {
				t.Errorf("unexpected SSE cursor %q", r.URL.RawQuery)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			run := after/3 + 1
			select {
			case <-releaseEvents[run-1]:
			case <-stop:
				return
			case <-r.Context().Done():
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			for i, eventType := range []string{"run.accepted", "assistant.text.delta", "run.completed"} {
				_, _ = fmt.Fprintf(w, "data: {\"version\":\"kbrain.agent.v1\",\"conversation_id\":\"session-empty-ws\",\"run_id\":\"backend-%d\",\"seq\":%d,\"type\":\"%s\",\"payload\":{\"text\":\"turn-%d\"}}\n\n", run, after+i+1, eventType, run)
			}
		default:
			t.Errorf("unexpected K-brain request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer kbrainServer.Close()
	defer close(stop)
	cfg := newV2TestConfig()
	cfg.KBrainURL, cfg.KBrainAgentID = kbrainServer.URL, "kbrain"
	cfg.KBrainProvider, cfg.KBrainModel = "fixture", "fixture-model"
	sm := session.NewManager()
	srv := pbws.NewServer(cfg, sm, nil)
	mux := http.NewServeMux()
	mux.Handle("/ws/v2", srv.BrowserHandler())
	first, cleanupFirst := dialV2Path(t, mux, "/ws/v2")
	defer cleanupFirst()
	helloV2(t, first, cfg.Token)
	retry, cleanupRetry := dialV2Path(t, mux, "/ws/v2")
	defer cleanupRetry()
	helloV2(t, retry, cfg.Token)

	command := func(requestID, clientRequestID, conversationID string) *gatewayv2.WebClientFrame {
		return &gatewayv2.WebClientFrame{
			RequestId: requestID, AgentId: cfg.KBrainAgentID,
			Payload: &gatewayv2.WebClientFrame_ChatCommand{ChatCommand: &gatewayv2.ChatCommandRequest{
				Type: "chat.submit", Request: &gatewayv2.ChatRequest{
					ConversationId: conversationID, ClientRequestId: clientRequestID,
					Message: "hello " + clientRequestID, Workdir: "/workspace",
				},
			}},
		}
	}
	// Both connections submit the same draft before either reads acceptance.
	sendProtoFrame(t, first, command("empty-first", "empty-client-1", ""))
	sendProtoFrame(t, retry, command("empty-retry", "empty-client-1", "  "))
	accepted := receiveWebFrameWithID(t, first, "empty-first").GetChatAccepted()
	duplicate := receiveWebFrameWithID(t, retry, "empty-retry").GetChatAccepted()
	if accepted == nil || duplicate == nil || accepted.GetDeduped() == duplicate.GetDeduped() {
		t.Fatalf("concurrent acceptances = %#v, %#v, want exactly one deduped", accepted, duplicate)
	}
	conversationID := accepted.GetConversationId()
	if _, err := uuid.Parse(conversationID); err != nil {
		t.Fatalf("assigned conversation ID = %q, want UUID: %v", conversationID, err)
	}
	if accepted.GetRunId() == "" || accepted.GetAcceptedSeq() <= 0 || duplicate.GetConversationId() != conversationID || duplicate.GetRunId() != accepted.GetRunId() || duplicate.GetAcceptedSeq() != accepted.GetAcceptedSeq() {
		t.Fatalf("draft retry changed canonical identity: %#v, %#v", accepted, duplicate)
	}
	_ = first.Close()
	_ = retry.Close()

	reconnected, cleanupReconnect := dialV2Path(t, mux, "/ws/v2")
	defer cleanupReconnect()
	// Active conversation broadcasts may precede the correlated hello reply.
	sendProtoFrame(t, reconnected, &gatewayv2.WebClientFrame{
		RequestId: "reconnect-hello",
		Payload: &gatewayv2.WebClientFrame_Hello{Hello: &gatewayv2.ClientHello{
			ProtocolVersion: pbws.ProtocolVersion, Role: gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
			Token: cfg.Token, ClientName: "empty-conversation-reconnect",
		}},
	})
	if hello := receiveWebFrameWithID(t, reconnected, "reconnect-hello").GetHello(); hello == nil || !hello.GetOk() {
		t.Fatalf("reconnect hello = %#v", hello)
	}
	sendProtoFrame(t, reconnected, command("empty-reconnect", "empty-client-1", ""))
	reconnectedAccepted := receiveWebFrameWithID(t, reconnected, "empty-reconnect").GetChatAccepted()
	if reconnectedAccepted == nil || !reconnectedAccepted.GetDeduped() || reconnectedAccepted.GetConversationId() != conversationID || reconnectedAccepted.GetRunId() != accepted.GetRunId() {
		t.Fatalf("reconnected draft retry = %#v", reconnectedAccepted)
	}
	subscribe := func(requestID string) *gatewayv2.ChatSubscribeResult {
		sendProtoFrame(t, reconnected, &gatewayv2.WebClientFrame{
			RequestId: requestID, AgentId: cfg.KBrainAgentID,
			Payload: &gatewayv2.WebClientFrame_ChatSubscribe{ChatSubscribe: &gatewayv2.ChatSubscribeRequest{ConversationId: conversationID}},
		})
		result := receiveWebFrameWithID(t, reconnected, requestID).GetChatSubscribed()
		if result == nil || result.GetConversationId() != conversationID || result.GetStreamEpoch() == "" {
			t.Fatalf("subscription = %#v", result)
		}
		return result
	}
	initial := subscribe("empty-subscribe")
	if len(initial.GetEventsJson()) != 1 {
		t.Fatalf("initial seeded events = %s, want one user_message", formatJSON(initial.GetEventsJson()))
	}
	var seeded map[string]any
	if err := json.Unmarshal(initial.GetEventsJson()[0], &seeded); err != nil || seeded["type"] != "user_message" || seeded["conversation_id"] != conversationID || seeded["run_id"] != accepted.GetRunId() {
		t.Fatalf("seeded event = %s, error %v", initial.GetEventsJson()[0], err)
	}
	lastSeq := initial.GetLatestSeq()
	readTurn := func(runID, text string) {
		t.Helper()
		started, token := false, false
		for {
			frame := receiveWebFrame(t, reconnected)
			if frame.GetLocalError() != nil || frame.GetChatCommandUpdate().GetPhase() == "failed" {
				t.Fatalf("chat failed: %v", frame)
			}
			event := frame.GetChatEvent()
			if event == nil {
				continue
			}
			if event.GetConversationId() != conversationID || event.GetSeq() <= lastSeq {
				t.Fatalf("event identity/sequence = %v, last sequence %d", event, lastSeq)
			}
			lastSeq = event.GetSeq()
			var payload map[string]any
			if err := json.Unmarshal(event.GetPayloadJson(), &payload); err != nil {
				t.Fatal(err)
			}
			if payload["conversation_id"] != conversationID || payload["run_id"] != runID {
				t.Fatalf("event payload identity = %s", event.GetPayloadJson())
			}
			switch payload["type"] {
			case "run_started":
				started = true
			case "token":
				if payload["text"] != text {
					t.Fatalf("token payload = %s", event.GetPayloadJson())
				}
				token = true
			case "run_finished":
				if !started || !token || payload["status"] != "completed" {
					t.Fatalf("turn finished before expected events: %s, started=%t token=%t", event.GetPayloadJson(), started, token)
				}
				return
			}
		}
	}
	close(releaseEvents[0])
	readTurn(accepted.GetRunId(), "turn-1")

	sendProtoFrame(t, reconnected, command("empty-after-completion", "empty-client-1", ""))
	afterCompletion := receiveWebFrameWithID(t, reconnected, "empty-after-completion").GetChatAccepted()
	if afterCompletion == nil || !afterCompletion.GetDeduped() || afterCompletion.GetRunId() != accepted.GetRunId() || afterCompletion.GetConversationId() != conversationID {
		t.Fatalf("completed draft retry = %#v", afterCompletion)
	}
	sendProtoFrame(t, reconnected, command("next-turn", "empty-client-2", conversationID))
	next := receiveWebFrameWithID(t, reconnected, "next-turn").GetChatAccepted()
	if next == nil || next.GetDeduped() || next.GetConversationId() != conversationID || next.GetRunId() == accepted.GetRunId() {
		t.Fatalf("next turn acceptance = %#v", next)
	}
	close(releaseEvents[1])
	readTurn(next.GetRunId(), "turn-2")
	replay := subscribe("empty-replay")
	counts := map[string]map[string]int{}
	for _, raw := range replay.GetEventsJson() {
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatal(err)
		}
		runID, _ := payload["run_id"].(string)
		typ, _ := payload["type"].(string)
		if payload["conversation_id"] != conversationID || (runID != accepted.GetRunId() && runID != next.GetRunId()) {
			t.Fatalf("replay identity = %s", raw)
		}
		if counts[runID] == nil {
			counts[runID] = map[string]int{}
		}
		counts[runID][typ]++
	}
	for _, runID := range []string{accepted.GetRunId(), next.GetRunId()} {
		for _, typ := range []string{"user_message", "run_started", "token", "run_finished"} {
			if counts[runID][typ] != 1 {
				t.Fatalf("replayed %s %s count = %d, want 1", runID, typ, counts[runID][typ])
			}
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if sessionRequests != 1 || runRequests != 2 || len(clientRequests) != 2 || clientRequests[0] != "empty-client-1" || clientRequests[1] != "empty-client-2" {
		t.Fatalf("backend sessions=%d runs=%d client requests=%v, want one session and two distinct turns", sessionRequests, runRequests, clientRequests)
	}
}
