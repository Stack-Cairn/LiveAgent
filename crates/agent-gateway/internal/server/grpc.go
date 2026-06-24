package server

import (
	"context"
	"errors"
	"io"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

type GRPCServer struct {
	gatewayv1.UnimplementedAgentGatewayServer

	cfg *config.Config
	sm  *session.Manager
}

func NewGRPCServer(cfg *config.Config, sm *session.Manager) *GRPCServer {
	return &GRPCServer{
		cfg: cfg,
		sm:  sm,
	}
}

func (s *GRPCServer) Authenticate(_ context.Context, req *gatewayv1.AuthRequest) (*gatewayv1.AuthResponse, error) {
	expectedToken := strings.TrimSpace(s.cfg.Token)
	if expectedToken == "" || strings.TrimSpace(req.GetToken()) != expectedToken {
		return &gatewayv1.AuthResponse{
			Success: false,
			Message: "invalid token",
		}, nil
	}

	sessionID := uuid.NewString()
	s.sm.RecordAuthentication(req.GetAgentId(), req.GetAgentVersion(), sessionID)

	return &gatewayv1.AuthResponse{
		Success:   true,
		Message:   "ok",
		SessionId: sessionID,
	}, nil
}

func (s *GRPCServer) AgentConnect(stream gatewayv1.AgentGateway_AgentConnectServer) error {
	authSnapshot := s.sm.LatestAuthSnapshot()
	sess := session.NewAgentSession(authSnapshot)
	toAgent := sess.Outbound()
	s.sm.SetSession(sess)
	defer s.sm.ClearSession(sess)

	ctx, cancel := context.WithCancel(stream.Context())
	defer cancel()

	go s.heartbeatLoop(ctx, sess)
	go func() {
		select {
		case <-ctx.Done():
		case <-sess.Done():
			cancel()
		}
	}()

	sendErrCh := make(chan error, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				sendErrCh <- ctx.Err()
				return
			case <-sess.Done():
				sendErrCh <- nil
				cancel()
				return
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
				if err := stream.Send(outbound.GatewayEnvelope); err != nil {
					outbound.Ack(err)
					sendErrCh <- err
					cancel()
					return
				}
				outbound.Ack(nil)
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-sendErrCh:
			if err == nil || err == context.Canceled {
				return nil
			}
			return err
		default:
		}

		env, err := stream.Recv()
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}

		if env.GetPong() != nil {
			s.sm.TouchHeartbeat(sess)
			continue
		}

		s.sm.DispatchFromAgentForSession(sess, env)
	}
}

func (s *GRPCServer) AgentTerminalConnect(stream gatewayv1.AgentGateway_AgentTerminalConnectServer) error {
	toAgent := make(chan *gatewayv1.TerminalStreamFrame, 4096)
	cleanup := s.sm.RegisterTerminalStreamToAgent(toAgent)
	defer cleanup()

	ctx, cancel := context.WithCancel(stream.Context())
	defer cancel()

	if err := stream.Send(gatewayTerminalStreamReadyFrame()); err != nil {
		return err
	}

	sendErrCh := make(chan error, 1)
	recvErrCh := make(chan error, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case frame := <-toAgent:
				if frame == nil {
					continue
				}
				if err := stream.Send(frame); err != nil {
					sendErrCh <- err
					cancel()
					return
				}
			}
		}
	}()

	go func() {
		frame, err := stream.Recv()
		for err == nil {
			s.sm.BroadcastTerminalStreamFrame(frame)
			frame, err = stream.Recv()
		}
		if err == io.EOF {
			recvErrCh <- nil
		} else {
			recvErrCh <- err
		}
		cancel()
	}()

	for {
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.Canceled) {
				return nil
			}
			return ctx.Err()
		case err := <-sendErrCh:
			cancel()
			if err == nil || errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		case err := <-recvErrCh:
			cancel()
			if err == nil || errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}
	}
}

func gatewayTerminalStreamReadyFrame() *gatewayv1.TerminalStreamFrame {
	return &gatewayv1.TerminalStreamFrame{
		Kind:     "detach",
		StreamId: "gateway-ready-" + uuid.NewString(),
	}
}

func (s *GRPCServer) heartbeatLoop(ctx context.Context, sess *session.AgentSession) {
	period := s.heartbeatPeriod()
	ticker := time.NewTicker(period)
	defer ticker.Stop()

	if !s.sendHeartbeat(sess) {
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
			if !s.sendHeartbeat(sess) {
				return
			}
		}
	}
}

func (s *GRPCServer) heartbeatPeriod() time.Duration {
	if s.cfg == nil || s.cfg.HeartbeatPeriod <= 0 {
		return 30 * time.Second
	}
	return s.cfg.HeartbeatPeriod
}

func (s *GRPCServer) sendHeartbeat(sess *session.AgentSession) bool {
	ok, err := sess.TrySendToAgent(&gatewayv1.GatewayEnvelope{
		RequestId: "ping-" + uuid.NewString(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_Ping{
			Ping: &gatewayv1.PingRequest{
				Timestamp: time.Now().Unix(),
			},
		},
	})
	if errors.Is(err, session.ErrAgentOffline) {
		return false
	}
	if err != nil {
		log.Printf("send heartbeat failed: %v", err)
		return false
	}
	if !ok {
		log.Printf("skip heartbeat: outbound queue is full")
	}
	return true
}
