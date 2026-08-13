package websocket_test

// ManagedProcess 快照链路集成测试：agent 发布 ManagedProcessSnapshot 后，已连接
// 浏览器应收到 process_state 广播帧，新连接则应收到缓存回放帧。

import (
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

func receiveProcessStateFrame(t *testing.T, conn *websocket.Conn) *gatewayv2.WebServerFrame {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		frame := receiveWebFrameRaw(t, conn)
		if frame.GetProcessState() != nil {
			return frame
		}
	}
	t.Fatalf("timed out waiting for process_state frame")
	return nil
}

func expectProcessState(t *testing.T, conn *websocket.Conn, context string) {
	t.Helper()
	frame := receiveProcessStateFrame(t, conn)
	if frame.GetAgentId() != "desktop-agent" || frame.GetProcessState().GetRevision() != 7 {
		t.Fatalf("%s frame = agent %q rev %d, want desktop-agent rev 7",
			context, frame.GetAgentId(), frame.GetProcessState().GetRevision())
	}
}

func TestV2ManagedProcessBroadcastAndReplay(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	store := newAgentTokenStore(t)
	agentToken, err := store.Issue("desktop-agent", "")
	if err != nil {
		t.Fatalf("issue desktop agent token: %v", err)
	}
	srv := pbws.NewServer(newV2TestConfig(), sm, store)

	mux := http.NewServeMux()
	mux.Handle("/ws/v2", srv.BrowserHandler())
	mux.Handle("/ws/v2/agent", srv.AgentHandler())

	agentConn, agentCleanup := dialV2Path(t, mux, "/ws/v2/agent")
	defer agentCleanup()
	sendProtoFrame(t, agentConn, &gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_AGENT,
				Token:           agentToken,
				AgentId:         "desktop-agent",
			},
		},
	})
	if hello := receiveAgentServerFrame(t, agentConn).GetHello(); hello == nil || !hello.GetOk() {
		t.Fatalf("agent hello reply = %#v, want ok", hello)
	}

	browserConn, browserCleanup := dialV2Path(t, mux, "/ws/v2")
	defer browserCleanup()
	helloV2(t, browserConn, "ws-token")

	sendProtoFrame(t, agentConn, &gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Envelope{
			Envelope: &gatewayv2.AgentEnvelope{
				RequestId: "managed-process-1",
				Payload: &gatewayv2.AgentEnvelope_ManagedProcessSnapshot{
					ManagedProcessSnapshot: &gatewayv2.ManagedProcessSnapshot{
						Revision: 7,
						Processes: []*gatewayv2.ManagedProcessRecord{
							{Id: "p-1", Command: "sleep 1000", Pid: 4242, Running: true},
						},
					},
				},
			},
		},
	})

	// 已连接浏览器收到广播;新浏览器连接收到缓存回放。
	expectProcessState(t, browserConn, "broadcast")
	browserConn2, browserCleanup2 := dialV2Path(t, mux, "/ws/v2")
	defer browserCleanup2()
	helloV2(t, browserConn2, "ws-token")
	expectProcessState(t, browserConn2, "replay")
}
