package handler

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gabriel-vasile/mimetype"
)

const (
	imageProxyMaxBytes       = 25 * 1024 * 1024
	imageProxyAccept         = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
	imageProxyAcceptLanguage = "en-US,en;q=0.9"
	imageProxyUserAgent      = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

func ImageProxy(timeout time.Duration) http.HandlerFunc {
	return imageProxyWithClient(newSafeOutboundHTTPClient(timeout))
}

func imageProxyWithClient(client outboundHTTPClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
		targetURL, err := validateImageProxyURL(rawURL)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL.String(), nil)
		if err != nil {
			http.Error(w, fmt.Sprintf("failed to create image proxy request: %v", err), http.StatusBadRequest)
			return
		}
		applyImageProxyRequestHeaders(upstreamReq, targetURL)

		resp, err := client.Do(upstreamReq)
		if err != nil {
			if isSafeOutboundBlockedError(err) {
				http.Error(w, "image proxy URL is not allowed", http.StatusBadRequest)
				return
			}
			http.Error(w, fmt.Sprintf("failed to load image through proxy: %v", err), http.StatusBadGateway)
			return
		}
		defer func() { _ = resp.Body.Close() }()

		if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
			http.Error(w, fmt.Sprintf("image proxy upstream returned HTTP status %d", resp.StatusCode), http.StatusBadGateway)
			return
		}
		if resp.ContentLength > imageProxyMaxBytes {
			http.Error(w, "image proxy response is too large", http.StatusRequestEntityTooLarge)
			return
		}

		body, err := io.ReadAll(io.LimitReader(resp.Body, imageProxyMaxBytes+1))
		if err != nil {
			http.Error(w, fmt.Sprintf("failed to read image proxy response: %v", err), http.StatusBadGateway)
			return
		}
		if len(body) > imageProxyMaxBytes {
			http.Error(w, "image proxy response is too large", http.StatusRequestEntityTooLarge)
			return
		}

		mimeType, ok := resolveImageProxyMime(resp.Header.Get("Content-Type"), body)
		if !ok {
			http.Error(w, "image proxy upstream response is not a supported image", http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", mimeType)
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
		w.Header().Set("Cache-Control", "private, max-age=300")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if mimeType == "image/svg+xml" {
			// SVG 可携带脚本；顶层导航到 SVG 会在网关 origin 执行脚本（WebUI
			// 的管理 token 在 localStorage）。sandbox 禁脚本 + 附件式内联处置
			// 把该端点降级为纯图片源。
			w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
			w.Header().Set("Content-Disposition", `inline; filename="image.svg"`)
		}
		_, _ = w.Write(body)
	}
}

func applyImageProxyRequestHeaders(req *http.Request, targetURL *url.URL) {
	req.Header.Set("Accept", imageProxyAccept)
	req.Header.Set("Accept-Language", imageProxyAcceptLanguage)
	req.Header.Set("User-Agent", imageProxyUserAgent)
	req.Header.Set("Referer", imageProxyReferer(targetURL))
}

func imageProxyReferer(targetURL *url.URL) string {
	if targetURL == nil || targetURL.Scheme == "" || targetURL.Host == "" {
		return ""
	}
	return (&url.URL{Scheme: targetURL.Scheme, Host: targetURL.Host, Path: "/"}).String()
}

func validateImageProxyURL(raw string) (*url.URL, error) {
	parsed, err := validateOutboundHTTPURL(raw)
	if err != nil {
		return nil, fmt.Errorf("image URL is not allowed: %v", err)
	}
	return parsed, nil
}

func normalizeImageProxyMime(value string) (string, bool) {
	mimeType := strings.ToLower(strings.TrimSpace(strings.Split(value, ";")[0]))
	switch mimeType {
	case "image/png":
		return "image/png", true
	case "image/jpeg", "image/jpg":
		return "image/jpeg", true
	case "image/gif":
		return "image/gif", true
	case "image/webp":
		return "image/webp", true
	case "image/bmp":
		return "image/bmp", true
	case "image/svg+xml":
		return "image/svg+xml", true
	case "image/x-icon", "image/vnd.microsoft.icon":
		return "image/x-icon", true
	default:
		return "", false
	}
}

func resolveImageProxyMime(_ string, body []byte) (string, bool) {
	if detected := mimetype.Detect(body); detected != nil {
		if mimeType, ok := normalizeImageProxyMime(detected.String()); ok {
			return mimeType, true
		}
	}
	return "", false
}
