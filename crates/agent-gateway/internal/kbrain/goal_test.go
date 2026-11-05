package kbrain

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestGoalManageProxiesGoalBarActionsToTheBackendSession(t *testing.T) {
	var requests []string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer goal-token" {
			t.Error("missing backend authentication")
		}
		if req.URL.Path != "/v1/sessions/backend-session/goal" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"session not found"}`))
			return
		}
		body := map[string]string{}
		if req.Method == http.MethodPost {
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				t.Errorf("decode: %v", err)
			}
		}
		requests = append(requests, req.Method+" "+body["action"]+" "+body["goal"])
		status, goal := "paused", "write the changelog"
		switch body["action"] {
		case "clear":
			status, goal = "cleared", ""
		case "update":
			goal = body["goal"]
		case "":
			status = "active"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version": "kbrain.agent.v1", "conversation_id": "backend-session", "goal": goal, "status": status,
			"round": 2, "max_rounds": 20, "reason": "", "started_at": "2026-11-05T10:00:00Z",
		})
	}))
	defer backend.Close()
	client, err := New(backend.URL, "goal-token", backend.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "kbrain", ModelRef{}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	relay.sessions["browser-alias"] = "backend-session"

	got, err := relay.GoalManage(context.Background(), &gatewayv2.GoalManageRequest{ConversationId: "browser-alias", Action: "get"})
	if err != nil {
		t.Fatal(err)
	}
	if got.ConversationId != "browser-alias" || got.Status != "active" || got.Round != 2 || got.MaxRounds != 20 || got.StartedAt != "2026-11-05T10:00:00Z" {
		t.Fatalf("get = %+v", got)
	}
	if paused, err := relay.GoalManage(context.Background(), &gatewayv2.GoalManageRequest{ConversationId: "browser-alias", Action: "pause"}); err != nil || paused.Status != "paused" {
		t.Fatalf("pause = %+v, %v", paused, err)
	}
	if updated, err := relay.GoalManage(context.Background(), &gatewayv2.GoalManageRequest{ConversationId: "browser-alias", Action: "update", Goal: " draft the notes "}); err != nil || updated.Goal != "draft the notes" {
		t.Fatalf("update = %+v, %v", updated, err)
	}
	if cleared, err := relay.GoalManage(context.Background(), &gatewayv2.GoalManageRequest{ConversationId: "browser-alias", Action: "clear"}); err != nil || cleared.Status != "cleared" {
		t.Fatalf("clear = %+v, %v", cleared, err)
	}
	want := []string{"GET  ", "POST pause ", "POST update draft the notes", "POST clear "}
	if strings.Join(requests, "|") != strings.Join(want, "|") {
		t.Fatalf("requests = %q, want %q", requests, want)
	}

	before := len(requests)
	for _, req := range []*gatewayv2.GoalManageRequest{
		{ConversationId: "browser-alias", Action: "set", Goal: "x"},
		{ConversationId: "browser-alias", Action: "resume"},
		{ConversationId: "browser-alias", Action: "update"},
		{Action: "get"},
	} {
		if _, err := relay.GoalManage(context.Background(), req); err == nil {
			t.Fatalf("GoalManage(%+v) accepted", req)
		}
	}
	if len(requests) != before {
		t.Fatalf("rejected actions reached the backend: %v", requests[before:])
	}
	if _, err := relay.GoalManage(context.Background(), &gatewayv2.GoalManageRequest{ConversationId: "unknown", Action: "get"}); err == nil || !strings.Contains(err.Error(), "session not found") {
		t.Fatalf("missing session error = %v", err)
	}
	if len(relay.sessions) != 1 {
		t.Fatalf("goal action created a session mapping: %v", relay.sessions)
	}
}
