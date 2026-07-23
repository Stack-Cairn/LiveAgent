package pbws

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/observability"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

// browserConnSeq 为每条浏览器连接分配 request_id 命名空间前缀，消除多标签页并发时
// agent 侧关联 id 冲突的可能。
var browserConnSeq atomic.Uint64

// browserConn 是 /ws/v2 上的一条浏览器连接。
type browserConn struct {
	cfg *config.Config
	sm  *session.Manager
	srv *Server

	conn *websocket.Conn
	core *wscore.Conn
	done <-chan struct{}

	// idPrefix + 原始 request_id 构成转发给桌面端的关联 id；回程剥离。
	idPrefix string

	terminalInterest *shared.TerminalInterestTracker

	// dispatchLimiter 限制在途派发数（慢请求 goroutine 上限）；rateLimiter 限制
	// 入站帧速率（快帧 CPU 上限）。两者合围单连接的资源占用。
	dispatchLimiter *wscore.DispatchLimiter
	rateLimiter     *wscore.InboundRateLimiter

	chatStreamsMu sync.Mutex
	chatStreams   map[string]func() // agent_id + conversation_id -> 订阅取消

	workspaceSubsMu sync.Mutex
	workspaceSubs   map[string]*workspaceSubscription
}

// BrowserHandler 返回 /ws/v2 的 HTTP 处理器。
func (s *Server) BrowserHandler() http.Handler {
	upgrader := s.upgrader()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		release, ok := acquireConnSlot(&s.browserConns, s.maxBrowserConnections())
		if !ok {
			http.Error(w, "too many browser connections", http.StatusServiceUnavailable)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			release()
			return
		}
		defer release()
		conn.SetReadLimit(browserReadLimit)

		c := &browserConn{
			cfg:              s.cfg,
			sm:               s.sm,
			srv:              s,
			conn:             conn,
			idPrefix:         browserIDPrefix(),
			terminalInterest: shared.NewTerminalInterestTracker(),
			dispatchLimiter:  wscore.NewDispatchLimiter(maxInflightDispatches),
			rateLimiter: wscore.NewInboundRateLimiter(
				browserInboundFramesPerSecond, browserInboundBurst, browserRateLimitMaxViolations,
			),
		}
		c.core = wscore.NewConn(conn, wscore.Config{
			WriteTimeout:    s.cfg.WebSocketWriteTimeout,
			QueueSize:       s.cfg.WebSocketWriteQueueSize,
			HeartbeatPeriod: s.cfg.WebSocketHeartbeatPeriod,
			HeartbeatGrace:  s.cfg.WebSocketHeartbeatGrace,
			Remote:          r.RemoteAddr,
			OnClose:         c.releaseSubscriptions,
		})
		c.done = c.core.Done()
		// WS 控制帧 pong 由浏览器网络栈应答（后台节流标签页亦然），必须计入存活证据。
		conn.SetPongHandler(func(string) error {
			c.core.TouchInboundActivity()
			return nil
		})
		_ = conn.SetReadDeadline(time.Now().Add(c.core.IdleTimeout()))
		defer c.core.Close()
		c.serve()
	})
}

func browserIDPrefix() string {
	// 前缀短且进程内唯一即可；对端只做等值回显。
	return "b" + strconv.FormatUint(browserConnSeq.Add(1), 10) + ":"
}

// serve 是读循环：首帧必须 hello，之后按载荷臂分发。chat/workspace 订阅生命周期帧在读循环
// 内联执行以保帧序（重订阅连发 [unsubscribe, subscribe]，并发分发会让旧退订取消新订阅）；
// 其余请求各自 goroutine 处理。
func (c *browserConn) serve() {
	if !c.handshake() {
		return
	}

	observability.Usage.V2BrowserConnectionsTotal.Add(1)
	observability.Usage.V2BrowserConnectionsActive.Add(1)
	defer observability.Usage.V2BrowserConnectionsActive.Add(-1)

	for {
		frame, ok := c.readFrame()
		if !ok {
			return
		}
		c.core.TouchInboundActivity()

		// 入站限速：超限丢帧回错，连续违规判定失控客户端、关闭连接。
		if allowed, exceeded := c.rateLimiter.Allow(); !allowed {
			if exceeded {
				return
			}
			_ = c.sendLocalError(frame.GetRequestId(), "too many requests")
			continue
		}

		switch payload := frame.GetPayload().(type) {
		case *gatewayv2.WebClientFrame_Pong:
			continue
		case *gatewayv2.WebClientFrame_Hello:
			_ = c.sendLocalError(frame.GetRequestId(), "already authenticated")
			continue
		case *gatewayv2.WebClientFrame_ChatSubscribe,
			*gatewayv2.WebClientFrame_ChatUnsubscribe,
			*gatewayv2.WebClientFrame_WorkspaceSubscribe,
			*gatewayv2.WebClientFrame_WorkspaceUnsubscribe:
			c.dispatch(frame)
		case nil:
			_ = c.sendLocalError(frame.GetRequestId(), "frame payload is required")
			continue
		default:
			_ = payload
			// try-acquire 失败即拒绝：绝不阻塞读循环等槽位（会拖死 pong/存活检测）。
			if !c.dispatchLimiter.TryAcquire() {
				_ = c.sendLocalError(frame.GetRequestId(), "too many concurrent requests")
				continue
			}
			go func(frame *gatewayv2.WebClientFrame) {
				defer c.dispatchLimiter.Release()
				c.dispatch(frame)
			}(frame)
		}
	}
}

