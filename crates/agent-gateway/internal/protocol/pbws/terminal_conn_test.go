package pbws

// 终端数据面浏览器角色的加固：attach/detach 跟踪表有容量与长度上限，
// 超长/超限的 attach 明确拒绝且不转发给 Agent；trim 前按原始长度拒绝并做
// 有界拷贝，防止 Go 子切片保留整帧缓冲区（接近 1 MiB 的空白前缀 + 短 ID）。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

func newTestTerminalBrowserConn(sm *session.Manager) *terminalBrowserConn {
	if sm == nil {
		sm = session.NewManager()
	}
	return &terminalBrowserConn{
		srv:      &Server{sm: sm},
		sm:       sm,
		agentID:  "agent-x",
		out:      make(chan []byte, terminalWriteQueueSize),
		attached: make(map[string]struct{}),
		streams:  make(map[string]struct{}),
	}
}

func sprintfSessionID(i int) string {
	return "session-" + itoa(i)
}

func sprintfStreamID(i int) string {
	return "stream-" + itoa(i)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var digits []byte
	for i > 0 {
		digits = append([]byte{byte('0' + i%10)}, digits...)
		i /= 10
	}
	return string(digits)
}

func TestTerminalBrowserRememberCapsTrackedIDs(t *testing.T) {
	c := newTestTerminalBrowserConn(nil)

	for i := 0; i < terminalBrowserMaxTrackedIDs; i++ {
		if message := c.remember(sprintfSessionID(i), ""); message != "" {
			t.Fatalf("remember %d = %q, want accepted", i, message)
		}
	}
	// 容量已满：新 id 必须被明确拒绝，而不是静默丢弃。
	if message := c.remember(sprintfSessionID(terminalBrowserMaxTrackedIDs), ""); message == "" {
		t.Fatal("remember over capacity = accepted, want rejection")
	}
	c.mu.RLock()
	attachedCount := len(c.attached)
	c.mu.RUnlock()
	if attachedCount != terminalBrowserMaxTrackedIDs {
		t.Fatalf("attached = %d, want capped at %d", attachedCount, terminalBrowserMaxTrackedIDs)
	}

	streamConn := newTestTerminalBrowserConn(nil)
	for i := 0; i < terminalBrowserMaxTrackedIDs; i++ {
		if message := streamConn.remember("", sprintfStreamID(i)); message != "" {
			t.Fatalf("stream remember %d = %q, want accepted", i, message)
		}
	}
	if message := streamConn.remember("", sprintfStreamID(terminalBrowserMaxTrackedIDs)); message == "" {
		t.Fatal("stream remember over capacity = accepted, want rejection")
	}
	streamConn.mu.RLock()
	streamsCount := len(streamConn.streams)
	streamConn.mu.RUnlock()
	if streamsCount != terminalBrowserMaxTrackedIDs {
		t.Fatalf("streams = %d, want capped at %d", streamsCount, terminalBrowserMaxTrackedIDs)
	}
}

