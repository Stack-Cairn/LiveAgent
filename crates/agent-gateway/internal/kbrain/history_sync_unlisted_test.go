package kbrain

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// K-brain keeps a new session unlisted until its first message is persisted.
// A WebUI-started run already maps its conversation to that session, so the
// unlisted change must not reach the browser as a delete of its pending row.
func TestRelayHistorySyncSkipsUnlistedChangesForNeverListedSessions(t *testing.T) {
	const sessionJSON = `{"id":"%s","title":"%s","cwd":"/one","model":{"provider":"fixture","model":"model"},"created_at":"2026-10-29T00:00:00Z","updated_at":"2026-10-29T00:00:01Z","message_count":%d}`
	batches := []string{
		// A never-listed new session, then an existing listed session being archived.
		`{"epoch":"epoch","head_revision":"2","min_since":"0","next_since":"2","reset":false,"more":false,"changes":[` +
			`{"id":"fresh","revision":"1","kind":"upsert","listed":false,"session":` + fmt.Sprintf(sessionJSON, "fresh", "", 0) + `},` +
			`{"id":"one","revision":"2","kind":"upsert","listed":false,"session":` + fmt.Sprintf(sessionJSON, "one", "One", 1) + `}]}`,
		// The first message is persisted and the new session becomes listed.
		`{"epoch":"epoch","head_revision":"3","min_since":"0","next_since":"3","reset":false,"more":false,"changes":[` +
			`{"id":"fresh","revision":"3","kind":"upsert","listed":true,"session":` + fmt.Sprintf(sessionJSON, "fresh", "First prompt", 1) + `}]}`,
	}
	var changesCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case req.URL.Path == "/v1/health":
			fmt.Fprint(w, `{"status":"ok","version":"kbrain.agent.v1","capabilities":{"session_changes":2}}`)
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions/snapshots":
			fmt.Fprint(w, `{"epoch":"epoch","revision":"0","snapshot_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expires_in_seconds":60,"total_count":1,"workdirs":[{"cwd":"/one","count":1,"updated_at":"2026-10-29T00:00:00Z"}]}`)
		case req.Method == http.MethodGet && req.URL.Path == "/v1/sessions/snapshots/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":
			fmt.Fprint(w, `{"epoch":"epoch","revision":"0","snapshot_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","total_count":1,"sessions":[`+fmt.Sprintf(sessionJSON, "one", "One", 1)+`],"next_offset":null}`)
		case req.Method == http.MethodDelete && req.URL.Path == "/v1/sessions/snapshots/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":
			w.WriteHeader(http.StatusNoContent)
		case req.URL.Path == "/v1/sessions/changes":
			call := int(changesCalls.Add(1))
			if call == 1 {
				fmt.Fprint(w, `{"epoch":"epoch","head_revision":"0","min_since":"0","next_since":"0","reset":false,"more":false,"changes":[]}`)
				return
			}
			if call-2 < len(batches) {
				fmt.Fprint(w, batches[call-2])
				return
			}
			<-req.Context().Done()
		default:
			http.NotFound(w, req)
		}
	}))
	defer server.Close()

	client, err := New(server.URL, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "target", ModelRef{}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	// What StartRun records for a conversation started from the WebUI.
	relay.mu.Lock()
	relay.sessions["browser-new"] = "fresh"
	relay.mu.Unlock()

	snapshotCh := make(chan *gatewayv2.HistorySyncSnapshot, 1)
	eventCh := make(chan *gatewayv2.HistorySyncEvent, 8)
	if err := relay.StartHistorySync(Callbacks{
		OnHistorySnapshot: func(snapshot *gatewayv2.HistorySyncSnapshot) { snapshotCh <- snapshot },
		OnHistoryEvent:    func(event *gatewayv2.HistorySyncEvent) { eventCh <- event },
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-snapshotCh:
	case <-time.After(time.Second):
		t.Fatal("snapshot not delivered")
	}

	var got []string
	deadline := time.After(2 * time.Second)
	for len(got) < 2 {
		select {
		case event := <-eventCh:
			got = append(got, event.GetKind()+":"+event.GetConversationId())
		case <-deadline:
			t.Fatalf("events = %v, want the archived delete and the new upsert", got)
		}
	}
	select {
	case event := <-eventCh:
		got = append(got, event.GetKind()+":"+event.GetConversationId())
	case <-time.After(100 * time.Millisecond):
	}
	want := []string{"delete:one", "upsert:browser-new"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
}
