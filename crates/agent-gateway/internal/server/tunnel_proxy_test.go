package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestParseTunnelPublicPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		raw  string
		slug string
		rest string
		ok   bool
	}{
		{"/t/abc/", "abc", "/", true},
		{"/t/abc/app/index.html", "abc", "/app/index.html", true},
		{"/t/abc", "abc", "/", true},
		{"/t/", "", "", false},
		{"/other", "", "", false},
	}
	for _, tt := range tests {
		slug, rest, ok := parseTunnelPublicPath(tt.raw)
		if slug != tt.slug || rest != tt.rest || ok != tt.ok {
			t.Fatalf("parseTunnelPublicPath(%q) = (%q, %q, %v), want (%q, %q, %v)",
				tt.raw, slug, rest, ok, tt.slug, tt.rest, tt.ok)
		}
	}

	if slug, ok := parseTunnelPublicPathWithoutTrailingSlash("/t/abc"); !ok || slug != "abc" {
		t.Fatalf("no-trailing-slash parse = (%q, %v)", slug, ok)
	}
	if _, ok := parseTunnelPublicPathWithoutTrailingSlash("/t/abc/x"); ok {
		t.Fatal("nested path must not match the redirect case")
	}
}

func TestTunnelRequestHeadersStripForwardedAndHopByHop(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "http://public.example/t/abc/", nil)
	req.Header.Set("X-Forwarded-Host", "evil.example")
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	req.Header.Set("Forwarded", "for=1.2.3.4")
	req.Header.Set("Connection", "keep-alive")
	req.Header.Set("Transfer-Encoding", "chunked")
	req.Header.Set("Accept", "text/html")
	req.Header.Set("Origin", "https://public.example")

	headers := tunnelRequestHeaders(req, "abc")
	byName := map[string][]string{}
	for _, header := range headers {
		byName[header.GetName()] = append(byName[header.GetName()], header.GetValue())
	}

	if got := byName["X-Forwarded-Host"]; len(got) != 1 || got[0] != "public.example" {
		t.Fatalf("X-Forwarded-Host = %v, want the gateway-derived host only", got)
	}
	for _, banned := range []string{"X-Forwarded-For", "Forwarded", "Connection", "Transfer-Encoding", "Host"} {
		if _, present := byName[banned]; present {
			t.Fatalf("header %q must be stripped", banned)
		}
	}
	if got := byName["X-Forwarded-Prefix"]; len(got) != 1 || got[0] != "/t/abc" {
		t.Fatalf("X-Forwarded-Prefix = %v", got)
	}
	if got := byName["X-Forwarded-Origin"]; len(got) != 1 || got[0] != "https://public.example" {
		t.Fatalf("X-Forwarded-Origin = %v", got)
	}
	if got := byName["Accept"]; len(got) != 1 || got[0] != "text/html" {
		t.Fatalf("Accept = %v, want passthrough", got)
	}
}

func TestTunnelWebSocketRequestHeadersStripSecWebSocket(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "http://public.example/t/abc/ws", nil)
	req.Header.Set("Sec-Websocket-Key", "k")
	req.Header.Set("Sec-Websocket-Version", "13")
	req.Header.Set("Sec-Websocket-Protocol", "graphql-ws")

	headers := tunnelWebSocketRequestHeaders(req, "abc")
	byName := map[string]string{}
	for _, header := range headers {
		byName[header.GetName()] = header.GetValue()
	}
	if _, present := byName["Sec-Websocket-Key"]; present {
		t.Fatal("Sec-WebSocket-Key must be stripped")
	}
	if _, present := byName["Sec-Websocket-Version"]; present {
		t.Fatal("Sec-WebSocket-Version must be stripped")
	}
	if got := byName["Sec-Websocket-Protocol"]; got != "graphql-ws" {
		t.Fatalf("Sec-WebSocket-Protocol = %q, want passthrough", got)
	}
}

