package stt

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// The fixture exercises the real TLS/WebSocket adapter without external credentials.
func TestDashScopeTLSWireAudioFinish(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer wire-fixture-key" {
			t.Error("missing authentication")
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		var start map[string]any
		if err := conn.ReadJSON(&start); err != nil {
			t.Error(err)
			return
		}
		if start["header"].(map[string]any)["action"] != "run-task" {
			t.Error(start)
		}
		_ = conn.WriteJSON(map[string]any{"header": map[string]string{"event": "task-started"}})
		kind, pcm, err := conn.ReadMessage()
		if err != nil || kind != websocket.BinaryMessage || len(pcm) != 320 {
			t.Errorf("audio=%d bytes=%d err=%v", kind, len(pcm), err)
			return
		}
		_ = conn.WriteJSON(map[string]any{"header": map[string]string{"event": "result-generated"}, "payload": map[string]any{"output": map[string]any{"sentence": map[string]any{"text": "wire fixture transcript", "sentence_end": true}}}})
		var finish map[string]any
		if err := conn.ReadJSON(&finish); err != nil {
			t.Error(err)
			return
		}
		if finish["header"].(map[string]any)["action"] != "finish-task" {
			t.Error(finish)
		}
		_ = conn.WriteJSON(map[string]any{"header": map[string]string{"event": "task-finished"}})
	}))
	defer server.Close()
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	previous := websocket.DefaultDialer
	copy := *previous
	copy.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	websocket.DefaultDialer = &copy
	defer func() { websocket.DefaultDialer = previous }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	commands := make(chan Command, 2)
	events := make(chan Event, 8)
	done := make(chan error, 1)
	go func() {
		done <- (&AliyunDashScopeAdapter{}).Run(ctx, "wire-session", map[string]any{"websocketUrl": "wss" + strings.TrimPrefix(server.URL, "https"), "apiKey": "wire-fixture-key"}, commands, events)
	}()
	select {
	case err := <-done:
		t.Fatalf("adapter stopped before ready: %v", err)
	case event := <-events:
		if event.Type != "ready" {
			t.Fatalf("expected ready: %+v", event)
		}
	case <-ctx.Done():
		t.Fatal("ready timeout")
	}
	commands <- Command{Audio: &AudioChunk{PCM: make([]byte, 320)}}
	commands <- Command{Finish: true}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("finish timeout")
	}
	final := false
	for len(events) > 0 {
		event := <-events
		if event.Type == "final" && event.Text == "wire fixture transcript" {
			final = true
		}
	}
	if !final {
		t.Fatal("missing final transcript")
	}
}
