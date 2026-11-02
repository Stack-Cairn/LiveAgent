package handler

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/auth"
	"github.com/liveagent/agent-gateway/internal/kbrain"
)

func imageTestGateway(t *testing.T, upstream http.HandlerFunc, configure bool) (*ImageGateway, ed25519.PublicKey) {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	client, err := kbrain.New(server.URL, "backend-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return &ImageGateway{ResolvePrincipal: func(r *http.Request) (auth.ImagePrincipal, error) {
		return auth.ImagePrincipal{OwnerID: "alice", Backends: map[string]auth.ImageGrant{"selected": {Execute: true, Configure: configure}}}, nil
	}, Backends: map[string]ImageBackend{"selected": {Client: client, Signer: kbrain.ImageDelegationSigner{KeyID: "test", PrivateKey: priv}}}}, pub
}

func TestImageGatewayIdentityPermissionsAndLimits(t *testing.T) {
	gateway, _ := imageTestGateway(t, func(w http.ResponseWriter, r *http.Request) { t.Error("denied request reached backend") }, false)
	tests := []struct {
		name, path, method string
		gateway            *ImageGateway
		size               int64
		status             int
	}{
		{"missing identity", "/api/image/jobs?backendId=selected", "GET", nil, 0, 503},
		{"explicit backend", "/api/image/jobs", "GET", gateway, 0, 422},
		{"duplicate backend", "/api/image/jobs?backendId=selected&backendId=other", "GET", gateway, 0, 422},
		{"wrong backend", "/api/image/jobs?backendId=other", "GET", gateway, 0, 403},
		{"settings read denied", "/api/image/settings?backendId=selected", "GET", gateway, 0, 403},
		{"settings write denied", "/api/image/settings?backendId=selected", "PUT", gateway, 0, 403},
		{"secret write denied", "/api/image/secrets?backendId=selected", "POST", gateway, 0, 403},
		{"secret directory denied", "/api/image/secrets/refs?backendId=selected", "GET", gateway, 0, 404},
		{"path traversal", "/api/image/assets/../settings?backendId=selected", "GET", gateway, 0, 404},
		{"upload limit", "/api/image/assets?backendId=selected", "POST", gateway, 22 << 20, 413},
		{"json limit", "/api/image/jobs?backendId=selected", "POST", gateway, 5 << 20, 413},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(tt.method, tt.path, nil)
			r.ContentLength = tt.size
			r.Header.Set("X-Owner-ID", "admin")
			w := httptest.NewRecorder()
			tt.gateway.ServeHTTP(w, r)
			if w.Code != tt.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			if !strings.Contains(w.Body.String(), "kbrain.image.v1") {
				t.Fatal("missing wire error")
			}
		})
	}
}

