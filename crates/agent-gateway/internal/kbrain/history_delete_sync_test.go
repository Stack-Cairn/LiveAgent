package kbrain

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestRelayDeleteRetainsAliasUntilOrderedDeleteIsDelivered(t *testing.T) {
	deleted := make(chan struct{})
	release := make(chan struct{})
	var deleteOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case req.URL.Path == "/v1/health":
			fmt.Fprint(w, `{"capabilities":{"session_changes":2}}`)
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions/snapshots":
			fmt.Fprint(w, `{"epoch":"e","revision":"0","snapshot_id":"s","total_count":1}`)
		case req.Method == http.MethodGet && req.URL.Path == "/v1/sessions/snapshots/s":
			fmt.Fprint(w, `{"epoch":"e","revision":"0","snapshot_id":"s","total_count":1,"sessions":[{"id":"one","title":"One","model":{"provider":"p","model":"m"},"created_at":"2026-10-28T00:00:00Z","updated_at":"2026-10-28T00:00:00Z","message_count":1}],"next_offset":null}`)
		case req.Method == http.MethodDelete && req.URL.Path == "/v1/sessions/snapshots/s":
			w.WriteHeader(http.StatusNoContent)
		case req.Method == http.MethodDelete && req.URL.Path == "/v1/sessions/one":
			deleteOnce.Do(func() { close(deleted) })
			fmt.Fprint(w, `{"ok":true}`)
		case req.URL.Path == "/v1/sessions/changes" && req.URL.Query().Get("wait") == "0":
			fmt.Fprint(w, `{"epoch":"e","head_revision":"0","next_since":"0","reset":false,"more":false,"changes":[]}`)
		case req.URL.Path == "/v1/sessions/changes" && req.URL.Query().Get("since") == "0":
			select {
			case <-release:
				fmt.Fprint(w, `{"epoch":"e","head_revision":"1","next_since":"1","reset":false,"more":false,"changes":[{"id":"one","revision":"1","kind":"delete"}]}`)
			case <-req.Context().Done():
			}
		case req.URL.Path == "/v1/sessions/changes":
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
	relay.sessions["stable-alias"] = "one"
	snapshots := make(chan *gatewayv2.HistorySyncSnapshot, 1)
	events := make(chan *gatewayv2.HistorySyncEvent, 1)
	if err := relay.StartHistorySync(Callbacks{
		OnHistorySnapshot: func(value *gatewayv2.HistorySyncSnapshot) { snapshots <- value },
		OnHistoryEvent:    func(value *gatewayv2.HistorySyncEvent) { events <- value },
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-snapshots:
	case <-time.After(time.Second):
		t.Fatal("initial snapshot was not delivered")
	}
	if _, err := relay.HistoryDelete(context.Background(), &gatewayv2.HistoryDeleteRequest{ConversationId: "stable-alias"}); err != nil {
		t.Fatal(err)
	}
	<-deleted
	relay.mu.Lock()
	alias := relay.sessions["stable-alias"]
	relay.mu.Unlock()
	if alias != "one" {
		t.Fatal("delete discarded the alias before the ordered change could identify it")
	}
	close(release)
	select {
	case event := <-events:
		if event.GetKind() != "delete" || event.GetConversationId() != "stable-alias" || event.GetDeliverySeq() != 1 {
			t.Fatalf("ordered delete = %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("successful unary delete was never delivered through the history stream")
	}
	deadline := time.Now().Add(time.Second)
	for {
		relay.mu.Lock()
		_, retained := relay.sessions["stable-alias"]
		pending := len(relay.historyState.pendingDeletes)
		relay.mu.Unlock()
		if !retained && pending == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("delivered deletion retained its alias or pending entry")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestRelayHistoryDeleteBudgetInvalidatesAuthorityBeforeReleasingAliases(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		fmt.Fprint(w, `{"ok":true}`)
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
	var status *gatewayv2.HistorySyncStatus
	relay.historyState = &relayHistoryState{
		available: true, pendingDeletes: make(map[string]struct{}),
		callbacks: Callbacks{OnHistoryStatus: func(value *gatewayv2.HistorySyncStatus) { status = value }},
	}
	for i := 0; i < maxPendingHistoryDeletes; i++ {
		id := fmt.Sprintf("deleted-%d", i)
		relay.sessions[id] = id
		relay.historyState.pendingDeletes[id] = struct{}{}
	}
	relay.sessions["last"] = "last"
	if _, err := relay.HistoryDelete(context.Background(), &gatewayv2.HistoryDeleteRequest{ConversationId: "last"}); err != nil {
		t.Fatal(err)
	}
	if status == nil || status.GetAvailable() || !status.GetNeedsResync() {
		t.Fatalf("budget exhaustion did not invalidate authority: %#v", status)
	}
	if len(relay.sessions) != 0 || len(relay.historyState.pendingDeletes) != 0 || !relay.historyState.resetRequired {
		t.Fatal("budget exhaustion retained unbounded aliases or failed to request a snapshot")
	}
}

func TestRelayLegacyDeleteReleasesAliasAndSetCwdForwardsTheValue(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodPatch {
			var input map[string]any
			if err := json.NewDecoder(req.Body).Decode(&input); err != nil {
				t.Error(err)
			}
			if input["cwd"] != "/workspace" {
				t.Errorf("forwarded cwd = %#v", input["cwd"])
			}
			fmt.Fprint(w, `{"id":"one","cwd":"/workspace","model":{"provider":"p","model":"m"}}`)
			return
		}
		fmt.Fprint(w, `{"ok":true}`)
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
	relay.sessions["alias"] = "one"
	response, err := relay.HistorySetCwd(context.Background(), &gatewayv2.HistorySetCwdRequest{ConversationId: "alias", Cwd: " /workspace "})
	if err != nil || response.GetConversation().GetCwd() != "/workspace" {
		t.Fatalf("forwarded cwd response = %#v, %v", response, err)
	}
	if _, err := relay.HistoryDelete(context.Background(), &gatewayv2.HistoryDeleteRequest{ConversationId: "alias"}); err != nil {
		t.Fatal(err)
	}
	if _, retained := relay.sessions["alias"]; retained {
		t.Fatal("legacy mode retained a deletion alias without a change subscriber")
	}
}
