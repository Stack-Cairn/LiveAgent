package wscore

import (
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/liveagent/agent-gateway/internal/observability"
)

// 写泵行为常量，保持既有稳定取值。
const (
	// DefaultQueueSize 是数据队列默认容量。
	DefaultQueueSize = 512
	// DefaultCtrlQueueSize 是控制队列默认容量。
	DefaultCtrlQueueSize = 64
	// DefaultQueueBytes / DefaultCtrlQueueBytes 让队列同时受帧数与字节数约束。
	DefaultQueueBytes     = 8 * 1024 * 1024
	DefaultCtrlQueueBytes = 256 * 1024

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
	// QueueBytes / CtrlQueueBytes 是两条队列的内存上限。
	QueueBytes     int64
	CtrlQueueBytes int64
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

	writeMu            sync.Mutex
	droppedFrames      atomic.Int64
	writerCloses       atomic.Int64
	queueByteOverflows atomic.Int64
	dataBytes          atomic.Int64
	controlBytes       atomic.Int64
	dataFreed          chan struct{}
	controlFreed       chan struct{}
	writeOverride      func(Frame) error

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
	if cfg.QueueBytes <= 0 {
		cfg.QueueBytes = DefaultQueueBytes
	}
	if cfg.CtrlQueueBytes <= 0 {
		cfg.CtrlQueueBytes = DefaultCtrlQueueBytes
	}
	return &Conn{
		Outbox:       make(chan Frame, cfg.QueueSize),
		CtrlOutbox:   make(chan Frame, cfg.CtrlQueueSize),
		ws:           ws,
		cfg:          cfg,
		done:         make(chan struct{}),
		dataFreed:    make(chan struct{}, 1),
		controlFreed: make(chan struct{}, 1),
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

// WriterCloses 返回写泵因底层写错误而关闭连接的累计次数。
func (c *Conn) WriterCloses() int64 {
	return c.writerCloses.Load()
}

// QueueByteOverflows 返回帧或聚合队列超过字节预算的累计次数。
func (c *Conn) QueueByteOverflows() int64 {
	return c.queueByteOverflows.Load()
}

// Enqueue 将帧交给写泵：控制/心跳帧走优先队列；数据帧持续拥塞时丢弃并返回
// ErrWriteQueueFull；FrameResponse 掉帧则关连接，让客户端重连重试而非挂到超时。
func (c *Conn) Enqueue(frame Frame) error {
	if frame.Class == FrameControl || frame.Class == FramePing {
		err := c.enqueueControl(frame)
		if errors.Is(err, ErrWriteQueueFull) || errors.Is(err, ErrWriteFrameTooLarge) {
			c.noteDroppedFrame(frame, "control", writeQueueDropReason(err))
		}
		return err
	}
	err := c.enqueueData(frame)
	if errors.Is(err, ErrWriteQueueFull) || errors.Is(err, ErrWriteFrameTooLarge) {
		c.noteDroppedFrame(frame, "data", writeQueueDropReason(err))
		if frame.Class == FrameResponse {
			c.Close()
		}
	}
	return err
}

// enqueueData 在数据队列瞬时满载时最多等 ControlWriteTimeout，持续积压才报 ErrWriteQueueFull；快速路径零分配。
func (c *Conn) enqueueData(frame Frame) error {
	return c.enqueueBounded(frame, "data", c.Outbox, &c.dataBytes, c.cfg.QueueBytes, c.dataFreed)
}

func (c *Conn) enqueueControl(frame Frame) error {
	if frame.Class == FramePing {
		if c.tryEnqueueBounded(frame, "control", c.CtrlOutbox, &c.controlBytes, c.cfg.CtrlQueueBytes) {
			return nil
		}
		select {
		case <-c.done:
			return errors.New("connection closed")
		default:
			// 心跳是周期性的：控制队列满时静默丢弃，下个周期自然取代。
			c.noteDroppedFrame(frame, "control", "queue_full")
			return nil
		}
	}
	return c.enqueueBounded(frame, "control", c.CtrlOutbox, &c.controlBytes, c.cfg.CtrlQueueBytes, c.controlFreed)
}

func (c *Conn) enqueueBounded(
	frame Frame,
	lane string,
	queue chan<- Frame,
	queuedBytes *atomic.Int64,
	byteLimit int64,
	freed <-chan struct{},
) error {
	frameBytes := int64(len(frame.Data))
	if frameBytes > byteLimit {
		c.noteQueueByteOverflow(frameBytes, lane, "frame_too_large")
		return ErrWriteFrameTooLarge
	}
	timer := time.NewTimer(c.ControlWriteTimeout())
	defer timer.Stop()
	for {
		if reserveQueueBytes(queuedBytes, frameBytes, byteLimit) {
			select {
			case <-c.done:
				releaseQueueBytes(queuedBytes, frameBytes, nil)
				return errors.New("connection closed")
			case queue <- frame:
				return nil
			case <-timer.C:
				releaseQueueBytes(queuedBytes, frameBytes, nil)
				return ErrWriteQueueFull
			}
		}
		select {
		case <-c.done:
			return errors.New("connection closed")
		case <-freed:
		case <-timer.C:
			c.noteQueueByteOverflow(frameBytes, lane, "byte_limit")
			return ErrWriteQueueFull
		}
	}
}

func (c *Conn) tryEnqueueBounded(
	frame Frame,
	lane string,
	queue chan<- Frame,
	queuedBytes *atomic.Int64,
	byteLimit int64,
) bool {
	frameBytes := int64(len(frame.Data))
	if frameBytes > byteLimit {
		c.noteQueueByteOverflow(frameBytes, lane, "frame_too_large")
		return false
	}
	if !reserveQueueBytes(queuedBytes, frameBytes, byteLimit) {
		c.noteQueueByteOverflow(frameBytes, lane, "byte_limit")
		return false
	}
	select {
	case <-c.done:
		releaseQueueBytes(queuedBytes, frameBytes, nil)
		return false
	case queue <- frame:
		return true
	default:
		releaseQueueBytes(queuedBytes, frameBytes, nil)
		return false
	}
}

func reserveQueueBytes(queuedBytes *atomic.Int64, frameBytes, byteLimit int64) bool {
	for {
		current := queuedBytes.Load()
		if frameBytes > byteLimit-current {
			return false
		}
		if queuedBytes.CompareAndSwap(current, current+frameBytes) {
			return true
		}
	}
}

func releaseQueueBytes(queuedBytes *atomic.Int64, frameBytes int64, freed chan<- struct{}) {
	for {
		current := queuedBytes.Load()
		next := current - frameBytes
		if next < 0 {
			next = 0
		}
		if queuedBytes.CompareAndSwap(current, next) {
			break
		}
	}
	if freed != nil {
		select {
		case freed <- struct{}{}:
		default:
		}
	}
}

func (c *Conn) noteDroppedFrame(frame Frame, lane string, reason string) {
	dropped := c.droppedFrames.Add(1)
	// 只记第一次与每第 100 次：生产可见掉帧，突发期不刷屏。
	if dropped == 1 || dropped%100 == 0 {
		slog.Warn("websocket: shed frame for slow client",
			"lane", lane,
			"kind", frame.Kind,
			"request_id", frame.RequestID,
			"remote", c.cfg.Remote,
			"size", len(frame.Data),
			"reason", reason,
		)
	}
}

func (c *Conn) noteQueueByteOverflow(size int64, lane string, reason string) {
	overflows := c.queueByteOverflows.Add(1)
	observability.Usage.WebSocketQueueByteOverflowsTotal.Add(1)
	if overflows == 1 || overflows%100 == 0 {
		slog.Warn("websocket_queue_byte_overflow",
			"lane", lane,
			"remote", c.cfg.Remote,
			"size", size,
			"reason", reason,
		)
	}
}

func writeQueueDropReason(err error) string {
	if errors.Is(err, ErrWriteFrameTooLarge) {
		return "frame_too_large"
	}
	return "queue_full"
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
			if !c.deliverQueuedFrame(frame, true) {
				return
			}
		case frame := <-c.Outbox:
			if !c.deliverQueuedFrame(frame, false) {
				return
			}
			for drained := 0; drained < writeLoopBatchSize; drained++ {
				select {
				case extra := <-c.CtrlOutbox:
					if !c.deliverQueuedFrame(extra, true) {
						return
					}
					continue
				default:
				}
				select {
				case extra := <-c.Outbox:
					if !c.deliverQueuedFrame(extra, false) {
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

// deliverQueuedFrame 在第一次写错误时立即关闭连接；可靠恢复必须发生在新连接上。
func (c *Conn) deliverQueuedFrame(frame Frame, control bool) bool {
	if control {
		defer releaseQueueBytes(&c.controlBytes, int64(len(frame.Data)), c.controlFreed)
	} else {
		defer releaseQueueBytes(&c.dataBytes, int64(len(frame.Data)), c.dataFreed)
	}
	if err := c.writeFrameDirect(frame); err != nil {
		lane := "data"
		if control {
			lane = "control"
		}
		c.writerCloses.Add(1)
		observability.Usage.WebSocketWriterClosesTotal.Add(1)
		slog.Error("websocket_writer_closed",
			"lane", lane,
			"size", len(frame.Data),
			"reason", "write_failed",
		)
		c.Close()
		return false
	}
	return true
}

func (c *Conn) writeFrameDirect(frame Frame) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.writeOverride != nil {
		return c.writeOverride(frame)
	}
	if c.ws == nil {
		return errors.New("websocket connection is nil")
	}
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
