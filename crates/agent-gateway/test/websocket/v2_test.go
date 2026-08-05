package websocket_test

// v2 浏览器链路集成测试：真实 httptest 服务器 + 二进制 proto 帧，覆盖握手鉴权、本地操作、
// 直通转发（白名单/限额/关联 id 命名空间化）、chat 订阅与事件推送。

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestV2HelloRejectsBadToken(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	handler := pbws.NewServer(newV2TestConfig(), sm, nil).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "hello-bad",
		Payload: &gatewayv2.WebClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Token:           "wrong-token",
			},
		},
	})
	frame := receiveWebFrameRaw(t, conn)
	hello := frame.GetHello()
	if hello == nil || hello.GetOk() {
		t.Fatalf("hello reply = %#v, want ok=false", frame)
	}
	// 其后连接应被服务端关闭。
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("connection stayed open after rejected hello")
	}
}

func TestV2HelloRejectsWrongVersion(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	handler := pbws.NewServer(newV2TestConfig(), sm, nil).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		Payload: &gatewayv2.WebClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{ProtocolVersion: 99, Token: "ws-token"},
		},
	})
	frame := receiveWebFrameRaw(t, conn)
	if hello := frame.GetHello(); hello == nil || hello.GetOk() {
		t.Fatalf("hello reply = %#v, want ok=false for wrong version", frame)
	}
}

func TestV2StatusGet(t *testing.T) {
	t.Parallel()

	_, _, conn, cleanup := newV2BrowserTest(t)
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "status-1",
		AgentId:   "desktop-agent",
		Payload:   &gatewayv2.WebClientFrame_StatusGet{StatusGet: &gatewayv2.StatusGetRequest{}},
	})
	frame := receiveWebFrameWithID(t, conn, "status-1")
	status := frame.GetStatus()
	if status == nil {
		t.Fatalf("status.get reply = %#v, want status payload", frame)
	}
	if !status.GetOnline() || status.GetAgentId() != "desktop-agent" {
		t.Fatalf("status = %#v, want online desktop-agent", status)
	}
}

func TestV2AgentRequestPassthroughRoundtrip(t *testing.T) {
	t.Parallel()

	sm, agentSession, conn, cleanup := newV2BrowserTest(t)
	defer cleanup()

	// page_size 越界应被网关钳制到协议上限（200）。
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "hist-1",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				RequestId: "hist-1",
				Payload: &gatewayv2.GatewayEnvelope_HistoryList{
					HistoryList: &gatewayv2.HistoryListRequest{PageSize: 999},
				},
			},
		},
	})

	outbound := readOutboundEnvelope(t, agentSession)
	if !strings.HasSuffix(outbound.GetRequestId(), ":hist-1") ||
		outbound.GetRequestId() == "hist-1" {
		t.Fatalf("agent request id = %q, want per-connection namespaced hist-1", outbound.GetRequestId())
	}
	if got := outbound.GetHistoryList().GetPageSize(); got != 200 {
		t.Fatalf("page_size = %d, want clamped to 200", got)
	}
	if got := outbound.GetHistoryList().GetPage(); got != 1 {
		t.Fatalf("page = %d, want defaulted to 1", got)
	}

	sm.DispatchFromAgent("desktop-agent", &gatewayv2.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Payload: &gatewayv2.AgentEnvelope_HistoryListResp{
			HistoryListResp: &gatewayv2.HistoryListResponse{TotalCount: 3},
		},
	})

	frame := receiveWebFrameWithID(t, conn, "hist-1")
	response := frame.GetAgentResponse()
	if response == nil {
		t.Fatalf("passthrough reply = %#v, want agent_response", frame)
	}
	// 回程信封的关联 id 已剥离命名空间前缀。
	if response.GetRequestId() != "hist-1" {
		t.Fatalf("agent_response request_id = %q, want hist-1", response.GetRequestId())
	}
	if response.GetHistoryListResp().GetTotalCount() != 3 {
		t.Fatalf("history list resp = %#v, want total_count 3", response)
	}
}

func TestV2GuardRejectsNonWhitelistedArms(t *testing.T) {
	t.Parallel()

	_, _, conn, cleanup := newV2BrowserTest(t)
	defer cleanup()

	// chat_command 必须走网关编排帧，不允许直通。
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "bad-1",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_ChatCommand{
					ChatCommand: &gatewayv2.ChatCommandRequest{Type: "chat.submit"},
				},
			},
		},
	})
	frame := receiveWebFrameWithID(t, conn, "bad-1")
	if frame.GetLocalError() == nil {
		t.Fatalf("chat_command passthrough reply = %#v, want local_error", frame)
	}

	// 内部推送臂同理。
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "bad-2",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_Ping{
					Ping: &gatewayv2.PingRequest{},
				},
			},
		},
	})
	frame = receiveWebFrameWithID(t, conn, "bad-2")
	if frame.GetLocalError() == nil {
		t.Fatalf("ping passthrough reply = %#v, want local_error", frame)
	}
}

