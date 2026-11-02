package kbrain

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const ImageDelegationHeader = "X-Kbrain-Image-Delegation"
const imageDelegationDomain = "kbrain.image.delegation.v1."

// ImageDelegationSigner is configured by the process owner. Keys and backend
// credentials must not be exposed through browser settings APIs.
type ImageDelegationSigner struct {
	KeyID      string
	PrivateKey ed25519.PrivateKey
}

type imageDelegationClaims struct {
	Subject      string `json:"sub"`
	BackendID    string `json:"backendId"`
	IssuedAt     int64  `json:"iat"`
	ExpiresAt    int64  `json:"exp"`
	Audience     string `json:"aud"`
	Nonce        string `json:"nonce"`
	CanConfigure bool   `json:"canConfigure"`
}

func (s ImageDelegationSigner) Sign(owner, backend string, configure bool) (string, error) {
	if len(s.PrivateKey) != ed25519.PrivateKeySize || s.KeyID == "" || strings.ContainsAny(s.KeyID, ".\r\n") || owner == "" || backend == "" {
		return "", errors.New("image delegation is not configured")
	}
	nonce := make([]byte, 24)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	now := time.Now().Unix()
	raw, err := json.Marshal(imageDelegationClaims{owner, backend, now, now + 60, "image", base64.RawURLEncoding.EncodeToString(nonce), configure})
	if err != nil {
		return "", err
	}
	unsigned := s.KeyID + "." + base64.RawURLEncoding.EncodeToString(raw)
	signature := ed25519.Sign(s.PrivateKey, []byte(imageDelegationDomain+unsigned))
	return "v1." + unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

// ImageRequest forwards only protocol headers. In particular browser-provided
// Authorization, cookies, owner/scope, forwarding and delegation headers never
// cross this boundary. The caller owns and streams the returned body.
func (c *Client) ImageRequest(ctx context.Context, incoming *http.Request, imagePath, delegation string) (*http.Response, error) {
	if delegation == "" {
		return nil, errors.New("image delegation is required")
	}
	return c.imageRequest(ctx, incoming, imagePath, delegation)
}

func (c *Client) LocalImageRequest(ctx context.Context, incoming *http.Request, imagePath string) (*http.Response, error) {
	return c.imageRequest(ctx, incoming, imagePath, "")
}

func (c *Client) imageRequest(ctx context.Context, incoming *http.Request, imagePath, delegation string) (*http.Response, error) {
	if c == nil {
		return nil, errors.New("image delegation is required")
	}
	base, err := url.Parse(c.BaseURL)
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("invalid image backend URL")
	}
	if delegation == "" {
		ip := net.ParseIP(base.Hostname())
		if ip == nil || !ip.IsLoopback() || c.Token == "" {
			return nil, errors.New("single-user image backend must be authenticated loopback")
		}
	}
	if (imagePath != "/v1/health" && !strings.HasPrefix(imagePath, "/v1/image/")) || strings.ContainsAny(imagePath, "\\?#") || (imagePath == "/v1/health" && incoming.Method != http.MethodGet) {
		return nil, errors.New("invalid image path")
	}
	base.Path = strings.TrimRight(base.Path, "/") + imagePath
	base.RawPath = ""
	query := url.Values{}
	for _, key := range []string{"variant", "projectId", "cursor", "limit", "afterSeq"} {
		if values, ok := incoming.URL.Query()[key]; ok {
			query[key] = values
		}
	}
	base.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, incoming.Method, base.String(), incoming.Body)
	if err != nil {
		return nil, err
	}
	req.ContentLength = incoming.ContentLength
	// Prevent net/http from replaying a write after a transport failure.
	req.GetBody = nil
	for _, key := range []string{"Content-Type", "Accept", "Last-Event-ID", "Idempotency-Key", "X-Idempotency-Key", "Range", "If-None-Match", "If-Modified-Since"} {
		for _, value := range incoming.Header.Values(key) {
			req.Header.Add(key, value)
		}
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if delegation != "" {
		req.Header.Set(ImageDelegationHeader, delegation)
	}
	client := http.Client{}
	if c.HTTP != nil {
		client = *c.HTTP
	}
	// Per-operation context deadlines also cover streaming. Redirects must never
	// leak a backend token or a signed scope to another destination.
	client.Timeout = 0
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// StreamImageResponse keeps binary and SSE payloads out of JSON/WS buffers.
// Flush each upstream chunk, and propagate read/write failures to the caller.
func StreamImageResponse(w http.ResponseWriter, resp *http.Response) error {
	for _, key := range []string{"Content-Type", "Content-Length", "Content-Disposition", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Retry-After", "Allow", "X-Image-Version", "X-Request-ID"} {
		for _, value := range resp.Header.Values(key) {
			w.Header().Add(key, value)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(resp.StatusCode)
	controller := http.NewResponseController(w)
	_ = controller.Flush()
	buf := make([]byte, 32*1024)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
			if flushErr := controller.Flush(); flushErr != nil && !errors.Is(flushErr, http.ErrNotSupported) {
				return flushErr
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
