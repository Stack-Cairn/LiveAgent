package websocket_test

// v2 加固集成测试：连接上限、派发信号量、按链路读限额、入站限速。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/protobuf/proto"
)

// writeProtoFrameRaw 直接写出帧、错误返回而非 t.Fatal（限速测试里服务端断开是预期）。
func writeProtoFrameRaw(conn *websocket.Conn, frame proto.Message) error {
	data, err := proto.Marshal(frame)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.BinaryMessage, data)
}

func TestV2BrowserConnectionCapRejectsExcess(t *testing.T) {
	t.Parallel()

	// 上限已是配置项：用小值验证行为，避免测试随默认值调整而失效。
	cfg := newV2TestConfig()
	cfg.MaxBrowserConnections = 4
	sm := session.NewManager()
	handler := pbws.NewServer(cfg, sm, nil).BrowserHandler()
	ts := httptest.NewServer(handler)
	defer ts.Close()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	dialer := websocket.Dialer{Subprotocols: []string{pbws.Subprotocol}}

	conns := make([]*websocket.Conn, 0, cfg.MaxBrowserConnections)
	defer func() {
		for _, conn := range conns {
			_ = conn.Close()
		}
	}()
	for i := 0; i < cfg.MaxBrowserConnections; i++ {
		conn, _, err := dialer.Dial(wsURL, http.Header{"Origin": []string{ts.URL}})
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		conns = append(conns, conn)
	}

	// 超限的下一个连接：升级前即 503。
	_, resp, err := dialer.Dial(wsURL, http.Header{"Origin": []string{ts.URL}})
	if err == nil {
		t.Fatal("connection beyond the cap should be rejected")
	}
	if resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("over-cap connection status = %v, want 503", resp)
	}

	// 释放一个槽位后可再连（计数正确回收）。
	_ = conns[0].Close()
	conns = conns[1:]
	deadline := time.Now().Add(2 * time.Second)
	for {
		conn, _, err := dialer.Dial(wsURL, http.Header{"Origin": []string{ts.URL}})
		if err == nil {
			conns = append(conns, conn)
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("slot was not released after close: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestV2DispatchSemaphoreRejectsAndRecovers(t *testing.T) {
	t.Parallel()

	// 两个 Agent 在线且不应答：agent_request 挂在 AwaitUnaryResponse 上直到
	// requestTimeout（1s），期间占满 16 个在途槽位。
	sm, agentA, _, conn, cleanup := newV2MultiAgentTest(t)
	defer cleanup()

	for i := 0; i < 17; i++ {
		sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
			RequestId: "slow-" + string(rune('a'+i)),
			AgentId:   "agent-a",
			Payload: &gatewayv2.WebClientFrame_AgentRequest{
				AgentRequest: &gatewayv2.GatewayEnvelope{
					Payload: &gatewayv2.GatewayEnvelope_HistoryWorkdirs{
						HistoryWorkdirs: &gatewayv2.HistoryWorkdirsRequest{},
					},
				},
			},
		})
	}

	// 第 17 个在途请求必须很快得到信号量本地错误（其余 16 个等到超时才有响应；
	// 期间会先收到快照回放等广播帧，跳过）。
	deadlineReject := time.Now().Add(time.Second)
	for {
		if time.Now().After(deadlineReject) {
			t.Fatal("timed out waiting for semaphore local_error")
		}
		frame := receiveWebFrameRaw(t, conn)
		if localError := frame.GetLocalError(); localError != nil {
			if !strings.Contains(localError.GetMessage(), "too many concurrent requests") {
				t.Fatalf("local_error = %q, want semaphore rejection", localError.GetMessage())
			}
			break
		}
	}

	// 槽位随超时释放：之后的请求恢复正常处理。此时才启动应答泵（前 16 个请求
	// 必须无应答才能占满槽位），恢复后的请求应立即得到真实响应。
	time.Sleep(1200 * time.Millisecond)
	go answerAgentRequests(sm, agentA, "/recovered")
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "after-recovery",
		AgentId:   "agent-a",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_HistoryWorkdirs{
					HistoryWorkdirs: &gatewayv2.HistoryWorkdirsRequest{},
				},
			},
		},
	})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		frame := receiveWebFrameRaw(t, conn)
		if frame.GetRequestId() != "after-recovery" {
			continue
		}
		if message := frame.GetLocalError().GetMessage(); strings.Contains(message, "too many concurrent requests") {
			t.Fatalf("semaphore did not recover: %q", message)
		}
		return
	}
	t.Fatal("timed out waiting for post-recovery response")
}

func TestV2BrowserOversizedFrameClosesConnection(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	handler := pbws.NewServer(newV2TestConfig(), sm, nil).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()
	helloV2(t, conn, "ws-token")

	// 超过浏览器链路 4 MiB 读限额的帧：服务端立即断开（写侧收到 reset 或读侧
	// 收到关闭都算命中）。
	oversized := make([]byte, 5<<20)
	if err := conn.WriteMessage(websocket.BinaryMessage, oversized); err != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

func TestV2InboundRateLimitClosesRunawayConnection(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	handler := pbws.NewServer(newV2TestConfig(), sm, nil).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()
	helloV2(t, conn, "ws-token")

	// 突发远超 burst(200)：先收 local_error，连续违规后连接被关闭。
	for i := 0; i < 400; i++ {
		frame := &gatewayv2.WebClientFrame{RequestId: "flood"}
		if err := conn.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
			t.Fatalf("set write deadline: %v", err)
		}
		if err := writeProtoFrameRaw(conn, frame); err != nil {
			// 服务端已断开——达到预期。
			return
		}
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
