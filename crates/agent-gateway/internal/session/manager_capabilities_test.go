package session

import (
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestChatRuntimeReadinessRequiresChatIngressV1(t *testing.T) {
	manager := NewManager()
	legacy := NewAgentSession(AuthSnapshot{AgentID: "agent-1", SessionID: "legacy-session"})
	manager.SetSession(legacy)
	manager.UpdateRuntimeStatus(legacy, &gatewayv2.RuntimeStatusEvent{
		WorkerId: "worker-1",
		State:    "ready",
		Visible:  true,
	})

	legacyStatus := manager.Status("agent-1")
	if legacyStatus.ChatRuntimeReady {
		t.Fatal("legacy desktop without CHAT_INGRESS_V1 must not be chat-runtime ready")
	}
	if legacyStatus.RuntimeState != "protocol_incompatible" {
		t.Fatalf("legacy runtime state = %q, want protocol_incompatible", legacyStatus.RuntimeState)
	}
	if manager.ChatIngressV1Ready("agent-1") {
		t.Fatal("legacy desktop must not pass CHAT_INGRESS_V1 readiness")
	}

	compatible := NewAgentSession(AuthSnapshot{AgentID: "agent-1", SessionID: "compatible-session"})
	compatible.SetCapabilities([]string{"ignored", gatewayv2.ChatIngressV1Capability})
	manager.SetSession(compatible)
	t.Cleanup(func() { manager.ClearSession(compatible) })
	manager.UpdateRuntimeStatus(compatible, &gatewayv2.RuntimeStatusEvent{
		WorkerId: "worker-2",
		State:    "ready",
		Visible:  true,
	})

	compatibleStatus := manager.Status("agent-1")
	if !compatibleStatus.ChatRuntimeReady {
		t.Fatal("desktop and gateway with CHAT_INGRESS_V1 should be chat-runtime ready")
	}
	if compatibleStatus.RuntimeState != "ready" {
		t.Fatalf("compatible runtime state = %q, want ready", compatibleStatus.RuntimeState)
	}
	if !manager.ChatIngressV1Ready("agent-1") {
		t.Fatal("compatible desktop should pass CHAT_INGRESS_V1 readiness")
	}
}
