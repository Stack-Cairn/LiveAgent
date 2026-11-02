package kbrain

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPromptRequestUsesCanonicalWireShape(t *testing.T) {
	data, err := json.Marshal(PromptRequest{
		ConversationID:  "backend-session",
		ClientRequestID: "request-1",
		Prompt:          "hello",
		Model:           &ModelRef{Provider: "custom-provider", Model: "model-1"},
		Options: &RunOptions{
			Mode: "agent", Search: "enabled", ApprovalPolicy: "auto",
			WorkspaceRoots: []WorkspaceRoot{{Path: "/workspace", Access: "write"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	if _, ok := wire["cwd"]; ok {
		t.Fatalf("prompt request unexpectedly contains cwd: %s", data)
	}
	if got := wire["conversation_id"]; got != "backend-session" {
		t.Fatalf("conversation_id=%v", got)
	}
	model, ok := wire["model"].(map[string]any)
	if !ok || model["provider"] != "custom-provider" {
		t.Fatalf("model=%v", wire["model"])
	}
}

func TestClientCronManageRoutesSnapshotCancelAndRunHydration(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.RequestURI())
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/cron":
			if r.Method == http.MethodGet {
				_, _ = w.Write([]byte(`{"revision":3,"tasks":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"status":"ok","cron":{"revision":4,"tasks":[]}}`))
		case "/v1/hooks":
			_, _ = w.Write([]byte(`{"revision":2,"hooks":[]}`))
		case "/v1/cron/task/1/runs":
			_, _ = w.Write([]byte(`{"runs":[{"id":"run-1","taskId":"task/1","state":"leased","startedAt":1}]}`))
		case "/v1/cron/task/1/cancel", "/v1/cron/task/1/runs/execution/1/cancel":
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	client, err := New(srv.URL, "token", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.CronManage(context.Background(), "snapshot", "", "")
	if err != nil {
		t.Fatal(err)
	}
	var snapshot map[string]json.RawMessage
	if err := json.Unmarshal(result, &snapshot); err != nil {
		t.Fatal(err)
	}
	if string(snapshot["cron"]) != `{"revision":3,"tasks":[]}` || string(snapshot["hooks"]) != `{"revision":2,"hooks":[]}` {
		t.Fatalf("snapshot=%s", result)
	}
	runs, err := client.CronManage(context.Background(), "list_runs", "task/1", `{"limit":500}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(runs), `"state":"leased"`) {
		t.Fatalf("runs=%s", runs)
	}
	if _, err := client.CronManage(context.Background(), "cancel_run", "task/1", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := client.CronManage(context.Background(), "cancel_run", "task/1", `{"executionId":"execution/1"}`); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(paths, "\n"), "POST /v1/cron/task%2F1/runs/execution%2F1/cancel") {
		t.Fatalf("exact cancel paths=%v", paths)
	}
	if !strings.Contains(strings.Join(paths, "\n"), "GET /v1/cron/task%2F1/runs?limit=500") || !strings.Contains(strings.Join(paths, "\n"), "POST /v1/cron/task%2F1/cancel") {
		t.Fatalf("paths=%v", paths)
	}
}

func TestClientUsesCanonicalSessionRunAndSSEReplay(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.RequestURI())
		if r.URL.Path == "/v1/sessions" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","id":"session-1"}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/runs") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","conversation_id":"session-1","run_id":"run-1","accepted_seq":2}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/events") {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("data: {\"version\":\"kbrain.agent.v1\",\"seq\":2,\"conversation_id\":\"session-1\",\"run_id\":\"run-1\",\"type\":\"run.accepted\"}\n\n"))
			_, _ = w.Write([]byte("data: {\"version\":\"kbrain.agent.v1\",\"seq\":3,\"conversation_id\":\"session-1\",\"run_id\":\"run-1\",\"type\":\"assistant.text.delta\",\"payload\":{\"text\":\"ok\"}}\n\n"))
			_, _ = w.Write([]byte("data: {\"version\":\"kbrain.agent.v1\",\"seq\":4,\"conversation_id\":\"session-1\",\"run_id\":\"run-1\",\"type\":\"run.completed\"}\n\n"))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	client, err := New(srv.URL, "token", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	sessionID, err := client.CreateSession(context.Background(), "/workspace", ModelRef{Provider: "fixture", Model: "fixture-model"})
	if err != nil || sessionID != "session-1" {
		t.Fatalf("session=%q err=%v", sessionID, err)
	}
	accepted, status, err := client.StartRun(context.Background(), sessionID, PromptRequest{ConversationID: sessionID, ClientRequestID: "client-1", Prompt: "hello"})
	if err != nil || status != http.StatusOK || accepted.RunID != "run-1" {
		t.Fatalf("accepted=%+v status=%d err=%v", accepted, status, err)
	}
	var events []Event
	if err := client.Events(context.Background(), sessionID, accepted.AcceptedSeq-1, func(event Event) error { events = append(events, event); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[0].Type != "run.accepted" || events[1].Seq != 3 || events[2].Type != "run.completed" {
		t.Fatalf("events=%+v", events)
	}
	if !strings.Contains(strings.Join(paths, "\n"), "after_seq=1") {
		t.Fatalf("paths=%v", paths)
	}
}
