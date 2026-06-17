package websocket_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

func newGitWebSocketTest(
	t *testing.T,
	webGitEnabled bool,
) (*session.Manager, *session.AgentSession, *websocket.Conn, func()) {
	t.Helper()

	sm := session.NewManager()
	webGitSetting := "false"
	if webGitEnabled {
		webGitSetting = "true"
	}
	sm.ApplySettingsJSON(`{"remote":{"enableWebGit":` + webGitSetting + `}}`)
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := server.NewWebSocketServer(&config.Config{
		Token:          "ws-token",
		RequestTimeout: time.Second,
	}, sm)
	conn, cleanup := dialGatewayWebSocket(t, handler)
	authWebSocket(t, conn, "ws-token")
	return sm, agentSession, conn, cleanup
}

func TestWebSocketGitRejectsWriteRequestsWhenDisabled(t *testing.T) {
	t.Parallel()

	_, _, conn, cleanup := newGitWebSocketTest(t, false)
	defer cleanup()

	cases := []struct {
		id      string
		reqType string
		args    map[string]any
	}{
		{
			id:      "git-stage-disabled",
			reqType: "git.stage",
			args: map[string]any{
				"path": "src/main.rs",
			},
		},
		{
			id:      "git-init-disabled",
			reqType: "git.init",
			args: map[string]any{
				"branch": "main",
			},
		},
		{id: "git-stage-all-disabled", reqType: "git.stage_all"},
		{id: "git-unstage-all-disabled", reqType: "git.unstage_all"},
		{id: "git-discard-all-disabled", reqType: "git.discard_all"},
	}
	for _, tc := range cases {
		sendEnvelope(t, conn, tc.id, tc.reqType, map[string]any{
			"workdir": "/workspace/project",
			"args":    tc.args,
		})

		env := receiveEnvelope(t, conn)
		if env.ID != tc.id || env.Type != "error" {
			t.Fatalf("%s disabled response = %#v, want error", tc.reqType, env)
		}
		if !strings.Contains(env.Error, "web git is disabled") {
			t.Fatalf("%s disabled error = %q", tc.reqType, env.Error)
		}
	}
}

func TestWebSocketGitAllowsReadRequestsWhenDisabled(t *testing.T) {
	t.Parallel()

	sm, agentSession, conn, cleanup := newGitWebSocketTest(t, false)
	defer cleanup()

	sendEnvelope(t, conn, "git-status-read", "git.status", map[string]any{
		"workdir": " /workspace/project ",
	})
	outbound := readOutboundEnvelope(t, agentSession)
	req := outbound.GetGitRequest()
	if req == nil {
		t.Fatalf("git.status outbound payload = %T, want GitRequest", outbound.GetPayload())
	}
	if req.GetAction() != "status" || req.GetWorkdir() != "/workspace/project" || req.GetArgsJson() != "{}" {
		t.Fatalf("git status request = %#v", req)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_GitResponse{
			GitResponse: &gatewayv1.GitResponse{
				Action:     "status",
				ResultJson: `{"status":"ready","repoRoot":"/workspace/project"}`,
			},
		},
	})
	resp := receiveEnvelopeWithID(t, conn, "git-status-read")
	if resp.Type != "response" {
		t.Fatalf("git status response = %#v, want response", resp)
	}
	var payload map[string]any
	if err := json.Unmarshal(resp.Payload, &payload); err != nil {
		t.Fatalf("decode git status response: %v", err)
	}
	if payload["status"] != "ready" || payload["repoRoot"] != "/workspace/project" {
		t.Fatalf("git status payload = %#v", payload)
	}

	readCases := []struct {
		id      string
		reqType string
		action  string
		args    map[string]any
		result  string
	}{
		{
			id:      "git-commit-details-read",
			reqType: "git.commit_details",
			action:  "commit_details",
			args: map[string]any{
				"commit": "abc1234",
			},
			result: `{"commit":{"sha":"abc1234","shortSha":"abc1234","subject":"subject"}}`,
		},
		{
			id:      "git-compare-remote-read",
			reqType: "git.compare_commit_with_remote",
			action:  "compare_commit_with_remote",
			args: map[string]any{
				"commit": "def5678",
			},
			result: `{"baseRef":"origin/main","headRef":"def5678","patch":""}`,
		},
	}
	for _, tc := range readCases {
		sendEnvelope(t, conn, tc.id, tc.reqType, map[string]any{
			"workdir": " /workspace/project ",
			"args":    tc.args,
		})
		outbound := readOutboundEnvelope(t, agentSession)
		req := outbound.GetGitRequest()
		if req == nil {
			t.Fatalf("%s outbound payload = %T, want GitRequest", tc.reqType, outbound.GetPayload())
		}
		if req.GetAction() != tc.action || req.GetWorkdir() != "/workspace/project" {
			t.Fatalf("%s request = %#v", tc.reqType, req)
		}
		var args map[string]any
		if err := json.Unmarshal([]byte(req.GetArgsJson()), &args); err != nil {
			t.Fatalf("decode %s args: %v", tc.reqType, err)
		}
		if args["commit"] != tc.args["commit"] {
			t.Fatalf("%s args = %#v", tc.reqType, args)
		}
		sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
			RequestId: outbound.GetRequestId(),
			Timestamp: time.Now().Unix(),
			Payload: &gatewayv1.AgentEnvelope_GitResponse{
				GitResponse: &gatewayv1.GitResponse{
					Action:     tc.action,
					ResultJson: tc.result,
				},
			},
		})
		resp := receiveEnvelopeWithID(t, conn, tc.id)
		if resp.Type != "response" {
			t.Fatalf("%s response = %#v, want response", tc.reqType, resp)
		}
	}
}

func TestWebSocketGitForwardsWriteRequestsWhenEnabled(t *testing.T) {
	t.Parallel()

	sm, agentSession, conn, cleanup := newGitWebSocketTest(t, true)
	defer cleanup()

	sendEnvelope(t, conn, "git-create-enabled", "git.create_branch", map[string]any{
		"workdir": " /workspace/project ",
		"args": map[string]any{
			"branch":     "feature/git-review",
			"startPoint": "abc1234",
		},
	})
	outbound := readOutboundEnvelope(t, agentSession)
	req := outbound.GetGitRequest()
	if req == nil {
		t.Fatalf("git.create_branch outbound payload = %T, want GitRequest", outbound.GetPayload())
	}
	if req.GetAction() != "create_branch" || req.GetWorkdir() != "/workspace/project" {
		t.Fatalf("git create_branch request = %#v", req)
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(req.GetArgsJson()), &args); err != nil {
		t.Fatalf("decode git args: %v", err)
	}
	if args["branch"] != "feature/git-review" {
		t.Fatalf("git create_branch args = %#v", args)
	}
	if args["startPoint"] != "abc1234" {
		t.Fatalf("git create_branch args = %#v", args)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_GitResponse{
			GitResponse: &gatewayv1.GitResponse{
				Action:     "create_branch",
				ResultJson: `{"ok":true,"message":"created"}`,
			},
		},
	})
	resp := receiveEnvelopeWithID(t, conn, "git-create-enabled")
	if resp.Type != "response" {
		t.Fatalf("git create response = %#v, want response", resp)
	}
}
