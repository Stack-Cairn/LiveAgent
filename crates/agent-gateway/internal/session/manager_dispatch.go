package session

import (
	"strings"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// DispatchFromAgent 是显式 Agent 测试/嵌入入口；生产 WebSocket 链路使用
// DispatchFromAgentForSession，把身份绑定到已认证连接。
func (m *Manager) DispatchFromAgent(agentID string, env *gatewayv2.AgentEnvelope) {
	session, err := m.resolveSession(agentID)
	if err != nil {
		return
	}
	m.dispatchFromAgent(session, env)
}

func (m *Manager) DispatchFromAgentForSession(session *AgentSession, env *gatewayv2.AgentEnvelope) {
	m.dispatchFromAgent(session, env)
}

func (m *Manager) dispatchFromAgent(expected *AgentSession, env *gatewayv2.AgentEnvelope) {
	// 严格校验 expected 仍是所属登记项的在线会话；被顶替连接的迟到事件直接丢弃。
	var session *AgentSession
	m.registry.mu.RLock()
	if entry := m.registry.entryForSessionLocked(expected); entry != nil {
		session = entry.session
	}
	m.registry.mu.RUnlock()
	if session == nil {
		return
	}
	// 所有入站事件按已认证会话的 agent_id 打标入账——这是跨 Agent 隔离的唯一
	// 事实源：Agent 无法伪造他人身份的事件（身份来自握手，不来自载荷）。
	agentID := session.AgentID
	reliableChatIngress := session.SupportsCapability(gatewayv2.ChatIngressV1Capability)

	if batch := env.GetChatIngressBatch(); batch != nil {
		m.touchRuntimeActivity(session)
		m.queueChatIngressAck(session, env.GetRequestId(), m.ingestChatIngressBatch(agentID, batch))
		return
	}
	if resume := env.GetChatIngressResume(); resume != nil {
		m.touchRuntimeActivity(session)
		for _, ack := range m.ingestChatIngressResume(agentID, resume) {
			m.queueChatIngressAck(session, env.GetRequestId(), ack)
		}
		return
	}
	if fragment := env.GetChatIngressFragment(); fragment != nil {
		m.touchRuntimeActivity(session)
		m.queueChatIngressAck(session, env.GetRequestId(), m.ingestChatIngressFragment(agentID, fragment))
		return
	}

	if runtimeStatus := env.GetRuntimeStatus(); runtimeStatus != nil {
		m.UpdateRuntimeStatus(session, runtimeStatus)
		m.convStreams.onRuntimeStatus(agentID, runtimeStatus, time.Now())
		return
	}

	if env.GetChatEvent() != nil || env.GetChatControl() != nil || env.GetChatRuntimeSnapshot() != nil {
		m.touchRuntimeActivity(session)
	}

	if runtimeSnapshot := env.GetChatRuntimeSnapshot(); runtimeSnapshot != nil {
		if reliableChatIngress {
			return
		}
		m.ingestRuntimeSnapshot(agentID, runtimeSnapshot)
		return
	}

	if chatEvent := env.GetChatEvent(); chatEvent != nil {
		if reliableChatIngress {
			return
		}
		m.ingestChatEvent(agentID, env.GetRequestId(), chatEvent)
	}

	if chatControl := env.GetChatControl(); chatControl != nil {
		controlType := strings.TrimSpace(chatControl.GetType())
		if controlType == "" {
			controlType = strings.TrimSpace(chatControl.GetState())
		}
		if reliableChatIngress && (controlType == "completed" || controlType == "failed" || controlType == "cancelled") {
			return
		}
		m.ingestChatControl(agentID, env.GetRequestId(), chatControl)
	}

	if historySync := env.GetHistorySync(); historySync != nil {
		// Agent-sent running/idle activity is dropped: conversation activity
		// is derived from run lifecycle transitions in the stream store, which
		// always carry run ids.
		switch strings.TrimSpace(historySync.GetKind()) {
		case "running", "idle":
			return
		}
		m.broadcastHistorySync(agentID, historySync)
		return
	}

	if settingsSync := env.GetSettingsSync(); settingsSync != nil {
		m.broadcastSettingsSync(agentID, settingsSync)
		return
	}

	if terminalEvent := env.GetTerminalEvent(); terminalEvent != nil {
		m.broadcastTerminalEvent(agentID, terminalEvent)
		return
	}

	if sftpEvent := env.GetSftpEvent(); sftpEvent != nil {
		m.broadcastSftpEvent(agentID, sftpEvent)
		return
	}

	if chatQueueEvent := env.GetChatQueueEvent(); chatQueueEvent != nil {
		m.broadcastChatQueueEvent(agentID, chatQueueEvent)
		return
	}

	if tunnelFrame := env.GetTunnelFrame(); tunnelFrame != nil {
		m.dispatchTunnelFrame(agentID, tunnelFrame)
		return
	}

	if workspaceActivity := env.GetWorkspaceActivity(); workspaceActivity != nil {
		m.broadcastWorkspaceActivity(agentID, workspaceActivity)
		return
	}

	if managedProcessSnapshot := env.GetManagedProcessSnapshot(); managedProcessSnapshot != nil {
		m.broadcastManagedProcessSnapshot(agentID, managedProcessSnapshot)
		return
	}

	// Desired-state and probe payloads fan out broadcasts and relay probes;
	// run them off the agent stream read loop so tunnel frames keep flowing.
	if tunnelDesired := env.GetTunnelDesired(); tunnelDesired != nil {
		go m.ApplyDesiredState(agentID, tunnelDesired)
		return
	}

	if tunnelProbeReport := env.GetTunnelProbeReport(); tunnelProbeReport != nil {
		go m.ApplyProbeReport(agentID, tunnelProbeReport)
		return
	}

	// TunnelMutationResult and ManagedProcessResponse intentionally fall
	// through to session.dispatch: they answer gateway-issued requests and
	// correlate by request id.
	session.dispatch(env)
}

func (m *Manager) queueChatIngressAck(session *AgentSession, requestID string, ack *gatewayv2.ChatIngressAck) {
	if session == nil || ack == nil {
		return
	}
	queued, err := session.TrySendToAgent(&gatewayv2.GatewayEnvelope{
		RequestId: requestID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv2.GatewayEnvelope_ChatIngressAck{
			ChatIngressAck: ack,
		},
	})
	if err != nil || !queued {
		// An ACK that cannot be queued must force a reconnect. Silently losing
		// it would leave the producer unsure whether the record committed.
		session.Close()
	}
}
