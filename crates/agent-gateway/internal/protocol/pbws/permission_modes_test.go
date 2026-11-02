package pbws

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	"github.com/liveagent/agent-gateway/internal/kbrain"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/protobuf/proto"
)

func TestKBrainPermissionModeTransport(t *testing.T) {
	for input, expected := range map[string]string{"ask": "normal", "autoEdit": "auto_edit", "autoReview": "auto_review", "auto": "always", "always": "always"} {
		body := handler.ChatRequestBody{CommandSafetyMode: input, ExecutionMode: "tools"}
		if got := kbrainOptions(body).PermissionMode; got != expected {
			t.Fatalf("%s: %s", input, got)
		}
		if got := handler.NormalizeCommandSafetyMode(input); got != input {
			t.Fatalf("normalization dropped %s", input)
		}
		plan := true
		body.RuntimeControls = &handler.ChatRuntimeControlsBody{PlanModeEnabled: &plan}
		options := kbrainOptions(body)
		if options.PermissionMode != "plan" || !options.PlanModeEnabled {
			t.Fatalf("plan restriction lost: %+v", options)
		}
	}
}

func TestExplicitPlanCommandOverridesRuntimeControls(t *testing.T) {
	plan := false
	options := kbrainOptions(handler.ChatRequestBody{
		PlanCommand: true, CommandSafetyMode: "auto",
		RuntimeControls: &handler.ChatRuntimeControlsBody{PlanModeEnabled: &plan},
	})
	if !options.PlanModeEnabled || options.PermissionMode != "plan" {
		t.Fatalf("explicit plan restriction lost: %+v", options)
	}
}

func TestPermissionModesOverWebSocketAndHTTP(t *testing.T) {
	for _, tc := range []struct{ selected, expected string }{
		{"ask", "normal"}, {"autoEdit", "auto_edit"}, {"autoReview", "auto_review"}, {"auto", "always"}, {"always", "always"}, {"plan", "plan"},
	} {
		t.Run(tc.selected, func(t *testing.T) {
			received := make(chan kbrain.PromptRequest, 1)
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v1/health":
					_, _ = w.Write([]byte(`{"status":"ok","version":"kbrain.agent.v1","capabilities":{"permission_modes":["always","auto_review","auto_edit"]}}`))
				case "/v1/sessions":
					w.WriteHeader(http.StatusCreated)
					_, _ = w.Write([]byte(`{"id":"backend-session"}`))
				case "/v1/sessions/backend-session/runs":
					var request kbrain.PromptRequest
					if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
						t.Error(err)
					}
					received <- request
					w.WriteHeader(http.StatusAccepted)
					_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","conversation_id":"backend-session","run_id":"backend-run","accepted_seq":1}`))
				case "/v1/sessions/backend-session/events":
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = fmt.Fprint(w, "data: {\"version\":\"kbrain.agent.v1\",\"seq\":1,\"conversation_id\":\"backend-session\",\"run_id\":\"backend-run\",\"type\":\"run.completed\",\"payload\":{\"state\":\"completed\"}}\n\n")
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
			write(&gatewayv2.WebClientFrame{RequestId: "hello", Payload: &gatewayv2.WebClientFrame_Hello{Hello: &gatewayv2.ClientHello{ProtocolVersion: ProtocolVersion, Token: cfg.Token}}})
			_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			if _, _, err := conn.ReadMessage(); err != nil {
				t.Fatal(err)
			}
			request := &gatewayv2.ChatRequest{ConversationId: "conversation", ClientRequestId: "stable-request", Message: "hello", ExecutionMode: "tools", CommandSafetyMode: tc.selected}
			if tc.selected == "plan" {
				request.CommandSafetyMode = "always"
				request.RuntimeControls = &gatewayv2.ChatRuntimeControls{PlanModeEnabled: true}
			}
			write(&gatewayv2.WebClientFrame{RequestId: "submit", AgentId: "kbrain", Payload: &gatewayv2.WebClientFrame_ChatCommand{ChatCommand: &gatewayv2.ChatCommandRequest{Type: "chat.submit", Request: request}}})
			select {
			case got := <-received:
				if got.ClientRequestID != "stable-request" || got.Options == nil || got.Options.PermissionMode != tc.expected {
					t.Fatalf("mode/identity lost across WS+HTTP: %+v", got)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("WebSocket command did not reach backend HTTP")
			}
			for {
				_, data, err := conn.ReadMessage()
				if err != nil {
					t.Fatal(err)
				}
				var response gatewayv2.WebServerFrame
				if err := proto.Unmarshal(data, &response); err != nil {
					t.Fatal(err)
				}
				if response.GetChatAccepted() != nil {
					if response.GetRequestId() != "submit" {
						t.Fatal("WebSocket acceptance lost request identity")
					}
					break
				}
			}
		})
	}
}
