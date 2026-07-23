// Package wscore 提供 v2 WebSocket 协议共用的连接运行时（优先级双队列写泵、拥塞掉帧、
// 有限重试、空闲驱逐与心跳）。对帧格式无感：帧以已编码字节入队，协议层负责编码并声明
// 拥塞策略（Frame.Class）。行为与常量沿用经过单元测试固定的实现，无语义变化。
package wscore

import "errors"

// ErrWriteQueueFull 表示帧因持续拥塞被丢弃；协议层可据此对单个流降级恢复而不牺牲整条连接。
var ErrWriteQueueFull = errors.New("write queue full")

// FrameClass 决定帧的入队队列与拥塞策略。
type FrameClass uint8

const (
	// FrameData 是可掉帧的事件/广播数据：走数据队列，持续拥塞时丢弃并返回 ErrWriteQueueFull。
	FrameData FrameClass = iota
	// FrameControl 是尽力送达的控制帧：走优先队列越过数据积压；持续拥塞时丢弃报错但不关连接。
	FrameControl
	// FramePing 是周期心跳：走优先队列，队列满时静默丢弃（下个周期取代）。
	FramePing
	// FrameResponse 是请求关联响应：静默丢弃会让客户端挂到超时，故持续拥塞时关连接促使重连重试。
	FrameResponse
)

// Frame 是写泵承载的单帧描述，载荷为已编码字节。
type Frame struct {
	Class FrameClass
	// RequestID 为关联响应的请求 id，仅用于诊断。
	RequestID string
	// Kind 是帧类型标签（v2 oneof 臂名 / v2 oneof 臂名），仅用于掉帧日志与测试断言。
	Kind string
	// MessageType 为 websocket.TextMessage 或 websocket.BinaryMessage。
	MessageType int
	// Data 为完整的已编码帧载荷。
	Data []byte
}
