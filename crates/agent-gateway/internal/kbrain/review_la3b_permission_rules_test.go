package kbrain

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// LA-3b review: workspace and id reach K-brain exactly as typed, read the way K-brain's
// permissionRules handler reads them (r.URL.Query(), TrimPrefix + PathUnescape on the
// already-decoded r.URL.Path). Covers space (QueryEscape writes "+"), literal "+", "%",
// "#", "?", "&" and CJK.
func TestReviewLA3bPermissionRulesRelayEncodingMatchesKBrainDecoding(t *testing.T) {
	type got struct{ workspace, scope, id string }
	var seen []got
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		entry := got{workspace: strings.TrimSpace(query.Get("workspace")), scope: query.Get("scope")}
		if rest := strings.TrimPrefix(r.URL.Path, "/v1/permissions/rules"); strings.HasPrefix(rest, "/") {
			id, err := url.PathUnescape(strings.TrimPrefix(rest, "/"))
			if err != nil {
				id = "<invalid: " + err.Error() + ">"
			}
			entry.id = id
		}
		seen = append(seen, entry)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"rules":[]}`))
	}))
	defer server.Close()
	client, err := New(server.URL, "t", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "target", ModelRef{}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()

	workspace := `D:\项目\a b+c%20#?&x=1`
	for _, req := range []*gatewayv2.PermissionRulesRequest{
		{Action: "list", InputJson: `{"workspace":` + quote(workspace) + `}`},
		{Action: "delete", InputJson: `{"id":"r_Ab-9","scope":"project","workspace":` + quote(workspace) + `}`},
	} {
		if _, err := relay.PermissionRules(context.Background(), req); err != nil {
			t.Fatalf("%s: %v", req.GetAction(), err)
		}
	}
	want := []got{{workspace: workspace}, {workspace: workspace, scope: "project", id: "r_Ab-9"}}
	if len(seen) != len(want) {
		t.Fatalf("seen %v", seen)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Fatalf("request %d: K-brain read %+v, want %+v", i, seen[i], want[i])
		}
	}
}

func quote(value string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + `"`
}
