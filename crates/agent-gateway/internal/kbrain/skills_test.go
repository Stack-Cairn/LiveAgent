package kbrain

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestRelaySkillSettingsSaveAndValidation(t *testing.T) {
	puts := 0
	fail := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/settings":
			if r.Method != "GET" {
				t.Error("skill settings written to provider settings")
			}
			_, _ = io.WriteString(w, `{"providers":[],"models":[]}`)
		case "/v1/skills/settings":
			puts++
			body, _ := io.ReadAll(r.Body)
			if r.Method != "PUT" || !strings.Contains(string(body), `"enabled":false`) {
				t.Errorf("invalid save %s %s", r.Method, body)
			}
			if fail {
				w.WriteHeader(503)
				_, _ = io.WriteString(w, `{"error":"offline"}`)
				return
			}
			_, _ = io.WriteString(w, `{"settings":{"enabled":false,"selected":[]}}`)
		default:
			t.Errorf("unexpected request %s", r.URL)
		}
	}))
	defer server.Close()
	client, _ := New(server.URL, "", server.Client())
	relay, _ := NewRelay(client, "kb", ModelRef{}, "")
	request := &gatewayv2.SettingsUpdateRequest{SettingsJson: `{"skills":{"enabled":false,"selected":[]}}`}
	result, err := relay.SettingsUpdate(context.Background(), request)
	if err != nil || !result.GetAccepted() || puts != 1 {
		t.Fatalf("result=%v err=%v puts=%d", result, err, puts)
	}
	for _, raw := range []string{`{"skills":null}`, `{"skills":{}}`, `{"skills":{"enabled":false,"selected":null}}`} {
		if _, err := relay.SettingsUpdate(context.Background(), &gatewayv2.SettingsUpdateRequest{SettingsJson: raw}); err == nil {
			t.Fatalf("accepted invalid settings %s", raw)
		}
	}
	for _, raw := range []string{`null`, `{}`, `{"action":"list","workdir":123}`} {
		if _, err := relay.SkillManage(context.Background(), &gatewayv2.SkillManageRequest{PayloadJson: raw}); err == nil {
			t.Fatalf("accepted invalid request %s", raw)
		}
	}
	fail = true
	if _, err := relay.SettingsUpdate(context.Background(), request); err == nil {
		t.Fatal("failed save acknowledged")
	}
}