func TestTerminalBrowserRememberRejectsOversizedIDs(t *testing.T) {
	c := newTestTerminalBrowserConn(nil)

	// 空白前缀绕过：trim 前先按原始长度拒绝。trim 后仅 2 字节的短 ID，
	// 原始字段却接近帧上限——旧实现会把它作为合法 key 存入 map，并让
	// 子切片保留整帧内存。
	padded := strings.Repeat(" ", terminalBrowserMaxRawIDLen) + "id"
	if message := c.remember(padded, ""); message == "" {
		t.Fatal("whitespace-padded raw id = accepted, want raw-length rejection")
	}
	if message := c.remember("", strings.Repeat(" ", terminalBrowserMaxRawIDLen)+"st"); message == "" {
		t.Fatal("whitespace-padded raw stream id = accepted, want raw-length rejection")
	}

	// 规范化后超长：原始长度合法（512 < 4 KiB）但 trim 后超过 512，同样拒绝。
	if message := c.remember(strings.Repeat("x", terminalBrowserMaxIDLen+1), ""); message == "" {
		t.Fatal("trimmed-over-limit id = accepted, want rejection")
	}

	c.mu.RLock()
	attachedCount := len(c.attached)
	streamsCount := len(c.streams)
	c.mu.RUnlock()
	if attachedCount != 0 || streamsCount != 0 {
		t.Fatalf("oversized ids tracked: attached=%d streams=%d", attachedCount, streamsCount)
	}

	// 边界长度（原始 512 = 规范化 512）仍然接受。
	if message := c.remember(strings.Repeat("s", terminalBrowserMaxIDLen), ""); message != "" {
		t.Fatalf("boundary-length id rejected: %q", message)
	}
	c.mu.RLock()
	attachedCount = len(c.attached)
	c.mu.RUnlock()
	if attachedCount != 1 {
		t.Fatalf("boundary-length id not tracked: attached=%d", attachedCount)
	}
}

// drainTerminalError 从出站队列读取第一条终端帧并返回其 error 文案。
func drainTerminalError(t *testing.T, c *terminalBrowserConn) string {
	t.Helper()
	select {
	case payload := <-c.out:
		var frame gatewayv2.TerminalServerFrame
		if err := proto.Unmarshal(payload, &frame); err != nil {
			t.Fatalf("unmarshal terminal server frame: %v", err)
		}
		return frame.GetFrame().GetError()
	default:
		t.Fatal("expected an error frame on the outbound queue")
		return ""
	}
}

func withWebTerminalEnabled(t *testing.T) *session.Manager {
	t.Helper()
	sm := session.NewManager()
	sm.ApplySettingsJSON("agent-x", `{"remote":{"enableWebTerminal":true}}`)
	return sm
}

func TestTerminalBrowserHandleFrameRejectsOversizedAttachWithoutForwarding(t *testing.T) {
	sm := withWebTerminalEnabled(t)
	c := newTestTerminalBrowserConn(sm)

	// 超长原始字段的 attach：回错误帧、不进跟踪表、不转发给 Agent
	// （队列里只有我们的拒绝帧，而不是转发路径的 "agent offline"）。
	padded := strings.Repeat(" ", terminalBrowserMaxRawIDLen) + "id"
	c.handleFrame(&gatewayv2.TerminalStreamFrame{
		Kind:      "attach",
		SessionId: padded,
		StreamId:  "stream-1",
	})
	if got := drainTerminalError(t, c); !strings.Contains(got, "too long") {
		t.Fatalf("attach error = %q, want length rejection", got)
	}
	c.mu.RLock()
	attachedCount := len(c.attached)
	c.mu.RUnlock()
	if attachedCount != 0 {
		t.Fatalf("oversized attach tracked: attached=%d", attachedCount)
	}

	// 对照：合法 attach 走到转发步，因没有 Agent 会话得到 "offline" 错误——
	// 证明合法路径未被误伤。
	c.handleFrame(&gatewayv2.TerminalStreamFrame{
		Kind:      "attach",
		SessionId: "session-ok",
		StreamId:  "stream-ok",
	})
	if got := drainTerminalError(t, c); !strings.Contains(got, "offline") {
		t.Fatalf("valid attach error = %q, want forward-path offline error", got)
	}
	c.mu.RLock()
	attachedCount = len(c.attached)
	c.mu.RUnlock()
	if attachedCount != 1 {
		t.Fatalf("valid attach not tracked: attached=%d", attachedCount)
	}
}

