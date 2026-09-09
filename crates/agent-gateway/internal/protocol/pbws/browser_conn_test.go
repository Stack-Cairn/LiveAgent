package pbws

// 主链路读路径与终端链路同形态的限速绑定回归：文本帧计入限速、限速先于
// 反序列化（旧实现 Allow 在 Unmarshal 之后且文本帧直接 continue，可被
// 零成本文本帧洪泛绕过，大帧的解析 CPU 也无法被约束）。

import (
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

// newReadFrameTestConn 构造仅够驱动 readFrame 的轻量 browserConn：
// 读路径只触达 conn / rateLimiter / core.TouchInboundActivity。
func newReadFrameTestConn(conn *websocket.Conn, limiter *wscore.InboundRateLimiter) *browserConn {
	return &browserConn{
		conn:        conn,
		core:        wscore.NewConn(conn, wscore.Config{}),
		rateLimiter: limiter,
	}
}

func mustMarshalWebClientFrame(t *testing.T) []byte {
	t.Helper()
	data, err := proto.Marshal(&gatewayv2.WebClientFrame{})
	if err != nil {
		t.Fatalf("marshal web client frame: %v", err)
	}
	return data
}

// 文本帧必须与二进制帧同罪计入限速：两帧文本耗尽突发额度后，合法二进制帧
// 必须被限速丢弃；旧实现中文本帧不计数，该帧会被放行。
func TestBrowserReadFrameCountsTextFramesAgainstRateLimit(t *testing.T) {
	results := make(chan frameReadResult, 3)
	limiter := wscore.NewInboundRateLimiter(0.0001, 2, 3)
	client := wsTestPair(t, func(conn *websocket.Conn) {
		defer func() { _ = conn.Close() }()
		c := newReadFrameTestConn(conn, limiter)
		for i := 0; i < 3; i++ {
			frame, denied, ok := c.readFrame()
			results <- frameReadResult{gotFrame: frame != nil, denied: denied, ok: ok}
			if !ok {
				return
			}
		}
	})

	valid := mustMarshalWebClientFrame(t)
	writes := []struct {
		messageType int
		data        []byte
	}{
		{websocket.TextMessage, []byte("junk-one")},
		{websocket.TextMessage, []byte("junk-two")},
		{websocket.BinaryMessage, valid},
		{websocket.BinaryMessage, valid},
		{websocket.BinaryMessage, valid},
	}
	for _, write := range writes {
		if err := client.WriteMessage(write.messageType, write.data); err != nil {
			t.Fatalf("write frame: %v", err)
		}
	}

	first := <-results
	if !first.denied || !first.ok || first.gotFrame {
		t.Fatalf("first read = %+v, want denied-but-alive (text frames must consume budget)", first)
	}
	second := <-results
	if !second.denied || !second.ok || second.gotFrame {
		t.Fatalf("second read = %+v, want denied-but-alive", second)
	}
	third := <-results
	if third.ok {
		t.Fatalf("third read = %+v, want connection closed after 3 consecutive violations", third)
	}
}

// 限速必须发生在 proto 反序列化之前：超限的非法帧在解析前即被丢弃、连接
// 存活；旧顺序（先解析后限速）下非法帧直接破坏帧流、关闭连接，第三帧
// 永远读不到。
func TestBrowserReadFrameLimitsBeforeUnmarshal(t *testing.T) {
	results := make(chan frameReadResult, 3)
	limiter := wscore.NewInboundRateLimiter(100, 1, 10)
	client := wsTestPair(t, func(conn *websocket.Conn) {
		defer func() { _ = conn.Close() }()
		c := newReadFrameTestConn(conn, limiter)
		for i := 0; i < 3; i++ {
			frame, denied, ok := c.readFrame()
			results <- frameReadResult{gotFrame: frame != nil, denied: denied, ok: ok}
			if !ok {
				return
			}
		}
	})

	valid := mustMarshalWebClientFrame(t)
	if err := client.WriteMessage(websocket.BinaryMessage, valid); err != nil {
		t.Fatalf("write valid frame: %v", err)
	}
	if err := client.WriteMessage(websocket.BinaryMessage, []byte{0xff, 0xff, 0xff}); err != nil {
		t.Fatalf("write invalid frame: %v", err)
	}
	// 等限速器回填后第三帧必须仍然可读、可解析。
	time.Sleep(30 * time.Millisecond)
	if err := client.WriteMessage(websocket.BinaryMessage, valid); err != nil {
		t.Fatalf("write third frame: %v", err)
	}

	first := <-results
	if !first.gotFrame || !first.ok || first.denied {
		t.Fatalf("first read = %+v, want parsed frame", first)
	}
	second := <-results
	if !second.denied || !second.ok || second.gotFrame {
		t.Fatalf("second read = %+v, want denied-but-alive (rate limit must precede unmarshal)", second)
	}
	third := <-results
	if !third.gotFrame || !third.ok || third.denied {
		t.Fatalf("third read = %+v, want parsed frame after refill", third)
	}
}
