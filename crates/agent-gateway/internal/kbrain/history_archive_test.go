package kbrain

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

type archiveFixture struct {
	capability string
	listQuery  string
	patchPath  string
	patchBody  map[string]any
	archived   bool
}

func newArchiveRelay(t *testing.T, fixture *archiveFixture) *Relay {
	t.Helper()
	updated := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/health":
			fmt.Fprintf(w, `{"status":"ok","version":"kbrain.agent.v1","capabilities":{%s}}`, fixture.capability)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/sessions":
			fixture.listQuery = r.URL.RawQuery
			_ = json.NewEncoder(w).Encode(SessionPage{Sessions: []Session{
				{ID: "sess-a", Title: "Old work", CWD: "/w", UpdatedAt: updated, Archived: true},
			}, TotalCount: 1})
		case r.Method == http.MethodPatch:
			fixture.patchPath = r.URL.Path
			body, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(body, &fixture.patchBody)
			archived, _ := fixture.patchBody["archived"].(bool)
			if fixture.archived {
				archived = !archived // simulate a backend that ignores the field
			}
			_ = json.NewEncoder(w).Encode(Session{ID: "sess-a", Archived: archived})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "kbrain", ModelRef{}, "")
	if err != nil {
		t.Fatal(err)
	}
	return relay
}

func manage(t *testing.T, relay *Relay, command, args string) (map[string]any, error) {
	t.Helper()
	response, err := relay.MemoryManage(context.Background(), &gatewayv2.MemoryManageRequest{Command: command, ArgsJson: args})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(response.GetResultJson()), &out); err != nil {
		t.Fatalf("result %q: %v", response.GetResultJson(), err)
	}
	return out, nil
}

func TestHistoryArchiveSupportedFollowsCapability(t *testing.T) {
	for _, tc := range []struct {
		capability string
		want       bool
	}{
		{`"session_archive":1`, true},
		{`"session_changes":2`, false},
	} {
		relay := newArchiveRelay(t, &archiveFixture{capability: tc.capability})
		out, err := manage(t, relay, historyArchiveSupportedCommand, "")
		if err != nil {
			t.Fatal(err)
		}
		if out["supported"] != tc.want {
			t.Fatalf("capabilities {%s}: supported=%v, want %v", tc.capability, out["supported"], tc.want)
		}
	}
}

func TestHistoryArchivedListAsksOnlyForArchivedSessions(t *testing.T) {
	fixture := &archiveFixture{capability: `"session_archive":1`}
	relay := newArchiveRelay(t, fixture)
	out, err := manage(t, relay, historyArchivedListCommand, `{"page":2,"page_size":30}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(fixture.listQuery, "archived=only") || !strings.Contains(fixture.listQuery, "page=2") {
		t.Fatalf("list query=%q", fixture.listQuery)
	}
	conversations, _ := out["conversations"].([]any)
	if len(conversations) != 1 || out["total_count"] != float64(1) {
		t.Fatalf("result=%v", out)
	}
	first := conversations[0].(map[string]any)
	if first["id"] != "sess-a" || first["title"] != "Old work" || first["is_archived"] != true || first["updated_at"] == float64(0) {
		t.Fatalf("summary=%v", first)
	}
}

func TestHistoryArchiveSetPatchesTheSession(t *testing.T) {
	fixture := &archiveFixture{capability: `"session_archive":1`}
	relay := newArchiveRelay(t, fixture)
	if _, err := manage(t, relay, historyArchiveSetCommand, `{"conversation_id":"sess-a","archived":true}`); err != nil {
		t.Fatal(err)
	}
	if fixture.patchPath != "/v1/sessions/sess-a" || fixture.patchBody["archived"] != true {
		t.Fatalf("patch %s %v", fixture.patchPath, fixture.patchBody)
	}
	if _, err := manage(t, relay, historyArchiveSetCommand, `{"conversation_id":"sess-a","archived":false}`); err != nil {
		t.Fatal(err)
	}
	if fixture.patchBody["archived"] != false {
		t.Fatalf("unarchive body %v", fixture.patchBody)
	}
	if _, err := manage(t, relay, historyArchiveSetCommand, `{"conversation_id":"sess-a"}`); err == nil {
		t.Fatal("missing archived flag was accepted")
	}
}

func TestHistoryArchiveRejectsBackendsWithoutArchive(t *testing.T) {
	fixture := &archiveFixture{capability: `"session_changes":2`}
	relay := newArchiveRelay(t, fixture)
	if _, err := manage(t, relay, historyArchiveSetCommand, `{"conversation_id":"sess-a","archived":true}`); err == nil {
		t.Fatal("archive without session_archive was sent")
	}
	if fixture.patchPath != "" {
		t.Fatalf("unexpected PATCH %s", fixture.patchPath)
	}
	if _, err := manage(t, relay, historyArchivedListCommand, `{}`); err == nil {
		t.Fatal("archived list without session_archive was sent")
	}
	// A backend that advertises archive but ignores the field is reported, not trusted.
	ignoring := &archiveFixture{capability: `"session_archive":1`, archived: true}
	if _, err := manage(t, newArchiveRelay(t, ignoring), historyArchiveSetCommand, `{"conversation_id":"sess-a","archived":true}`); err == nil {
		t.Fatal("ignored archive change was reported as applied")
	}
}
