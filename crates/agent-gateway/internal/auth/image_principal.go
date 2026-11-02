package auth

import (
	"crypto/rand"
	"encoding/json"
	"net/http"
)

func writeImageAuthRequired(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]any{"version": "kbrain.image.v1", "error": map[string]any{
		"code": "IMAGE_AUTH_REQUIRED", "message": "Image authentication is required", "retryable": false, "requestId": rand.Text(),
	}})
}

// ImagePrincipal must come from verified deployment identity, never request
// scope headers or the shared Gateway management token. The current bearer
// middleware does not establish this identity.
type ImagePrincipal struct {
	OwnerID  string
	Backends map[string]ImageGrant
}

type ImageGrant struct {
	Execute   bool
	Configure bool
}

// ImagePrincipalResolver authenticates the user and loads server-side backend
// grants. A nil resolver deliberately disables Image Studio on shared targets.
type ImagePrincipalResolver func(*http.Request) (ImagePrincipal, error)
