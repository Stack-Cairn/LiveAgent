package websocket_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

// This is intentionally a real Gorilla WebSocket -> Gateway -> HTTP history
// request. It does not use the browser transport mock or a direct relay call.
func TestV2KBrainHistorySurvivesGatewayReload(t *testing.T) {
	const backendID = "backend-history-1"
	kbrain := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/sessions":
			_, _ = fmt.Fprint(w, `{"sessions":[{"id":"backend-history-1","title":"Recovered","cwd":"/workspace","model":{"provider":"fixture","model":"fixture-model"},"created_at":"2026-09-30T10:00:00Z","updated_at":"2026-09-30T10:01:00Z","message_count":2}],"total_count":1}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/sessions/"+backendID+"/history":
			if got := r.URL.Query().Get("include_active"); got != "false" {
				t.Errorf("include_active=%q, want false", got)
			}
			_, _ = fmt.Fprint(w, `{"session":{"id":"backend-history-1","title":"Recovered","cwd":"/workspace","model":{"provider":"fixture","model":"fixture-model"},"created_at":"2026-09-30T10:00:00Z","updated_at":"2026-09-30T10:01:00Z","message_count":2,"messages":[{"id":"u1","role":"user","content":[{"type":"text","text":"hello"}],"created_at":"2026-09-30T10:00:01Z"},{"id":"a1","role":"assistant","provider":"fixture","model":"fixture-model","content":[{"type":"text","text":"world"}],"stop_reason":"end_turn","created_at":"2026-09-30T10:00:02Z"}]},"revision":"history-rev-1","oldest_offset":0,"has_more_before":false,"total_message_count":2}`)
		default:
			http.NotFound(w, r)
		}
	})
	backendConn, backendCleanup := dialHTTPServer(t, kbrain)
	defer backendCleanup()

	cfg := newV2TestConfig()
	cfg.KBrainURL = backendConn
	cfg.KBrainAgentID = "kbrain-history"
	sm := session.NewManager()

	// First gateway instance hydrates the canonical backend id into its relay map.
	first := pbws.NewServer(cfg, sm, nil)
	firstMux := http.NewServeMux()
	firstMux.Handle("/ws/v2", first.BrowserHandler())
	browser, browserCleanup := dialV2Path(t, firstMux, "/ws/v2")
	defer browserCleanup()
	helloV2(t, browser, cfg.Token)

	sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{RequestId: "list-1", AgentId: cfg.KBrainAgentID,
		Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_HistoryList{HistoryList: &gatewayv2.HistoryListRequest{Page: 1, PageSize: 80}}}}})
	list := receiveWebFrameWithID(t, browser, "list-1").GetAgentResponse().GetHistoryListResp()
	if list == nil || len(list.GetConversations()) != 1 || list.GetConversations()[0].GetId() != backendID {
		t.Fatalf("history.list=%#v", list)
	}

	sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{RequestId: "get-1", AgentId: cfg.KBrainAgentID,
		Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_HistoryGet{HistoryGet: &gatewayv2.HistoryGetRequest{ConversationId: backendID, MaxMessages: 80}}}}})
	getFrame := receiveWebFrameWithID(t, browser, "get-1")
	if getFrame.GetLocalError() != nil {
		t.Fatalf("history.get local error=%s", getFrame.GetLocalError().GetMessage())
	}
	get := getFrame.GetAgentResponse().GetHistoryGetResp()
	assertHistoryDetail(t, get, backendID)
	_ = browser.Close()

	// A newly constructed Gateway has no in-memory mapping. history.list must
	// rediscover the backend-owned id, then history.get must route canonically.
	reloaded := pbws.NewServer(cfg, session.NewManager(), nil)
	reloadedMux := http.NewServeMux()
	reloadedMux.Handle("/ws/v2", reloaded.BrowserHandler())
	reconnected, reconnectCleanup := dialV2Path(t, reloadedMux, "/ws/v2")
	defer reconnectCleanup()
	helloV2(t, reconnected, cfg.Token)
	sendProtoFrame(t, reconnected, &gatewayv2.WebClientFrame{RequestId: "list-2", AgentId: cfg.KBrainAgentID,
		Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_HistoryList{HistoryList: &gatewayv2.HistoryListRequest{}}}}})
	list = receiveWebFrameWithID(t, reconnected, "list-2").GetAgentResponse().GetHistoryListResp()
	if list == nil || list.GetConversations()[0].GetSessionId() != backendID {
		t.Fatalf("reloaded history.list=%#v", list)
	}
	sendProtoFrame(t, reconnected, &gatewayv2.WebClientFrame{RequestId: "get-2", AgentId: cfg.KBrainAgentID,
		Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_HistoryGet{HistoryGet: &gatewayv2.HistoryGetRequest{ConversationId: backendID}}}}})
	assertHistoryDetail(t, receiveWebFrameWithID(t, reconnected, "get-2").GetAgentResponse().GetHistoryGetResp(), backendID)
}

func assertHistoryDetail(t *testing.T, detail *gatewayv2.HistoryGetResponse, id string) {
	t.Helper()
	if detail == nil || detail.GetConversationId() != id || detail.GetConversation() == nil || detail.GetMessagesJson() == "" {
		t.Fatalf("history.get=%#v", detail)
	}
	var messages []map[string]any
	if err := json.Unmarshal([]byte(detail.GetMessagesJson()), &messages); err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0]["role"] != "user" || messages[1]["role"] != "assistant" {
		t.Fatalf("messages=%s", detail.GetMessagesJson())
	}
}

func dialHTTPServer(t *testing.T, handler http.Handler) (string, func()) {
	t.Helper()
	server := httptest.NewServer(handler)
	return server.URL, func() { server.Close() }
}
