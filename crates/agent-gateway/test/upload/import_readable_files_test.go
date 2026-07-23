package upload_test

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestImportReadableFilesForwardsMultipartToAgent(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot("desktop-agent"))
	sm.SetSession(agentSession)

	handler := server.NewHTTPServer(&config.Config{
		Token:          "upload-token",
		RequestTimeout: time.Second,
	}, sm, nil)

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("workdir", " /workspace/project "); err != nil {
		t.Fatalf("write workdir field: %v", err)
	}
	part, err := writer.CreateFormFile("files", "notes.txt")
	if err != nil {
		t.Fatalf("create file part: %v", err)
	}
	if _, err := io.WriteString(part, "hello from upload"); err != nil {
		t.Fatalf("write file part: %v", err)
	}
	part, err = writer.CreateFormFile("files", "tasks.md")
	if err != nil {
		t.Fatalf("create second file part: %v", err)
	}
	if _, err := io.WriteString(part, "# tasks"); err != nil {
		t.Fatalf("write second file part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "http://gateway.test/api/files/import?agent_id=desktop-agent", &body)
	req.Header.Set("Authorization", "Bearer upload-token")
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		defer close(done)
		handler.ServeHTTP(rec, req)
	}()

	var outbound *gatewayv2.GatewayEnvelope
	select {
	case delivered := <-agentSession.Outbound():
		delivered.Ack(nil)
		outbound = delivered.GatewayEnvelope
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for upload request to reach agent")
	}

	uploadReq := outbound.GetUploadReadableFiles()
	if uploadReq == nil {
		t.Fatalf("outbound payload = %T, want UploadReadableFilesRequest", outbound.GetPayload())
	}
	if uploadReq.GetWorkdir() != "/workspace/project" {
		t.Fatalf("workdir = %q, want trimmed workdir", uploadReq.GetWorkdir())
	}
	if len(uploadReq.GetFiles()) != 2 {
		t.Fatalf("files len = %d, want 2", len(uploadReq.GetFiles()))
	}
	file := uploadReq.GetFiles()[0]
	if file.GetFileName() != "notes.txt" {
		t.Fatalf("file name = %q, want notes.txt", file.GetFileName())
	}
	if string(file.GetContent()) != "hello from upload" {
		t.Fatalf("file content = %q", string(file.GetContent()))
	}
	secondFile := uploadReq.GetFiles()[1]
	if secondFile.GetFileName() != "tasks.md" {
		t.Fatalf("second file name = %q, want tasks.md", secondFile.GetFileName())
	}
	if string(secondFile.GetContent()) != "# tasks" {
		t.Fatalf("second file content = %q", string(secondFile.GetContent()))
	}

	sm.DispatchFromAgentForSession(agentSession, &gatewayv2.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv2.AgentEnvelope_UploadReadableFilesResp{
			UploadReadableFilesResp: &gatewayv2.UploadReadableFilesResponse{
				Files: []*gatewayv2.ChatUploadedFile{
					{
						RelativePath: "uploads/notes.txt",
						AbsolutePath: "/workspace/project/uploads/notes.txt",
						FileName:     "notes.txt",
						Kind:         "text",
						SizeBytes:    int64(len("hello from upload")),
					},
					{
						RelativePath: "uploads/tasks.md",
						AbsolutePath: "/workspace/project/uploads/tasks.md",
						FileName:     "tasks.md",
						Kind:         "text",
						SizeBytes:    int64(len("# tasks")),
					},
				},
				Skipped: []string{"ignored.bin"},
			},
		},
	})

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for HTTP response")
	}

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var payload struct {
		Files []struct {
			RelativePath string `json:"relativePath"`
			AbsolutePath string `json:"absolutePath"`
			FileName     string `json:"fileName"`
			Kind         string `json:"kind"`
			SizeBytes    int64  `json:"sizeBytes"`
		} `json:"files"`
		Skipped []string `json:"skipped"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(payload.Files) != 2 ||
		payload.Files[0].RelativePath != "uploads/notes.txt" ||
		payload.Files[1].RelativePath != "uploads/tasks.md" {
		t.Fatalf("files payload = %#v", payload.Files)
	}
	if len(payload.Skipped) != 1 || payload.Skipped[0] != "ignored.bin" {
		t.Fatalf("skipped payload = %#v", payload.Skipped)
	}
}

func TestImportReadableFilesRequiresAgentID(t *testing.T) {
	t.Parallel()

	handler := server.NewHTTPServer(&config.Config{
		Token:          "upload-token",
		RequestTimeout: time.Second,
	}, session.NewManager(), nil)

	req := httptest.NewRequest(http.MethodPost, "http://gateway.test/api/files/import", nil)
	req.Header.Set("Authorization", "Bearer upload-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("agent_id is required")) {
		t.Fatalf("body = %q, want agent_id validation error", rec.Body.String())
	}
}

func TestImportReadableFilesRejectsOfflineAgentBeforeParsing(t *testing.T) {
	t.Parallel()

	handler := server.NewHTTPServer(&config.Config{
		Token:          "upload-token",
		RequestTimeout: time.Second,
	}, session.NewManager(), nil)

	req := httptest.NewRequest(http.MethodPost, "http://gateway.test/api/files/import?agent_id=desktop-agent", nil)
	req.Header.Set("Authorization", "Bearer upload-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
	if rec.Body.String() == "" {
		t.Fatalf("expected JSON error body")
	}
}
