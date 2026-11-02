package handler

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// 评审回归：缓存已有可用副本时，到期回源若挂起（国内网络下 raw 被黑洞是本代理
// 要解决的场景），其他请求不应排在回源后面等到 RequestTimeout。WebUI 客户端
// 超时 30 秒，Gateway 默认 RequestTimeout 2 分钟：排队请求全部超时，代理形同虚设。
func TestReviewModelCatalogProxyServesCachedCopyWhileRevalidationHangs(t *testing.T) {
	var hang atomic.Bool
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hang.Load() {
			select {
			case <-release:
			case <-r.Context().Done():
			}
			return
		}
		w.Header().Set("ETag", `"upstream-v1"`)
		_, _ = w.Write([]byte(testCatalogBody))
	}))
	t.Cleanup(func() {
		close(release)
		upstream.Close()
	})

	// 上游超时取 3 秒代替默认的 2 分钟。
	proxy := NewModelCatalogProxy(upstream.URL, 3*time.Second)
	var clock atomic.Int64
	clock.Store(time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC).UnixNano())
	proxy.now = func() time.Time { return time.Unix(0, clock.Load()) }

	if first := serveCatalog(proxy, ""); first.Code != http.StatusOK {
		t.Fatalf("warm-up response = %d", first.Code)
	}

	// 缓存到期，上游开始挂起。第一个请求触发回源。
	clock.Add(int64(modelCatalogRevalidateAfter + time.Second))
	hang.Store(true)
	go serveCatalog(proxy, "")
	time.Sleep(100 * time.Millisecond)

	// 第二个请求：已有缓存副本，应立即拿到（可标 stale），而不是等回源结束。
	done := make(chan *httptest.ResponseRecorder, 1)
	started := time.Now()
	go func() { done <- serveCatalog(proxy, "") }()
	select {
	case rec := <-done:
		if rec.Code != http.StatusOK || rec.Body.String() != testCatalogBody {
			t.Fatalf("cached response = %d %q", rec.Code, rec.Body.String())
		}
	case <-time.After(1 * time.Second):
		rec := <-done
		t.Fatalf("request with a cached copy waited %v behind a hanging revalidation (status %d)",
			time.Since(started).Round(100*time.Millisecond), rec.Code)
	}
}

// 第二轮：冷启动无缓存时，并发请求共享同一次回源，全部拿到同一份文档。
func TestReviewModelCatalogProxyColdBurstSharesOneUpstreamFetch(t *testing.T) {
	var hits atomic.Int32
	gate := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		<-gate
		w.Header().Set("ETag", `"upstream-v1"`)
		_, _ = w.Write([]byte(testCatalogBody))
	}))
	t.Cleanup(upstream.Close)
	proxy := NewModelCatalogProxy(upstream.URL, 3*time.Second)

	const clients = 16
	results := make(chan *httptest.ResponseRecorder, clients)
	for range clients {
		go func() { results <- serveCatalog(proxy, "") }()
	}
	time.Sleep(100 * time.Millisecond)
	close(gate)
	for range clients {
		rec := <-results
		if rec.Code != http.StatusOK || rec.Body.String() != testCatalogBody {
			t.Fatalf("cold burst response = %d %q", rec.Code, rec.Body.String())
		}
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("upstream fetched %d times for one cold burst", got)
	}
}

// 第二轮：有缓存且回源失败后，响应标 stale；上游恢复、下一次到期回源成功后清除。
func TestReviewModelCatalogProxyStaleFlagClearsAfterRecovery(t *testing.T) {
	var failing atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failing.Load() {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(testCatalogBody))
	}))
	t.Cleanup(upstream.Close)
	proxy := NewModelCatalogProxy(upstream.URL, 3*time.Second)
	var clock atomic.Int64
	clock.Store(time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC).UnixNano())
	proxy.now = func() time.Time { return time.Unix(0, clock.Load()) }
	if rec := serveCatalog(proxy, ""); rec.Code != http.StatusOK {
		t.Fatalf("warm-up = %d", rec.Code)
	}

	failing.Store(true)
	clock.Add(int64(modelCatalogRevalidateAfter + time.Second))
	serveCatalog(proxy, "")
	waitForCatalogRefresh(t, proxy)
	if rec := serveCatalog(proxy, ""); rec.Header().Get(modelCatalogStaleHeader) != "1" || rec.Code != http.StatusOK {
		t.Fatalf("after failed revalidation: %d stale=%q", rec.Code, rec.Header().Get(modelCatalogStaleHeader))
	}

	failing.Store(false)
	clock.Add(int64(modelCatalogRevalidateAfter + time.Second))
	serveCatalog(proxy, "")
	waitForCatalogRefresh(t, proxy)
	if rec := serveCatalog(proxy, ""); rec.Header().Get(modelCatalogStaleHeader) != "" {
		t.Fatalf("stale flag kept after upstream recovered: %q", rec.Header().Get(modelCatalogStaleHeader))
	}
}
