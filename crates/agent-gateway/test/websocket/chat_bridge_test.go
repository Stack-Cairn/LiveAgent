package websocket_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/websocket"

	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

type wsEnvelope struct {
	ID      string          `json:"id,omitempty"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Error   string          `json:"error,omitempty"`
}

func dialGatewayWebSocket(t *testing.T, handler http.Handler) (*websocket.Conn, func()) {
	t.Helper()
	ts := httptest.NewServer(handler)
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	conn, err := websocket.Dial(wsURL, "", "http://gateway.test/")
	if err != nil {
		ts.Close()
		t.Fatalf("dial websocket: %v", err)
	}
	return conn, func() {
		_ = conn.Close()
		ts.Close()
	}
}

func sendEnvelope(t *testing.T, conn *websocket.Conn, id string, typ string, payload any) {
	t.Helper()
	env := map[string]any{
		"id":   id,
		"type": typ,
	}
	if payload != nil {
		env["payload"] = payload
	}
	if err := websocket.JSON.Send(conn, env); err != nil {
		t.Fatalf("send %s: %v", typ, err)
	}
}

func receiveEnvelope(t *testing.T, conn *websocket.Conn) wsEnvelope {
	t.Helper()
	if err := conn.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set websocket deadline: %v", err)
	}
	var env wsEnvelope
	if err := websocket.JSON.Receive(conn, &env); err != nil {
		t.Fatalf("receive websocket envelope: %v", err)
	}
	return env
}

func receiveEnvelopeWithID(t *testing.T, conn *websocket.Conn, id string) wsEnvelope {
	t.Helper()
	for attempt := 0; attempt < 4; attempt += 1 {
		env := receiveEnvelope(t, conn)
		if env.ID == id {
			return env
		}
	}
	t.Fatalf("timed out waiting for websocket envelope id %q", id)
	return wsEnvelope{}
}

func authWebSocket(t *testing.T, conn *websocket.Conn, token string) {
	t.Helper()
	sendEnvelope(t, conn, "auth-1", "auth", map[string]any{"token": token})
	env := receiveEnvelope(t, conn)
	if env.ID != "auth-1" || env.Type != "response" {
		t.Fatalf("auth envelope = %#v, want response for auth-1", env)
	}
}

func readOutboundEnvelope(t *testing.T, agentSession *session.AgentSession) *gatewayv1.GatewayEnvelope {
	t.Helper()
	select {
	case outbound := <-agentSession.Outbound():
		return outbound
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for gateway request to reach agent")
		return nil
	}
}

func TestWebSocketRejectsRequestsBeforeAuth(t *testing.T) {
	t.Parallel()

	conn, cleanup := dialGatewayWebSocket(
		t,
		server.NewWebSocketServer(&config.Config{Token: "ws-token"}, session.NewManager()),
	)
	defer cleanup()

	sendEnvelope(t, conn, "status-1", "status.get", map[string]any{})
	env := receiveEnvelope(t, conn)

	if env.ID != "status-1" || env.Type != "error" || env.Error != "unauthorized" {
		t.Fatalf("envelope = %#v, want unauthorized error", env)
	}
}

func TestWebSocketChatStartForwardsNormalizedRequestAndStreamsEvents(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := server.NewWebSocketServer(&config.Config{
		Token:          "ws-token",
		RequestTimeout: time.Second,
	}, sm)
	conn, cleanup := dialGatewayWebSocket(t, handler)
	defer cleanup()

	authWebSocket(t, conn, "ws-token")
	sendEnvelope(t, conn, "chat-1", "chat.start", map[string]any{
		"conversation_id":   " conversation-1 ",
		"client_request_id": " client-submit-1 ",
		"message":           " hello gateway ",
		"execution_mode":    "agent-dev",
		"workdir":           " /workspace/project ",
		"selected_system_tools": []string{
			" http_get_test ",
			"unknown",
			"http_get_test",
		},
		"selected_model": map[string]any{
			"custom_provider_id": " claude-provider ",
			"model":              " claude-test ",
			"provider_type":      "claude_code",
		},
		"runtime_controls": map[string]any{
			"thinking_enabled":          false,
			"native_web_search_enabled": true,
			"reasoning":                 " xhigh ",
		},
		"uploaded_files": []map[string]any{
			{
				"relative_path": " uploads/notes.txt ",
				"absolute_path": " /workspace/project/uploads/notes.txt ",
				"file_name":     " notes.txt ",
				"kind":          "text",
				"size_bytes":    128,
			},
			{
				"relative_path": " uploads/screenshot.webp ",
				"absolute_path": " /workspace/project/uploads/screenshot.webp ",
				"file_name":     " screenshot.webp ",
				"kind":          "image",
				"size_bytes":    256,
			},
			{
				"relative_path": " uploads/report.pdf ",
				"absolute_path": " /workspace/project/uploads/report.pdf ",
				"file_name":     " report.pdf ",
				"kind":          "pdf",
				"size_bytes":    512,
			},
			{
				"relative_path": "bad.bin",
				"file_name":     "bad.bin",
				"kind":          "binary",
				"size_bytes":    64,
			},
		},
	})

	var outbound *gatewayv1.GatewayEnvelope
	select {
	case outbound = <-agentSession.Outbound():
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for chat request to reach agent")
	}

	chatReq := outbound.GetChatRequest()
	if chatReq == nil {
		t.Fatalf("outbound payload = %T, want ChatRequest", outbound.GetPayload())
	}
	if chatReq.GetMessage() != "hello gateway" {
		t.Fatalf("message = %q, want trimmed message", chatReq.GetMessage())
	}
	if chatReq.GetConversationId() != "conversation-1" {
		t.Fatalf("conversation_id = %q", chatReq.GetConversationId())
	}
	if chatReq.GetClientRequestId() != "client-submit-1" {
		t.Fatalf("client_request_id = %q", chatReq.GetClientRequestId())
	}
	if chatReq.GetExecutionMode() != "agent-dev" || chatReq.GetWorkdir() != "/workspace/project" {
		t.Fatalf("execution/workdir = %q/%q", chatReq.GetExecutionMode(), chatReq.GetWorkdir())
	}
	if got := chatReq.GetSelectedSystemTools(); len(got) != 1 || got[0] != "http_get_test" {
		t.Fatalf("selected tools = %#v, want deduped http_get_test", got)
	}
	if chatReq.GetSelectedModel().GetCustomProviderId() != "claude-provider" ||
		chatReq.GetSelectedModel().GetModel() != "claude-test" ||
		chatReq.GetSelectedModel().GetProviderType() != "claude_code" {
		t.Fatalf("selected model = %#v", chatReq.GetSelectedModel())
	}
	if chatReq.GetRuntimeControls().GetThinkingEnabled() ||
		!chatReq.GetRuntimeControls().GetNativeWebSearchEnabled() ||
		chatReq.GetRuntimeControls().GetReasoning() != "xhigh" {
		t.Fatalf("runtime controls = %#v", chatReq.GetRuntimeControls())
	}
	files := chatReq.GetUploadedFiles()
	if len(files) != 3 {
		t.Fatalf("uploaded files = %#v", files)
	}
	if files[0].GetRelativePath() != "uploads/notes.txt" ||
		files[0].GetKind() != "text" ||
		files[1].GetRelativePath() != "uploads/screenshot.webp" ||
		files[1].GetKind() != "image" ||
		files[2].GetRelativePath() != "uploads/report.pdf" ||
		files[2].GetKind() != "pdf" {
		t.Fatalf("uploaded files = %#v", files)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"hello back","round":1}`,
			},
		},
	})
	tokenEvent := receiveEnvelope(t, conn)
	if tokenEvent.ID != "chat-1" || tokenEvent.Type != "chat.event" {
		t.Fatalf("token envelope = %#v, want chat.event", tokenEvent)
	}
	var tokenPayload map[string]any
	if err := json.Unmarshal(tokenEvent.Payload, &tokenPayload); err != nil {
		t.Fatalf("decode token payload: %v", err)
	}
	if tokenPayload["type"] != "token" || tokenPayload["text"] != "hello back" || tokenPayload["conversation_id"] != "conversation-1" {
		t.Fatalf("token payload = %#v", tokenPayload)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_DONE,
				ConversationId: "conversation-1",
				Data:           `{"title":"Done"}`,
			},
		},
	})
	doneEvent := receiveEnvelope(t, conn)
	if doneEvent.ID != "chat-1" || doneEvent.Type != "chat.event" {
		t.Fatalf("done envelope = %#v, want chat.event", doneEvent)
	}
	var donePayload map[string]any
	if err := json.Unmarshal(doneEvent.Payload, &donePayload); err != nil {
		t.Fatalf("decode done payload: %v", err)
	}
	if donePayload["type"] != "done" || donePayload["title"] != "Done" {
		t.Fatalf("done payload = %#v", donePayload)
	}
}

