package kbrain

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

type recordedRequest struct {
	method string
	uri    string
	body   map[string]any
}

func permissionRulesRelay(t *testing.T, status int, answer string) (*Relay, *[]recordedRequest) {
	t.Helper()
	var seen []recordedRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		raw, _ := io.ReadAll(req.Body)
		record := recordedRequest{method: req.Method, uri: req.URL.RequestURI()}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &record.body)
		}
		seen = append(seen, record)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, answer)
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, "secret-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "target", ModelRef{}, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { relay.Close() })
	return relay, &seen
}

// The WebUI reaches K-brain's rules API through the relay with only the fields the
// settings page needs; the answer is K-brain's JSON as is.
func TestPermissionRulesRelayMapsActionsToTheRulesAPI(t *testing.T) {
	relay, seen := permissionRulesRelay(t, http.StatusOK, `{"project_root":"D:\\w","rules":[{"id":"r_1","rule":"Bash(ls:*)","effect":"allow","scope":"project"}]}`)
	response, err := relay.PermissionRules(context.Background(), &gatewayv2.PermissionRulesRequest{Action: "list", InputJson: `{"workspace":"D:\\w","session_id":"s1"}`})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(response.GetResultJson(), `"r_1"`) {
		t.Fatalf("result = %s", response.GetResultJson())
	}
	if got := (*seen)[0]; got.method != http.MethodGet || got.uri != "/v1/permissions/rules?workspace=D%3A%5Cw" {
		t.Fatalf("list request = %+v", got)
	}

	if _, err := relay.PermissionRules(context.Background(), &gatewayv2.PermissionRulesRequest{Action: "add", InputJson: `{"rule":"Bash(rm:*)","effect":"deny","scope":"project","workspace":"/w","session_id":"s1","extra":1}`}); err != nil {
		t.Fatal(err)
	}
	add := (*seen)[1]
	if add.method != http.MethodPost || add.uri != "/v1/permissions/rules" {
		t.Fatalf("add request = %+v", add)
	}
	want := map[string]any{"rule": "Bash(rm:*)", "effect": "deny", "scope": "project", "workspace": "/w"}
	if len(add.body) != len(want) {
		t.Fatalf("add body = %v, want only %v", add.body, want)
	}
	for key, value := range want {
		if add.body[key] != value {
			t.Fatalf("add body = %v, want %v", add.body, want)
		}
	}

	if _, err := relay.PermissionRules(context.Background(), &gatewayv2.PermissionRulesRequest{Action: "delete", InputJson: `{"id":"r 1/x","scope":"user"}`}); err != nil {
		t.Fatal(err)
	}
	if got := (*seen)[2]; got.method != http.MethodDelete || got.uri != "/v1/permissions/rules/r%201%2Fx?scope=user" {
		t.Fatalf("delete request = %+v", got)
	}
}

// Session rules and malformed requests never reach K-brain.
func TestPermissionRulesRelayRejectsBadInputLocally(t *testing.T) {
	relay, seen := permissionRulesRelay(t, http.StatusOK, `{}`)
	for _, req := range []*gatewayv2.PermissionRulesRequest{
		{Action: "add", InputJson: `{"rule":"Bash(rm:*)","effect":"deny","scope":"session"}`},
		{Action: "add", InputJson: `{"rule":"Bash(rm:*)","effect":"ask","scope":"user"}`},
		{Action: "add", InputJson: `{"rule":"  ","effect":"deny","scope":"user"}`},
		{Action: "add", InputJson: `{"rule":"Bash(rm:*)","effect":"deny","scope":"project"}`},
		{Action: "delete", InputJson: `{"scope":"user"}`},
		{Action: "delete", InputJson: `{"id":"r_1","scope":"session"}`},
		{Action: "rename", InputJson: `{}`},
	} {
		if _, err := relay.PermissionRules(context.Background(), req); err == nil {
			t.Fatalf("%s %s: expected rejection", req.GetAction(), req.GetInputJson())
		}
	}
	if len(*seen) != 0 {
		t.Fatalf("rejected requests reached K-brain: %+v", *seen)
	}
}

// K-brain explains a refused rule in {"error"}; the WebUI shows that text, not the JSON.
func TestPermissionRulesRelayKeepsKBrainErrorText(t *testing.T) {
	relay, _ := permissionRulesRelay(t, http.StatusBadRequest, `{"error":"permission rule \"Bash(\": missing closing parenthesis","version":"kbrain.agent.v1"}`)
	_, err := relay.PermissionRules(context.Background(), &gatewayv2.PermissionRulesRequest{Action: "add", InputJson: `{"rule":"Bash(","effect":"deny","scope":"user"}`})
	if err == nil || err.Error() != `permission rule "Bash(": missing closing parenthesis` {
		t.Fatalf("error = %v", err)
	}
}
