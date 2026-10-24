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

func TestCommandResourcesPreserveBackendOwnership(t *testing.T) {
	var methods []string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer command-token" {
			t.Error("missing backend authentication")
		}
		methods = append(methods, req.Method+" "+req.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch req.URL.Path {
		case "/v1/commands":
			if req.URL.Query().Get("workdir") != "/workspace/a b" {
				t.Errorf("workdir: %s", req.URL)
			}
			_, _ = w.Write([]byte(`{"commands":[{"name":"goal","kind":"action"},{"name":"custom","kind":"prompt","source":"user","argument_hint":"<file>"},{"name":"loop","kind":"action"}]}`))
		case "/v1/sessions/backend-session/loops":
			if req.Method == http.MethodPost {
				var input map[string]string
				if err := json.NewDecoder(req.Body).Decode(&input); err != nil || input["interval"] != "10m" || input["prompt"] != "inspect" || input["reasoning"] != "high" || input["workdir"] != "" {
					t.Errorf("create: %v %v", input, err)
				}
				w.WriteHeader(http.StatusCreated)
				_, _ = w.Write([]byte(`{"id":"loop-1","interval":"10m","prompt":"inspect","enabled":true}`))
			} else {
				_, _ = w.Write([]byte(`{"loops":[{"id":"loop-1","interval":"10m","prompt":"inspect","enabled":true}]}`))
			}
		case "/v1/sessions/backend-session/loops/loop-1":
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"session not found"}`))
		}
	}))
	defer backend.Close()
	client, err := New(backend.URL, "command-token", backend.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "kbrain", ModelRef{}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	relay.sessions["browser-alias"] = "backend-session"
	commands, err := relay.SlashCommands(context.Background(), &gatewayv2.SlashCommandListRequest{Workdir: "/workspace/a b"})
	if err != nil || len(commands.GetCommands()) != 2 || commands.Commands[0].ArgumentHint != "<file>" {
		t.Fatalf("commands=%v err=%v", commands, err)
	}
	for _, action := range []string{"create", "list", "cancel"} {
		out, err := relay.Loops(context.Background(), &gatewayv2.LoopManageRequest{ConversationId: "browser-alias", Action: action, Interval: "10m", Prompt: "inspect", Reasoning: "high", LoopId: "loop-1"})
		if err != nil {
			t.Fatal(err)
		}
		if action != "cancel" && (len(out.Loops) != 1 || out.Loops[0].Id != "loop-1" || !out.Loops[0].Enabled) {
			t.Fatalf("loops=%v", out)
		}
	}
	before := len(methods)
	if _, err := relay.Loops(context.Background(), &gatewayv2.LoopManageRequest{ConversationId: "unknown", Action: "create", Interval: "10m", Prompt: "inspect"}); err == nil || !strings.Contains(err.Error(), "session not found") {
		t.Fatalf("missing backend error: %v", err)
	}
	if len(methods) != before+1 || len(relay.sessions) != 1 {
		t.Fatalf("unknown session was created or mutation retried: %v", methods)
	}
	for _, request := range methods {
		if request == "POST /v1/sessions" {
			t.Fatal("resource request created a session")
		}
	}
}
