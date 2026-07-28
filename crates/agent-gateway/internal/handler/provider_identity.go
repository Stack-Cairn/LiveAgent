package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const providerIdentityResponseLimit = 16 * 1024

var stableProviderIdentityVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

type providerIdentitySource struct {
	url     string
	distTag string
}

var providerIdentitySources = map[string]providerIdentitySource{
	"claude_code": {
		url:     "https://registry.npmjs.org/-/package/%40anthropic-ai%2Fclaude-code/dist-tags",
		distTag: "stable",
	},
	"codex": {
		url:     "https://registry.npmjs.org/-/package/%40openai%2Fcodex/dist-tags",
		distTag: "latest",
	},
	"xai": {
		url:     "https://registry.npmjs.org/-/package/%40xai-official%2Fgrok/dist-tags",
		distTag: "latest",
	},
}

func ProviderIdentityVersion(timeout time.Duration) http.HandlerFunc {
	if timeout <= 0 || timeout > 10*time.Second {
		timeout = 10 * time.Second
	}
	return providerIdentityVersionWithClient(newSafeOutboundHTTPClient(timeout))
}

func providerIdentityVersionWithClient(client outboundHTTPClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		providerID := strings.TrimSpace(r.PathValue("provider"))
		source, ok := providerIdentitySources[providerID]
		if !ok {
			writeError(w, http.StatusNotFound, "unsupported provider identity")
			return
		}

		request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, source.url, nil)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to build version request")
			return
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("User-Agent", "LiveAgent-Gateway/1")

		response, err := client.Do(request)
		if err != nil {
			writeError(w, http.StatusBadGateway, fmt.Sprintf("version lookup failed: %v", err))
			return
		}
		defer func() { _ = response.Body.Close() }()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			writeError(w, http.StatusBadGateway, fmt.Sprintf("version registry returned HTTP %d", response.StatusCode))
			return
		}

		body, err := io.ReadAll(io.LimitReader(response.Body, providerIdentityResponseLimit+1))
		if err != nil {
			writeError(w, http.StatusBadGateway, "failed to read version response")
			return
		}
		if len(body) > providerIdentityResponseLimit {
			writeError(w, http.StatusBadGateway, "version response is too large")
			return
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(body, &payload); err != nil {
			writeError(w, http.StatusBadGateway, "version response is not valid JSON")
			return
		}
		var version string
		if err := json.Unmarshal(payload[source.distTag], &version); err != nil {
			writeError(w, http.StatusBadGateway, "version response is missing the stable dist-tag")
			return
		}
		version = strings.TrimSpace(version)
		if len(version) > 64 || !stableProviderIdentityVersion.MatchString(version) {
			writeError(w, http.StatusBadGateway, "version response is not a stable semantic version")
			return
		}

		w.Header().Set("Cache-Control", "private, max-age=300")
		writeJSON(w, http.StatusOK, map[string]string{"version": version})
	}
}
