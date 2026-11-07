package kbrain

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

const (
	elicitCall    = `{"tool_call":{"id":"mcp-1","name":"mcp__deploy__ship","arguments":{"env":"prod"}}}`
	elicitRequest = `{"elicitation_id":"el-1","tool_call_id":"mcp-1","run_id":"kb-run","deadline_at":1900000000000,"server":"deploy","tool":"ship","message":"Confirm the release","fields":[{"name":"name","type":"string","required":true,"min_length":2},{"name":"token","type":"string","sensitive":true}],"requested_schema":{"type":"object"}}`
	elicitPath    = "/v1/sessions/kb-session/elicitations/el-1"
)

func elicitationLists(t *testing.T, event decodedEvent) (pending, records []map[string]any) {
	t.Helper()
	args := event.args()
	for key, target := range map[string]*[]map[string]any{argElicitationPending: &pending, argElicitationRecords: &records} {
		list, _ := args[key].([]any)
		for _, item := range list {
			entry, ok := item.(map[string]any)
			if !ok {
				t.Fatalf("%s entry = %#v", key, item)
			}
			*target = append(*target, entry)
		}
	}
	return pending, records
}

func TestElicitationRequestOpensFormAndForwardsAnswer(t *testing.T) {
	f := newInteractiveFixture(t)
	f.send("tool.call", elicitCall)
	f.take()
	if response := f.queue("mcp_elicitation", "mcp-1", `{"elicitationId":"el-1","action":"decline"}`); response.ErrorCode != "not_found" {
		t.Fatalf("unregistered form answered: %+v", response)
	}

	f.send("elicitation.requested", elicitRequest)
	events := f.take()
	if len(events) != 2 || events[0].kind != gatewayv2.ChatEvent_TOOL_CALL || events[1].data["status"] != "Waiting for your answer…" {
		t.Fatalf("request events = %+v", events)
	}
	pending, records := elicitationLists(t, events[0])
	if len(pending) != 1 || len(records) != 0 || pending[0]["server"] != "deploy" || pending[0]["message"] != "Confirm the release" || events[0].args()["env"] != "prod" {
		t.Fatalf("pending form = %+v", events[0].args())
	}
	if fields, _ := pending[0]["fields"].([]any); len(fields) != 2 {
		t.Fatalf("form fields = %+v", pending[0])
	}
	// A reconnect replays the request: the form is shown once.
	f.send("elicitation.requested", elicitRequest)
	f.send("elicitation.requested", elicitRequest)
	if events = f.take(); len(events) != 0 {
		t.Fatalf("replayed request redrew the form: %+v", events)
	}
	// A replayed model call keeps the form.
	f.send("tool.call", elicitCall)
	if events = f.take(); len(events) != 1 {
		t.Fatalf("replayed call = %+v", events)
	} else if pending, _ = elicitationLists(t, events[0]); len(pending) != 1 {
		t.Fatalf("replayed call lost the form: %+v", events[0].args())
	}

	// K-brain refuses the content: the form stays open with the field errors.
	f.mu.Lock()
	f.status[elicitPath] = http.StatusBadRequest
	f.replies[elicitPath] = `{"version":"kbrain.agent.v1","error":"invalid content: name: too short","field_errors":{"name":"must be at least 2 characters"}}`
	f.mu.Unlock()
	response := f.queue("mcp_elicitation", "mcp-1", `{"elicitationId":"el-1","action":"accept","content":{"name":"x","token":"s3cret"}}`)
	if response.Accepted || response.ErrorCode != "invalid_content" || response.Message != "invalid content: name: too short" {
		t.Fatalf("refused answer = %+v", response)
	}
	var item struct {
		FieldErrors map[string]string `json:"field_errors"`
	}
	if err := json.Unmarshal([]byte(response.ItemJSON), &item); err != nil || item.FieldErrors["name"] != "must be at least 2 characters" {
		t.Fatalf("field errors = %q (%v)", response.ItemJSON, err)
	}
	f.mu.Lock()
	delete(f.status, elicitPath)
	f.mu.Unlock()

	if response = f.queue("mcp_elicitation", "mcp-1", `{"elicitationId":"el-1","action":"accept","content":{"name":"Ada","token":"s3cret"}}`); !response.Accepted {
		t.Fatalf("answer = %+v", response)
	}
	posts := f.postsTo(elicitPath)
	if len(posts) != 2 {
		t.Fatalf("posts = %+v", posts)
	}
	body := posts[1]
	content, _ := body["content"].(map[string]any)
	if body["conversation_id"] != "kb-session" || body["run_id"] != "kb-run" || body["elicitation_id"] != "el-1" || body["action"] != "accept" || content["name"] != "Ada" || content["token"] != "s3cret" {
		t.Fatalf("answer body = %+v", body)
	}

	// The resolution has no fields; the summary keeps the request's. A sensitive
	// value K-brain failed to remove is removed here.
	resolved := `{"elicitation_id":"el-1","tool_call_id":"mcp-1","run_id":"kb-run","server":"deploy","tool":"ship","message":"Confirm the release","action":"accept","reason":"user","content":{"name":"Ada","token":"s3cret"}}`
	f.send("elicitation.resolved", resolved)
	events = f.take()
	if len(events) != 2 || events[1].data["status"] != nil {
		t.Fatalf("resolved events = %+v", events)
	}
	pending, records = elicitationLists(t, events[0])
	if len(pending) != 0 || len(records) != 1 {
		t.Fatalf("resolved form = %+v", events[0].args())
	}
	record := records[0]
	recorded, _ := record["content"].(map[string]any)
	redacted, _ := record["redacted"].([]any)
	fields, _ := record["fields"].([]any)
	if record["action"] != "accept" || recorded["name"] != "Ada" || recorded["token"] != nil || len(redacted) != 1 || redacted[0] != "token" || len(fields) != 2 {
		t.Fatalf("record = %+v", record)
	}
	f.mu.Lock()
	for _, event := range f.events {
		if strings.Contains(event.Data, "s3cret") {
			t.Fatalf("sensitive value forwarded: %s", event.Data)
		}
	}
	f.mu.Unlock()
	// Replays of the resolution change nothing, and the form is closed.
	f.send("elicitation.resolved", resolved)
	f.send("elicitation.requested", elicitRequest)
	if events = f.take(); len(events) != 0 {
		t.Fatalf("replayed resolution = %+v", events)
	}
	if response = f.queue("mcp_elicitation", "mcp-1", `{"elicitationId":"el-1","action":"decline"}`); response.ErrorCode != "not_found" {
		t.Fatalf("resolved form answered: %+v", response)
	}
}

