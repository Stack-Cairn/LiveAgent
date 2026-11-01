package websocket_test

import (
	"strings"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

// LA-3b review: the desktop arm through the real browser handler. An old desktop is
// refused before anything is queued for it; a desktop with PERMISSION_RULES_V1 gets
// the request byte for byte, and both its answer and its error reach the browser.
func TestReviewLA3bPermissionRulesDesktopArm(t *testing.T) {
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot("desktop-agent"))
	agentSession.SetCapabilities([]string{gatewayv2.ChatIngressV1Capability})
	sm.SetSession(agentSession)
	conn, cleanup := dialV2(t, pbws.NewServer(newV2TestConfig(), sm, nil).BrowserHandler())
	defer cleanup()
	helloV2(t, conn, "ws-token")

	const input = `{"workspace":"D:\\项目\\a b+c","rule":"Bash(rm:*)","effect":"deny","scope":"project"}`
	send := func(id string) {
		sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{RequestId: id, AgentId: "desktop-agent",
			Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_PermissionRules{PermissionRules: &gatewayv2.PermissionRulesRequest{Action: "add", InputJson: input}},
			}}})
	}

	send("old")
	refused := receiveWebFrameWithID(t, conn, "old")
	if message := refused.GetLocalError().GetMessage(); !strings.Contains(message, "update LiveAgent on the desktop") {
		t.Fatalf("old desktop: %v", refused)
	}
	select {
	case outbound := <-agentSession.Outbound():
		outbound.Ack(nil)
		t.Fatalf("old desktop was sent %v", outbound.GatewayEnvelope)
	case <-time.After(100 * time.Millisecond):
	}

	agentSession.SetCapabilities([]string{gatewayv2.ChatIngressV1Capability, gatewayv2.PermissionRulesV1Capability})
	send("ok")
	forwarded := readOutboundEnvelope(t, agentSession)
	if got := forwarded.GetPermissionRules(); got.GetAction() != "add" || got.GetInputJson() != input {
		t.Fatalf("forwarded = %v", forwarded)
	}
	sm.DispatchFromAgent("desktop-agent", &gatewayv2.AgentEnvelope{RequestId: forwarded.GetRequestId(),
		Payload: &gatewayv2.AgentEnvelope_PermissionRulesResp{PermissionRulesResp: &gatewayv2.PermissionRulesResponse{ResultJson: `{"id":"r_9"}`}}})
	answered := receiveWebFrameWithID(t, conn, "ok")
	if got := answered.GetAgentResponse().GetPermissionRulesResp().GetResultJson(); got != `{"id":"r_9"}` {
		t.Fatalf("answer = %v", answered)
	}

	send("err")
	forwarded = readOutboundEnvelope(t, agentSession)
	sm.DispatchFromAgent("desktop-agent", &gatewayv2.AgentEnvelope{RequestId: forwarded.GetRequestId(),
		Payload: &gatewayv2.AgentEnvelope_Error{Error: &gatewayv2.ErrorResponse{Code: 400, Message: `permission rule "Bash(": missing closing parenthesis (HTTP 400 Bad Request)`}}})
	failed := receiveWebFrameWithID(t, conn, "err")
	if got := failed.GetAgentResponse().GetError().GetMessage(); !strings.Contains(got, "missing closing parenthesis") {
		t.Fatalf("error = %v", failed)
	}
}