func TestWebSocketChatStartDedupesClientRequestID(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := server.NewWebSocketServer(&config.Config{
		Token:          "ws-token",
		RequestTimeout: time.Second,
	}, sm)
	conn, cleanup := dialGatewayWebSocket(t, handler)
	defer cleanup()

	authWebSocket(t, conn, "ws-token")
	sendEnvelope(t, conn, "chat-1", "chat.start", map[string]any{
		"client_request_id": "client-submit-1",
		"message":           "hello gateway",
	})

	outbound := readOutboundEnvelope(t, agentSession)
	if outbound.GetRequestId() != "chat-1" {
		t.Fatalf("first outbound request id = %q, want chat-1", outbound.GetRequestId())
	}
	if outbound.GetChatRequest().GetClientRequestId() != "client-submit-1" {
		t.Fatalf(
			"first outbound client_request_id = %q",
			outbound.GetChatRequest().GetClientRequestId(),
		)
	}

	sendEnvelope(t, conn, "chat-2", "chat.start", map[string]any{
		"client_request_id": "client-submit-1",
		"message":           "hello gateway",
	})

	select {
	case duplicate := <-agentSession.Outbound():
		t.Fatalf("unexpected duplicate outbound chat request: %#v", duplicate)
	case <-time.After(100 * time.Millisecond):
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"shared event"}`,
			},
		},
	})

	eventsByID := make(map[string]wsEnvelope, 2)
	for len(eventsByID) < 2 {
		event := receiveEnvelope(t, conn)
		if event.Type != "chat.event" {
			t.Fatalf("event = %#v, want chat.event", event)
		}
		if event.ID != "chat-1" && event.ID != "chat-2" {
			t.Fatalf("event id = %q, want chat-1 or chat-2", event.ID)
		}
		eventsByID[event.ID] = event
	}
	for _, id := range []string{"chat-1", "chat-2"} {
		event := eventsByID[id]
		if event.ID == "" {
			t.Fatalf("missing chat event for %s", id)
		}
		var payload map[string]any
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatalf("decode payload for %s: %v", id, err)
		}
		if payload["text"] != "shared event" || payload["conversation_id"] != "conversation-1" {
			t.Fatalf("payload for %s = %#v", id, payload)
		}
	}
}

func TestWebSocketChatStartFailsWhenAgentSessionDisconnects(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := server.NewWebSocketServer(&config.Config{
		Token:          "ws-token",
		RequestTimeout: time.Second,
	}, sm)
	conn, cleanup := dialGatewayWebSocket(t, handler)
	defer cleanup()

	authWebSocket(t, conn, "ws-token")
	sendEnvelope(t, conn, "chat-1", "chat.start", map[string]any{
		"conversation_id":   "conversation-1",
		"client_request_id": "client-submit-1",
		"message":           "hello gateway",
	})

	outbound := readOutboundEnvelope(t, agentSession)
	if outbound.GetRequestId() != "chat-1" {
		t.Fatalf("outbound request id = %q, want chat-1", outbound.GetRequestId())
	}

	sm.ClearSession(agentSession)
	event := receiveEnvelope(t, conn)
	if event.ID != "chat-1" || event.Type != "chat.event" {
		t.Fatalf("disconnect event = %#v, want chat.event for chat-1", event)
	}
	var payload map[string]any
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("decode disconnect event: %v", err)
	}
	if payload["type"] != "error" ||
		payload["conversation_id"] != "conversation-1" ||
		!strings.Contains(fmt.Sprint(payload["message"]), "Desktop agent disconnected") {
		t.Fatalf("disconnect payload = %#v", payload)
	}
	if got := sm.ActiveChatRunConversationIDs(); len(got) != 0 {
		t.Fatalf("active chat runs after disconnect = %#v, want empty", got)
	}

	replacementSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(replacementSession)
	sendEnvelope(t, conn, "chat-2", "chat.start", map[string]any{
		"conversation_id":   "conversation-1",
		"client_request_id": "client-submit-1",
		"message":           "retry after reconnect",
	})
	retryOutbound := readOutboundEnvelope(t, replacementSession)
	if retryOutbound.GetRequestId() != "chat-2" {
		t.Fatalf("retry outbound request id = %q, want chat-2", retryOutbound.GetRequestId())
	}
}

func TestWebSocketMemoryManageForwardsJSONArgs(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := server.NewWebSocketServer(&config.Config{
		Token:          "ws-token",
		RequestTimeout: time.Second,
	}, sm)
	conn, cleanup := dialGatewayWebSocket(t, handler)
	defer cleanup()

	authWebSocket(t, conn, "ws-token")
	sendEnvelope(t, conn, "memory-1", "memory.manage", map[string]any{
		"command": "memory_search",
		"args": map[string]any{
			"query": "Kevin",
			"limit": 3,
		},
	})

	outbound := readOutboundEnvelope(t, agentSession)
	req := outbound.GetMemoryManage()
	if req == nil {
		t.Fatalf("outbound payload = %T, want MemoryManageRequest", outbound.GetPayload())
	}
	if req.GetCommand() != "memory_search" {
		t.Fatalf("memory command = %q", req.GetCommand())
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(req.GetArgsJson()), &args); err != nil {
		t.Fatalf("decode args_json: %v", err)
	}
	if args["query"] != "Kevin" || args["limit"] != float64(3) {
		t.Fatalf("args_json = %#v", args)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_MemoryManageResp{
			MemoryManageResp: &gatewayv1.MemoryManageResponse{
				ResultJson: `{"matches":[],"usedFallback":false}`,
			},
		},
	})

	env := receiveEnvelope(t, conn)
	if env.ID != "memory-1" || env.Type != "response" {
		t.Fatalf("memory response envelope = %#v, want response", env)
	}
	var payload map[string]any
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		t.Fatalf("decode memory response payload: %v", err)
	}
	if matches, ok := payload["matches"].([]any); !ok || len(matches) != 0 || payload["usedFallback"] != false {
		t.Fatalf("memory response payload = %#v", payload)
	}
}

func TestWebSocketChatResumeReplaysEventsAfterReconnect(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := server.NewWebSocketServer(&config.Config{
		Token:           "ws-token",
		RequestTimeout:  time.Second,
		HeartbeatPeriod: time.Hour,
	}, sm)
	conn1, cleanup1 := dialGatewayWebSocket(t, handler)
	defer cleanup1()

	authWebSocket(t, conn1, "ws-token")
	sendEnvelope(t, conn1, "chat-1", "chat.start", map[string]any{
		"conversation_id": "conversation-1",
		"message":         "hello gateway",
	})

	outbound := readOutboundEnvelope(t, agentSession)
	if outbound.GetRequestId() != "chat-1" {
		t.Fatalf("chat request id = %q, want chat-1", outbound.GetRequestId())
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"first","round":1}`,
			},
		},
	})
	firstEvent := receiveEnvelope(t, conn1)
	if firstEvent.ID != "chat-1" || firstEvent.Type != "chat.event" {
		t.Fatalf("first event = %#v, want chat.event for chat-1", firstEvent)
	}
	var firstPayload map[string]any
	if err := json.Unmarshal(firstEvent.Payload, &firstPayload); err != nil {
		t.Fatalf("decode first payload: %v", err)
	}
	if firstPayload["text"] != "first" || firstPayload["seq"] != float64(1) {
		t.Fatalf("first payload = %#v, want first seq=1", firstPayload)
	}

	_ = conn1.Close()
	time.Sleep(50 * time.Millisecond)

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"second","round":1}`,
			},
		},
	})
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_DONE,
				ConversationId: "conversation-1",
				Data:           `{}`,
			},
		},
	})

	conn2, cleanup2 := dialGatewayWebSocket(t, handler)
	defer cleanup2()
	authWebSocket(t, conn2, "ws-token")
	sendEnvelope(t, conn2, "resume-1", "chat.resume", map[string]any{
		"request_id": "chat-1",
		"after_seq":  float64(1),
	})

	secondEvent := receiveEnvelope(t, conn2)
	if secondEvent.ID != "chat-1" || secondEvent.Type != "chat.event" {
		t.Fatalf("second event = %#v, want replayed chat.event for chat-1", secondEvent)
	}
	var secondPayload map[string]any
	if err := json.Unmarshal(secondEvent.Payload, &secondPayload); err != nil {
		t.Fatalf("decode second payload: %v", err)
	}
	if secondPayload["text"] != "second" || secondPayload["seq"] != float64(2) {
		t.Fatalf("second payload = %#v, want second seq=2", secondPayload)
	}

	doneEvent := receiveEnvelope(t, conn2)
	if doneEvent.ID != "chat-1" || doneEvent.Type != "chat.event" {
		t.Fatalf("done event = %#v, want replayed chat.event for chat-1", doneEvent)
	}
	var donePayload map[string]any
	if err := json.Unmarshal(doneEvent.Payload, &donePayload); err != nil {
		t.Fatalf("decode done payload: %v", err)
	}
	if donePayload["type"] != "done" || donePayload["seq"] != float64(3) {
		t.Fatalf("done payload = %#v, want done seq=3", donePayload)
	}
}

func TestWebSocketChatAttachReplaysBufferedEventsByConversationID(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := server.NewWebSocketServer(&config.Config{
		Token:           "ws-token",
		RequestTimeout:  time.Second,
		HeartbeatPeriod: time.Hour,
	}, sm)
	conn1, cleanup1 := dialGatewayWebSocket(t, handler)
	defer cleanup1()
	authWebSocket(t, conn1, "ws-token")

	sendEnvelope(t, conn1, "chat-1", "chat.start", map[string]any{
		"conversation_id": "conversation-1",
		"message":         "hello gateway",
	})
	outbound := readOutboundEnvelope(t, agentSession)

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"first","round":1}`,
			},
		},
	})
	firstEvent := receiveEnvelope(t, conn1)
	if firstEvent.ID != "chat-1" || firstEvent.Type != "chat.event" {
		t.Fatalf("first event = %#v, want chat.event for chat-1", firstEvent)
	}

	conn2, cleanup2 := dialGatewayWebSocket(t, handler)
	defer cleanup2()
	authWebSocket(t, conn2, "ws-token")
	sendEnvelope(t, conn2, "attach-1", "chat.attach", map[string]any{
		"conversation_id": "conversation-1",
	})

	attachedEvent := receiveEnvelope(t, conn2)
	if attachedEvent.ID != "attach-1" || attachedEvent.Type != "chat.event" {
		t.Fatalf("attached event = %#v, want replayed chat.event for attach-1", attachedEvent)
	}
	var attachedPayload map[string]any
	if err := json.Unmarshal(attachedEvent.Payload, &attachedPayload); err != nil {
		t.Fatalf("decode attached payload: %v", err)
	}
	if attachedPayload["text"] != "first" || attachedPayload["seq"] != float64(1) {
		t.Fatalf("attached payload = %#v, want first seq=1", attachedPayload)
	}

	sendEnvelope(t, conn2, "detach-1", "chat.detach", map[string]any{
		"request_id": "attach-1",
	})
	detachEvent := receiveEnvelope(t, conn2)
	if detachEvent.ID != "detach-1" || detachEvent.Type != "response" {
		t.Fatalf("detach event = %#v, want response for detach-1", detachEvent)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"second","round":1}`,
			},
		},
	})
	secondEvent := receiveEnvelope(t, conn1)
	if secondEvent.ID != "chat-1" || secondEvent.Type != "chat.event" {
		t.Fatalf("second event = %#v, want chat.event for chat-1", secondEvent)
	}
	var secondPayload map[string]any
	if err := json.Unmarshal(secondEvent.Payload, &secondPayload); err != nil {
		t.Fatalf("decode second payload: %v", err)
	}
	if secondPayload["text"] != "second" || secondPayload["seq"] != float64(2) {
		t.Fatalf("second payload = %#v, want second seq=2", secondPayload)
	}
}

func TestWebSocketChatAttachExpiresAfterDoneHistoryUpsert(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := server.NewWebSocketServer(&config.Config{
		Token:           "ws-token",
		RequestTimeout:  time.Second,
		HeartbeatPeriod: time.Hour,
	}, sm)
	conn, cleanup := dialGatewayWebSocket(t, handler)
	defer cleanup()
	authWebSocket(t, conn, "ws-token")

	sendEnvelope(t, conn, "chat-1", "chat.start", map[string]any{
		"conversation_id": "conversation-1",
		"message":         "hello gateway",
	})
	outbound := readOutboundEnvelope(t, agentSession)
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_DONE,
				ConversationId: "conversation-1",
				Data:           `{}`,
			},
		},
	})
	doneEvent := receiveEnvelope(t, conn)
	if doneEvent.ID != "chat-1" || doneEvent.Type != "chat.event" {
		t.Fatalf("done event = %#v, want chat.event for chat-1", doneEvent)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "history-sync-1",
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_HistorySync{
			HistorySync: &gatewayv1.HistorySyncEvent{
				Kind:           "upsert",
				ConversationId: "conversation-1",
				Conversation: &gatewayv1.ConversationSummary{
					Id: "conversation-1",
				},
			},
		},
	})
	historyEvent := receiveEnvelope(t, conn)
	if historyEvent.Type != "history.event" {
		t.Fatalf("history event = %#v, want history.event before attach", historyEvent)
	}

	sendEnvelope(t, conn, "attach-after-upsert", "chat.attach", map[string]any{
		"conversation_id": "conversation-1",
	})
	attachEvent := receiveEnvelope(t, conn)
	if attachEvent.ID != "attach-after-upsert" || attachEvent.Type != "error" || attachEvent.Error != "chat stream not available" {
		t.Fatalf("attach event = %#v, want chat stream not available", attachEvent)
	}
}

func TestWebSocketChatCancelReleasesBufferedAttachRun(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := server.NewWebSocketServer(&config.Config{
		Token:           "ws-token",
		RequestTimeout:  time.Second,
		HeartbeatPeriod: time.Hour,
	}, sm)
	conn, cleanup := dialGatewayWebSocket(t, handler)
	defer cleanup()
	authWebSocket(t, conn, "ws-token")

	sendEnvelope(t, conn, "chat-1", "chat.start", map[string]any{
		"conversation_id": "conversation-1",
		"message":         "hello gateway",
	})
	outbound := readOutboundEnvelope(t, agentSession)
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"partial","round":1}`,
			},
		},
	})
	tokenEvent := receiveEnvelope(t, conn)
	if tokenEvent.ID != "chat-1" || tokenEvent.Type != "chat.event" {
		t.Fatalf("token event = %#v, want chat.event for chat-1", tokenEvent)
	}

	sendEnvelope(t, conn, "cancel-1", "chat.cancel", map[string]any{
		"conversation_id": "conversation-1",
	})
	cancelOutbound := readOutboundEnvelope(t, agentSession)
	if cancelOutbound.GetCancelChat().GetConversationId() != "conversation-1" {
		t.Fatalf("cancel outbound = %#v, want conversation-1", cancelOutbound.GetCancelChat())
	}
	cancelEvent := receiveEnvelopeWithID(t, conn, "cancel-1")
	if cancelEvent.Type != "response" {
		t.Fatalf("cancel event = %#v, want response", cancelEvent)
	}

	sendEnvelope(t, conn, "attach-after-cancel", "chat.attach", map[string]any{
		"conversation_id": "conversation-1",
	})
	attachEvent := receiveEnvelopeWithID(t, conn, "attach-after-cancel")
	if attachEvent.ID != "attach-after-cancel" || attachEvent.Type != "error" || attachEvent.Error != "chat stream not available" {
		t.Fatalf("attach event = %#v, want chat stream not available after cancel", attachEvent)
	}
}

