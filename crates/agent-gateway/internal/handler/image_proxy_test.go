package handler

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestImageProxyServesSupportedImage(t *testing.T) {
	client := outboundHTTPClientFunc(func(r *http.Request) (*http.Response, error) {
		if got := r.Header.Get("Accept"); got != imageProxyAccept {
			t.Fatalf("upstream Accept = %q, want %q", got, imageProxyAccept)
		}
		if got := r.Header.Get("Accept-Language"); got != imageProxyAcceptLanguage {
			t.Fatalf("upstream Accept-Language = %q, want %q", got, imageProxyAcceptLanguage)
		}
		if got := r.Header.Get("User-Agent"); got != imageProxyUserAgent {
			t.Fatalf("upstream User-Agent = %q, want %q", got, imageProxyUserAgent)
		}
		if got, want := r.Header.Get("Referer"), "https://images.example/"; got != want {
			t.Fatalf("upstream Referer = %q, want %q", got, want)
		}
		body := []byte("\x89PNG\r\n\x1a\nliveagent-test")
		return &http.Response{
			StatusCode:    http.StatusOK,
			Header:        http.Header{"Content-Type": []string{"image/png"}},
			Body:          io.NopCloser(strings.NewReader(string(body))),
			ContentLength: int64(len(body)),
			Request:       r,
		}, nil
	})

	req := httptest.NewRequest(http.MethodGet, "/image-proxy?url=https://images.example/photo.png", nil)
	rec := httptest.NewRecorder()
	imageProxyWithClient(client)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d body=%q", http.StatusOK, rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("content-type = %q, want image/png", got)
	}
}

func TestImageProxyServesSVGWithSandboxCSP(t *testing.T) {
	// 顶层导航到 SVG 会在网关 origin 执行脚本（WebUI 管理 token 在 localStorage）；
	// SVG 响应必须携带 sandbox CSP 与附件式处置,降级为纯图片源。
	client := outboundHTTPClientFunc(func(r *http.Request) (*http.Response, error) {
		body := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
		return &http.Response{
			StatusCode:    http.StatusOK,
			Header:        http.Header{"Content-Type": []string{"text/plain"}},
			Body:          io.NopCloser(strings.NewReader(string(body))),
			ContentLength: int64(len(body)),
			Request:       r,
		}, nil
	})

	req := httptest.NewRequest(http.MethodGet, "/image-proxy?url=https://evil.example/x.svg", nil)
	rec := httptest.NewRecorder()
	imageProxyWithClient(client)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d body=%q", http.StatusOK, rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "image/svg+xml" {
		t.Fatalf("content-type = %q, want image/svg+xml", got)
	}
	if got := rec.Header().Get("Content-Security-Policy"); got != "sandbox; default-src 'none'" {
		t.Fatalf("svg CSP = %q, want sandbox CSP", got)
	}
	if got := rec.Header().Get("Content-Disposition"); !strings.Contains(got, "inline") {
		t.Fatalf("svg content-disposition = %q, want inline attachment-style disposition", got)
	}
}

func TestImageProxyNonSVGHasNoSandboxCSP(t *testing.T) {
	client := outboundHTTPClientFunc(func(r *http.Request) (*http.Response, error) {
		body := []byte("\x89PNG\r\n\x1a\nliveagent-test")
		return &http.Response{
			StatusCode:    http.StatusOK,
			Header:        http.Header{"Content-Type": []string{"image/png"}},
			Body:          io.NopCloser(strings.NewReader(string(body))),
			ContentLength: int64(len(body)),
			Request:       r,
		}, nil
	})

	req := httptest.NewRequest(http.MethodGet, "/image-proxy?url=https://images.example/photo.png", nil)
	rec := httptest.NewRecorder()
	imageProxyWithClient(client)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d body=%q", http.StatusOK, rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Security-Policy"); got != "" {
		t.Fatalf("non-svg CSP = %q, want empty", got)
	}
}

func TestImageProxyRefererUsesTargetOrigin(t *testing.T) {
	targetURL, err := url.Parse("https://example.com:8443/path/photo.png?size=large")
	if err != nil {
		t.Fatalf("parse target url: %v", err)
	}

	if got, want := imageProxyReferer(targetURL), "https://example.com:8443/"; got != want {
		t.Fatalf("referer = %q, want %q", got, want)
	}
}

func TestApplyImageProxyRequestHeaders(t *testing.T) {
	targetURL, err := url.Parse("https://example.com/path/photo.png")
	if err != nil {
		t.Fatalf("parse target url: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/proxy", nil)

	applyImageProxyRequestHeaders(req, targetURL)

	if got := req.Header.Get("Accept"); got != imageProxyAccept {
		t.Fatalf("Accept = %q, want %q", got, imageProxyAccept)
	}
	if got := req.Header.Get("Accept-Language"); got != imageProxyAcceptLanguage {
		t.Fatalf("Accept-Language = %q, want %q", got, imageProxyAcceptLanguage)
	}
	if got := req.Header.Get("User-Agent"); got != imageProxyUserAgent {
		t.Fatalf("User-Agent = %q, want %q", got, imageProxyUserAgent)
	}
	if got, want := req.Header.Get("Referer"), "https://example.com/"; got != want {
		t.Fatalf("Referer = %q, want %q", got, want)
	}
}

func TestImageProxyRejectsNonImage(t *testing.T) {
	client := outboundHTTPClientFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode:    http.StatusOK,
			Header:        http.Header{"Content-Type": []string{"text/html"}},
			Body:          io.NopCloser(strings.NewReader("<html></html>")),
			ContentLength: int64(len("<html></html>")),
			Request:       r,
		}, nil
	})

	req := httptest.NewRequest(http.MethodGet, "/image-proxy?url=https://images.example/page", nil)
	rec := httptest.NewRecorder()
	imageProxyWithClient(client)(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected status %d, got %d", http.StatusBadGateway, rec.Code)
	}
}

func TestImageProxyRejectsLoopbackURL(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/image-proxy?url=http://127.0.0.1/photo.png", nil)
	rec := httptest.NewRecorder()

	ImageProxy(time.Second)(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d body=%q", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func TestImageProxyRejectsIPv4MappedLoopbackURL(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/image-proxy?url=http://[::ffff:127.0.0.1]/photo.png", nil)
	rec := httptest.NewRecorder()

	ImageProxy(time.Second)(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d body=%q", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func TestImageProxyDoesNotTrustSpoofedImageContentType(t *testing.T) {
	client := outboundHTTPClientFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode:    http.StatusOK,
			Header:        http.Header{"Content-Type": []string{"image/png"}},
			Body:          io.NopCloser(strings.NewReader("<html></html>")),
			ContentLength: int64(len("<html></html>")),
			Request:       r,
		}, nil
	})

	req := httptest.NewRequest(http.MethodGet, "/image-proxy?url=https://images.example/spoofed", nil)
	rec := httptest.NewRecorder()
	imageProxyWithClient(client)(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected status %d, got %d", http.StatusBadGateway, rec.Code)
	}
}

func TestResolveImageProxyMimeDetectsSVGFromBytes(t *testing.T) {
	mimeType, ok := resolveImageProxyMime("text/plain", []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`))
	if !ok || mimeType != "image/svg+xml" {
		t.Fatalf("resolveImageProxyMime() = %q, %v; want image/svg+xml, true", mimeType, ok)
	}
}

type outboundHTTPClientFunc func(*http.Request) (*http.Response, error)

func (fn outboundHTTPClientFunc) Do(req *http.Request) (*http.Response, error) {
	return fn(req)
}
