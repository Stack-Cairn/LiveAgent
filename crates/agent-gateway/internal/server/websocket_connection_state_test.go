package server

import (
	"testing"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestWebsocketTerminalInterestTrackerFiltersOutputBySession(t *testing.T) {
	t.Parallel()

	tracker := newWebsocketTerminalInterestTracker()
	outputEvent := &gatewayv1.TerminalEvent{
		Kind:           "output",
		SessionId:      "session-1",
		ProjectPathKey: "project-1",
	}
	metadataEvent := &gatewayv1.TerminalEvent{
		Kind:           "created",
		SessionId:      "session-1",
		ProjectPathKey: "project-1",
	}

	if tracker.shouldForward(outputEvent) {
		t.Fatal("output should not forward before a session is attached")
	}
	if !tracker.shouldForward(metadataEvent) {
		t.Fatal("metadata should forward so project/session lists stay fresh")
	}

	tracker.rememberSession("session-1", "project-1")
	if !tracker.shouldForward(outputEvent) {
		t.Fatal("output should forward after attaching the session")
	}

	tracker.forget("session-1", "project-1")
	if tracker.shouldForward(outputEvent) {
		t.Fatal("output should stop forwarding after detaching the session")
	}
}

func TestWebsocketTerminalPermissionsSeparateLocalAndSshSessions(t *testing.T) {
	t.Parallel()

	manager := session.NewManager()
	manager.ApplySettingsJSON(`{"remote":{"enableWebTerminal":false,"enableWebSshTerminal":true}}`)
	conn := &websocketConnection{sm: manager}
	localSession := &gatewayv1.TerminalSession{
		Id:   "local-1",
		Kind: "local",
	}
	sshSession := &gatewayv1.TerminalSession{
		Id:   "ssh-1",
		Kind: "ssh",
		Ssh: &gatewayv1.TerminalSshMetadata{
			Status: "connected",
		},
	}

	if conn.terminalSessionAllowed(localSession) {
		t.Fatal("local terminal session should not be allowed when only web SSH terminal is enabled")
	}
	if !conn.terminalSessionAllowed(sshSession) {
		t.Fatal("SSH terminal session should be allowed when web SSH terminal is enabled")
	}

	manager.ApplySettingsJSON(`{"remote":{"enableWebTerminal":true,"enableWebSshTerminal":false}}`)
	if !conn.terminalSessionAllowed(localSession) {
		t.Fatal("local terminal session should be allowed when web terminal is enabled")
	}
	if conn.terminalSessionAllowed(sshSession) {
		t.Fatal("SSH terminal session should not be allowed when web SSH terminal is disabled")
	}
}

func TestWebsocketTerminalSessionPayloadIncludesSftpEnabled(t *testing.T) {
	t.Parallel()

	payload := websocketTerminalSessionPayload(&gatewayv1.TerminalSession{
		Id:   "ssh-1",
		Kind: "ssh",
		Ssh: &gatewayv1.TerminalSshMetadata{
			SftpEnabled: true,
		},
	})
	ssh, ok := payload["ssh"].(map[string]any)
	if !ok {
		t.Fatalf("ssh payload missing: %#v", payload["ssh"])
	}
	if got := ssh["sftp_enabled"]; got != true {
		t.Fatalf("sftp_enabled = %#v, want true", got)
	}
	if got := ssh["sftpEnabled"]; got != true {
		t.Fatalf("sftpEnabled = %#v, want true", got)
	}
}

func TestWebsocketTerminalEventForwardingAllowsSshOnlyStatusEvents(t *testing.T) {
	t.Parallel()

	manager := session.NewManager()
	manager.ApplySettingsJSON(`{"remote":{"enableWebTerminal":false,"enableWebSshTerminal":true}}`)
	conn := &websocketConnection{
		sm:               manager,
		terminalInterest: newWebsocketTerminalInterestTracker(),
	}

	if !conn.shouldForwardTerminalEvent(&gatewayv1.TerminalEvent{
		Kind:           "reconnecting",
		SessionId:      "ssh-1",
		ProjectPathKey: "project-1",
		Session: &gatewayv1.TerminalSession{
			Id:             "ssh-1",
			ProjectPathKey: "project-1",
			Kind:           "ssh",
			Ssh: &gatewayv1.TerminalSshMetadata{
				Status:           "reconnecting",
				ReconnectAttempt: 1,
			},
		},
	}) {
		t.Fatal("SSH metadata event should forward when only web SSH terminal is enabled")
	}

	if conn.shouldForwardTerminalEvent(&gatewayv1.TerminalEvent{
		Kind:           "created",
		SessionId:      "local-1",
		ProjectPathKey: "project-1",
		Session: &gatewayv1.TerminalSession{
			Id:             "local-1",
			ProjectPathKey: "project-1",
			Kind:           "local",
		},
	}) {
		t.Fatal("local metadata event should not forward when web terminal is disabled")
	}
}
