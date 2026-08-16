package pbws

// 终端数据面浏览器角色的加固：attach/detach 跟踪表有容量与长度上限，
// 超长/超限的 attach 明确拒绝且不转发给 Agent；trim 前按原始长度拒绝并做
// 有界拷贝，防止 Go 子切片保留整帧缓冲区（接近 1 MiB 的空白前缀 + 短 ID）。

import (
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
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
