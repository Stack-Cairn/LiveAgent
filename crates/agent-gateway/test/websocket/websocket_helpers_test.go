package websocket_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
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
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{
		"Origin": []string{ts.URL},
	})
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
	if err := conn.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set websocket write deadline: %v", err)
	}
	if err := conn.WriteJSON(env); err != nil {
		t.Fatalf("send %s: %v", typ, err)
	}
}

func receiveEnvelope(t *testing.T, conn *websocket.Conn) wsEnvelope {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set websocket read deadline: %v", err)
	}
	var env wsEnvelope
	if err := conn.ReadJSON(&env); err != nil {
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
		outbound.Ack(nil)
		return outbound.GatewayEnvelope
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for gateway request to reach agent")
		return nil
	}
}
