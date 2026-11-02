package kbrain

import (
	"encoding/json"
	"testing"
)

func TestComputerScreenshotEventProjection(t *testing.T) {
	event, _, err := ToChatEvent(Event{Type: "tool.result", Payload: json.RawMessage(`{"tool_result":{"id":"cua","name":"computer_exec","output":"observed","content":[{"type":"image","image_url":"data:image/png;base64,aW1n","mime_type":"image/png"}]}}`)})
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(event.Data), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["id"] != "cua" || payload["isError"] != false {
		t.Fatalf("payload: %v", payload)
	}
	content := payload["content"].([]any)
	image := content[1].(map[string]any)
	if image["data"] != "data:image/png;base64,aW1n" || image["mimeType"] != "image/png" {
		t.Fatalf("image: %v", image)
	}
}
