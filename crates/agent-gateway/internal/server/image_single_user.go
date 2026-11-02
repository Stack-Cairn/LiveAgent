package server

import (
	"bufio"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"

	"github.com/liveagent/agent-gateway/internal/auth"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	"github.com/liveagent/agent-gateway/internal/kbrain"
)

// imageBackendConnection picks the K-Brain that serves Image Studio at startup.
// The image-specific pair needs no opt-in and never touches KBrainURL, so it cannot
// enable the K-Brain chat relay. A half-configured pair disables images rather
// than silently falling back to the chat backend. The legacy KBrainURL pair still
// requires the explicit ImageSingleUser switch.
func imageBackendConnection(cfg *config.Config) (string, string, bool) {
	if cfg.ImageKBrainURL != "" || cfg.ImageKBrainToken != "" {
		return cfg.ImageKBrainURL, cfg.ImageKBrainToken, cfg.ImageKBrainURL != "" && cfg.ImageKBrainToken != ""
	}
	if cfg.ImageSingleUser {
		return cfg.KBrainURL, cfg.KBrainToken, true
	}
	return "", "", false
}

// localImages builds the startup Image Studio route from configuration.
func localImages(cfg *config.Config) *handler.ImageGateway {
	if cfg == nil {
		return nil
	}
	rawURL, token, ok := imageBackendConnection(cfg)
	if !ok {
		return nil
	}
	return buildLocalImages(cfg, rawURL, token)
}

// buildLocalImages forwards Image Studio to a K-Brain on this host under the
// desktop owner's "local" scope, so the browser shares the desktop's history and
// assets. Anyone holding the Gateway token can already drive the agent; image
// access adds no broader authority. Multi-user delegation is a separate, signed mode.
func buildLocalImages(cfg *config.Config, rawURL, token string) *handler.ImageGateway {
	if cfg == nil || cfg.Token == "" || strings.TrimSpace(cfg.KBrainAgentID) == "" || token == "" {
		return nil
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !ip.IsLoopback() || (u.Scheme != "http" && u.Scheme != "https") {
		return nil
	}
	client, err := kbrain.New(rawURL, token, &http.Client{Transport: &http.Transport{Proxy: nil}})
	if err != nil {
		return nil
	}
	id := cfg.KBrainAgentID
	return &handler.ImageGateway{Backends: map[string]handler.ImageBackend{id: {Client: client, SingleUserLocal: true}}, ResolvePrincipal: func(r *http.Request) (auth.ImagePrincipal, error) {
		if !auth.ValidateBearerHeader(r.Header.Get("Authorization"), cfg.Token) {
			return auth.ImagePrincipal{}, http.ErrNoCookie
		}
		return auth.ImagePrincipal{OwnerID: "local", Backends: map[string]auth.ImageGrant{id: {Execute: true, Configure: true}}}, nil
	}}
}

// LocalImageHub holds the current Image Studio route. The desktop rebinds it
// while running (K-Brain restarts on a new port/token, or stops) so the Gateway
// process, its agent connection and browser sessions survive the change.
type LocalImageHub struct {
	cfg     *config.Config
	current atomic.Pointer[handler.ImageGateway]
}

func NewLocalImageHub(cfg *config.Config) *LocalImageHub {
	hub := &LocalImageHub{cfg: cfg}
	hub.current.Store(localImages(cfg))
	return hub
}

// fixedImageHub serves an explicitly supplied gateway (tests, delegated mode).
func fixedImageHub(cfg *config.Config, images *handler.ImageGateway) *LocalImageHub {
	hub := &LocalImageHub{cfg: cfg}
	hub.current.Store(images)
	return hub
}

// Update replaces the backend; an empty or invalid URL/token disables images.
func (h *LocalImageHub) Update(rawURL, token string) {
	h.current.Store(buildLocalImages(h.cfg, strings.TrimRight(strings.TrimSpace(rawURL), "/"), strings.TrimSpace(token)))
}

func (h *LocalImageHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// A nil *ImageGateway answers IMAGE_IDENTITY_UNAVAILABLE.
	h.current.Load().ServeHTTP(w, r)
}

func (h *LocalImageHub) identity() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		localImageIdentity(h.cfg, h.current.Load())(w, r)
	}
}

func localImageIdentity(cfg *config.Config, images *handler.ImageGateway) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		// Only the loopback local-owner gateway may claim the desktop's "local" scope.
		if cfg == nil || images == nil || !images.Backends[cfg.KBrainAgentID].SingleUserLocal {
			writeJSON(w, 503, map[string]any{"error": map[string]any{"code": "IMAGE_IDENTITY_UNAVAILABLE"}})
			return
		}
		if !auth.ValidateBearerHeader(r.Header.Get("Authorization"), cfg.Token) {
			writeJSON(w, 401, map[string]any{"error": map[string]any{"code": "IMAGE_AUTH_REQUIRED"}})
			return
		}
		// "single_user" is the wire value the WebUI identity check expects.
		writeJSON(w, 200, map[string]any{"ownerId": "local", "backendId": cfg.KBrainAgentID, "mode": "single_user"})
	}
}

// desktopControl is one line the owning desktop writes to the Gateway's stdin.
type desktopControl struct {
	Type  string `json:"type"`
	URL   string `json:"url"`
	Token string `json:"token"`
}

// WatchDesktopParent consumes the desktop's stdin pipe. The desktop never closes
// its write end while alive, so EOF (including on force termination) means the
// parent is gone. Lines are control messages; unknown or malformed ones are
// ignored and never logged, since they may carry a bearer token.
func WatchDesktopParent(reader io.Reader, hub *LocalImageHub) <-chan struct{} {
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 0, 4096), 64<<10)
		for scanner.Scan() {
			var msg desktopControl
			if json.Unmarshal(scanner.Bytes(), &msg) != nil {
				continue
			}
			if msg.Type == "image_backend" && hub != nil {
				hub.Update(msg.URL, msg.Token)
				slog.Info("desktop updated the Image Studio backend", "enabled", hub.current.Load() != nil)
			}
		}
		// An oversized line stops the scanner; keep draining so EOF still means exit.
		if scanner.Err() != nil {
			_, _ = io.Copy(io.Discard, reader)
		}
	}()
	return closed
}
