package kbrain

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"
)

func TestHistoryWorkdirsAggregatesAllSessionPages(t *testing.T) {
	firstUpdated := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	secondUpdated := firstUpdated.Add(2 * time.Minute)
	var requests []url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.Query())
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		w.Header().Set("Content-Type", "application/json")
		switch page {
		case 1:
			_ = json.NewEncoder(w).Encode(SessionPage{Sessions: []Session{
				{ID: "one", CWD: " /workspace/a ", UpdatedAt: firstUpdated},
				{ID: "two", CWD: "/workspace/a", UpdatedAt: secondUpdated},
				{ID: "empty", CWD: "", UpdatedAt: secondUpdated},
			}, TotalCount: 401})
		case 2:
			_ = json.NewEncoder(w).Encode(SessionPage{Sessions: []Session{
				{ID: "three", CWD: "/workspace/b", CreatedAt: firstUpdated},
			}, TotalCount: 401})
		case 3:
			_ = json.NewEncoder(w).Encode(SessionPage{Sessions: nil, TotalCount: 401})
		default:
			t.Fatalf("unexpected page %d", page)
		}
	}))
	defer server.Close()

	client, err := New(server.URL, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "kbrain", ModelRef{}, "")
	if err != nil {
		t.Fatal(err)
	}
	response, err := relay.HistoryWorkdirs(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(requests) != 3 {
		t.Fatalf("ListSessions requests=%d, want 3", len(requests))
	}
	for index, query := range requests {
		if got := query.Get("page"); got != strconv.Itoa(index+1) {
			t.Errorf("request %d page=%q, want %d", index+1, got, index+1)
		}
		if got := query.Get("page_size"); got != "200" {
			t.Errorf("request %d page_size=%q, want 200", index+1, got)
		}
		if got := query.Get("cwd"); got != "" || query.Get("cwd_empty") != "" {
			t.Errorf("request %d unexpectedly filtered: %v", index+1, query)
		}
	}
	if len(response.GetWorkdirs()) != 2 {
		t.Fatalf("workdirs=%#v, want two paths", response.GetWorkdirs())
	}
	if got := response.GetWorkdirs()[0]; got.GetPath() != "/workspace/a" || got.GetConversationCount() != 2 || got.GetUpdatedAt() != secondUpdated.UnixMilli() {
		t.Fatalf("first workdir=%#v", got)
	}
	if got := response.GetWorkdirs()[1]; got.GetPath() != "/workspace/b" || got.GetConversationCount() != 1 || got.GetUpdatedAt() != firstUpdated.UnixMilli() {
		t.Fatalf("second workdir=%#v", got)
	}
}
