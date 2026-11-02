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

func TestTerminalRelayMapsCanonicalIdentityAndBinaryBuffer(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/terminal" || r.Header.Get("Authorization") != "Bearer secret" {
			t.Errorf("request=%s auth=%s", r.URL.Path, r.Header.Get("Authorization"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["conversation_id"] != "backend-session" || body["run_id"] != "backend-run" || body["action"] != "read" {
			t.Errorf("body=%v", body)
		}
		if _, ok := body["command"]; ok {
			t.Error("unexpected legacy command")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"conversation_id":"backend-session","run_id":"backend-run","action":"read","session":{"id":"term-1","pid":42,"running":true,"kind":"local"},"output":"AP9B","output_start_offset":7,"output_end_offset":10,"truncated":true}`))
	}))
	defer server.Close()
	client, _ := New(server.URL, "secret", server.Client())
	relay, _ := NewRelay(client, "target", ModelRef{}, "")
	relay.runs["gateway-run"] = &runState{conversationID: "gateway-conversation", kbrainSessionID: "backend-session", kbrainRunID: "backend-run"}
	request := &gatewayv2.TerminalRequest{Action: "read", ConversationId: "gateway-conversation", RunId: "gateway-run", SessionId: "term-1", MaxBytes: 3}
	response, err := relay.Terminal(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if string(response.Output) != string([]byte{0, 255, 65}) || response.OutputStartOffset != 7 || response.OutputEndOffset != 10 || !response.Truncated || response.Session.Pid != 42 {
		t.Fatalf("response=%+v", response)
	}
	if request.RunId != "gateway-run" {
		t.Fatal("mutated inbound request")
	}
	request.ConversationId = "other-conversation"
	if _, err := relay.Terminal(context.Background(), request); err == nil {
		t.Fatal("cross-conversation read allowed")
	}
	if calls != 1 {
		t.Fatalf("rejected request reached backend: %d", calls)
	}
}

func TestTerminalClientRejectsIdentityMismatchAndHTTPDenial(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"conversation_id":"wrong","run_id":"run","error":"denied"}`))
			}))
			defer server.Close()
			client, _ := New(server.URL, "", server.Client())
			if _, err := client.Terminal(context.Background(), &gatewayv2.TerminalRequest{Action: "read", ConversationId: "conversation", RunId: "run"}); err == nil {
				t.Fatal("invalid response accepted")
			}
		})
	}
}

func TestTerminalClientPreservesClosedAndPlainHTTPErrorBodies(t *testing.T) {
	for _, test := range []struct {
		name    string
		status  int
		body    string
		message string
	}{
		{name: "json error", status: http.StatusConflict, body: `{"error":"terminal run is no longer active"}`, message: "terminal run is no longer active"},
		{name: "plain error", status: http.StatusServiceUnavailable, body: "backend closed the terminal bridge", message: "backend closed the terminal bridge"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			client, _ := New(server.URL, "", server.Client())
			_, err := client.Terminal(context.Background(), &gatewayv2.TerminalRequest{Action: "read", ConversationId: "conversation", RunId: "run"})
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("error = %v, want message %q", err, test.message)
			}
		})
	}
}
