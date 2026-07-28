package handler

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func providerIdentityRequest(providerID string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, "/api/provider-identities/"+providerID+"/latest", nil)
	request.SetPathValue("provider", providerID)
	return request
}

func TestProviderIdentityVersionReturnsStableDistTag(t *testing.T) {
	client := outboundHTTPClientFunc(func(request *http.Request) (*http.Response, error) {
		if got, want := request.URL.String(), providerIdentitySources["codex"].url; got != want {
			t.Fatalf("request URL = %q, want %q", got, want)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"latest":"0.145.0","alpha":"0.146.0-alpha.1"}`)),
			Header:     make(http.Header),
			Request:    request,
		}, nil
	})
	recorder := httptest.NewRecorder()
	providerIdentityVersionWithClient(client)(recorder, providerIdentityRequest("codex"))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%q", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if got, want := strings.TrimSpace(recorder.Body.String()), `{"version":"0.145.0"}`; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

func TestProviderIdentityVersionRejectsUnknownProvider(t *testing.T) {
	called := false
	client := outboundHTTPClientFunc(func(request *http.Request) (*http.Response, error) {
		called = true
		return nil, nil
	})
	recorder := httptest.NewRecorder()
	providerIdentityVersionWithClient(client)(recorder, providerIdentityRequest("gemini"))

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
	if called {
		t.Fatal("unknown provider must not trigger an outbound request")
	}
}

func TestProviderIdentityVersionRejectsPrerelease(t *testing.T) {
	client := outboundHTTPClientFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"latest":"0.146.0-alpha.1"}`)),
			Header:     make(http.Header),
			Request:    request,
		}, nil
	})
	recorder := httptest.NewRecorder()
	providerIdentityVersionWithClient(client)(recorder, providerIdentityRequest("codex"))

	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d, body=%q", recorder.Code, http.StatusBadGateway, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "stable semantic version") {
		t.Fatalf("body = %q, want stable-version error", recorder.Body.String())
	}
}
