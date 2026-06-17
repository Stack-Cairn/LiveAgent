package websocket_test

import (
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

func receiveNoTerminalEnvelope(t *testing.T, _ *websocket.Conn) {
	t.Helper()
	time.Sleep(150 * time.Millisecond)
}

func assertNoTerminalEnvelopeAtEnd(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(150 * time.Millisecond)); err != nil {
		t.Fatalf("set websocket short deadline: %v", err)
	}
	var env wsEnvelope
	err := conn.ReadJSON(&env)
	if err == nil {
		t.Fatalf("unexpected websocket envelope = %#v", env)
	}
	var netErr net.Error
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("receive websocket envelope returned %v, want timeout", err)
	}
}

func assertTerminalEventKind(t *testing.T, env wsEnvelope, wantKind string) {
	t.Helper()
	if env.Type != "terminal.event" {
		t.Fatalf("terminal event = %#v, want terminal.event", env)
	}
	var payload struct {
		Kind string `json:"kind"`
		Data string `json:"data"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		t.Fatalf("decode terminal event payload: %v", err)
	}
	if payload.Kind != wantKind {
		t.Fatalf("terminal event kind = %q data = %q, want %q", payload.Kind, payload.Data, wantKind)
	}
}

func newTerminalWebSocketTest(
	t *testing.T,
	webTerminalEnabled bool,
) (*session.Manager, *session.AgentSession, *websocket.Conn, func()) {
	t.Helper()
	return newTerminalWebSocketTestWithPermissions(t, webTerminalEnabled, false)
}

func newTerminalWebSocketTestWithPermissions(
	t *testing.T,
	webTerminalEnabled bool,
	webSshTerminalEnabled bool,
) (*session.Manager, *session.AgentSession, *websocket.Conn, func()) {
	t.Helper()

	sm := session.NewManager()
	webTerminalSetting := "false"
	if webTerminalEnabled {
		webTerminalSetting = "true"
	}
	webSshTerminalSetting := "false"
	if webSshTerminalEnabled {
		webSshTerminalSetting = "true"
	}
	sm.ApplySettingsJSON(`{"remote":{"enableWebTerminal":` + webTerminalSetting + `,"enableWebSshTerminal":` + webSshTerminalSetting + `}}`)
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

func TestWebSocketSshTerminalPermissionIsIndependentFromLocalTerminal(t *testing.T) {
	t.Parallel()

	sm, agentSession, conn, cleanup := newTerminalWebSocketTestWithPermissions(t, false, true)
	defer cleanup()

	sendEnvelope(t, conn, "terminal-create-local-disabled", "terminal.create", map[string]any{
		"cwd":              "/workspace/project",
		"project_path_key": "/workspace/project",
	})
	localResponse := receiveEnvelope(t, conn)
	if localResponse.ID != "terminal-create-local-disabled" || localResponse.Type != "error" {
		t.Fatalf("local terminal disabled response = %#v, want error", localResponse)
	}
	if !strings.Contains(localResponse.Error, "web terminal is disabled") {
		t.Fatalf("local terminal disabled error = %q", localResponse.Error)
	}

	sendEnvelope(t, conn, "terminal-create-ssh-enabled", "terminal.create_ssh", map[string]any{
		"cwd":              " /workspace/project ",
		"project_path_key": " /workspace/project ",
		"ssh_host_id":      " prod ",
		"title":            " Prod SSH ",
		"cols":             120,
		"rows":             32,
	})
	outbound := readOutboundEnvelope(t, agentSession)
	req := outbound.GetTerminalRequest()
	if req == nil {
		t.Fatalf("terminal.create_ssh outbound payload = %T, want TerminalRequest", outbound.GetPayload())
	}
	if req.GetAction() != "create_ssh" ||
		req.GetCwd() != "/workspace/project" ||
		req.GetProjectPathKey() != "/workspace/project" ||
		req.GetSshHostId() != "prod" ||
		req.GetTitle() != "Prod SSH" ||
		req.GetCols() != 120 ||
		req.GetRows() != 32 {
		t.Fatalf("terminal create_ssh request = %#v", req)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalResponse{
			TerminalResponse: &gatewayv1.TerminalResponse{
				Action: "create_ssh",
				Session: &gatewayv1.TerminalSession{
					Id:             "ssh-1",
					ProjectPathKey: "/workspace/project",
					Cwd:            "/workspace/project",
					Shell:          "ssh",
					Title:          "Prod SSH",
					Kind:           "ssh",
					Cols:           120,
					Rows:           32,
					CreatedAt:      1,
					UpdatedAt:      2,
					Running:        true,
					Ssh: &gatewayv1.TerminalSshMetadata{
						HostId:   "prod",
						HostName: "Production",
						Username: "deploy",
						Host:     "prod.example.com",
						Port:     22,
						AuthType: "privateKey",
					},
				},
			},
		},
	})
	createResponse := receiveEnvelopeWithID(t, conn, "terminal-create-ssh-enabled")
	if createResponse.Type != "response" {
		t.Fatalf("terminal create_ssh response = %#v, want response", createResponse)
	}
	var createPayload struct {
		Session map[string]any `json:"session"`
	}
	if err := json.Unmarshal(createResponse.Payload, &createPayload); err != nil {
		t.Fatalf("decode create_ssh response: %v", err)
	}
	if createPayload.Session["kind"] != "ssh" || createPayload.Session["pid"] != nil {
		t.Fatalf("create_ssh session payload = %#v, want ssh with nil pid", createPayload.Session)
	}
	sshPayload, ok := createPayload.Session["ssh"].(map[string]any)
	if !ok || sshPayload["host_id"] != "prod" || sshPayload["auth_type"] != "privateKey" {
		t.Fatalf("create_ssh ssh metadata = %#v", createPayload.Session["ssh"])
	}

	sendEnvelope(t, conn, "terminal-input-ssh-enabled", "terminal.input", map[string]any{
		"session_id":       " ssh-1 ",
		"project_path_key": " /workspace/project ",
		"data":             "pwd\n",
	})
	inputOutbound := readOutboundEnvelope(t, agentSession)
	inputReq := inputOutbound.GetTerminalRequest()
	if inputReq == nil {
		t.Fatalf("ssh terminal input outbound payload = %T, want TerminalRequest", inputOutbound.GetPayload())
	}
	if inputReq.GetAction() != "input" ||
		inputReq.GetSessionId() != "ssh-1" ||
		inputReq.GetData() != "pwd\n" {
		t.Fatalf("ssh terminal input request = %#v", inputReq)
	}
}

func TestWebSocketSshTerminalCreateRejectedWithoutSshPermission(t *testing.T) {
	t.Parallel()

	_, _, conn, cleanup := newTerminalWebSocketTestWithPermissions(t, true, false)
	defer cleanup()

	sendEnvelope(t, conn, "terminal-create-ssh-disabled", "terminal.create_ssh", map[string]any{
		"cwd":              "/workspace/project",
		"project_path_key": "/workspace/project",
		"ssh_host_id":      "prod",
	})

	env := receiveEnvelope(t, conn)
	if env.ID != "terminal-create-ssh-disabled" || env.Type != "error" {
		t.Fatalf("ssh terminal disabled response = %#v, want error", env)
	}
	if !strings.Contains(env.Error, "web SSH terminal is disabled") {
		t.Fatalf("ssh terminal disabled error = %q", env.Error)
	}
}

func TestWebSocketTerminalListFiltersLocalSessionsWhenOnlySshEnabled(t *testing.T) {
	t.Parallel()

	sm, agentSession, conn, cleanup := newTerminalWebSocketTestWithPermissions(t, false, true)
	defer cleanup()

	sendEnvelope(t, conn, "terminal-list-ssh-only", "terminal.list", map[string]any{
		"project_path_key": "/workspace/project",
	})
	outbound := readOutboundEnvelope(t, agentSession)
	req := outbound.GetTerminalRequest()
	if req == nil || req.GetAction() != "list" {
		t.Fatalf("terminal list outbound payload = %#v, want list request", outbound.GetPayload())
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalResponse{
			TerminalResponse: &gatewayv1.TerminalResponse{
				Action: "list",
				Sessions: []*gatewayv1.TerminalSession{
					{
						Id:             "local-1",
						ProjectPathKey: "/workspace/project",
						Cwd:            "/workspace/project",
						Title:          "Local",
						Kind:           "local",
						CreatedAt:      1,
						UpdatedAt:      1,
						Running:        true,
					},
					{
						Id:             "ssh-1",
						ProjectPathKey: "/workspace/project",
						Cwd:            "/workspace/project",
						Shell:          "ssh",
						Title:          "Production",
						Kind:           "ssh",
						CreatedAt:      2,
						UpdatedAt:      2,
						Running:        true,
						Ssh: &gatewayv1.TerminalSshMetadata{
							HostId:   "prod",
							HostName: "Production",
							Username: "deploy",
							Host:     "prod.example.com",
							Port:     22,
							AuthType: "password",
						},
					},
				},
			},
		},
	})
	response := receiveEnvelopeWithID(t, conn, "terminal-list-ssh-only")
	if response.Type != "response" {
		t.Fatalf("terminal ssh-only list response = %#v, want response", response)
	}
	var payload struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(response.Payload, &payload); err != nil {
		t.Fatalf("decode ssh-only list response: %v", err)
	}
	if len(payload.Sessions) != 1 ||
		payload.Sessions[0]["id"] != "ssh-1" ||
		payload.Sessions[0]["kind"] != "ssh" {
		t.Fatalf("ssh-only list sessions = %#v, want only ssh-1", payload.Sessions)
	}
}

func TestWebSocketTerminalListMergesCachedSshSessions(t *testing.T) {
	t.Parallel()

	sm, agentSession, conn, cleanup := newTerminalWebSocketTestWithPermissions(t, false, true)
	defer cleanup()

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "event-created-cached-ssh",
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalEvent{
			TerminalEvent: &gatewayv1.TerminalEvent{
				Kind:           "created",
				SessionId:      "ssh-1",
				ProjectPathKey: "/workspace/project",
				Session: &gatewayv1.TerminalSession{
					Id:             "ssh-1",
					ProjectPathKey: "/workspace/project",
					Cwd:            "/workspace/project",
					Shell:          "ssh",
					Title:          "Production",
					Kind:           "ssh",
					CreatedAt:      2,
					UpdatedAt:      2,
					Running:        true,
					Ssh: &gatewayv1.TerminalSshMetadata{
						HostId:   "prod",
						HostName: "Production",
						Username: "deploy",
						Host:     "prod.example.com",
						Port:     22,
						AuthType: "password",
						Status:   "connected",
					},
				},
			},
		},
	})
	createdEvent := receiveEnvelope(t, conn)
	if createdEvent.Type != "terminal.event" {
		t.Fatalf("cached ssh created event = %#v, want terminal.event", createdEvent)
	}

	sendEnvelope(t, conn, "terminal-list-merge-cached-ssh", "terminal.list", map[string]any{})
	outbound := readOutboundEnvelope(t, agentSession)
	req := outbound.GetTerminalRequest()
	if req == nil || req.GetAction() != "list" {
		t.Fatalf("terminal list outbound payload = %#v, want list request", outbound.GetPayload())
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalResponse{
			TerminalResponse: &gatewayv1.TerminalResponse{
				Action:   "list",
				Sessions: []*gatewayv1.TerminalSession{},
			},
		},
	})
	response := receiveEnvelopeWithID(t, conn, "terminal-list-merge-cached-ssh")
	if response.Type != "response" {
		t.Fatalf("terminal cached ssh list response = %#v, want response", response)
	}
	var payload struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(response.Payload, &payload); err != nil {
		t.Fatalf("decode cached ssh list response: %v", err)
	}
	if len(payload.Sessions) != 1 ||
		payload.Sessions[0]["id"] != "ssh-1" ||
		payload.Sessions[0]["kind"] != "ssh" {
		t.Fatalf("cached ssh list sessions = %#v, want ssh-1", payload.Sessions)
	}
}

func TestWebSocketTerminalRejectsInteractiveRequestsWhenDisabled(t *testing.T) {
	t.Parallel()

	_, _, conn, cleanup := newTerminalWebSocketTest(t, false)
	defer cleanup()

	sendEnvelope(t, conn, "terminal-create-disabled", "terminal.create", map[string]any{
		"cwd":              "/workspace/project",
		"project_path_key": "/workspace/project",
	})

	env := receiveEnvelope(t, conn)
	if env.ID != "terminal-create-disabled" || env.Type != "error" {
		t.Fatalf("terminal disabled response = %#v, want error", env)
	}
	if !strings.Contains(env.Error, "web terminal is disabled") {
		t.Fatalf("terminal disabled error = %q", env.Error)
	}
}

func TestWebSocketTerminalRejectsProjectCleanupRequestsWhenDisabled(t *testing.T) {
	t.Parallel()

	_, _, conn, cleanup := newTerminalWebSocketTest(t, false)
	defer cleanup()

	sendEnvelope(t, conn, "terminal-list-disabled", "terminal.list", map[string]any{
		"project_path_key": " /workspace/project ",
	})
	listResponse := receiveEnvelope(t, conn)
	if listResponse.ID != "terminal-list-disabled" || listResponse.Type != "error" {
		t.Fatalf("terminal list response = %#v", listResponse)
	}
	if !strings.Contains(listResponse.Error, "web terminal is disabled") {
		t.Fatalf("terminal list disabled error = %q", listResponse.Error)
	}

	sendEnvelope(t, conn, "terminal-close-project-disabled", "terminal.close_project", map[string]any{
		"project_path_key": " /workspace/project ",
	})
	closeResponse := receiveEnvelope(t, conn)
	if closeResponse.ID != "terminal-close-project-disabled" || closeResponse.Type != "error" {
		t.Fatalf("terminal close_project response = %#v", closeResponse)
	}
	if !strings.Contains(closeResponse.Error, "web terminal is disabled") {
		t.Fatalf("terminal close_project disabled error = %q", closeResponse.Error)
	}
}

func TestWebSocketSettingsGetEnablesTerminalListAfterRefresh(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := server.NewWebSocketServer(&config.Config{
		Token:          "ws-token",
		RequestTimeout: time.Second,
	}, sm)
	conn, cleanup := dialGatewayWebSocket(t, handler)
	defer cleanup()
	authWebSocket(t, conn, "ws-token")

	sendEnvelope(t, conn, "terminal-list-before-settings", "terminal.list", map[string]any{
		"project_path_key": "/workspace/project",
	})
	beforeSettings := receiveEnvelope(t, conn)
	if beforeSettings.ID != "terminal-list-before-settings" || beforeSettings.Type != "error" {
		t.Fatalf("terminal list before settings = %#v, want disabled error", beforeSettings)
	}

	sendEnvelope(t, conn, "settings-get", "settings.get", map[string]any{})
	settingsReq := readOutboundEnvelope(t, agentSession)
	if settingsReq.GetSettingsGet() == nil {
		t.Fatalf("settings.get outbound payload = %T, want SettingsGetRequest", settingsReq.GetPayload())
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: settingsReq.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_SettingsGetResp{
			SettingsGetResp: &gatewayv1.SettingsGetResponse{
				SettingsJson: `{"remote":{"enableWebTerminal":true}}`,
			},
		},
	})
	settingsResp := receiveEnvelopeWithID(t, conn, "settings-get")
	if settingsResp.Type != "response" {
		t.Fatalf("settings.get response = %#v, want response", settingsResp)
	}

	sendEnvelope(t, conn, "terminal-list-after-settings", "terminal.list", map[string]any{
		"project_path_key": "/workspace/project",
	})
	terminalReq := readOutboundEnvelope(t, agentSession)
	req := terminalReq.GetTerminalRequest()
	if req == nil {
		t.Fatalf("terminal.list outbound payload = %T, want TerminalRequest", terminalReq.GetPayload())
	}
	if req.GetAction() != "list" || req.GetProjectPathKey() != "/workspace/project" {
		t.Fatalf("terminal list request after settings = %#v", req)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: terminalReq.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalResponse{
			TerminalResponse: &gatewayv1.TerminalResponse{
				Action: "list",
				Sessions: []*gatewayv1.TerminalSession{
					{
						Id:             "terminal-1",
						ProjectPathKey: "/workspace/project",
						Cwd:            "/workspace/project",
						Title:          "Terminal 1",
						CreatedAt:      1,
						UpdatedAt:      1,
						Running:        true,
					},
				},
			},
		},
	})
	terminalResp := receiveEnvelopeWithID(t, conn, "terminal-list-after-settings")
	if terminalResp.Type != "response" {
		t.Fatalf("terminal list after settings response = %#v, want response", terminalResp)
	}
}

func TestWebSocketTerminalListCanBootstrapAllSessions(t *testing.T) {
	t.Parallel()

	sm, agentSession, conn, cleanup := newTerminalWebSocketTest(t, true)
	defer cleanup()

	sendEnvelope(t, conn, "terminal-list-all", "terminal.list", map[string]any{})
	terminalReq := readOutboundEnvelope(t, agentSession)
	req := terminalReq.GetTerminalRequest()
	if req == nil {
		t.Fatalf("terminal.list outbound payload = %T, want TerminalRequest", terminalReq.GetPayload())
	}
	if req.GetAction() != "list" || req.GetProjectPathKey() != "" {
		t.Fatalf("terminal list all request = %#v", req)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: terminalReq.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalResponse{
			TerminalResponse: &gatewayv1.TerminalResponse{
				Action: "list",
				Sessions: []*gatewayv1.TerminalSession{
					{
						Id:             "terminal-1",
						ProjectPathKey: "/workspace/project-a",
						Cwd:            "/workspace/project-a",
						Title:          "Terminal 1",
						CreatedAt:      1,
						UpdatedAt:      1,
						Running:        true,
					},
					{
						Id:             "terminal-2",
						ProjectPathKey: "/workspace/project-b",
						Cwd:            "/workspace/project-b",
						Title:          "Terminal 2",
						CreatedAt:      2,
						UpdatedAt:      2,
						Running:        true,
					},
				},
			},
		},
	})

	terminalResp := receiveEnvelopeWithID(t, conn, "terminal-list-all")
	if terminalResp.Type != "response" {
		t.Fatalf("terminal list all response = %#v, want response", terminalResp)
	}
	var payload struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(terminalResp.Payload, &payload); err != nil {
		t.Fatalf("decode terminal list all response: %v", err)
	}
	if len(payload.Sessions) != 2 {
		t.Fatalf("terminal list all sessions = %#v, want 2 sessions", payload.Sessions)
	}
}

func TestWebSocketTerminalReplaysCachedSessionsAfterAuth(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	sm.ApplySettingsJSON(`{"remote":{"enableWebTerminal":true}}`)
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := server.NewWebSocketServer(&config.Config{
		Token:          "ws-token",
		RequestTimeout: time.Second,
	}, sm)
	conn1, cleanup1 := dialGatewayWebSocket(t, handler)
	defer cleanup1()
	authWebSocket(t, conn1, "ws-token")

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "event-created-replay",
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalEvent{
			TerminalEvent: &gatewayv1.TerminalEvent{
				Kind:           "created",
				SessionId:      "terminal-1",
				ProjectPathKey: "/workspace/project",
				Session: &gatewayv1.TerminalSession{
					Id:             "terminal-1",
					ProjectPathKey: "/workspace/project",
					Cwd:            "/workspace/project",
					Title:          "Terminal 1",
					CreatedAt:      1,
					UpdatedAt:      1,
					Running:        true,
				},
			},
		},
	})
	firstEvent := receiveEnvelope(t, conn1)
	if firstEvent.Type != "terminal.event" {
		t.Fatalf("terminal created event = %#v, want terminal.event", firstEvent)
	}

	conn2, cleanup2 := dialGatewayWebSocket(t, handler)
	defer cleanup2()
	authWebSocket(t, conn2, "ws-token")
	replayedEvent := receiveEnvelope(t, conn2)
	if replayedEvent.Type != "terminal.event" {
		t.Fatalf("terminal replay event = %#v, want terminal.event", replayedEvent)
	}
	var payload struct {
		Kind      string         `json:"kind"`
		SessionID string         `json:"session_id"`
		Session   map[string]any `json:"session"`
	}
	if err := json.Unmarshal(replayedEvent.Payload, &payload); err != nil {
		t.Fatalf("decode terminal replay event: %v", err)
	}
	if payload.Kind != "created" || payload.SessionID != "terminal-1" {
		t.Fatalf("terminal replay payload = %#v, want terminal-1 created", payload)
	}
}

func TestWebSocketTerminalForwardsInteractiveRequestsWhenEnabled(t *testing.T) {
	t.Parallel()

	sm, agentSession, conn, cleanup := newTerminalWebSocketTest(t, true)
	defer cleanup()

	sendEnvelope(t, conn, "terminal-create-enabled", "terminal.create", map[string]any{
		"cwd":              " /workspace/project ",
		"project_path_key": " /workspace/project ",
		"shell":            " default ",
		"title":            " Dev ",
		"cols":             120,
		"rows":             32,
	})
	outbound := readOutboundEnvelope(t, agentSession)
	req := outbound.GetTerminalRequest()
	if req == nil {
		t.Fatalf("terminal create outbound payload = %T, want TerminalRequest", outbound.GetPayload())
	}
	if req.GetAction() != "create" ||
		req.GetCwd() != "/workspace/project" ||
		req.GetProjectPathKey() != "/workspace/project" ||
		req.GetShell() != "default" ||
		req.GetTitle() != "Dev" ||
		req.GetCols() != 120 ||
		req.GetRows() != 32 {
		t.Fatalf("terminal create request = %#v", req)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalResponse{
			TerminalResponse: &gatewayv1.TerminalResponse{
				Action: "create",
				Session: &gatewayv1.TerminalSession{
					Id:             "terminal-1",
					ProjectPathKey: "/workspace/project",
					Cwd:            "/workspace/project",
					Shell:          "zsh",
					Title:          "Dev",
					Cols:           120,
					Rows:           32,
					CreatedAt:      1,
					UpdatedAt:      2,
					Running:        true,
				},
			},
		},
	})
	response := receiveEnvelope(t, conn)
	if response.ID != "terminal-create-enabled" || response.Type != "response" {
		t.Fatalf("terminal create response = %#v", response)
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Payload, &payload); err != nil {
		t.Fatalf("decode terminal create payload: %v", err)
	}
	sessionPayload, ok := payload["session"].(map[string]any)
	if !ok || sessionPayload["id"] != "terminal-1" {
		t.Fatalf("terminal create payload = %#v", payload)
	}

	sendEnvelope(t, conn, "terminal-input-enabled", "terminal.input", map[string]any{
		"session_id":       " terminal-1 ",
		"project_path_key": " /workspace/project ",
		"data":             "pwd\n",
	})
	inputOutbound := readOutboundEnvelope(t, agentSession)
	inputReq := inputOutbound.GetTerminalRequest()
	if inputReq == nil {
		t.Fatalf("terminal input outbound payload = %T, want TerminalRequest", inputOutbound.GetPayload())
	}
	if inputReq.GetAction() != "input" ||
		inputReq.GetSessionId() != "terminal-1" ||
		inputReq.GetProjectPathKey() != "/workspace/project" ||
		inputReq.GetData() != "pwd\n" {
		t.Fatalf("terminal input request = %#v", inputReq)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: inputOutbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalResponse{
			TerminalResponse: &gatewayv1.TerminalResponse{
				Action: "input",
				Session: &gatewayv1.TerminalSession{
					Id:             "terminal-1",
					ProjectPathKey: "/workspace/project",
					Cwd:            "/workspace/project",
					Shell:          "zsh",
					Title:          "Dev",
					Cols:           120,
					Rows:           32,
					CreatedAt:      1,
					UpdatedAt:      3,
					Running:        true,
				},
			},
		},
	})
	inputResponse := receiveEnvelope(t, conn)
	if inputResponse.ID != "terminal-input-enabled" || inputResponse.Type != "response" {
		t.Fatalf("terminal input response = %#v", inputResponse)
	}
}

func TestWebSocketTerminalEventsForwardMetadataAndRequireAttachForOutput(t *testing.T) {
	t.Parallel()

	sm, agentSession, conn, cleanup := newTerminalWebSocketTest(t, true)
	defer cleanup()

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "event-unsubscribed",
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalEvent{
			TerminalEvent: &gatewayv1.TerminalEvent{
				Kind:           "output",
				SessionId:      "terminal-1",
				ProjectPathKey: "/workspace/project",
				Session: &gatewayv1.TerminalSession{
					Id:             "terminal-1",
					ProjectPathKey: "/workspace/project",
					Cwd:            "/workspace/project",
					Title:          "Terminal 1",
					Running:        true,
				},
				Data: "secret\n",
			},
		},
	})
	receiveNoTerminalEnvelope(t, conn)

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "event-unsubscribed-created",
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalEvent{
			TerminalEvent: &gatewayv1.TerminalEvent{
				Kind:           "created",
				SessionId:      "terminal-1",
				ProjectPathKey: "/workspace/project",
				Session: &gatewayv1.TerminalSession{
					Id:             "terminal-1",
					ProjectPathKey: "/workspace/project",
					Cwd:            "/workspace/project",
					Title:          "Terminal 1",
					Running:        true,
				},
			},
		},
	})
	createdEvent := receiveEnvelope(t, conn)
	assertTerminalEventKind(t, createdEvent, "created")

	sendEnvelope(t, conn, "terminal-list-for-events", "terminal.list", map[string]any{
		"project_path_key": "/workspace/project",
	})
	listOutbound := readOutboundEnvelope(t, agentSession)
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: listOutbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalResponse{
			TerminalResponse: &gatewayv1.TerminalResponse{
				Action: "list",
			},
		},
	})
	listResponse := receiveEnvelope(t, conn)
	if listResponse.ID != "terminal-list-for-events" || listResponse.Type != "response" {
		t.Fatalf("terminal list response = %#v", listResponse)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "event-project-output",
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalEvent{
			TerminalEvent: &gatewayv1.TerminalEvent{
				Kind:           "output",
				SessionId:      "terminal-1",
				ProjectPathKey: "/workspace/project",
				Session: &gatewayv1.TerminalSession{
					Id:             "terminal-1",
					ProjectPathKey: "/workspace/project",
					Cwd:            "/workspace/project",
					Title:          "Terminal 1",
					Running:        true,
				},
				Data: "still-hidden\n",
			},
		},
	})
	receiveNoTerminalEnvelope(t, conn)

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "event-project-exit",
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalEvent{
			TerminalEvent: &gatewayv1.TerminalEvent{
				Kind:           "exit",
				SessionId:      "terminal-1",
				ProjectPathKey: "/workspace/project",
				Session: &gatewayv1.TerminalSession{
					Id:             "terminal-1",
					ProjectPathKey: "/workspace/project",
					Cwd:            "/workspace/project",
					Title:          "Terminal 1",
					Running:        false,
				},
			},
		},
	})
	exitEvent := receiveEnvelope(t, conn)
	assertTerminalEventKind(t, exitEvent, "exit")

	sendEnvelope(t, conn, "terminal-attach-for-output", "terminal.attach", map[string]any{
		"session_id":       "terminal-1",
		"project_path_key": "/workspace/project",
	})
	attachOutbound := readOutboundEnvelope(t, agentSession)
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "event-attach-pending-output",
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalEvent{
			TerminalEvent: &gatewayv1.TerminalEvent{
				Kind:           "output",
				SessionId:      "terminal-1",
				ProjectPathKey: "/workspace/project",
				Session: &gatewayv1.TerminalSession{
					Id:             "terminal-1",
					ProjectPathKey: "/workspace/project",
					Cwd:            "/workspace/project",
					Title:          "Terminal 1",
					Running:        true,
				},
				Data:              "visible-before-attach-response\n",
				OutputStartOffset: 10,
				OutputEndOffset:   41,
			},
		},
	})
	pendingOutputEvent := receiveEnvelope(t, conn)
	assertTerminalEventKind(t, pendingOutputEvent, "output")
	var pendingOutputPayload struct {
		Data              string `json:"data"`
		OutputStartOffset uint64 `json:"output_start_offset"`
		OutputEndOffset   uint64 `json:"output_end_offset"`
	}
	if err := json.Unmarshal(pendingOutputEvent.Payload, &pendingOutputPayload); err != nil {
		t.Fatalf("decode terminal attach-pending output event: %v", err)
	}
	if pendingOutputPayload.Data != "visible-before-attach-response\n" ||
		pendingOutputPayload.OutputStartOffset != 10 ||
		pendingOutputPayload.OutputEndOffset != 41 {
		t.Fatalf("terminal attach-pending output payload = %#v", pendingOutputPayload)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: attachOutbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalResponse{
			TerminalResponse: &gatewayv1.TerminalResponse{
				Action: "attach",
				Session: &gatewayv1.TerminalSession{
					Id:             "terminal-1",
					ProjectPathKey: "/workspace/project",
					Cwd:            "/workspace/project",
					Title:          "Terminal 1",
					Running:        true,
				},
			},
		},
	})
	attachResponse := receiveEnvelope(t, conn)
	if attachResponse.ID != "terminal-attach-for-output" || attachResponse.Type != "response" {
		t.Fatalf("terminal attach response = %#v", attachResponse)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "event-attached-output",
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalEvent{
			TerminalEvent: &gatewayv1.TerminalEvent{
				Kind:           "output",
				SessionId:      "terminal-1",
				ProjectPathKey: "/workspace/project",
				Session: &gatewayv1.TerminalSession{
					Id:             "terminal-1",
					ProjectPathKey: "/workspace/project",
					Cwd:            "/workspace/project",
					Title:          "Terminal 1",
					Running:        true,
				},
				Data: "visible\n",
			},
		},
	})
	outputEvent := receiveEnvelope(t, conn)
	assertTerminalEventKind(t, outputEvent, "output")

	sendEnvelope(t, conn, "terminal-detach-for-output", "terminal.detach", map[string]any{
		"session_id":       "terminal-1",
		"project_path_key": "/workspace/project",
	})
	detachResponse := receiveEnvelope(t, conn)
	if detachResponse.ID != "terminal-detach-for-output" || detachResponse.Type != "response" {
		t.Fatalf("terminal detach response = %#v", detachResponse)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "event-detached-output",
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_TerminalEvent{
			TerminalEvent: &gatewayv1.TerminalEvent{
				Kind:           "output",
				SessionId:      "terminal-1",
				ProjectPathKey: "/workspace/project",
				Session: &gatewayv1.TerminalSession{
					Id:             "terminal-1",
					ProjectPathKey: "/workspace/project",
					Cwd:            "/workspace/project",
					Title:          "Terminal 1",
					Running:        true,
				},
				Data: "hidden-again\n",
			},
		},
	})
	assertNoTerminalEnvelopeAtEnd(t, conn)
}
