package kbrain

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

type interactiveFixture struct {
	t      *testing.T
	relay  *Relay
	mu     sync.Mutex
	posts  map[string][]map[string]any
	status map[string]int
	events []*gatewayv2.ChatEvent
}

func newInteractiveFixture(t *testing.T) *interactiveFixture {
	t.Helper()
	f := &interactiveFixture{t: t, posts: map[string][]map[string]any{}, status: map[string]int{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		data, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(data, &body); err != nil {
			t.Errorf("decode %s: %v", r.URL.Path, err)
		}
		f.mu.Lock()
		f.posts[r.URL.Path] = append(f.posts[r.URL.Path], body)
		status := f.status[r.URL.Path]
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if status != 0 {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":"cannot store rules: project has no workspace"}`))
			return
		}
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	t.Cleanup(srv.Close)
	client, err := New(srv.URL, "", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "kbrain", ModelRef{Provider: "fixture", Model: "fixture-model"}, "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	f.relay = relay
	return f
}

func (f *interactiveFixture) send(eventType, payload string) *gatewayv2.ChatControlEvent {
	f.t.Helper()
	control, err := f.relay.relayRunEvent(context.Background(), Event{ConversationID: "kb-session", RunID: "kb-run", Type: eventType, Payload: json.RawMessage(payload)}, "conv-1", f.emit)
	if err != nil {
		f.t.Fatalf("%s: %v", eventType, err)
	}
	return control
}

func (f *interactiveFixture) emit(event *gatewayv2.ChatEvent) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, event)
}

// take returns the events emitted since the last call, decoded.
func (f *interactiveFixture) take() []decodedEvent {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]decodedEvent, 0, len(f.events))
	for _, event := range f.events {
		data := map[string]any{}
		if err := json.Unmarshal([]byte(event.Data), &data); err != nil {
			f.t.Fatalf("event data %q: %v", event.Data, err)
		}
		if event.ConversationId != "conv-1" {
			f.t.Fatalf("event left the gateway conversation: %+v", event)
		}
		out = append(out, decodedEvent{kind: event.Type, data: data})
	}
	f.events = nil
	return out
}

func (f *interactiveFixture) postsTo(path string) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.posts[path]
}

func (f *interactiveFixture) queue(action, itemID, request string) QueueResponse {
	return f.relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: action, ConversationId: "conv-1", ItemId: itemID, RequestJson: request})
}

type decodedEvent struct {
	kind gatewayv2.ChatEvent_ChatEventType
	data map[string]any
}

func (e decodedEvent) args() map[string]any {
	args, _ := e.data["arguments"].(map[string]any)
	return args
}

