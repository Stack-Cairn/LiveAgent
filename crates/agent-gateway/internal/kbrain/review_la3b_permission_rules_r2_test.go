package kbrain

import (
	"context"
	"net/http"
	"strings"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// LA-3b review, round 2: effect/scope are trimmed like the desktop bridge does, so the
// same input gets the same answer on both arms.
func TestReviewLA3bR2PermissionRulesRelayTrimsEffectAndScope(t *testing.T) {
	relay, seen := permissionRulesRelay(t, http.StatusCreated, `{"id":"r_1"}`)
	if _, err := relay.PermissionRules(context.Background(), &gatewayv2.PermissionRulesRequest{
		Action:    "add",
		InputJson: `{"rule":" Bash(rm:*) ","effect":" deny ","scope":" project ","workspace":" /w "}`,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := relay.PermissionRules(context.Background(), &gatewayv2.PermissionRulesRequest{
		Action:    "delete",
		InputJson: `{"id":" r_1 ","scope":" user "}`,
	}); err != nil {
		t.Fatal(err)
	}
	got := *seen
	if len(got) != 2 {
		t.Fatalf("seen %v", got)
	}
	want := map[string]any{"rule": "Bash(rm:*)", "effect": "deny", "scope": "project", "workspace": "/w"}
	for key, value := range want {
		if got[0].body[key] != value {
			t.Fatalf("add body %v, want %v", got[0].body, want)
		}
	}
	if len(got[0].body) != len(want) {
		t.Fatalf("add body %v has extra fields", got[0].body)
	}
	if got[1].method != http.MethodDelete || got[1].uri != "/v1/permissions/rules/r_1?scope=user" {
		t.Fatalf("delete = %s %s", got[1].method, got[1].uri)
	}
}

// Exactly 4 MiB of JSON still passes; one byte more is reported as too large, whether
// K-brain answered 200 or an error.
func TestReviewLA3bR2PermissionRulesRelayAnswerLimit(t *testing.T) {
	const limit = 4 << 20
	fill := func(size int) string {
		prefix, suffix := `{"rules":[],"pad":"`, `"}`
		return prefix + strings.Repeat("x", size-len(prefix)-len(suffix)) + suffix
	}
	list := &gatewayv2.PermissionRulesRequest{Action: "list"}

	relay, _ := permissionRulesRelay(t, http.StatusOK, fill(limit))
	response, err := relay.PermissionRules(context.Background(), list)
	if err != nil || len(response.GetResultJson()) != limit {
		t.Fatalf("4 MiB answer: len=%d err=%v", len(response.GetResultJson()), err)
	}
	for _, status := range []int{http.StatusOK, http.StatusBadRequest} {
		relay, _ := permissionRulesRelay(t, status, fill(limit+1))
		if _, err := relay.PermissionRules(context.Background(), list); err == nil || !strings.Contains(err.Error(), "too large") {
			t.Fatalf("status %d, 4 MiB + 1: err=%v", status, err)
		}
	}
}
