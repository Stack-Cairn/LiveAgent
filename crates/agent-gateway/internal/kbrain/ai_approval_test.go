package kbrain

import (
	"encoding/json"
	v2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAIReviewEventProjectsRiskStatus(t *testing.T) {
	event, _, err := ToChatEvent(Event{Type: "approval.reviewed", Payload: json.RawMessage(`{"phase":"action","tool":"Bash","report":{"risk":"high","reason":"Credential upload"}}`)})
	if err != nil || event == nil || event.Type != v2.ChatEvent_TOOL_STATUS || !strings.Contains(event.Data, "Credential upload") {
		t.Fatalf("event=%+v err=%v", event, err)
	}
}

func TestRemoteManualApprovalFailsClosed(t *testing.T) {
	var decision string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sessions/session/permissions/permission" || r.Method != http.MethodPost {
			t.Errorf("wrong request %s %s", r.Method, r.URL.Path)
		}
		var input struct {
			ConversationID string            `json:"conversation_id"`
			RunID          string            `json:"run_id"`
			Decision       map[string]string `json:"decision"`
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input.ConversationID != "session" || input.RunID != "run" {
			t.Error("identity lost")
		}
		decision = input.Decision["decision"]
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()
	client := &Client{BaseURL: server.URL, HTTP: server.Client()}
	err := client.rejectUnsupportedPermission(t.Context(), Event{ConversationID: "session", RunID: "run", Type: "permission.requested", Payload: json.RawMessage(`{"permission_id":"permission"}`)})
	if err != nil || decision != "reject" {
		t.Fatalf("decision=%s err=%v", decision, err)
	}
}