func TestElicitationDeclineCancelAndTimeout(t *testing.T) {
	for _, action := range []string{"decline", "cancel"} {
		t.Run(action, func(t *testing.T) {
			f := newInteractiveFixture(t)
			f.send("tool.call", elicitCall)
			f.send("elicitation.requested", elicitRequest)
			f.take()
			// Content goes only with accept.
			if response := f.queue("mcp_elicitation", "mcp-1", `{"elicitationId":"el-1","action":"`+action+`","content":{"name":"Ada"}}`); !response.Accepted {
				t.Fatalf("%s = %+v", action, response)
			}
			body := f.postsTo(elicitPath)[0]
			if _, has := body["content"]; has || body["action"] != action {
				t.Fatalf("%s body = %+v", action, body)
			}
		})
	}
	f := newInteractiveFixture(t)
	f.send("tool.call", elicitCall)
	f.send("elicitation.requested", elicitRequest)
	f.take()
	for _, bad := range []string{`{"elicitationId":"el-1","action":"accept"}`, `{"elicitationId":"el-1","action":"maybe"}`, `not json`} {
		if response := f.queue("mcp_elicitation", "mcp-1", bad); response.ErrorCode != "invalid_request" {
			t.Fatalf("%s = %+v", bad, response)
		}
	}
	if response := f.queue("mcp_elicitation", "other-call", `{"elicitationId":"el-1","action":"decline"}`); response.ErrorCode != "not_found" {
		t.Fatalf("answer on another call = %+v", response)
	}
	if response := f.relay.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "mcp_elicitation", ConversationId: "conv-2", ItemId: "mcp-1", RequestJson: `{"elicitationId":"el-1","action":"decline"}`}); response.ErrorCode != "not_found" {
		t.Fatalf("answer from another conversation = %+v", response)
	}
	if posts := f.postsTo(elicitPath); len(posts) != 0 {
		t.Fatalf("refused answers reached K-brain: %+v", posts)
	}
	f.send("elicitation.resolved", `{"elicitation_id":"el-1","tool_call_id":"mcp-1","run_id":"kb-run","server":"deploy","message":"Confirm the release","action":"cancel","reason":"timeout"}`)
	events := f.take()
	pending, records := elicitationLists(t, events[0])
	if len(pending) != 0 || len(records) != 1 || records[0]["reason"] != "timeout" || records[0]["action"] != "cancel" {
		t.Fatalf("timed out form = %+v", events[0].args())
	}
}

