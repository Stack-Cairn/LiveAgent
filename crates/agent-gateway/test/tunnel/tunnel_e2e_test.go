package tunnel_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

// fakeAgent emulates the desktop agent's data-plane behavior in-process: it
// drains the session outbound queue and answers tunnel frames the way the
// Rust proxy does (HTTP echo, SSE stream, WS echo, PONG).
type fakeAgent struct {
	sm   *session.Manager
	sess *session.AgentSession
	done chan struct{}
	once sync.Once
}

func startFakeAgent(t *testing.T) (*session.Manager, *fakeAgent) {
	t.Helper()
	sm := session.NewManager()
	sess := session.NewAgentSession(session.AuthSnapshot{AgentID: "fake-agent"})
	sm.SetSession(sess)
	agent := &fakeAgent{sm: sm, sess: sess, done: make(chan struct{})}
	go agent.run()
	t.Cleanup(agent.stop)
	return sm, agent
}

func (a *fakeAgent) stop() {
	a.once.Do(func() { close(a.done) })
}

func (a *fakeAgent) run() {
	for {
		select {
		case <-a.done:
			return
		case outbound := <-a.sess.Outbound():
			if outbound == nil || outbound.GatewayEnvelope == nil {
				continue
			}
			outbound.Ack(nil)
			frame := outbound.GetTunnelFrame()
			if frame == nil {
				continue
			}
			a.handleFrame(frame)
		}
	}
}

func (a *fakeAgent) reply(frame *gatewayv2.TunnelFrame) {
	a.sm.DispatchFromAgentForSession(a.sess, &gatewayv2.AgentEnvelope{
		RequestId: "fake-agent-frame",
		Timestamp: time.Now().Unix(),
		Payload:   &gatewayv2.AgentEnvelope_TunnelFrame{TunnelFrame: frame},
	})
}

func (a *fakeAgent) handleFrame(frame *gatewayv2.TunnelFrame) {
	streamID := frame.GetStreamId()
	switch frame.GetKind() {
	case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_PING:
		a.reply(&gatewayv2.TunnelFrame{
			StreamId: streamID,
			Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_PONG,
		})
	case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_START:
		if strings.HasPrefix(frame.GetPath(), "/sse") {
			a.reply(&gatewayv2.TunnelFrame{
				StreamId: streamID,
				Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_START,
				Status:   200,
				Headers: []*gatewayv2.TunnelHeader{
					{Name: "Content-Type", Value: "text/event-stream; charset=utf-8"},
				},
			})
			for _, chunk := range []string{"event: tick\ndata: 1\n\n", "event: tick\ndata: 2\n\n"} {
				a.reply(&gatewayv2.TunnelFrame{
					StreamId: streamID,
					Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_BODY,
					Body:     []byte(chunk),
				})
			}
			a.reply(&gatewayv2.TunnelFrame{
				StreamId: streamID,
				Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_END,
			})
			return
		}
		a.reply(&gatewayv2.TunnelFrame{
			StreamId: streamID,
			Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_START,
			Status:   200,
			Headers: []*gatewayv2.TunnelHeader{
				{Name: "Content-Type", Value: "text/plain; charset=utf-8"},
			},
		})
		a.reply(&gatewayv2.TunnelFrame{
			StreamId: streamID,
			Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_BODY,
			Body:     []byte("hello " + frame.GetMethod() + " " + frame.GetPath()),
		})
		a.reply(&gatewayv2.TunnelFrame{
			StreamId: streamID,
			Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_END,
		})
	case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_DIAL:
		a.reply(&gatewayv2.TunnelFrame{
			StreamId: streamID,
			Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_DIAL_OK,
		})
	case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_FRAME:
		if string(frame.GetBody()) == "close-me" {
			// Emulate the local service closing the socket with its own code.
			a.reply(&gatewayv2.TunnelFrame{
				StreamId:      streamID,
				Kind:          gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_CLOSE,
				WsCloseCode:   4321,
				WsCloseReason: "goodbye",
			})
			return
		}
		a.reply(&gatewayv2.TunnelFrame{
			StreamId:      streamID,
			Kind:          gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_FRAME,
			Body:          append([]byte("echo:"), frame.GetBody()...),
			WsMessageType: frame.GetWsMessageType(),
		})
	}
}

