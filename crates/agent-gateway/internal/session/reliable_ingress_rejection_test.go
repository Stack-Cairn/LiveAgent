package session

import (
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func newReliableIngressSession(t *testing.T, manager *Manager) *AgentSession {
	t.Helper()
	agentSession := NewAgentSession(AuthSnapshot{AgentID: conversationTestAgentID, SessionID: "session-1"})
	agentSession.SetCapabilities([]string{gatewayv2.ChatIngressV1Capability})
	manager.SetSession(agentSession)
	t.Cleanup(func() { manager.ClearSession(agentSession) })
	return agentSession
}

func dispatchChatControl(manager *Manager, agentSession *AgentSession, runID string, control *gatewayv2.ChatControlEvent) {
	control.RequestId = runID
	manager.DispatchFromAgentForSession(agentSession, &gatewayv2.AgentEnvelope{
		RequestId: runID,
		Payload:   &gatewayv2.AgentEnvelope_ChatControl{ChatControl: control},
	})
}

func runFinishedEvents(events []*ConversationEvent) []*ConversationEvent {
	var finished []*ConversationEvent
	for _, event := range events {
		if event.Type == StreamEventRunFinished {
			finished = append(finished, event)
		}
	}
	return finished
}

func TestReliableIngressAgentRefusalFailsDraftCommandWithItsReason(t *testing.T) {
	manager := NewManager()
	agentSession := newReliableIngressSession(t, manager)
	manager.StartChatCommand(conversationTestAgentID, "run-draft", "", "", "client-1",
		[]map[string]any{{"type": "user_message", "message": "hello"}})

	dispatchChatControl(manager, agentSession, "run-draft", &gatewayv2.ChatControlEvent{
		ConversationId: "conv-desktop",
		Type:           "failed",
		ErrorCode:      "model_config_provider_type_mismatch",
		Message:        "provider type differs",
	})

	updates, cleanup := manager.WatchChatCommand(conversationTestAgentID, "run-draft")
	defer cleanup()
	select {
	case update := <-updates:
		if update.Phase != "failed" ||
			update.ErrorCode != "model_config_provider_type_mismatch" ||
			update.Message != "provider type differs" ||
			update.ClientRequestID != "client-1" {
			t.Fatalf("update = %+v", update)
		}
	default:
		t.Fatal("desktop refusal did not fail the command")
	}

	// The startup watchdog firing later must not replace the real reason.
	manager.FailChatCommand(conversationTestAgentID, "run-draft", "startup_timeout", "timeout")
	select {
	case update := <-updates:
		t.Fatalf("watchdog produced a second update: %+v", update)
	default:
	}
}

func TestReliableIngressAgentRefusalFinishesBoundCommandWithItsReason(t *testing.T) {
	manager := NewManager()
	agentSession := newReliableIngressSession(t, manager)
	manager.StartChatCommand(conversationTestAgentID, "run-bound", "conv-1", "", "client-1",
		[]map[string]any{{"type": "user_message", "message": "hello"}})

	dispatchChatControl(manager, agentSession, "run-bound", &gatewayv2.ChatControlEvent{
		ConversationId: "conv-1",
		Type:           "failed",
		ErrorCode:      "model_config_model_disabled",
		Message:        "model disabled",
	})

	if !manager.ChatCommandSettled(conversationTestAgentID, "run-bound") {
		t.Fatal("refused command is not settled; the startup watchdog would still fire")
	}
	subscription := manager.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer subscription.Cleanup()
	finished := runFinishedEvents(subscription.Events)
	if len(finished) != 1 {
		t.Fatalf("events = %v", eventTypes(subscription.Events))
	}
	payload := finished[0].Payload
	if payload["status"] != "failed" ||
		payload["error_code"] != "model_config_model_disabled" ||
		payload["message"] != "model disabled" {
		t.Fatalf("run_finished payload = %#v", payload)
	}
}

func TestReliableIngressAgentFailureAfterStartIsLeftToIngress(t *testing.T) {
	manager := NewManager()
	agentSession := newReliableIngressSession(t, manager)
	manager.StartChatCommand(conversationTestAgentID, "run-started", "conv-1", "", "client-1", nil)
	dispatchChatControl(manager, agentSession, "run-started", &gatewayv2.ChatControlEvent{
		ConversationId: "conv-1",
		Type:           "started",
	})
	dispatchChatControl(manager, agentSession, "run-started", &gatewayv2.ChatControlEvent{
		ConversationId: "conv-1",
		Type:           "failed",
		ErrorCode:      "desktop_runtime_error",
		Message:        "boom",
	})

	subscription := manager.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer subscription.Cleanup()
	if finished := runFinishedEvents(subscription.Events); len(finished) != 0 {
		t.Fatalf("legacy failure finished a started run: %v", eventTypes(subscription.Events))
	}
}

func TestReliableIngressAgentFailureForIngressRunIsIgnored(t *testing.T) {
	manager := NewManager()
	agentSession := newReliableIngressSession(t, manager)
	manager.StartChatCommand(conversationTestAgentID, "run-ingress", "conv-1", "", "client-1", nil)
	manager.ingestChatIngressBatch(conversationTestAgentID, &gatewayv2.ChatIngressBatch{
		RunId:          "run-ingress",
		ConversationId: "conv-1",
		FirstSeq:       1,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressDelta(`{"type":"token","text":"hello"}`)},
	})
	dispatchChatControl(manager, agentSession, "run-ingress", &gatewayv2.ChatControlEvent{
		ConversationId: "conv-1",
		Type:           "failed",
		ErrorCode:      "desktop_runtime_error",
		Message:        "boom",
	})

	subscription := manager.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer subscription.Cleanup()
	if finished := runFinishedEvents(subscription.Events); len(finished) != 0 {
		t.Fatalf("legacy failure finished an ingress run: %v", eventTypes(subscription.Events))
	}
}
