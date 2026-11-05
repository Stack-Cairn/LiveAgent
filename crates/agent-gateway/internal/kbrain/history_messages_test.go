package kbrain

import (
	"encoding/json"
	"testing"
)

func TestHistoryMessagesJSONCarriesCanonicalOffsets(t *testing.T) {
	messages := []Message{
		{ID: "m100", Role: "user", Content: []ContentBlock{{Type: "text", Text: "q"}}},
		{ID: "sys", Role: "system"},
		{ID: "m102", Role: "assistant", Content: []ContentBlock{{Type: "text", Text: "a"}}},
	}
	raw, err := historyMessagesJSON(messages, 100)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 {
		t.Fatalf("expected system message to be skipped, got %d entries", len(out))
	}
	for i, want := range []float64{100, 102} {
		if got := out[i]["messageIndex"]; got != want {
			t.Fatalf("entry %d messageIndex = %v, want %v", i, got, want)
		}
	}
}

func TestHistoryMessagesJSONMarksBackgroundNotices(t *testing.T) {
	messages := []Message{
		{ID: "u1", Role: "user", Content: []ContentBlock{{Type: "text", Text: "run the build"}}},
		{ID: "u2", Role: "user", Origin: OriginBackground, Content: []ContentBlock{{Type: "text", Text: "[wait w1 done] condition met"}}},
		{ID: "a1", Role: "assistant", Origin: OriginBackground, Content: []ContentBlock{{Type: "text", Text: "ok"}}},
	}
	raw, err := historyMessagesJSON(messages, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatal(err)
	}
	for i, want := range []bool{false, true, false} {
		if got := out[i]["liveAgentBackgroundNotice"] == true; got != want {
			t.Fatalf("entry %d background notice = %v, want %v (%v)", i, got, want, out[i])
		}
	}
}
