package handler

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBuildProviderModelsURLForGemini(t *testing.T) {
	t.Parallel()

	officialCases := map[string]string{
		"https://generativelanguage.googleapis.com":                                                    "https://generativelanguage.googleapis.com/v1beta/models",
		"https://generativelanguage.googleapis.com/v1beta":                                             "https://generativelanguage.googleapis.com/v1beta/models",
		"https://generativelanguage.googleapis.com/v1beta/models":                                      "https://generativelanguage.googleapis.com/v1beta/models",
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent":       "https://generativelanguage.googleapis.com/v1beta/models",
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent": "https://generativelanguage.googleapis.com/v1beta/models",
	}

	for input, want := range officialCases {
		got, err := buildProviderModelsURL("gemini", input, true)
		if err != nil {
			t.Fatalf("buildProviderModelsURL(%q, official) error = %v", input, err)
		}
		if got != want {
			t.Fatalf("buildProviderModelsURL(%q, official) = %q, want %q", input, got, want)
		}
	}

	defaultCases := map[string]string{
		"https://generativelanguage.googleapis.com":        "https://generativelanguage.googleapis.com/v1/models",
		"https://generativelanguage.googleapis.com/v1beta": "https://generativelanguage.googleapis.com/v1beta/models",
		"https://relay.example.com":                        "https://relay.example.com/v1/models",
	}

	for input, want := range defaultCases {
		got, err := buildProviderModelsURL("gemini", input, false)
		if err != nil {
			t.Fatalf("buildProviderModelsURL(%q, default) error = %v", input, err)
		}
		if got != want {
			t.Fatalf("buildProviderModelsURL(%q, default) = %q, want %q", input, got, want)
		}
	}
}

func TestBuildProviderModelsAttempts(t *testing.T) {
	t.Parallel()

	geminiAttempts, err := buildProviderModelsAttempts("gemini", "https://relay.example.com", "test-key")
	if err != nil {
		t.Fatalf("buildProviderModelsAttempts(gemini) error = %v", err)
	}
	if len(geminiAttempts) != 2 {
		t.Fatalf("gemini attempts = %d, want 2", len(geminiAttempts))
	}
	if geminiAttempts[0].url != "https://relay.example.com/v1/models" {
		t.Fatalf("gemini default attempt URL = %q", geminiAttempts[0].url)
	}
	if geminiAttempts[1].url != "https://relay.example.com/v1beta/models" {
		t.Fatalf("gemini official attempt URL = %q", geminiAttempts[1].url)
	}
	if geminiAttempts[0].headers["Authorization"] == "" {
		t.Fatal("gemini default attempt should include Authorization header")
	}
	if geminiAttempts[1].headers["Authorization"] != "" {
		t.Fatal("gemini official attempt should not include Authorization header")
	}
	if geminiAttempts[1].headers["x-goog-api-key"] != "test-key" {
		t.Fatal("gemini official attempt should authenticate with x-goog-api-key")
	}

	claudeAttempts, err := buildProviderModelsAttempts("claude_code", "https://relay.example.com", "test-key")
	if err != nil {
		t.Fatalf("buildProviderModelsAttempts(claude_code) error = %v", err)
	}
	if len(claudeAttempts) != 2 {
		t.Fatalf("claude_code attempts = %d, want 2", len(claudeAttempts))
	}
	if claudeAttempts[0].url != claudeAttempts[1].url {
		t.Fatal("claude_code attempts should share the /v1/models URL")
	}
	if claudeAttempts[1].headers["Authorization"] != "" {
		t.Fatal("claude_code official attempt should drop the Authorization header")
	}
	if claudeAttempts[1].headers["anthropic-version"] == "" {
		t.Fatal("claude_code official attempt should keep anthropic-version")
	}

	codexAttempts, err := buildProviderModelsAttempts("codex", "https://relay.example.com/v1", "test-key")
	if err != nil {
		t.Fatalf("buildProviderModelsAttempts(codex) error = %v", err)
	}
	if len(codexAttempts) != 2 {
		t.Fatalf("codex attempts = %d, want 2", len(codexAttempts))
	}
	if codexAttempts[0].url != "https://relay.example.com/v1/models" {
		t.Fatalf("codex default attempt URL = %q", codexAttempts[0].url)
	}
}

