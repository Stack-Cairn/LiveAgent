package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/auth"
	"github.com/liveagent/agent-gateway/internal/kbrain"
)

// ImageBackend is server-owned configuration, selected by an explicit backendId
// query parameter and checked against the verified principal's grants.
type ImageBackend struct {
	Client *kbrain.Client
	Signer kbrain.ImageDelegationSigner
	// Explicit single-owner deployment, only an authenticated loopback backend.
	SingleUserLocal bool
}

type ImageGateway struct {
	ResolvePrincipal auth.ImagePrincipalResolver
	Backends         map[string]ImageBackend
}

func imageGatewayError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"version": "kbrain.image.v1", "error": map[string]any{
		"code": code, "message": message, "retryable": status == 502 || status == 504, "requestId": uuid.NewString(),
	}})
}

func (g *ImageGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if g == nil || g.ResolvePrincipal == nil {
		imageGatewayError(w, 503, "IMAGE_IDENTITY_UNAVAILABLE", "Trusted image identity is not configured")
		return
	}
	// Even the trusted resolver cannot accidentally use browser scope headers.
	r = r.Clone(r.Context())
	for key := range r.Header {
		lower := strings.ToLower(key)
		if strings.Contains(lower, "owner") || strings.Contains(lower, "scope") || lower == strings.ToLower(kbrain.ImageDelegationHeader) || lower == "x-backend-id" {
			r.Header.Del(key)
		}
	}
	principal, err := g.ResolvePrincipal(r)
	if err != nil || strings.TrimSpace(principal.OwnerID) == "" {
		imageGatewayError(w, 401, "IMAGE_AUTH_REQUIRED", "Verified image identity is required")
		return
	}
	backendIDs := r.URL.Query()["backendId"]
	if len(backendIDs) != 1 || backendIDs[0] == "" {
		imageGatewayError(w, 422, "IMAGE_INVALID_INPUT", "Select an image backend")
		return
	}
	backendID := backendIDs[0]
	grant, allowed := principal.Backends[backendID]
	backend, exists := g.Backends[backendID]
	if !allowed || !grant.Execute || !exists {
		imageGatewayError(w, 403, "IMAGE_FORBIDDEN", "Image backend access is denied")
		return
	}
	suffix := strings.TrimPrefix(r.URL.Path, "/api/image/")
	if suffix == r.URL.Path || !validImagePath(suffix) {
		imageGatewayError(w, 404, "IMAGE_NOT_FOUND", "Image route not found")
		return
	}
	resource := strings.Split(suffix, "/")[0]
	if (resource == "settings" || resource == "secrets" || resource == "targets" && strings.Contains(suffix, "/")) && !grant.Configure {
		imageGatewayError(w, 403, "IMAGE_FORBIDDEN", "Image configuration access is denied")
		return
	}
	delegation := ""
	if !backend.SingleUserLocal {
		delegation, err = backend.Signer.Sign(principal.OwnerID, backendID, grant.Configure)
	} else if principal.OwnerID != "local" || !grant.Configure {
		err = errors.New("single-user scope mismatch")
	}
	if err != nil || backend.Client == nil {
		imageGatewayError(w, 503, "IMAGE_DELEGATION_UNAVAILABLE", "Image backend delegation is not configured")
		return
	}
	limit := int64(4 << 20)
	if resource == "assets" && r.Method == http.MethodPost {
		limit = 21 << 20
	} // 20 MiB file + bounded multipart framing; KB enforces file limit.
	if r.ContentLength > limit {
		imageGatewayError(w, 413, "IMAGE_TOO_LARGE", "Image request is too large")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	timeout := 30 * time.Second
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		timeout = 180 * time.Second
	}
	if strings.HasSuffix(suffix, "/content") {
		timeout = 180 * time.Second
	}
	if strings.HasSuffix(suffix, "/events") {
		timeout = 30 * time.Minute
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	upstreamPath := "/v1/image/" + suffix
	if suffix == "health" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			imageGatewayError(w, http.StatusMethodNotAllowed, "IMAGE_INVALID_INPUT", "Image health requires GET")
			return
		}
		upstreamPath = "/v1/health"
	}
	var resp *http.Response
	if backend.SingleUserLocal {
		resp, err = backend.Client.LocalImageRequest(ctx, r, upstreamPath)
	} else {
		resp, err = backend.Client.ImageRequest(ctx, r, upstreamPath, delegation)
	}
	if err != nil {
		var tooLarge *http.MaxBytesError
		switch {
		case errors.As(err, &tooLarge):
			imageGatewayError(w, 413, "IMAGE_TOO_LARGE", "Image request is too large")
		case errors.Is(err, context.DeadlineExceeded):
			imageGatewayError(w, 504, "IMAGE_TIMEOUT", "Image backend timed out")
		default:
			imageGatewayError(w, 502, "IMAGE_BACKEND_UNAVAILABLE", "Image backend request failed")
		}
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		imageGatewayError(w, 502, "IMAGE_BACKEND_UNAVAILABLE", "Image backend redirect is not permitted")
		return
	}
	if err := kbrain.StreamImageResponse(w, resp); err != nil {
		// A partial binary/SSE response must be observed as a broken stream, never a
		// successful truncated response. net/http suppresses logs for this sentinel.
		panic(http.ErrAbortHandler)
	}
}

func validImagePath(path string) bool {
	parts := strings.Split(path, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\%?#\r\n") {
			return false
		}
	}
	switch parts[0] {
	case "health", "settings", "secrets":
		return len(parts) == 1
	case "targets":
		return len(parts) == 1 || len(parts) == 3 && parts[2] == "verify" || len(parts) == 4 && parts[2] == "verifications"
	case "projects":
		return len(parts) <= 2
	case "assets":
		return len(parts) == 1 || len(parts) == 3 && parts[2] == "content"
	case "jobs":
		return len(parts) <= 2 || len(parts) == 3 && (parts[2] == "cancel" || parts[2] == "events")
	}
	return false
}