func TestPermissionRequestOpensApprovalCardAndForwardsDecision(t *testing.T) {
	f := newInteractiveFixture(t)
	f.send("tool.call", `{"tool_call":{"id":"call-1","name":"Bash","arguments":{"command":"ls","__toolApprovalPending":true,"__askUserQuestionPending":true}}}`)
	events := f.take()
	if len(events) != 1 || events[0].kind != gatewayv2.ChatEvent_TOOL_CALL || events[0].data["id"] != "call-1" {
		t.Fatalf("tool call = %+v", events)
	}
	if args := events[0].args(); args["command"] != "ls" || args[argApprovalPending] != nil || args[argQuestionPending] != nil {
		t.Fatalf("model-supplied synthetic args must be dropped: %+v", args)
	}

	f.send("permission.requested", `{"permission_id":"perm-1","tool":"Bash","command":"ls","description":"List files","options":[{"id":"allow_once"},{"id":"reject"},{"id":"allow_always"}],"suggestion":{"rules":["Bash(ls:*)"],"default_scope":"project"},"tool_call_id":"call-1"}`)
	if posts := f.postsTo("/v1/sessions/kb-session/permissions/perm-1"); len(posts) != 0 {
		t.Fatalf("permission must wait for the user, got %+v", posts)
	}
	events = f.take()
	if len(events) != 2 || events[0].data["id"] != "call-1" || events[1].kind != gatewayv2.ChatEvent_TOOL_STATUS {
		t.Fatalf("permission events = %+v", events)
	}
	args := events[0].args()
	if args["command"] != "ls" || args[argApprovalPending] != true || args[argApprovalAllowAlways] != true || args[argApprovalSummary] != "ls\n\nList files" || args[argApprovalDefault] != "project" {
		t.Fatalf("approval overlay = %+v", args)
	}
	if rules, _ := args[argApprovalRules].([]any); len(rules) != 1 || rules[0] != "Bash(ls:*)" {
		t.Fatalf("remember rules = %+v", args[argApprovalRules])
	}
	if events[1].data["status"] != "Waiting for permission…" {
		t.Fatalf("status = %+v", events[1].data)
	}

	if response := f.queue("tool_approval", "call-1", `{"decision":"approve_session","scope":"user"}`); !response.Accepted {
		t.Fatalf("approval rejected: %+v", response)
	}
	posts := f.postsTo("/v1/sessions/kb-session/permissions/perm-1")
	if len(posts) != 1 {
		t.Fatalf("posts = %+v", posts)
	}
	decision, _ := posts[0]["decision"].(map[string]any)
	if posts[0]["conversation_id"] != "kb-session" || posts[0]["run_id"] != "kb-run" || decision["permission_id"] != "perm-1" || decision["decision"] != "allow_always" || decision["scope"] != "user" {
		t.Fatalf("permission body = %+v", posts[0])
	}

	f.send("permission.resolved", `{"permission_id":"perm-1","decision":"allow_always"}`)
	events = f.take()
	if len(events) != 2 || events[0].data["id"] != "call-1" || events[0].args()[argApprovalPending] != nil || events[1].data["status"] != nil {
		t.Fatalf("resolved events = %+v", events)
	}
	if response := f.queue("tool_approval", "call-1", `{"decision":"approve"}`); response.Accepted || response.ErrorCode != "not_found" {
		t.Fatalf("settled approval answered again: %+v", response)
	}
}

func TestApprovalDecisionMapping(t *testing.T) {
	for _, test := range []struct {
		request, decision, scope, reason string
		rules                            bool
	}{
		{request: `{"decision":"approve"}`, decision: "allow_once"},
		{request: `"approve"`, decision: "allow_once"},
		{request: `{"decision":"approve_session"}`, decision: "allow_always"},
		{request: `{"decision":"approve_session"}`, decision: "allow_always", scope: "session", rules: true},
		{request: `{"decision":"approve_session","scope":"bogus"}`, decision: "allow_always", scope: "session", rules: true},
		{request: `{"decision":"deny","reason":"not now"}`, decision: "reject", reason: "not now"},
	} {
		f := newInteractiveFixture(t)
		suggestion := ""
		if test.rules {
			suggestion = `,"suggestion":{"rules":["Bash(ls:*)"],"default_scope":"session"}`
		}
		f.send("tool.call", `{"tool_call":{"id":"call-1","name":"Bash","arguments":{"command":"ls"}}}`)
		f.send("permission.requested", `{"permission_id":"perm-1","tool":"Bash","command":"ls","tool_call_id":"call-1"`+suggestion+`}`)
		if response := f.queue("tool_approval", "call-1", test.request); !response.Accepted {
			t.Fatalf("%s: %+v", test.request, response)
		}
		decision, _ := f.postsTo("/v1/sessions/kb-session/permissions/perm-1")[0]["decision"].(map[string]any)
		scope, _ := decision["scope"].(string)
		reason, _ := decision["reason"].(string)
		if decision["decision"] != test.decision || scope != test.scope || reason != test.reason {
			t.Fatalf("%s: decision = %+v", test.request, decision)
		}
	}
	f := newInteractiveFixture(t)
	f.send("permission.requested", `{"permission_id":"perm-1","tool":"Bash","tool_call_id":"call-x"}`)
	if response := f.queue("tool_approval", syntheticPermissionPrefix+"perm-1", `{"decision":"maybe"}`); response.Accepted || response.ErrorCode != "invalid_request" {
		t.Fatalf("invalid decision = %+v", response)
	}
}

