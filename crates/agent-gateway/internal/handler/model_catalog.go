package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

const (
	modelCatalogMaxBytes = 4 * 1024 * 1024
	// Upstream is published at most every 6 hours; revalidating every 10 minutes
	// keeps a fleet of browsers from turning into upstream load.
	modelCatalogRevalidateAfter = 10 * time.Minute
	modelCatalogRetryAfter      = 30 * time.Second
	// Below the WebUI's 30s fetch timeout, so a first request that has to wait
	// still gets an answer (503) before the browser moves to the next source.
	modelCatalogFetchTimeout = 20 * time.Second
	modelCatalogStaleHeader  = "X-LiveAgent-Catalog-Stale"
)

// ModelCatalogProxy serves the runtime model catalog to WebUI clients from the
// Gateway's own origin, so deployments whose browsers cannot reach
// raw.githubusercontent.com still get updates (the Gateway's outbound request
// honors HTTPS_PROXY). It caches bytes and the upstream ETag, never parses or
// rewrites the document beyond a shape check — clients run the full validation —
// and keeps serving the last good copy when upstream fails.
type ModelCatalogProxy struct {
	upstreamURL string
	client      *http.Client
	now         func() time.Time

	timeout time.Duration

	mu           sync.Mutex
	body         []byte
	etag         string
	upstreamETag string
	checkedAt    time.Time
	stale        bool
	refreshing   chan struct{}
}

// NewModelCatalogProxy returns nil when upstreamURL is empty (proxy disabled).
func NewModelCatalogProxy(upstreamURL string, timeout time.Duration) *ModelCatalogProxy {
	if upstreamURL == "" {
		return nil
	}
	if timeout <= 0 || timeout > modelCatalogFetchTimeout {
		timeout = modelCatalogFetchTimeout
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	return &ModelCatalogProxy{
		upstreamURL: upstreamURL,
		client:      &http.Client{Transport: transport},
		now:         time.Now,
		timeout:     timeout,
	}
}

func (p *ModelCatalogProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if p == nil {
		writeError(w, http.StatusNotFound, "model catalog proxy is disabled")
		return
	}
	body, etag, stale := p.current(r.Context())
	if body == nil {
		writeError(w, http.StatusServiceUnavailable, "model catalog is unavailable")
		return
	}
	header := w.Header()
	header.Set("Content-Type", "application/json")
	header.Set("Cache-Control", "no-cache")
	header.Set("ETag", etag)
	if stale {
		header.Set(modelCatalogStaleHeader, "1")
	}
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

// current returns the cached document and starts a revalidation when due.
// Upstream I/O never runs under p.mu: with a cached copy every request is
// answered at once while a single background fetch revalidates; only a
// Gateway that has never fetched successfully makes requests wait for that
// fetch (bounded by modelCatalogFetchTimeout, below the 30s client timeout).
// A failed check is remembered too: with a cached copy the next attempt waits
// the normal interval, without one it waits modelCatalogRetryAfter.
func (p *ModelCatalogProxy) current(ctx context.Context) (body []byte, etag string, stale bool) {
	p.mu.Lock()
	if !p.checkedAt.IsZero() && p.now().Sub(p.checkedAt) < p.nextCheckAfter() {
		defer p.mu.Unlock()
		return p.body, p.etag, p.stale
	}
	done := p.startRefreshLocked()
	if p.body != nil {
		defer p.mu.Unlock()
		return p.body, p.etag, p.stale
	}
	p.mu.Unlock()
	select {
	case <-done:
	case <-ctx.Done():
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.body, p.etag, p.stale
}

func (p *ModelCatalogProxy) nextCheckAfter() time.Duration {
	if p.body == nil {
		return modelCatalogRetryAfter
	}
	return modelCatalogRevalidateAfter
}

// startRefreshLocked starts the shared upstream fetch unless one is running and
// returns a channel closed when it finishes. Callers hold p.mu.
func (p *ModelCatalogProxy) startRefreshLocked() <-chan struct{} {
	if p.refreshing != nil {
		return p.refreshing
	}
	done := make(chan struct{})
	p.refreshing = done
	upstreamETag := ""
	if p.body != nil {
		upstreamETag = p.upstreamETag
	}
	go func() {
		defer close(done)
		fetched, err := p.fetch(upstreamETag)
		p.mu.Lock()
		defer p.mu.Unlock()
		if err == nil && fetched != nil {
			sum := sha256.Sum256(fetched.body)
			p.body = fetched.body
			p.etag = `"` + hex.EncodeToString(sum[:]) + `"`
			p.upstreamETag = fetched.upstreamETag
		}
		p.stale = err != nil && p.body != nil
		p.checkedAt = p.now()
		p.refreshing = nil
	}()
	return done
}

type fetchedModelCatalog struct {
	body         []byte
	upstreamETag string
}

// fetch returns nil without error when upstream answers 304 for upstreamETag.
func (p *ModelCatalogProxy) fetch(upstreamETag string) (*fetchedModelCatalog, error) {
	ctx, cancel := context.WithTimeout(context.Background(), p.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.upstreamURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if upstreamETag != "" {
		req.Header.Set("If-None-Match", upstreamETag)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotModified && upstreamETag != "" {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("model catalog upstream returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, modelCatalogMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > modelCatalogMaxBytes {
		return nil, fmt.Errorf("model catalog exceeds %d bytes", modelCatalogMaxBytes)
	}
	if err := checkModelCatalogShape(body); err != nil {
		return nil, err
	}
	return &fetchedModelCatalog{body: body, upstreamETag: resp.Header.Get("ETag")}, nil
}

// checkModelCatalogShape rejects documents that are obviously not a catalog
// (HTML error pages, truncated bodies) so they never replace a good copy.
func checkModelCatalogShape(body []byte) error {
	var document struct {
		SchemaVersion *int            `json:"schemaVersion"`
		SHA256        string          `json:"sha256"`
		Sections      json.RawMessage `json:"sections"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(&document); err != nil {
		return fmt.Errorf("model catalog is not JSON: %w", err)
	}
	if document.SchemaVersion == nil || document.SHA256 == "" ||
		len(document.Sections) == 0 || document.Sections[0] != '{' {
		return fmt.Errorf("model catalog is missing schemaVersion, sha256 or sections")
	}
	return nil
}
