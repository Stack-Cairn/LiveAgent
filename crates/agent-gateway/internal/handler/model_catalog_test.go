package handler

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

const testCatalogBody = `{"schemaVersion":1,"snapshotDate":"2026-10-30","sections":{"openai":[]},"sha256":"abc"}`

type catalogUpstream struct {
	server  *httptest.Server
	hits    atomic.Int32
	status  atomic.Int32
	body    atomic.Value
	lastINM atomic.Value
}

func newCatalogUpstream(t *testing.T) *catalogUpstream {
	t.Helper()
	u := &catalogUpstream{}
	u.status.Store(http.StatusOK)
	u.body.Store(testCatalogBody)
	u.lastINM.Store("")
	u.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.hits.Add(1)
		u.lastINM.Store(r.Header.Get("If-None-Match"))
		status := int(u.status.Load())
		if status == http.StatusOK && r.Header.Get("If-None-Match") == `"upstream-v1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"upstream-v1"`)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(u.body.Load().(string)))
	}))
	t.Cleanup(u.server.Close)
	return u
}

func newTestCatalogProxy(t *testing.T, upstreamURL string) (*ModelCatalogProxy, *time.Time) {
	t.Helper()
	proxy := NewModelCatalogProxy(upstreamURL, 5*time.Second)
	clock := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	proxy.now = func() time.Time { return clock }
	return proxy, &clock
}

// waitForCatalogRefresh blocks until the background revalidation (if any) is done.
func waitForCatalogRefresh(t *testing.T, proxy *ModelCatalogProxy) {
	t.Helper()
	proxy.mu.Lock()
	done := proxy.refreshing
	proxy.mu.Unlock()
	if done == nil {
		return
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("background revalidation did not finish")
	}
}

func serveCatalog(proxy http.Handler, ifNoneMatch string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/public/model-catalog", nil)
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req)
	return rec
}

func TestModelCatalogProxyServesAndCachesUpstream(t *testing.T) {
	upstream := newCatalogUpstream(t)
	proxy, _ := newTestCatalogProxy(t, upstream.server.URL)

	first := serveCatalog(proxy, "")
	if first.Code != http.StatusOK || first.Body.String() != testCatalogBody {
		t.Fatalf("first response = %d %q", first.Code, first.Body.String())
	}
	if first.Header().Get("ETag") == "" || first.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("missing cache headers: %v", first.Header())
	}
	if got := first.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("content type = %q", got)
	}

	second := serveCatalog(proxy, "")
	if second.Code != http.StatusOK || second.Body.String() != testCatalogBody {
		t.Fatalf("cached response = %d %q", second.Code, second.Body.String())
	}
	if hits := upstream.hits.Load(); hits != 1 {
		t.Fatalf("upstream hits within revalidate window = %d, want 1", hits)
	}
}

func TestModelCatalogProxyRevalidatesWithUpstreamETag(t *testing.T) {
	upstream := newCatalogUpstream(t)
	proxy, clock := newTestCatalogProxy(t, upstream.server.URL)
	serveCatalog(proxy, "")

	*clock = clock.Add(modelCatalogRevalidateAfter + time.Second)
	rec := serveCatalog(proxy, "")
	if rec.Code != http.StatusOK || rec.Body.String() != testCatalogBody {
		t.Fatalf("revalidated response = %d %q", rec.Code, rec.Body.String())
	}
	waitForCatalogRefresh(t, proxy)
	rec = serveCatalog(proxy, "")
	if hits := upstream.hits.Load(); hits != 2 {
		t.Fatalf("upstream hits = %d, want 2", hits)
	}
	if inm := upstream.lastINM.Load().(string); inm != `"upstream-v1"` {
		t.Fatalf("revalidation If-None-Match = %q", inm)
	}
	if rec.Header().Get(modelCatalogStaleHeader) != "" {
		t.Fatalf("304 revalidation must not mark the copy stale")
	}
}

