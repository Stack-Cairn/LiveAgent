package server

import (
	"testing"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func TestWebsocketChatEventPayloadPreservesHostedSearch(t *testing.T) {
	payload := websocketChatEventPayload(&gatewayv1.ChatEvent{
		Type:           gatewayv1.ChatEvent_HOSTED_SEARCH,
		ConversationId: "conversation-1",
		Data:           `{"id":"search-1","provider":"codex","status":"completed","queries":["设计模式定义"],"sources":[{"url":"https://example.com/pattern","title":"设计模式"}],"round":2}`,
	}, 7)

	if payload["type"] != "hosted_search" {
		t.Fatalf("expected hosted_search type, got %#v", payload["type"])
	}
	if payload["conversation_id"] != "conversation-1" {
		t.Fatalf("expected conversation id, got %#v", payload["conversation_id"])
	}
	if payload["id"] != "search-1" {
		t.Fatalf("expected search id, got %#v", payload["id"])
	}
	if payload["provider"] != "codex" {
		t.Fatalf("expected provider, got %#v", payload["provider"])
	}
	if payload["status"] != "completed" {
		t.Fatalf("expected status, got %#v", payload["status"])
	}
	if payload["seq"] != int64(7) {
		t.Fatalf("expected seq 7, got %#v", payload["seq"])
	}
}

func TestWebsocketTerminalPayloadsPreserveOutputOffsets(t *testing.T) {
	response := websocketTerminalResponsePayload(&gatewayv1.TerminalResponse{
		Action:            "attach",
		Output:            "uploads\n",
		OutputStartOffset: 8,
		OutputEndOffset:   16,
	})
	if response["output_start_offset"] != uint64(8) {
		t.Fatalf("terminal response output_start_offset = %#v, want 8", response["output_start_offset"])
	}
	if response["output_end_offset"] != uint64(16) {
		t.Fatalf("terminal response output_end_offset = %#v, want 16", response["output_end_offset"])
	}

	event := websocketTerminalEventPayload(&gatewayv1.TerminalEvent{
		Kind:              "output",
		SessionId:         "terminal-1",
		ProjectPathKey:    "/workspace/project",
		Data:              "uploads\n",
		OutputStartOffset: 16,
		OutputEndOffset:   24,
	})
	if event["output_start_offset"] != uint64(16) {
		t.Fatalf("terminal event output_start_offset = %#v, want 16", event["output_start_offset"])
	}
	if event["output_end_offset"] != uint64(24) {
		t.Fatalf("terminal event output_end_offset = %#v, want 24", event["output_end_offset"])
	}
}

func TestWebsocketFsPayloadsUseFrontendFieldNames(t *testing.T) {
	list := websocketFsListResponsePayload(&gatewayv1.FsListResponse{
		Path:       "src",
		HasPath:    true,
		Depth:      1,
		Offset:     2,
		MaxResults: 50,
		Total:      3,
		HasMore:    true,
		Entries: []*gatewayv1.FsListEntry{
			{Path: "src/components", Kind: "dir"},
			{Path: "src/app.tsx", Kind: "file"},
		},
	})
	if list["path"] != "src" {
		t.Fatalf("fs.list path = %#v, want src", list["path"])
	}
	if list["maxResults"] != uint32(50) {
		t.Fatalf("fs.list maxResults = %#v, want 50", list["maxResults"])
	}
	if list["hasMore"] != true {
		t.Fatalf("fs.list hasMore = %#v, want true", list["hasMore"])
	}
	entries, ok := list["entries"].([]map[string]any)
	if !ok || len(entries) != 2 {
		t.Fatalf("fs.list entries = %#v, want two entry maps", list["entries"])
	}
	if entries[0]["path"] != "src/components" || entries[0]["kind"] != "dir" {
		t.Fatalf("fs.list first entry = %#v", entries[0])
	}

	readEditable := websocketFsReadEditableTextResponsePayload(&gatewayv1.FsReadEditableTextResponse{
		Path:        "src/main.ts",
		Content:     "export {};\n",
		MtimeMs:     42,
		ContentHash: "hash",
		SizeBytes:   11,
		TotalLines:  1,
	})
	if readEditable["content"] != "export {};\n" {
		t.Fatalf("fs.read_editable_text content = %#v", readEditable["content"])
	}
	if readEditable["sizeBytes"] != uint64(11) {
		t.Fatalf("fs.read_editable_text sizeBytes = %#v, want 11", readEditable["sizeBytes"])
	}

	readWorkspaceImage := websocketFsReadWorkspaceImageResponsePayload(&gatewayv1.FsReadWorkspaceImageResponse{
		Path:        "assets/preview.png",
		MimeType:    "image/png",
		Data:        "base64",
		SizeBytes:   6,
		MtimeMs:     42,
		ContentHash: "hash",
	})
	if readWorkspaceImage["mimeType"] != "image/png" {
		t.Fatalf("fs.read_workspace_image mimeType = %#v", readWorkspaceImage["mimeType"])
	}
	if readWorkspaceImage["sizeBytes"] != uint64(6) {
		t.Fatalf("fs.read_workspace_image sizeBytes = %#v, want 6", readWorkspaceImage["sizeBytes"])
	}
	if readWorkspaceImage["contentHash"] != "hash" {
		t.Fatalf("fs.read_workspace_image contentHash = %#v", readWorkspaceImage["contentHash"])
	}

	write := websocketFsWriteTextResponsePayload(&gatewayv1.FsWriteTextResponse{
		Path:          "src/new.ts",
		Mode:          "rewrite",
		ExistedBefore: false,
		BytesWritten:  12,
		MtimeMs:       42,
		ContentHash:   "hash",
		TotalLines:    1,
	})
	if write["existedBefore"] != false {
		t.Fatalf("fs.write_text existedBefore = %#v, want false", write["existedBefore"])
	}
	if write["bytesWritten"] != uint64(12) {
		t.Fatalf("fs.write_text bytesWritten = %#v, want 12", write["bytesWritten"])
	}
	if write["mtimeMs"] != uint64(42) {
		t.Fatalf("fs.write_text mtimeMs = %#v, want 42", write["mtimeMs"])
	}
	if write["totalLines"] != uint64(1) {
		t.Fatalf("fs.write_text totalLines = %#v, want 1", write["totalLines"])
	}

	createDir := websocketFsCreateDirResponsePayload(&gatewayv1.FsCreateDirResponse{
		Path: "src/new-folder",
		Kind: "dir",
	})
	if createDir["path"] != "src/new-folder" || createDir["kind"] != "dir" {
		t.Fatalf("fs.create_dir payload = %#v", createDir)
	}

	rename := websocketFsRenameResponsePayload(&gatewayv1.FsRenameResponse{
		FromPath: "src/old.ts",
		Path:     "src/new.ts",
		Kind:     "file",
	})
	if rename["fromPath"] != "src/old.ts" {
		t.Fatalf("fs.rename fromPath = %#v, want src/old.ts", rename["fromPath"])
	}
	if rename["path"] != "src/new.ts" || rename["kind"] != "file" {
		t.Fatalf("fs.rename payload = %#v", rename)
	}

	deletePayload := websocketFsDeleteResponsePayload(&gatewayv1.FsDeleteResponse{
		Path: "src/new.ts",
		Kind: "file",
	})
	if deletePayload["path"] != "src/new.ts" || deletePayload["kind"] != "file" {
		t.Fatalf("fs.delete payload = %#v", deletePayload)
	}
}