func TestElicitationSettledAnswerAndRunEnd(t *testing.T) {
	for _, status := range []int{http.StatusNotFound, http.StatusConflict} {
		f := newInteractiveFixture(t)
		f.send("tool.call", elicitCall)
		f.send("elicitation.requested", elicitRequest)
		f.take()
		f.status[elicitPath] = status
		f.replies[elicitPath] = `{"error":"elicitation is no longer pending"}`
		if response := f.queue("mcp_elicitation", "mcp-1", `{"elicitationId":"el-1","action":"decline"}`); response.ErrorCode != "not_found" {
			t.Fatalf("%d answer = %+v", status, response)
		}
		if response := f.queue("mcp_elicitation", "mcp-1", `{"elicitationId":"el-1","action":"decline"}`); response.ErrorCode != "not_found" || len(f.postsTo(elicitPath)) != 1 {
			t.Fatalf("%d settled form still answerable: %+v", status, response)
		}
	}

	f := newInteractiveFixture(t)
	f.send("tool.call", elicitCall)
	f.send("elicitation.requested", elicitRequest)
	f.take()
	f.send("run.cancelled", `{"state":"cancelled"}`)
	events := f.take()
	if len(events) == 0 {
		t.Fatal("run end did not redraw the form")
	}
	if pending, _ := elicitationLists(t, events[0]); len(pending) != 0 {
		t.Fatalf("finished run keeps the form open: %+v", events[0].args())
	}
	if response := f.queue("mcp_elicitation", "mcp-1", `{"elicitationId":"el-1","action":"decline"}`); response.ErrorCode != "not_found" {
		t.Fatalf("finished run answered: %+v", response)
	}
}

func TestModelCannotFakeElicitationForm(t *testing.T) {
	f := newInteractiveFixture(t)
	f.send("tool.call", `{"tool_call":{"id":"mcp-1","name":"mcp__deploy__ship","arguments":{"env":"prod","__mcpElicitationPending":[{"elicitation_id":"fake"}],"__mcpElicitations":[]}}}`)
	events := f.take()
	if args := events[0].args(); len(args) != 1 || args["env"] != "prod" {
		t.Fatalf("model arguments = %+v", args)
	}
}

