package session

import (
	"context"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func NewAgentSession(auth AuthSnapshot) *AgentSession {
	return &AgentSession{
		AgentID:      auth.AgentID,
		AgentVersion: auth.AgentVersion,
		SessionID:    auth.SessionID,
		ConnectedAt:  time.Now(),
		LastPing:     time.Now(),
		toAgent:      make(chan *OutboundEnvelope, 512),
		pingCh:       make(chan *gatewayv2.GatewayEnvelope, 1),
		done:         make(chan struct{}),
		streams:      make(map[string]*agentStream),
	}
}

type OutboundEnvelope struct {
	*gatewayv2.GatewayEnvelope

	ctx    context.Context
	result chan error
}

func (e *OutboundEnvelope) Context() context.Context {
	if e == nil || e.ctx == nil {
		return context.Background()
	}
	return e.ctx
}

func (e *OutboundEnvelope) Ack(err error) {
	if e == nil || e.result == nil {
		return
	}
	select {
	case e.result <- err:
	default:
	}
}

func (s *AgentSession) Outbound() <-chan *OutboundEnvelope {
	return s.toAgent
}

func (s *AgentSession) Pings() <-chan *gatewayv2.GatewayEnvelope {
	return s.pingCh
}

// SendPing queues a heartbeat on a dedicated lane that can never be starved
// by the shared outbound queue. Single producer (heartbeatLoop): a still-queued
// older ping is replaced so the freshest timestamp wins.
func (s *AgentSession) SendPing(env *gatewayv2.GatewayEnvelope) error {
	select {
	case <-s.done:
		return ErrAgentOffline
	default:
	}
	select {
	case s.pingCh <- env:
	default:
		select {
		case <-s.pingCh:
		default:
		}
		select {
		case s.pingCh <- env:
		default:
		}
	}
	return nil
}

func (s *AgentSession) Done() <-chan struct{} {
	return s.done
}

func (s *AgentSession) Close() {
	s.closeOnce.Do(func() {
		s.streamsMu.Lock()
		s.closed = true
		close(s.done)
		for requestID, stream := range s.streams {
			delete(s.streams, requestID)
			stream.close()
		}
		s.streamsMu.Unlock()
	})
}

func (s *AgentSession) SendToAgent(env *gatewayv2.GatewayEnvelope) error {
	return s.enqueueToAgent(context.Background(), env, nil)
}

func (s *AgentSession) SendToAgentContext(ctx context.Context, env *gatewayv2.GatewayEnvelope) error {
	if ctx == nil {
		ctx = context.Background()
	}
	result := make(chan error, 1)
	if err := s.enqueueToAgent(ctx, env, result); err != nil {
		return err
	}

	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		// The envelope stays queued; the writer skips it once its context is
		// expired. A congested-but-alive session must not be torn down here.
		return ctx.Err()
	case <-s.done:
		return ErrAgentOffline
	}
}

func (s *AgentSession) enqueueToAgent(
	ctx context.Context,
	env *gatewayv2.GatewayEnvelope,
	result chan error,
) error {
	s.streamsMu.Lock()
	closed := s.closed
	s.streamsMu.Unlock()
	if closed {
		return ErrAgentOffline
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.done:
		return ErrAgentOffline
	case s.toAgent <- &OutboundEnvelope{
		GatewayEnvelope: env,
		ctx:             ctx,
		result:          result,
	}:
		return nil
	}
}

func (s *AgentSession) TrySendToAgent(env *gatewayv2.GatewayEnvelope) (bool, error) {
	s.streamsMu.Lock()
	closed := s.closed
	s.streamsMu.Unlock()
	if closed {
		return false, ErrAgentOffline
	}

	select {
	case <-s.done:
		return false, ErrAgentOffline
	default:
	}

	select {
	case <-s.done:
		return false, ErrAgentOffline
	case s.toAgent <- &OutboundEnvelope{GatewayEnvelope: env}:
		return true, nil
	default:
		return false, nil
	}
}

func (s *AgentSession) registerStream(requestID string) (*agentStream, error) {
	stream := &agentStream{
		ch:   make(chan *gatewayv2.AgentEnvelope, 64),
		done: make(chan struct{}),
	}

	s.streamsMu.Lock()
	defer s.streamsMu.Unlock()
	if s.closed {
		stream.close()
		return nil, ErrAgentOffline
	}
	if existing, ok := s.streams[requestID]; ok {
		existing.close()
	}
	s.streams[requestID] = stream
	return stream, nil
}

func (s *AgentSession) unregisterStream(requestID string, stream *agentStream) {
	s.streamsMu.Lock()
	if existing, ok := s.streams[requestID]; ok && existing == stream {
		delete(s.streams, requestID)
		existing.close()
	}
	s.streamsMu.Unlock()
}

func (s *AgentSession) dispatch(env *gatewayv2.AgentEnvelope) {
	s.streamsMu.Lock()
	stream := s.streams[env.GetRequestId()]
	s.streamsMu.Unlock()
	if stream == nil {
		return
	}
	stream.send(env)
}

func (s *agentStream) close() {
	s.closeOnce.Do(func() {
		close(s.done)
	})
}

func (s *agentStream) send(env *gatewayv2.AgentEnvelope) bool {
	select {
	case <-s.done:
		return false
	case s.ch <- env:
		return true
	}
}
