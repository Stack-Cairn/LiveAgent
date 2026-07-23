package wscore

import (
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// 写泵行为常量，保持既有稳定取值。
const (
	// DefaultQueueSize 是数据队列默认容量。
	DefaultQueueSize = 512
	// DefaultCtrlQueueSize 是控制队列默认容量。
	DefaultCtrlQueueSize = 64

	maxWriteRetries         = 2
	retryBackoff            = 100 * time.Millisecond
	defaultHeartbeatPeriod  = 15 * time.Second
	heartbeatGraceFloor     = 5 * time.Second
	defaultControlWriteWait = 10 * time.Second
	// writeLoopBatchSize 是一次唤醒最多连续写出的帧数（控制帧优先穿插）。
	writeLoopBatchSize = 64
)

// Config 是连接运行时的行为参数；零值字段取默认。
type Config struct {
	// WriteTimeout 同时用作单帧写超时与入队等待上限。
	WriteTimeout time.Duration
	// QueueSize / CtrlQueueSize 为两条队列的容量。
	QueueSize     int
	CtrlQueueSize int
	// HeartbeatPeriod / HeartbeatGrace 决定心跳周期与空闲驱逐窗口（IdleTimeout = 3*period + grace）。
	HeartbeatPeriod time.Duration
	HeartbeatGrace  time.Duration
	// Remote 是掉帧日志中的对端标识（通常为 RemoteAddr）。
	Remote string
	// OnClose 在连接关闭时恰好回调一次（done 已关闭、底层 ws 尚未关闭），供协议层清理订阅等资源。
	OnClose func()
}

// Conn 是单条 WebSocket 连接的传输运行时。Outbox/CtrlOutbox 由任意 goroutine 经 Enqueue
// 生产、由唯一写泵 goroutine 消费；两通道导出仅为白盒测试，业务代码一律走 Enqueue。
type Conn struct {
	// Outbox 是数据队列（写泵独占消费；除测试外勿直接读写）。
	Outbox chan Frame
	// CtrlOutbox 是控制队列，写泵优先消费它，使拥塞无法饿死心跳与流恢复信号。
	CtrlOutbox chan Frame

	ws  *websocket.Conn
	cfg Config

	writeMu       sync.Mutex
	droppedFrames atomic.Int64

	closeOnce sync.Once
	done      chan struct{}

	// authorized 只在鉴权成功后置位；置位前入站活动不刷新读超时——客户端只有一个
	// IdleTimeout 窗口完成鉴权。
	authorized atomic.Bool

	lastInboundMu sync.Mutex
	lastInboundAt time.Time

	writeLoopOnce sync.Once
	heartbeatOnce sync.Once
}

// NewConn 构造连接运行时。ws 允许为 nil（仅入队语义的单元测试）。
func NewConn(ws *websocket.Conn, cfg Config) *Conn {
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = DefaultQueueSize
	}
	if cfg.CtrlQueueSize <= 0 {
		cfg.CtrlQueueSize = DefaultCtrlQueueSize
	}
	return &Conn{
		Outbox:     make(chan Frame, cfg.QueueSize),
		CtrlOutbox: make(chan Frame, cfg.CtrlQueueSize),
		ws:         ws,
		cfg:        cfg,
		done:       make(chan struct{}),
	}
}

// Done 返回连接关闭信号通道。
func (c *Conn) Done() <-chan struct{} {
	return c.done
}

// Close 幂等关闭连接：先发布 done、回调 OnClose 清理，最后关底层 ws。
func (c *Conn) Close() {
	c.closeOnce.Do(func() {
		close(c.done)
		if c.cfg.OnClose != nil {
			c.cfg.OnClose()
		}
		if c.ws != nil {
			_ = c.ws.Close()
		}
	})
}

// SetAuthorized 标记鉴权完成；此后入站活动开始刷新读超时。
func (c *Conn) SetAuthorized() {
	c.authorized.Store(true)
}

// TouchInboundActivity 记录入站活动并（鉴权后）后推读超时；读循环收到任何帧及 WS pong 回调须调用。
func (c *Conn) TouchInboundActivity() {
	c.lastInboundMu.Lock()
	c.lastInboundAt = time.Now()
	c.lastInboundMu.Unlock()
	if !c.authorized.Load() || c.ws == nil {
		return
	}
	_ = c.ws.SetReadDeadline(time.Now().Add(c.IdleTimeout()))
}

// IdleTimeout 是空闲驱逐窗口：3 个心跳周期加宽限。
func (c *Conn) IdleTimeout() time.Duration {
	period := c.cfg.HeartbeatPeriod
	if period <= 0 {
		period = defaultHeartbeatPeriod
	}
	grace := c.cfg.HeartbeatGrace
	if grace <= 0 {
		grace = heartbeatGraceFloor
	}
	return period*3 + grace
}