func TestPermissionWithoutToolCallUsesSyntheticCard(t *testing.T) {
	f := newInteractiveFixture(t)
	f.send("permission.requested", `{"permission_id":"perm-9","tool":"computer_exec","description":"Click the Save button","scope":"session","rule":"call:click","options":[{"id":"allow_once"},{"id":"reject"}]}`)
	events := f.take()
	if len(events) != 2 || events[0].data["id"] != syntheticPermissionPrefix+"perm-9" || events[0].data["name"] != "computer_exec" {
		t.Fatalf("synthetic card = %+v", events)
	}
	args := events[0].args()
	if args[argApprovalPending] != true || args[argApprovalSessionWide] != true || args[argApprovalAllowAlways] != false || args[argApprovalScope] != "call:click" || args["description"] != "Click the Save button" {
		t.Fatalf("synthetic overlay = %+v", args)
	}
	f.send("permission.resolved", `{"permission_id":"perm-9","decision":"reject","reason":"no"}`)
	events = f.take()
	if len(events) != 3 || events[1].kind != gatewayv2.ChatEvent_TOOL_RESULT || events[1].data["isError"] != true {
		t.Fatalf("synthetic resolution = %+v", events)
	}
	if content, _ := events[1].data["content"].([]any); len(content) != 1 || content[0].(map[string]any)["text"] != "Rejected: no" {
		t.Fatalf("synthetic result = %+v", events[1].data)
	}
}

func TestRefusedRememberKeepsApprovalPendingWithNotice(t *testing.T) {
	f := newInteractiveFixture(t)
	f.status["/v1/sessions/kb-session/permissions/perm-1"] = http.StatusBadRequest
	f.send("tool.call", `{"tool_call":{"id":"call-1","name":"Bash","arguments":{"command":"ls"}}}`)
	f.send("permission.requested", `{"permission_id":"perm-1","tool":"Bash","command":"ls","tool_call_id":"call-1","suggestion":{"rules":["Bash(ls:*)"],"default_scope":"project"}}`)
	f.take()
	response := f.queue("tool_approval", "call-1", `{"decision":"approve_session","scope":"project"}`)
	if response.Accepted || !strings.Contains(response.Message, "cannot store rules") {
		t.Fatalf("refusal = %+v", response)
	}
	events := f.take()
	if len(events) != 1 || events[0].args()[argApprovalPending] != true || !strings.Contains(fmt.Sprint(events[0].args()[argApprovalNotice]), "cannot store rules") {
		t.Fatalf("refusal redraw = %+v", events)
	}
	// The card is still answerable.
	f.status["/v1/sessions/kb-session/permissions/perm-1"] = 0
	if response := f.queue("tool_approval", "call-1", `{"decision":"approve"}`); !response.Accepted {
		t.Fatalf("retry = %+v", response)
	}
}

func TestSettledPermissionAnswerIsAccepted(t *testing.T) {
	f := newInteractiveFixture(t)
	f.status["/v1/sessions/kb-session/permissions/perm-1"] = http.StatusNotFound
	f.send("tool.call", `{"tool_call":{"id":"call-1","name":"Bash","arguments":{"command":"ls"}}}`)
	f.send("permission.requested", `{"permission_id":"perm-1","tool":"Bash","command":"ls","tool_call_id":"call-1"}`)
	if response := f.queue("tool_approval", "call-1", `{"decision":"approve"}`); !response.Accepted {
		t.Fatalf("settled = %+v", response)
	}
	if response := f.queue("tool_approval", "call-1", `{"decision":"approve"}`); response.ErrorCode != "not_found" {
		t.Fatalf("dropped approval still pending: %+v", response)
	}
}