func TestWebSocketForwardsHistorySettingsAndFsRPCs(t *testing.T) {
	t.Parallel()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := server.NewWebSocketServer(&config.Config{
		Token:          "ws-token",
		RequestTimeout: time.Second,
	}, sm)
	conn, cleanup := dialGatewayWebSocket(t, handler)
	defer cleanup()

	authWebSocket(t, conn, "ws-token")

	sendEnvelope(t, conn, "chat-running", "chat.start", map[string]any{
		"conversation_id": "conversation-1",
		"message":         "hello gateway",
	})
	chatOutbound := readOutboundEnvelope(t, agentSession)
	if chatOutbound.GetChatRequest() == nil {
		t.Fatalf("chat outbound payload = %T, want ChatRequest", chatOutbound.GetPayload())
	}

	sendEnvelope(t, conn, "history-1", "history.list", map[string]any{
		"limit":  25,
		"offset": 5,
	})
	historyOutbound := readOutboundEnvelope(t, agentSession)
	historyReq := historyOutbound.GetHistoryList()
	if historyReq == nil {
		t.Fatalf("history outbound payload = %T, want HistoryListRequest", historyOutbound.GetPayload())
	}
	if historyReq.GetLimit() != 25 || historyReq.GetOffset() != 5 {
		t.Fatalf("history list request = %#v", historyReq)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: historyOutbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_HistoryListResp{
			HistoryListResp: &gatewayv1.HistoryListResponse{
				Total: 1,
				Conversations: []*gatewayv1.ConversationSummary{
					{
						Id:           "conversation-1",
						Title:        "Gateway test",
						CreatedAt:    10,
						UpdatedAt:    11,
						MessageCount: 3,
						ProviderId:   "codex-provider",
						Model:        "gpt-test",
						SessionId:    "session-1",
						Cwd:          "/workspace",
						IsPinned:     true,
						PinnedAt:     12,
						IsShared:     true,
					},
				},
			},
		},
	})
	historyResponse := receiveEnvelope(t, conn)
	if historyResponse.ID != "history-1" || historyResponse.Type != "response" {
		t.Fatalf("history response = %#v", historyResponse)
	}
	var historyPayload map[string]any
	if err := json.Unmarshal(historyResponse.Payload, &historyPayload); err != nil {
		t.Fatalf("decode history response: %v", err)
	}
	if historyPayload["total"] != float64(1) {
		t.Fatalf("history payload = %#v", historyPayload)
	}
	runningConversationIDs, ok := historyPayload["running_conversation_ids"].([]any)
	if !ok || len(runningConversationIDs) != 1 || runningConversationIDs[0] != "conversation-1" {
		t.Fatalf("history running conversation ids = %#v", historyPayload["running_conversation_ids"])
	}
	historyConversations, ok := historyPayload["conversations"].([]any)
	if !ok || len(historyConversations) != 1 {
		t.Fatalf("history conversations = %#v", historyPayload["conversations"])
	}
	historyConversation, ok := historyConversations[0].(map[string]any)
	if !ok {
		t.Fatalf("history conversation = %#v", historyConversations[0])
	}
	if historyConversation["is_pinned"] != true || historyConversation["pinned_at"] != float64(12) {
		t.Fatalf("history conversation pin fields = %#v", historyConversation)
	}
	if historyConversation["is_shared"] != true {
		t.Fatalf("history conversation share field = %#v", historyConversation)
	}

	sendEnvelope(t, conn, "history-get-1", "history.get", map[string]any{
		"conversation_id": "conversation-1",
		"max_messages":    360,
	})
	historyGetOutbound := readOutboundEnvelope(t, agentSession)
	historyGetReq := historyGetOutbound.GetHistoryGet()
	if historyGetReq == nil {
		t.Fatalf("history get outbound payload = %T, want HistoryGetRequest", historyGetOutbound.GetPayload())
	}
	if historyGetReq.GetConversationId() != "conversation-1" || historyGetReq.GetMaxMessages() != 360 {
		t.Fatalf("history get request = %#v", historyGetReq)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: historyGetOutbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_HistoryGetResp{
			HistoryGetResp: &gatewayv1.HistoryGetResponse{
				ConversationId:       "conversation-1",
				MessagesJson:         `[{"role":"user","content":"tail"}]`,
				TotalMessageCount:    1000,
				ReturnedMessageCount: 360,
				HasMore:              true,
				Conversation: &gatewayv1.ConversationSummary{
					Id:           "conversation-1",
					Title:        "Gateway test",
					CreatedAt:    10,
					UpdatedAt:    11,
					MessageCount: 1000,
					ProviderId:   "codex-provider",
					Model:        "gpt-test",
					SessionId:    "session-1",
					Cwd:          "/workspace",
					IsPinned:     true,
					PinnedAt:     12,
					IsShared:     true,
				},
			},
		},
	})
	historyGetResponse := receiveEnvelope(t, conn)
	if historyGetResponse.ID != "history-get-1" || historyGetResponse.Type != "response" {
		t.Fatalf("history get response = %#v", historyGetResponse)
	}
	var historyGetPayload map[string]any
	if err := json.Unmarshal(historyGetResponse.Payload, &historyGetPayload); err != nil {
		t.Fatalf("decode history get response: %v", err)
	}
	if historyGetPayload["messages_json"] != `[{"role":"user","content":"tail"}]` ||
		historyGetPayload["total_message_count"] != float64(1000) ||
		historyGetPayload["returned_message_count"] != float64(360) ||
		historyGetPayload["has_more"] != true {
		t.Fatalf("history get payload = %#v", historyGetPayload)
	}
	historyGetConversation, ok := historyGetPayload["conversation"].(map[string]any)
	if !ok ||
		historyGetConversation["message_count"] != float64(1000) ||
		historyGetConversation["is_pinned"] != true ||
		historyGetConversation["is_shared"] != true {
		t.Fatalf("history get conversation = %#v", historyGetPayload["conversation"])
	}

	sendEnvelope(t, conn, "history-pin-1", "history.pin", map[string]any{
		"conversation_id": "conversation-1",
		"is_pinned":       false,
	})
	historyPinOutbound := readOutboundEnvelope(t, agentSession)
	historyPinReq := historyPinOutbound.GetHistoryPin()
	if historyPinReq == nil {
		t.Fatalf("history pin outbound payload = %T, want HistoryPinRequest", historyPinOutbound.GetPayload())
	}
	if historyPinReq.GetConversationId() != "conversation-1" || historyPinReq.GetIsPinned() {
		t.Fatalf("history pin request = %#v", historyPinReq)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: historyPinOutbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_HistoryPinResp{
			HistoryPinResp: &gatewayv1.HistoryPinResponse{
				Conversation: &gatewayv1.ConversationSummary{
					Id:           "conversation-1",
					Title:        "Gateway test",
					CreatedAt:    10,
					UpdatedAt:    11,
					MessageCount: 3,
					ProviderId:   "codex-provider",
					Model:        "gpt-test",
					SessionId:    "session-1",
					Cwd:          "/workspace",
					IsPinned:     false,
				},
			},
		},
	})
	historyPinResponse := receiveEnvelope(t, conn)
	if historyPinResponse.ID != "history-pin-1" || historyPinResponse.Type != "response" {
		t.Fatalf("history pin response = %#v", historyPinResponse)
	}
	var historyPinPayload map[string]any
	if err := json.Unmarshal(historyPinResponse.Payload, &historyPinPayload); err != nil {
		t.Fatalf("decode history pin response: %v", err)
	}
	if historyPinPayload["is_pinned"] != false {
		t.Fatalf("history pin payload = %#v", historyPinPayload)
	}

	sendEnvelope(t, conn, "history-share-get-1", "history.share.get", map[string]any{
		"conversation_id": "conversation-1",
	})
	historyShareGetOutbound := readOutboundEnvelope(t, agentSession)
	historyShareGetReq := historyShareGetOutbound.GetHistoryShareGet()
	if historyShareGetReq == nil {
		t.Fatalf("history share get outbound payload = %T, want HistoryShareGetRequest", historyShareGetOutbound.GetPayload())
	}
	if historyShareGetReq.GetConversationId() != "conversation-1" {
		t.Fatalf("history share get request = %#v", historyShareGetReq)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: historyShareGetOutbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_HistoryShareGetResp{
			HistoryShareGetResp: &gatewayv1.HistoryShareGetResponse{
				Share: &gatewayv1.HistoryShareStatus{
					ConversationId: "conversation-1",
					Enabled:        false,
				},
			},
		},
	})
	historyShareGetResponse := receiveEnvelope(t, conn)
	if historyShareGetResponse.ID != "history-share-get-1" || historyShareGetResponse.Type != "response" {
		t.Fatalf("history share get response = %#v", historyShareGetResponse)
	}
	var historyShareGetPayload map[string]any
	if err := json.Unmarshal(historyShareGetResponse.Payload, &historyShareGetPayload); err != nil {
		t.Fatalf("decode history share get response: %v", err)
	}
	if historyShareGetPayload["enabled"] != false || historyShareGetPayload["conversation_id"] != "conversation-1" {
		t.Fatalf("history share get payload = %#v", historyShareGetPayload)
	}

	sendEnvelope(t, conn, "history-share-set-1", "history.share.set", map[string]any{
		"conversation_id":     "conversation-1",
		"enabled":             true,
		"redact_tool_content": true,
	})
	historyShareSetOutbound := readOutboundEnvelope(t, agentSession)
	historyShareSetReq := historyShareSetOutbound.GetHistoryShareSet()
	if historyShareSetReq == nil {
		t.Fatalf("history share set outbound payload = %T, want HistoryShareSetRequest", historyShareSetOutbound.GetPayload())
	}
	if historyShareSetReq.GetConversationId() != "conversation-1" ||
		!historyShareSetReq.GetEnabled() ||
		historyShareSetReq.RedactToolContent == nil ||
		!historyShareSetReq.GetRedactToolContent() {
		t.Fatalf("history share set request = %#v", historyShareSetReq)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: historyShareSetOutbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_HistoryShareSetResp{
			HistoryShareSetResp: &gatewayv1.HistoryShareSetResponse{
				Share: &gatewayv1.HistoryShareStatus{
					ConversationId:    "conversation-1",
					Enabled:           true,
					Token:             "share-token",
					CreatedAt:         20,
					UpdatedAt:         21,
					RedactToolContent: true,
				},
			},
		},
	})
	historyShareSetResponse := receiveEnvelope(t, conn)
	if historyShareSetResponse.ID != "history-share-set-1" || historyShareSetResponse.Type != "response" {
		t.Fatalf("history share set response = %#v", historyShareSetResponse)
	}
	var historyShareSetPayload map[string]any
	if err := json.Unmarshal(historyShareSetResponse.Payload, &historyShareSetPayload); err != nil {
		t.Fatalf("decode history share set response: %v", err)
	}
	if historyShareSetPayload["enabled"] != true ||
		historyShareSetPayload["token"] != "share-token" ||
		historyShareSetPayload["updated_at"] != float64(21) ||
		historyShareSetPayload["redact_tool_content"] != true {
		t.Fatalf("history share set payload = %#v", historyShareSetPayload)
	}

	sendEnvelope(t, conn, "settings-1", "settings.update", map[string]any{
		"system": map[string]any{
			"executionMode": "agent-dev",
			"workdir":       "/workspace",
		},
	})
	settingsOutbound := readOutboundEnvelope(t, agentSession)
	settingsReq := settingsOutbound.GetSettingsUpdate()
	if settingsReq == nil {
		t.Fatalf("settings outbound payload = %T, want SettingsUpdateRequest", settingsOutbound.GetPayload())
	}
	var settingsJSON map[string]any
	if err := json.Unmarshal([]byte(settingsReq.GetSettingsJson()), &settingsJSON); err != nil {
		t.Fatalf("decode settings JSON: %v", err)
	}
	if _, ok := settingsJSON["system"].(map[string]any); !ok {
		t.Fatalf("settings JSON = %#v, want system object", settingsJSON)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: settingsOutbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_SettingsUpdateResp{
			SettingsUpdateResp: &gatewayv1.SettingsUpdateResponse{
				Accepted: true,
				Message:  "ok",
			},
		},
	})
	settingsResponse := receiveEnvelope(t, conn)
	if settingsResponse.ID != "settings-1" || settingsResponse.Type != "response" {
		t.Fatalf("settings response = %#v", settingsResponse)
	}

	sendEnvelope(t, conn, "fs-1", "fs.list_dirs", map[string]any{
		"path":        " /workspace ",
		"max_results": 50,
	})
	fsOutbound := readOutboundEnvelope(t, agentSession)
	fsReq := fsOutbound.GetFsListDirs()
	if fsReq == nil {
		t.Fatalf("fs outbound payload = %T, want FsListDirsRequest", fsOutbound.GetPayload())
	}
	if fsReq.GetPath() != "/workspace" || fsReq.GetMaxResults() != 50 {
		t.Fatalf("fs request = %#v", fsReq)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: fsOutbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_FsListDirsResp{
			FsListDirsResp: &gatewayv1.FsListDirsResponse{
				Path: "/workspace",
				Entries: []*gatewayv1.FsDirEntry{
					{Path: "/workspace/src", Name: "src"},
				},
				Truncated: true,
			},
		},
	})
	fsResponse := receiveEnvelope(t, conn)
	if fsResponse.ID != "fs-1" || fsResponse.Type != "response" {
		t.Fatalf("fs response = %#v", fsResponse)
	}
	var fsPayload map[string]any
	if err := json.Unmarshal(fsResponse.Payload, &fsPayload); err != nil {
		t.Fatalf("decode fs response: %v", err)
	}
	if fsPayload["path"] != "/workspace" || fsPayload["truncated"] != true {
		t.Fatalf("fs payload = %#v", fsPayload)
	}

	sendEnvelope(t, conn, "mentions-1", "mentions.list", map[string]any{
		"workdir":     " /workspace ",
		"max_results": 50,
		"query":       " src ",
	})
	mentionsOutbound := readOutboundEnvelope(t, agentSession)
	mentionsReq := mentionsOutbound.GetFileMentionList()
	if mentionsReq == nil {
		t.Fatalf("mentions outbound payload = %T, want FileMentionListRequest", mentionsOutbound.GetPayload())
	}
	if mentionsReq.GetWorkdir() != "/workspace" || mentionsReq.GetMaxResults() != 50 || mentionsReq.GetQuery() != "src" {
		t.Fatalf("mentions request = %#v", mentionsReq)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: mentionsOutbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_FileMentionListResp{
			FileMentionListResp: &gatewayv1.FileMentionListResponse{
				Entries: []*gatewayv1.FileMentionEntry{
					{Path: "src/main.ts", Kind: "file"},
				},
				Truncated: true,
			},
		},
	})
	mentionsResponse := receiveEnvelope(t, conn)
	if mentionsResponse.ID != "mentions-1" || mentionsResponse.Type != "response" {
		t.Fatalf("mentions response = %#v", mentionsResponse)
	}
	var mentionsPayload map[string]any
	if err := json.Unmarshal(mentionsResponse.Payload, &mentionsPayload); err != nil {
		t.Fatalf("decode mentions response: %v", err)
	}
	if mentionsPayload["truncated"] != true {
		t.Fatalf("mentions payload = %#v", mentionsPayload)
	}

	sendEnvelope(t, conn, "preview-1", "files.preview", map[string]any{
		"workdir":       " /workspace ",
		"absolute_path": " /workspace/uploads/1/image.png ",
	})
	previewOutbound := readOutboundEnvelope(t, agentSession)
	previewReq := previewOutbound.GetUploadedImagePreview()
	if previewReq == nil {
		t.Fatalf("preview outbound payload = %T, want UploadedImagePreviewRequest", previewOutbound.GetPayload())
	}
	if previewReq.GetWorkdir() != "/workspace" || previewReq.GetAbsolutePath() != "/workspace/uploads/1/image.png" {
		t.Fatalf("preview request = %#v", previewReq)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: previewOutbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_UploadedImagePreviewResp{
			UploadedImagePreviewResp: &gatewayv1.UploadedImagePreviewResponse{
				MimeType: "image/png",
				Data:     "aW1hZ2U=",
			},
		},
	})
	previewResponse := receiveEnvelope(t, conn)
	if previewResponse.ID != "preview-1" || previewResponse.Type != "response" {
		t.Fatalf("preview response = %#v", previewResponse)
	}
	var previewPayload map[string]any
	if err := json.Unmarshal(previewResponse.Payload, &previewPayload); err != nil {
		t.Fatalf("decode preview response: %v", err)
	}
	if previewPayload["mimeType"] != "image/png" || previewPayload["data"] != "aW1hZ2U=" {
		t.Fatalf("preview payload = %#v", previewPayload)
	}
}