// ControlWriteTimeout 是入队等待与控制帧写出的时间上限。
func (c *Conn) ControlWriteTimeout() time.Duration {
	if c.cfg.WriteTimeout > 0 {
		return c.cfg.WriteTimeout
	}
	return defaultControlWriteWait
}

// DroppedFrames 返回累计掉帧数（观测与测试用）。
func (c *Conn) DroppedFrames() int64 {
	return c.droppedFrames.Load()
}

// Enqueue 将帧交给写泵：控制/心跳帧走优先队列；数据帧持续拥塞时丢弃并返回
// ErrWriteQueueFull；FrameResponse 掉帧则关连接，让客户端重连重试而非挂到超时。
func (c *Conn) Enqueue(frame Frame) error {
	if frame.Class == FrameControl || frame.Class == FramePing {
		return c.enqueueControl(frame)
	}
	err := c.enqueueData(frame)
	if errors.Is(err, ErrWriteQueueFull) {
		c.noteDroppedFrame(frame.Kind)
		if frame.Class == FrameResponse {
			c.Close()
		}
	}
	return err
}

// enqueueData 在数据队列瞬时满载时最多等 ControlWriteTimeout，持续积压才报 ErrWriteQueueFull；快速路径零分配。
func (c *Conn) enqueueData(frame Frame) error {
	select {
	case <-c.done:
		return errors.New("connection closed")
	case c.Outbox <- frame:
		return nil
	default:
	}

	timer := time.NewTimer(c.ControlWriteTimeout())
	defer timer.Stop()
	select {
	case <-c.done:
		return errors.New("connection closed")
	case c.Outbox <- frame:
		return nil
	case <-timer.C:
		return ErrWriteQueueFull
	}
}

func (c *Conn) enqueueControl(frame Frame) error {
	select {
	case <-c.done:
		return errors.New("connection closed")
	case c.CtrlOutbox <- frame:
		return nil
	default:
	}

	if frame.Class == FramePing {
		// 心跳是周期性的：控制队列满时静默丢弃，下个周期自然取代。
		c.noteDroppedFrame(frame.Kind)
		return nil
	}

	timer := time.NewTimer(c.ControlWriteTimeout())
	defer timer.Stop()
	select {
	case <-c.done:
		return errors.New("connection closed")
	case c.CtrlOutbox <- frame:
		return nil
	case <-timer.C:
		c.noteDroppedFrame(frame.Kind)
		return ErrWriteQueueFull
	}
}

func (c *Conn) noteDroppedFrame(kind string) {
	dropped := c.droppedFrames.Add(1)
	// 只记第一次与每第 100 次：生产可见掉帧，突发期不刷屏。
	if dropped == 1 || dropped%100 == 0 {
		slog.Warn("websocket: shed frame for slow client",
			"kind", kind,
			"dropped", dropped,
			"remote", c.cfg.Remote,
		)
	}
}

// StartWriteLoop 启动写泵（幂等），协议层在鉴权成功后调用——鉴权前队列无人消费。
func (c *Conn) StartWriteLoop() {
	c.writeLoopOnce.Do(func() {
		go c.writeLoop()
	})
}

// writeLoop 优先清空控制队列再消费数据队列，使拥塞无法饿死心跳与流恢复帧。
func (c *Conn) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case frame := <-c.CtrlOutbox:
			if !c.deliverFrame(frame) {
				return
			}
		case frame := <-c.Outbox:
			if !c.deliverFrame(frame) {
				return
			}
			for drained := 0; drained < writeLoopBatchSize; drained++ {
				select {
				case extra := <-c.CtrlOutbox:
					if !c.deliverFrame(extra) {
						return
					}
					continue
				default:
				}
				select {
				case extra := <-c.Outbox:
					if !c.deliverFrame(extra) {
						return
					}
				default:
					goto batchDone
				}
			}
		batchDone:
		}
	}
}

// deliverFrame 带有限重试地写出一帧；重试耗尽即底层链路不可写，是唯一允许据此关连接的路径。
func (c *Conn) deliverFrame(frame Frame) bool {
	if err := c.writeFrameDirect(frame); err == nil {
		return true
	}
	for attempt := 0; attempt < maxWriteRetries; attempt++ {
		select {
		case <-c.done:
			return false
		case <-time.After(retryBackoff):
		}
		if err := c.writeFrameDirect(frame); err == nil {
			return true
		}
	}
	c.Close()
	return false
}

func (c *Conn) writeFrameDirect(frame Frame) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.cfg.WriteTimeout > 0 {
		if err := c.ws.SetWriteDeadline(time.Now().Add(c.cfg.WriteTimeout)); err != nil {
			return err
		}
		defer func() {
			_ = c.ws.SetWriteDeadline(time.Time{})
		}()
	}
	return c.ws.WriteMessage(frame.MessageType, frame.Data)
}
