package chatwire

import (
	"strings"
	"testing"
	"unicode/utf8"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestEventPayloadPreservesHostedSearch(t *testing.T) {
	payload := EventPayload(&gatewayv2.ChatEvent{
		Type:           gatewayv2.ChatEvent_HOSTED_SEARCH,
		ConversationId: "conversation-1",
		Data:           `{"id":"search-1","provider":"codex","status":"completed","queries":["设计模式定义"],"sources":[{"url":"https://example.com/pattern","title":"设计模式"}],"round":2}`,
	}, 7)

	if payload["type"] != "hosted_search" {
		t.Fatalf("expected hosted_search type, got %#v", payload["type"])
	}
	if payload["conversation_id"] != "conversation-1" {
		t.Fatalf("expected conversation id, got %#v", payload["conversation_id"])
	}
	if payload["id"] != "search-1" {
		t.Fatalf("expected search id, got %#v", payload["id"])
	}
	if payload["provider"] != "codex" {
		t.Fatalf("expected provider, got %#v", payload["provider"])
	}
	if payload["status"] != "completed" {
		t.Fatalf("expected status, got %#v", payload["status"])
	}
	if payload["seq"] != int64(7) {
		t.Fatalf("expected seq 7, got %#v", payload["seq"])
	}
}

func TestEventPayloadPreservesToolCallDeltaType(t *testing.T) {
	payload := EventPayload(&gatewayv2.ChatEvent{
		Type:           gatewayv2.ChatEvent_TOOL_CALL,
		ConversationId: "conversation-1",
		Data:           `{"type":"tool_call_delta","id":"call-write","name":"Write","arguments":{"path":"src/app.ts","content":"con"},"round":1}`,
	}, 8)

	if payload["type"] != "tool_call_delta" {
		t.Fatalf("expected tool_call_delta type, got %#v", payload["type"])
	}
	if payload["conversation_id"] != "conversation-1" {
		t.Fatalf("expected conversation id, got %#v", payload["conversation_id"])
	}
	if payload["id"] != "call-write" {
		t.Fatalf("expected tool call id, got %#v", payload["id"])
	}
	if payload["name"] != "Write" {
		t.Fatalf("expected tool name, got %#v", payload["name"])
	}
	if payload["seq"] != int64(8) {
		t.Fatalf("expected seq 8, got %#v", payload["seq"])
	}
}

// Tool-call arguments must pass through untouched: the desktop app already
// truncated them and stamped the preview meta; the gateway rewriting either
// caused the chars regression this suite guards against.
func TestEventPayloadLeavesToolCallArgsUntouched(t *testing.T) {
	longContent := strings.Repeat("x", 500)
	payload := EventPayload(&gatewayv2.ChatEvent{
		Type:           gatewayv2.ChatEvent_TOOL_CALL,
		ConversationId: "conversation-1",
		Data: `{"type":"tool_call_delta","id":"call-write","name":"Write","arguments":{"path":"src/app.ts","content":"` +
			longContent +
			`","__liveagent_stream_preview":{"v":2,"progress":6000,"fields":{"content":{"chars":6000,"lines":12,"truncated":true}}}},"round":1}`,
	}, 9)

	args, ok := payload["arguments"].(map[string]any)
	if !ok {
		t.Fatalf("expected arguments map, got %#v", payload["arguments"])
	}
	if content := args["content"].(string); content != longContent {
		t.Fatalf("content modified: len=%d, want %d", len(content), len(longContent))
	}
	meta, ok := args["__liveagent_stream_preview"].(map[string]any)
	if !ok {
		t.Fatalf("expected producer preview meta preserved, got %#v", args)
	}
	fields := meta["fields"].(map[string]any)
	info := fields["content"].(map[string]any)
	if chars, _ := info["chars"].(float64); chars != 6000 {
		t.Fatalf("producer chars overwritten: %#v", info)
	}
	if progress, _ := meta["progress"].(float64); progress != 6000 {
		t.Fatalf("producer progress overwritten: %#v", meta)
	}
}

func TestTrimLargeToolResultContentTruncatesToolResult(t *testing.T) {
	longText := strings.Repeat("r", 300)
	payload := map[string]any{
		"type":    "tool_result",
		"content": longText,
	}

	TrimLargeToolResultContent(payload, "tool_result")

	if content := payload["content"].(string); len(content) != 200 {
		t.Fatalf("trimmed result length = %d, want 200", len(content))
	}
	meta, ok := payload["__liveagent_stream_preview"].(map[string]any)
	if !ok {
		t.Fatalf("expected preview meta on tool_result payload")
	}
	fields := meta["fields"].(map[string]any)
	info := fields["content"].(map[string]any)
	if info["chars"] != 300 || info["truncated"] != true {
		t.Fatalf("preview meta = %#v", info)
	}
}

func TestTrimLargeToolResultContentIsRuneSafe(t *testing.T) {
	longText := strings.Repeat("汉", 100) // 300 bytes, 100 runes
	payload := map[string]any{
		"type":    "tool_result",
		"content": longText,
	}

	TrimLargeToolResultContent(payload, "tool_result")

	content := payload["content"].(string)
	if !utf8.ValidString(content) {
		t.Fatalf("truncated content is not valid UTF-8")
	}
	if len(content) > 200 {
		t.Fatalf("trimmed result length = %d, want <= 200", len(content))
	}
	meta := payload["__liveagent_stream_preview"].(map[string]any)
	fields := meta["fields"].(map[string]any)
	info := fields["content"].(map[string]any)
	if info["chars"] != 100 {
		t.Fatalf("chars should count runes, got %#v", info["chars"])
	}
}
