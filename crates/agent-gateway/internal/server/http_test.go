package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestNewHTTPServerServesRootWithoutRedirect(t *testing.T) {
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager())

	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rec.Code)
	}
	if location := rec.Header().Get("Location"); location != "" {
		t.Fatalf("expected no redirect location, got %q", location)
	}
	if !strings.Contains(rec.Body.String(), "<title>LiveAgent Gateway</title>") {
		t.Fatalf("expected WebUI index.html, got body %q", rec.Body.String())
	}
	if cacheControl := rec.Header().Get("Cache-Control"); !strings.Contains(cacheControl, "no-store") {
		t.Fatalf("Cache-Control = %q, want no-store for index.html", cacheControl)
	}
}

func TestNewHTTPServerServesSpaFallbackWithoutRedirect(t *testing.T) {
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager())

	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/history/session-123", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rec.Code)
	}
	if location := rec.Header().Get("Location"); location != "" {
		t.Fatalf("expected no redirect location, got %q", location)
	}
	if !strings.Contains(rec.Body.String(), "<title>LiveAgent Gateway</title>") {
		t.Fatalf("expected WebUI index.html, got body %q", rec.Body.String())
	}
}

func TestNewHTTPServerDoesNotFallbackMissingStaticAssetsToIndex(t *testing.T) {
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager())

	for _, target := range []string{
		"http://gateway.test/assets/missing-module.js",
		"http://gateway.test/assets/missing-style.css",
		"http://gateway.test/missing-icon.svg",
	} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want %d", target, rec.Code, http.StatusNotFound)
		}
		if strings.Contains(rec.Body.String(), "<title>LiveAgent Gateway</title>") {
			t.Fatalf("%s returned SPA index fallback for a missing static asset", target)
		}
		if contentType := rec.Header().Get("Content-Type"); strings.Contains(contentType, "text/html") {
			t.Fatalf("%s Content-Type = %q, want non-html 404", target, contentType)
		}
	}
}

func TestWebSocketRejectsForeignOrigin(t *testing.T) {
	ts := httptest.NewServer(NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager()))
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, http.Header{
		"Origin": []string{"https://evil.example"},
	})
	if err == nil {
		_ = conn.Close()
		t.Fatal("expected websocket handshake with foreign origin to be rejected")
	}
	if resp == nil {
		t.Fatalf("expected forbidden websocket response, got nil response and error %v", err)
	}
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("websocket response status = %d, want %d", resp.StatusCode, http.StatusForbidden)
	}
}

func TestPublicHistoryShareResolvesWithoutAuthorization(t *testing.T) {
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := NewHTTPServer(&config.Config{
		Token:          "dev-token",
		RequestTimeout: time.Second,
	}, sm)
	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/api/public/history-shares/share-token", nil)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec, req)
		close(done)
	}()

	var outbound *gatewayv1.GatewayEnvelope
	select {
	case delivered := <-agentSession.Outbound():
		delivered.Ack(nil)
		outbound = delivered.GatewayEnvelope
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for public share request")
	}
	shareReq := outbound.GetHistoryShareResolve()
	if shareReq == nil {
		t.Fatalf("public share outbound payload = %T, want HistoryShareResolveRequest", outbound.GetPayload())
	}
	if shareReq.GetToken() != "share-token" {
		t.Fatalf("public share token = %q", shareReq.GetToken())
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_HistoryShareResolveResp{
			HistoryShareResolveResp: &gatewayv1.HistoryShareResolveResponse{
				ConversationId:    "conversation-1",
				MessagesJson:      `[{"role":"user","content":"hello"}]`,
				TotalMessageCount: 1,
				RedactToolContent: true,
				Conversation: &gatewayv1.ConversationSummary{
					Id:           "conversation-1",
					Title:        "Shared conversation",
					CreatedAt:    10,
					UpdatedAt:    11,
					MessageCount: 1,
				},
			},
		},
	})

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for public share response")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d body %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode public share payload: %v", err)
	}
	if payload["conversation_id"] != "conversation-1" ||
		payload["messages_json"] != `[{"role":"user","content":"hello"}]` ||
		payload["total_message_count"] != float64(1) ||
		payload["redact_tool_content"] != true {
		t.Fatalf("public share payload = %#v", payload)
	}
}

