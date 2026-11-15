package kbrain

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

type usageStatsFixture struct {
	capability string
	status     int
	answer     string
	statsURI   string
	statsCalls int
}

func newUsageStatsRelay(t *testing.T, fixture *usageStatsFixture) *Relay {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/health":
			fmt.Fprintf(w, `{"status":"ok","version":"kbrain.agent.v1","capabilities":{%s}}`, fixture.capability)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/usage/stats":
			fixture.statsCalls++
			fixture.statsURI = r.URL.RequestURI()
			status := fixture.status
			if status == 0 {
				status = http.StatusOK
			}
			w.WriteHeader(status)
			_, _ = io.WriteString(w, fixture.answer)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, "secret-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "kbrain", ModelRef{}, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { relay.Close() })
	return relay
}

// The WebUI gets K-brain's aggregate as is; the relay only forwards the range and
// the browser's time zone.
func TestUsageStatsRelayForwardsRangeAndTimezone(t *testing.T) {
	answer := `{"generatedAt":"2026-11-15T08:00:00Z","timezone":"Asia/Shanghai","days":371,"totals":{"total":42},"daily":[],"models":[]}`
	fixture := &usageStatsFixture{capability: `"usage_stats":1`, answer: answer}
	relay := newUsageStatsRelay(t, fixture)
	response, err := relay.UsageStats(context.Background(), &gatewayv2.UsageStatsRequest{Days: 371, Timezone: "Asia/Shanghai"})
	if err != nil {
		t.Fatal(err)
	}
	if response.GetUnsupported() || response.GetResultJson() != answer {
		t.Fatalf("response = %+v", response)
	}
	if fixture.statsURI != "/v1/usage/stats?days=371&tz=Asia%2FShanghai" {
		t.Fatalf("stats uri = %q", fixture.statsURI)
	}

	if _, err := relay.UsageStats(context.Background(), &gatewayv2.UsageStatsRequest{}); err != nil {
		t.Fatal(err)
	}
	if fixture.statsURI != "/v1/usage/stats?days=371" {
		t.Fatalf("default stats uri = %q", fixture.statsURI)
	}
}

// An older K-brain without the capability is reported as unsupported, not as an
// error, and its stats route is never called.
func TestUsageStatsRelayReportsMissingCapabilityAsUnsupported(t *testing.T) {
	for _, capability := range []string{``, `"usage_stats":0`, `"usage_stats":false`} {
		fixture := &usageStatsFixture{capability: capability, answer: `{}`}
		relay := newUsageStatsRelay(t, fixture)
		response, err := relay.UsageStats(context.Background(), &gatewayv2.UsageStatsRequest{Days: 30})
		if err != nil {
			t.Fatalf("capabilities {%s}: %v", capability, err)
		}
		if !response.GetUnsupported() || response.GetResultJson() != "" {
			t.Fatalf("capabilities {%s}: response = %+v", capability, response)
		}
		if fixture.statsCalls != 0 {
			t.Fatalf("capabilities {%s}: stats route called %d times", capability, fixture.statsCalls)
		}
	}
}

func TestUsageStatsQueryAllowsKBrainRange(t *testing.T) {
	// K-brain accepts 1..1100 days; 0 means the default range.
	for days, want := range map[int32]string{0: "?days=371", 1: "?days=1", 1100: "?days=1100"} {
		got, err := UsageStatsQuery(days, "")
		if err != nil || got != want {
			t.Fatalf("UsageStatsQuery(%d) = %q, %v; want %q", days, got, err, want)
		}
	}
	if _, err := UsageStatsQuery(1101, ""); err == nil {
		t.Fatal("UsageStatsQuery(1101) error = nil")
	}
}

func TestUsageStatsRelayRejectsBadInputBeforeCallingKBrain(t *testing.T) {
	fixture := &usageStatsFixture{capability: `"usage_stats":1`, answer: `{}`}
	relay := newUsageStatsRelay(t, fixture)
	for _, req := range []*gatewayv2.UsageStatsRequest{
		{Days: -1},
		{Days: UsageStatsMaxDays + 1},
		{Days: 30, Timezone: "Asia/Shanghai&days=99999"},
		{Days: 30, Timezone: "../../etc"},
		{Days: 30, Timezone: strings.Repeat("A", 65)},
	} {
		if _, err := relay.UsageStats(context.Background(), req); err == nil {
			t.Fatalf("UsageStats(%+v) error = nil", req)
		}
	}
	if fixture.statsCalls != 0 {
		t.Fatalf("stats route called %d times", fixture.statsCalls)
	}
}

func TestUsageStatsRelaySurfacesKBrainErrors(t *testing.T) {
	cases := []struct {
		status int
		answer string
		want   string
	}{
		{http.StatusBadRequest, `{"error":"unknown time zone"}`, "unknown time zone"},
		{http.StatusInternalServerError, `oops`, "500"},
		{http.StatusOK, `[1,2]`, "not a JSON object"},
		{http.StatusOK, `null`, "not a JSON object"},
	}
	for _, tc := range cases {
		fixture := &usageStatsFixture{capability: `"usage_stats":1`, status: tc.status, answer: tc.answer}
		relay := newUsageStatsRelay(t, fixture)
		_, err := relay.UsageStats(context.Background(), &gatewayv2.UsageStatsRequest{Days: 7, Timezone: "UTC"})
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("status %d %q: error = %v, want %q", tc.status, tc.answer, err, tc.want)
		}
		if strings.Contains(err.Error(), "secret-token") {
			t.Fatalf("error leaks the token: %v", err)
		}
	}
}

// A capability cached from before a K-brain downgrade must not turn into an error.
func TestUsageStatsRelayTreatsMissingRouteAsUnsupported(t *testing.T) {
	fixture := &usageStatsFixture{capability: `"usage_stats":1`, status: http.StatusNotFound, answer: `404 page not found`}
	relay := newUsageStatsRelay(t, fixture)
	response, err := relay.UsageStats(context.Background(), &gatewayv2.UsageStatsRequest{Days: 7})
	if err != nil || !response.GetUnsupported() {
		t.Fatalf("response = %+v, err = %v", response, err)
	}
}