func TestWriteTunnelAcquireErrorStatusMapping(t *testing.T) {
	t.Parallel()

	tests := []struct {
		err    error
		status int
	}{
		{session.ErrTunnelNotFound, http.StatusNotFound},
		{session.ErrTunnelExpired, http.StatusNotFound},
		{session.ErrAgentOffline, http.StatusServiceUnavailable},
		{session.ErrTunnelOverLimit, http.StatusTooManyRequests},
	}
	for _, tt := range tests {
		recorder := httptest.NewRecorder()
		writeTunnelAcquireError(recorder, tt.err)
		if recorder.Code != tt.status {
			t.Fatalf("status for %v = %d, want %d", tt.err, recorder.Code, tt.status)
		}
	}
}

func TestTunnelResponseHeadersRewriteLocationAndCookies(t *testing.T) {
	t.Parallel()

	rw := tunnelRewrite{slug: "abc", targetURL: "http://localhost:3000"}
	frame := &gatewayv2.TunnelFrame{
		Headers: []*gatewayv2.TunnelHeader{
			{Name: "Location", Value: "http://localhost:3000/login?next=%2F"},
			{Name: "Set-Cookie", Value: "sid=1; Path=/; HttpOnly"},
			{Name: "Transfer-Encoding", Value: "chunked"},
			{Name: "Content-Type", Value: "text/html"},
		},
	}
	headers := tunnelResponseHeaders(frame, rw)
	if got := headers.Get("Location"); got != "/t/abc/login?next=%2F" {
		t.Fatalf("Location = %q", got)
	}
	if got := headers.Get("Set-Cookie"); !strings.Contains(got, "Path=/t/abc/") {
		t.Fatalf("Set-Cookie = %q, want rewritten path", got)
	}
	if headers.Get("Transfer-Encoding") != "" {
		t.Fatal("hop-by-hop response header must be dropped")
	}
	if headers.Get("Content-Type") != "text/html" {
		t.Fatal("Content-Type must pass through")
	}
}

func TestAmendTunnelCSPHashAmendable(t *testing.T) {
	t.Parallel()

	headers := http.Header{}
	headers.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'")
	amendTunnelCSP(headers, "console.log(1)")
	policy := headers.Get("Content-Security-Policy")
	if !strings.Contains(policy, "script-src 'self' 'sha256-") {
		t.Fatalf("policy = %q, want sha256 appended to script-src", policy)
	}
	if strings.Contains(strings.TrimPrefix(policy, "default-src 'self' 'sha256-"), "default-src 'self' 'sha256-") {
		t.Fatalf("policy = %q, default-src must stay untouched when script-src exists", policy)
	}
}

func TestAmendTunnelCSPDefaultSrcFallback(t *testing.T) {
	t.Parallel()

	headers := http.Header{}
	headers.Set("Content-Security-Policy", "default-src 'self'")
	amendTunnelCSP(headers, "console.log(1)")
	if policy := headers.Get("Content-Security-Policy"); !strings.Contains(policy, "default-src 'self' 'sha256-") {
		t.Fatalf("policy = %q, want sha256 appended to default-src", policy)
	}
}

func TestAmendTunnelCSPNonceStripped(t *testing.T) {
	t.Parallel()

	headers := http.Header{}
	headers.Set("Content-Security-Policy", "script-src 'nonce-abc123'")
	headers.Set("Content-Security-Policy-Report-Only", "script-src 'self'")
	amendTunnelCSP(headers, "console.log(1)")
	if headers.Get("Content-Security-Policy") != "" {
		t.Fatal("nonce policy must be stripped")
	}
	if headers.Get("Content-Security-Policy-Report-Only") != "" {
		t.Fatal("report-only policy must be stripped alongside")
	}
	if headers.Get("X-Liveagent-Tunnel-Csp") != "stripped" {
		t.Fatal("stripped marker header missing")
	}
}

func TestAmendTunnelCSPUnsafeInlineLeftAlone(t *testing.T) {
	t.Parallel()

	headers := http.Header{}
	headers.Set("Content-Security-Policy", "script-src 'self' 'unsafe-inline'")
	amendTunnelCSP(headers, "console.log(1)")
	policy := headers.Get("Content-Security-Policy")
	if strings.Contains(policy, "sha256-") {
		t.Fatalf("policy = %q; adding a hash would re-disable 'unsafe-inline'", policy)
	}
}
