package pbws

// 终端数据面浏览器角色的加固：attach/detach 跟踪表有容量与长度上限，
// 防止单连接以任意大小/数量的 session_id 无界增长内存。

import (
	"strings"
	"testing"
)

func newTestTerminalBrowserConn() *terminalBrowserConn {
	return &terminalBrowserConn{
		attached: make(map[string]struct{}),
		streams:  make(map[string]struct{}),
	}
}

func TestTerminalBrowserRememberCapsTrackedIDs(t *testing.T) {
	c := newTestTerminalBrowserConn()

	for i := 0; i < terminalBrowserMaxTrackedIDs+128; i++ {
		c.remember(sprintfSessionID(i), "")
	}
	c.mu.RLock()
	attachedCount := len(c.attached)
	c.mu.RUnlock()
	if attachedCount != terminalBrowserMaxTrackedIDs {
		t.Fatalf("attached = %d, want capped at %d", attachedCount, terminalBrowserMaxTrackedIDs)
	}

	for i := 0; i < terminalBrowserMaxTrackedIDs+128; i++ {
		c.remember("", sprintfStreamID(i))
	}
	c.mu.RLock()
	streamsCount := len(c.streams)
	c.mu.RUnlock()
	if streamsCount != terminalBrowserMaxTrackedIDs {
		t.Fatalf("streams = %d, want capped at %d", streamsCount, terminalBrowserMaxTrackedIDs)
	}
}

func TestTerminalBrowserRememberRejectsOversizedIDs(t *testing.T) {
	c := newTestTerminalBrowserConn()

	// 超长 id（帧内任意长度字符串）不得进入跟踪表。
	c.remember(strings.Repeat("s", terminalBrowserMaxIDLen+1), "")
	c.remember("", strings.Repeat("t", terminalBrowserMaxIDLen+1))

	c.mu.RLock()
	attachedCount := len(c.attached)
	streamsCount := len(c.streams)
	c.mu.RUnlock()
	if attachedCount != 0 || streamsCount != 0 {
		t.Fatalf("oversized ids tracked: attached=%d streams=%d", attachedCount, streamsCount)
	}

	// 边界长度仍然接受。
	c.remember(strings.Repeat("s", terminalBrowserMaxIDLen), "")
	c.mu.RLock()
	attachedCount = len(c.attached)
	c.mu.RUnlock()
	if attachedCount != 1 {
		t.Fatalf("boundary-length id not tracked: attached=%d", attachedCount)
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