func TestPublicHistoryShareReturnsNotFoundForDisabledToken(t *testing.T) {
	status := publicHistoryShareErrorStatusForTest(t, http.StatusNotFound, "分享链接不存在或已关闭")
	if status != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, status)
	}
}

func TestPublicHistoryShareReturnsBadRequestFromAgentCode(t *testing.T) {
	status := publicHistoryShareErrorStatusForTest(t, http.StatusBadRequest, "分享 token 不能为空")
	if status != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, status)
	}
}

func TestPublicHistoryShareDoesNotInferStatusFromLegacyMessage(t *testing.T) {
	status := publicHistoryShareErrorStatusForTest(t, http.StatusInternalServerError, "分享链接不存在或已关闭")
	if status != http.StatusBadGateway {
		t.Fatalf("expected status %d, got %d", http.StatusBadGateway, status)
	}
}

func publicHistoryShareErrorStatusForTest(t *testing.T, code int, message string) int {
	t.Helper()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := NewHTTPServer(&config.Config{
		Token:          "dev-token",
		RequestTimeout: time.Second,
	}, sm)
	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/api/public/history-shares/disabled-token", nil)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec, req)
		close(done)
	}()

	var outbound *gatewayv1.GatewayEnvelope
	select {
	case delivered := <-agentSession.Outbound():
		delivered.Ack(nil)
		outbound = delivered.GatewayEnvelope
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for public share request")
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.AgentEnvelope_Error{
			Error: &gatewayv1.ErrorResponse{
				Code:    int32(code),
				Message: message,
			},
		},
	})

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for public share response")
	}
	return rec.Code
}

func TestPublicHistoryShareReturnsUnavailableWhenAgentOffline(t *testing.T) {
	handler := NewHTTPServer(&config.Config{
		Token:          "dev-token",
		RequestTimeout: time.Second,
	}, session.NewManager())

	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/api/public/history-shares/share-token", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected status %d, got %d body %s", http.StatusServiceUnavailable, rec.Code, rec.Body.String())
	}
}

func TestChatCommandRequiresCSRFHeader(t *testing.T) {
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager())

	req := httptest.NewRequest(
		http.MethodPost,
		"http://gateway.test/api/chat/commands",
		strings.NewReader(`{"type":"chat.submit","payload":{"message":"hello"}}`),
	)
	req.Header.Set("Authorization", "Bearer dev-token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected status %d, got %d body %s", http.StatusForbidden, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "csrf") {
		t.Fatalf("body = %q, want csrf error", rec.Body.String())
	}
}

func TestChatCommandRejectsForeignOrigin(t *testing.T) {
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager())

	req := httptest.NewRequest(
		http.MethodPost,
		"http://gateway.test/api/chat/commands",
		strings.NewReader(`{"type":"chat.submit","payload":{"message":"hello"}}`),
	)
	req.Header.Set("Authorization", "Bearer dev-token")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-LiveAgent-CSRF", "1")
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected status %d, got %d body %s", http.StatusForbidden, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "origin") {
		t.Fatalf("body = %q, want origin error", rec.Body.String())
	}
}

func TestChatEventsRejectsForeignOrigin(t *testing.T) {
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager())

	req := httptest.NewRequest(
		http.MethodGet,
		"http://gateway.test/api/chat/events?run_id=run-1",
		nil,
	)
	req.Header.Set("Authorization", "Bearer dev-token")
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected status %d, got %d body %s", http.StatusForbidden, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "origin") {
		t.Fatalf("body = %q, want origin error", rec.Body.String())
	}
}

func TestOriginAllowedRequiresStrictOriginForPublicHosts(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://gateway.test:8080/api/chat/commands", nil)
	req.Header.Set("Origin", "http://gateway.test:5173")

	if originAllowed(req) {
		t.Fatal("expected same hostname with different public port to be rejected")
	}
}

func TestOriginAllowedPermitsLoopbackDevPorts(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/api/chat/commands", nil)
	req.Header.Set("Origin", "http://localhost:5173")

	if !originAllowed(req) {
		t.Fatal("expected loopback development origins to be allowed across ports")
	}
}

func TestOriginAllowedUsesForwardedProtoForSameOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://gateway.test/api/chat/commands", nil)
	req.Host = "gateway.test"
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("Origin", "https://gateway.test")

	if !originAllowed(req) {
		t.Fatal("expected forwarded https origin to be allowed")
	}
}

