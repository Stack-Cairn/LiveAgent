package websocket_test

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestV2ComposerRejectionReplaysAfterReconnectWithoutHistory(t *testing.T) {
	var runRequests atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/sessions":
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte(`{"id":"kb-session"}`))
		case "/v1/sessions/kb-session/runs":
			runRequests.Add(1)
			w.WriteHeader(http.StatusConflict)
			w.Write([]byte(`{"error":"session is already running"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer backend.Close()
	cfg := newV2TestConfig()
	cfg.KBrainURL, cfg.KBrainAgentID = backend.URL, "kbrain"
	cfg.KBrainProvider, cfg.KBrainModel = "fixture", "model"
	manager := session.NewManager()
	server := pbws.NewServer(cfg, manager, nil)
	for attempt := 0; attempt < 2; attempt++ {
		browser, cleanup := dialV2(t, server.BrowserHandler())
		helloV2(t, browser, cfg.Token)
		sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{
			RequestId: "submit", AgentId: cfg.KBrainAgentID,
			Payload: &gatewayv2.WebClientFrame_ChatCommand{ChatCommand: &gatewayv2.ChatCommandRequest{
				Type: "chat.submit", Request: &gatewayv2.ChatRequest{ConversationId: "c", ClientRequestId: "stable", Message: "/plan inspect", PlanCommand: true, QueuePolicy: "append"},
			}},
		})
		accepted, rejected := false, false
		for !accepted || !rejected {
			frame := receiveWebFrame(t, browser)
			if ack := frame.GetChatAccepted(); ack != nil {
				accepted = true
				if ack.GetDeduped() != (attempt == 1) {
					t.Fatalf("deduped=%v attempt=%d", ack.GetDeduped(), attempt)
				}
			}
			if update := frame.GetChatCommandUpdate(); update != nil {
				rejected = true
				if update.GetPhase() != "failed" || update.GetErrorCode() != "conversation_busy" || update.GetClientRequestId() != "stable" {
					t.Fatalf("update=%+v", update)
				}
			}
		}
		cleanup()
	}
	if runRequests.Load() != 1 {
		t.Fatalf("duplicate execution: %d requests", runRequests.Load())
	}
	sub := manager.SubscribeConversationStream(cfg.KBrainAgentID, "c", 0, "")
	defer sub.Cleanup()
	if len(sub.Events) != 0 || sub.Activity != nil {
		t.Fatalf("rejection polluted history: %+v", sub)
	}
}