func TestImageGatewayDelegationAndHeaderIsolation(t *testing.T) {
	var observed *http.Request
	var body string
	gateway, pub := imageTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		observed = r.Clone(r.Context())
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Set-Cookie", "private=secret")
		_, _ = w.Write([]byte{0, 1, 2, 255})
	}, true)
	original := gateway.ResolvePrincipal
	gateway.ResolvePrincipal = func(r *http.Request) (auth.ImagePrincipal, error) {
		if r.Header.Get("X-Owner-ID") != "" || r.Header.Get("X-Scope") != "" || r.Header.Get(kbrain.ImageDelegationHeader) != "" {
			t.Error("scope headers reached identity resolver")
		}
		return original(r)
	}
	r := httptest.NewRequest("POST", "/api/image/assets?backendId=selected", strings.NewReader("multipart bytes"))
	for k, v := range map[string]string{"Content-Type": "multipart/form-data; boundary=actual", "Authorization": "Bearer browser", "X-Owner-ID": "mallory", "X-Scope": "local", "X-Backend-ID": "other", kbrain.ImageDelegationHeader: "forged", "Cookie": "private=browser", "Idempotency-Key": "stable-key", "Last-Event-ID": "9"} {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	gateway.ServeHTTP(w, r)
	if w.Code != 200 || w.Body.String() != string([]byte{0, 1, 2, 255}) {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if observed == nil {
		t.Fatal("no upstream request")
	}
	if observed.URL.Path != "/v1/image/assets" || observed.URL.Query().Has("backendId") || body != "multipart bytes" {
		t.Fatal("request routing changed")
	}
	if observed.Header.Get("Authorization") != "Bearer backend-secret" || observed.Header.Get("Content-Type") != "multipart/form-data; boundary=actual" || observed.Header.Get("Idempotency-Key") != "stable-key" || observed.Header.Get("Last-Event-ID") != "9" {
		t.Fatal("protocol headers changed")
	}
	for _, key := range []string{"X-Owner-ID", "X-Scope", "X-Backend-ID", "Cookie"} {
		if observed.Header.Get(key) != "" {
			t.Errorf("leaked header %s", key)
		}
	}
	if w.Header().Get("Set-Cookie") != "" {
		t.Fatal("upstream cookie leaked")
	}
	parts := strings.Split(observed.Header.Get(kbrain.ImageDelegationHeader), ".")
	if len(parts) != 4 {
		t.Fatal("missing delegation")
	}
	sig, _ := base64.RawURLEncoding.DecodeString(parts[3])
	if !ed25519.Verify(pub, []byte("kbrain.image.delegation.v1."+parts[1]+"."+parts[2]), sig) {
		t.Fatal("signature invalid")
	}
	raw, _ := base64.RawURLEncoding.DecodeString(parts[2])
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	if claims["sub"] != "alice" || claims["backendId"] != "selected" || claims["aud"] != "image" || claims["canConfigure"] != true || claims["exp"].(float64)-claims["iat"].(float64) > 60 || claims["nonce"] == "" {
		t.Fatalf("claims=%v", claims)
	}
}

func TestImageGatewayStreamsAndCancels(t *testing.T) {
	for _, contentType := range []string{"text/event-stream", "image/png"} {
		t.Run(contentType, func(t *testing.T) {
			cancelled := make(chan struct{})
			gateway, _ := imageTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", contentType)
				_, _ = io.WriteString(w, "first chunk\n")
				w.(http.Flusher).Flush()
				<-r.Context().Done()
				close(cancelled)
			}, false)
			downstream := httptest.NewServer(gateway)
			defer downstream.Close()
			path := "/api/image/jobs/ij_1/events?backendId=selected"
			if contentType == "image/png" {
				path = "/api/image/assets/ia_1/content?backendId=selected"
			}
			client := &http.Client{Timeout: 3 * time.Second}
			resp, err := client.Get(downstream.URL + path)
			if err != nil {
				t.Fatal(err)
			}
			line, err := bufio.NewReader(resp.Body).ReadString('\n')
			if err != nil || line != "first chunk\n" {
				t.Fatalf("first chunk=%q err=%v", line, err)
			}
			_ = resp.Body.Close()
			select {
			case <-cancelled:
			case <-time.After(3 * time.Second):
				t.Fatal("disconnect did not cancel upstream")
			}
		})
	}
}

func TestImageGatewayRedirectDenied(t *testing.T) {
	gateway, _ := imageTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "http://example.invalid/private")
		w.WriteHeader(307)
	}, false)
	w := httptest.NewRecorder()
	gateway.ServeHTTP(w, httptest.NewRequest("GET", "/api/image/jobs?backendId=selected", nil))
	if w.Code != 502 || w.Header().Get("Location") != "" {
		t.Fatalf("redirect escaped: %d", w.Code)
	}
}

func TestImageGatewayVerificationRoutesAndPermission(t *testing.T) {
	for _, tc := range []struct {
		name, method, suffix string
		configure            bool
		want                 int
	}{
		{"start permitted", "POST", "targets/it_test/verify", true, 202},
		{"receipt permitted", "GET", "targets/it_test/verifications/iv_test", true, 202},
		{"receipt recovery", "GET", "targets/it_test/verifications/by-key", true, 202},
		{"start denied", "POST", "targets/it_test/verify", false, 403},
		{"receipt denied", "GET", "targets/it_test/verifications/iv_test", false, 403},
		{"invalid target suffix", "GET", "targets/it_test/arbitrary", true, 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			g, _ := imageTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/v1/image/"+tc.suffix {
					t.Errorf("wrong path: %s", r.URL.Path)
				}
				if (tc.method == "POST" || strings.HasSuffix(tc.suffix, "/by-key")) && r.Header.Get("X-Idempotency-Key") != "verification-key" {
					t.Error("verification idempotency key was dropped")
				}
				w.WriteHeader(http.StatusAccepted)
			}, tc.configure)
			r := httptest.NewRequest(tc.method, "/api/image/"+tc.suffix+"?backendId=selected", nil)
			r.Header.Set("X-Idempotency-Key", "verification-key")
			w := httptest.NewRecorder()
			g.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status=%d want=%d", w.Code, tc.want)
			}
			if tc.want != 202 && calls != 0 {
				t.Fatal("denied request reached upstream")
			}
			if tc.want == 202 && calls != 1 {
				t.Fatalf("forward count=%d", calls)
			}
		})
	}
}
