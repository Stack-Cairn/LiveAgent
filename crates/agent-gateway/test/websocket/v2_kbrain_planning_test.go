package websocket_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestV2KBrainPlanningRelaysWithoutDesktop(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/health" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path != "/v1/planning" || r.Method != "POST" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		var input map[string]any
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
		}
		if input["action"] != "query" {
			t.Errorf("action %v", input)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"seq":7,"todos":[{"id":"backend-task"}]}`))
	}))
	defer backend.Close()
	cfg := newV2TestConfig()
	cfg.KBrainURL = backend.URL
	cfg.KBrainAgentID = "planning-kbrain"
	cfg.KBrainProvider = "fixture"
	cfg.KBrainModel = "fixture"
	srv := pbws.NewServer(cfg, session.NewManager(), nil)
	defer srv.Close()
	mux := http.NewServeMux()
	mux.Handle("/ws/v2", srv.BrowserHandler())
	browser, cleanup := dialV2Path(t, mux, "/ws/v2")
	defer cleanup()
	helloV2(t, browser, cfg.Token)
	sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{
		RequestId: "planning-query", AgentId: cfg.KBrainAgentID,
		Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_Planning{Planning: &gatewayv2.PlanningRequest{Action: "query", InputJson: "{}"}},
		}},
	})
	response := receiveWebFrameWithID(t, browser, "planning-query")
	if response.GetAgentResponse().GetPlanningResp().GetResultJson() != `{"seq":7,"todos":[{"id":"backend-task"}]}` {
		t.Fatalf("unexpected Planning response: %v", response)
	}
}