func TestTerminalBrowserHandleFrameRejectsFullTrackingTable(t *testing.T) {
	sm := withWebTerminalEnabled(t)
	c := newTestTerminalBrowserConn(sm)

	for i := 0; i < terminalBrowserMaxTrackedIDs; i++ {
		if message := c.remember(sprintfSessionID(i), ""); message != "" {
			t.Fatalf("seed remember %d = %q, want accepted", i, message)
		}
	}

	c.handleFrame(&gatewayv2.TerminalStreamFrame{
		Kind:      "attach",
		SessionId: "session-overflow",
		StreamId:  "",
	})
	if got := drainTerminalError(t, c); !strings.Contains(got, "full") {
		t.Fatalf("overflow attach error = %q, want capacity rejection", got)
	}
	if c.isAttached("session-overflow") {
		t.Fatal("overflow attach tracked despite full table")
	}
}

// ---------------------------------------------------------------------------
// 入站限速绑定回归：文本帧计数 + 限速先于反序列化 + 握手边界（websocket 级）
// ---------------------------------------------------------------------------

// frameReadResult 记录一次 readTerminalFrame / readFrame 调用的三态结果。
type frameReadResult struct {
	gotFrame bool
	denied   bool
	ok       bool
}

// wsTestPair 建立一个仅升级的测试服务：服务端 conn 交给 serve（handler 内
// 同步执行），返回客户端 conn。清理顺序：先关客户端（服务端读循环随之出错
// 返回），再关 httptest server，避免 Close 等待挂起的 handler。
func wsTestPair(t *testing.T, serve func(*websocket.Conn)) *websocket.Conn {
	t.Helper()
	upgrader := websocket.Upgrader{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serve(conn)
	}))
	t.Cleanup(ts.Close)
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial test ws: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func mustMarshalTerminalClientFrame(t *testing.T) []byte {
	t.Helper()
	data, err := proto.Marshal(&gatewayv2.TerminalClientFrame{
		Payload: &gatewayv2.TerminalClientFrame_Frame{
			Frame: &gatewayv2.TerminalStreamFrame{Kind: "input"},
		},
	})
	if err != nil {
		t.Fatalf("marshal terminal client frame: %v", err)
	}
	return data
}

// 文本帧必须与二进制帧同罪计入限速：旧实现中文本帧直接 continue，洪泛零成本。
func TestReadTerminalFrameCountsTextFramesAgainstRateLimit(t *testing.T) {
	results := make(chan frameReadResult, 3)
	// 突发 2、几乎不回填、3 次连续违规判死：两帧文本即耗尽全部预算。
	limiter := wscore.NewInboundRateLimiter(0.0001, 2, 3)
	client := wsTestPair(t, func(conn *websocket.Conn) {
		defer func() { _ = conn.Close() }()
		for i := 0; i < 3; i++ {
			frame, denied, ok := readTerminalFrame(conn, limiter)
			results <- frameReadResult{gotFrame: frame != nil, denied: denied, ok: ok}
			if !ok {
				return
			}
		}
	})

	valid := mustMarshalTerminalClientFrame(t)
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

	// 两帧文本耗尽突发额度后：第 3 帧（合法二进制）必须被限速丢弃——
	// 旧实现中文本帧不计数，此帧会被放行。
	first := <-results
	if !first.denied || !first.ok || first.gotFrame {
		t.Fatalf("first read = %+v, want denied-but-alive (text frames must consume budget)", first)
	}
	second := <-results
	if !second.denied || !second.ok || second.gotFrame {
		t.Fatalf("second read = %+v, want denied-but-alive", second)
	}
	// 3 次连续违规判死。
	third := <-results
	if third.ok {
		t.Fatalf("third read = %+v, want connection closed after 3 consecutive violations", third)
	}
}

