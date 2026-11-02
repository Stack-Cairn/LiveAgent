package session

import (
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestComposerRejectionDoesNotSeedHistory(t *testing.T) {
	for _, control := range []bool{false, true} {
		for _, running := range []bool{false, true} {
			m := NewManager()
			if running {
				m.IngestRemoteChatControl(conversationTestAgentID, "existing", &gatewayv2.ChatControlEvent{Type: "started", ConversationId: "c"})
			}
			before := m.SubscribeConversationStream(conversationTestAgentID, "c", 0, "")
			count := len(before.Events)
			before.Cleanup()
			m.StartChatCommand(conversationTestAgentID, "command", "c", "", "req", []map[string]any{{"type": "user_message", "message": "/goal task"}}, true)
			if control {
				m.IngestRemoteChatControl(conversationTestAgentID, "command", &gatewayv2.ChatControlEvent{Type: "failed", ConversationId: "c", ErrorCode: "conversation_busy", Message: "busy"})
			} else {
				m.FailChatCommand(conversationTestAgentID, "command", "conversation_busy", "busy")
			}
			after := m.SubscribeConversationStream(conversationTestAgentID, "c", 0, "")
			if len(after.Events) != count {
				t.Fatalf("rejection polluted history: %+v", after.Events)
			}
			if running && (after.Activity == nil || after.Activity.RunID != "existing") {
				t.Fatalf("changed active run: %+v", after.Activity)
			}
			after.Cleanup()
			updates, cleanup := m.WatchChatCommand(conversationTestAgentID, "command")
			select {
			case update := <-updates:
				if update.Phase != "failed" || update.ErrorCode != "conversation_busy" {
					t.Fatalf("update = %+v", update)
				}
			default:
				t.Fatal("missing replayable rejection")
			}
			cleanup()
		}
	}
}

func TestComposerStartFlushesSeedsOnce(t *testing.T) {
	m := NewManager()
	m.StartChatCommand(conversationTestAgentID, "r", "c", "", "req", []map[string]any{{"type": "user_message", "message": "/plan task"}}, true)
	for i := 0; i < 2; i++ {
		m.IngestRemoteChatControl(conversationTestAgentID, "r", &gatewayv2.ChatControlEvent{Type: "started", ConversationId: "c"})
	}
	sub := m.SubscribeConversationStream(conversationTestAgentID, "c", 0, "")
	defer sub.Cleanup()
	if len(sub.Events) != 2 || sub.Events[0].Type != "user_message" || sub.Events[1].Type != StreamEventRunStarted {
		t.Fatalf("events = %+v", sub.Events)
	}
}

func TestDraftComposerRejectionDoesNotSeedHistory(t *testing.T) {
	m := NewManager()
	m.StartChatCommand(conversationTestAgentID, "r", "", "", "req", []map[string]any{{"type": "user_message", "message": "/goal task"}}, true)
	m.IngestRemoteChatControl(conversationTestAgentID, "r", &gatewayv2.ChatControlEvent{Type: "claimed", ConversationId: "bound"})
	m.IngestRemoteChatControl(conversationTestAgentID, "r", &gatewayv2.ChatControlEvent{Type: "failed", ConversationId: "bound", ErrorCode: "conversation_busy"})
	sub := m.SubscribeConversationStream(conversationTestAgentID, "bound", 0, "")
	defer sub.Cleanup()
	if len(sub.Events) != 0 || sub.Activity != nil {
		t.Fatalf("rejected draft polluted stream: %+v", sub)
	}
}

func TestStartedComposerFailurePreservesHistory(t *testing.T) {
	m := NewManager()
	m.StartChatCommand(conversationTestAgentID, "r", "c", "", "req", []map[string]any{{"type": "user_message", "message": "/plan task"}}, true)
	m.IngestRemoteChatEvent(conversationTestAgentID, "r", &gatewayv2.ChatEvent{Type: gatewayv2.ChatEvent_USER_MESSAGE, ConversationId: "c"})
	m.IngestRemoteChatControl(conversationTestAgentID, "r", &gatewayv2.ChatControlEvent{Type: "failed", ConversationId: "c", ErrorCode: "model_error"})
	sub := m.SubscribeConversationStream(conversationTestAgentID, "c", 0, "")
	defer sub.Cleanup()
	if len(sub.Events) != 3 || sub.Events[0].Type != "user_message" || sub.Events[2].Type != StreamEventRunFinished {
		t.Fatalf("started command history = %+v", sub.Events)
	}
}