func startTunnelTestServer(t *testing.T, sm *session.Manager) *httptest.Server {
	t.Helper()
	handler := server.NewHTTPServer(&config.Config{
		Token:          "dev-token",
		RequestTimeout: 2 * time.Second,
	}, sm, nil)
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	return ts
}

func applyOneTunnel(t *testing.T, sm *session.Manager) string {
	t.Helper()
	sm.ApplyDesiredState("fake-agent", &gatewayv2.TunnelDesiredState{
		Tunnels: []*gatewayv2.TunnelSpec{
			{Id: "tun-e2e", TargetUrl: "http://localhost:3999", Name: "e2e"},
		},
	})
	snapshot := sm.TunnelStateSnapshot("fake-agent")
	if len(snapshot.GetTunnels()) != 1 {
		t.Fatalf("tunnels = %d, want 1", len(snapshot.GetTunnels()))
	}
	slug := snapshot.GetTunnels()[0].GetSlug()
	if slug == "" {
		t.Fatal("no slug allocated")
	}
	return slug
}

func TestTunnelEndToEndHTTP(t *testing.T) {
	sm, _ := startFakeAgent(t)
	ts := startTunnelTestServer(t, sm)
	slug := applyOneTunnel(t, sm)

	resp, err := http.Get(ts.URL + "/t/" + slug + "/app/page?x=1")
	if err != nil {
		t.Fatalf("GET through tunnel: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body=%s", resp.StatusCode, body)
	}
	if got := string(body); got != "hello GET /app/page?x=1" {
		t.Fatalf("body = %q", got)
	}
}

func TestTunnelEndToEndSSEStreams(t *testing.T) {
	sm, _ := startFakeAgent(t)
	ts := startTunnelTestServer(t, sm)
	slug := applyOneTunnel(t, sm)

	resp, err := http.Get(ts.URL + "/t/" + slug + "/sse")
	if err != nil {
		t.Fatalf("GET sse through tunnel: %v", err)
	}
	defer resp.Body.Close()
	if contentType := resp.Header.Get("Content-Type"); !strings.Contains(contentType, "text/event-stream") {
		t.Fatalf("content-type = %q", contentType)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "data: 1") || !strings.Contains(string(body), "data: 2") {
		t.Fatalf("sse body = %q", body)
	}
}

