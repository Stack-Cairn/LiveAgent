package websocket_test

// 预认证握手超时：/ws/v2/agent 与 /ws/v2/terminal 升级后必须在握手窗口内
// 完成 hello，否则连接被服务端关闭——无凭据攻击者无法用静默连接永久
// 占用 Agent/Terminal 连接槽位（槽位耗尽 DoS）。认证完成后窗口清除，
// 空闲但健康的连接不被误杀。

import (
	"errors"
	"net"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

// sendAgentHello 发送 agent 角色 hello 并消费服务端 hello 判定。
func sendAgentHello(t *testing.T, conn *websocket.Conn, token, agentID string) {
	t.Helper()
	sendProtoFrame(t, conn, &gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_AGENT,
				AgentId:         agentID,
				Token:           token,
			},
		},
	})
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set hello reply deadline: %v", err)
	}
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatalf("read agent hello reply: %v", err)
	}
}

// newV2ShortTimeoutConfig 把心跳窗口压到亚秒级：IdleTimeout = 3×100ms + 50ms = 350ms，
// 让测试在秒内完成（默认 50s）。
func newV2ShortTimeoutConfig() *config.Config {
	cfg := newV2TestConfig()
	cfg.WebSocketHeartbeatPeriod = 100 * time.Millisecond
	cfg.WebSocketHeartbeatGrace = 50 * time.Millisecond
	return cfg
}

// waitForServerClose 在窗口内读取并判定连接是否被服务端关闭：
// 返回 nil 表示已被关闭；返回 timeout 错误表示连接仍打开（漏洞仍在）。
func waitForServerClose(t *testing.T, conn *websocket.Conn, wait time.Duration) error {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(wait)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	_, _, err := conn.ReadMessage()
	if err == nil {
		t.Fatal("connection still open and readable after handshake window")
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return err // 读超时：连接还开着
	}
	return nil // 服务端已关闭连接
}

func TestV2AgentHandshakeClosesSilentConnection(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	handler := pbws.NewServer(newV2ShortTimeoutConfig(), sm, nil).AgentHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()

	// 静默连接（不发 hello、不发任何字节）必须在 ~350ms 窗口后被服务端关闭。
	if err := waitForServerClose(t, conn, 2*time.Second); err != nil {
		t.Fatalf("silent pre-hello agent connection stayed open past handshake window (%v); slot-exhaustion DoS persists", err)
	}
}

func TestV2TerminalHandshakeClosesSilentConnection(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	handler := pbws.NewServer(newV2ShortTimeoutConfig(), sm, nil).TerminalHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()

	if err := waitForServerClose(t, conn, 2*time.Second); err != nil {
		t.Fatalf("silent pre-hello terminal connection stayed open past handshake window (%v); slot-exhaustion DoS persists", err)
	}
}

func TestV2AgentAuthenticatedConnectionSurvivesIdle(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	sess := session.NewAgentSession(sm.LatestAuthSnapshot("desktop-agent"))
	sm.SetSession(sess)

	handler := pbws.NewServer(newV2ShortTimeoutConfig(), sm, newAgentTokenStore(t)).AgentHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()

	sendAgentHello(t, conn, "ws-token", "desktop-agent")

	// 认证完成后保持静默，时长超过若干倍握手窗口：连接必须仍然存活
	// （认证后的存活由会话心跳维持，不被读超时误杀）。
	time.Sleep(2 * time.Second)
	if err := conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	if _, _, err := conn.ReadMessage(); err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return // 无数据但连接存活：符合预期
		}
		t.Fatalf("authenticated idle agent connection was closed: %v", err)
	}
	// 收到帧（服务端心跳 ping 等）同样证明连接存活：认证后不被读超时误杀。
}
