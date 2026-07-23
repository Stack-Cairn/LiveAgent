package session

import (
	"context"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// AwaitUnaryResponse 以单次请求-响应语义向目标 Agent 发送信封并等待首条关联响应；
// 取消/超时由调用方 ctx 控制；agentID 必须明确且非空。
func (m *Manager) AwaitUnaryResponse(
	ctx context.Context,
	agentID string,
	requestID string,
	envelope *gatewayv2.GatewayEnvelope,
) (*gatewayv2.AgentEnvelope, error) {
	ch, done, cleanup, err := m.RegisterStreamAndSendContext(ctx, agentID, requestID, envelope)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-done:
		return nil, ErrAgentOffline
	case env, ok := <-ch:
		if !ok {
			return nil, ErrAgentOffline
		}
		return env, nil
	}
}
