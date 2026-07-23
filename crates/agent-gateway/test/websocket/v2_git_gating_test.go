package websocket_test

// v2 直通 git 门控：写操作受桌面端 Remote 设置 enable_web_git 门控，
// 读操作始终放行。

import (
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

func newV2GitBrowserTest(
	t *testing.T,
	webGitEnabled bool,
) (*session.Manager, *session.AgentSession, *websocket.Conn, func()) {
	t.Helper()

	sm := session.NewManager()
	webGitSetting := "false"
	if webGitEnabled {
		webGitSetting = "true"
	}
	sm.ApplySettingsJSON("desktop-agent", `{"remote":{"enableWebGit":`+webGitSetting+`}}`)
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot("desktop-agent"))
	sm.SetSession(agentSession)

	handler := pbws.NewServer(newV2TestConfig(), sm, nil).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	helloV2(t, conn, "ws-token")
	return sm, agentSession, conn, cleanup
}

func sendGitAgentRequest(t *testing.T, conn *websocket.Conn, id string, action string) {
	t.Helper()
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: id,
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				RequestId: id,
				Payload: &gatewayv2.GatewayEnvelope_GitRequest{
					GitRequest: &gatewayv2.GitRequest{
						Action:   action,
						Workdir:  "/workspace/project",
						ArgsJson: "{}",
					},
				},
			},
		},
	})
}

func TestV2GitRejectsWriteRequestsWhenDisabled(t *testing.T) {
	t.Parallel()

	_, _, conn, cleanup := newV2GitBrowserTest(t, false)
	defer cleanup()

	for _, action := range []string{"clone", "stage", "init", "stage_all", "unstage_all", "discard_all", "push", "commit"} {
		id := "git-disabled-" + action
		sendGitAgentRequest(t, conn, id, action)

		frame := receiveWebFrameWithID(t, conn, id)
		localError := frame.GetLocalError()
		if localError == nil {
			t.Fatalf("git %s reply = %#v, want local_error", action, frame)
		}
		if !strings.Contains(localError.GetMessage(), "web git is disabled") {
			t.Fatalf("git %s error = %q, want web git disabled message", action, localError.GetMessage())
		}
	}
}

func TestV2GitAllowsReadRequestsWhenDisabled(t *testing.T) {
	t.Parallel()

	_, agentSession, conn, cleanup := newV2GitBrowserTest(t, false)
	defer cleanup()

	for _, action := range []string{"status", "list_remote_branches"} {
		sendGitAgentRequest(t, conn, "git-read-"+action, action)

		outbound := readOutboundEnvelope(t, agentSession)
		if outbound.GetGitRequest().GetAction() != action {
			t.Fatalf("outbound = %#v, want forwarded git %s request", outbound, action)
		}
	}
}

func TestV2GitAllowsWriteRequestsWhenEnabled(t *testing.T) {
	t.Parallel()

	_, agentSession, conn, cleanup := newV2GitBrowserTest(t, true)
	defer cleanup()

	sendGitAgentRequest(t, conn, "git-stage-1", "stage")

	outbound := readOutboundEnvelope(t, agentSession)
	if outbound.GetGitRequest().GetAction() != "stage" {
		t.Fatalf("outbound = %#v, want forwarded git stage request", outbound)
	}
}
