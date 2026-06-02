package server

import "testing"

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
		"history.truncate",
		"providers.list",
		"settings.get",
		"settings.update",
		"skills.list",
		"mentions.list",
		"skills.read-metadata",
		"skills.read-text",
		"skills.manage",
		"chat.start",
		"chat.resume",
		"chat.attach",
		"chat.detach",
		"chat.cancel",
		"files.preview",
		"memory.manage",
		"terminal.shell_options",
		"terminal.list",
		"terminal.create",
		"terminal.attach",
		"terminal.input",
		"terminal.resize",
		"terminal.rename",
		"terminal.close",
		"terminal.close_project",
		"terminal.detach",
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