func TestChatCommandsRejectLegacyEnvelopeShapes(t *testing.T) {
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager())
	legacyBodies := []string{
		`{"message":"hello","client_request_id":"client-1"}`,
		`{"command":"chat.submit","payload":{"message":"hello","client_request_id":"client-1"}}`,
		`{"type":"chat.submit","message":"hello","client_request_id":"client-1"}`,
		`{"type":"chat.submit","payload":{"message":"hello","request_id":"legacy-run"}}`,
		`{"type":"chat.submit","payload":null}`,
	}

	for _, body := range legacyBodies {
		req := httptest.NewRequest(
			http.MethodPost,
			"http://gateway.test/api/chat/commands",
			strings.NewReader(body),
		)
		req.Header.Set("Authorization", "Bearer dev-token")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-LiveAgent-CSRF", "1")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %s expected status %d, got %d body %s", body, http.StatusBadRequest, rec.Code, rec.Body.String())
		}
	}
}

func TestChatCommandsRequireClientRequestID(t *testing.T) {
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager())

	req := httptest.NewRequest(
		http.MethodPost,
		"http://gateway.test/api/chat/commands",
		strings.NewReader(`{"type":"chat.submit","payload":{"message":"hello"}}`),
	)
	req.Header.Set("Authorization", "Bearer dev-token")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-LiveAgent-CSRF", "1")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "client_request_id") {
		t.Fatalf("body = %q, want client_request_id error", rec.Body.String())
	}
}

func TestChatEventsRejectLegacyRequestIDAlias(t *testing.T) {
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager())

	req := httptest.NewRequest(
		http.MethodGet,
		"http://gateway.test/api/chat/events?request_id=run-1",
		nil,
	)
	req.Header.Set("Authorization", "Bearer dev-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "run_id or conversation_id") {
		t.Fatalf("body = %q, want run_id error", rec.Body.String())
	}
}

func TestChatEventsAfterSeqParsingIsStrictNumeric(t *testing.T) {
	if got := parseAfterSeq("41"); got != 41 {
		t.Fatalf("parseAfterSeq numeric = %d, want 41", got)
	}
	if got := parseAfterSeq("run-1/41"); got != 0 {
		t.Fatalf("parseAfterSeq legacy slash id = %d, want 0", got)
	}
}

func TestChatCancelCommandForwardsCancelRequest(t *testing.T) {
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := NewHTTPServer(&config.Config{
		Token:                 "dev-token",
		RequestTimeout:        time.Second,
		WebSocketWriteTimeout: time.Second,
	}, sm)
	req := httptest.NewRequest(
		http.MethodPost,
		"http://gateway.test/api/chat/commands",
		strings.NewReader(`{"type":"chat.cancel","payload":{"conversation_id":"conversation-1","run_id":"run-1"}}`),
	)
	req.Header.Set("Authorization", "Bearer dev-token")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-LiveAgent-CSRF", "1")
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec, req)
		close(done)
	}()

	select {
	case outbound := <-agentSession.Outbound():
		outbound.Ack(nil)
		command := outbound.GetChatCommand()
		cancelReq := command.GetCancel()
		if outbound.GetRequestId() != "run-1" ||
			command.GetType() != "chat.cancel" ||
			cancelReq == nil ||
			cancelReq.GetConversationId() != "conversation-1" {
			t.Fatalf("cancel outbound id=%q payload=%#v", outbound.GetRequestId(), command)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for cancel chat request")
	}

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for cancel response")
	}
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}
	var decoded map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode cancel response: %v", err)
	}
	if decoded["accepted"] != true || decoded["run_id"] != "run-1" || decoded["conversation_id"] != "conversation-1" {
		t.Fatalf("cancel response = %#v", decoded)
	}
}

