package pbws

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/observability"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

// AgentHandler 返回 /ws/v2/agent 的 HTTP 处理器：hello 一并完成鉴权与
// 会话登记，之后进入双向信封流。
func (s *Server) AgentHandler() http.Handler {
	upgrader := s.upgrader()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		release, ok := acquireConnSlot(&s.agentConns, s.maxAgentConnections())
		if !ok {
			http.Error(w, "too many agent connections", http.StatusServiceUnavailable)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			release()
			return
		}
		defer release()
		conn.SetReadLimit(s.readLimit())
		s.serveAgent(conn)
	})
}

func (s *Server) serveAgent(conn *websocket.Conn) {
	defer func() { _ = conn.Close() }()

	// ---- 握手：hello 同时完成鉴权与会话登记 ----
	frame, ok := readAgentFrame(conn)
	if !ok {
		return
	}
	hello := frame.GetHello()
	verdict := s.vetHello(hello, gatewayv2.ClientRole_CLIENT_ROLE_AGENT)
	if !verdict.ok {
		_ = writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.AgentServerFrame{
			Payload: &gatewayv2.AgentServerFrame_Hello{
				Hello: s.serverHello(false, verdict.message, "", s.readLimit()),
			},
		})
		closeUnauthorized(conn, s.writeTimeout())
		return
	}
	authEpoch, err := s.authenticateAgentHello(hello)
	if err != nil {
		message := "gateway storage unavailable"
		if errors.Is(err, agenttoken.ErrUnauthorized) {
			message = "unauthorized"
		}
		_ = writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.AgentServerFrame{
			Payload: &gatewayv2.AgentServerFrame_Hello{
				Hello: s.serverHello(false, message, "", s.readLimit()),
			},
		})
		if errors.Is(err, agenttoken.ErrUnauthorized) {
			closeUnauthorized(conn, s.writeTimeout())
		}
		return
	}

	sessionID := uuid.NewString()
	authSnapshot := session.AuthSnapshot{
		AgentID:      hello.GetAgentId(),
		AgentVersion: hello.GetAgentVersion(),
		SessionID:    sessionID,
	}
	sess := session.NewAgentSession(authSnapshot)
	toAgent := sess.Outbound()
	if !s.sm.SetAuthenticatedSessionIfCurrent(sess, func() bool {
		return s.tokens.AuthenticationCurrent(hello.GetAgentId(), authEpoch)
	}) {
		_ = writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.AgentServerFrame{
			Payload: &gatewayv2.AgentServerFrame_Hello{
				Hello: s.serverHello(false, "unauthorized", "", s.readLimit()),
			},
		})
		closeUnauthorized(conn, s.writeTimeout())
		return
	}
	defer s.sm.ClearSession(sess)
	if err := writeDirectMessage(conn, s.writeTimeout(), &gatewayv2.AgentServerFrame{
		Payload: &gatewayv2.AgentServerFrame_Hello{
			Hello: s.serverHello(true, "", sessionID, s.readLimit()),
		},
	}); err != nil {
		return
	}

	observability.Usage.V2AgentConnectsTotal.Add(1)
	observability.Usage.V2AgentActive.Add(1)
	defer observability.Usage.V2AgentActive.Add(-1)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-ctx.Done():
		case <-sess.Done():
			cancel()
		}
	}()
	// ctx 结束时关闭底层连接，解除读循环的阻塞。
	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()

	go s.agentHeartbeatLoop(ctx, conn, sess)

	// WS 控制帧 pong 计入桌面端存活（对应 h2 keepalive 的职能）。
	conn.SetPongHandler(func(string) error {
		s.sm.TouchHeartbeat(sess)
		return nil
	})

	// ---- 出站泵：心跳专用通道优先，拥塞永远饿不死保活 ----
	go func() {
		defer cancel()
		pings := sess.Pings()
		for {
			select {
			case ping := <-pings:
				if !s.writeAgentEnvelope(conn, ping) {
					return
				}
				continue
			default:
			}
			select {
			case <-ctx.Done():
				return
			case <-sess.Done():
				return
			case ping := <-pings:
				if !s.writeAgentEnvelope(conn, ping) {
					return
				}
			case outbound := <-toAgent:
				if outbound == nil || outbound.GatewayEnvelope == nil {
					continue
				}
				select {
				case <-outbound.Context().Done():
					outbound.Ack(outbound.Context().Err())
					continue
				default:
				}
				if !s.writeAgentEnvelope(conn, outbound.GatewayEnvelope) {
					outbound.Ack(context.Canceled)
					return
				}
				outbound.Ack(nil)
			}
		}
	}()

	// ---- 入站循环 ----
	for {
		frame, ok := readAgentFrame(conn)
		if !ok {
			cancel()
			return
		}
		env := frame.GetEnvelope()
		if env == nil {
			// 重复 hello 或空帧：忽略（仍计入存活）。
			s.sm.TouchHeartbeat(sess)
			continue
		}
		// 任何入站信封都证明桌面端存活；活跃流式传输中的 agent 绝不能被判心跳过期。
		s.sm.TouchHeartbeat(sess)
		// Pong 与其他信封同一分发：关联探测按 request_id 命中注册流，周期心跳的 Pong 无注册流、被无害忽略。
		s.sm.DispatchFromAgentForSession(sess, env)
	}
}

func readAgentFrame(conn *websocket.Conn) (*gatewayv2.AgentClientFrame, bool) {
	for {
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			return nil, false
		}
		if messageType != websocket.BinaryMessage {
			continue
		}
		var frame gatewayv2.AgentClientFrame
		if err := proto.Unmarshal(data, &frame); err != nil {
			return nil, false
		}
		return &frame, true
	}
}

// writeAgentEnvelope 序列化并写出一条 GatewayEnvelope 帧（单写者无需互斥；WriteControl 与之并发安全）。
func (s *Server) writeAgentEnvelope(conn *websocket.Conn, env *gatewayv2.GatewayEnvelope) bool {
	data, err := proto.Marshal(&gatewayv2.AgentServerFrame{
		Payload: &gatewayv2.AgentServerFrame_Envelope{Envelope: env},
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

// agentHeartbeatLoop：周期发应用层 Ping（走专用心跳通道）、
// 驱逐心跳过期会话；额外补发 WS 控制帧 ping，由 tokio-tungstenite 自动 pong 承担传输层保活。
func (s *Server) agentHeartbeatLoop(ctx context.Context, conn *websocket.Conn, sess *session.AgentSession) {
	period := 30 * time.Second
	if s.cfg != nil && s.cfg.HeartbeatPeriod > 0 {
		period = s.cfg.HeartbeatPeriod
	}
	ticker := time.NewTicker(period)
	defer ticker.Stop()

	if !s.sendAgentHeartbeat(sess) {
		return
	}

	timeout := period * 3
	for {
		select {
		case <-ctx.Done():
			return
		case <-sess.Done():
			return
		case <-ticker.C:
			if s.sm.ClearSessionIfHeartbeatStale(sess, timeout) {
				return
			}
			deadline := time.Now().Add(s.writeTimeout())
			_ = conn.WriteControl(websocket.PingMessage, nil, deadline)
			if !s.sendAgentHeartbeat(sess) {
				return
			}
		}
	}
}

func (s *Server) sendAgentHeartbeat(sess *session.AgentSession) bool {
	return sess.SendPing(&gatewayv2.GatewayEnvelope{
		RequestId: "ping-" + uuid.NewString(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv2.GatewayEnvelope_Ping{
			Ping: &gatewayv2.PingRequest{
				Timestamp: time.Now().Unix(),
			},
		},
	}) == nil
}
