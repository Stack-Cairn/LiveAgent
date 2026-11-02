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

func TestV2KBrainSkillsWithoutDesktop(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/health" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer backend-token" {
			t.Error("missing backend authentication")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/skills":
			if r.Method != "GET" || r.URL.Query().Get("workdir") != "/tmp/work dir" {
				t.Errorf("unexpected list %s %s", r.Method, r.URL)
			}
			_, _ = w.Write([]byte(`{"rootDir":"backend-skills","skills":[],"settings":{"enabled":true,"selected":[]}}`))
		case "/v1/skills/settings":
			var input map[string]any
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
			}
			if r.Method != "PUT" || input["enabled"] != false || input["action"] != nil {
				t.Errorf("unexpected settings %s %v", r.Method, input)
			}
			_, _ = w.Write([]byte(`{"settings":{"enabled":false,"selected":[]}}`))
		case "/v1/skills/manage":
			var input map[string]any
			_ = json.NewDecoder(r.Body).Decode(&input)
			if r.Method != "POST" || input["action"] != "read" || input["path"] != "audit/SKILL.md" {
				t.Errorf("unexpected read %s %v", r.Method, input)
			}
			_, _ = w.Write([]byte(`{"content":"Backend skill text","truncated":false}`))
		default:
			t.Errorf("unexpected route %s", r.URL)
			http.NotFound(w, r)
		}
	}))
	defer backend.Close()
	cfg := newV2TestConfig()
	cfg.KBrainURL, cfg.KBrainToken, cfg.KBrainAgentID = backend.URL, "backend-token", "skills-kbrain"
	srv := pbws.NewServer(cfg, session.NewManager(), nil)
	defer srv.Close()
	mux := http.NewServeMux()
	mux.Handle("/ws/v2", srv.BrowserHandler())
	browser, cleanup := dialV2Path(t, mux, "/ws/v2")
	defer cleanup()
	helloV2(t, browser, cfg.Token)
	for _, payload := range []string{
		`{"action":"list","workdir":"/tmp/work dir"}`,
		`{"action":"settings","enabled":false,"selected":[]}`,
		`{"action":"read","path":"audit/SKILL.md","offset":0,"length":200}`,
	} {
		sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{RequestId: "skill-request", AgentId: cfg.KBrainAgentID,
			Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_SkillManage{SkillManage: &gatewayv2.SkillManageRequest{PayloadJson: payload}},
			}},
		})
		response := receiveWebFrameWithID(t, browser, "skill-request")
		if response.GetAgentResponse().GetSkillManageResp().GetResultJson() == "" {
			t.Fatalf("skills request failed: %v", response)
		}
	}
}
