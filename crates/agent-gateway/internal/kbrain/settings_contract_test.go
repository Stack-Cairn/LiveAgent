package kbrain

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestComputerSettingsPassThroughBackend(t *testing.T) {
	projected, err := settingsProjectionForGateway(json.RawMessage(`{"providers":[],"models":[],"computer":{"enabled":true,"backend":"cua"}}`))
	if err != nil || !strings.Contains(string(projected), `"computer":{"enabled":true,"backend":"cua"}`) {
		t.Fatalf("projection: %s %v", projected, err)
	}
	update, err := settingsUpdateForKBrain(json.RawMessage(`{"computer":{"enabled":false,"approvalPolicy":"deny"}}`))
	if err != nil || !strings.Contains(string(update), `"computer"`) {
		t.Fatalf("update: %s %v", update, err)
	}
	if _, err := settingsUpdateForKBrain(json.RawMessage(`{"computer":null}`)); err == nil {
		t.Fatal("accepted null computer settings")
	}
}

func TestMemorySwitchTravelsAsKBrainMemory(t *testing.T) {
	projected, err := settingsProjectionForGateway(json.RawMessage(`{"providers":[],"models":[],"memory":{"enabled":false}}`))
	if err != nil || !strings.Contains(string(projected), `"kbrainMemory":{"enabled":false}`) || strings.Contains(string(projected), `"memory"`) {
		t.Fatalf("projection must expose the switch only as kbrainMemory: %s %v", projected, err)
	}
	legacy, err := settingsProjectionForGateway(json.RawMessage(`{"providers":[],"models":[]}`))
	if err != nil || strings.Contains(string(legacy), "kbrainMemory") {
		t.Fatalf("a backend without the switch must not project one: %s %v", legacy, err)
	}
	update, err := settingsUpdateForKBrain(json.RawMessage(`{"kbrainMemory":{"enabled":false}}`))
	if err != nil || string(update) != `{"memory":{"enabled":false}}` {
		t.Fatalf("update: %s %v", update, err)
	}
	for _, bad := range []string{`{"kbrainMemory":null}`, `{"kbrainMemory":{}}`, `{"kbrainMemory":{"enabled":"no"}}`, `{"memory":{"enabled":false}}`} {
		if _, err := settingsUpdateForKBrain(json.RawMessage(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}

func TestSettingsProjectionOnlyProjectsKBrainOwnedFields(t *testing.T) {
	raw := json.RawMessage(`{"defaultProvider":"p","defaultModel":"m","providers":[{"id":"p","name":"Provider","api":"openai-completions","baseUrl":"https://example.test/v1","apiKeyConfigured":true,"models":[{"id":"m","contextWindow":4096,"maxOutputTokens":512,"inputModalities":["text","image"]}]}]}`)
	projected, err := settingsProjectionForGateway(raw)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(projected, &got); err != nil {
		t.Fatal(err)
	}
	if _, ok := got["theme"]; ok {
		t.Fatal("projection invented theme")
	}
	provider := got["customProviders"].([]any)[0].(map[string]any)
	if provider["apiKey"] != "" || provider["apiKeyConfigured"] != true || provider["type"] != "codex" {
		t.Fatalf("provider projection=%v", provider)
	}
	model := provider["models"].([]any)[0].(map[string]any)
	if model["contextWindow"] != float64(4096) || !reflect.DeepEqual(model["inputModalities"], []any{"text", "image"}) {
		t.Fatalf("model projection=%v", model)
	}
}

func TestSettingsProjectionPreservesExplicitFalseNativeSearch(t *testing.T) {
	raw := json.RawMessage(`{"defaultProvider":"p","defaultModel":"m","providers":[{"id":"p","api":"openai-completions","baseUrl":"https://example.test/v1","nativeWebSearchEnabled":false,"models":[{"id":"m"}]}]}`)
	projected, err := settingsProjectionForGateway(raw)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(projected, &got); err != nil {
		t.Fatal(err)
	}
	provider := got["customProviders"].([]any)[0].(map[string]any)
	value, ok := provider["nativeWebSearchEnabled"]
	if !ok || value != false {
		t.Fatalf("nativeWebSearchEnabled wire value = %#v, projected = %s", value, projected)
	}
}

func TestSettingsUpdateMapsProviderSidecarsAndRejectsUnknownFields(t *testing.T) {
	input := json.RawMessage(`{"customProviders":[{"id":"p","name":"P","type":"codex","baseUrl":"https://example.test","apiKey":"","apiKeyConfigured":true,"models":[{"provider":"p","id":"m","contextWindow":12,"unexpected":"drop"}]}],"selectedModel":{"customProviderId":"p","model":"m"},"providerApiKeyUpdates":{"p":"secret"}}`)
	translated, err := settingsUpdateForKBrain(input)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(translated, &got); err != nil {
		t.Fatal(err)
	}
	providers := got["providers"].([]any)
	provider := providers[0].(map[string]any)
	if provider["apiKey"] != "secret" || provider["clearApiKey"] != nil || provider["api"] != "openai-responses" {
		t.Fatalf("provider update=%v", provider)
	}
	model := provider["models"].([]any)[0].(map[string]any)
	if _, ok := model["provider"]; ok {
		t.Fatal("model provider key was not removed")
	}
	if _, ok := model["unexpected"]; ok {
		t.Fatal("unknown model field was not filtered")
	}
	if _, err := settingsUpdateForKBrain(json.RawMessage(`{"theme":"dark"}`)); err == nil {
		t.Fatal("unknown settings field silently accepted")
	}
}

func TestProviderModelsUsesKBrainDraftEndpoint(t *testing.T) {
	var method, path, body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.EscapedPath()
		data, _ := io.ReadAll(r.Body)
		body = string(data)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"version":"kbrain.agent.v1","provider":"draft/provider","models":[{"provider":"draft/provider","id":"m","contextWindow":100}]}`)
	}))
	defer srv.Close()
	client, err := New(srv.URL, "token", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "kbrain", ModelRef{}, "")
	if err != nil {
		t.Fatal(err)
	}
	response, err := relay.ProviderModels(context.Background(), &gatewayv2.ProviderModelsRequest{
		ProviderId: "draft/provider", ProviderType: "codex", BaseUrl: "https://example.test", ApiKey: "key", RequestFormat: "openai-responses",
	})
	if err != nil {
		t.Fatal(err)
	}
	if method != http.MethodPost || path != "/v1/settings/providers/draft%2Fprovider/models" {
		t.Fatalf("request=%s %s", method, path)
	}
	if !strings.Contains(body, `"providerId":"draft/provider"`) || !strings.Contains(body, `"requestFormat":"openai-responses"`) {
		t.Fatalf("discovery body=%s", body)
	}
	if !strings.Contains(response.GetModelsJson(), `"contextWindow":100`) {
		t.Fatalf("response=%s", response.GetModelsJson())
	}
}

func TestSettingsReplacementDeletesProvidersAndPreservesDisabledModels(t *testing.T) {
	previous := json.RawMessage(`{"providers":[{"id":"keep","apiKeyConfigured":true,"models":[]},{"id":"remove","models":[]}]}`)
	input := json.RawMessage(`{"customProviders":[{"id":"keep","type":"deepseek","apiKey":"","apiKeyConfigured":true,"activeModels":[],"models":[{"id":"disabled","displayName":"Disabled","maxOutputToken":42,"maxOutputTokens":7,"promptCacheHintMode":"auto"}]}]}`)
	translated, err := settingsUpdateForKBrain(input, previous)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Providers []map[string]any `json:"providers"`
		Deleted   []string         `json:"deleteProviders"`
	}
	if err := json.Unmarshal(translated, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Deleted, []string{"remove"}) {
		t.Fatalf("deleted=%v", got.Deleted)
	}
	provider := got.Providers[0]
	if provider["apiKey"] != nil || provider["clearApiKey"] != nil || provider["api"] != "openai-completions" || provider["type"] != "deepseek" {
		t.Fatalf("provider=%v", provider)
	}
	if len(provider["activeModels"].([]any)) != 0 {
		t.Fatalf("active=%v", provider["activeModels"])
	}
	model := provider["models"].([]any)[0].(map[string]any)
	if model["id"] != "disabled" || model["maxOutputTokens"] != float64(42) || model["promptCacheHintMode"] != nil {
		t.Fatalf("model=%v", model)
	}
	cleared, err := settingsUpdateForKBrain(json.RawMessage(`{"customProviders":[],"selectedModel":null}`), previous)
	if err != nil {
		t.Fatal(err)
	}
	var all map[string]any
	if err := json.Unmarshal(cleared, &all); err != nil {
		t.Fatal(err)
	}
	if len(all["deleteProviders"].([]any)) != 2 || all["defaultModel"] != "" || all["defaultProvider"] != "" {
		t.Fatalf("clear=%s", cleared)
	}
}

func TestSettingsCredentialIntentAndUsageSidecars(t *testing.T) {
	previous := json.RawMessage(`{"providers":[{"id":"p","apiKeyConfigured":true,"models":[],"usageQuery":{"mode":"newapi","apiKey":"","apiKeyConfigured":true}}]}`)
	for _, tc := range []struct {
		name, provider, sidecar string
		clear                   bool
		key                     string
	}{
		{"blank preserves", `{"id":"p","apiKey":""}`, "", false, ""},
		{"redacted preserves", `{"id":"p","apiKey":"","apiKeyConfigured":true}`, `,"providerApiKeyUpdates":{"p":""}`, false, ""},
		{"configured flag clears", `{"id":"p","apiKeyConfigured":false}`, "", true, ""},
		{"explicit clear", `{"id":"p","clearApiKey":true}`, "", true, ""},
		{"sidecar wins flag", `{"id":"p","apiKeyConfigured":false}`, `,"providerApiKeyUpdates":{"p":" replacement "}`, false, "replacement"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := settingsUpdateForKBrain(json.RawMessage(`{"customProviders":[`+tc.provider+`]`+tc.sidecar+`}`), previous)
			if err != nil {
				t.Fatal(err)
			}
			var result struct {
				Providers []map[string]any `json:"providers"`
			}
			if err := json.Unmarshal(out, &result); err != nil {
				t.Fatal(err)
			}
			p := result.Providers[0]
			if (p["clearApiKey"] == true) != tc.clear || asString(p["apiKey"]) != tc.key {
				t.Fatalf("update=%s", out)
			}
		})
	}
	out, err := settingsUpdateForKBrain(json.RawMessage(`{"customProviders":[{"id":"p"}],"providerUsageQuerySecretUpdates":{"p":{"apiKey":"","accessToken":"token"}}}`), previous)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Providers []struct {
			Usage map[string]any `json:"usageQuery"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatal(err)
	}
	query := result.Providers[0].Usage
	if query["mode"] != "newapi" || query["apiKeyConfigured"] != false || query["apiKey"] != "" || query["accessToken"] != "token" {
		t.Fatalf("usage=%v", query)
	}
}

func TestSettingsRejectsUnpersistedOrMalformedUpdates(t *testing.T) {
	for _, input := range []string{
		`null`, `[]`, `{}`, `{"customProviders":null}`, `{"customProviders":[null]}`,
		`{"theme":"dark","customProviders":[]}`, `{"system":{"executionMode":"tools"}}`,
		`{"customProviders":[{"id":"p"},{"id":"p"}]}`, `{"customProviders":[{"id":"p","models":null}]}`,
		`{"customProviders":[{"id":"p","activeModels":null}]}`, `{"customProviders":[{"id":"p","apiKey":null}]}`,
		`{"customProviders":[{"id":"p","type":"unknown"}]}`, `{"customProviders":[{"id":"p","type":"gemini","api":"openai-responses"}]}`,
		`{"customProviders":[{"id":"p","clearApiKey":true}],"providerApiKeyUpdates":{"p":"key"}}`,
		`{"customProviders":[],"providerApiKeyUpdates":{"missing":"key"}}`,
		`{"providerUsageQuerySecretUpdates":{"p":{"apiKey":"key"}}}`,
		`{"customProviders":[{"id":"p"}],"providerUsageQuerySecretUpdates":{"p":{"unknown":"key"}}}`,
		`{"customProviders":[{"id":"p"}],"deleteProviders":["p"]}`,
	} {
		t.Run(input, func(t *testing.T) {
			if _, err := settingsUpdateForKBrain(json.RawMessage(input)); err == nil {
				t.Fatalf("silently accepted %s", input)
			}
		})
	}
}

func TestProviderTypeAndAPIMappings(t *testing.T) {
	for _, tc := range []struct{ ptype, format, api string }{
		{"codex", "", "openai-responses"}, {"codex", "openai-completions", "openai-completions"},
		{"claude_code", "", "anthropic-messages"}, {"gemini", "", "google-generative-ai"},
		{"deepseek", "", "openai-completions"}, {"xai", "", "openai-responses"},
	} {
		t.Run(tc.ptype+tc.format, func(t *testing.T) {
			if apiForProviderType(tc.ptype, tc.format) != tc.api {
				t.Fatal("incorrect API")
			}
			if providerType(kbrainProvider{Type: tc.ptype, API: tc.api}) != tc.ptype {
				t.Fatal("lost explicit provider type")
			}
		})
	}
	if providerType(kbrainProvider{Type: "unknown", API: "anthropic-messages"}) != "claude_code" {
		t.Fatal("incorrect API fallback")
	}
	model := providerModel(kbrainProvider{ID: "p"}, kbrainModel{ID: "m", Name: "Model", MaxOutputTokens: 64, Vision: true})
	if model["displayName"] != "Model" || model["maxOutputToken"] != 64 || model["limitsSource"] != "provider" || !reflect.DeepEqual(model["inputModalities"], []string{"text", "image"}) {
		t.Fatalf("model=%v", model)
	}
}

func TestRelaySettingsUpdateReadsSnapshotAndPropagatesPersistenceFailure(t *testing.T) {
	var received map[string]any
	var puts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/settings" || r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("unexpected request %s", r.URL)
		}
		if r.Method == http.MethodGet {
			_, _ = io.WriteString(w, `{"providers":[{"id":"p","apiKeyConfigured":true,"models":[]},{"id":"deleted","models":[]}]}`)
			return
		}
		if r.Method != http.MethodPut {
			t.Errorf("method=%s", r.Method)
		}
		puts++
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		http.Error(w, "persistence unavailable", http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	client, _ := New(srv.URL, "token", srv.Client())
	relay, _ := NewRelay(client, "kbrain", ModelRef{}, "")
	response, err := relay.SettingsUpdate(context.Background(), &gatewayv2.SettingsUpdateRequest{SettingsJson: `{"customProviders":[{"id":"p","apiKey":""}]}`})
	if err == nil || response != nil || puts != 1 {
		t.Fatalf("response=%v err=%v puts=%d", response, err, puts)
	}
	if !reflect.DeepEqual(received["deleteProviders"], []any{"deleted"}) {
		t.Fatalf("update=%v", received)
	}
	if _, err := relay.SettingsUpdate(context.Background(), &gatewayv2.SettingsUpdateRequest{SettingsJson: `{"theme":"dark","customProviders":[]}`}); err == nil || puts != 1 {
		t.Fatal("unsupported mixed update wrote settings")
	}
}

func TestProviderDiscoveryDraftPresenceAndFailureContracts(t *testing.T) {
	for _, tc := range []struct {
		name      string
		headers   *gatewayv2.ProviderCustomHeaders
		full      *bool
		status    int
		response  string
		wantError bool
	}{
		{"omitted overrides", nil, nil, 200, `{"models":[]}`, false},
		{"explicit empty overrides", &gatewayv2.ProviderCustomHeaders{}, new(bool), 200, `{"models":[]}`, false},
		{"headers", &gatewayv2.ProviderCustomHeaders{Headers: []*gatewayv2.ProviderCustomHeader{{Name: "X-Test", Value: "value"}}}, nil, 200, `{"models":[]}`, false},
		{"backend error", nil, nil, 502, `model discovery failed`, true},
		{"missing models", nil, nil, 200, `{}`, true},
		{"null models", nil, nil, 200, `{"models":null}`, true},
		{"missing ID", nil, nil, 200, `{"models":[{}]}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/v1/settings/providers/draft/models" || r.Header.Get("Authorization") != "Bearer token" {
					t.Errorf("unexpected discovery request %s %s", r.Method, r.URL)
				}
				var draft map[string]any
				if err := json.NewDecoder(r.Body).Decode(&draft); err != nil {
					t.Error(err)
				}
				if _, exists := draft["isFullUrl"]; exists != (tc.full != nil) {
					t.Error("lost full URL presence")
				}
				if _, exists := draft["customHeaders"]; exists != (tc.headers != nil) {
					t.Error("lost headers presence")
				}
				if tc.headers != nil && len(tc.headers.Headers) > 0 {
					header := draft["customHeaders"].([]any)[0].(map[string]any)
					if header["key"] != "X-Test" || header["value"] != "value" {
						t.Errorf("header=%v", header)
					}
				}
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.response)
			}))
			defer srv.Close()
			client, _ := New(srv.URL, "token", srv.Client())
			relay, _ := NewRelay(client, "kbrain", ModelRef{}, "")
			response, err := relay.ProviderModels(context.Background(), &gatewayv2.ProviderModelsRequest{ProviderType: "codex", BaseUrl: "https://draft.example/v1", CustomHeaders: tc.headers, IsFullUrl: tc.full})
			if (err != nil) != tc.wantError {
				t.Fatalf("response=%v err=%v", response, err)
			}
			if !tc.wantError && response.ModelsJson != "[]" {
				t.Fatalf("models=%s", response.ModelsJson)
			}
		})
	}
}

func TestSettingsReplacementClearsSelectedModelRemovedFromProvider(t *testing.T) {
	previous := json.RawMessage(`{"defaultProvider":"p","defaultModel":"old","providers":[{"id":"p","models":[{"id":"old"}]}]}`)
	translated, err := settingsUpdateForKBrain(json.RawMessage(`{"customProviders":[{"id":"p","models":[{"id":"new"}],"activeModels":["new"]}]}`), previous)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(translated, &got); err != nil {
		t.Fatal(err)
	}
	if got["defaultProvider"] != "" || got["defaultModel"] != "" {
		t.Fatalf("stale selected model was retained: %s", translated)
	}
}

func TestAIApprovalSettingsPassThrough(t *testing.T) {
	raw := json.RawMessage(`{"providers":[],"models":[],"aiApproval":{"mode":"auto","provider":"p","model":"small"}}`)
	projected, err := settingsProjectionForGateway(raw)
	if err != nil || !strings.Contains(string(projected), `"aiApproval":{"mode":"auto"`) {
		t.Fatalf("projection=%s err=%v", projected, err)
	}
	update, err := settingsUpdateForKBrain(json.RawMessage(`{"aiApproval":{"mode":"risk_only","provider":"p","model":"small"}}`))
	if err != nil || !strings.Contains(string(update), `"aiApproval"`) {
		t.Fatalf("update=%s err=%v", update, err)
	}
	if _, err := settingsUpdateForKBrain(json.RawMessage(`{"aiApproval":null}`)); err == nil {
		t.Fatal("accepted null")
	}
}