func TestBuildProviderModelsURLAllowsPrivateAndLoopback(t *testing.T) {
	t.Parallel()

	for _, baseURL := range []string{
		"http://10.66.0.1:8787",
		"http://10.66.0.1:8787/v1",
		"http://127.0.0.1:11434",
		"http://[::1]:11434",
		"http://[fd00::1]:11434",
	} {
		got, err := buildProviderModelsURL("codex", baseURL, false)
		if err != nil {
			t.Fatalf("buildProviderModelsURL(%q) error = %v", baseURL, err)
		}
		if !strings.HasSuffix(got, "/v1/models") {
			t.Fatalf("buildProviderModelsURL(%q) = %q, want /v1/models suffix", baseURL, got)
		}
	}
}

func TestBuildProviderModelsURLDefersAddressPolicy(t *testing.T) {
	t.Parallel()

	if _, err := buildProviderModelsURL("codex", "http://169.254.169.254/latest", false); err != nil {
		t.Fatalf("buildProviderModelsURL() error = %v, want structural validation to pass", err)
	}
}

func TestFetchProviderModelsRejectsUnsafeURL(t *testing.T) {
	t.Parallel()

	_, err := FetchProviderModels(context.Background(), ProviderModelsRequestBody{
		Type:    "codex",
		BaseURL: "http://169.254.169.254:80",
		APIKey:  "test-key",
	})
	if err == nil {
		t.Fatal("FetchProviderModels() error = nil, want unsafe URL rejection")
	}
	var statusErr *HTTPStatusError
	if !errors.As(err, &statusErr) {
		t.Fatalf("FetchProviderModels() error = %T, want *HTTPStatusError", err)
	}
	if statusErr.Status != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", statusErr.Status, http.StatusBadRequest)
	}
}

func TestFetchProviderModelsRequiresConfirmationForPrivateURL(t *testing.T) {
	t.Parallel()

	_, err := FetchProviderModels(context.Background(), ProviderModelsRequestBody{
		Type:    "codex",
		BaseURL: "http://10.66.0.1:8787",
		APIKey:  "test-key",
	})
	if err == nil {
		t.Fatal("FetchProviderModels() error = nil, want confirmation requirement")
	}
	var statusErr *HTTPStatusError
	if !errors.As(err, &statusErr) {
		t.Fatalf("FetchProviderModels() error = %T, want *HTTPStatusError", err)
	}
	if statusErr.Code != "provider_models_confirmation_required" {
		t.Fatalf("code = %q, want confirmation code", statusErr.Code)
	}
}

func TestFetchProviderModelsAllowsConfirmedLoopback(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/v1/models" {
			t.Fatalf("path = %q, want /v1/models", req.URL.Path)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"data":[{"id":"local-model"}]}`))
	}))
	defer server.Close()

	result, err := FetchProviderModels(context.Background(), ProviderModelsRequestBody{
		Type:                "codex",
		BaseURL:             server.URL,
		APIKey:              "test-key",
		AllowPrivateNetwork: true,
	})
	if err != nil {
		t.Fatalf("FetchProviderModels() error = %v", err)
	}
	if !bytes.Contains(result.Body, []byte("local-model")) {
		t.Fatalf("result body = %s, want local model", result.Body)
	}
}

func TestFetchProviderModelsRejectsCrossOriginPrivateRedirect(t *testing.T) {
	t.Parallel()

	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, req *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"data":[{"id":"redirected-model"}]}`))
	}))
	defer target.Close()

	source := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, req *http.Request) {
		http.Redirect(writer, req, target.URL+"/v1/models", http.StatusTemporaryRedirect)
	}))
	defer source.Close()

	_, err := FetchProviderModels(context.Background(), ProviderModelsRequestBody{
		Type:                "codex",
		BaseURL:             source.URL,
		APIKey:              "test-key",
		AllowPrivateNetwork: true,
	})
	if err == nil {
		t.Fatal("FetchProviderModels() error = nil, want redirect rejection")
	}
	var statusErr *HTTPStatusError
	if !errors.As(err, &statusErr) || statusErr.Message != "provider models URL is not allowed" {
		t.Fatalf("error = %#v, want provider models URL rejection", err)
	}
}

type stubOutboundHTTPClient struct {
	requests []*http.Request
	respond  func(req *http.Request) (*http.Response, error)
}

func (c *stubOutboundHTTPClient) Do(req *http.Request) (*http.Response, error) {
	c.requests = append(c.requests, req)
	return c.respond(req)
}

func stubJSONResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(bytes.NewReader([]byte(body))),
	}
}

