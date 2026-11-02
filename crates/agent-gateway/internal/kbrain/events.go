package kbrain

import (
	"encoding/json"
	"fmt"
	"strings"

	v2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// ToChatEvent translates one canonical K-brain event into the legacy Gateway
// event vocabulary. Provider-specific response/chat-message fields never cross
// this boundary.
func ToChatEvent(event Event) (*v2.ChatEvent, *v2.ChatControlEvent, error) {
	payload := map[string]any{}
	if len(event.Payload) != 0 && string(event.Payload) != "null" {
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			return nil, nil, fmt.Errorf("decode kbrain event payload: %w", err)
		}
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, err
	}
	base := &v2.ChatEvent{ConversationId: event.ConversationID, Data: string(data)}
	switch strings.TrimSpace(event.Type) {
	case "run.accepted":
		return nil, &v2.ChatControlEvent{RequestId: event.RunID, ConversationId: event.ConversationID, Type: "started"}, nil
	case "user.message.appended":
		base.Type = v2.ChatEvent_USER_MESSAGE
	case "assistant.text.delta":
		base.Type = v2.ChatEvent_TOKEN
	case "assistant.message.created":
		base.Type = v2.ChatEvent_TOKEN
	case "assistant.thinking.delta":
		base.Type = v2.ChatEvent_THINKING
	case "assistant.sources":
		base.Type = v2.ChatEvent_HOSTED_SEARCH
	case "tool.call":
		base.Type = v2.ChatEvent_TOOL_CALL
		if call, ok := payload["tool_call"].(map[string]any); ok {
			for key, value := range call {
				payload[key] = value
			}
		}
	case "tool.result":
		base.Type = v2.ChatEvent_TOOL_RESULT
		if result, ok := payload["tool_result"].(map[string]any); ok {
			payload["id"], payload["name"] = result["id"], result["name"]
			payload["isError"] = result["failed"] == true || result["cancelled"] == true
			content := []any{map[string]any{"type": "text", "text": result["output"]}}
			if blocks, ok := result["content"].([]any); ok {
				for _, value := range blocks {
					block, ok := value.(map[string]any)
					if !ok {
						continue
					}
					if block["type"] == "image" {
						mime, _ := block["mime_type"].(string)
						if mime == "" {
							mime = "image/png"
						}
						content = append(content, map[string]any{"type": "image", "data": block["image_url"], "mimeType": mime})
					}
				}
			}
			payload["content"] = content
		}
	case "permission.requested":
		base.Type = v2.ChatEvent_TOOL_STATUS
		payload["status"] = "Manual approval required. This WebUI transport cannot confirm permissions; the action was rejected. Retry in LiveAgent desktop or K-brain TUI."
	case "approval.reviewed":
		base.Type = v2.ChatEvent_TOOL_STATUS
		if object, ok := payloadAsMap(payload); ok {
			if report, ok := object["report"].(map[string]any); ok {
				object["status"] = fmt.Sprintf("AI review [%v]: %v", report["risk"], report["reason"])
			}
		}
	case "tool.status":
		base.Type = v2.ChatEvent_TOOL_STATUS
	case "run.progress":
		base.Type = v2.ChatEvent_TOOL_STATUS
		payload = map[string]any{"status": "kbrain-progress:" + string(data)}
	case "run.completed":
		return nil, &v2.ChatControlEvent{RequestId: event.RunID, ConversationId: event.ConversationID, Type: "completed"}, nil
	case "run.failed":
		message := ""
		if terminal, ok := payloadAsMap(payload); ok {
			message, _ = terminal["error"].(string)
		}
		return nil, &v2.ChatControlEvent{RequestId: event.RunID, ConversationId: event.ConversationID, Type: "failed", Message: message}, nil
	case "run.cancelled":
		return nil, &v2.ChatControlEvent{RequestId: event.RunID, ConversationId: event.ConversationID, Type: "cancelled"}, nil
	default:
		return nil, nil, nil
	}
	data, err = json.Marshal(payload)
	if err != nil {
		return nil, nil, err
	}
	base.Data = string(data)
	return base, nil, nil
}

func payloadAsMap(payload map[string]any) (map[string]any, bool) { return payload, payload != nil }
