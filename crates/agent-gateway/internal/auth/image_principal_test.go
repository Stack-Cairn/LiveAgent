package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestImageAuthenticationWireAndLegacyErrors(t *testing.T) {
	handler := HTTPMiddleware("shared", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for _, path := range []string{"/api/image", "/api/image/assets/ia_1/content", "/api/status"} {
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("X-Owner-ID", "local")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != 401 {
			t.Fatal("unauthenticated request accepted")
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if path == "/api/status" {
			if body["error"] != "unauthorized" {
				t.Fatal("legacy error changed")
			}
		} else {
			imageErr, ok := body["error"].(map[string]any)
			if !ok || body["version"] != "kbrain.image.v1" || imageErr["code"] != "IMAGE_AUTH_REQUIRED" || imageErr["requestId"] == "" {
				t.Fatal("invalid image authentication error")
			}
		}
		req.Header.Set("Authorization", "Bearer shared")
		rec = httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != 204 {
			t.Fatal("valid bearer rejected")
		}
	}
}
