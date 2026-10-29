package kbrain

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// K-brain explains a rejected settings request in its JSON error body. The WebUI
// shows the relay's error text, so keep that explanation instead of the bare
// status (the provider editor uses it to tell an old backend's stored-key
// refusal from other failures).
func TestSettingsRequestKeepsKBrainErrorExplanation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":"provider credentials or endpoint are not configured","version":"kbrain.agent.v1"}`)
	}))
	defer server.Close()
	client, err := New(server.URL, "secret-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "target", ModelRef{}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()

	_, err = relay.ProviderModels(context.Background(), &gatewayv2.ProviderModelsRequest{
		ProviderId: "p", ProviderType: "codex", BaseUrl: "https://moved.example.com/v1",
	})
	if err == nil {
		t.Fatal("a rejected discovery must fail")
	}
	message := err.Error()
	if !strings.Contains(message, "400") || !strings.Contains(message, "provider credentials or endpoint are not configured") {
		t.Fatalf("error = %q, want the status and K-brain's explanation", message)
	}
	if strings.Contains(message, "secret-token") || strings.Contains(message, server.URL) {
		t.Fatalf("error leaks the token or backend URL: %q", message)
	}
}