func TestV2ChatSubscribeAndStreamEvents(t *testing.T) {
	t.Parallel()

	sm, _, conn, cleanup := newV2BrowserTest(t)
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "sub-1",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_ChatSubscribe{
			ChatSubscribe: &gatewayv2.ChatSubscribeRequest{ConversationId: "conv-1"},
		},
	})
	frame := receiveWebFrameWithID(t, conn, "sub-1")
	subscribed := frame.GetChatSubscribed()
	if subscribed == nil || subscribed.GetConversationId() != "conv-1" {
		t.Fatalf("chat_subscribe reply = %#v, want chat_subscribed conv-1", frame)
	}

	dispatchStarted(sm, "run-1", "conv-1")
	tokenData, _ := json.Marshal(map[string]any{"text": "hello"})
	sm.DispatchFromAgent("desktop-agent", &gatewayv2.AgentEnvelope{
		RequestId: "run-1",
		Payload: &gatewayv2.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv2.ChatEvent{
				Type:           gatewayv2.ChatEvent_TOKEN,
				ConversationId: "conv-1",
				Data:           string(tokenData),
			},
		},
	})

	// 依次应收到 started 与 token 两条流事件。
	sawToken := false
	for attempt := 0; attempt < 8 && !sawToken; attempt++ {
		frame := receiveWebFrame(t, conn)
		event := frame.GetChatEvent()
		if event == nil {
			continue
		}
		if event.GetConversationId() != "conv-1" {
			t.Fatalf("chat_event conversation = %q, want conv-1", event.GetConversationId())
		}
		var payload map[string]any
		if err := json.Unmarshal(event.GetPayloadJson(), &payload); err != nil {
			t.Fatalf("chat_event payload_json invalid: %v", err)
		}
		if payload["type"] == "token" {
			sawToken = true
		}
	}
	if !sawToken {
		t.Fatal("timed out waiting for token chat_event")
	}
}

// TestV2EndToEndBinaryPath 打通首条全二进制路径：假 agent 经 /ws/v2/agent 接入，
// 浏览器经 /ws/v2 直通请求，全程使用 Protobuf 二进制帧。
func TestV2EndToEndBinaryPath(t *testing.T) {
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

	// ---- 假 agent 上线 ----
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
	if agentHello == nil || !agentHello.GetOk() || agentHello.GetSessionId() == "" {
		t.Fatalf("agent hello reply = %#v, want ok with session id", agentHello)
	}

	// ---- 浏览器接入并发起直通请求 ----
	browserConn, browserCleanup := dialV2Path(t, mux, "/ws/v2")
	defer browserCleanup()
	helloV2(t, browserConn, "ws-token")

	sendProtoFrame(t, browserConn, &gatewayv2.WebClientFrame{
		RequestId: "e2e-1",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_SettingsGet{
					SettingsGet: &gatewayv2.SettingsGetRequest{},
				},
			},
		},
	})

	// agent 侧应收到直通信封（跳过心跳 Ping）。
	var inbound *gatewayv2.GatewayEnvelope
	for attempt := 0; attempt < 8; attempt++ {
		envelope := receiveAgentServerFrame(t, agentConn).GetEnvelope()
		if envelope == nil || envelope.GetPing() != nil {
			continue
		}
		inbound = envelope
		break
	}
	if inbound == nil || inbound.GetSettingsGet() == nil {
		t.Fatalf("agent inbound = %#v, want settings_get", inbound)
	}

	sendProtoFrame(t, agentConn, &gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Envelope{
			Envelope: &gatewayv2.AgentEnvelope{
				RequestId: inbound.GetRequestId(),
				Payload: &gatewayv2.AgentEnvelope_SettingsGetResp{
					SettingsGetResp: &gatewayv2.SettingsGetResponse{SettingsJson: `{"ok":true}`},
				},
			},
		},
	})

	frame := receiveWebFrameWithID(t, browserConn, "e2e-1")
	response := frame.GetAgentResponse()
	if response == nil || response.GetSettingsGetResp().GetSettingsJson() != `{"ok":true}` {
		t.Fatalf("e2e reply = %#v, want settings_get_resp", frame)
	}
}

// dialV2Path 对多路由 mux 的指定路径拨号。
func dialV2Path(t *testing.T, handler http.Handler, path string) (*websocket.Conn, func()) {
	t.Helper()
	return dialV2(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = path
		handler.ServeHTTP(w, r)
	}))
}

func receiveAgentServerFrame(t *testing.T, conn *websocket.Conn) *gatewayv2.AgentServerFrame {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set agent read deadline: %v", err)
	}
	messageType, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("receive agent frame: %v", err)
	}
	if messageType != websocket.BinaryMessage {
		t.Fatalf("agent frame message type = %d, want binary", messageType)
	}
	var frame gatewayv2.AgentServerFrame
	if err := proto.Unmarshal(data, &frame); err != nil {
		t.Fatalf("unmarshal agent frame: %v", err)
	}
	return &frame
}
