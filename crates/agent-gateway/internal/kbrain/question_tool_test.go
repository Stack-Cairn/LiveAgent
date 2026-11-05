package kbrain

import (
	"encoding/json"
	"strings"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

const multiQuestionArgs = `{"questions":[{"header":"Stack","question":"Which stack?","options":[{"label":"Go"},{"label":"Rust"}]},{"header":"Extras","question":"Add what?","multiple":true,"options":[{"label":"Docs"},{"label":"Tests"},{"label":"CI"}]}]}`

func TestQuestionToolCallShowsAsMultiQuestionCard(t *testing.T) {
	f := newInteractiveFixture(t)
	f.send("tool.call", `{"tool_call":{"id":"ask-1","name":"question","arguments":`+multiQuestionArgs+`}}`)
	events := f.take()
	if len(events) != 1 || events[0].data["name"] != askUserQuestionTool || events[0].args()[argQuestionPending] != false {
		t.Fatalf("question call = %+v", events)
	}
	questions, _ := events[0].args()["questions"].([]any)
	if len(questions) != 2 {
		t.Fatalf("questions = %+v", events[0].args())
	}
	second, _ := questions[1].(map[string]any)
	if second["id"] != "q2" || second["header"] != "Extras" || second["prompt"] != "Add what?" || second["multiple"] != true {
		t.Fatalf("second question = %+v", second)
	}

	f.send("question.requested", `{"question_id":"question-1","tool_call_id":"ask-1","run_id":"kb-run","questions":[{"id":"q1","header":"Stack","prompt":"Which stack?","options":[{"label":"Go"},{"label":"Rust"}]},{"id":"q2","header":"Extras","prompt":"Add what?","multiple":true,"options":[{"label":"Docs"},{"label":"Tests"},{"label":"CI"}]}]}`)
	f.take()
	answers := `[{"questionId":"q1","prompt":"Which stack?","selectedLabel":"Go"},{"questionId":"q2","prompt":"Add what?","selectedLabel":"Docs, CI","selectedLabels":["Docs","CI"]},{"questionId":"q3","selectedLabel":"Tests","selectedLabels":["Tests"]}]`
	if response := f.queue("tool_answer", "ask-1", answers); !response.Accepted {
		t.Fatalf("answer = %+v", response)
	}
	posts := f.postsTo("/v1/sessions/kb-session/questions/question-1")
	sent, _ := posts[0]["answers"].([]any)
	if len(sent) != 3 {
		t.Fatalf("answers = %+v", posts)
	}
	single, multi, one := sent[0].(map[string]any), sent[1].(map[string]any), sent[2].(map[string]any)
	if single["custom"] != nil || multi["selected_label"] != "Docs, CI" || multi["custom"] != true || one["custom"] != nil {
		t.Fatalf("multi-select answers must go as joined custom labels: %+v", sent)
	}

	f.send("question.resolved", `{"question_id":"question-1","tool_call_id":"ask-1"}`)
	f.take()
	result := "The user answered:\n1. Which stack?\n   → Go\n2. Add what?\n   → Docs, CI"
	raw, _ := json.Marshal(map[string]any{"tool_result": map[string]any{"id": "ask-1", "name": "question", "output": result}})
	f.send("tool.result", string(raw))
	events = f.take()
	if len(events) != 1 || events[0].kind != gatewayv2.ChatEvent_TOOL_RESULT || events[0].data["name"] != askUserQuestionTool {
		t.Fatalf("result = %+v", events)
	}
	details, _ := events[0].data["details"].(map[string]any)
	got, _ := details["answers"].([]any)
	if details["kind"] != "ask_user_question" || len(got) != 2 {
		t.Fatalf("details = %+v", events[0].data["details"])
	}
	if first := got[0].(map[string]any); first["questionId"] != "q1" || first["selectedLabel"] != "Go" || first["custom"] != nil {
		t.Fatalf("first answer = %+v", first)
	}
	if second := got[1].(map[string]any); second["questionId"] != "q2" || second["selectedLabel"] != "Docs, CI" {
		t.Fatalf("second answer = %+v", second)
	}
}

func TestQuestionToolResultText(t *testing.T) {
	args := normalizeQuestionToolArgs(map[string]any{"question": "Proceed?", "options": []any{map[string]any{"label": "Yes"}, map[string]any{"label": "No"}}})
	details := questionToolResultDetails(args, `User answered "Proceed?": Maybe later`, false)
	answers, _ := details["answers"].([]any)
	if len(answers) != 1 || answers[0].(map[string]any)["selectedLabel"] != "Maybe later" || answers[0].(map[string]any)["custom"] != true {
		t.Fatalf("single form = %+v", details)
	}
	var multi map[string]any
	_ = json.Unmarshal([]byte(multiQuestionArgs), &multi)
	timedOut := questionToolResultDetails(multi, "The user answered:\n1. Which stack?\n   → (no answer)\n2. Add what?\n   → (no answer)", false)
	if timedOut["timedOut"] != true {
		t.Fatalf("no answers = %+v", timedOut)
	}
	if cancelled := questionToolResultDetails(multi, "the user dismissed the question", true); cancelled["cancelled"] != true {
		t.Fatalf("dismissed = %+v", cancelled)
	}
	if questionToolResultDetails(multi, "boom", true) != nil || questionToolResultDetails(multi, "unrelated", false) != nil {
		t.Fatal("other results carry no question details")
	}
}

func TestHistoryReplaysQuestionToolAndRunInfo(t *testing.T) {
	exit := 2
	messages := []Message{
		{Role: "assistant", ToolCalls: []ToolCall{
			{ID: "ask-1", Name: "question", Arguments: json.RawMessage(multiQuestionArgs)},
			{ID: "sh-1", Name: "Bash", Arguments: json.RawMessage(`{"command":"false"}`), ExitCode: &exit, DurationMs: 1234},
		}},
		{Role: "tool", ToolCallID: "ask-1", Name: "question", Content: []ContentBlock{{Type: "text", Text: "The user answered:\n1. Which stack?\n   → Rust\n2. Add what?\n   → Tests"}}},
		{Role: "tool", ToolCallID: "sh-1", Name: "Bash", StopReason: "error", Content: []ContentBlock{{Type: "text", Text: "exit status 2"}}},
	}
	raw, err := historyMessagesJSON(messages, 0)
	if err != nil {
		t.Fatal(err)
	}
	var entries []map[string]any
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		t.Fatal(err)
	}
	call := entries[0]["content"].([]any)[0].(map[string]any)
	questions, _ := call["arguments"].(map[string]any)["questions"].([]any)
	if call["name"] != askUserQuestionTool || len(questions) != 2 || questions[0].(map[string]any)["prompt"] != "Which stack?" {
		t.Fatalf("question call = %+v", call)
	}
	if entries[1]["toolName"] != askUserQuestionTool || !strings.Contains(raw, `"selectedLabel":"Rust"`) {
		t.Fatalf("question result = %+v", entries[1])
	}
	run, _ := entries[2]["details"].(map[string]any)[kbrainRunDetailsKey].(map[string]any)
	if run["exitCode"] != float64(2) || run["durationMs"] != float64(1234) || run["timedOut"] != nil {
		t.Fatalf("run info = %+v", entries[2]["details"])
	}
}