func TestQuestionRequestOpensCardAndForwardsAnswers(t *testing.T) {
	f := newInteractiveFixture(t)
	f.send("tool.call", `{"tool_call":{"id":"ask-1","name":"AskUserQuestion","arguments":{"questions":[{"question":"Pick"}]}}}`)
	events := f.take()
	if len(events) != 1 || events[0].args()[argQuestionPending] != false {
		t.Fatalf("question call before registration = %+v", events)
	}
	if response := f.queue("tool_answer", "ask-1", `[{"questionId":"q1","selectedLabel":"Red"}]`); response.ErrorCode != "not_found" {
		t.Fatalf("unregistered question answered: %+v", response)
	}

	f.send("question.requested", `{"question_id":"question-1","tool_call_id":"ask-1","run_id":"kb-run","deadline_at":1900000000000,"questions":[{"id":"q1","header":"Color","prompt":"Pick a color","options":[{"label":"Red"},{"label":"Blue","recommended":true}]}]}`)
	events = f.take()
	if len(events) != 2 || events[0].data["name"] != askUserQuestionTool || events[1].data["status"] != "Waiting for your answer…" {
		t.Fatalf("question events = %+v", events)
	}
	args := events[0].args()
	questions, _ := args["questions"].([]any)
	if args[argQuestionPending] != true || args[argQuestionDeadline] != float64(1900000000000) || len(questions) != 1 || questions[0].(map[string]any)["prompt"] != "Pick a color" {
		t.Fatalf("question args = %+v", args)
	}
	// A late replay of the model call keeps the registered card.
	f.send("tool.call", `{"tool_call":{"id":"ask-1","name":"AskUserQuestion","arguments":{"questions":[{"question":"Pick"}]}}}`)
	if events = f.take(); len(events) != 1 || events[0].args()[argQuestionPending] != true {
		t.Fatalf("replayed call = %+v", events)
	}

	answers := `[{"questionId":"q1","prompt":"Pick a color","selectedLabel":"Green","custom":true}]`
	if response := f.queue("tool_answer", "ask-1", answers); !response.Accepted {
		t.Fatalf("answer = %+v", response)
	}
	posts := f.postsTo("/v1/sessions/kb-session/questions/question-1")
	if len(posts) != 1 {
		t.Fatalf("posts = %+v", posts)
	}
	body := posts[0]
	sent, _ := body["answers"].([]any)
	if body["conversation_id"] != "kb-session" || body["run_id"] != "kb-run" || body["question_id"] != "question-1" || len(sent) != 1 {
		t.Fatalf("answer body = %+v", body)
	}
	if answer := sent[0].(map[string]any); answer["question_id"] != "q1" || answer["selected_label"] != "Green" || answer["custom"] != true || answer["prompt"] != "Pick a color" {
		t.Fatalf("answer = %+v", answer)
	}

	f.send("question.resolved", `{"question_id":"question-1","tool_call_id":"ask-1"}`)
	events = f.take()
	if len(events) != 2 || events[0].args()[argQuestionPending] != false {
		t.Fatalf("resolved question = %+v", events)
	}
}

func TestRunEndClosesPendingCards(t *testing.T) {
	f := newInteractiveFixture(t)
	f.send("tool.call", `{"tool_call":{"id":"call-1","name":"Bash","arguments":{"command":"ls"}}}`)
	f.send("permission.requested", `{"permission_id":"perm-1","tool":"Bash","tool_call_id":"call-1"}`)
	f.send("permission.requested", `{"permission_id":"perm-2","tool":"Write"}`)
	f.send("question.requested", `{"question_id":"question-1","tool_call_id":"ask-1","questions":[]}`)
	f.take()
	control := f.send("run.cancelled", `{"state":"cancelled"}`)
	if control == nil || control.Type != "cancelled" {
		t.Fatalf("control = %+v", control)
	}
	events := f.take()
	pending := 0
	results := 0
	for _, event := range events {
		if event.args()[argApprovalPending] == true || event.args()[argQuestionPending] == true {
			pending++
		}
		if event.kind == gatewayv2.ChatEvent_TOOL_RESULT {
			results++
		}
	}
	if pending != 0 || results != 1 || len(events) != 4 {
		t.Fatalf("run end events = %+v", events)
	}
	for _, item := range []string{"call-1", syntheticPermissionPrefix + "perm-2"} {
		if response := f.queue("tool_approval", item, `{"decision":"approve"}`); response.ErrorCode != "not_found" {
			t.Fatalf("%s still pending: %+v", item, response)
		}
	}
}

func TestAutoResolvedPermissionMarksCall(t *testing.T) {
	f := newInteractiveFixture(t)
	f.send("permission.auto_resolved", `{"tool_call_id":"call-1","tool":"Bash","source":"rule","rule":"Bash(ls:*)","scope":"project"}`)
	if events := f.take(); len(events) != 0 {
		t.Fatalf("marker before call = %+v", events)
	}
	f.send("tool.call", `{"tool_call":{"id":"call-1","name":"Bash","arguments":{"command":"ls"}}}`)
	events := f.take()
	marker, _ := events[0].args()[argAutoResolved].(map[string]any)
	if marker["source"] != "rule" || marker["rule"] != "Bash(ls:*)" || marker["scope"] != "project" {
		t.Fatalf("marker = %+v", events)
	}
}

