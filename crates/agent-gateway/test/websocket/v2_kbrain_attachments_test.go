package websocket_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

// TestV2KBrainDirectImageAttachment imports an image through the shipped
// /api/files/import route for the direct K-brain target, submits it, and checks
// that K-brain receives it as a canonical image block.
func TestV2KBrainDirectImageAttachment(t *testing.T) {
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
	runBodies := make(chan map[string]any, 1)
	kbrainServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sessions":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprint(w, `{"version":"kbrain.agent.v1","id":"session-img"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/sessions/session-img/runs":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			runBodies <- body
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_, _ = fmt.Fprint(w, `{"version":"kbrain.agent.v1","conversation_id":"session-img","run_id":"kb-run-img","accepted_seq":1}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/sessions/session-img/events":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":1,\"conversation_id\":\"session-img\",\"run_id\":\"kb-run-img\",\"type\":\"run.completed\",\"payload\":{\"state\":\"completed\"}}\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	defer kbrainServer.Close()

	cfg := newV2TestConfig()
	cfg.KBrainURL = kbrainServer.URL
	cfg.KBrainAgentID = "kbrain"
	cfg.KBrainProvider = "fixture"
	cfg.KBrainModel = "fixture-model"
	handler := server.NewHTTPServer(cfg, session.NewManager(), nil)
	if closer, ok := handler.(io.Closer); ok {
		defer func() { _ = closer.Close() }()
	}

	var form bytes.Buffer
	writer := multipart.NewWriter(&form)
	_ = writer.WriteField("workdir", "/workspace")
	part, _ := writer.CreateFormFile("files", "pixel.png")
	_, _ = part.Write(png)
	_ = writer.Close()
	req := httptest.NewRequest(http.MethodPost, "http://gateway.test/api/files/import?agent_id=kbrain", &form)
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("import status = %d body=%s", rec.Code, rec.Body.String())
	}
	var imported struct {
		Files []struct {
			RelativePath string `json:"relativePath"`
			FileName     string `json:"fileName"`
			Kind         string `json:"kind"`
			SizeBytes    int64  `json:"sizeBytes"`
		} `json:"files"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &imported); err != nil || len(imported.Files) != 1 || imported.Files[0].Kind != "image" {
		t.Fatalf("imported = %s err=%v", rec.Body.String(), err)
	}
	file := imported.Files[0]

	browserConn, cleanup := dialV2Path(t, handler, "/ws/v2")
	defer cleanup()
	helloV2(t, browserConn, cfg.Token)
	sendProtoFrame(t, browserConn, &gatewayv2.WebClientFrame{
		RequestId: "command-img",
		AgentId:   cfg.KBrainAgentID,
		Payload: &gatewayv2.WebClientFrame_ChatCommand{ChatCommand: &gatewayv2.ChatCommandRequest{
			Type: "chat.submit",
			Request: &gatewayv2.ChatRequest{
				ConversationId:  "conv-img",
				ClientRequestId: "client-img-1",
				Message:         "What color is this pixel?",
				Workdir:         "/workspace",
				UploadedFiles:   []*gatewayv2.ChatUploadedFile{{RelativePath: file.RelativePath, FileName: file.FileName, Kind: file.Kind, SizeBytes: file.SizeBytes}},
			},
		}},
	})
	if accepted := receiveWebFrameWithID(t, browserConn, "command-img").GetChatAccepted(); accepted == nil {
		t.Fatal("chat command was not accepted")
	}
	var body map[string]any
	select {
	case body = <-runBodies:
	case <-time.After(2 * time.Second):
		t.Fatal("K-brain run was not started")
	}
	blocks, _ := body["content"].([]any)
	if body["prompt"] != "What color is this pixel?" || len(blocks) != 1 {
		t.Fatalf("run body = %+v", body)
	}
	block, _ := blocks[0].(map[string]any)
	if block["type"] != "image" || block["mime_type"] != "image/png" || !strings.HasPrefix(fmt.Sprint(block["image_url"]), "data:image/png;base64,") {
		t.Fatalf("image block = %+v", block)
	}
	if body["hook_policy"] != "backend" || body["hook_scope_id"] != "conv-img" {
		t.Fatalf("hook fields = %+v", body)
	}
}
