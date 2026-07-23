package websocket_test

// 每 Agent 凭证（agenttoken）集成测试：角色-凭证绑定、签发/轮换/撤销、撤销踢线。

import (
	"errors"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/db"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

func newAgentTokenStore(t *testing.T) *agenttoken.Store {
	t.Helper()
	_, store := openAgentTokenDB(t, filepath.Join(t.TempDir(), "agent-tokens.db"))
	return store
}

func agentTokenAuthenticates(
	t *testing.T,
	store *agenttoken.Store,
	agentID string,
	token string,
) bool {
	t.Helper()
	_, err := store.AuthenticateAndRegister(agentID, token, false)
	if err == nil {
		return true
	}
	if errors.Is(err, agenttoken.ErrUnauthorized) {
		return false
	}
	t.Fatalf("authenticate agent token: %v", err)
	return false
}

// openAgentTokenDB 打开共享池并初始化凭证表（测试清理时关闭池）。
func openAgentTokenDB(t *testing.T, path string) (*db.DB, *agenttoken.Store) {
	t.Helper()
	database, err := db.Open(path)
	if err != nil {
		t.Fatalf("open gateway db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	store, err := agenttoken.NewStore(database)
	if err != nil {
		t.Fatalf("init agent token store: %v", err)
	}
	return database, store
}

// dialV2AgentHello 拨号 agent 链路并发送 hello，返回服务端的 hello 判定。
func dialV2AgentHello(t *testing.T, handler http.Handler, agentID, token string) *gatewayv2.ServerHello {
	t.Helper()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()

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
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	messageType, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read agent hello reply: %v", err)
	}
	if messageType != websocket.BinaryMessage {
		t.Fatalf("hello reply message type = %d", messageType)
	}
	var frame gatewayv2.AgentServerFrame
	if err := proto.Unmarshal(data, &frame); err != nil {
		t.Fatalf("unmarshal agent hello reply: %v", err)
	}
	hello := frame.GetHello()
	if hello == nil {
		t.Fatalf("agent hello reply = %#v, want hello", &frame)
	}
	return hello
}

func dialV2TerminalAgent(
	t *testing.T,
	handler http.Handler,
	agentID string,
	token string,
) (*websocket.Conn, *gatewayv2.ServerHello, func()) {
	t.Helper()
	conn, cleanup := dialV2(t, handler)
	sendProtoFrame(t, conn, &gatewayv2.TerminalClientFrame{
		Payload: &gatewayv2.TerminalClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_AGENT,
				AgentId:         agentID,
				Token:           token,
			},
		},
	})
	hello := receiveTerminalServerFrame(t, conn).GetHello()
	if hello == nil {
		cleanup()
		t.Fatal("terminal agent hello reply is missing")
	}
	return conn, hello, cleanup
}

func TestAgentCredentialsRequireIssuedToken(t *testing.T) {
	t.Parallel()

	store := newAgentTokenStore(t)
	tokenA, err := store.Issue("agent-a", "")
	if err != nil {
		t.Fatalf("issue agent-a token: %v", err)
	}
	sm := session.NewManager()
	cfg := newV2TestConfig()
	srv := pbws.NewServer(cfg, sm, store)

	// 正确凭证 + 正确 id：通过。
	if hello := dialV2AgentHello(t, srv.AgentHandler(), "agent-a", tokenA); !hello.GetOk() {
		t.Fatalf("agent-a with own token rejected: %q", hello.GetMessage())
	}
	// A 的凭证声明 B 的身份：拒绝（凭证按 id 绑定）。
	if hello := dialV2AgentHello(t, srv.AgentHandler(), "agent-b", tokenA); hello.GetOk() {
		t.Fatal("agent-a token must not authenticate agent-b")
	}
	// agent_id 必填。
	if hello := dialV2AgentHello(t, srv.AgentHandler(), "", tokenA); hello.GetOk() {
		t.Fatal("empty agent_id must be rejected")
	}
}

func TestAgentAuthAcceptsGatewayAndPerAgentTokens(t *testing.T) {
	t.Parallel()

	store := newAgentTokenStore(t)
	agentToken, err := store.Issue("agent-a", "")
	if err != nil {
		t.Fatalf("issue agent token: %v", err)
	}
	srv := pbws.NewServer(newV2TestConfig(), session.NewManager(), store)
	if hello := dialV2AgentHello(t, srv.AgentHandler(), "gateway-token-agent", "ws-token"); !hello.GetOk() {
		t.Fatalf("gateway token rejected: %q", hello.GetMessage())
	}
	if hello := dialV2AgentHello(t, srv.AgentHandler(), "agent-a", agentToken); !hello.GetOk() {
		t.Fatalf("agent token rejected: %q", hello.GetMessage())
	}
	registered, err := store.Registered()
	if err != nil {
		t.Fatalf("list registered agents: %v", err)
	}
	if len(registered) != 2 || registered[1].AgentID != "gateway-token-agent" {
		t.Fatalf("gateway-token agent was not persisted in directory: %#v", registered)
	}
}

