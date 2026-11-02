package kbrain

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestRelayHistorySyncSnapshotChangesAndCancellation(t *testing.T) {
	var changesCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case req.URL.Path == "/v1/health":
			fmt.Fprint(w, `{"status":"ok","version":"kbrain.agent.v1","capabilities":{"session_changes":2}}`)
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions/snapshots":
			fmt.Fprint(w, `{"epoch":"epoch","revision":"0","snapshot_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expires_in_seconds":60,"total_count":1,"workdirs":[{"cwd":"/one","count":1,"updated_at":"2026-10-28T00:00:00Z"}]}`)
		case req.Method == http.MethodGet && req.URL.Path == "/v1/sessions/snapshots/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":
			fmt.Fprint(w, `{"epoch":"epoch","revision":"0","snapshot_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","total_count":1,"sessions":[{"id":"one","title":"One","cwd":"/one","model":{"provider":"fixture","model":"model"},"created_at":"2026-10-28T00:00:00Z","updated_at":"2026-10-28T00:00:00Z","message_count":1}],"next_offset":null}`)
		case req.Method == http.MethodDelete && req.URL.Path == "/v1/sessions/snapshots/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":
			w.WriteHeader(http.StatusNoContent)
		case req.URL.Path == "/v1/sessions/changes":
			call := changesCalls.Add(1)
			if call == 1 {
				if req.URL.Query().Get("wait") != "0" || req.URL.Query().Get("since") != "0" {
					t.Errorf("changes query = %s", req.URL.RawQuery)
				}
				fmt.Fprint(w, `{"epoch":"epoch","head_revision":"0","min_since":"0","next_since":"0","reset":false,"more":false,"changes":[]}`)
				return
			}
			if call == 2 {
				if req.URL.Query().Get("rescan") != "1" || req.URL.Query().Get("wait") != "30" || req.URL.Query().Get("since") != "0" {
					t.Errorf("changes query = %s", req.URL.RawQuery)
				}
				fmt.Fprint(w, `{"epoch":"epoch","head_revision":"1","min_since":"0","next_since":"1","reset":false,"more":false,"changes":[{"id":"two","revision":"1","kind":"upsert","listed":true,"session":{"id":"two","title":"Two","cwd":"/two","model":{"provider":"fixture","model":"model"},"created_at":"2026-10-28T00:00:01Z","updated_at":"2026-10-28T00:00:01Z","message_count":1}}]}`)
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
	var snapshotCh = make(chan *gatewayv2.HistorySyncSnapshot, 1)
	var eventCh = make(chan *gatewayv2.HistorySyncEvent, 1)
	relay, err := NewRelay(client, "target", ModelRef{}, "")
	if err != nil {
		t.Fatal(err)
	}
	callbacks := Callbacks{
		OnHistorySnapshot: func(snapshot *gatewayv2.HistorySyncSnapshot) { snapshotCh <- snapshot },
		OnHistoryEvent:    func(event *gatewayv2.HistorySyncEvent) { eventCh <- event },
	}
	if err := relay.StartHistorySync(callbacks); err != nil {
		t.Fatal(err)
	}
	select {
	case snapshot := <-snapshotCh:
		if len(snapshot.GetConversations()) != 1 || snapshot.GetCutDeliverySeq() != 0 {
			t.Fatalf("snapshot = %#v", snapshot)
		}
	case <-time.After(time.Second):
		t.Fatal("snapshot not delivered")
	}
	select {
	case event := <-eventCh:
		if event.GetKind() != "upsert" || event.GetConversationId() != "two" || event.GetDeliverySeq() != 1 {
			t.Fatalf("event = %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("change not delivered")
	}

	deadline := time.Now().Add(time.Second)
	for changesCalls.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if changesCalls.Load() < 3 {
		t.Fatal("long poll was not started")
	}
	relay.Close()
	if err := relay.backendContext.Err(); err != context.Canceled {
		t.Fatalf("relay context = %v", err)
	}
}

func TestValidateHistoryChangesRejectsSkippedAndMalformedBatches(t *testing.T) {
	next := "3"
	validSession := &Session{ID: "one"}
	for name, input := range map[string]historyChanges{
		"next skips batch tail": {
			Epoch: "epoch", HeadRevision: "3", NextSince: &next,
			Changes: []historyChange{{ID: "one", Revision: "2", Kind: "upsert", Listed: true, Session: validSession}},
		},
		"unknown kind": {
			Epoch: "epoch", HeadRevision: "3", NextSince: &next,
			Changes: []historyChange{{ID: "one", Revision: "3", Kind: "unknown"}},
		},
		"summary identity mismatch": {
			Epoch: "epoch", HeadRevision: "3", NextSince: &next,
			Changes: []historyChange{{ID: "one", Revision: "3", Kind: "upsert", Listed: true, Session: &Session{ID: "other"}}},
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := validateHistoryChanges(input, "epoch", 1); err == nil {
				t.Fatal("malformed batch was accepted")
			}
		})
	}
}

func TestRelayHistorySyncRetriesTransientCapabilityFailure(t *testing.T) {
	var healthCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case req.URL.Path == "/v1/health":
			if healthCalls.Add(1) == 1 {
				w.WriteHeader(http.StatusServiceUnavailable)
				fmt.Fprint(w, `{}`)
				return
			}
			fmt.Fprint(w, `{"status":"ok","version":"kbrain.agent.v1","capabilities":{"session_changes":2}}`)
		case req.Method == http.MethodPost && req.URL.Path == "/v1/sessions/snapshots":
			fmt.Fprint(w, `{"epoch":"epoch","revision":"0","snapshot_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","expires_in_seconds":60,"total_count":0,"workdirs":[]}`)
		case req.Method == http.MethodGet && req.URL.Path == "/v1/sessions/snapshots/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":
			fmt.Fprint(w, `{"epoch":"epoch","revision":"0","snapshot_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","total_count":0,"sessions":[],"next_offset":null}`)
		case req.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case req.URL.Path == "/v1/sessions/changes":
			fmt.Fprint(w, `{"epoch":"epoch","head_revision":"0","min_since":"0","next_since":"0","reset":false,"more":false,"changes":[]}`)
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
	snapshots := make(chan *gatewayv2.HistorySyncSnapshot, 1)
	if err := relay.StartHistorySync(Callbacks{OnHistorySnapshot: func(value *gatewayv2.HistorySyncSnapshot) { snapshots <- value }}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-snapshots:
	case <-time.After(3 * time.Second):
		t.Fatal("history synchronization did not recover after transient health failure")
	}
	if healthCalls.Load() < 2 {
		t.Fatalf("health calls = %d", healthCalls.Load())
	}
}
