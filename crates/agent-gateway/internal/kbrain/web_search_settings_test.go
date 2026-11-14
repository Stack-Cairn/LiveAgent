package kbrain

import (
	"encoding/json"
	"strings"
	"testing"
)

// The Go relay and the desktop agent's Rust bridge (services/gateway/kbrain_web_search.rs)
// must agree on the kbrainWebSearch contract.
func TestWebSearchSettingsContractMatchesDesktopBridge(t *testing.T) {
	for input, want := range map[string]string{
		`{"kbrainWebSearch":{"provider":"searxng","baseUrl":" http://127.0.0.1:8888 ","maxResults":5}}`: `{"webSearch":{"baseUrl":"http://127.0.0.1:8888","maxResults":5,"provider":"searxng"}}`,
		`{"kbrainWebSearch":{"apiKey":" tvly-new "}}`:                                                   `{"webSearch":{"apiKey":"tvly-new"}}`,
		// An empty key keeps the stored one, so it is not forwarded.
		`{"kbrainWebSearch":{"provider":"tavily","apiKey":""}}`: `{"webSearch":{"provider":"tavily"}}`,
		`{"kbrainWebSearch":{"clearApiKey":true}}`:              `{"webSearch":{"clearApiKey":true}}`,
		`{"kbrainWebSearch":{"clearApiKey":false}}`:             `{"webSearch":{}}`,
		// A GET body put back: the read-only fields are dropped.
		`{"kbrainWebSearch":{"provider":"brave","maxResults":0,"apiKeyConfigured":true,"apiKeySource":"env","available":true,"reason":"","providers":["tavily"]}}`: `{"webSearch":{"maxResults":0,"provider":"brave"}}`,
	} {
		update, err := settingsUpdateForKBrain(json.RawMessage(input))
		if err != nil || string(update) != want {
			t.Fatalf("%s: got %s %v, want %s", input, update, err, want)
		}
	}
	for _, bad := range []string{
		`{"kbrainWebSearch":true}`,
		`{"kbrainWebSearch":null}`,
		`{"kbrainWebSearch":[]}`,
		`{"kbrainWebSearch":{"provider":1}}`,
		`{"kbrainWebSearch":{"apiKey":true}}`,
		`{"kbrainWebSearch":{"clearApiKey":"yes"}}`,
		`{"kbrainWebSearch":{"maxResults":"5"}}`,
		`{"kbrainWebSearch":{"apiKey":"k","clearApiKey":true}}`,
	} {
		if _, err := settingsUpdateForKBrain(json.RawMessage(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	// Provider names, URLs and the 0-10 range are K-brain's to check.
	if update, err := settingsUpdateForKBrain(json.RawMessage(`{"kbrainWebSearch":{"provider":"bing","maxResults":50}}`)); err != nil || string(update) != `{"webSearch":{"maxResults":50,"provider":"bing"}}` {
		t.Fatalf("forwarded for K-brain to check: %s %v", update, err)
	}

	projected, err := settingsProjectionForGateway(json.RawMessage(`{"providers":[],"webSearch":{"provider":"tavily","maxResults":0,"apiKeyConfigured":true,"apiKeySource":"config","available":true,"providers":["tavily","brave","searxng","bocha","jina"]}}`))
	if err != nil || !strings.Contains(string(projected), `"kbrainWebSearch":{"provider":"tavily","maxResults":0,"apiKeyConfigured":true,"apiKeySource":"config","available":true,"providers":["tavily","brave","searxng","bocha","jina"]}`) {
		t.Fatalf("projection: %s %v", projected, err)
	}
	legacy, err := settingsProjectionForGateway(json.RawMessage(`{"providers":[]}`))
	if err != nil || strings.Contains(string(legacy), "kbrainWebSearch") {
		t.Fatalf("older backend projection: %s %v", legacy, err)
	}
}

func TestNativeWebSearchSupportedIsRelayedButNeverWritten(t *testing.T) {
	projected, err := settingsProjectionForGateway(json.RawMessage(`{"providers":[
		{"id":"relay","name":"Relay","api":"openai-completions","baseUrl":"http://127.0.0.1:9","activeModels":[],"models":[],"nativeWebSearchSupported":false},
		{"id":"official","name":"Official","api":"openai-responses","baseUrl":"","activeModels":[],"models":[],"nativeWebSearchSupported":true},
		{"id":"legacy","name":"Legacy","api":"openai-responses","baseUrl":"","activeModels":[],"models":[]}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		CustomProviders []map[string]any `json:"customProviders"`
	}
	if err := json.Unmarshal(projected, &document); err != nil {
		t.Fatal(err)
	}
	if got := document.CustomProviders[0]["nativeWebSearchSupported"]; got != false {
		t.Fatalf("relay: %v", got)
	}
	if got := document.CustomProviders[1]["nativeWebSearchSupported"]; got != true {
		t.Fatalf("official: %v", got)
	}
	if _, present := document.CustomProviders[2]["nativeWebSearchSupported"]; present {
		t.Fatalf("older backend gained the flag: %v", document.CustomProviders[2])
	}

	// A WebUI echoes the flag back with the provider; K-brain does not take it as a setting.
	update, err := settingsUpdateForKBrain(json.RawMessage(`{"customProviders":[{"id":"relay","name":"Relay","type":"codex","requestFormat":"openai-completions","nativeWebSearchSupported":false}]}`))
	if err != nil || strings.Contains(string(update), "nativeWebSearchSupported") {
		t.Fatalf("update: %s %v", update, err)
	}
}
