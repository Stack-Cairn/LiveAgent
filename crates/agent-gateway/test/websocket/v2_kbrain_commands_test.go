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

func TestV2KBrainCommandsWithoutDesktop(t *testing.T) {
	var calls atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/commands":
			_, _ = w.Write([]byte(`{"commands":[{"name":"loop","kind":"action"},{"name":"review","kind":"prompt"}]}`))
		case "/v1/sessions/session/loops":
			calls.Add(1)
			_, _ = w.Write([]byte(`{"id":"loop-1","interval":"10m","prompt":"inspect","enabled":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer backend.Close()
	cfg := newV2TestConfig()
	cfg.KBrainURL, cfg.KBrainAgentID = backend.URL, "commands-kbrain"
	srv := pbws.NewServer(cfg, session.NewManager(), nil)
	defer srv.Close()
	mux := http.NewServeMux()
	mux.Handle("/ws/v2", srv.BrowserHandler())
	browser, cleanup := dialV2Path(t, mux, "/ws/v2")
	defer cleanup()
	helloV2(t, browser, cfg.Token)
	send := func(id string, env *gatewayv2.GatewayEnvelope) *gatewayv2.WebServerFrame {
		sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{RequestId: id, AgentId: cfg.KBrainAgentID,
			Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: env}})
		return receiveWebFrameWithID(t, browser, id)
	}
	commands := send("commands", &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_SlashCommandList{SlashCommandList: &gatewayv2.SlashCommandListRequest{}}})
	if len(commands.GetAgentResponse().GetSlashCommandListResp().GetCommands()) != 2 {
		t.Fatalf("commands: %v", commands)
	}
	loop := &gatewayv2.LoopManageRequest{ConversationId: "session", Action: "create", Interval: "10m", Prompt: "inspect"}
	created := send("create", &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_LoopManage{LoopManage: loop}})
	if len(created.GetAgentResponse().GetLoopManageResp().GetLoops()) != 1 || calls.Load() != 1 {
		t.Fatalf("create: %v", created)
	}
	loop.Interval = ""
	invalid := send("invalid", &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_LoopManage{LoopManage: loop}})
	if invalid.GetLocalError() == nil || calls.Load() != 1 {
		t.Fatalf("invalid schedule reached backend: %v", invalid)
	}
}
