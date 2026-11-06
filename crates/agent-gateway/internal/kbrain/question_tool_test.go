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
	details := questionToolResultDetails(args, `User answered "Proceed?": Maybe later`, false, nil)
	answers, _ := details["answers"].([]any)
	if len(answers) != 1 || answers[0].(map[string]any)["selectedLabel"] != "Maybe later" || answers[0].(map[string]any)["custom"] != true {
		t.Fatalf("single form = %+v", details)
	}
	var multi map[string]any
	_ = json.Unmarshal([]byte(multiQuestionArgs), &multi)
	timedOut := questionToolResultDetails(multi, "The user answered:\n1. Which stack?\n   → (no answer)\n2. Add what?\n   → (no answer)", false, nil)
	if timedOut["timedOut"] != true {
		t.Fatalf("no answers = %+v", timedOut)
	}
	if cancelled := questionToolResultDetails(multi, "the user dismissed the question", true, nil); cancelled["cancelled"] != true {
		t.Fatalf("dismissed = %+v", cancelled)
	}
	if questionToolResultDetails(multi, "boom", true, nil) != nil || questionToolResultDetails(multi, "unrelated", false, nil) != nil {
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

// Stack-Cairn/K-brain#168: structured multi-select answers (selected_labels) and the
// question_answers K-brain records on the call.
const (
	selectedLabelsHealth = `{"status":"ok","version":"kbrain.agent.v1","capabilities":{"question_selected_labels":1}}`
	olderHealth          = `{"status":"ok","version":"kbrain.agent.v1","capabilities":{}}`
	commaQuestionArgs    = `{"questions":[{"header":"Stack","question":"Which stack?","options":[{"label":"Go"},{"label":"Rust"}]},{"header":"Extras","question":"Add what?","multiple":true,"options":[{"label":"Docs"},{"label":"Search, filter"},{"label":"CI"}]}]}`
	commaQuestionRequest = `{"question_id":"question-1","tool_call_id":"ask-1","run_id":"kb-run","questions":[{"id":"q1","header":"Stack","prompt":"Which stack?","options":[{"label":"Go"},{"label":"Rust"}]},{"id":"q2","header":"Extras","prompt":"Add what?","multiple":true,"options":[{"label":"Docs"},{"label":"Search, filter"},{"label":"CI"}]}]}`
)

func TestQuestionAnswersSendSelectedLabelsOnlyWithCapability(t *testing.T) {
	for name, tc := range map[string]struct {
		health string
		labels string
		custom string
	}{
		"capability":     {selectedLabelsHealth, `[{"question_id":"q1","selected_label":"Go"},{"question_id":"q2","selected_labels":["Search, filter","CI"]}]`, `[{"question_id":"q1","selected_label":"Go"},{"question_id":"q2","selected_labels":["Docs"],"selected_label":"a badge","custom":true}]`},
		"older backend":  {olderHealth, `[{"question_id":"q1","selected_label":"Go"},{"question_id":"q2","selected_label":"Search, filter, CI","custom":true}]`, `[{"question_id":"q1","selected_label":"Go"},{"question_id":"q2","selected_label":"Docs, a badge","custom":true}]`},
		"health missing": {"", `[{"question_id":"q1","selected_label":"Go"},{"question_id":"q2","selected_label":"Search, filter, CI","custom":true}]`, `[{"question_id":"q1","selected_label":"Go"},{"question_id":"q2","selected_label":"Docs, a badge","custom":true}]`},
	} {
		t.Run(name, func(t *testing.T) {
			for i, answer := range []struct{ card, want string }{
				{`[{"questionId":"q1","selectedLabel":"Go"},{"questionId":"q2","selectedLabel":"Search, filter, CI","selectedLabels":["Search, filter","CI"]}]`, tc.labels},
				{`[{"questionId":"q1","selectedLabel":"Go"},{"questionId":"q2","selectedLabel":"Docs, a badge","selectedLabels":["Docs"],"customText":"a badge","custom":true}]`, tc.custom},
			} {
				f := newInteractiveFixture(t)
				f.health = tc.health
				f.send("tool.call", `{"tool_call":{"id":"ask-1","name":"question","arguments":`+commaQuestionArgs+`}}`)
				f.send("question.requested", commaQuestionRequest)
				f.take()
				if response := f.queue("tool_answer", "ask-1", answer.card); !response.Accepted {
					t.Fatalf("answer %d = %+v", i, response)
				}
				got, _ := json.Marshal(f.postsTo("/v1/sessions/kb-session/questions/question-1")[0]["answers"])
				var want, sent any
				_ = json.Unmarshal([]byte(answer.want), &want)
				_ = json.Unmarshal(got, &sent)
				if !jsonEqual(want, sent) {
					t.Fatalf("answer %d sent %s, want %s", i, got, answer.want)
				}
			}
		})
	}
}

func jsonEqual(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return string(left) == string(right)
}

func TestQuestionAnswersReplayLabelsWithSeparator(t *testing.T) {
	recorded := []QuestionAnswer{
		{QuestionID: "q1", Prompt: "Which stack?", SelectedLabel: "Go"},
		{QuestionID: "q2", Prompt: "Add what?", SelectedLabel: "a badge", SelectedLabels: []string{"Search, filter", "CI"}, Custom: true},
	}
	// The text for the model cannot tell "Search, filter" from two options.
	text := "The user answered:\n1. Which stack?\n   → Go\n2. Add what?\n   → Search, filter, CI; plus a badge (user-typed answer via Other, not a listed option)"
	check := func(t *testing.T, details map[string]any) {
		t.Helper()
		answers, _ := details["answers"].([]any)
		if len(answers) != 2 {
			t.Fatalf("details = %+v", details)
		}
		if first := answers[0].(map[string]any); first["selectedLabel"] != "Go" || first["selectedLabels"] != nil || first["custom"] != nil {
			t.Fatalf("single answer = %+v", first)
		}
		second := answers[1].(map[string]any)
		labels, _ := second["selectedLabels"].([]any)
		if len(labels) != 2 || labels[0] != "Search, filter" || labels[1] != "CI" || second["customText"] != "a badge" || second["custom"] != true || second["selectedLabel"] != "Search, filter, CI, a badge" {
			t.Fatalf("multi answer = %+v", second)
		}
	}

	t.Run("history", func(t *testing.T) {
		raw, err := historyMessagesJSON([]Message{
			{Role: "assistant", ToolCalls: []ToolCall{{ID: "ask-1", Name: "question", Arguments: json.RawMessage(commaQuestionArgs), QuestionAnswers: recorded}}},
			{Role: "tool", ToolCallID: "ask-1", Name: "question", Content: []ContentBlock{{Type: "text", Text: text}}},
		}, 0)
		if err != nil {
			t.Fatal(err)
		}
		var entries []map[string]any
		if err := json.Unmarshal([]byte(raw), &entries); err != nil {
			t.Fatal(err)
		}
		details, _ := entries[1]["details"].(map[string]any)
		check(t, roundTrip(t, details))
	})

	t.Run("tool.result", func(t *testing.T) {
		f := newInteractiveFixture(t)
		f.send("tool.call", `{"tool_call":{"id":"ask-1","name":"question","arguments":`+commaQuestionArgs+`}}`)
		f.take()
		raw, _ := json.Marshal(map[string]any{"tool_result": map[string]any{"id": "ask-1", "name": "question", "output": text, "question_answers": recorded}})
		f.send("tool.result", string(raw))
		events := f.take()
		if len(events) != 1 {
			t.Fatalf("events = %+v", events)
		}
		details, _ := events[0].data["details"].(map[string]any)
		check(t, details)
	})

	t.Run("AskUserQuestion", func(t *testing.T) {
		resolution, _ := json.Marshal(map[string]any{
			"kind": "ask_user_question",
			"questions": []any{
				map[string]any{"id": "q1", "prompt": "Which stack?", "options": []any{map[string]any{"label": "Go"}, map[string]any{"label": "Rust"}}},
				map[string]any{"id": "q2", "prompt": "Add what?", "multiple": true, "options": []any{map[string]any{"label": "Docs"}, map[string]any{"label": "Search, filter"}, map[string]any{"label": "CI"}}},
			},
			"answers": recorded,
		})
		check(t, roundTrip(t, questionResultDetails(askUserQuestionTool, string(resolution), nil)))
		// question_answers on the call wins over the result's own answers.
		check(t, roundTrip(t, questionResultDetails(askUserQuestionTool, strings.Replace(string(resolution), `"Search, filter","CI"`, `"Docs"`, 1), recorded)))
	})

	t.Run("old sessions read the text", func(t *testing.T) {
		var args map[string]any
		_ = json.Unmarshal([]byte(commaQuestionArgs), &args)
		details := questionToolResultDetails(args, "The user answered:\n1. Which stack?\n   → Go\n2. Add what?\n   → Search, filter, CI", false, nil)
		answers, _ := details["answers"].([]any)
		if len(answers) != 2 || answers[1].(map[string]any)["selectedLabel"] != "Search, filter, CI" || answers[1].(map[string]any)["selectedLabels"] != nil {
			t.Fatalf("old-style details = %+v", details)
		}
		// A timed-out question records no answers and still shows as timed out.
		timedOut := questionToolResultDetails(args, "The user answered:\n1. Which stack?\n   → (no answer)\n2. Add what?\n   → (no answer)", false, []QuestionAnswer{})
		if timedOut["timedOut"] != true {
			t.Fatalf("timed out = %+v", timedOut)
		}
	})
}

func roundTrip(t *testing.T, value map[string]any) map[string]any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