func TestTunnelEndToEndWebSocketEchoAndClose(t *testing.T) {
	sm, _ := startFakeAgent(t)
	ts := startTunnelTestServer(t, sm)
	slug := applyOneTunnel(t, sm)

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/t/" + slug + "/socket"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial tunnel websocket: %v", err)
	}
	defer conn.Close()

	if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	messageType, body, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if messageType != websocket.TextMessage || string(body) != "echo:ping" {
		t.Fatalf("echo = (%d, %q)", messageType, body)
	}

	// Upstream-initiated close: the local service's close code/reason must
	// reach the visitor verbatim through the frame relay.
	if err := conn.WriteMessage(websocket.TextMessage, []byte("close-me")); err != nil {
		t.Fatalf("write close-me: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = conn.ReadMessage()
	closeErr, ok := err.(*websocket.CloseError)
	if !ok {
		t.Fatalf("expected close error, got %v", err)
	}
	if closeErr.Code != 4321 || closeErr.Text != "goodbye" {
		t.Fatalf("close = (%d, %q), want (4321, goodbye)", closeErr.Code, closeErr.Text)
	}
}

// TestTunnelTrafficWhileControlPlaneBusy is the deadlock regression: the old
// design executed probes synchronously on the agent read loop, so any control
// activity starved the data plane. The new design must serve traffic while
// desired-state applies and relay probes run concurrently.
func TestTunnelTrafficWhileControlPlaneBusy(t *testing.T) {
	sm, _ := startFakeAgent(t)
	ts := startTunnelTestServer(t, sm)
	slug := applyOneTunnel(t, sm)

	stop := make(chan struct{})
	var controlWG sync.WaitGroup
	controlWG.Add(1)
	go func() {
		defer controlWG.Done()
		for {
			select {
			case <-stop:
				return
			default:
				sm.ApplyDesiredState("fake-agent", &gatewayv2.TunnelDesiredState{
					Tunnels: []*gatewayv2.TunnelSpec{
						{Id: "tun-e2e", TargetUrl: "http://localhost:3999", Name: "e2e", SlugHint: slug},
					},
				})
			}
		}
	}()

	deadline := time.Now().Add(2 * time.Second)
	requests := 0
	for time.Now().Before(deadline) {
		client := http.Client{Timeout: time.Second}
		resp, err := client.Get(ts.URL + "/t/" + slug + "/")
		if err != nil {
			close(stop)
			controlWG.Wait()
			t.Fatalf("request %d during control churn: %v", requests, err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			close(stop)
			controlWG.Wait()
			t.Fatalf("request %d status = %d", requests, resp.StatusCode)
		}
		requests += 1
	}
	close(stop)
	controlWG.Wait()
	if requests < 10 {
		t.Fatalf("only %d requests completed during control churn", requests)
	}
}

func TestTunnelHTMLRewriteInjectsShimAndDropsContentLength(t *testing.T) {
	sm := session.NewManager()
	sess := session.NewAgentSession(session.AuthSnapshot{AgentID: "fake-agent"})
	sm.SetSession(sess)
	agent := &fakeAgent{sm: sm, sess: sess, done: make(chan struct{})}
	t.Cleanup(agent.stop)

	html := "<html><head></head><body><a href=\"/about\">x</a></body></html>"
	go func() {
		for {
			select {
			case <-agent.done:
				return
			case outbound := <-sess.Outbound():
				if outbound == nil || outbound.GatewayEnvelope == nil {
					continue
				}
				outbound.Ack(nil)
				frame := outbound.GetTunnelFrame()
				if frame == nil ||
					frame.GetKind() != gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_START {
					continue
				}
				agent.reply(&gatewayv2.TunnelFrame{
					StreamId: frame.GetStreamId(),
					Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_START,
					Status:   200,
					Headers: []*gatewayv2.TunnelHeader{
						{Name: "Content-Type", Value: "text/html; charset=utf-8"},
						{Name: "Content-Length", Value: "999"},
						{Name: "Content-Security-Policy", Value: "script-src 'self'"},
					},
				})
				agent.reply(&gatewayv2.TunnelFrame{
					StreamId: frame.GetStreamId(),
					Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_BODY,
					Body:     []byte(html),
				})
				agent.reply(&gatewayv2.TunnelFrame{
					StreamId: frame.GetStreamId(),
					Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_END,
				})
			}
		}
	}()

	ts := startTunnelTestServer(t, sm)
	slug := applyOneTunnel(t, sm)

	resp, err := http.Get(ts.URL + "/t/" + slug + "/")
	if err != nil {
		t.Fatalf("GET html through tunnel: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.Header.Get("Content-Length") == "999" {
		t.Fatal("stale Content-Length must be dropped for rewritten responses")
	}
	if !strings.Contains(string(body), "data-liveagent-tunnel-shim") {
		t.Fatalf("shim not injected: %q", body)
	}
	if !strings.Contains(string(body), "/t/"+slug+"/about") {
		t.Fatalf("href not rewritten: %q", body)
	}
	if policy := resp.Header.Get("Content-Security-Policy"); !strings.Contains(policy, "'sha256-") {
		t.Fatalf("CSP not hash-amended: %q", policy)
	}
}
