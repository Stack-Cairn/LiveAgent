package kbrain

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestRelayMCPSettingsReadSaveClearAndFailure(t *testing.T) {
	settings := json.RawMessage(`{"servers":[{"id":"existing","enabled":true,"transport":"stdio","command":"fixture"}],"selected":["existing"]}`)
	failed := false
	puts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer backend-token" {
			t.Error("missing backend auth")
		}
		if r.URL.Path == "/v1/settings" {
			if r.Method != "GET" {
				t.Error("MCP save wrote provider settings")
			}
			_, _ = io.WriteString(w, `{"providers":[],"models":[]}`)
			return
		}
		if r.URL.Path == "/v1/skills" {
			_, _ = io.WriteString(w, `{"settings":{"enabled":true,"selected":[]}}`)
			return
		}
		if r.URL.Path != "/v1/mcp" {
			t.Errorf("path=%s", r.URL)
			return
		}
		if failed {
			http.Error(w, "unavailable", 503)
			return
		}
		if r.Method == "PUT" {
			puts++
			if err := json.NewDecoder(r.Body).Decode(&settings); err != nil {
				t.Error(err)
			}
		}
		_, _ = w.Write([]byte(`{"settings":` + string(settings) + `}`))
	}))
	defer srv.Close()
	client, _ := New(srv.URL, "backend-token", srv.Client())
	relay, _ := NewRelay(client, "kb", ModelRef{}, "")
	get, err := relay.SettingsGet(context.Background(), &gatewayv2.SettingsGetRequest{})
	if err != nil || !strings.Contains(get.GetSettingsJson(), `"existing"`) {
		t.Fatalf("get=%v err=%v", get, err)
	}
	for _, body := range []string{`{"mcp":{"servers":[{"id":"sse","transport":"sse","enabled":true,"url":"https://example.test/mcp"}],"selected":["sse"]}}`, `{"mcp":{"servers":[],"selected":[]}}`} {
		response, err := relay.SettingsUpdate(context.Background(), &gatewayv2.SettingsUpdateRequest{SettingsJson: body})
		if err != nil || !response.GetAccepted() {
			t.Fatalf("update=%v %v", response, err)
		}
		if strings.Contains(string(settings), `"sse"`) && strings.Contains(string(settings), `"transport":"sse"`) {
			t.Fatal("transport was not normalized")
		}
	}
	if puts != 2 || !strings.Contains(string(settings), `"servers":[]`) {
		t.Fatalf("puts=%d settings=%s", puts, settings)
	}
	for _, bad := range []string{`{"mcp":null}`, `{"mcp":{}}`, `{"mcp":{"servers":[null]}}`} {
		if _, err := relay.SettingsUpdate(context.Background(), &gatewayv2.SettingsUpdateRequest{SettingsJson: bad}); err == nil {
			t.Fatal("accepted malformed MCP")
		}
	}
	failed = true
	if _, err := relay.SettingsGet(context.Background(), &gatewayv2.SettingsGetRequest{}); err == nil {
		t.Fatal("MCP read failure was silently hidden")
	}
	if _, err := relay.SettingsUpdate(context.Background(), &gatewayv2.SettingsUpdateRequest{SettingsJson: `{"mcp":{"servers":[]}}`}); err == nil {
		t.Fatal("failed save acknowledged")
	}
}
