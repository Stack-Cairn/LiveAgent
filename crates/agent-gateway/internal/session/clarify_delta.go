package session

import (
	"sync"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// clarifyDeltaHub 把桌面端澄清流式增量交给发起该轮的浏览器。
// 与 unary 等待分离：delta 不得占用 AwaitUnaryResponse 的首条关联响应。
type clarifyDeltaHub struct {
	mu   sync.Mutex
	subs map[string]func(*gatewayv2.ClarifyTurnDelta)
}

func newClarifyDeltaHub() *clarifyDeltaHub {
	return &clarifyDeltaHub{subs: make(map[string]func(*gatewayv2.ClarifyTurnDelta))}
}

// WatchClarifyDeltas 订阅指定（已命名空间化）request_id 的澄清增量。
// 返回退订函数；重复订阅同一 id 覆盖前一个回调。
func (m *Manager) WatchClarifyDeltas(requestID string, fn func(*gatewayv2.ClarifyTurnDelta)) func() {
	if requestID == "" || fn == nil {
		return func() {}
	}
	m.clarifyDeltas.mu.Lock()
	m.clarifyDeltas.subs[requestID] = fn
	m.clarifyDeltas.mu.Unlock()
	return func() {
		m.clarifyDeltas.mu.Lock()
		delete(m.clarifyDeltas.subs, requestID)
		m.clarifyDeltas.mu.Unlock()
	}
}

func (m *Manager) forwardClarifyTurnDelta(requestID string, delta *gatewayv2.ClarifyTurnDelta) {
	if delta == nil || requestID == "" {
		return
	}
	m.clarifyDeltas.mu.Lock()
	fn := m.clarifyDeltas.subs[requestID]
	m.clarifyDeltas.mu.Unlock()
	if fn != nil {
		fn(delta)
	}
}
