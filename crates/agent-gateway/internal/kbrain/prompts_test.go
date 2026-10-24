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

func TestRelayPromptTemplateSaveClearAndFailure(t *testing.T) {
	puts := 0
	failed := false
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/settings":
			if r.Method != "GET" {
				t.Error("prompts written into model configuration")
			}
			_, _ = io.WriteString(w, `{"providers":[],"models":[]}`)
		case "/v1/prompts/templates":
			puts++
			body, _ := io.ReadAll(r.Body)
			if r.Method != "PUT" || !strings.Contains(string(body), `"templates":`) {
				t.Errorf("unexpected mutation: %s %s", r.Method, body)
			}
			if failed {
				w.WriteHeader(409)
				_, _ = io.WriteString(w, `{"error":"prompt conflict"}`)
				return
			}
			_, _ = io.WriteString(w, `{"revision":2}`)
		default:
			t.Errorf("unexpected resource: %s", r.URL)
		}
	}))
	defer backend.Close()
	client, _ := New(backend.URL, "", backend.Client())
	relay, _ := NewRelay(client, "kb", ModelRef{}, "")
	defer relay.Close()
	for _, raw := range []string{`{"agents":[{"id":"a","name":"Audit","description":"","prompt":"Audit prompt","enabled":true}]}`, `{"agents":[]}`} {
		out, err := relay.SettingsUpdate(context.Background(), &gatewayv2.SettingsUpdateRequest{SettingsJson: raw})
		if err != nil || !out.GetAccepted() {
			t.Fatalf("save=%v err=%v", out, err)
		}
	}
	for _, raw := range []string{`null`, `{}`, `[null]`, `[{"id":"a"}]`, `[{"id":"a","name":"n","description":"","prompt":"p","enabled":null}]`} {
		if _, err := relay.SettingsUpdate(context.Background(), &gatewayv2.SettingsUpdateRequest{SettingsJson: `{"agents":` + raw + `}`}); err == nil {
			t.Fatalf("accepted malformed templates: %s", raw)
		}
	}
	if puts != 2 {
		t.Fatalf("malformed mutation reached backend: puts=%d", puts)
	}
	failed = true
	if _, err := relay.SettingsUpdate(context.Background(), &gatewayv2.SettingsUpdateRequest{SettingsJson: `{"agents":[]}`}); err == nil || !strings.Contains(err.Error(), "prompt conflict") || puts != 3 {
		t.Fatalf("failed mutation acknowledged or retried: %v puts=%d", err, puts)
	}
}
