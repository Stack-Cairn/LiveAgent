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

func newDirectoryImportServer(t *testing.T) (*session.Manager, *session.AgentSession, http.Handler) {
	t.Helper()
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot("desktop-agent"))
	sm.SetSession(agentSession)

	handler := server.NewHTTPServer(&config.Config{
		Token:          "upload-token",
		RequestTimeout: time.Second,
	}, sm, nil)
	return sm, agentSession, handler
}

func TestImportDirectoryForwardsRelativePathsToAgent(t *testing.T) {
	t.Parallel()

	sm, agentSession, handler := newDirectoryImportServer(t)

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("name", " demo "); err != nil {
		t.Fatalf("write name field: %v", err)
	}
	if err := writer.WriteField("target", "workspace"); err != nil {
		t.Fatalf("write target field: %v", err)
	}
	part, err := writer.CreateFormFile("files", "main.rs")
	if err != nil {
		t.Fatalf("create file part: %v", err)
	}
	if _, err := io.WriteString(part, "fn main() {}"); err != nil {
		t.Fatalf("write file part: %v", err)
	}
	if err := writer.WriteField("paths", "src/main.rs"); err != nil {
		t.Fatalf("write first path field: %v", err)
	}
	part, err = writer.CreateFormFile("files", "README.md")
	if err != nil {
		t.Fatalf("create second file part: %v", err)
	}
	if _, err := io.WriteString(part, "# demo"); err != nil {
		t.Fatalf("write second file part: %v", err)
	}
	if err := writer.WriteField("paths", "README.md"); err != nil {
		t.Fatalf("write second path field: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "http://gateway.test/api/files/import-directory?agent_id=desktop-agent", &body)
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
		t.Fatalf("timed out waiting for directory import to reach agent")
	}

	importReq := outbound.GetImportDirectory()
	if importReq == nil {
		t.Fatalf("outbound payload = %T, want ImportDirectoryRequest", outbound.GetPayload())
	}
	if importReq.GetName() != "demo" {
		t.Fatalf("name = %q, want trimmed name", importReq.GetName())
	}
	if importReq.GetTarget() != "workspace" {
		t.Fatalf("target = %q, want workspace", importReq.GetTarget())
	}
	if len(importReq.GetFiles()) != 2 {
		t.Fatalf("files len = %d, want 2", len(importReq.GetFiles()))
	}
	if importReq.GetFiles()[0].GetRelativePath() != "src/main.rs" {
		t.Fatalf("relative path = %q, want src/main.rs", importReq.GetFiles()[0].GetRelativePath())
	}
	if string(importReq.GetFiles()[0].GetContent()) != "fn main() {}" {
		t.Fatalf("content = %q", string(importReq.GetFiles()[0].GetContent()))
	}

	sm.DispatchFromAgentForSession(agentSession, &gatewayv2.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv2.AgentEnvelope_ImportDirectoryResp{
			ImportDirectoryResp: &gatewayv2.ImportDirectoryResponse{
				RootPath:  "/home/user/.liveagent/imports/workspaces/demo",
				FileCount: 2,
				Skipped:   nil,
			},
		},
	})

	<-done

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		RootPath  string   `json:"rootPath"`
		FileCount int32    `json:"fileCount"`
		Skipped   []string `json:"skipped"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.RootPath != "/home/user/.liveagent/imports/workspaces/demo" {
		t.Fatalf("rootPath = %q", payload.RootPath)
	}
	if payload.FileCount != 2 {
		t.Fatalf("fileCount = %d, want 2", payload.FileCount)
	}
}

func TestImportDirectoryRejectsUnknownTarget(t *testing.T) {
	t.Parallel()

	_, _, handler := newDirectoryImportServer(t)

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("name", "demo"); err != nil {
		t.Fatalf("write name field: %v", err)
	}
	if err := writer.WriteField("target", "somewhere"); err != nil {
		t.Fatalf("write target field: %v", err)
	}
	part, err := writer.CreateFormFile("files", "a.txt")
	if err != nil {
		t.Fatalf("create file part: %v", err)
	}
	if _, err := io.WriteString(part, "a"); err != nil {
		t.Fatalf("write file part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "http://gateway.test/api/files/import-directory?agent_id=desktop-agent", &body)
	req.Header.Set("Authorization", "Bearer upload-token")
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body = %s)", rec.Code, rec.Body.String())
	}
}

func TestImportDirectoryRequiresName(t *testing.T) {
	t.Parallel()

	_, _, handler := newDirectoryImportServer(t)

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("target", "workspace"); err != nil {
		t.Fatalf("write target field: %v", err)
	}
	part, err := writer.CreateFormFile("files", "a.txt")
	if err != nil {
		t.Fatalf("create file part: %v", err)
	}
	if _, err := io.WriteString(part, "a"); err != nil {
		t.Fatalf("write file part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "http://gateway.test/api/files/import-directory?agent_id=desktop-agent", &body)
	req.Header.Set("Authorization", "Bearer upload-token")
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body = %s)", rec.Code, rec.Body.String())
	}
}
