package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestImageGatewayHealthUsesBackendCapabilityEndpoint(t *testing.T) {
	calls := 0
	gateway, _ := imageTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != http.MethodGet || r.URL.Path != "/v1/health" || r.URL.Query().Has("backendId") {
			t.Errorf("unexpected health route: %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer backend-secret" {
			t.Error("backend authentication missing")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"capabilities":{"image":{"supported":true,"version":"kbrain.image.v1"}}}`))
	}, false)
	w := httptest.NewRecorder()
	gateway.ServeHTTP(w, httptest.NewRequest("GET", "/api/image/health?backendId=selected", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"supported":true`) || calls != 1 {
		t.Fatalf("health response status=%d calls=%d", w.Code, calls)
	}
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		w = httptest.NewRecorder()
		gateway.ServeHTTP(w, httptest.NewRequest(method, "/api/image/health?backendId=selected", nil))
		if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET" {
			t.Fatalf("method %s status=%d", method, w.Code)
		}
	}
	if calls != 1 {
		t.Fatal("health mutation reached backend")
	}
	w = httptest.NewRecorder()
	gateway.ServeHTTP(w, httptest.NewRequest("GET", "/api/image/health?backendId=other", nil))
	if w.Code != http.StatusForbidden || calls != 1 {
		t.Fatal("health bypassed backend grants")
	}
}