func TestModelCatalogProxyServesStaleCopyWhenUpstreamFails(t *testing.T) {
	upstream := newCatalogUpstream(t)
	proxy, clock := newTestCatalogProxy(t, upstream.server.URL)
	serveCatalog(proxy, "")

	upstream.status.Store(http.StatusBadGateway)
	*clock = clock.Add(modelCatalogRevalidateAfter + time.Second)
	// The cached copy is served at once; the failing revalidation runs behind it.
	if rec := serveCatalog(proxy, ""); rec.Code != http.StatusOK || rec.Body.String() != testCatalogBody {
		t.Fatalf("response during revalidation = %d %q", rec.Code, rec.Body.String())
	}
	waitForCatalogRefresh(t, proxy)
	rec := serveCatalog(proxy, "")
	if rec.Code != http.StatusOK || rec.Body.String() != testCatalogBody {
		t.Fatalf("stale response = %d %q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get(modelCatalogStaleHeader) != "1" {
		t.Fatalf("stale copy must carry %s", modelCatalogStaleHeader)
	}
	// The failed check is remembered: the next request inside the window does
	// not hit the broken upstream again.
	hits := upstream.hits.Load()
	again := serveCatalog(proxy, "")
	if upstream.hits.Load() != hits || again.Header().Get(modelCatalogStaleHeader) != "1" {
		t.Fatalf("failed upstream retried inside the window (hits %d -> %d)", hits, upstream.hits.Load())
	}
}

func TestModelCatalogProxyReturnsUnavailableWithoutCache(t *testing.T) {
	upstream := newCatalogUpstream(t)
	upstream.status.Store(http.StatusInternalServerError)
	proxy, clock := newTestCatalogProxy(t, upstream.server.URL)

	if rec := serveCatalog(proxy, ""); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("no cache + failing upstream = %d, want 503", rec.Code)
	}
	// Backs off instead of hammering upstream, then recovers.
	serveCatalog(proxy, "")
	if hits := upstream.hits.Load(); hits != 1 {
		t.Fatalf("upstream hits during retry backoff = %d, want 1", hits)
	}
	upstream.status.Store(http.StatusOK)
	*clock = clock.Add(modelCatalogRetryAfter + time.Second)
	if rec := serveCatalog(proxy, ""); rec.Code != http.StatusOK {
		t.Fatalf("after recovery = %d, want 200", rec.Code)
	}
}

func TestModelCatalogProxyAnswersClientConditionalRequest(t *testing.T) {
	upstream := newCatalogUpstream(t)
	proxy, _ := newTestCatalogProxy(t, upstream.server.URL)
	etag := serveCatalog(proxy, "").Header().Get("ETag")

	rec := serveCatalog(proxy, etag)
	if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
		t.Fatalf("matching If-None-Match = %d (%d bytes), want 304", rec.Code, rec.Body.Len())
	}
	if rec := serveCatalog(proxy, `"other"`); rec.Code != http.StatusOK {
		t.Fatalf("non-matching If-None-Match = %d, want 200", rec.Code)
	}
}

func TestModelCatalogProxyNeverCachesNonCatalogBodies(t *testing.T) {
	for name, body := range map[string]string{
		"html error page":   "<html>rate limited</html>",
		"truncated json":    testCatalogBody[:40],
		"missing sections":  `{"schemaVersion":1,"sha256":"abc"}`,
		"sections is array": `{"schemaVersion":1,"sha256":"abc","sections":[]}`,
	} {
		t.Run(name, func(t *testing.T) {
			upstream := newCatalogUpstream(t)
			upstream.body.Store(body)
			proxy, _ := newTestCatalogProxy(t, upstream.server.URL)
			if rec := serveCatalog(proxy, ""); rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("invalid upstream body served with %d", rec.Code)
			}
		})
	}
}

func TestModelCatalogProxyKeepsGoodCopyWhenUpstreamTurnsInvalid(t *testing.T) {
	upstream := newCatalogUpstream(t)
	proxy, clock := newTestCatalogProxy(t, upstream.server.URL)
	serveCatalog(proxy, "")

	upstream.body.Store("<html>oops</html>")
	upstream.lastINM.Store("")
	// Force a full fetch: an upstream that changes ETag returns the new body.
	proxy.upstreamETag = ""
	*clock = clock.Add(modelCatalogRevalidateAfter + time.Second)
	serveCatalog(proxy, "")
	waitForCatalogRefresh(t, proxy)
	rec := serveCatalog(proxy, "")
	if rec.Code != http.StatusOK || rec.Body.String() != testCatalogBody {
		t.Fatalf("good copy replaced by invalid upstream: %d %q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get(modelCatalogStaleHeader) != "1" {
		t.Fatalf("an invalid upstream body must mark the kept copy stale")
	}
}

func TestModelCatalogProxyDisabledReturnsNotFound(t *testing.T) {
	proxy := NewModelCatalogProxy("", time.Second)
	if proxy != nil {
		t.Fatalf("empty upstream URL must disable the proxy")
	}
	if rec := serveCatalog(proxy, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("disabled proxy = %d, want 404", rec.Code)
	}
}
