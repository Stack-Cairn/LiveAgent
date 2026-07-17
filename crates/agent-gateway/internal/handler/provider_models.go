package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strings"
)

const maxProviderModelsResponseBytes = 2 << 20

const anthropicAPIVersion = "2023-06-01"

type HTTPStatusError struct {
	Status  int
	Message string
	Code    string
}

func (e *HTTPStatusError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

type ProviderModelsResult struct {
	ContentType string
	Body        []byte
}

var codexModelsSuffixes = []string{
	"/chat/completions",
	"/responses",
	"/response",
}

var providerModelsAllowedIPPrefixes = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("fc00::/7"),
}

type providerModelsAttempt struct {
	url     string
	headers map[string]string
}

type providerModelsAttemptFailure struct {
	upstreamStatus int
	err            error
}

func FetchProviderModels(
	ctx context.Context,
	req ProviderModelsRequestBody,
) (*ProviderModelsResult, error) {
	attempts, err := prepareProviderModelsAttempts(req)
	if err != nil {
		return nil, err
	}
	client, err := newProviderModelsHTTPClient(ctx, attempts[0].url, req.AllowPrivateNetwork)
	if err != nil {
		return nil, err
	}
	return fetchProviderModelsAttemptsWithClient(ctx, attempts, client)
}

func fetchProviderModelsWithClient(
	ctx context.Context,
	req ProviderModelsRequestBody,
	client outboundHTTPClient,
) (*ProviderModelsResult, error) {
	attempts, err := prepareProviderModelsAttempts(req)
	if err != nil {
		return nil, err
	}
	return fetchProviderModelsAttemptsWithClient(ctx, attempts, client)
}

func prepareProviderModelsAttempts(req ProviderModelsRequestBody) ([]providerModelsAttempt, error) {
	providerType := strings.TrimSpace(req.Type)
	baseURL := strings.TrimSpace(req.BaseURL)
	apiKey := strings.TrimSpace(req.APIKey)
	if baseURL == "" || apiKey == "" {
		return nil, &HTTPStatusError{
			Status:  http.StatusBadRequest,
			Message: "base_url and api_key are required",
		}
	}

	attempts, err := buildProviderModelsAttempts(providerType, baseURL, apiKey)
	if err != nil {
		return nil, &HTTPStatusError{
			Status:  http.StatusBadRequest,
			Message: err.Error(),
		}
	}
	return attempts, nil
}

func fetchProviderModelsAttemptsWithClient(
	ctx context.Context,
	attempts []providerModelsAttempt,
	client outboundHTTPClient,
) (*ProviderModelsResult, error) {
	var failures []providerModelsAttemptFailure
	var emptyResult *ProviderModelsResult

	for _, attempt := range attempts {
		result, failure, err := runProviderModelsAttempt(ctx, client, attempt)
		if err != nil {
			return nil, err
		}
		if failure != nil {
			failures = append(failures, *failure)
			continue
		}
		if providerModelsBodyHasEntries(result.Body) {
			return result, nil
		}
		emptyResult = result
	}

	if emptyResult != nil {
		return emptyResult, nil
	}

	return nil, pickProviderModelsFailure(failures)
}