func TestShellToolResultCarriesRunInfo(t *testing.T) {
	event, _, err := ToChatEvent(Event{Type: "tool.result", Payload: json.RawMessage(`{"tool_result":{"id":"sh","name":"Bash","output":"killed","failed":true,"timed_out":true,"duration_ms":30000}}`)})
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	_ = json.Unmarshal([]byte(event.GetData()), &payload)
	run, _ := payload["details"].(map[string]any)[kbrainRunDetailsKey].(map[string]any)
	if run["timedOut"] != true || run["durationMs"] != float64(30000) || run["exitCode"] != nil {
		t.Fatalf("run info = %+v", payload)
	}
	event, _, _ = ToChatEvent(Event{Type: "tool.result", Payload: json.RawMessage(`{"tool_result":{"id":"rd","name":"Read","output":"x","duration_ms":12}}`)})
	if strings.Contains(event.GetData(), kbrainRunDetailsKey) {
		t.Fatalf("non-shell tools carry no run info: %s", event.GetData())
	}
}

func TestPermissionPreviewReachesApprovalCard(t *testing.T) {
	f := newInteractiveFixture(t)
	f.send("tool.call", `{"tool_call":{"id":"edit-1","name":"Edit","arguments":{"file_path":"/w/a.go","old_string":"a","new_string":"b"}}}`)
	f.take()
	f.send("permission.requested", `{"permission_id":"perm-1","tool":"Edit","description":"Edit /w/a.go","options":[{"id":"allow_once"},{"id":"reject"}],"tool_call_id":"edit-1","preview":{"path":"/w/a.go","diff":"3 - a\n3 + b","truncated":false}}`)
	args := f.take()[0].args()
	preview, _ := args[argApprovalPreview].(map[string]any)
	if preview["diff"] != "3 - a\n3 + b" || preview["path"] != "/w/a.go" || preview["truncated"] != false || preview["newFile"] != false {
		t.Fatalf("preview = %+v", args)
	}

	f.send("tool.call", `{"tool_call":{"id":"write-1","name":"Write","arguments":{"file_path":"/w/big.bin"}}}`)
	f.take()
	f.send("permission.requested", `{"permission_id":"perm-2","tool":"Write","tool_call_id":"write-1","preview":{"path":"/w/big.bin","new_file":true,"truncated":true}}`)
	preview, _ = f.take()[0].args()[argApprovalPreview].(map[string]any)
	if preview["diff"] != "" || preview["truncated"] != true || preview["newFile"] != true {
		t.Fatalf("too-large preview = %+v", preview)
	}

	diff, cut := clampDiffRows(strings.Repeat("1 + abcdefghij\n", 4000), approvalPreviewMax)
	if !cut || len(diff) > approvalPreviewMax || strings.HasSuffix(diff, "\n") {
		t.Fatalf("diff clamp = %d cut=%v", len(diff), cut)
	}
}
