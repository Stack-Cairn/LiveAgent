package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestImageRoutesRequireBearerAndTrustedIdentity(t *testing.T) {
	server := NewHTTPServer(&config.Config{Token: "shared-token"}, session.NewManager(), nil)
	for _, path := range []string{"/api/image", "/api/image/", "/api/image/jobs?backendId=kbrain", "/api/image/assets/ia_1/content?backendId=kbrain"} {
		for _, authenticated := range []bool{false, true} {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Header.Set("X-Owner-ID", "local")
			if authenticated {
				req.Header.Set("Authorization", "Bearer shared-token")
			}
			rec := httptest.NewRecorder()
			server.ServeHTTP(rec, req)
			want := 401
			if authenticated {
				want = 503
			}
			if rec.Code != want {
				t.Fatalf("path=%s authenticated=%v status=%d body=%s", path, authenticated, rec.Code, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "<html") {
				t.Fatal("image API used static fallback")
			}
			if authenticated && !strings.Contains(rec.Body.String(), "IMAGE_IDENTITY_UNAVAILABLE") {
				t.Fatal("shared bearer silently enabled image scope")
			}
		}
	}
}