func newProviderModelsHTTPClient(
	ctx context.Context,
	targetURL string,
	allowPrivateNetwork bool,
) (outboundHTTPClient, error) {
	parsed, err := url.Parse(targetURL)
	if err != nil {
		return nil, &HTTPStatusError{
			Status:  http.StatusBadRequest,
			Message: "base_url is not allowed",
			Code:    "provider_models_url_not_allowed",
		}
	}
	if err := validateParsedOutboundHTTPURLShape(parsed); err != nil {
		return nil, &HTTPStatusError{
			Status:  http.StatusBadRequest,
			Message: "base_url is not allowed",
			Code:    "provider_models_url_not_allowed",
		}
	}

	addresses := make([]netip.Addr, 0, 4)
	if literal, err := netip.ParseAddr(parsed.Hostname()); err == nil {
		addresses = append(addresses, literal.Unmap())
	} else {
		resolved, resolveErr := net.DefaultResolver.LookupNetIP(ctx, "ip", parsed.Hostname())
		if resolveErr != nil {
			return nil, &HTTPStatusError{
				Status:  http.StatusBadGateway,
				Message: "failed to resolve provider models URL",
			}
		}
		addresses = append(addresses, resolved...)
	}

	allowedIPs := make([]netip.Addr, 0, len(addresses))
	hasPrivateAddress := false
	for _, address := range addresses {
		address = address.Unmap()
		if isProviderModelsAllowedIP(address) {
			hasPrivateAddress = true
			if allowPrivateNetwork {
				allowedIPs = append(allowedIPs, address)
			}
			continue
		}
		if !isBlockedOutboundIP(address) {
			allowedIPs = append(allowedIPs, address)
		}
	}

	if hasPrivateAddress && !allowPrivateNetwork {
		return nil, &HTTPStatusError{
			Status:  http.StatusBadRequest,
			Message: "provider models URL requires confirmation",
			Code:    "provider_models_confirmation_required",
		}
	}
	if len(allowedIPs) == 0 {
		return nil, &HTTPStatusError{
			Status:  http.StatusBadRequest,
			Message: "base_url is not allowed",
			Code:    "provider_models_url_not_allowed",
		}
	}

	if !hasPrivateAddress {
		return newSafeOutboundHTTPClient(0), nil
	}
	origin := providerModelsOrigin(parsed)
	return newSafeOutboundHTTPClientWithOptions(
		0,
		allowedIPs,
		func(req *http.Request, via []*http.Request) error {
			return validateProviderModelsRedirect(origin, req, via)
		},
	), nil
}

func isProviderModelsAllowedIP(ip netip.Addr) bool {
	if !ip.IsValid() {
		return false
	}
	ip = ip.Unmap()
	for _, prefix := range providerModelsAllowedIPPrefixes {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}

func providerModelsOrigin(parsed *url.URL) string {
	return strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host)
}

func validateProviderModelsRedirect(origin string, req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return &unsafeOutboundURLError{message: "too many redirects"}
	}
	if req == nil || req.URL == nil {
		return &unsafeOutboundURLError{message: "redirect URL is required"}
	}
	if err := validateParsedOutboundHTTPURLShape(req.URL); err != nil {
		return err
	}
	if providerModelsOrigin(req.URL) != origin {
		return &unsafeOutboundURLError{message: "provider models redirect origin is not allowed"}
	}
	return nil
}

// runProviderModelsAttempt performs a single upstream request. A non-nil
// error aborts the whole fetch (policy block); a non-nil failure lets the
// caller fall back to the next attempt.
func runProviderModelsAttempt(
	ctx context.Context,
	client outboundHTTPClient,
	attempt providerModelsAttempt,
) (*ProviderModelsResult, *providerModelsAttemptFailure, error) {
	upstreamReq, err := http.NewRequestWithContext(ctx, http.MethodGet, attempt.url, nil)
	if err != nil {
		return nil, nil, &HTTPStatusError{
			Status:  http.StatusBadRequest,
			Message: "invalid provider models URL",
		}
	}
	for key, value := range attempt.headers {
		upstreamReq.Header.Set(key, value)
	}

	resp, err := client.Do(upstreamReq)
	if err != nil {
		if isSafeOutboundBlockedError(err) {
			return nil, nil, &HTTPStatusError{
				Status:  http.StatusBadRequest,
				Message: "provider models URL is not allowed",
			}
		}
		return nil, &providerModelsAttemptFailure{err: err}, nil
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxProviderModelsResponseBytes))
	if err != nil {
		return nil, &providerModelsAttemptFailure{
			err: &HTTPStatusError{
				Status:  http.StatusBadGateway,
				Message: "failed to read provider model response",
			},
		}, nil
	}

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, &providerModelsAttemptFailure{
			upstreamStatus: resp.StatusCode,
			err: &HTTPStatusError{
				Status:  mapUpstreamProviderStatus(resp.StatusCode),
				Message: extractUpstreamErrorMessage(body, resp.Status),
			},
		}, nil
	}

	if !json.Valid(body) {
		return nil, &providerModelsAttemptFailure{
			err: &HTTPStatusError{
				Status:  http.StatusBadGateway,
				Message: "provider model response is not valid JSON",
			},
		}, nil
	}

	contentType := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if contentType == "" {
		contentType = "application/json"
	}

	return &ProviderModelsResult{
		ContentType: contentType,
		Body:        body,
	}, nil, nil
}

