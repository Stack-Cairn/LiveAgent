// Package chatwire shapes agent chat protobuf events into the JSON payloads
// sent to webui clients. Shaping (decode, normalize, result trimming) happens
// exactly once at ingress so every subscriber observes identical bytes.
//
// Tool-call arguments pass through untouched: the desktop app is the single
// producer of streaming previews (truncated text + __liveagent_stream_preview
// metadata) and the gateway must never recompute or overwrite them.
package chatwire

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// EventPayload shapes a ChatEvent into a wire payload, decoding the JSON data
// blob and trimming oversized tool-result content.
func EventPayload(event *gatewayv2.ChatEvent, seq int64, workdirInput ...string) map[string]any {
	protoType := EventTypeName(event.GetType())
	payload := map[string]any{
		"type": protoType,
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

	TrimLargeToolResultContent(payload, protoType)

	return payload
}

const toolResultMaxBytes = 200

// TrimLargeToolResultContent truncates oversized tool-result content in place,
// attaching a __liveagent_stream_preview meta block describing the original
// size. Tool-call arguments are never touched.
func TrimLargeToolResultContent(payload map[string]any, protoType string) {
	eventType, _ := payload["type"].(string)
	if eventType != "tool_result" && protoType != "tool_result" {
		return
	}
	switch content := payload["content"].(type) {
	case string:
		if len(content) > toolResultMaxBytes {
			payload["content"] = truncateRuneSafe(content, toolResultMaxBytes)
			setPreviewMeta(payload, "content", content)
		}
	case []any:
		for _, item := range content {
			block, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := block["text"].(string); ok && len(text) > toolResultMaxBytes {
				block["text"] = truncateRuneSafe(text, toolResultMaxBytes)
				setPreviewMeta(block, "text", text)
			}
		}
	}
}

// truncateRuneSafe cuts s to at most maxBytes without splitting a UTF-8 rune.
func truncateRuneSafe(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func setPreviewMeta(container map[string]any, fieldName string, original string) {
	const metaKey = "__liveagent_stream_preview"
	meta, _ := container[metaKey].(map[string]any)
	if meta == nil {
		meta = map[string]any{}
		container[metaKey] = meta
	}
	fields, _ := meta["fields"].(map[string]any)
	if fields == nil {
		fields = map[string]any{}
		meta["fields"] = fields
	}
	fields[fieldName] = map[string]any{
		"chars":     utf8.RuneCountInString(original),
		"lines":     countLines(original),
		"truncated": true,
	}
}

func countLines(s string) int {
	if len(s) == 0 {
		return 0
	}
	n := 1
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\n':
			n++
		case '\r':
			n++
			if i+1 < len(s) && s[i+1] == '\n' {
				i++
			}
		}
	}
	return n
}

// EventTypeName maps the protobuf ChatEvent type enum to its wire name.
func EventTypeName(eventType gatewayv2.ChatEvent_ChatEventType) string {
	switch eventType {
	case gatewayv2.ChatEvent_TOKEN:
		return "token"
	case gatewayv2.ChatEvent_THINKING:
		return "thinking"
	case gatewayv2.ChatEvent_TOOL_CALL:
		return "tool_call"
	case gatewayv2.ChatEvent_TOOL_RESULT:
		return "tool_result"
	case gatewayv2.ChatEvent_DONE:
		return "done"
	case gatewayv2.ChatEvent_ERROR:
		return "error"
	case gatewayv2.ChatEvent_TOOL_STATUS:
		return "tool_status"
	case gatewayv2.ChatEvent_HOSTED_SEARCH:
		return "hosted_search"
	case gatewayv2.ChatEvent_USER_MESSAGE:
		return "user_message"
	default:
		return "message"
	}
}
