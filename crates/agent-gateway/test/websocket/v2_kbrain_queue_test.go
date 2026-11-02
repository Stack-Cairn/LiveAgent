package websocket_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestV2KBrainQueueRPCOverWebSocketAndSSE(t *testing.T) {
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	var releaseOnce sync.Once
	var mu sync.Mutex
	runRequests := 0
	kbrainServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sessions":
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(w, `{"id":"session-queue-ws"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sessions/session-queue-ws/runs":
			mu.Lock()
			runRequests++
			run := runRequests
			mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			_, _ = fmt.Fprintf(w, `{"version":"kbrain.agent.v1","conversation_id":"session-queue-ws","run_id":"backend-%d","accepted_seq":%d}`, run, 2*run-1)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sessions/session-queue-ws/runs/backend-1/cancel":
			releaseOnce.Do(func() { close(releaseFirst) })
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/sessions/session-queue-ws/events":
			if r.URL.Query().Get("after_seq") == "2" {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = fmt.Fprint(w, `data: {"version":"kbrain.agent.v1","seq":3,"conversation_id":"session-queue-ws","run_id":"backend-2","type":"run.accepted"}`+"\n\n")
				_, _ = fmt.Fprint(w, `data: {"version":"kbrain.agent.v1","seq":4,"conversation_id":"session-queue-ws","run_id":"backend-2","type":"run.completed"}`+"\n\n")
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			flusher, ok := w.(http.Flusher)
			if !ok {
				t.Fatal("K-brain test server does not support streaming flush")
			}
			_, _ = fmt.Fprint(w, `data: {"version":"kbrain.agent.v1","seq":1,"conversation_id":"session-queue-ws","run_id":"backend-1","type":"run.accepted"}`+"\n\n")
			flusher.Flush()
			select {
			case <-firstStarted:
			case <-r.Context().Done():
				return
			}
			select {
			case <-releaseFirst:
			case <-r.Context().Done():
				return
			}
			_, _ = fmt.Fprint(w, `data: {"version":"kbrain.agent.v1","seq":2,"conversation_id":"session-queue-ws","run_id":"backend-1","type":"run.cancelled"}`+"\n\n")
			flusher.Flush()
		default:
			http.NotFound(w, r)
		}
	}))
	defer kbrainServer.Close()

	cfg := newV2TestConfig()
	cfg.KBrainURL = kbrainServer.URL
	cfg.KBrainAgentID = "kbrain-queue"
	cfg.KBrainProvider = "fixture"
	cfg.KBrainModel = "fixture-model"
	srv := pbws.NewServer(cfg, session.NewManager(), nil)
	mux := http.NewServeMux()
	mux.Handle("/ws/v2", srv.BrowserHandler())
	browser, cleanup := dialV2Path(t, mux, "/ws/v2")
	defer cleanup()
	helloV2(t, browser, cfg.Token)

	conversationID := "conv-queue-ws"
	submit := func(requestID, clientRequestID, message, queuePolicy string) *gatewayv2.ChatCommandAccepted {
		sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{
			RequestId: requestID,
			AgentId:   cfg.KBrainAgentID,
			Payload: &gatewayv2.WebClientFrame_ChatCommand{ChatCommand: &gatewayv2.ChatCommandRequest{
				Type:    "chat.submit",
				Request: &gatewayv2.ChatRequest{ConversationId: conversationID, ClientRequestId: clientRequestID, Message: message, QueuePolicy: queuePolicy},
			}},
		})
		return receiveWebFrameWithID(t, browser, requestID).GetChatAccepted()
	}
	first := submit("submit-first", "client-first", "first", "auto")
	if first == nil || first.GetDeduped() {
		t.Fatalf("first accepted = %#v", first)
	}
	closeOnce(firstStarted)
	second := submit("submit-second", "client-second", "second", "append")
	if second == nil || second.GetDeduped() {
		t.Fatalf("second accepted = %#v", second)
	}

	awaitQueued := func(runID string) {
		t.Helper()
		for {
			frame := receiveWebFrame(t, browser)
			if update := frame.GetChatCommandUpdate(); update != nil && update.GetRunId() == runID {
				if update.GetPhase() != "queued_in_gui" {
					t.Fatalf("queued update = %#v", update)
				}
				return
			}
		}
	}
	awaitQueued(second.GetRunId())

	queueRequest := func(requestID, action, itemID, direction string, revision uint64, draft string) *gatewayv2.ChatQueueResponse {
		sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{
			RequestId: requestID,
			AgentId:   cfg.KBrainAgentID,
			Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_ChatQueue{ChatQueue: &gatewayv2.ChatQueueRequest{
					Action: action, ConversationId: conversationID, ItemId: itemID, Direction: direction, Revision: revision, DraftJson: draft, UploadedFilesJson: `[]`,
				}},
			}},
		})
		for {
			frame := receiveWebFrame(t, browser)
			if frame.GetRequestId() == requestID {
				return frame.GetAgentResponse().GetChatQueueResp()
			}
		}
	}

	inspect := queueRequest("queue-inspect", "inspect", "", "", 0, "")
	if inspect == nil || !inspect.GetAccepted() || inspect.GetRevision() != 1 {
		t.Fatalf("inspect = %#v", inspect)
	}
	var snapshot struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(inspect.GetSnapshotJson()), &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Items) != 1 || snapshot.Items[0].ID != second.GetRunId() {
		t.Fatalf("queue snapshot = %#v, want queued run %q", snapshot, second.GetRunId())
	}

	deleteRequestID := "queue-delete"
	sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{
		RequestId: deleteRequestID,
		AgentId:   cfg.KBrainAgentID,
		Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_ChatQueue{ChatQueue: &gatewayv2.ChatQueueRequest{Action: "delete", ConversationId: conversationID, ItemId: second.GetRunId(), Revision: inspect.GetRevision()}},
		}},
	})
	var deleted *gatewayv2.ChatQueueResponse
	queueEventSeen := false
	for deleted == nil || !queueEventSeen {
		frame := receiveWebFrame(t, browser)
		if frame.GetRequestId() == deleteRequestID {
			deleted = frame.GetAgentResponse().GetChatQueueResp()
		}
		if event := frame.GetChatQueueEvent(); event != nil && strings.Contains(event.GetSnapshotJson(), `"items":[]`) {
			queueEventSeen = true
		}
	}
	if deleted == nil || !deleted.GetAccepted() || deleted.GetRevision() != 2 || !queueEventSeen {
		t.Fatalf("delete = %#v, queue_event=%v", deleted, queueEventSeen)
	}

	third := submit("submit-third", "client-third", "third", "append")
	if third == nil {
		t.Fatal("missing third acceptance")
	}
	awaitQueued(third.GetRunId())
	begin := queueRequest("queue-edit", "edit_begin", third.GetRunId(), "", 0, "")
	var detail struct {
		DraftJSON         string `json:"draftJson"`
		UploadedFilesJSON string `json:"uploadedFilesJson"`
	}
	if begin == nil || !begin.GetAccepted() || json.Unmarshal([]byte(begin.GetItemJson()), &detail) != nil || !json.Valid([]byte(detail.DraftJSON)) || detail.UploadedFilesJSON != "[]" {
		t.Fatalf("edit detail = %#v, response=%v", detail, begin)
	}
	restored := queueRequest("queue-edit-cancel", "edit_cancel", third.GetRunId(), "", 0, "")
	if restored == nil || !restored.GetAccepted() {
		t.Fatalf("edit cancel = %v", restored)
	}
	sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{RequestId: "subscribe-run-now", AgentId: cfg.KBrainAgentID,
		Payload: &gatewayv2.WebClientFrame_ChatSubscribe{ChatSubscribe: &gatewayv2.ChatSubscribeRequest{ConversationId: conversationID}},
	})
	receiveWebFrameWithID(t, browser, "subscribe-run-now")
	response := queueRequest("queue-run-now", "run_now", third.GetRunId(), "", restored.GetRevision(), "")
	if response == nil || !response.GetAccepted() {
		t.Fatalf("run_now = %v", response)
	}
	// A replay also catches events delivered before the RPC response.
	sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{RequestId: "replay-run-now", AgentId: cfg.KBrainAgentID,
		Payload: &gatewayv2.WebClientFrame_ChatSubscribe{ChatSubscribe: &gatewayv2.ChatSubscribeRequest{ConversationId: conversationID}},
	})
	started, completed := false, false
	inspectEvent := func(raw []byte) {
		var event map[string]any
		if json.Unmarshal(raw, &event) != nil || event["run_id"] != third.GetRunId() {
			return
		}
		if event["type"] == "run_started" {
			started = true
		}
		if event["type"] == "run_finished" {
			completed = true
		}
	}
	for !started || !completed {
		frame := receiveWebFrame(t, browser)
		if sub := frame.GetChatSubscribed(); sub != nil {
			for _, raw := range sub.GetEventsJson() {
				inspectEvent(raw)
			}
		}
		if event := frame.GetChatEvent(); event != nil {
			inspectEvent(event.GetPayloadJson())
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if runRequests != 2 {
		t.Fatalf("backend runs = %d, want active and run_now only", runRequests)
	}
}