func TestLiveToolOutputAndStatusEvents(t *testing.T) {
	f := newInteractiveFixture(t)
	f.send("tool.call", `{"tool_call":{"id":"call-1","name":"Bash","arguments":{"command":"make"}}}`)
	f.take()
	f.send("tool.status", `{"tool_call_id":"call-1","tool":"Bash","status":"running","message":"line 1\nline 2"}`)
	events := f.take()
	if len(events) != 1 || events[0].kind != gatewayv2.ChatEvent_TOOL_CALL || events[0].data["type"] != "tool_output" || events[0].data["id"] != "call-1" || events[0].data["output"] != "line 1\nline 2" {
		t.Fatalf("live output = %+v", events)
	}
	f.send("tool.result", `{"tool_result":{"id":"call-1","name":"Bash","output":"done"}}`)
	f.take()
	f.send("tool.status", `{"tool_call_id":"call-1","tool":"Bash","status":"running","message":"late"}`)
	if events := f.take(); len(events) != 0 {
		t.Fatalf("output after the result = %+v", events)
	}

	f.send("compaction.started", `{"tool":"compaction","status":"running","compaction":true}`)
	f.send("compaction.completed", `{"status":"completed"}`)
	f.send("hook.warning", `{"hookName":"lint","hookType":"command","event":"PostToolUse","message":"exit 1"}`)
	events = f.take()
	if len(events) != 3 || events[0].data["isCompaction"] != true || events[1].data["status"] != nil || events[2].data["status"] != "Hook lint (PostToolUse) warning: exit 1" {
		t.Fatalf("status events = %+v", events)
	}
	for _, event := range events {
		if event.kind != gatewayv2.ChatEvent_TOOL_STATUS {
			t.Fatalf("status kind = %+v", event)
		}
	}

	f.send("goal.updated", `{"version":3,"conversation_id":"kb-session","goal":"Ship it","status":"active","round":1}`)
	events = f.take()
	goal, _ := events[0].data["goal"].(map[string]any)
	if len(events) != 1 || events[0].data["type"] != "goal_updated" || goal["goal"] != "Ship it" || goal["version"] != float64(3) {
		t.Fatalf("goal = %+v", events)
	}

	f.send("history.updated", `{"revision":4}`)
	if events := f.take(); len(events) != 0 {
		t.Fatalf("history.updated = %+v", events)
	}
}

func TestSubagentEventsProjectToToolCard(t *testing.T) {
	f := newInteractiveFixture(t)
	f.send("subagent.started", `{"subagent":{"id":"sa-1","description":"Survey the docs","status":"running","model":{"provider":"p","model":"m"}}}`)
	f.send("subagent.completed", `{"subagent":{"id":"sa-1","description":"Survey the docs","status":"completed","report":"Found 3 pages"}}`)
	events := f.take()
	if len(events) != 3 || events[0].data["id"] != subagentCallPrefix+"sa-1" || events[0].data["name"] != "subagent" || events[0].args()["description"] != "Survey the docs" {
		t.Fatalf("subagent = %+v", events)
	}
	if events[2].kind != gatewayv2.ChatEvent_TOOL_RESULT || events[2].data["isError"] != false || events[2].data["content"].([]any)[0].(map[string]any)["text"] != "Found 3 pages" {
		t.Fatalf("subagent result = %+v", events[2])
	}
}

func TestClientToolRequestFailsFast(t *testing.T) {
	f := newInteractiveFixture(t)
	f.send("client_tool.requested", `{"call_id":"ct-1","tool_call_id":"call-1","run_id":"kb-run","tool":"open_url","arguments":{}}`)
	posts := f.postsTo("/v1/sessions/kb-session/client-tools/ct-1")
	if len(posts) != 1 || posts[0]["is_error"] != true || posts[0]["run_id"] != "kb-run" || !strings.Contains(fmt.Sprint(posts[0]["text"]), "open_url must execute in K-brain") {
		t.Fatalf("client tool posts = %+v", posts)
	}
	if events := f.take(); len(events) != 0 {
		t.Fatalf("client tool events = %+v", events)
	}
}

