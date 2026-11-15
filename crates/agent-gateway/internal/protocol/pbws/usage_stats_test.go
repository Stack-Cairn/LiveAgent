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

// A browser on a direct K-brain target reads Settings → Usage through the gateway:
// the request is vetted, relayed to /v1/usage/stats, and K-brain's JSON comes back
// in usage_stats_resp.
func TestDirectKBrainUsageStatsOverWebSocket(t *testing.T) {
	statsQuery := make(chan string, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/health":
			_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1","capabilities":{"usage_stats":1}}`))
		case "/v1/usage/stats":
			statsQuery <- r.URL.RawQuery
			_, _ = w.Write([]byte(`{"timezone":"Europe/Berlin","days":371,"totals":{"total":9}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer backend.Close()
	cfg := &config.Config{Token: "gateway-token", KBrainURL: backend.URL, KBrainAgentID: "kbrain", KBrainProvider: "fixture", KBrainModel: "model", WebSocketWriteTimeout: time.Second, WebSocketWriteQueueSize: 64, WebSocketHeartbeatPeriod: time.Minute, WebSocketHeartbeatGrace: time.Minute}
	srv := NewServer(cfg, session.NewManager(), nil)
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

	usage := func(requestID string, req *gatewayv2.UsageStatsRequest) {
		write(&gatewayv2.WebClientFrame{RequestId: requestID, AgentId: "kbrain", Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_UsageStats{UsageStats: req},
		}}})
	}
	usage("stats", &gatewayv2.UsageStatsRequest{Days: 371, Timezone: "Europe/Berlin"})
	frame := read("stats")
	result := frame.GetAgentResponse().GetUsageStatsResp()
	if result == nil || result.GetUnsupported() || !strings.Contains(result.GetResultJson(), `"total":9`) {
		t.Fatalf("usage stats frame = %v", frame)
	}
	select {
	case query := <-statsQuery:
		if query != "days=371&tz=Europe%2FBerlin" {
			t.Fatalf("stats query = %q", query)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("usage stats request did not reach K-brain")
	}

	usage("bad", &gatewayv2.UsageStatsRequest{Days: 371, Timezone: "UTC&days=99999"})
	if message := read("bad").GetLocalError().GetMessage(); !strings.Contains(message, "timezone") {
		t.Fatalf("bad timezone error = %q", message)
	}
}
