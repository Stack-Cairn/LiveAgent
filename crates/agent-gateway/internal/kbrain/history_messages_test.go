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

// K-brain 0.107.17 and earlier saved these notices without origin (#1211).
func TestHistoryMessagesJSONMarksLegacyBackgroundNotices(t *testing.T) {
	cases := []struct {
		text string
		want bool
	}{
		{"[process bash-1793875844913105000 completed exit_code=0]\n$ sleep 5; echo READY\n\nLast output:\nREADY", true},
		{"[process mp-1793875844913105001 timed_out] build\n$ sleep 30", true},
		{"[subagent count-files-3 done] count files\n\n42 files", true},
		{"[subagent sub-4 cancelled] 统计文件\n\ncontext canceled", true},
		{"[subagent count-files-5] prepare subagent workspace: not a git repository", true},
		{"[wait wait-cat-build-log-6 done] condition met (ran every 2s):\n$ cat build.log", true},
		{"[wait wait-cat-build-log-7 timeout] deadline elapsed without the condition being met:\n$ cat build.log", true},
		{"[wait wait-cat-build-log-8] gave up: command failed 5 consecutive times", true},
		{"[workflow run-19a5c2d3e4f-1-ab12 complete] review\n\n{}", true},
		{"[process bash-1 completed] what does this mean?", false},
		{"[subagent] why did it stop?", false},
		{"[wait] how long is left?", false},
		{"please check [process bash-1 completed exit_code=0]\n$ ls", false},
	}
	messages := make([]Message, 0, len(cases))
	for _, c := range cases {
		messages = append(messages, Message{Role: "user", Content: []ContentBlock{{Type: "text", Text: c.text}}})
	}
	raw, err := historyMessagesJSON(messages, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		if got := out[i]["liveAgentBackgroundNotice"] == true; got != c.want {
			t.Errorf("%q background notice = %v, want %v", c.text, got, c.want)
		}
	}
}
