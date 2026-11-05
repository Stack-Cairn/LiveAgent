package kbrain

import (
	"encoding/json"
	v2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"strings"
	"testing"
)

func TestAIReviewEventProjectsRiskStatus(t *testing.T) {
	event, _, err := ToChatEvent(Event{Type: "approval.reviewed", Payload: json.RawMessage(`{"phase":"action","tool":"Bash","report":{"risk":"high","reason":"Credential upload"}}`)})
	if err != nil || event == nil || event.Type != v2.ChatEvent_TOOL_STATUS || !strings.Contains(event.Data, "Credential upload") {
		t.Fatalf("event=%+v err=%v", event, err)
	}
}
