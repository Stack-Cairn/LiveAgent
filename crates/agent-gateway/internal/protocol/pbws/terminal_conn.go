package pbws

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/observability"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

// 终端数据面（/ws/v2/terminal）：两端共用一条路径，角色由 hello 区分。浏览器
// 角色维护 attach/detach 订阅并校验 input/resize；Agent 角色登记数据通道并广播
// 入站帧。两端直接传输 proto TerminalStreamFrame。

const terminalWriteQueueSize = 1024

// TerminalHandler 返回 /ws/v2/terminal 的 HTTP 处理器。
func (s *Server) TerminalHandler() http.Handler {
	upgrader := s.upgrader()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		release, ok := acquireConnSlot(&s.terminalConns, s.maxTerminalConnections())
		if !ok {
			http.Error(w, "too many terminal connections", http.StatusServiceUnavailable)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			release()
			return
		}
		defer release()
		// 角色未知前先按浏览器（更严）限额；hello 判定为 Agent 角色后再放宽。
		conn.SetReadLimit(terminalBrowserReadLimit)
		s.serveTerminal(conn)
	})
}

func (s *Server) serveTerminal(conn *websocket.Conn) {
	defer func() { _ = conn.Close() }()

	frame, ok := readTerminalFrame(conn)
	if !ok {
		return
	}
	hello := frame.GetHello()
	// 终端路径两端共用：按 hello 声明的角色校验（未声明按浏览器处理）。
	wantRole := hello.GetRole()
	if wantRole == gatewayv2.ClientRole_CLIENT_ROLE_UNSPECIFIED {
		wantRole = gatewayv2.ClientRole_CLIENT_ROLE_BROWSER
	}
	verdict := s.vetHello(hello, wantRole)
	if verdict.ok && strings.TrimSpace(hello.GetAgentId()) == "" {
		verdict = helloVerdict{message: "agent_id is required"}
	}
	if !verdict.ok {
		_ = writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.TerminalServerFrame{
			Payload: &gatewayv2.TerminalServerFrame_Hello{
				Hello: s.serverHello(false, verdict.message, "", terminalBrowserReadLimit),
			},
		})
		closeUnauthorized(conn, s.writeTimeout())
		return
	}

	boundAgentID := strings.TrimSpace(hello.GetAgentId())
	var (
		authEpoch uint64
		toAgent   chan *gatewayv2.TerminalStreamFrame
		agentCtx  context.Context
		cancel    context.CancelFunc
		cleanup   func()
	)
	if wantRole == gatewayv2.ClientRole_CLIENT_ROLE_AGENT {
		var err error
		authEpoch, err = s.authenticateAgentHello(hello)
		if err != nil {
			message := "gateway storage unavailable"
			if errors.Is(err, agenttoken.ErrUnauthorized) {
				message = "unauthorized"
			}
			_ = writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.TerminalServerFrame{
				Payload: &gatewayv2.TerminalServerFrame_Hello{
					Hello: s.serverHello(false, message, "", terminalAgentReadLimit),
				},
			})
			if errors.Is(err, agenttoken.ErrUnauthorized) {
				closeUnauthorized(conn, s.writeTimeout())
			}
			return
		}

		agentCtx, cancel = context.WithCancel(context.Background())
		defer cancel()
		go func() {
			<-agentCtx.Done()
			_ = conn.Close()
		}()
		toAgent = make(chan *gatewayv2.TerminalStreamFrame, 4096)
		var registered bool
		cleanup, registered = s.sm.RegisterTerminalStreamToAgentIfCurrent(
			boundAgentID,
			toAgent,
			cancel,
			func() bool {
				return s.tokens.AuthenticationCurrent(boundAgentID, authEpoch)
			},
		)
		if !registered {
			_ = writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.TerminalServerFrame{
				Payload: &gatewayv2.TerminalServerFrame_Hello{
					Hello: s.serverHello(false, "unauthorized", "", terminalAgentReadLimit),
				},
			})
			closeUnauthorized(conn, s.writeTimeout())
			return
		}
		defer cleanup()
	}

	// 角色确定后按链路调整读限额并在 hello 中报告实际值。
	roleReadLimit := int64(terminalBrowserReadLimit)
	if wantRole == gatewayv2.ClientRole_CLIENT_ROLE_AGENT {
		roleReadLimit = terminalAgentReadLimit
	}
	conn.SetReadLimit(roleReadLimit)
	if err := writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.TerminalServerFrame{
		Payload: &gatewayv2.TerminalServerFrame_Hello{
			Hello: s.serverHello(true, "", "", roleReadLimit),
		},
	}); err != nil {
		return
	}

	if wantRole == gatewayv2.ClientRole_CLIENT_ROLE_AGENT {
		observability.Usage.V2TerminalConnectsTotal.Add(1)
		s.serveTerminalAgent(conn, boundAgentID, agentCtx, cancel, toAgent)
		return
	}
	observability.Usage.V2TerminalConnectsTotal.Add(1)
	s.serveTerminalBrowser(conn, boundAgentID)
}

