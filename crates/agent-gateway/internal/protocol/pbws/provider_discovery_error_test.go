package pbws

import (
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

// A failed model discovery reaches the WebUI with K-brain's reason (errorCode,
// upstreamStatus, upstreamMessage) next to the generic error text, so the
// provider editor can say "API key was rejected (401)"; an older backend that
// only sends {"error": ...} keeps the plain message.
func TestProviderDiscoveryFailureForwardsReasonOverWebSocket(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/health":
			_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1","capabilities":{}}`))
		case "/v1/settings/providers/new/models":
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":"model discovery failed","errorCode":"invalid_api_key","upstreamStatus":401,"upstreamMessage":"Incorrect API key provided: sk-bad***.","version":"kbrain.agent.v1"}`))
		case "/v1/settings/providers/old/models":
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":"model discovery failed","version":"kbrain.agent.v1"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer backend.Close()
	cfg := &config.Config{Token: "gateway-token", KBrainURL: backend.URL, KBrainAgentID: "kbrain", KBrainProvider: "fixture", KBrainModel: "model", WebSocketWriteTimeout: time.Second, WebSocketWriteQueueSize: 64, WebSocketHeartbeatPeriod: time.Minute, WebSocketHeartbeatGrace: time.Minute}
	gateway := httptest.NewServer(NewServer(cfg, session.NewManager(), nil).BrowserHandler())
	defer gateway.Close()
	conn, _, err := (&websocket.Dialer{Subprotocols: []string{Subprotocol}}).Dial("ws"+strings.TrimPrefix(gateway.URL, "http"), nil)
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
		if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
			t.Fatal(err)
		}
	}
	read := func(requestID string) *gatewayv2.WebServerFrame {
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
			if frame.GetRequestId() == requestID {
				return &frame
			}
		}
	}
	write(&gatewayv2.WebClientFrame{RequestId: "hello", Payload: &gatewayv2.WebClientFrame_Hello{Hello: &gatewayv2.ClientHello{ProtocolVersion: ProtocolVersion, Token: cfg.Token}}})
	read("hello")
	discover := func(providerID string) *gatewayv2.ErrorResponse {
		write(&gatewayv2.WebClientFrame{RequestId: providerID, AgentId: "kbrain", Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_ProviderModels{ProviderModels: &gatewayv2.ProviderModelsRequest{ProviderId: providerID, ProviderType: "codex", BaseUrl: "https://models.example.invalid/v1", ApiKey: "sk-bad-key"}},
		}}})
		frame := read(providerID)
		if frame.GetLocalError() == nil {
			t.Fatalf("%s: frame = %v, want a local error", providerID, frame)
		}
		return frame.GetLocalError()
	}

	failure := discover("new")
	if !strings.Contains(failure.GetMessage(), "model discovery failed") || failure.GetErrorCode() != "invalid_api_key" || failure.GetUpstreamStatus() != 401 || failure.GetUpstreamMessage() != "Incorrect API key provided: sk-bad***." {
		t.Fatalf("failure = %v", failure)
	}
	old := discover("old")
	if !strings.Contains(old.GetMessage(), "model discovery failed") || old.GetErrorCode() != "" || old.GetUpstreamStatus() != 0 || old.GetUpstreamMessage() != "" {
		t.Fatalf("old backend failure = %v", old)
	}
}