func TestChatCancelRejectsLegacyRequestIDAlias(t *testing.T) {
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	handler := NewHTTPServer(&config.Config{
		Token:                 "dev-token",
		RequestTimeout:        time.Second,
		WebSocketWriteTimeout: time.Second,
	}, sm)
	req := httptest.NewRequest(
		http.MethodPost,
		"http://gateway.test/api/chat/commands",
		strings.NewReader(`{"type":"chat.cancel","payload":{"conversation_id":"conversation-1","request_id":"legacy-run"}}`),
	)
	req.Header.Set("Authorization", "Bearer dev-token")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-LiveAgent-CSRF", "1")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	select {
	case outbound := <-agentSession.Outbound():
		outbound.Ack(nil)
		t.Fatalf("unexpected outbound cancel for rejected legacy payload: %#v", outbound)
	default:
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func TestChatCancelCommandFindsRunByConversation(t *testing.T) {
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)
	if _, created, err := sm.StartPendingChatCommandRun("run-1", "conversation-1", "client-1"); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun created=%v err=%v", created, err)
	}

	handler := NewHTTPServer(&config.Config{
		Token:                 "dev-token",
		RequestTimeout:        time.Second,
		WebSocketWriteTimeout: time.Second,
	}, sm)
	req := httptest.NewRequest(
		http.MethodPost,
		"http://gateway.test/api/chat/commands",
		strings.NewReader(`{"type":"chat.cancel","payload":{"conversation_id":"conversation-1"}}`),
	)
	req.Header.Set("Authorization", "Bearer dev-token")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-LiveAgent-CSRF", "1")
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec, req)
		close(done)
	}()

	select {
	case outbound := <-agentSession.Outbound():
		outbound.Ack(nil)
		if outbound.GetRequestId() != "run-1" {
			t.Fatalf("cancel request id = %q, want run-1", outbound.GetRequestId())
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for cancel chat request")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for cancel response")
	}
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	ch, _, cleanup, _, err := sm.SubscribeChatRun("run-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	select {
	case event := <-ch:
		if event.Control == nil || event.Control.GetType() != "cancelled" {
			t.Fatalf("cancel event = %#v, want cancelled control", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for local cancelled event")
	}
}

func TestChatEditResendRejectsNegativeBaseMessageRef(t *testing.T) {
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager())

	req := httptest.NewRequest(
		http.MethodPost,
		"http://gateway.test/api/chat/commands",
		strings.NewReader(`{"type":"chat.edit_resend","payload":{"message":"edited","conversation_id":"conversation-1","client_request_id":"client-edit-1","base_message_ref":{"segment_index":-1,"message_index":4}}}`),
	)
	req.Header.Set("Authorization", "Bearer dev-token")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-LiveAgent-CSRF", "1")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "base_message_ref") {
		t.Fatalf("body = %q, want base_message_ref error", rec.Body.String())
	}
}

