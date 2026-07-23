package wscore

import (
	"errors"
	"testing"
	"time"
)

// 写泵语义回归测试（原 internal/server/websocket_write_test.go）：队列路由、
// 拥塞掉帧、关联响应关连接、心跳静默丢弃等行为必须逐一保持。

func newTestConn(queueSize int, writeTimeout time.Duration) *Conn {
	return NewConn(nil, Config{
		QueueSize:    queueSize,
		WriteTimeout: writeTimeout,
	})
}

func TestEnqueueDataWaitsForDrainedSlot(t *testing.T) {
	t.Parallel()

	c := newTestConn(1, 500*time.Millisecond)
	c.Outbox <- Frame{Kind: "ping"}

	go func() {
		time.Sleep(10 * time.Millisecond)
		<-c.Outbox
	}()

	if err := c.Enqueue(Frame{Class: FrameData, Kind: "chat.event"}); err != nil {
		t.Fatalf("Enqueue with draining outbox = %v, want nil", err)
	}
}

func TestEnqueueDataFailsAfterPersistentBacklog(t *testing.T) {
	t.Parallel()

	c := newTestConn(1, 50*time.Millisecond)
	c.Outbox <- Frame{Kind: "ping"}

	started := time.Now()
	err := c.Enqueue(Frame{Class: FrameData, Kind: "chat.event"})
	if !errors.Is(err, ErrWriteQueueFull) {
		t.Fatalf("Enqueue with stuck outbox = %v, want ErrWriteQueueFull", err)
	}
	if waited := time.Since(started); waited < 50*time.Millisecond {
		t.Fatalf("Enqueue gave up after %s, want at least the 50ms write timeout", waited)
	}
}

func TestEnqueueReturnsWhenConnectionCloses(t *testing.T) {
	t.Parallel()

	c := newTestConn(1, time.Second)
	c.Outbox <- Frame{Kind: "ping"}

	go func() {
		time.Sleep(10 * time.Millisecond)
		c.Close()
	}()

	err := c.Enqueue(Frame{Class: FrameData, Kind: "chat.event"})
	if err == nil || err.Error() != "connection closed" {
		t.Fatalf("Enqueue on closed connection = %v, want connection closed", err)
	}
}

func TestControlFramesRouteToControlQueue(t *testing.T) {
	t.Parallel()

	c := newTestConn(1, 50*time.Millisecond)

	if err := c.Enqueue(Frame{Class: FramePing, Kind: "ping"}); err != nil {
		t.Fatalf("Enqueue(ping) = %v, want nil", err)
	}
	for _, kind := range []string{"error", "chat.subscription_reset", "chat.command_update"} {
		if err := c.Enqueue(Frame{Class: FrameControl, Kind: kind}); err != nil {
			t.Fatalf("Enqueue(%q) = %v, want nil", kind, err)
		}
	}
	if got := len(c.CtrlOutbox); got != 4 {
		t.Fatalf("control queue depth = %d, want 4", got)
	}
	if got := len(c.Outbox); got != 0 {
		t.Fatalf("data queue depth = %d, want 0", got)
	}

	if err := c.Enqueue(Frame{Class: FrameData, Kind: "chat.event"}); err != nil {
		t.Fatalf("Enqueue(chat.event) = %v, want nil", err)
	}
	if got := len(c.Outbox); got != 1 {
		t.Fatalf("data queue depth after chat.event = %d, want 1", got)
	}
}

func TestDataQueueFullDoesNotCloseConnection(t *testing.T) {
	t.Parallel()

	c := newTestConn(1, 20*time.Millisecond)
	c.Outbox <- Frame{Kind: "chat.event"}

	err := c.Enqueue(Frame{Class: FrameData, Kind: "chat.event"})
	if !errors.Is(err, ErrWriteQueueFull) {
		t.Fatalf("Enqueue with stuck outbox = %v, want ErrWriteQueueFull", err)
	}
	select {
	case <-c.Done():
		t.Fatal("Enqueue closed the connection on a full data queue")
	default:
	}
	if got := c.DroppedFrames(); got != 1 {
		t.Fatalf("DroppedFrames = %d, want 1", got)
	}
}

func TestResponseQueueFullClosesConnectionForRecovery(t *testing.T) {
	t.Parallel()

	c := newTestConn(1, 20*time.Millisecond)
	c.Outbox <- Frame{Kind: "chat.event"}

	err := c.Enqueue(Frame{Class: FrameResponse, RequestID: "history-1", Kind: "response"})
	if !errors.Is(err, ErrWriteQueueFull) {
		t.Fatalf("Enqueue(response) with stuck outbox = %v, want ErrWriteQueueFull", err)
	}
	select {
	case <-c.Done():
		// 预期：客户端观察到断连即可恢复该关联请求，而非等一个被静默丢弃的响应到超时。
	default:
		t.Fatal("dropping a correlated response left the connection open")
	}
}

func TestPingDroppedSilentlyWhenControlQueueFull(t *testing.T) {
	t.Parallel()

	c := newTestConn(1, time.Second)
	for range DefaultCtrlQueueSize {
		c.CtrlOutbox <- Frame{Kind: "error"}
	}

	started := time.Now()
	if err := c.Enqueue(Frame{Class: FramePing, Kind: "ping"}); err != nil {
		t.Fatalf("Enqueue(ping) with full control queue = %v, want nil (dropped)", err)
	}
	if waited := time.Since(started); waited > 100*time.Millisecond {
		t.Fatalf("ping enqueue blocked for %s, want immediate drop", waited)
	}
	if got := c.DroppedFrames(); got != 1 {
		t.Fatalf("DroppedFrames = %d, want 1", got)
	}
	select {
	case <-c.Done():
		t.Fatal("dropped ping closed the connection")
	default:
	}
}

func TestOnCloseRunsExactlyOnce(t *testing.T) {
	t.Parallel()

	calls := 0
	c := NewConn(nil, Config{OnClose: func() { calls++ }})
	c.Close()
	c.Close()
	if calls != 1 {
		t.Fatalf("OnClose calls = %d, want 1", calls)
	}
}