func buildProviderModelsAttempts(
	providerType string,
	baseURL string,
	apiKey string,
) ([]providerModelsAttempt, error) {
	defaultURL, err := buildProviderModelsURL(providerType, baseURL, false)
	if err != nil {
		return nil, err
	}
	officialURL, err := buildProviderModelsURL(providerType, baseURL, true)
	if err != nil {
		return nil, err
	}

	candidates := []providerModelsAttempt{
		{url: defaultURL, headers: buildProviderModelsHeaders(providerType, apiKey, false)},
		{url: officialURL, headers: buildProviderModelsHeaders(providerType, apiKey, true)},
	}

	attempts := make([]providerModelsAttempt, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		signature := providerModelsAttemptSignature(candidate)
		if _, ok := seen[signature]; ok {
			continue
		}
		seen[signature] = struct{}{}
		attempts = append(attempts, candidate)
	}
	return attempts, nil
}

func providerModelsAttemptSignature(attempt providerModelsAttempt) string {
	keys := make([]string, 0, len(attempt.headers))
	for key := range attempt.headers {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var builder strings.Builder
	builder.WriteString(attempt.url)
	for _, key := range keys {
		builder.WriteString("||")
		builder.WriteString(key)
		builder.WriteString("=")
		builder.WriteString(attempt.headers[key])
	}
	return builder.String()
}

func buildProviderModelsHeaders(
	providerType string,
	apiKey string,
	official bool,
) map[string]string {
	headers := map[string]string{"Content-Type": "application/json"}
	switch providerType {
	case "gemini":
		headers["x-goog-api-key"] = apiKey
		if !official {
			headers["Authorization"] = "Bearer " + apiKey
		}
	case "claude_code":
		headers["x-api-key"] = apiKey
		headers["anthropic-version"] = anthropicAPIVersion
		if !official {
			headers["Authorization"] = "Bearer " + apiKey
		}
	default:
		headers["Authorization"] = "Bearer " + apiKey
		if !official {
			headers["x-api-key"] = apiKey
		}
	}
	return headers
}

func providerModelsBodyHasEntries(body []byte) bool {
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return false
	}

	switch typed := payload.(type) {
	case []any:
		return len(typed) > 0
	case map[string]any:
		if items, ok := typed["data"].([]any); ok && len(items) > 0 {
			return true
		}
		if items, ok := typed["models"].([]any); ok && len(items) > 0 {
			return true
		}
	}
	return false
}

func isMissingEndpointStatus(status int) bool {
	return status == http.StatusNotFound || status == http.StatusMethodNotAllowed
}

// pickProviderModelsFailure prefers the most informative failure: the last
// one that is not a bare "endpoint missing" upstream status, falling back to
// the last failure overall.
func pickProviderModelsFailure(failures []providerModelsAttemptFailure) error {
	for index := len(failures) - 1; index >= 0; index-- {
		if !isMissingEndpointStatus(failures[index].upstreamStatus) {
			return failures[index].err
		}
	}
	if len(failures) > 0 {
		return failures[len(failures)-1].err
	}
	return &HTTPStatusError{
		Status:  http.StatusBadGateway,
		Message: "failed to fetch provider models",
	}
}