func TestChatCommandSubmitAcceptsAndSSEReplaysControl(t *testing.T) {
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	ts := httptest.NewServer(NewHTTPServer(&config.Config{
		Token:          "dev-token",
		RequestTimeout: time.Second,
	}, sm))
	defer ts.Close()

	req, err := http.NewRequest(
		http.MethodPost,
		ts.URL+"/api/chat/commands",
		strings.NewReader(`{"type":"chat.submit","payload":{"message":"hello","conversation_id":"conversation-1","client_request_id":"client-1","workdir":"/workspace"}}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer dev-token")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-LiveAgent-CSRF", "1")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("post chat command: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusAccepted)
	}
	var accepted struct {
		RunID        string `json:"run_id"`
		AcceptedSeq  int64  `json:"accepted_seq"`
		Conversation string `json:"conversation_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&accepted); err != nil {
		t.Fatalf("decode accepted response: %v", err)
	}
	if accepted.RunID == "" || accepted.AcceptedSeq != 1 || accepted.Conversation != "conversation-1" {
		t.Fatalf("accepted response = %#v", accepted)
	}

	select {
	case outbound := <-agentSession.Outbound():
		outbound.Ack(nil)
		command := outbound.GetChatCommand()
		chatReq := command.GetRequest()
		if chatReq == nil {
			t.Fatalf("outbound payload = %T, want ChatCommandRequest with ChatRequest", outbound.GetPayload())
		}
		if command.GetType() != "chat.submit" {
			t.Fatalf("chat command type = %q, want chat.submit", command.GetType())
		}
		if chatReq.GetMessage() != "hello" ||
			chatReq.GetConversationId() != "conversation-1" ||
			chatReq.GetClientRequestId() != "client-1" ||
			chatReq.GetWorkdir() != "/workspace" {
			t.Fatalf("chat request = %#v", chatReq)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for chat command outbound request")
	}

	eventsReq, err := http.NewRequest(
		http.MethodGet,
		ts.URL+"/api/chat/events?run_id="+accepted.RunID+"&after_seq=0",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	eventsReq.Header.Set("Authorization", "Bearer dev-token")
	eventsResp, err := ts.Client().Do(eventsReq)
	if err != nil {
		t.Fatalf("get chat events: %v", err)
	}
	defer eventsResp.Body.Close()
	if eventsResp.StatusCode != http.StatusOK {
		t.Fatalf("events status = %d, want %d", eventsResp.StatusCode, http.StatusOK)
	}

	event := readChatSSEEvent(t, bufio.NewReader(eventsResp.Body))
	if event["type"] != "run.accepted" || event["run_id"] != accepted.RunID {
		t.Fatalf("sse event = %#v", event)
	}
	payload, _ := event["payload"].(map[string]any)
	if payload["type"] != "accepted" || payload["seq"] != float64(1) {
		t.Fatalf("sse payload = %#v", payload)
	}
	if _, ok := payload["request_id"]; ok {
		t.Fatalf("sse payload leaked legacy request_id: %#v", payload)
	}
}

func TestChatCommandStartWatchdogFailsUndeliveredRun(t *testing.T) {
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	ts := httptest.NewServer(NewHTTPServer(&config.Config{
		Token:                  "dev-token",
		RequestTimeout:         time.Second,
		ChatStartTimeout:       20 * time.Millisecond,
		ChatRenderStartTimeout: time.Second,
	}, sm))
	defer ts.Close()

	req, err := http.NewRequest(
		http.MethodPost,
		ts.URL+"/api/chat/commands",
		strings.NewReader(`{"type":"chat.submit","payload":{"message":"hello","conversation_id":"conversation-1","client_request_id":"client-watchdog-1"}}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer dev-token")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-LiveAgent-CSRF", "1")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("post chat command: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusAccepted)
	}
	var accepted struct {
		RunID string `json:"run_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&accepted); err != nil {
		t.Fatalf("decode accepted response: %v", err)
	}
	if accepted.RunID == "" {
		t.Fatalf("accepted response missing run_id")
	}

	select {
	case outbound := <-agentSession.Outbound():
		outbound.Ack(nil)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for chat command outbound request")
	}

	deadline := time.After(time.Second)
	for {
		snapshot, ok := sm.ChatRunSnapshot(accepted.RunID, "conversation-1")
		if ok && snapshot.State == session.ChatRunStateFailed {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for watchdog failure, last snapshot ok=%v value=%#v", ok, snapshot)
		case <-time.After(10 * time.Millisecond):
		}
	}

	ch, _, cleanup, _, err := sm.SubscribeChatRun(accepted.RunID, "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	for {
		select {
		case event := <-ch:
			if event.Event != nil && event.Event.GetType() == gatewayv1.ChatEvent_ERROR {
				if !strings.Contains(event.Event.GetData(), "Desktop backend did not accept") {
					t.Fatalf("watchdog error data = %q", event.Event.GetData())
				}
				return
			}
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for watchdog error replay")
		}
	}
}

func TestChatCommandDedupesClientRequestID(t *testing.T) {
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	ts := httptest.NewServer(NewHTTPServer(&config.Config{
		Token:          "dev-token",
		RequestTimeout: time.Second,
	}, sm))
	defer ts.Close()

	postCommand := func() map[string]any {
		req, err := http.NewRequest(
			http.MethodPost,
			ts.URL+"/api/chat/commands",
			strings.NewReader(`{"type":"chat.submit","payload":{"message":"hello","conversation_id":"conversation-1","client_request_id":"client-1"}}`),
		)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer dev-token")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-LiveAgent-CSRF", "1")
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatalf("post chat command: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusAccepted {
			t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusAccepted)
		}
		var decoded map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
			t.Fatalf("decode accepted response: %v", err)
		}
		return decoded
	}

	first := postCommand()
	firstRunID, _ := first["run_id"].(string)
	if firstRunID == "" || first["deduped"] == true {
		t.Fatalf("first response = %#v", first)
	}
	select {
	case outbound := <-agentSession.Outbound():
		outbound.Ack(nil)
		command := outbound.GetChatCommand()
		if command.GetType() != "chat.submit" || command.GetRequest() == nil {
			t.Fatalf("outbound payload = %#v, want chat.submit command", command)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first chat request")
	}

	second := postCommand()
	if second["run_id"] != firstRunID || second["deduped"] != true {
		t.Fatalf("second response = %#v, first run_id %q", second, firstRunID)
	}
	select {
	case outbound := <-agentSession.Outbound():
		t.Fatalf("unexpected duplicate outbound request %s payload %T", outbound.GetRequestId(), outbound.GetPayload())
	case <-time.After(100 * time.Millisecond):
	}
}

func TestChatCommandSeqContinuesAcrossConversationRuns(t *testing.T) {
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	ts := httptest.NewServer(NewHTTPServer(&config.Config{
		Token:          "dev-token",
		RequestTimeout: time.Second,
	}, sm))
	defer ts.Close()

	postCommand := func(raw string) map[string]any {
		t.Helper()
		req, err := http.NewRequest(
			http.MethodPost,
			ts.URL+"/api/chat/commands",
			strings.NewReader(raw),
		)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer dev-token")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-LiveAgent-CSRF", "1")
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatalf("post chat command: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusAccepted {
			t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusAccepted)
		}
		var decoded map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return decoded
	}

	first := postCommand(`{"type":"chat.submit","payload":{"message":"first","conversation_id":"conversation-1","client_request_id":"client-submit-1"}}`)
	firstRunID, _ := first["run_id"].(string)
	if firstRunID == "" || first["accepted_seq"] != float64(1) {
		t.Fatalf("first response = %#v, want accepted_seq 1", first)
	}
	select {
	case outbound := <-agentSession.Outbound():
		outbound.Ack(nil)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first chat command")
	}
	sm.MarkChatRunControl(firstRunID, "conversation-1", "completed", "", "")

	second := postCommand(`{"type":"chat.edit_resend","payload":{"message":"edited","conversation_id":"conversation-1","client_request_id":"client-edit-1","base_message_ref":{"segment_index":0,"message_index":0}}}`)
	secondRunID, _ := second["run_id"].(string)
	if secondRunID == "" || secondRunID == firstRunID || second["accepted_seq"] != float64(4) {
		t.Fatalf("second response = %#v, want new run accepted_seq 4", second)
	}
	select {
	case outbound := <-agentSession.Outbound():
		outbound.Ack(nil)
		command := outbound.GetChatCommand()
		if command.GetType() != "chat.edit_resend" {
			t.Fatalf("second outbound command type = %q, want chat.edit_resend", command.GetType())
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for second chat command")
	}
}

func TestChatEventsReplayConversationAcrossRuns(t *testing.T) {
	sm := session.NewManager()
	if _, created, err := sm.StartPendingChatCommandRun("request-1", "conversation-1", "client-submit-1"); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun request-1 created=%v err=%v", created, err)
	}
	sm.MarkChatRunControl("request-1", "conversation-1", "accepted", "", "")
	sm.MarkChatRunPayload("request-1", "conversation-1", map[string]any{
		"type":    "user_message",
		"message": "first",
	})
	sm.MarkChatRunControl("request-1", "conversation-1", "completed", "", "")

	if _, created, err := sm.StartPendingChatCommandRun("request-2", "conversation-1", "client-submit-2"); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun request-2 created=%v err=%v", created, err)
	}
	sm.MarkChatRunControl("request-2", "conversation-1", "accepted", "", "")

	ts := httptest.NewServer(NewHTTPServer(&config.Config{Token: "dev-token"}, sm))
	defer ts.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		ts.URL+"/api/chat/events?conversation_id=conversation-1&after_seq=0",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer dev-token")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("get chat events: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("events status = %d, want %d", resp.StatusCode, http.StatusOK)
	}

	reader := bufio.NewReader(resp.Body)
	got := make([]string, 0, 4)
	for len(got) < 4 {
		event := readChatSSEEvent(t, reader)
		payload, _ := event["payload"].(map[string]any)
		eventType, _ := payload["type"].(string)
		if event["snapshot_run_id"] != "request-2" {
			t.Fatalf("snapshot_run_id = %#v, want request-2", event["snapshot_run_id"])
		}
		got = append(got, event["run_id"].(string)+":"+eventType)
	}
	cancel()

	want := []string{
		"request-1:accepted",
		"request-1:user_message",
		"request-1:completed",
		"request-2:accepted",
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("conversation SSE replay = %#v, want %#v", got, want)
		}
	}
}

