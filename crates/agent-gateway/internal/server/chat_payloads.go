package server

import (
	"encoding/json"
	"strings"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func isTerminalChatControlPayload(control *gatewayv1.ChatControlEvent) bool {
	switch strings.TrimSpace(control.GetState()) {
	case "completed", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func chatControlPayload(
	control *gatewayv1.ChatControlEvent,
	seq int64,
	workdirInput ...string,
) map[string]any {
	payload := map[string]any{
		"type":              strings.TrimSpace(control.GetType()),
		"client_request_id": strings.TrimSpace(control.GetClientRequestId()),
		"conversation_id":   strings.TrimSpace(control.GetConversationId()),
		"run_epoch":         control.GetRunEpoch(),
		"state":             strings.TrimSpace(control.GetState()),
	}
	if seq > 0 {
		payload["seq"] = seq
	} else if control.GetSeq() > 0 {
		payload["seq"] = control.GetSeq()
	}
	if errorCode := strings.TrimSpace(control.GetErrorCode()); errorCode != "" {
		payload["error_code"] = errorCode
	}
	if message := strings.TrimSpace(control.GetMessage()); message != "" {
		payload["message"] = message
	}
	if len(workdirInput) > 0 {
		if workdir := strings.TrimSpace(workdirInput[0]); workdir != "" {
			payload["workdir"] = workdir
		}
	}
	return payload
}

func chatEventPayload(event *gatewayv1.ChatEvent, seq int64, workdirInput ...string) map[string]any {
	payload := map[string]any{
		"type": chatEventType(event.GetType()),
	}
	if seq > 0 {
		payload["seq"] = seq
	}
	if len(workdirInput) > 0 {
		if workdir := strings.TrimSpace(workdirInput[0]); workdir != "" {
			payload["workdir"] = workdir
		}
	}

	raw := strings.TrimSpace(event.GetData())
	if raw == "" {
		raw = "{}"
	}

	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err == nil {
		for key, value := range decoded {
			payload[key] = value
		}
	}

	if conversationID := strings.TrimSpace(event.GetConversationId()); conversationID != "" {
		payload["conversation_id"] = conversationID
	}

	return payload
}

func chatEventType(eventType gatewayv1.ChatEvent_ChatEventType) string {
	switch eventType {
	case gatewayv1.ChatEvent_TOKEN:
		return "token"
	case gatewayv1.ChatEvent_THINKING:
		return "thinking"
	case gatewayv1.ChatEvent_TOOL_CALL:
		return "tool_call"
	case gatewayv1.ChatEvent_TOOL_RESULT:
		return "tool_result"
	case gatewayv1.ChatEvent_DONE:
		return "done"
	case gatewayv1.ChatEvent_ERROR:
		return "error"
	case gatewayv1.ChatEvent_TOOL_STATUS:
		return "tool_status"
	case gatewayv1.ChatEvent_HOSTED_SEARCH:
		return "hosted_search"
	default:
		return "message"
	}
}