func buildProviderModelsURL(providerType string, baseURL string, official bool) (string, error) {
	normalizedBaseURL := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if normalizedBaseURL == "" {
		return "", errors.New("base_url is required")
	}

	switch providerType {
	case "claude_code", "codex", "gemini":
	default:
		return "", errors.New("unsupported provider type")
	}

	if providerType == "codex" {
		lower := strings.ToLower(normalizedBaseURL)
		for _, suffix := range codexModelsSuffixes {
			if strings.HasSuffix(lower, suffix) {
				normalizedBaseURL = normalizedBaseURL[:len(normalizedBaseURL)-len(suffix)]
				break
			}
		}
	}
	if providerType == "gemini" {
		lower := strings.ToLower(normalizedBaseURL)
		for _, suffix := range []string{":streamgeneratecontent", ":generatecontent"} {
			if strings.HasSuffix(lower, suffix) {
				normalizedBaseURL = normalizedBaseURL[:len(normalizedBaseURL)-len(suffix)]
				break
			}
		}
		if modelsIndex := strings.LastIndex(strings.ToLower(normalizedBaseURL), "/models"); modelsIndex >= 0 {
			afterModels := normalizedBaseURL[modelsIndex+len("/models"):]
			if afterModels == "" || strings.HasPrefix(afterModels, "/") {
				normalizedBaseURL = normalizedBaseURL[:modelsIndex]
			}
		}
	}

	parsed, err := url.Parse(normalizedBaseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("base_url must be an absolute URL")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("base_url cannot contain query parameters or fragments")
	}
	if err := validateParsedOutboundHTTPURLShape(parsed); err != nil {
		return "", errors.New("base_url is not allowed")
	}

	if providerType == "gemini" {
		versionPath := "/v1"
		if official {
			versionPath = "/v1beta"
		}
		normalizedPath := strings.TrimRight(parsed.Path, "/")
		if strings.HasSuffix(strings.ToLower(normalizedPath), "/models") {
			parsed.Path = normalizedPath
		} else if isGeminiVersionPath(normalizedPath) {
			parsed.Path = normalizedPath + "/models"
		} else {
			parsed.Path = normalizedPath + versionPath + "/models"
		}
		return parsed.String(), nil
	}

	if strings.HasSuffix(strings.TrimRight(parsed.Path, "/"), "/v1") {
		parsed.Path = strings.TrimRight(parsed.Path, "/") + "/models"
	} else {
		parsed.Path = strings.TrimRight(parsed.Path, "/") + "/v1/models"
	}

	return parsed.String(), nil
}

func isGeminiVersionPath(path string) bool {
	path = strings.TrimRight(strings.ToLower(path), "/")
	return path == "/v1" || path == "/v1beta" ||
		strings.HasSuffix(path, "/v1") || strings.HasSuffix(path, "/v1beta")
}

func mapUpstreamProviderStatus(status int) int {
	switch status {
	case http.StatusUnauthorized,
		http.StatusForbidden,
		http.StatusNotFound,
		http.StatusConflict,
		http.StatusTooManyRequests:
		return status
	default:
		return http.StatusBadGateway
	}
}

func extractUpstreamErrorMessage(body []byte, fallback string) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return fallback
	}

	var payload any
	if err := json.Unmarshal(body, &payload); err == nil {
		if message := findStructuredErrorMessage(payload, 0); message != "" {
			return message
		}
	}

	return text
}

func findStructuredErrorMessage(value any, depth int) string {
	if depth > 4 || value == nil {
		return ""
	}

	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []any:
		for _, item := range typed {
			if nested := findStructuredErrorMessage(item, depth+1); nested != "" {
				return nested
			}
		}
	case map[string]any:
		for _, key := range []string{"error", "message", "detail", "details", "errorMessage", "msg", "title"} {
			if nested := findStructuredErrorMessage(typed[key], depth+1); nested != "" {
				return nested
			}
		}
	}

	return ""
}
