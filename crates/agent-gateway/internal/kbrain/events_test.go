package kbrain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestCanonicalEventsMapToGatewayVocabulary(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{"text": "hello"})
	event, control, err := ToChatEvent(Event{ConversationID: "c1", RunID: "r1", Type: "assistant.text.delta", Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	if control != nil || event == nil || event.Type != gatewayv2.ChatEvent_TOKEN || event.ConversationId != "c1" {
		t.Fatalf("event=%+v control=%+v", event, control)
	}

	_, control, err = ToChatEvent(Event{ConversationID: "c1", RunID: "r1", Type: "run.completed"})
	if err != nil {
		t.Fatal(err)
	}
	if control == nil || control.Type != "completed" || control.RequestId != "r1" {
		t.Fatalf("control=%+v", control)
	}
}

func TestRunProgressMapsToSharedStatus(t *testing.T) {
	event, control, err := ToChatEvent(Event{ConversationID: "c1", Type: "run.progress", Payload: json.RawMessage(`{"stage":"waiting_model","elapsed_ms":12}`)})
	if err != nil || control != nil || event == nil || event.Type != gatewayv2.ChatEvent_TOOL_STATUS {
		t.Fatalf("event=%+v control=%+v err=%v", event, control, err)
	}
	var data map[string]string
	if err := json.Unmarshal([]byte(event.Data), &data); err != nil {
		t.Fatal(err)
	}
	if data["status"] != `kbrain-progress:{"elapsed_ms":12,"stage":"waiting_model"}` {
		t.Fatalf("unexpected status: %s", event.Data)
	}
}

func TestModelRetryMapsToRetryingStatus(t *testing.T) {
	before := time.Now().UnixMilli()
	event, control, err := ToChatEvent(Event{ConversationID: "c1", RunID: "r1", Type: "trajectory.retry", Payload: json.RawMessage(`{"request_id":"q1","task_id":"","provider":"fake","attempt":1,"max":3,"delay_ms":4000,"error":"429 Too Many Requests"}`)})
	if err != nil || control != nil || event == nil || event.Type != gatewayv2.ChatEvent_TOOL_STATUS {
		t.Fatalf("event=%+v control=%+v err=%v", event, control, err)
	}
	var data map[string]string
	if err := json.Unmarshal([]byte(event.Data), &data); err != nil {
		t.Fatal(err)
	}
	status, ok := strings.CutPrefix(data["status"], "kbrain-progress:")
	if !ok {
		t.Fatalf("unexpected status: %s", event.Data)
	}
	var progress struct {
		Stage   string `json:"stage"`
		Attempt int    `json:"retry_attempt"`
		Max     int    `json:"retry_max"`
		At      int64  `json:"retry_at_ms"`
	}
	if err := json.Unmarshal([]byte(status), &progress); err != nil {
		t.Fatal(err)
	}
	// Three attempts allow two retries; the first failed attempt starts retry 1 of 2.
	if progress.Stage != "retrying" || progress.Attempt != 1 || progress.Max != 2 || progress.At < before+4000 || progress.At > time.Now().UnixMilli()+4000 {
		t.Fatalf("unexpected progress: %s", status)
	}

	// retries_remaining is exact when the backend sends it: the second of five
	// attempts with one retry left counts to 2, not to max-1.
	event, _, err = ToChatEvent(Event{ConversationID: "c1", RunID: "r1", Type: "trajectory.retry", Payload: json.RawMessage(`{"attempt":2,"max":5,"retries_remaining":1,"delay_ms":10}`)})
	if err != nil || event == nil || !strings.Contains(event.Data, `\"retry_max\":2`) {
		t.Fatalf("retries_remaining: event=%+v err=%v", event, err)
	}

	// A background task's retries are not the turn's.
	event, control, err = ToChatEvent(Event{ConversationID: "c1", RunID: "r1", Type: "trajectory.retry", Payload: json.RawMessage(`{"task_id":"t1","attempt":1,"max":3,"delay_ms":10}`)})
	if err != nil || event != nil || control != nil {
		t.Fatalf("task retry: event=%+v control=%+v err=%v", event, control, err)
	}
}

func TestUsageReportsMapToLiveAgentUsage(t *testing.T) {
	event, control, err := ToChatEvent(Event{ConversationID: "c1", RunID: "r1", Type: "usage.updated", Payload: json.RawMessage(`{"input_tokens":1200,"output_tokens":80,"cached_tokens":1000,"cache_write_tokens":50}`)})
	if err != nil || control != nil || event == nil || event.Type != gatewayv2.ChatEvent_TOKEN {
		t.Fatalf("event=%+v control=%+v err=%v", event, control, err)
	}
	var data struct {
		Text      *string          `json:"text"`
		UsageLive bool             `json:"usageLive"`
		Usage     map[string]int64 `json:"usage"`
	}
	if err := json.Unmarshal([]byte(event.Data), &data); err != nil {
		t.Fatal(err)
	}
	want := map[string]int64{"input": 150, "output": 80, "cacheRead": 1000, "cacheWrite": 50, "totalTokens": 1280}
	if data.Text == nil || *data.Text != "" || !data.UsageLive || len(data.Usage) != len(want) {
		t.Fatalf("unexpected usage event: %s", event.Data)
	}
	for key, value := range want {
		if data.Usage[key] != value {
			t.Fatalf("usage[%s] = %d, want %d (%s)", key, data.Usage[key], value, event.Data)
		}
	}

	// The final message's usage uses the same fields, so it cannot zero the live report.
	event, _, err = ToChatEvent(Event{ConversationID: "c1", RunID: "r1", Type: "assistant.message.created", Payload: json.RawMessage(`{"id":"m1","usage":{"input_tokens":300,"output_tokens":20,"cached_tokens":100}}`)})
	if err != nil || event == nil {
		t.Fatalf("event=%+v err=%v", event, err)
	}
	var created struct {
		Usage map[string]int64 `json:"usage"`
	}
	if err := json.Unmarshal([]byte(event.Data), &created); err != nil {
		t.Fatal(err)
	}
	if created.Usage["input"] != 200 || created.Usage["cacheRead"] != 100 || created.Usage["totalTokens"] != 320 {
		t.Fatalf("unexpected message usage: %s", event.Data)
	}
}
