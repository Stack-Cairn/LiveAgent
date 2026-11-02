package server

import (
	"io"
	"time"

	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	"github.com/liveagent/agent-gateway/internal/kbrain"
	"github.com/liveagent/agent-gateway/internal/session"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSingleUserImageDeploymentExplicitAndLoopback(t *testing.T) {
	cfg := &config.Config{Token: "gateway-fixture", KBrainToken: "backend-fixture", KBrainURL: "http://127.0.0.1:1", KBrainAgentID: "selected"}
	if localImages(cfg) != nil {
		t.Fatal("enabled without opt-in")
	}
	cfg.ImageSingleUser = true
	if localImages(cfg) == nil {
		t.Fatal("explicit local mode unavailable")
	}
	for _, raw := range []string{"https://example.com", "http://localhost:1", "http://user:secret@127.0.0.1:1", "http://127.0.0.1:1?token=secret"} {
		cfg.KBrainURL = raw
		if localImages(cfg) != nil {
			t.Fatal("unsafe backend accepted")
		}
	}
}
func TestSingleUserImageIdentityAndLocalForwarding(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer backend-fixture" || r.Header.Get(kbrain.ImageDelegationHeader) != "" || r.Header.Get("X-Owner-ID") != "" {
			t.Fatal("unsafe upstream identity")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"kbrain.image.v1","items":[]}`))
	}))
	defer upstream.Close()
	cfg := &config.Config{ImageSingleUser: true, Token: "gateway-fixture", KBrainToken: "backend-fixture", KBrainURL: upstream.URL, KBrainAgentID: "selected"}
	images := localImages(cfg)
	if images == nil {
		t.Fatal("not configured")
	}
	r := httptest.NewRequest("GET", "/api/image/identity", nil)
	w := httptest.NewRecorder()
	localImageIdentity(cfg, images)(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	r.Header.Set("Authorization", "Bearer gateway-fixture")
	w = httptest.NewRecorder()
	localImageIdentity(cfg, images)(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"ownerId":"local"`) || strings.Contains(w.Body.String(), "fixture") {
		t.Fatal("identity invalid or secret exposed")
	}
	r = httptest.NewRequest("GET", "/api/image/targets?backendId=selected", nil)
	r.Header.Set("Authorization", "Bearer gateway-fixture")
	r.Header.Set("X-Owner-ID", "forged")
	w = httptest.NewRecorder()
	images.ServeHTTP(w, r)
	if w.Code != 200 || calls != 1 {
		t.Fatalf("forward %d calls%d", w.Code, calls)
	}
}

func TestImageSpecificBackendNeedsNoSwitchAndIgnoresChatBackend(t *testing.T) {
	cfg := &config.Config{Token: "gateway-fixture", KBrainAgentID: "selected", ImageKBrainURL: "http://127.0.0.1:1", ImageKBrainToken: "image-fixture"}
	if localImages(cfg) == nil {
		t.Fatal("image-specific backend should enable images without the legacy switch")
	}
	url, token, ok := imageBackendConnection(cfg)
	if !ok || url != "http://127.0.0.1:1" || token != "image-fixture" {
		t.Fatal("image-specific pair not selected")
	}
	// A half-configured image pair must not silently fall back to the chat backend.
	for _, half := range []*config.Config{
		{Token: "gateway-fixture", KBrainAgentID: "selected", ImageSingleUser: true, KBrainURL: "http://127.0.0.1:2", KBrainToken: "chat-fixture", ImageKBrainURL: "http://127.0.0.1:1"},
		{Token: "gateway-fixture", KBrainAgentID: "selected", ImageSingleUser: true, KBrainURL: "http://127.0.0.1:2", KBrainToken: "chat-fixture", ImageKBrainToken: "image-fixture"},
	} {
		if localImages(half) != nil {
			t.Fatal("half image config fell back to the chat backend")
		}
	}
	for _, good := range []string{"http://[::1]:1", "https://127.0.0.1:1"} {
		cfg.ImageKBrainURL = good
		if localImages(cfg) == nil {
			t.Fatalf("loopback image backend rejected: %s", good)
		}
	}
	for _, raw := range []string{"https://example.com", "http://localhost:1", "http://user:secret@127.0.0.1:1", "http://127.0.0.1:1?token=secret"} {
		cfg.ImageKBrainURL = raw
		if localImages(cfg) != nil {
			t.Fatalf("unsafe image backend accepted: %s", raw)
		}
	}
	cfg.ImageKBrainURL = "http://127.0.0.1:1"
	cfg.Token = ""
	if localImages(cfg) != nil {
		t.Fatal("images enabled without a Gateway token")
	}
}

