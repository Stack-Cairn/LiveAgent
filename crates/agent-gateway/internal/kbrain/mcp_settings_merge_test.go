package kbrain

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestMergeMCPSettingsKeepsKBrainFieldsTheWebUIDoesNotEdit(t *testing.T) {
	current := `{"settings":{"servers":[
		{"id":"docs","enabled":true,"transport":"stdio","command":"docs-mcp","env":null,
		 "policy":{"*":"deny"},"workspaceRoots":["/work/a"],"futureField":7},
		{"id":"gone","enabled":true,"transport":"stdio","command":"x"}
	],"selected":["docs"],"futureTop":{"x":1}},"statuses":[]}`
	update := `{"servers":[
		{"id":"docs","enabled":false,"transport":"stdio","command":"docs-mcp","policy":{"*":"ask"},
		 "messageUrl":"http://legacy","backendFields":{"futureField":7}},
		{"id":"new","enabled":true,"transport":"http","url":"https://mcp.example"}
	],"selected":[]}`

	merged, err := mergeMCPSettingsWithCurrent(json.RawMessage(update), json.RawMessage(current))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(merged, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"servers": []any{
			map[string]any{
				"id": "docs", "enabled": false, "transport": "stdio", "command": "docs-mcp", "env": nil,
				// The WebUI's own policy change wins; fields it left out keep K-brain's value.
				"policy": map[string]any{"*": "ask"}, "workspaceRoots": []any{"/work/a"}, "futureField": float64(7),
			},
			map[string]any{"id": "new", "enabled": true, "transport": "http", "url": "https://mcp.example"},
		},
		"selected":  []any{},
		"futureTop": map[string]any{"x": float64(1)},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("merged:\n%s", merged)
	}

	for _, bad := range []string{`[]`, `{"servers":null}`, `{"servers":[null]}`} {
		if _, err := mergeMCPSettingsWithCurrent(json.RawMessage(bad), json.RawMessage(current)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	// A K-brain without saved settings answers an empty document.
	if _, err := mergeMCPSettingsWithCurrent(json.RawMessage(`{"servers":[]}`), json.RawMessage(`{"settings":{"servers":[]}}`)); err != nil {
		t.Fatal(err)
	}
}

func TestRelayMCPSaveKeepsPolicyAndWorkspaceRoots(t *testing.T) {
	stored := `{"servers":[{"id":"docs","enabled":true,"transport":"stdio","command":"docs-mcp","policy":{"*":"deny"},"workspaceRoots":["/work/a"]}],"selected":[]}`
	var put map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/settings":
			_, _ = io.WriteString(w, `{"providers":[],"models":[]}`)
		case r.URL.Path == "/v1/mcp" && r.Method == "GET":
			_, _ = io.WriteString(w, `{"settings":`+stored+`,"statuses":[]}`)
		case r.URL.Path == "/v1/mcp" && r.Method == "PUT":
			if err := json.NewDecoder(r.Body).Decode(&put); err != nil {
				t.Error(err)
			}
			_, _ = io.WriteString(w, `{"settings":`+stored+`}`)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL)
		}
	}))
	defer srv.Close()
	client, _ := New(srv.URL, "token", srv.Client())
	relay, _ := NewRelay(client, "kb", ModelRef{}, "")
	// The WebUI disables the server; it never edits workspaceRoots and this build
	// sends no policy.
	body := `{"mcp":{"servers":[{"id":"docs","enabled":false,"transport":"stdio","command":"docs-mcp"}],"selected":[]}}`
	if response, err := relay.SettingsUpdate(context.Background(), &gatewayv2.SettingsUpdateRequest{SettingsJson: body}); err != nil || !response.GetAccepted() {
		t.Fatalf("update=%v %v", response, err)
	}
	server := put["servers"].([]any)[0].(map[string]any)
	if server["enabled"] != false || !reflect.DeepEqual(server["policy"], map[string]any{"*": "deny"}) || !reflect.DeepEqual(server["workspaceRoots"], []any{"/work/a"}) {
		t.Fatalf("PUT body lost K-brain fields: %v", put)
	}
}
