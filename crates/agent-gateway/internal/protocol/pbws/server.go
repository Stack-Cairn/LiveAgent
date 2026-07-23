// Package pbws 实现 v2 统一线协议（WebSocket+Protobuf）服务端的三条链路（见 proto/v2/gateway_ws.proto）：
// /ws/v2 浏览器直通、/ws/v2/agent 桌面端信封流、/ws/v2/terminal 终端数据面。
// 本包只做帧编解码、鉴权握手、直通白名单与事件扇出；会话状态复用 session，
// 传输运行时复用 wscore，跨协议域逻辑复用 shared 与 chatcmd。
package pbws

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
)

// Subprotocol 是 v2 的 WebSocket 子协议名；服务端必须回显，否则浏览器主动断开握手。
const Subprotocol = "liveagent.v2.pb"

// ProtocolVersion 是本包实现的协议版本号（ClientHello.protocol_version）。
const ProtocolVersion = 2

// closeCodeUnauthorized 是鉴权失败时的自定义关闭码（4000-4999 为应用保留段）。
const closeCodeUnauthorized = 4401

// 加固上限：单个连接（bug 或凭证被盗）的损害必须被限制在该连接内，不能升级成
// 全网关故障。并发连接上限已改为配置项（config.DefaultMax*Connections 为默认值），
// 以下为每连接粒度的固定值，与总台数无关。
const (
	// 每浏览器连接在途派发上限：直通请求可在 AwaitUnaryResponse 上阻塞至
	// requestTimeout（默认 2 分钟），无上限时重试风暴即 goroutine 泄漏。
	maxInflightDispatches = 16

	// 浏览器链路入站限速（帧/秒）：正常 webui 远低于此，不误伤。
	browserInboundFramesPerSecond = 100
	browserInboundBurst           = 200
	browserRateLimitMaxViolations = 3

	// 读限额按链路收紧：浏览器控制帧合法场景仅数百 KB，64 MiB 上限是内存放大
	// 攻击面；Agent 链路维持配置值（上传需要）。
	browserReadLimit         = 4 << 20
	terminalBrowserReadLimit = 1 << 20
	terminalAgentReadLimit   = 16 << 20
)

// Server 聚合三条 v2 链路的依赖，由 http 路由层构造一次、复用于全部连接。
type Server struct {
	cfg *config.Config
	sm  *session.Manager
	// tokens 是每 Agent 凭证存储；生产网关启动时始终非 nil，nil 仅供轻量测试构造。
	tokens *agenttoken.Store

	agentConns    atomic.Int64
	browserConns  atomic.Int64
	terminalConns atomic.Int64
}

// NewServer 构造 v2 协议服务端；tokens 传 nil 仅用于不涉及持久化的单元测试。
func NewServer(cfg *config.Config, sm *session.Manager, tokens *agenttoken.Store) *Server {
	return &Server{cfg: cfg, sm: sm, tokens: tokens}
}

// acquireConnSlot 在升级前占用一个连接槽位；超限返回 false（调用方回 503）。
func acquireConnSlot(counter *atomic.Int64, limit int64) (func(), bool) {
	if counter.Add(1) > limit {
		counter.Add(-1)
		return nil, false
	}
	released := &atomic.Bool{}
	return func() {
		if released.CompareAndSwap(false, true) {
			counter.Add(-1)
		}
	}, true
}

// 三条链路的并发连接上限：取配置值，未配置回落默认（Load 已兜底，此处再防
// 测试直接构造 Config 的零值）。
func (s *Server) maxAgentConnections() int64 {
	if s.cfg != nil && s.cfg.MaxAgentConnections > 0 {
		return int64(s.cfg.MaxAgentConnections)
	}
	return config.DefaultMaxAgentConnections
}

func (s *Server) maxBrowserConnections() int64 {
	if s.cfg != nil && s.cfg.MaxBrowserConnections > 0 {
		return int64(s.cfg.MaxBrowserConnections)
	}
	return config.DefaultMaxBrowserConnections
}

func (s *Server) maxTerminalConnections() int64 {
	if s.cfg != nil && s.cfg.MaxTerminalConnections > 0 {
		return int64(s.cfg.MaxTerminalConnections)
	}
	return config.DefaultMaxTerminalConnections
}

func (s *Server) upgrader() websocket.Upgrader {
	return websocket.Upgrader{
		Subprotocols: []string{Subprotocol},
		CheckOrigin: func(r *http.Request) bool {
			return shared.OriginAllowed(r)
		},
	}
}

// readLimit 复用 MaxMessageBytes 配置（历史命名保留，语义为消息大小上限）。
func (s *Server) readLimit() int64 {
	if s.cfg != nil && s.cfg.MaxMessageBytes > 0 {
		return int64(s.cfg.MaxMessageBytes)
	}
	return int64(config.DefaultMaxMessageBytes)
}

func (s *Server) heartbeatPeriod() time.Duration {
	if s.cfg != nil && s.cfg.WebSocketHeartbeatPeriod > 0 {
		return s.cfg.WebSocketHeartbeatPeriod
	}
	return 15 * time.Second
}

func (s *Server) writeTimeout() time.Duration {
	if s.cfg != nil && s.cfg.WebSocketWriteTimeout > 0 {
		return s.cfg.WebSocketWriteTimeout
	}
	return 10 * time.Second
}

func (s *Server) requestTimeout() time.Duration {
	if s.cfg != nil && s.cfg.RequestTimeout > 0 {
		return s.cfg.RequestTimeout
	}
	return 2 * time.Minute
}

// errorMessage 把内部错误映射为对客户端友好的信息。
func errorMessage(err error) string {
	if err == nil {
		return "request failed"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "request timed out"
	}
	if errors.Is(err, context.Canceled) {
		return "request canceled"
	}
	if errors.Is(err, session.ErrAgentOffline) {
		return "agent offline"
	}
	return err.Error()
}

// writeDirectMessage 在写泵启动前（握手阶段）直接写出一条二进制帧。
func writeDirectMessage(conn *websocket.Conn, timeout time.Duration, msg proto.Message) error {
	data, err := proto.Marshal(msg)
	if err != nil {
		return err
	}
	if timeout > 0 {
		if err := conn.SetWriteDeadline(time.Now().Add(timeout)); err != nil {
			return err
		}
		defer func() {
			_ = conn.SetWriteDeadline(time.Time{})
		}()
	}
	return conn.WriteMessage(websocket.BinaryMessage, data)
}