func TestPlanDecisionUnsupportedInDirectMode(t *testing.T) {
	f := newInteractiveFixture(t)
	if response := f.queue("plan_decision", "plan-1", `{"decision":"approve"}`); response.Accepted || response.ErrorCode != "unsupported" {
		t.Fatalf("plan decision = %+v", response)
	}
}

// The relay no longer rejects permissions on the user's behalf: the run waits
// and WebUI gets an answerable card.
func TestRelayRunWaitsForPermissionAnswer(t *testing.T) {
	var mu sync.Mutex
	var permissionPosts []string
	answered := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/sessions":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"kb-session"}`))
		case "/v1/sessions/kb-session/runs":
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","conversation_id":"kb-session","run_id":"kb-run","accepted_seq":1}`))
		case "/v1/sessions/kb-session/permissions/perm-1":
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			permissionPosts = append(permissionPosts, string(body))
			mu.Unlock()
			_, _ = w.Write([]byte(`{"accepted":true}`))
			close(answered)
		case "/v1/sessions/kb-session/events":
			w.Header().Set("Content-Type", "text/event-stream")
			flusher, _ := w.(http.Flusher)
			after := r.URL.Query().Get("after_seq")
			if after == "" || after == "0" {
				fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":1,\"conversation_id\":\"kb-session\",\"run_id\":\"kb-run\",\"type\":\"run.accepted\"}\n\n")
				fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":2,\"conversation_id\":\"kb-session\",\"run_id\":\"kb-run\",\"type\":\"tool.call\",\"payload\":{\"tool_call\":{\"id\":\"call-1\",\"name\":\"Bash\",\"arguments\":{\"command\":\"ls\"}}}}\n\n")
				fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":3,\"conversation_id\":\"kb-session\",\"run_id\":\"kb-run\",\"type\":\"permission.requested\",\"payload\":{\"permission_id\":\"perm-1\",\"tool\":\"Bash\",\"command\":\"ls\",\"tool_call_id\":\"call-1\"}}\n\n")
				if flusher != nil {
					flusher.Flush()
				}
			}
			select {
			case <-answered:
			case <-r.Context().Done():
				return
			}
			fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":4,\"conversation_id\":\"kb-session\",\"run_id\":\"kb-run\",\"type\":\"permission.resolved\",\"payload\":{\"permission_id\":\"perm-1\",\"decision\":\"allow_once\"}}\n\n")
			fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":5,\"conversation_id\":\"kb-session\",\"run_id\":\"kb-run\",\"type\":\"run.completed\",\"payload\":{\"state\":\"completed\"}}\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	client, err := New(srv.URL, "", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "kbrain", ModelRef{Provider: "fixture", Model: "fixture-model"}, "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	cardShown := make(chan struct{})
	done := make(chan struct{})
	var once sync.Once
	_, err = relay.StartWithCWD(context.Background(), "gw-run", "conv-1", "client-1", "/workspace", PromptRequest{Prompt: "list files"}, "auto", Callbacks{
		OnEvent: func(_ string, event *gatewayv2.ChatEvent) {
			if event.Type == gatewayv2.ChatEvent_TOOL_CALL && strings.Contains(event.Data, argApprovalPending) {
				once.Do(func() { close(cardShown) })
			}
		},
		OnControl: func(_ string, control *gatewayv2.ChatControlEvent) {
			if control.Type == "completed" {
				close(done)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-cardShown:
	case <-time.After(2 * time.Second):
		t.Fatal("approval card was not shown")
	}
	mu.Lock()
	if len(permissionPosts) != 0 {
		t.Fatalf("relay answered for the user: %v", permissionPosts)
	}
	mu.Unlock()
	if response := relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "tool_approval", ConversationId: "conv-1", ItemId: "call-1", RequestJson: `{"decision":"approve"}`}); !response.Accepted {
		t.Fatalf("approve = %+v", response)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("run did not complete after approval")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(permissionPosts) != 1 || !strings.Contains(permissionPosts[0], `"decision":"allow_once"`) {
		t.Fatalf("permission posts = %v", permissionPosts)
	}
}