func TestFetchProviderModelsFallsBackToOfficialEndpoint(t *testing.T) {
	t.Parallel()

	client := &stubOutboundHTTPClient{
		respond: func(req *http.Request) (*http.Response, error) {
			if req.URL.Path == "/v1/models" {
				return stubJSONResponse(http.StatusNotFound, `{"error":"not found"}`), nil
			}
			return stubJSONResponse(http.StatusOK, `{"models":[{"name":"models/gemini-2.5-pro"}]}`), nil
		},
	}

	result, err := fetchProviderModelsWithClient(context.Background(), ProviderModelsRequestBody{
		Type:    "gemini",
		BaseURL: "https://relay.example.com",
		APIKey:  "test-key",
	}, client)
	if err != nil {
		t.Fatalf("fetchProviderModelsWithClient() error = %v", err)
	}
	if len(client.requests) != 2 {
		t.Fatalf("requests = %d, want 2", len(client.requests))
	}
	if client.requests[0].URL.Path != "/v1/models" {
		t.Fatalf("first request path = %q, want /v1/models", client.requests[0].URL.Path)
	}
	if client.requests[1].URL.Path != "/v1beta/models" {
		t.Fatalf("second request path = %q, want /v1beta/models", client.requests[1].URL.Path)
	}
	if !bytes.Contains(result.Body, []byte("gemini-2.5-pro")) {
		t.Fatalf("result body = %s, want fetched models", result.Body)
	}
}

func TestFetchProviderModelsFallsBackWhenDefaultListIsEmpty(t *testing.T) {
	t.Parallel()

	client := &stubOutboundHTTPClient{
		respond: func(req *http.Request) (*http.Response, error) {
			if req.URL.Path == "/v1/models" {
				return stubJSONResponse(http.StatusOK, `{"data":[]}`), nil
			}
			return stubJSONResponse(http.StatusOK, `{"models":[{"name":"models/gemini-2.5-flash"}]}`), nil
		},
	}

	result, err := fetchProviderModelsWithClient(context.Background(), ProviderModelsRequestBody{
		Type:    "gemini",
		BaseURL: "https://relay.example.com",
		APIKey:  "test-key",
	}, client)
	if err != nil {
		t.Fatalf("fetchProviderModelsWithClient() error = %v", err)
	}
	if !bytes.Contains(result.Body, []byte("gemini-2.5-flash")) {
		t.Fatalf("result body = %s, want official models", result.Body)
	}
}

func TestFetchProviderModelsStopsAtFirstSuccess(t *testing.T) {
	t.Parallel()

	client := &stubOutboundHTTPClient{
		respond: func(req *http.Request) (*http.Response, error) {
			return stubJSONResponse(http.StatusOK, `{"data":[{"id":"gpt-5"}]}`), nil
		},
	}

	result, err := fetchProviderModelsWithClient(context.Background(), ProviderModelsRequestBody{
		Type:    "codex",
		BaseURL: "https://relay.example.com",
		APIKey:  "test-key",
	}, client)
	if err != nil {
		t.Fatalf("fetchProviderModelsWithClient() error = %v", err)
	}
	if len(client.requests) != 1 {
		t.Fatalf("requests = %d, want 1", len(client.requests))
	}
	if !bytes.Contains(result.Body, []byte("gpt-5")) {
		t.Fatalf("result body = %s, want default models", result.Body)
	}
}

func TestFetchProviderModelsPrefersInformativeFailure(t *testing.T) {
	t.Parallel()

	client := &stubOutboundHTTPClient{
		respond: func(req *http.Request) (*http.Response, error) {
			if req.URL.Path == "/v1/models" {
				return stubJSONResponse(http.StatusUnauthorized, `{"error":"invalid api key"}`), nil
			}
			return stubJSONResponse(http.StatusNotFound, `{"error":"not found"}`), nil
		},
	}

	_, err := fetchProviderModelsWithClient(context.Background(), ProviderModelsRequestBody{
		Type:    "gemini",
		BaseURL: "https://relay.example.com",
		APIKey:  "test-key",
	}, client)
	if err == nil {
		t.Fatal("fetchProviderModelsWithClient() error = nil, want failure")
	}
	var statusErr *HTTPStatusError
	if !errors.As(err, &statusErr) {
		t.Fatalf("error = %T, want *HTTPStatusError", err)
	}
	if statusErr.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", statusErr.Status, http.StatusUnauthorized)
	}
	if statusErr.Message != "invalid api key" {
		t.Fatalf("message = %q, want %q", statusErr.Message, "invalid api key")
	}
}