func readTerminalFrame(conn *websocket.Conn) (*gatewayv2.TerminalClientFrame, bool) {
	for {
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			return nil, false
		}
		if messageType != websocket.BinaryMessage {
			continue
		}
		var frame gatewayv2.TerminalClientFrame
		if err := proto.Unmarshal(data, &frame); err != nil {
			return nil, false
		}
		return &frame, true
	}
}

// ---------------------------------------------------------------------------
// Agent 角色
// ---------------------------------------------------------------------------

func (s *Server) serveTerminalAgent(
	conn *websocket.Conn,
	agentID string,
	ctx context.Context,
	cancel context.CancelFunc,
	toAgent <-chan *gatewayv2.TerminalStreamFrame,
) {
	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case frame := <-toAgent:
				if frame == nil {
					continue
				}
				if !s.writeTerminalFrame(conn, frame) {
					return
				}
			}
		}
	}()

	for {
		frame, ok := readTerminalFrame(conn)
		if !ok {
			cancel()
			return
		}
		if streamFrame := frame.GetFrame(); streamFrame != nil {
			s.sm.BroadcastTerminalStreamFrame(agentID, streamFrame)
		}
	}
}

func (s *Server) writeTerminalFrame(conn *websocket.Conn, frame *gatewayv2.TerminalStreamFrame) bool {
	data, err := proto.Marshal(&gatewayv2.TerminalServerFrame{
		Payload: &gatewayv2.TerminalServerFrame_Frame{Frame: frame},
	})
	if err != nil {
		return false
	}
	if timeout := s.writeTimeout(); timeout > 0 {
		if err := conn.SetWriteDeadline(time.Now().Add(timeout)); err != nil {
			return false
		}
		defer func() { _ = conn.SetWriteDeadline(time.Time{}) }()
	}
	return conn.WriteMessage(websocket.BinaryMessage, data) == nil
}

// ---------------------------------------------------------------------------
// 浏览器角色
// ---------------------------------------------------------------------------

// terminalBrowserMaxTrackedIDs 限制单连接 attach/detach 跟踪的会话/流 id 数量：
// 无上限时任意长度、任意数量的 session_id 会把网关内存打爆（单帧可达 1 MiB）。
const terminalBrowserMaxTrackedIDs = 512

// terminalBrowserMaxRawIDLen 限制 trim 前的原始字段长度：TrimSpace 返回子切片、
// 底层数组仍持有整帧缓冲区，必须先按原始长度拒绝再规范化。
const terminalBrowserMaxRawIDLen = 4 * 1024

// terminalBrowserMaxIDLen 限制规范化后单个 session_id / stream_id 的长度上限。
const terminalBrowserMaxIDLen = 512

type terminalBrowserConn struct {
	srv  *Server
	sm   *session.Manager
	conn *websocket.Conn
	// agentID 是连接通过 hello.agent_id 显式绑定的目标 Agent；出站按它路由，
	// 入站只放行同源帧。
	agentID string

	out  chan []byte
	done chan struct{}
	once sync.Once

	// rateLimiter 与主链路同款入站限速（100 帧/秒、突发 200、3 次违规断连）：
	// 终端链路此前完全没有帧率限制，可被单连接以任意速率灌帧。
	rateLimiter *wscore.InboundRateLimiter

	mu       sync.RWMutex
	attached map[string]struct{}
	streams  map[string]struct{}
}

