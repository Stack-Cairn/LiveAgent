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
	"google.golang.org/protobuf/proto"
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
	largeContent := bytes.Repeat([]byte("a"), (1<<20)+17)
	if _, err := part.Write(largeContent); err != nil {
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

	var transferID string
	reconstructed := map[string][]byte{}
	chunkCount := 0
	for {
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
		if encodedSize := proto.Size(outbound); encodedSize > 2<<20 {
			t.Fatalf("encoded gateway envelope = %d bytes, want <= 2 MiB", encodedSize)
		}
		response := &gatewayv2.ImportDirectoryResponse{TransferId: importReq.GetTransferId()}
		switch importReq.GetOperation() {
		case gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_START:
			if importReq.GetName() != "demo" || importReq.GetTarget() != "workspace" {
				t.Fatalf("start request = %#v", importReq)
			}
			if importReq.GetTotalFiles() != 2 {
				t.Fatalf("total files = %d, want 2", importReq.GetTotalFiles())
			}
			if importReq.GetTotalBytes() != uint64(len(largeContent)+len("# demo")) {
				t.Fatalf("total bytes = %d", importReq.GetTotalBytes())
			}
			transferID = importReq.GetTransferId()
			if transferID == "" {
				t.Fatal("transfer id is empty")
			}
		case gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_WRITE_CHUNK:
			if importReq.GetTransferId() != transferID {
				t.Fatalf("chunk transfer id = %q, want %q", importReq.GetTransferId(), transferID)
			}
			if len(importReq.GetChunk()) > 1<<20 {
				t.Fatalf("chunk size = %d, want <= 1 MiB", len(importReq.GetChunk()))
			}
			path := importReq.GetRelativePath()
			if importReq.GetOffset() != uint64(len(reconstructed[path])) {
				t.Fatalf("chunk offset = %d, want %d", importReq.GetOffset(), len(reconstructed[path]))
			}
			reconstructed[path] = append(reconstructed[path], importReq.GetChunk()...)
			chunkCount++
		case gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_COMMIT:
			response.RootPath = "/home/user/.liveagent/imports/workspaces/demo"
			response.FileCount = 2
		default:
			t.Fatalf("unexpected import operation: %v", importReq.GetOperation())
		}

		sm.DispatchFromAgentForSession(agentSession, &gatewayv2.AgentEnvelope{
			RequestId: outbound.GetRequestId(),
			Timestamp: time.Now().Unix(),
			Payload: &gatewayv2.AgentEnvelope_ImportDirectoryResp{
				ImportDirectoryResp: response,
			},
		})
		if importReq.GetOperation() == gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_COMMIT {
			break
		}
	}
	if chunkCount != 3 {
		t.Fatalf("chunk count = %d, want 3", chunkCount)
	}
	if !bytes.Equal(reconstructed["src/main.rs"], largeContent) {
		t.Fatal("large file was not reconstructed from chunks")
	}
	if string(reconstructed["README.md"]) != "# demo" {
		t.Fatalf("README content = %q", reconstructed["README.md"])
	}

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