func TestChatEditResendSendsSingleChatCommand(t *testing.T) {
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(agentSession)

	ts := httptest.NewServer(NewHTTPServer(&config.Config{
		Token:          "dev-token",
		RequestTimeout: time.Second,
	}, sm))
	defer ts.Close()

	req, err := http.NewRequest(
		http.MethodPost,
		ts.URL+"/api/chat/commands",
		strings.NewReader(`{"type":"chat.edit_resend","payload":{"message":"edited","conversation_id":"conversation-1","client_request_id":"client-edit-1","base_message_ref":{"segment_index":2,"message_index":4}}}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer dev-token")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-LiveAgent-CSRF", "1")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("post chat edit command: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusAccepted)
	}

	var accepted struct {
		RunID string `json:"run_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&accepted); err != nil {
		t.Fatalf("decode accepted response: %v", err)
	}
	if accepted.RunID == "" {
		t.Fatalf("accepted response missing run_id")
	}

	eventsReq, err := http.NewRequest(
		http.MethodGet,
		ts.URL+"/api/chat/events?run_id="+accepted.RunID+"&after_seq=0",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	eventsReq.Header.Set("Authorization", "Bearer dev-token")
	eventsResp, err := ts.Client().Do(eventsReq)
	if err != nil {
		t.Fatalf("get chat edit events: %v", err)
	}
	defer eventsResp.Body.Close()
	if eventsResp.StatusCode != http.StatusOK {
		t.Fatalf("events status = %d, want %d", eventsResp.StatusCode, http.StatusOK)
	}
	eventsReader := bufio.NewReader(eventsResp.Body)
	if event := readChatSSEEvent(t, eventsReader); event["type"] != "run.accepted" {
		t.Fatalf("first edit event = %#v, want run.accepted", event)
	}
	rebaseEvent := readChatSSEEvent(t, eventsReader)
	if rebaseEvent["type"] != "conversation.rebased" {
		t.Fatalf("second edit event = %#v, want conversation.rebased", rebaseEvent)
	}
	rebasePayload, _ := rebaseEvent["payload"].(map[string]any)
	if rebasePayload["type"] != "rebased" || rebasePayload["reason"] != "edit_resend" {
		t.Fatalf("rebase payload = %#v", rebasePayload)
	}
	if _, ok := rebasePayload["request_id"]; ok {
		t.Fatalf("rebase payload leaked legacy request_id: %#v", rebasePayload)
	}
	userMessageEvent := readChatSSEEvent(t, eventsReader)
	if userMessageEvent["type"] != "user.message.appended" {
		t.Fatalf("third edit event = %#v, want user.message.appended", userMessageEvent)
	}
	userMessagePayload, _ := userMessageEvent["payload"].(map[string]any)
	if userMessagePayload["type"] != "user_message" || userMessagePayload["message"] != "edited" {
		t.Fatalf("user message payload = %#v", userMessagePayload)
	}

	select {
	case outbound := <-agentSession.Outbound():
		outbound.Ack(nil)
		command := outbound.GetChatCommand()
		chatReq := command.GetRequest()
		baseRef := command.GetBaseMessageRef()
		if command.GetType() != "chat.edit_resend" || chatReq == nil || baseRef == nil {
			t.Fatalf("outbound payload = %#v, want chat.edit_resend command", command)
		}
		if outbound.GetRequestId() != accepted.RunID ||
			chatReq.GetMessage() != "edited" ||
			chatReq.GetConversationId() != "conversation-1" ||
			chatReq.GetClientRequestId() != "client-edit-1" ||
			baseRef.GetSegmentIndex() != 2 ||
			baseRef.GetMessageIndex() != 4 {
			t.Fatalf("chat command id=%q command=%#v", outbound.GetRequestId(), command)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for chat edit command")
	}
	select {
	case outbound := <-agentSession.Outbound():
		t.Fatalf("unexpected extra outbound after edit command %s payload %T", outbound.GetRequestId(), outbound.GetPayload())
	case <-time.After(100 * time.Millisecond):
	}
}

func readChatSSEEvent(t *testing.T, reader *bufio.Reader) map[string]any {
	t.Helper()
	var dataLine string
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read sse line: %v", err)
		}
		if strings.HasPrefix(line, "data:") {
			dataLine = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		}
		if strings.TrimSpace(line) == "" && dataLine != "" {
			break
		}
	}
	var event map[string]any
	if err := json.Unmarshal([]byte(dataLine), &event); err != nil {
		t.Fatalf("decode sse data %q: %v", dataLine, err)
	}
	return event
}