// 限速必须发生在 proto 反序列化之前：超限的非法帧在解析前即被丢弃，连接存活；
// 旧顺序（先解析后限速）下非法帧直接破坏帧流、关闭连接。
func TestReadTerminalFrameLimitsBeforeUnmarshal(t *testing.T) {
	results := make(chan frameReadResult, 3)
	// 突发 1、100 帧/秒回填（10ms 一令牌）、违规阈值放宽，隔离限速与判死。
	limiter := wscore.NewInboundRateLimiter(100, 1, 10)
	client := wsTestPair(t, func(conn *websocket.Conn) {
		defer func() { _ = conn.Close() }()
		for i := 0; i < 3; i++ {
			frame, denied, ok := readTerminalFrame(conn, limiter)
			results <- frameReadResult{gotFrame: frame != nil, denied: denied, ok: ok}
			if !ok {
				return
			}
		}
	})

	valid := mustMarshalTerminalClientFrame(t)
	// 帧 1：合法，消耗唯一令牌。
	if err := client.WriteMessage(websocket.BinaryMessage, valid); err != nil {
		t.Fatalf("write valid frame: %v", err)
	}
	// 帧 2：非法 protobuf，立即送达（令牌未回填，必被限速）。若限速发生在
	// 反序列化之后，此帧会因解析失败直接关闭连接，帧 3 永远读不到。
	if err := client.WriteMessage(websocket.BinaryMessage, []byte{0xff, 0xff, 0xff}); err != nil {
		t.Fatalf("write invalid frame: %v", err)
	}
	// 等令牌回填后帧 3 必须仍然可读、可解析。
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

// 握手前洪泛文本帧必须被判死关闭：旧实现 pre-hello 文本帧直接 continue，
// 连接可零成本无限占住 terminal slot。
func TestTerminalHandlerClosesPreHelloTextFlood(t *testing.T) {
	srv := &Server{cfg: &config.Config{Token: "dev-token"}, sm: session.NewManager()}
	ts := httptest.NewServer(srv.TerminalHandler())
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial terminal: %v", err)
	}
	defer func() { _ = conn.Close() }()

	// 突发 200 + 3 次连续违规：300 帧洪泛必然越线。
	for i := 0; i < 300; i++ {
		if err := conn.WriteMessage(websocket.TextMessage, []byte("flood")); err != nil {
			break // 服务端已关闭，后续写入失败属预期
		}
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("connection survived a 300-frame pre-hello text flood, want closed")
	}
}

// 握手绝对时间边界：完全沉默的连接也必须在超时内被关闭。
func TestTerminalHandshakeDeadlineClosesSilentConnection(t *testing.T) {
	old := terminalHandshakeTimeout
	terminalHandshakeTimeout = 50 * time.Millisecond
	defer func() { terminalHandshakeTimeout = old }()

	srv := &Server{cfg: &config.Config{Token: "dev-token"}, sm: session.NewManager()}
	ts := httptest.NewServer(srv.TerminalHandler())
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial terminal: %v", err)
	}
	defer func() { _ = conn.Close() }()

	// 不发任何帧：旧实现下可无限挂住 slot；50ms 握手超时后必须被关闭。
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("silent pre-hello connection was not closed by the handshake deadline")
	}
}

// 正路回归：合法浏览器 hello 在新握手路径（限速器 + 截止时间）下照常放行。
func TestTerminalHandlerBrowserHelloAccepted(t *testing.T) {
	srv := &Server{cfg: &config.Config{Token: "dev-token"}, sm: session.NewManager()}
	ts := httptest.NewServer(srv.TerminalHandler())
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial terminal: %v", err)
	}
	defer func() { _ = conn.Close() }()

	hello, err := proto.Marshal(&gatewayv2.TerminalClientFrame{
		Payload: &gatewayv2.TerminalClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
				AgentId:         "agent-x",
				Token:           "dev-token",
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal hello: %v", err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, hello); err != nil {
		t.Fatalf("write hello: %v", err)
	}

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read server hello: %v", err)
	}
	var frame gatewayv2.TerminalServerFrame
	if err := proto.Unmarshal(payload, &frame); err != nil {
		t.Fatalf("unmarshal server hello: %v", err)
	}
	if !frame.GetHello().GetOk() {
		t.Fatalf("browser hello rejected: %q", frame.GetHello().GetMessage())
	}
}
