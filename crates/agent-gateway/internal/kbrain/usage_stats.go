package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// Settings → Usage asks for one year of daily buckets (52 full weeks plus the
// current one); the range is capped so a hostile request cannot make K-brain
// aggregate an unbounded history.
const (
	UsageStatsDefaultDays = 371
	UsageStatsMaxDays     = 1100
	usageStatsMaxTimezone = 64
	usageStatsMaxAnswer   = 8 << 20
)

// UsageStatsQuery checks the WebUI's days and timezone and returns K-brain's
// /v1/usage/stats query string. days 0 means the default range; an empty
// timezone lets K-brain use its own. Only IANA name characters pass, so the
// value cannot smuggle extra query parameters.
func UsageStatsQuery(days int32, timezone string) (string, error) {
	if days == 0 {
		days = UsageStatsDefaultDays
	}
	if days < 1 || days > UsageStatsMaxDays {
		return "", fmt.Errorf("invalid usage stats request: days must be between 1 and %d", UsageStatsMaxDays)
	}
	timezone = strings.TrimSpace(timezone)
	if !validUsageStatsTimezone(timezone) {
		return "", errors.New("invalid usage stats request: timezone must be an IANA time zone name")
	}
	query := url.Values{}
	query.Set("days", strconv.Itoa(int(days)))
	if timezone != "" {
		query.Set("tz", timezone)
	}
	return "?" + query.Encode(), nil
}

func validUsageStatsTimezone(timezone string) bool {
	if len(timezone) > usageStatsMaxTimezone {
		return false
	}
	for _, r := range timezone {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '/', r == '_', r == '-', r == '+':
		default:
			return false
		}
	}
	return true
}

// UsageStats serves Settings → Usage for a direct K-brain target. A backend
// without capabilities.usage_stats answers unsupported instead of an error, so
// the page can ask for an update rather than show a failure.
func (r *Relay) UsageStats(ctx context.Context, req *gatewayv2.UsageStatsRequest) (*gatewayv2.UsageStatsResponse, error) {
	if req == nil {
		return nil, errors.New("invalid usage stats request")
	}
	query, err := UsageStatsQuery(req.GetDays(), req.GetTimezone())
	if err != nil {
		return nil, err
	}
	health, err := r.client.verifiedHealth(ctx, handshakeCapabilityMaxAge)
	if errors.Is(err, errHealthUnavailable) {
		return &gatewayv2.UsageStatsResponse{Unsupported: true}, nil
	}
	if err != nil {
		return nil, err
	}
	if !health.CapabilityAtLeast("usage_stats", 1) {
		return &gatewayv2.UsageStatsResponse{Unsupported: true}, nil
	}
	resp, err := r.client.request(ctx, http.MethodGet, "/v1/usage/stats"+query, nil, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, usageStatsMaxAnswer+1))
	if err != nil {
		return nil, err
	}
	if len(data) > usageStatsMaxAnswer {
		return nil, errors.New("kbrain usage stats response is too large")
	}
	if resp.StatusCode == http.StatusNotFound {
		// The handshake was cached before a downgrade: no route means no capability.
		return &gatewayv2.UsageStatsResponse{Unsupported: true}, nil
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		var failure struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &failure) == nil && strings.TrimSpace(failure.Error) != "" {
			return nil, errors.New(strings.TrimSpace(failure.Error))
		}
		return nil, fmt.Errorf("kbrain usage stats request: %s", resp.Status)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil || object == nil {
		return nil, errors.New("kbrain usage stats response is not a JSON object")
	}
	return &gatewayv2.UsageStatsResponse{ResultJson: string(data)}, nil
}