// readFrame 读取并解码一帧；解码失败说明帧流已破坏，直接关闭连接。
func (c *browserConn) readFrame() (*gatewayv2.WebClientFrame, bool) {
	for {
		messageType, data, err := c.conn.ReadMessage()
		if err != nil {
			return nil, false
		}
		if messageType != websocket.BinaryMessage {
			// v2 链路上文本帧无意义；容忍并忽略（仍计入存活）。
			c.core.TouchInboundActivity()
			continue
		}
		var frame gatewayv2.WebClientFrame
		if err := proto.Unmarshal(data, &frame); err != nil {
			return nil, false
		}
		return &frame, true
	}
}

// handshake 处理首帧 hello；失败时写出失败应答并关闭。
func (c *browserConn) handshake() bool {
	frame, ok := c.readFrame()
	if !ok {
		return false
	}
	hello := frame.GetHello()
	verdict := c.srv.vetHello(hello, gatewayv2.ClientRole_CLIENT_ROLE_BROWSER)
	if !verdict.ok {
		_ = writeDirectMessage(c.conn, c.srv.writeTimeout(), &gatewayv2.WebServerFrame{
			RequestId: frame.GetRequestId(),
			Payload: &gatewayv2.WebServerFrame_Hello{
				Hello: c.srv.serverHello(false, verdict.message, "", browserReadLimit),
			},
		})
		closeUnauthorized(c.conn, c.srv.writeTimeout())
		return false
	}

	c.core.SetAuthorized()
	// 握手前的读超时刻意未刷新；成功后立即续期。
	c.core.TouchInboundActivity()
	c.core.StartWriteLoop()
	c.startEventForwarders()
	c.core.StartHeartbeat(c.buildHeartbeatPing)

	// hello 应答走数据队列（FrameResponse）：与快照回放同队 FIFO，保证客户端先收 hello
	// 再收回放帧（跨队列只有优先级、无顺序保证）。
	if err := c.send(wscore.FrameResponse, "hello", &gatewayv2.WebServerFrame{
		RequestId: frame.GetRequestId(),
		Payload: &gatewayv2.WebServerFrame_Hello{
			Hello: c.srv.serverHello(true, "", "", browserReadLimit),
		},
	}); err != nil {
		c.core.Close()
		return false
	}
	c.replaySnapshots()
	return true
}

func (c *browserConn) dispatch(frame *gatewayv2.WebClientFrame) {
	observability.Usage.V2BrowserRequestsTotal.Add(1)
	requestID := strings.TrimSpace(frame.GetRequestId())
	// 目标型请求必须显式声明 Agent；目录与全局会话查询不需要目标 id。
	agentID := strings.TrimSpace(frame.GetAgentId())

	switch payload := frame.GetPayload().(type) {
	case *gatewayv2.WebClientFrame_AgentRequest:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleAgentRequest(requestID, agentID, payload.AgentRequest)
	case *gatewayv2.WebClientFrame_StatusGet:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleStatusGet(requestID, agentID)
	case *gatewayv2.WebClientFrame_ChatCommand:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleChatCommand(requestID, agentID, payload.ChatCommand)
	case *gatewayv2.WebClientFrame_ChatPrepare:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleChatPrepare(requestID, agentID, payload.ChatPrepare)
	case *gatewayv2.WebClientFrame_ChatSubscribe:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleChatSubscribe(requestID, agentID, payload.ChatSubscribe)
	case *gatewayv2.WebClientFrame_ChatUnsubscribe:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleChatUnsubscribe(requestID, agentID, payload.ChatUnsubscribe)
	case *gatewayv2.WebClientFrame_ChatActivities:
		c.handleChatActivities(requestID)
	case *gatewayv2.WebClientFrame_WorkspaceSubscribe:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleWorkspaceSubscribe(requestID, agentID, payload.WorkspaceSubscribe)
	case *gatewayv2.WebClientFrame_WorkspaceUnsubscribe:
		if !c.requireAgentID(requestID, agentID) {
			return
		}
		c.handleWorkspaceUnsubscribe(requestID, agentID, payload.WorkspaceUnsubscribe)
	case *gatewayv2.WebClientFrame_AgentList:
		c.handleAgentList(requestID)
	default:
		_ = c.sendLocalError(requestID, "unsupported frame payload")
	}
}

func (c *browserConn) requireAgentID(requestID, agentID string) bool {
	if agentID != "" {
		return true
	}
	_ = c.sendLocalError(requestID, "agent_id is required")
	return false
}

// send 编码并投递一帧（拥塞策略由帧类别声明，wscore 统一执行）。
func (c *browserConn) send(class wscore.FrameClass, kind string, frame *gatewayv2.WebServerFrame) error {
	data, err := proto.Marshal(frame)
	if err != nil {
		return err
	}
	return c.core.Enqueue(wscore.Frame{
		Class:       class,
		RequestID:   frame.GetRequestId(),
		Kind:        kind,
		MessageType: websocket.BinaryMessage,
		Data:        data,
	})
}

// sendLocalError 回送网关本地结构化错误，走控制队列保证拥塞下可达。
func (c *browserConn) sendLocalError(requestID string, message string) error {
	return c.send(wscore.FrameControl, "local_error", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.WebServerFrame_LocalError{
			LocalError: &gatewayv2.ErrorResponse{Message: message},
		},
	})
}

// buildHeartbeatPing 为共享心跳循环构造应用层 PingFrame。
func (c *browserConn) buildHeartbeatPing() (wscore.Frame, bool) {
	data, err := proto.Marshal(&gatewayv2.WebServerFrame{
		Payload: &gatewayv2.WebServerFrame_Ping{
			Ping: &gatewayv2.PingFrame{Timestamp: time.Now().Unix()},
		},
	})
	if err != nil {
		return wscore.Frame{}, false
	}
	return wscore.Frame{
		Class:       wscore.FramePing,
		Kind:        "ping",
		MessageType: websocket.BinaryMessage,
		Data:        data,
	}, true
}