func TestImageIdentityFollowsImageAvailabilityNotTheSwitch(t *testing.T) {
	cfg := &config.Config{Token: "gateway-fixture", KBrainAgentID: "selected", ImageKBrainURL: "http://127.0.0.1:1", ImageKBrainToken: "image-fixture"}
	r := httptest.NewRequest("GET", "/api/image/identity", nil)
	r.Header.Set("Authorization", "Bearer gateway-fixture")
	w := httptest.NewRecorder()
	localImageIdentity(cfg, localImages(cfg))(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"backendId":"selected"`) || !strings.Contains(w.Body.String(), `"mode":"single_user"`) || strings.Contains(w.Body.String(), "fixture") {
		t.Fatalf("identity %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	localImageIdentity(&config.Config{Token: "gateway-fixture", KBrainAgentID: "selected"}, nil)(w, r)
	if w.Code != 503 {
		t.Fatalf("identity without an image backend: %d", w.Code)
	}
	// A delegated (non-local) gateway must not be reported as the desktop's local owner.
	delegated := &handler.ImageGateway{Backends: map[string]handler.ImageBackend{"selected": {}}}
	w = httptest.NewRecorder()
	localImageIdentity(cfg, delegated)(w, r)
	if w.Code != 503 {
		t.Fatalf("identity claimed local scope for a delegated gateway: %d", w.Code)
	}
}

func TestLocalImageHubRebindsWithoutRestart(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer second-backend" {
			t.Errorf("stale backend token forwarded: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"kbrain.image.v1","items":[]}`))
	}))
	defer upstream.Close()
	cfg := &config.Config{Token: "gateway-fixture", KBrainAgentID: "selected"}
	hub := NewLocalImageHub(cfg)
	server := NewHTTPServerWithLocalImages(cfg, session.NewManager(), nil, hub)
	identity := func() int {
		r := httptest.NewRequest("GET", "/api/image/identity", nil)
		r.Header.Set("Authorization", "Bearer gateway-fixture")
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		return w.Code
	}
	if identity() != 503 {
		t.Fatal("images enabled before the desktop provided a backend")
	}
	hub.Update("http://127.0.0.1:1", "first-backend")
	if identity() != 200 {
		t.Fatal("first backend not served")
	}
	hub.Update(upstream.URL+"/", " second-backend ")
	r := httptest.NewRequest("GET", "/api/image/targets?backendId=selected", nil)
	r.Header.Set("Authorization", "Bearer gateway-fixture")
	w := httptest.NewRecorder()
	server.ServeHTTP(w, r)
	if w.Code != 200 || calls != 1 {
		t.Fatalf("rebound backend not used: %d calls %d", w.Code, calls)
	}
	hub.Update("", "")
	if identity() != 503 {
		t.Fatal("stopped K-Brain still advertised")
	}
	hub.Update("http://example.com:1", "token")
	if identity() != 503 {
		t.Fatal("non-loopback rebind accepted")
	}
}

func TestWatchDesktopParentAppliesControlLinesAndClosesOnEOF(t *testing.T) {
	cfg := &config.Config{Token: "gateway-fixture", KBrainAgentID: "selected"}
	hub := NewLocalImageHub(cfg)
	reader, writer := io.Pipe()
	closed := WatchDesktopParent(reader, hub)
	send := func(line string) {
		if _, err := writer.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	waitFor := func(enabled bool) {
		deadline := time.Now().Add(2 * time.Second)
		for (hub.current.Load() != nil) != enabled {
			if time.Now().After(deadline) {
				t.Fatalf("hub enabled=%v never reached", enabled)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	send("not json")
	send(`{"type":"unknown","url":"http://127.0.0.1:1","token":"x"}`)
	send(`{"type":"image_backend","url":"http://127.0.0.1:1","token":"kb"}`)
	waitFor(true)
	send(`{"type":"image_backend"}`)
	waitFor(false)
	select {
	case <-closed:
		t.Fatal("closed before EOF")
	default:
	}
	send(strings.Repeat("x", 70<<10)) // oversized line: ignored, EOF still detected
	_ = writer.Close()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("EOF did not signal the parent exit")
	}
}
