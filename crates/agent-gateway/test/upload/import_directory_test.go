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

func newDirectoryImportServer(t *testing.T, requestTimeout time.Duration) (*session.Manager, *session.AgentSession, http.Handler) {
	t.Helper()
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot("desktop-agent"))
	sm.SetSession(agentSession)

	handler := server.NewHTTPServer(&config.Config{
		Token:          "upload-token",
		RequestTimeout: requestTimeout,
	}, sm, nil)
	return sm, agentSession, handler
}

func TestImportDirectoryForwardsRelativePathsToAgent(t *testing.T) {
	t.Parallel()

	sm, agentSession, handler := newDirectoryImportServer(t, time.Second)

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

	_, _, handler := newDirectoryImportServer(t, time.Second)

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

// 目录总量越过网关/桌面端默认的 64 MiB WebSocket 消息上限时，必须仍以小块
// envelope 流式送达；回归保护：整包发送会在 Agent 侧超限断连（PR #484 评审）。
func TestImportDirectoryStreamsPayloadBeyondMessageLimit(t *testing.T) {
	t.Parallel()
	if testing.Short() {
		t.Skip("skipping 64 MiB+ end-to-end import in short mode")
	}

	// 几十次 chunk 往返共用同一个整体超时；放宽以免慢 CI 抖动。
	sm, agentSession, handler := newDirectoryImportServer(t, 30*time.Second)

	const totalSize = (65 << 20) + 17
	if totalSize <= config.DefaultMaxMessageBytes {
		t.Fatalf("fixture size %d must exceed the %d-byte message limit", totalSize, config.DefaultMaxMessageBytes)
	}
	content := make([]byte, totalSize)
	for i := range content {
		content[i] = byte(i % 251)
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("name", "bigdir"); err != nil {
		t.Fatalf("write name field: %v", err)
	}
	if err := writer.WriteField("target", "workspace"); err != nil {
		t.Fatalf("write target field: %v", err)
	}
	part, err := writer.CreateFormFile("files", "blob.bin")
	if err != nil {
		t.Fatalf("create file part: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write file part: %v", err)
	}
	if err := writer.WriteField("paths", "assets/blob.bin"); err != nil {
		t.Fatalf("write path field: %v", err)
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
	var receivedBytes uint64
	chunkCount := 0
	fileCompleted := false
	for {
		var outbound *gatewayv2.GatewayEnvelope
		select {
		case delivered := <-agentSession.Outbound():
			delivered.Ack(nil)
			outbound = delivered.GatewayEnvelope
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for directory import to reach agent (chunks so far: %d)", chunkCount)
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
			if importReq.GetTotalFiles() != 1 {
				t.Fatalf("total files = %d, want 1", importReq.GetTotalFiles())
			}
			if importReq.GetTotalBytes() != uint64(totalSize) {
				t.Fatalf("total bytes = %d, want %d", importReq.GetTotalBytes(), totalSize)
			}
			transferID = importReq.GetTransferId()
			if transferID == "" {
				t.Fatal("transfer id is empty")
			}
		case gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_WRITE_CHUNK:
			if importReq.GetTransferId() != transferID {
				t.Fatalf("chunk transfer id = %q, want %q", importReq.GetTransferId(), transferID)
			}
			if importReq.GetRelativePath() != "assets/blob.bin" {
				t.Fatalf("chunk path = %q", importReq.GetRelativePath())
			}
			chunk := importReq.GetChunk()
			if len(chunk) == 0 || len(chunk) > 1<<20 {
				t.Fatalf("chunk size = %d, want 1..1 MiB", len(chunk))
			}
			if importReq.GetOffset() != receivedBytes {
				t.Fatalf("chunk offset = %d, want %d", importReq.GetOffset(), receivedBytes)
			}
			end := receivedBytes + uint64(len(chunk))
			if end > totalSize {
				t.Fatalf("chunk end = %d overruns total size %d", end, totalSize)
			}
			if !bytes.Equal(chunk, content[receivedBytes:end]) {
				t.Fatalf("chunk content mismatch at offset %d", receivedBytes)
			}
			receivedBytes = end
			chunkCount++
			if importReq.GetFileComplete() {
				fileCompleted = true
				if receivedBytes != totalSize {
					t.Fatalf("file completed at %d bytes, want %d", receivedBytes, totalSize)
				}
			}
		case gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_COMMIT:
			response.RootPath = "/home/user/.liveagent/imports/workspaces/bigdir"
			response.FileCount = 1
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

	wantChunks := (totalSize + (1 << 20) - 1) / (1 << 20)
	if chunkCount != wantChunks {
		t.Fatalf("chunk count = %d, want %d", chunkCount, wantChunks)
	}
	if receivedBytes != totalSize {
		t.Fatalf("received bytes = %d, want %d", receivedBytes, totalSize)
	}
	if !fileCompleted {
		t.Fatal("final chunk did not mark the file complete")
	}

	<-done

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		RootPath  string `json:"rootPath"`
		FileCount int32  `json:"fileCount"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.RootPath != "/home/user/.liveagent/imports/workspaces/bigdir" {
		t.Fatalf("rootPath = %q", payload.RootPath)
	}
	if payload.FileCount != 1 {
		t.Fatalf("fileCount = %d, want 1", payload.FileCount)
	}
}

// RequestTimeout 是单次往返的空闲超时而非整个传输的绝对上限：只要每个
// chunk 都在推进，累计耗时超过 RequestTimeout 的传输也必须成功（回归保护：
// 旧实现整个传输复用同一个 context.WithTimeout，大目录在慢链路上会被整体取消）。
func TestImportDirectorySurvivesSlowChunkAcks(t *testing.T) {
	t.Parallel()
	if testing.Short() {
		t.Skip("skipping slow-ack import test in short mode")
	}

	const requestTimeout = time.Second
	const ackDelay = 300 * time.Millisecond
	sm, agentSession, handler := newDirectoryImportServer(t, requestTimeout)

	// 4 个 chunk + START + COMMIT = 6 次往返；按 ackDelay 累计 1.8s，
	// 显著超过 1s 的 RequestTimeout，逼出"绝对超时"回归。
	const totalSize = (3 << 20) + 17
	content := bytes.Repeat([]byte("s"), totalSize)

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("name", "slowdir"); err != nil {
		t.Fatalf("write name field: %v", err)
	}
	if err := writer.WriteField("target", "workspace"); err != nil {
		t.Fatalf("write target field: %v", err)
	}
	part, err := writer.CreateFormFile("files", "blob.bin")
	if err != nil {
		t.Fatalf("create file part: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write file part: %v", err)
	}
	if err := writer.WriteField("paths", "blob.bin"); err != nil {
		t.Fatalf("write path field: %v", err)
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

	started := time.Now()
	var receivedBytes uint64
	roundTrips := 0
	for {
		var outbound *gatewayv2.GatewayEnvelope
		select {
		case delivered := <-agentSession.Outbound():
			delivered.Ack(nil)
			outbound = delivered.GatewayEnvelope
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for directory import to reach agent (round trips so far: %d)", roundTrips)
		}
		roundTrips++

		importReq := outbound.GetImportDirectory()
		if importReq == nil {
			t.Fatalf("outbound payload = %T, want ImportDirectoryRequest", outbound.GetPayload())
		}
		if importReq.GetOperation() == gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_ABORT {
			t.Fatalf("transfer was aborted after %d round trips (%s elapsed)", roundTrips, time.Since(started))
		}
		if importReq.GetOperation() == gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_WRITE_CHUNK {
			receivedBytes += uint64(len(importReq.GetChunk()))
		}

		time.Sleep(ackDelay)

		response := &gatewayv2.ImportDirectoryResponse{TransferId: importReq.GetTransferId()}
		if importReq.GetOperation() == gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_COMMIT {
			response.RootPath = "/home/user/.liveagent/imports/workspaces/slowdir"
			response.FileCount = 1
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

	if elapsed := time.Since(started); elapsed <= requestTimeout {
		t.Fatalf("transfer finished in %s, too fast to exercise the absolute-timeout regression", elapsed)
	}
	if receivedBytes != totalSize {
		t.Fatalf("received bytes = %d, want %d", receivedBytes, totalSize)
	}

	<-done

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestImportDirectoryRequiresName(t *testing.T) {
	t.Parallel()

	_, _, handler := newDirectoryImportServer(t, time.Second)

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
