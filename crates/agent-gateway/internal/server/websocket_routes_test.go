package server

import (
	"encoding/json"
	"testing"
)

func TestWebsocketRequestHandlersCoverKnownProtocolTypes(t *testing.T) {
	t.Parallel()

	expectedTypes := []string{
		"status.get",
		"fs.roots",
		"fs.list_dirs",
		"fs.create_project_folder",
		"fs.list",
		"fs.read_editable_text",
		"fs.read_workspace_image",
		"fs.write_text",
		"fs.create_dir",
		"fs.rename",
		"fs.delete",
		"history.list",
		"history.workdirs",
		"history.shared_list",
		"history.get",
		"history.rename",
		"history.pin",
		"history.share.get",
		"history.share.set",
		"history.delete",
		"providers.list",
		"settings.get",
		"settings.update",
		"settings.ssh_known_host.reset",
		"skills.list",
		"mentions.list",
		"skills.read-metadata",
		"skills.read-text",
		"skills.manage",
		"files.preview",
		"memory.manage",
		"terminal.shell_options",
		"terminal.list",
		"terminal.create",
		"terminal.create_ssh",
		"terminal.answer_ssh_prompt",
		"terminal.cancel_ssh_prompt",
		"terminal.ssh_latency",
		"terminal.attach",
		"terminal.input",
		"terminal.resize",
		"terminal.rename",
		"terminal.close",
		"terminal.close_project",
		"terminal.detach",
		"sftp.list",
		"sftp.stat",
		"sftp.mkdir",
		"sftp.rename",
		"sftp.delete",
		"sftp.transfer",
		"sftp.cancel",
		"tunnel.list",
		"tunnel.create",
		"tunnel.update",
		"tunnel.close",
		"git.status",
		"git.branches",
		"git.init",
		"git.switch_branch",
		"git.create_branch",
		"git.diff",
		"git.log",
		"git.commit_details",
		"git.compare_commit_with_remote",
		"git.commit_diff",
		"git.stage",
		"git.stage_all",
		"git.unstage",
		"git.unstage_all",
		"git.discard",
		"git.discard_all",
		"git.add_to_gitignore",
		"git.commit",
		"git.fetch",
		"git.pull",
		"git.set_remote",
		"git.push",
		"cron.manage",
		"provider.models",
	}

	for _, requestType := range expectedTypes {
		if websocketRequestHandlers[requestType] == nil {
			t.Fatalf("websocketRequestHandlers[%q] is missing", requestType)
		}
	}
	if got := len(websocketRequestHandlers); got != len(expectedTypes) {
		t.Fatalf("websocketRequestHandlers has %d entries, want %d", got, len(expectedTypes))
	}

	for _, removedType := range []string{
		"history.truncate",
		"chat.start",
		"chat.resume",
		"chat.attach",
		"chat.detach",
		"chat.cancel",
	} {
		if websocketRequestHandlers[removedType] != nil {
			t.Fatalf("websocketRequestHandlers[%q] should be removed; chat uses HTTP commands and SSE", removedType)
		}
	}
}

func TestDecodeWebSocketPayloadRejectsUnknownFields(t *testing.T) {
	t.Parallel()

	var empty struct{}
	if err := decodeWebSocketPayload(nil, &empty); err != nil {
		t.Fatalf("decode empty payload: %v", err)
	}

	var payload struct {
		Known string `json:"known"`
	}
	if err := decodeWebSocketPayload([]byte(`{"known":"ok","unknown":true}`), &payload); err == nil {
		t.Fatal("expected unknown payload field to be rejected")
	}
}

func TestTunnelTTLFromPayloadDefaultsOnlyWhenOmitted(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		raw        json.RawMessage
		camelValue uint32
		snakeValue uint32
		want       uint32
	}{
		{
			name:       "omitted",
			raw:        json.RawMessage(`{"targetUrl":"http://localhost:3000"}`),
			camelValue: 0,
			snakeValue: 0,
			want:       websocketDefaultTunnelTTLSeconds,
		},
		{
			name:       "camel explicit infinite",
			raw:        json.RawMessage(`{"targetUrl":"http://localhost:3000","ttlSeconds":0}`),
			camelValue: 0,
			snakeValue: 0,
			want:       0,
		},
		{
			name:       "snake explicit infinite",
			raw:        json.RawMessage(`{"target_url":"http://localhost:3000","ttl_seconds":0}`),
			camelValue: 0,
			snakeValue: 0,
			want:       0,
		},
		{
			name:       "camel finite",
			raw:        json.RawMessage(`{"targetUrl":"http://localhost:3000","ttlSeconds":900}`),
			camelValue: 900,
			snakeValue: 0,
			want:       900,
		},
	}

	for _, tt := range tests {
		if got := tunnelTTLFromPayload(tt.raw, tt.camelValue, tt.snakeValue); got != tt.want {
			t.Fatalf("%s: tunnelTTLFromPayload = %d, want %d", tt.name, got, tt.want)
		}
	}
}
