package server

import (
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// 公开分享页 JSON 合同：protojson 会把 int64 编成字符串、int32 编成 float64，
// coerce 链必须矫正为原生数值（前端时间戳/计数渲染依赖）。
func TestProtoJSONPayloadPreservesFrontendNumberTypes(t *testing.T) {
	payload := conversationSummaryPayload(&gatewayv2.ConversationSummary{
		Id:           "conversation-1",
		CreatedAt:    42,
		UpdatedAt:    84,
		MessageCount: 3,
	})

	if got := payload["created_at"]; got != int64(42) {
		t.Fatalf("created_at = %#v (%T), want int64(42)", got, got)
	}
	if got := payload["updated_at"]; got != int64(84) {
		t.Fatalf("updated_at = %#v (%T), want int64(84)", got, got)
	}
	if got := payload["message_count"]; got != int32(3) {
		t.Fatalf("message_count = %#v (%T), want int32(3)", got, got)
	}
	if got := payload["id"]; got != "conversation-1" {
		t.Fatalf("id = %#v, want conversation-1", got)
	}
}

func TestProtoJSONPayloadPreservesNilPayloads(t *testing.T) {
	if payload := conversationSummaryPayload(nil); payload != nil {
		t.Fatalf("conversation nil payload = %#v, want nil", payload)
	}
	if payload := protoJSONPayload(nil, true); payload != nil {
		t.Fatalf("nil message payload = %#v, want nil", payload)
	}
}