func TestElicitationsReachToolResultAndHistory(t *testing.T) {
	recorded := `[{"elicitation_id":"el-1","server":"deploy","message":"Confirm","fields":[{"name":"name","type":"string"},{"name":"token","type":"string","sensitive":true}],"action":"accept","reason":"user","content":{"name":"Ada","token":"leak"},"redacted":["token"]},{"server":"deploy","message":"Again","action":"decline","reason":"unattended"}]`
	check := func(label string, details map[string]any) {
		t.Helper()
		list, _ := details[elicitationDetailsKey].([]any)
		if len(list) != 2 {
			t.Fatalf("%s details = %+v", label, details)
		}
		first := list[0].(map[string]any)
		content, _ := first["content"].(map[string]any)
		redacted, _ := first["redacted"].([]any)
		if content["name"] != "Ada" || content["token"] != nil || len(redacted) != 1 {
			t.Fatalf("%s record = %+v", label, first)
		}
		if list[1].(map[string]any)["reason"] != "unattended" {
			t.Fatalf("%s auto-decline = %+v", label, list[1])
		}
	}
	event, _, err := ToChatEvent(Event{Type: "tool.result", Payload: json.RawMessage(`{"tool_result":{"id":"mcp-1","name":"mcp__deploy__ship","output":"shipped","elicitations":` + recorded + `}}`)})
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	_ = json.Unmarshal([]byte(event.GetData()), &payload)
	details, _ := payload["details"].(map[string]any)
	check("tool.result", details)
	if strings.Contains(event.GetData(), "leak") {
		t.Fatalf("sensitive value in tool result: %s", event.GetData())
	}

	var records []json.RawMessage
	_ = json.Unmarshal([]byte(recorded), &records)
	raw, err := historyMessagesJSON([]Message{
		{Role: "assistant", ToolCalls: []ToolCall{{ID: "mcp-1", Name: "mcp__deploy__ship", Arguments: json.RawMessage(`{"env":"prod"}`), Elicitations: records}}},
		{Role: "tool", ToolCallID: "mcp-1", Name: "mcp__deploy__ship", Content: []ContentBlock{{Type: "text", Text: "shipped"}}},
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	var entries []map[string]any
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		t.Fatal(err)
	}
	details, _ = entries[1]["details"].(map[string]any)
	check("history", details)
	if strings.Contains(raw, "leak") {
		t.Fatalf("sensitive value in history: %s", raw)
	}
}

// options.mcp_elicitation is sent only when the handshake proves capability
// mcp_elicitation: older backends reject unknown run options.
func TestStartRunAsksForElicitationOnlyWithCapability(t *testing.T) {
	for name, tc := range map[string]struct {
		health string
		want   bool
	}{
		"capable backend": {`{"status":"ok","version":"kbrain.agent.v1","capabilities":{"mcp_elicitation":1}}`, true},
		"older backend":   {`{"status":"ok","version":"kbrain.agent.v1","capabilities":{}}`, false},
		"no health":       {"", false},
	} {
		t.Run(name, func(t *testing.T) {
			var mu sync.Mutex
			var sent map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/health" {
					if tc.health == "" {
						http.NotFound(w, r)
						return
					}
					_, _ = io.WriteString(w, tc.health)
					return
				}
				var body struct {
					Options map[string]any `json:"options"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				mu.Lock()
				sent = body.Options
				mu.Unlock()
				w.WriteHeader(http.StatusAccepted)
				_, _ = io.WriteString(w, `{"version":"kbrain.agent.v1","conversation_id":"session","run_id":"run","accepted_seq":1}`)
			}))
			defer server.Close()
			client := &Client{BaseURL: server.URL, HTTP: server.Client()}
			options := &RunOptions{Mode: "agent", PermissionMode: "normal"}
			if _, _, err := client.StartRun(context.Background(), "session", PromptRequest{ConversationID: "session", Prompt: "hi", Options: options}); err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			defer mu.Unlock()
			_, has := sent["mcp_elicitation"]
			if sent == nil || has != tc.want || (tc.want && sent["mcp_elicitation"] != true) {
				t.Fatalf("options = %+v, want mcp_elicitation %v", sent, tc.want)
			}
			if options.MCPElicitation {
				t.Fatalf("caller options mutated: %+v", options)
			}
		})
	}
}
