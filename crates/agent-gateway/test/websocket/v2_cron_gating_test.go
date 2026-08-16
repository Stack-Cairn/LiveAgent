package websocket_test

// v2 直通 cron/hooks 门控：cron.manage 可写入并立即执行 bash 脚本，
// 与 terminal/git/tunnels 同款，受桌面端 Remote 设置 enable_web_automation 门控，
// 未同步设置时 fail-closed。

import (
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

func newV2CronBrowserTest(
	t *testing.T,
	webAutomationEnabled bool,
) (*session.Manager, *session.AgentSession, *websocket.Conn, func()) {
	t.Helper()

	sm := session.NewManager()
	webAutomationSetting := "false"
	if webAutomationEnabled {
		webAutomationSetting = "true"
	}
	sm.ApplySettingsJSON("desktop-agent", `{"remote":{"enableWebAutomation":`+webAutomationSetting+`}}`)
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot("desktop-agent"))
	sm.SetSession(agentSession)

	handler := pbws.NewServer(newV2TestConfig(), sm, nil).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	helloV2(t, conn, "ws-token")
	return sm, agentSession, conn, cleanup
}

func sendCronManageAgentRequest(t *testing.T, conn *websocket.Conn, id string, action string) {
	t.Helper()
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: id,
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				RequestId: id,
				Payload: &gatewayv2.GatewayEnvelope_CronManage{
					CronManage: &gatewayv2.CronManageRequest{
						Action:   action,
						TaskId:   "task-1",
						TaskJson: "{}",
					},
				},
			},
		},
	})
}

func TestV2CronManageRejectsWhenDisabled(t *testing.T) {
	t.Parallel()

	_, _, conn, cleanup := newV2CronBrowserTest(t, false)
	defer cleanup()

	for _, action := range []string{"cron_apply", "hooks_apply", "run_now", "snapshot"} {
		id := "cron-disabled-" + action
		sendCronManageAgentRequest(t, conn, id, action)

		frame := receiveWebFrameWithID(t, conn, id)
		localError := frame.GetLocalError()
		if localError == nil {
			t.Fatalf("cron.manage %s reply = %#v, want local_error", action, frame)
		}
		if !strings.Contains(localError.GetMessage(), "web automation is disabled") {
			t.Fatalf("cron.manage %s error = %q, want web automation disabled message", action, localError.GetMessage())
		}
	}
}

func TestV2CronManageAllowsWhenEnabled(t *testing.T) {
	t.Parallel()

	_, agentSession, conn, cleanup := newV2CronBrowserTest(t, true)
	defer cleanup()

	for _, action := range []string{"cron_apply", "run_now"} {
		id := "cron-enabled-" + action
		sendCronManageAgentRequest(t, conn, id, action)

		outbound := readOutboundEnvelope(t, agentSession)
		if outbound.GetCronManage().GetAction() != action {
			t.Fatalf("outbound = %#v, want forwarded cron.manage %s request", outbound, action)
		}
	}
}