func TestTerminalAgentAuthAcceptsGatewayAndPerAgentTokens(t *testing.T) {
	t.Parallel()

	store := newAgentTokenStore(t)
	agentToken, err := store.Issue("agent-a", "")
	if err != nil {
		t.Fatalf("issue agent token: %v", err)
	}
	srv := pbws.NewServer(newV2TestConfig(), session.NewManager(), store)

	for _, test := range []struct {
		name    string
		agentID string
		token   string
	}{
		{name: "gateway token", agentID: "gateway-token-agent", token: "ws-token"},
		{name: "per-agent token", agentID: "agent-a", token: agentToken},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, hello, cleanup := dialV2TerminalAgent(t, srv.TerminalHandler(), test.agentID, test.token)
			defer cleanup()
			if !hello.GetOk() {
				t.Fatalf("terminal agent token rejected: %q", hello.GetMessage())
			}
		})
	}

	_, hello, cleanup := dialV2TerminalAgent(t, srv.TerminalHandler(), "agent-a", "wrong-token")
	defer cleanup()
	if hello.GetOk() || hello.GetMessage() != "unauthorized" {
		t.Fatalf("wrong terminal agent token = %#v, want unauthorized", hello)
	}
}

func TestTerminalAgentCredentialChangesRevokeLiveConnection(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name   string
		revoke func(*testing.T, *agenttoken.Store, *session.Manager)
	}{
		{
			name: "rotation",
			revoke: func(t *testing.T, store *agenttoken.Store, sm *session.Manager) {
				t.Helper()
				if _, err := store.Issue("agent-a", ""); err != nil {
					t.Fatalf("rotate token: %v", err)
				}
				if !sm.DisconnectAgent("agent-a") {
					t.Fatal("rotation did not revoke terminal connection")
				}
			},
		},
		{
			name: "delete",
			revoke: func(t *testing.T, store *agenttoken.Store, sm *session.Manager) {
				t.Helper()
				if deleted, err := store.Delete("agent-a"); err != nil || !deleted {
					t.Fatalf("delete agent = %v, %v", deleted, err)
				}
				if !sm.ForgetAgent("agent-a") {
					t.Fatal("delete did not revoke terminal connection")
				}
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			store := newAgentTokenStore(t)
			token, err := store.Issue("agent-a", "")
			if err != nil {
				t.Fatalf("issue token: %v", err)
			}
			sm := session.NewManager()
			srv := pbws.NewServer(newV2TestConfig(), sm, store)
			conn, hello, cleanup := dialV2TerminalAgent(t, srv.TerminalHandler(), "agent-a", token)
			defer cleanup()
			if !hello.GetOk() {
				t.Fatalf("terminal agent hello rejected: %q", hello.GetMessage())
			}

			test.revoke(t, store, sm)
			if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
				t.Fatalf("set read deadline: %v", err)
			}
			if _, _, err := conn.ReadMessage(); err == nil {
				t.Fatal("revoked terminal connection remained open")
			}
		})
	}
}

func TestAgentIDRequired(t *testing.T) {
	t.Parallel()

	srv := pbws.NewServer(newV2TestConfig(), session.NewManager(), nil)
	hello := dialV2AgentHello(t, srv.AgentHandler(), "", "ws-token")
	if hello.GetOk() || hello.GetMessage() != "agent_id is required" {
		t.Fatalf("agent hello without id = %v, want rejection", hello)
	}
}

func TestAgentTokenRejectedOnBrowserLink(t *testing.T) {
	t.Parallel()

	store := newAgentTokenStore(t)
	tokenA, err := store.Issue("agent-a", "")
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	sm := session.NewManager()
	handler := pbws.NewServer(newV2TestConfig(), sm, store).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()

	// Agent 凭证冒充浏览器（控制端）：必须拒绝——角色-凭证绑定的另一半。
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "hello-agent-token",
		Payload: &gatewayv2.WebClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
				Token:           tokenA,
			},
		},
	})
	frame := receiveWebFrameRaw(t, conn)
	if hello := frame.GetHello(); hello == nil || hello.GetOk() {
		t.Fatalf("browser hello with agent token = %#v, want rejection", frame)
	}
}

func TestTokenRotationInvalidatesOldCredential(t *testing.T) {
	t.Parallel()

	store := newAgentTokenStore(t)
	oldToken, err := store.Issue("agent-a", "")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	newToken, err := store.Issue("agent-a", "")
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if agentTokenAuthenticates(t, store, "agent-a", oldToken) {
		t.Fatal("rotated-out token must be invalid")
	}
	if !agentTokenAuthenticates(t, store, "agent-a", newToken) {
		t.Fatal("rotated-in token must be valid")
	}
}

func TestDeleteInvalidatesAndSurvivesReload(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "agent-tokens.db")
	database, store := openAgentTokenDB(t, path)
	token, err := store.Issue("agent-a", "prod laptop")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// 落盘后重开（模拟网关重启）：凭证仍有效，删除也持久化。
	reloadedDB, reloaded := openAgentTokenDB(t, path)
	if !agentTokenAuthenticates(t, reloaded, "agent-a", token) {
		t.Fatal("token must survive store reload")
	}
	if deleted, err := reloaded.Delete("agent-a"); err != nil || !deleted {
		t.Fatalf("delete = %v, %v", deleted, err)
	}
	if agentTokenAuthenticates(t, reloaded, "agent-a", token) {
		t.Fatal("deleted token must be invalid")
	}
	if err := reloadedDB.Close(); err != nil {
		t.Fatalf("close reloaded: %v", err)
	}

	_, again := openAgentTokenDB(t, path)
	if agentTokenAuthenticates(t, again, "agent-a", token) {
		t.Fatal("deletion must survive reload")
	}
}