func (s *Server) serveTerminalBrowser(conn *websocket.Conn, agentID string) {
	c := &terminalBrowserConn{
		srv:      s,
		sm:       s.sm,
		conn:     conn,
		agentID:  agentID,
		out:      make(chan []byte, terminalWriteQueueSize),
		done:     make(chan struct{}),
		rateLimiter: wscore.NewInboundRateLimiter(
			browserInboundFramesPerSecond, browserInboundBurst, browserRateLimitMaxViolations,
		),
		attached: make(map[string]struct{}),
		streams:  make(map[string]struct{}),
	}
	defer c.close()

	go c.writeLoop()
	c.startForwarder()

	for {
		frame, ok := readTerminalFrame(conn)
		if !ok {
			return
		}
		// 入站限速：与主链路同款，超限丢帧、连续违规判定失控客户端、关闭连接。
		if allowed, exceeded := c.rateLimiter.Allow(); !allowed {
			if exceeded {
				return
			}
			c.enqueueFrame(terminalErrorFrame(
				&gatewayv2.TerminalStreamFrame{Kind: "error"},
				"too many requests",
			))
			continue
		}
		streamFrame := frame.GetFrame()
		if streamFrame == nil {
			continue
		}
		c.handleFrame(streamFrame)
	}
}

func (c *terminalBrowserConn) handleFrame(frame *gatewayv2.TerminalStreamFrame) {
	kind := strings.TrimSpace(frame.GetKind())
	if !c.frameAllowed(frame) {
		c.enqueueFrame(terminalErrorFrame(frame, shared.TerminalPermissionError(kind)))
		return
	}

	switch kind {
	case "attach":
		// 拒绝的 attach 明确回错误帧且不转发给 Agent:超长原始字段、
		// 规范化后超长或跟踪表已满都不得进入后续链路。
		if message := c.remember(frame.GetSessionId(), frame.GetStreamId()); message != "" {
			c.enqueueFrame(terminalErrorFrame(frame, message))
			return
		}
	case "detach":
		c.forget(frame.GetSessionId(), frame.GetStreamId())
	case "input", "resize":
		if !c.isAttached(frame.GetSessionId()) {
			c.enqueueFrame(terminalErrorFrame(frame, "terminal stream is not attached"))
			return
		}
	default:
		c.enqueueFrame(terminalErrorFrame(frame, "unsupported terminal stream frame"))
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.sm.SendTerminalFrameToAgent(ctx, c.agentID, frame); err != nil {
		message := "desktop agent is offline"
		if !errors.Is(err, session.ErrAgentOffline) {
			message = err.Error()
		}
		c.enqueueFrame(terminalErrorFrame(frame, message))
	}
}

func (c *terminalBrowserConn) frameAllowed(frame *gatewayv2.TerminalStreamFrame) bool {
	if frame == nil {
		return false
	}
	view := c.sm.AgentView(c.agentID)
	sessionID := strings.TrimSpace(frame.GetSessionId())
	switch view.TerminalSessionKind(sessionID) {
	case "ssh":
		return view.WebSshTerminalEnabled()
	case "local":
		return view.WebTerminalEnabled()
	default:
		return view.WebTerminalEnabled() || view.WebSshTerminalEnabled()
	}
}

func (c *terminalBrowserConn) startForwarder() {
	frames, cleanup := c.sm.SubscribeTerminalStreamFrames()
	go func() {
		defer cleanup()
		for {
			select {
			case <-c.done:
				return
			case frame, ok := <-frames:
				if !ok {
					c.close()
					return
				}
				if !c.fromBoundAgent(frame.AgentID) || !c.shouldForward(frame.Event) {
					continue
				}
				c.enqueueFrame(frame.Event)
			}
		}
	}()
}

// fromBoundAgent 判断帧来源是否为本连接显式绑定的 Agent。
func (c *terminalBrowserConn) fromBoundAgent(frameAgentID string) bool {
	return frameAgentID == c.agentID
}

func (c *terminalBrowserConn) shouldForward(frame *gatewayv2.TerminalStreamFrame) bool {
	if frame == nil {
		return false
	}
	kind := strings.TrimSpace(frame.GetKind())
	if kind == "snapshot" || kind == "error" {
		return c.knowsStream(frame.GetStreamId())
	}
	if kind != "output" {
		return false
	}
	return c.isAttached(frame.GetSessionId())
}

// remember 登记 attach 的 session/stream id。返回错误信息表示该 attach 必须被
// 拒绝且不得转发给 Agent(超长原始字段 / 规范化后超长 / 跟踪表已满);
// 返回空串表示登记成功。
func (c *terminalBrowserConn) remember(sessionID string, streamID string) string {
	// 先按原始字段长度拒绝:TrimSpace 返回的是原字符串的子切片,底层数组仍
	// 持有整帧缓冲区(帧上限可达 1 MiB)。若先 trim 再截长度,"接近 1 MiB 的
	// 空白前缀 + 短且唯一的 ID" 会以合法长度进入 map,却让每个 key 保留
	// 接近整帧的内存——这正是要在源头上切断的保留路径。
	if len(sessionID) > terminalBrowserMaxRawIDLen || len(streamID) > terminalBrowserMaxRawIDLen {
		return "terminal attach id is too long"
	}
	sessionID = strings.TrimSpace(sessionID)
	streamID = strings.TrimSpace(streamID)
	if sessionID == "" && streamID == "" {
		return "terminal attach id is required"
	}
	if len(sessionID) > terminalBrowserMaxIDLen || len(streamID) > terminalBrowserMaxIDLen {
		return "terminal attach id is too long"
	}
	// 有界拷贝:切断与整帧缓冲区的引用,map key 的底层内存只保留规范化后的
	// 字节(≤ terminalBrowserMaxIDLen)。
	if sessionID != "" {
		sessionID = string([]byte(sessionID))
	}
	if streamID != "" {
		streamID = string([]byte(streamID))
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if sessionID != "" && len(c.attached) >= terminalBrowserMaxTrackedIDs {
		return "terminal attach tracking table is full"
	}
	if streamID != "" && len(c.streams) >= terminalBrowserMaxTrackedIDs {
		return "terminal attach tracking table is full"
	}
	if sessionID != "" {
		c.attached[sessionID] = struct{}{}
	}
	if streamID != "" {
		c.streams[streamID] = struct{}{}
	}
	return ""
}

func (c *terminalBrowserConn) forget(sessionID string, streamID string) {
	sessionID = strings.TrimSpace(sessionID)
	streamID = strings.TrimSpace(streamID)
	if sessionID == "" && streamID == "" {
		return
	}
	c.mu.Lock()
	if sessionID != "" {
		delete(c.attached, sessionID)
	}
	if streamID != "" {
		delete(c.streams, streamID)
	}
	c.mu.Unlock()
}

func (c *terminalBrowserConn) isAttached(sessionID string) bool {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return false
	}
	c.mu.RLock()
	_, ok := c.attached[sessionID]
	c.mu.RUnlock()
	return ok
}

func (c *terminalBrowserConn) knowsStream(streamID string) bool {
	streamID = strings.TrimSpace(streamID)
	if streamID == "" {
		return false
	}
	c.mu.RLock()
	_, ok := c.streams[streamID]
	c.mu.RUnlock()
	return ok
}

// enqueueFrame 在队列满时关闭连接（终端输出无可容忍的丢帧语义，
// 客户端重连后 attach + snapshot 恢复）。
func (c *terminalBrowserConn) enqueueFrame(frame *gatewayv2.TerminalStreamFrame) {
	data, err := proto.Marshal(&gatewayv2.TerminalServerFrame{
		Payload: &gatewayv2.TerminalServerFrame_Frame{Frame: frame},
	})
	if err != nil {
		return
	}
	select {
	case <-c.done:
	case c.out <- data:
	default:
		c.close()
	}
}

func (c *terminalBrowserConn) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case payload := <-c.out:
			if timeout := c.srv.writeTimeout(); timeout > 0 {
				_ = c.conn.SetWriteDeadline(time.Now().Add(timeout))
			}
			if err := c.conn.WriteMessage(websocket.BinaryMessage, payload); err != nil {
				c.close()
				return
			}
			_ = c.conn.SetWriteDeadline(time.Time{})
		}
	}
}

func (c *terminalBrowserConn) close() {
	c.once.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

func terminalErrorFrame(source *gatewayv2.TerminalStreamFrame, message string) *gatewayv2.TerminalStreamFrame {
	return &gatewayv2.TerminalStreamFrame{
		Kind:           "error",
		StreamId:       strings.TrimSpace(source.GetStreamId()),
		SessionId:      strings.TrimSpace(source.GetSessionId()),
		ProjectPathKey: strings.TrimSpace(source.GetProjectPathKey()),
		Error:          strings.TrimSpace(message),
	}
}
