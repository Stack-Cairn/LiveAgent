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
				AgentVersion:    "1.0.0",
			},
		},
	})
	agentHello := receiveAgentServerFrame(t, agentConn).GetHello()
	if agentHello == nil || !agentHello.GetOk() {
		t.Fatalf("agent hello reply = %#v, want ok", agentHello)
	}

	browserConn, browserCleanup := dialV2Path(t, mux, "/ws/v2")
	defer browserCleanup()
	helloV2(t, browserConn, "ws-token")

	snapshot := &gatewayv2.ManagedProcessSnapshot{
		Revision: 7,
		Processes: []*gatewayv2.ManagedProcessRecord{{
			Id:        "p-1",
			Command:   "sleep 1000",
			Cwd:       "/tmp",
			Shell:     "zsh",
			Pid:       4242,
			LogPath:   "/tmp/p-1.log",
			StartedAt: time.Now().UnixMilli(),
			Running:   true,
		}},
	}
	sendProtoFrame(t, agentConn, &gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Envelope{
			Envelope: &gatewayv2.AgentEnvelope{
				RequestId: "managed-process-probe",
				Payload:   &gatewayv2.AgentEnvelope_ManagedProcessSnapshot{ManagedProcessSnapshot: snapshot},
			},
		},
	})

	// 已连接浏览器应收到广播。
	frame := receiveProcessStateFrame(t, browserConn)
	if frame.GetAgentId() != "desktop-agent" {
		t.Fatalf("broadcast agent id = %q, want desktop-agent", frame.GetAgentId())
	}
	if got := frame.GetProcessState().GetRevision(); got != 7 {
		t.Fatalf("broadcast revision = %d, want 7", got)
	}
	if len(frame.GetProcessState().GetProcesses()) != 1 {
		t.Fatalf("broadcast processes = %d, want 1", len(frame.GetProcessState().GetProcesses()))
	}

	// 新浏览器连接应回放缓存快照。
	browserConn2, browserCleanup2 := dialV2Path(t, mux, "/ws/v2")
	defer browserCleanup2()
	helloV2(t, browserConn2, "ws-token")
	replay := receiveProcessStateFrame(t, browserConn2)
	if replay.GetAgentId() != "desktop-agent" {
		t.Fatalf("replay agent id = %q, want desktop-agent", replay.GetAgentId())
	}
	if got := replay.GetProcessState().GetRevision(); got != 7 {
		t.Fatalf("replay revision = %d, want 7", got)
	}
}
