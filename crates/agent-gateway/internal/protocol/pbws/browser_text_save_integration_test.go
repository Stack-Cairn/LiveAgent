package pbws

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/protobuf/proto"
)

func TestBrowserChunkSaveUsesNormalDispatchAndConflictResponse(t *testing.T) {
	content := strings.Repeat("猫\x00\n", 500000)
	writes := make(chan string, 4)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/health":
			_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1"}`))
		case "/v1/fs":
			var input struct {
				Path         string `json:"path"`
				Content      string `json:"content"`
				ExpectedHash string `json:"expected_content_hash"`
			}
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
				return
			}
			if input.Content != content || input.ExpectedHash != "original" {
				t.Error("dispatch lost assembled bytes or conflict guard")
			}
			writes <- input.Path
			if input.Path == "stale" {
				w.WriteHeader(http.StatusUnprocessableEntity)
				_, _ = w.Write([]byte(`{"error":"FILE_CONFLICT: destination changed"}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"path": input.Path, "bytes_written": len(input.Content), "content_hash": "saved"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer backend.Close()
	cfg := &config.Config{Token: "token", KBrainURL: backend.URL, KBrainAgentID: "kbrain", KBrainProvider: "fixture", KBrainModel: "model", WebSocketWriteTimeout: time.Second, WebSocketWriteQueueSize: 64, WebSocketHeartbeatPeriod: time.Minute, WebSocketHeartbeatGrace: time.Minute}
	srv := NewServer(cfg, session.NewManager(), nil)
	defer srv.kbrainRelay.Close()
	gateway := httptest.NewServer(srv.BrowserHandler())
	defer gateway.Close()
	dialer := websocket.Dialer{Subprotocols: []string{Subprotocol}}
	conn, _, err := dialer.Dial("ws"+strings.TrimPrefix(gateway.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	write := func(frame *gatewayv2.WebClientFrame) {
		t.Helper()
		data, err := proto.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		if frame.GetAgentRequestChunk() != nil && len(data) > maxTextSaveFrameBytes {
			t.Fatal("test exceeded per-chunk frame limit")
		}
		if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
			t.Fatal(err)
		}
	}
	read := func(id string) *gatewayv2.WebServerFrame {
		t.Helper()
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				t.Fatal(err)
			}
			var frame gatewayv2.WebServerFrame
			if err := proto.Unmarshal(data, &frame); err != nil {
				t.Fatal(err)
			}
			if frame.GetRequestId() == id {
				return &frame
			}
		}
	}
	write(&gatewayv2.WebClientFrame{RequestId: "hello", Payload: &gatewayv2.WebClientFrame_Hello{Hello: &gatewayv2.ClientHello{ProtocolVersion: ProtocolVersion, Token: cfg.Token}}})
	if hello := read("hello").GetHello(); !hello.GetOk() || hello.GetMaxMessageBytes() != browserReadLimit {
		t.Fatalf("browser limit changed or authentication failed: %v", hello)
	}
	for _, id := range []string{"first", "second", "stale"} {
		for offset := 0; offset < len(content); {
			end := offset + (900 << 10)
			if end > len(content) {
				end = len(content)
			}
			var metadata *gatewayv2.GatewayEnvelope
			if offset == 0 {
				metadata = textSaveMetadata(false)
				metadata.GetFsWriteText().Path = id
			}
			write(textSaveChunk(id, "kbrain", uint64(len(content)), uint64(offset), []byte(content[offset:end]), metadata))
			frame := read(id)
			if end < len(content) {
				if frame.GetAck() == nil {
					t.Fatalf("intermediate chunk did not ACK: %v", frame)
				}
				select {
				case <-writes:
					t.Fatal("partial upload reached backend")
				default:
				}
			} else {
				if id == "stale" {
					if !strings.Contains(frame.GetLocalError().GetMessage(), "FILE_CONFLICT") {
						t.Fatalf("conflict response lost: %v", frame)
					}
				} else if frame.GetAgentResponse().GetFsWriteTextResp().GetBytesWritten() != uint64(len(content)) {
					t.Fatalf("ordinary final response missing: %v", frame)
				}
				if path := <-writes; path != id {
					t.Fatalf("backend path = %q, want %q", path, id)
				}
			}
			offset = end
		}
	}
}
