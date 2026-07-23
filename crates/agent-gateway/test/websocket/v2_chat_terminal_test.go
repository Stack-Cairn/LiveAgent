package websocket_test

// v2 chat 命令编排与终端链路的集成测试。

import (
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/protobuf/proto"
)

// TestV2ChatCommandAcceptedFlow 覆盖 submit 编排：运行时探活（网关发 Ping、假 agent 回 Pong）
// → 接受回执 → 命令信封投递到 agent。
func TestV2ChatCommandAcceptedFlow(t *testing.T) {
	t.Parallel()

	sm, agentSession, conn, cleanup := newV2BrowserTest(t)
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "cmd-1",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_ChatCommand{
			ChatCommand: &gatewayv2.ChatCommandRequest{
				Type: "chat.submit",
				Request: &gatewayv2.ChatRequest{
					ConversationId:  "conv-cmd",
					ClientRequestId: "client-cmd-1",
					Message:         "hello v2",
				},
			},
		},
	})

	// 网关先发运行时探活；假 agent 应答 Pong。
	answerChatRuntimeProbe(t, sm, agentSession)

	frame := receiveWebFrameWithID(t, conn, "cmd-1")
	accepted := frame.GetChatAccepted()
	if accepted == nil || accepted.GetConversationId() != "conv-cmd" || accepted.GetRunId() == "" {
		t.Fatalf("chat command reply = %#v, want chat_accepted", frame)
	}

	// 命令信封随后投递到 agent。
	outbound := readOutboundEnvelope(t, agentSession)
	command := outbound.GetChatCommand()
	if command.GetType() != "chat.submit" || command.GetRequest().GetMessage() != "hello v2" {
		t.Fatalf("agent chat command = %#v, want chat.submit hello v2", command)
	}
}

func TestV2TerminalBrowserRequiresAgentID(t *testing.T) {
	t.Parallel()

	handler := pbws.NewServer(newV2TestConfig(), session.NewManager(), nil).TerminalHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()
	sendProtoFrame(t, conn, &gatewayv2.TerminalClientFrame{
		Payload: &gatewayv2.TerminalClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
				Token:           "ws-token",
			},
		},
	})
	hello := receiveTerminalServerFrame(t, conn).GetHello()
	if hello == nil || hello.GetOk() || hello.GetMessage() != "agent_id is required" {
		t.Fatalf("terminal hello without agent_id = %v, want rejection", hello)
	}
}

// TestV2TerminalBrowserGating 覆盖终端链路浏览器角色：默认设置下 attach 被权限门控拒绝；
// 开启 Web 终端后 attach 转发失败（agent 离线）也以 error 帧回报。
func TestV2TerminalBrowserGating(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	handler := pbws.NewServer(newV2TestConfig(), sm, nil).TerminalHandler()

	dialTerminal := func() (*websocket.Conn, func()) {
		conn, cleanup := dialV2(t, handler)
		sendProtoFrame(t, conn, &gatewayv2.TerminalClientFrame{
			Payload: &gatewayv2.TerminalClientFrame_Hello{
				Hello: &gatewayv2.ClientHello{
					ProtocolVersion: pbws.ProtocolVersion,
					Role:            gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
					Token:           "ws-token",
					AgentId:         "desktop-agent",
				},
			},
		})
		hello := receiveTerminalServerFrame(t, conn).GetHello()
		if hello == nil || !hello.GetOk() {
			t.Fatalf("terminal hello reply = %#v, want ok", hello)
		}
		return conn, cleanup
	}

	attach := func(conn *websocket.Conn) {
		sendProtoFrame(t, conn, &gatewayv2.TerminalClientFrame{
			Payload: &gatewayv2.TerminalClientFrame_Frame{
				Frame: &gatewayv2.TerminalStreamFrame{
					Kind:      "attach",
					SessionId: "sess-1",
					StreamId:  "stream-1",
				},
			},
		})
	}

	// 默认设置：Web 终端关闭 → 权限错误。
	conn, cleanup := dialTerminal()
	attach(conn)
	frame := receiveTerminalServerFrame(t, conn).GetFrame()
	if frame.GetKind() != "error" || frame.GetError() == "" {
		t.Fatalf("gated attach reply = %#v, want error frame", frame)
	}
	cleanup()

	// 开启 Web 终端：attach 通过门控，但 agent 离线 → 离线错误。
	sm.ApplySettingsJSON("desktop-agent", `{"remote":{"enableWebTerminal":true}}`)
	conn, cleanup = dialTerminal()
	defer cleanup()
	attach(conn)
	frame = receiveTerminalServerFrame(t, conn).GetFrame()
	if frame.GetKind() != "error" || frame.GetError() != "desktop agent is offline" {
		t.Fatalf("offline attach reply = %#v, want agent offline error", frame)
	}
}

// TestV2AgentHelloRejectsBrowserRole 确认角色错配被拒绝。
func TestV2AgentHelloRejectsBrowserRole(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	srv := pbws.NewServer(newV2TestConfig(), sm, nil)
	mux := http.NewServeMux()
	mux.Handle("/ws/v2/agent", srv.AgentHandler())

	conn, cleanup := dialV2Path(t, mux, "/ws/v2/agent")
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
				Token:           "ws-token",
			},
		},
	})
	hello := receiveAgentServerFrame(t, conn).GetHello()
	if hello == nil || hello.GetOk() {
		t.Fatalf("agent hello with browser role = %#v, want ok=false", hello)
	}
}

func receiveTerminalServerFrame(t *testing.T, conn *websocket.Conn) *gatewayv2.TerminalServerFrame {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set terminal read deadline: %v", err)
	}
	messageType, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("receive terminal frame: %v", err)
	}
	if messageType != websocket.BinaryMessage {
		t.Fatalf("terminal frame message type = %d, want binary", messageType)
	}
	var frame gatewayv2.TerminalServerFrame
	if err := proto.Unmarshal(data, &frame); err != nil {
		t.Fatalf("unmarshal terminal frame: %v", err)
	}
	return &frame
}
