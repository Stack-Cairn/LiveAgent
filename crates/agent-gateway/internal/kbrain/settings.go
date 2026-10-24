package kbrain

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Project backend-owned settings only; MCP is fetched from its resource route.
type gatewaySettingsProjection struct {
	AIApproval json.RawMessage `json:"aiApproval,omitempty"`
	Computer   json.RawMessage `json:"computer,omitempty"`
	// KBrainMemory is K-brain's memory master switch; WebUI's `memory` key is
	// LiveAgent's organizer settings, so the switch travels under its own name.
	KBrainMemory    json.RawMessage `json:"kbrainMemory,omitempty"`
	CustomProviders []any           `json:"customProviders"`
	SelectedModel   map[string]any  `json:"selectedModel"`
}

type kbrainSettingsDocument struct {
	AIApproval      json.RawMessage  `json:"aiApproval,omitempty"`
	Computer        json.RawMessage  `json:"computer,omitempty"`
	Memory          json.RawMessage  `json:"memory,omitempty"`
	DefaultModel    string           `json:"defaultModel"`
	DefaultProvider string           `json:"defaultProvider"`
	Providers       []kbrainProvider `json:"providers"`
	Models          []kbrainModel    `json:"models"`
}

type kbrainProvider struct {
	ID                   string         `json:"id"`
	Name                 string         `json:"name"`
	Type                 string         `json:"type,omitempty"`
	API                  string         `json:"api"`
	BaseURL              string         `json:"baseUrl"`
	IsFullURL            bool           `json:"isFullUrl,omitempty"`
	ModelsURL            string         `json:"modelsUrl,omitempty"`
	APIKeyConfigured     bool           `json:"apiKeyConfigured"`
	CustomHeaders        []any          `json:"customHeaders,omitempty"`
	ModelOrder           []string       `json:"modelOrder,omitempty"`
	ActiveModels         []string       `json:"activeModels"`
	RequestFormat        string         `json:"requestFormat,omitempty"`
	Reasoning            string         `json:"reasoning,omitempty"`
	PromptCachingEnabled *bool          `json:"promptCachingEnabled,omitempty"`
	PromptCacheHintMode  string         `json:"promptCacheHintMode,omitempty"`
	PromptCacheRetention string         `json:"promptCacheRetention,omitempty"`
	NativeWebSearch      bool           `json:"nativeWebSearchEnabled"`
	UseSystemProxy       bool           `json:"useSystemProxy,omitempty"`
	RetryPolicy          map[string]any `json:"retryPolicy,omitempty"`
	UsageQuery           map[string]any `json:"usageQuery,omitempty"`
	Metadata             map[string]any `json:"metadata,omitempty"`
	Models               []kbrainModel  `json:"models"`
}

type kbrainModel struct {
	Provider        string   `json:"provider"`
	ID              string   `json:"id"`
	Name            string   `json:"name,omitempty"`
	DisplayName     string   `json:"displayName,omitempty"`
	OwnedBy         string   `json:"ownedBy,omitempty"`
	LimitsSource    string   `json:"limitsSource,omitempty"`
	ContextWindow   int      `json:"contextWindow,omitempty"`
	MaxOutputTokens int      `json:"maxOutputTokens,omitempty"`
	MaxOutputToken  int      `json:"maxOutputToken,omitempty"`
	InputModalities []string `json:"inputModalities,omitempty"`
	Vision          bool     `json:"vision,omitempty"`
}

func providerType(provider kbrainProvider) string {
	switch provider.Type {
	case "codex", "claude_code", "gemini", "xai", "deepseek":
		return provider.Type
	}
	switch provider.API {
	case "anthropic-messages":
		return "claude_code"
	case "google-generative-ai":
		return "gemini"
	case "openai-completions", "openai-responses":
		return "codex"
	default:
		return "codex"
	}
}

func providerModel(provider kbrainProvider, model kbrainModel) map[string]any {
	if model.Provider == "" {
		model.Provider = provider.ID
	}
	if model.DisplayName == "" {
		model.DisplayName = model.Name
	}
	if model.DisplayName == "" {
		model.DisplayName = model.ID
	}
	if model.MaxOutputToken == 0 {
		model.MaxOutputToken = model.MaxOutputTokens
	}
	if model.LimitsSource == "" {
		model.LimitsSource = "provider"
	}
	out := map[string]any{
		"provider": model.Provider, "id": model.ID,
		"displayName": model.DisplayName, "ownedBy": model.OwnedBy,
		"limitsSource": model.LimitsSource, "contextWindow": model.ContextWindow,
		"maxOutputToken": model.MaxOutputToken,
	}
	if model.InputModalities != nil {
		out["inputModalities"] = model.InputModalities
	} else if model.Vision {
		out["inputModalities"] = []string{"text", "image"}
	}
	return out
}

func providerPayload(provider kbrainProvider) map[string]any {
	ptype := providerType(provider)
	if provider.Name == "" {
		provider.Name = provider.ID
	}
	if provider.CustomHeaders == nil {
		provider.CustomHeaders = []any{}
	}
	if provider.ModelOrder == nil {
		provider.ModelOrder = []string{}
	}
	models := make([]any, 0, len(provider.Models))
	for _, model := range provider.Models {
		models = append(models, providerModel(provider, model))
	}
	activeModels := provider.ActiveModels
	if activeModels == nil {
		activeModels = make([]string, 0, len(provider.Models))
		for _, model := range provider.Models {
			activeModels = append(activeModels, model.ID)
		}
	}
	requestFormat := provider.RequestFormat
	if requestFormat == "" && ptype == "codex" {
		if provider.API == "openai-completions" {
			requestFormat = "openai-completions"
		} else {
			requestFormat = "openai-responses"
		}
	}
	promptCaching := true
	if provider.PromptCachingEnabled != nil {
		promptCaching = *provider.PromptCachingEnabled
	}
	if ptype == "gemini" || ptype == "xai" || ptype == "deepseek" {
		promptCaching = false
	}
	return map[string]any{
		"id":                     provider.ID,
		"name":                   provider.Name,
		"type":                   ptype,
		"baseUrl":                provider.BaseURL,
		"isFullUrl":              provider.IsFullURL,
		"modelsUrl":              provider.ModelsURL,
		"apiKey":                 "",
		"apiKeyConfigured":       provider.APIKeyConfigured,
		"customHeaders":          provider.CustomHeaders,
		"modelOrder":             provider.ModelOrder,
		"models":                 models,
		"activeModels":           activeModels,
		"requestFormat":          requestFormat,
		"reasoning":              provider.Reasoning,
		"promptCachingEnabled":   promptCaching,
		"promptCacheHintMode":    provider.PromptCacheHintMode,
		"promptCacheRetention":   provider.PromptCacheRetention,
		"nativeWebSearchEnabled": provider.NativeWebSearch,
		"useSystemProxy":         provider.UseSystemProxy,
		"retryPolicy":            provider.RetryPolicy,
		"usageQuery":             provider.UsageQuery,
		"metadata":               provider.Metadata,
	}
}

func settingsProjectionForGateway(raw json.RawMessage) (json.RawMessage, error) {
	document, err := decodeSettingsDocument(raw)
	if err != nil {
		return nil, err
	}
	providers := make([]any, 0, len(document.Providers))
	providerTypeByID := make(map[string]string, len(document.Providers))
	for _, provider := range document.Providers {
		providers = append(providers, providerPayload(provider))
		providerTypeByID[provider.ID] = providerType(provider)
	}
	selected := map[string]any(nil)
	if document.DefaultProvider != "" || document.DefaultModel != "" {
		selected = map[string]any{
			"customProviderId": document.DefaultProvider,
			"model":            document.DefaultModel,
			"providerType":     providerTypeByID[document.DefaultProvider],
		}
	}
	return json.Marshal(gatewaySettingsProjection{CustomProviders: providers, SelectedModel: selected, Computer: document.Computer, AIApproval: document.AIApproval, KBrainMemory: document.Memory})
}

func decodeSettingsDocument(raw json.RawMessage) (kbrainSettingsDocument, error) {
	var document kbrainSettingsDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return document, fmt.Errorf("decode kbrain settings: %w", err)
	}
	if document.Providers == nil {
		return document, errors.New("kbrain settings must contain a providers array")
	}
	return document, nil
}

// customProviders is a replacement list in WebUI, but providers is an upsert
// list in K-brain. The current snapshot supplies removals and credential flags.
func settingsUpdateForKBrain(raw json.RawMessage, previous ...json.RawMessage) (json.RawMessage, error) {
	var input map[string]json.RawMessage
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, fmt.Errorf("decode Gateway settings update: %w", err)
	}
	if input == nil {
		return nil, errors.New("settings update must be an object")
	}
	for key := range input {
		switch key {
		case "selectedModel", "customProviders", "deleteProviders", "providerApiKeyUpdates", "providerUsageQuerySecretUpdates", "computer", "aiApproval", "mcp", "skills", "agents", "projectPrompts", "kbrainMemory":
		default:
			return nil, fmt.Errorf("unsupported Gateway settings field %q: non-provider settings persistence is unavailable", key)
		}
	}
	current := map[string]kbrainProvider{}
	previousDefaultProvider, previousDefaultModel := "", ""
	if len(previous) > 0 {
		document, err := decodeSettingsDocument(previous[0])
		if err != nil {
			return nil, err
		}
		previousDefaultProvider = document.DefaultProvider
		previousDefaultModel = document.DefaultModel
		for _, provider := range document.Providers {
			current[provider.ID] = provider
		}
	}
	update := map[string]any{}
	if value, ok := input["aiApproval"]; ok {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(value, &object); err != nil || object == nil {
			return nil, errors.New("aiApproval must be an object")
		}
		update["aiApproval"] = value
	}
	if computer, ok := input["computer"]; ok {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(computer, &object); err != nil || object == nil {
			return nil, errors.New("computer must be an object")
		}
		update["computer"] = computer
	}
	if memory, ok := input["kbrainMemory"]; ok {
		var object struct {
			Enabled *bool `json:"enabled"`
		}
		if err := json.Unmarshal(memory, &object); err != nil || object.Enabled == nil {
			return nil, errors.New("kbrainMemory must be an object with boolean enabled")
		}
		update["memory"] = map[string]bool{"enabled": *object.Enabled}
	}
	if selectedRaw, ok := input["selectedModel"]; ok {
		var selected map[string]json.RawMessage
		if err := json.Unmarshal(selectedRaw, &selected); err != nil {
			return nil, fmt.Errorf("selectedModel must be an object or null: %w", err)
		}
		if selected == nil {
			update["defaultProvider"], update["defaultModel"] = "", ""
		} else {
			for key := range selected {
				if key != "customProviderId" && key != "model" && key != "providerType" {
					return nil, fmt.Errorf("unsupported selectedModel field %q", key)
				}
			}
			for source, target := range map[string]string{"customProviderId": "defaultProvider", "model": "defaultModel"} {
				rawValue, present := selected[source]
				if !present {
					continue
				}
				var value string
				if err := json.Unmarshal(rawValue, &value); err != nil || strings.TrimSpace(value) == "" {
					return nil, fmt.Errorf("selectedModel.%s must be a non-empty string", source)
				}
				update[target] = strings.TrimSpace(value)
			}
		}
	}
	providers := []map[string]any{}
	byID := map[string]map[string]any{}
	if providersRaw, ok := input["customProviders"]; ok {
		var items []map[string]json.RawMessage
		if err := json.Unmarshal(providersRaw, &items); err != nil || items == nil {
			return nil, errors.New("customProviders must be an array")
		}
		for _, item := range items {
			provider, err := kbrainProviderUpdate(item)
			if err != nil {
				return nil, err
			}
			id := provider["id"].(string)
			if byID[id] != nil {
				return nil, fmt.Errorf("duplicate provider ID %q", id)
			}
			byID[id] = provider
			providers = append(providers, provider)
		}
		update["providers"] = providers
	}
	deleted := []string{}
	deletedSet := map[string]bool{}
	if deletedRaw, ok := input["deleteProviders"]; ok {
		if err := json.Unmarshal(deletedRaw, &deleted); err != nil || deleted == nil {
			return nil, errors.New("deleteProviders must be an array of strings")
		}
		for _, id := range deleted {
			if id == "" || strings.TrimSpace(id) != id || deletedSet[id] || byID[id] != nil {
				return nil, errors.New("deleteProviders must contain unique IDs absent from customProviders")
			}
			deletedSet[id] = true
		}
	}
	if _, replace := input["customProviders"]; replace {
		for id := range current {
			if byID[id] == nil && !deletedSet[id] {
				deleted = append(deleted, id)
				deletedSet[id] = true
			}
		}
	}
	if len(deleted) > 0 {
		sort.Strings(deleted)
		update["deleteProviders"] = deleted
	}
	if sidecarRaw, ok := input["providerApiKeyUpdates"]; ok {
		var sidecar map[string]string
		if err := json.Unmarshal(sidecarRaw, &sidecar); err != nil || sidecar == nil {
			return nil, errors.New("providerApiKeyUpdates must be an object of strings")
		}
		for id, key := range sidecar {
			provider := byID[id]
			if provider == nil {
				return nil, fmt.Errorf("providerApiKeyUpdates references provider %q absent from customProviders", id)
			}
			if key = strings.TrimSpace(key); key != "" {
				provider["apiKey"] = key
			}
		}
	}
	for id, provider := range byID {
		key, _ := provider["apiKey"].(string)
		if provider["clearApiKey"] == true && key != "" {
			return nil, errors.New("cannot replace and clear an API key together")
		}
		if provider["apiKeyConfigured"] == false && current[id].APIKeyConfigured && key == "" {
			provider["clearApiKey"] = true
		}
		delete(provider, "apiKeyConfigured")
	}
	// A provider replacement can remove the model currently selected in the
	// K-brain config. Clear that stale default in the same write instead of
	// leaving a session that fails with "unknown model" on the next open.
	if _, replacingProviders := input["customProviders"]; replacingProviders {
		selectedProvider, selectedModel := previousDefaultProvider, previousDefaultModel
		if value, ok := update["defaultProvider"].(string); ok {
			selectedProvider = value
		}
		if value, ok := update["defaultModel"].(string); ok {
			selectedModel = value
		}
		provider := byID[selectedProvider]
		valid := provider != nil && providerModelPresent(provider, selectedModel)
		if !valid {
			update["defaultProvider"], update["defaultModel"] = "", ""
		}
	}

	if usageRaw, ok := input["providerUsageQuerySecretUpdates"]; ok {
		var usage map[string]map[string]string
		if err := json.Unmarshal(usageRaw, &usage); err != nil || usage == nil {
			return nil, errors.New("providerUsageQuerySecretUpdates must be an object")
		}
		for id, secrets := range usage {
			provider := byID[id]
			if provider == nil || secrets == nil {
				return nil, fmt.Errorf("invalid usage secret update for provider %q", id)
			}
			query, _ := provider["usageQuery"].(map[string]any)
			if query == nil {
				query = map[string]any{}
				for key, value := range current[id].UsageQuery {
					query[key] = value
				}
			}
			for key, value := range secrets {
				switch key {
				case "apiKey", "accessToken", "secretAccessKey":
					query[key] = value
					query[key+"Configured"] = strings.TrimSpace(value) != ""
				default:
					return nil, fmt.Errorf("unsupported usage secret field %q", key)
				}
			}
			provider["usageQuery"] = query
		}
	}
	if len(update) == 0 {
		_, mcp := input["mcp"]
		_, skills := input["skills"]
		_, agents := input["agents"]
		_, projects := input["projectPrompts"]
		if !mcp && !skills && !agents && !projects {
			return nil, errors.New("settings update contains no supported changes")
		}
	}
	return json.Marshal(update)
}

func gatewayMCPSettings(raw json.RawMessage) (json.RawMessage, error) {
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(raw, &settings); err != nil || settings == nil {
		return nil, errors.New("MCP settings must be an object")
	}
	var servers []map[string]json.RawMessage
	if err := json.Unmarshal(settings["servers"], &servers); err != nil || servers == nil {
		return nil, errors.New("MCP settings must contain a servers array")
	}
	for _, server := range servers {
		if server == nil {
			return nil, errors.New("MCP server must be an object")
		}
		var transport string
		_ = json.Unmarshal(server["transport"], &transport)
		if transport == "sse" {
			server["transport"] = json.RawMessage(`"http"`)
		}
	}
	settings["servers"], _ = json.Marshal(servers)
	return json.Marshal(settings)
}

func providerModelPresent(provider map[string]any, modelID string) bool {
	if strings.TrimSpace(modelID) == "" {
		return false
	}
	models, ok := provider["models"].([]any)
	if !ok {
		return false
	}
	known := false
	for _, item := range models {
		model, ok := item.(map[string]any)
		if ok && asString(model["id"]) == modelID {
			known = true
			break
		}
	}
	if !known {
		return false
	}
	active, present := provider["activeModels"]
	if !present {
		return true
	}
	items, ok := active.([]any)
	if !ok {
		return false
	}
	for _, item := range items {
		if asString(item) == modelID {
			return true
		}
	}
	return false
}

func kbrainProviderUpdate(provider map[string]json.RawMessage) (map[string]any, error) {
	out := map[string]any{}
	allowed := []string{"id", "name", "type", "api", "baseUrl", "apiKey", "apiKeyConfigured", "clearApiKey", "models", "activeModels", "modelOrder", "modelsUrl", "isFullUrl", "customHeaders", "requestFormat", "reasoning", "promptCachingEnabled", "promptCacheHintMode", "promptCacheRetention", "nativeWebSearchEnabled", "useSystemProxy", "retryPolicy", "usageQuery", "metadata"}
	allowedSet := map[string]bool{}
	for _, key := range allowed {
		allowedSet[key] = true
	}
	for key, value := range provider {
		if !allowedSet[key] {
			return nil, fmt.Errorf("unsupported provider field %q", key)
		}
		var decoded any
		if err := json.Unmarshal(value, &decoded); err != nil {
			return nil, fmt.Errorf("invalid provider field %q: %w", key, err)
		}
		out[key] = decoded
	}
	id, _ := out["id"].(string)
	if id == "" || strings.TrimSpace(id) != id {
		return nil, errors.New("provider id must be non-empty without surrounding whitespace")
	}
	for _, key := range []string{"type", "api", "requestFormat", "apiKey"} {
		if value, exists := out[key]; exists {
			text, ok := value.(string)
			if !ok {
				return nil, fmt.Errorf("provider %s must be a string", key)
			}
			out[key] = strings.TrimSpace(text)
		}
	}
	for _, key := range []string{"apiKeyConfigured", "clearApiKey"} {
		if value, exists := out[key]; exists {
			if _, ok := value.(bool); !ok {
				return nil, fmt.Errorf("provider %s must be a boolean", key)
			}
		}
	}
	ptype, format := asString(out["type"]), asString(out["requestFormat"])
	if format != "" && format != "openai-completions" && format != "openai-responses" {
		return nil, errors.New("unsupported provider requestFormat")
	}
	if ptype != "" {
		switch ptype {
		case "codex", "claude_code", "gemini", "xai", "deepseek":
		default:
			return nil, errors.New("unsupported provider type")
		}
		api := apiForProviderType(ptype, format)
		if explicit := asString(out["api"]); explicit != "" && explicit != api {
			return nil, errors.New("provider api conflicts with type/requestFormat")
		}
		out["api"] = api
	} else if format != "" {
		out["api"] = format
	}
	if key, exists := out["apiKey"]; exists && key == "" {
		delete(out, "apiKey")
	}
	if value, exists := out["models"]; exists {
		models, ok := value.([]any)
		if !ok {
			return nil, errors.New("provider models must be an array")
		}
		filtered := make([]any, 0, len(models))
		modelIDs := map[string]bool{}
		modelFields := map[string]bool{
			"id": true, "name": true, "displayName": true, "ownedBy": true,
			"limitsSource": true, "contextWindow": true, "maxOutputTokens": true,
			"maxOutputToken": true, "inputModalities": true, "vision": true,
		}
		for _, item := range models {
			model, ok := item.(map[string]any)
			if !ok {
				return nil, errors.New("provider models must be objects")
			}
			id, _ := model["id"].(string)
			if strings.TrimSpace(id) == "" || modelIDs[id] {
				return nil, errors.New("provider models require unique non-empty IDs")
			}
			modelIDs[id] = true
			clean := make(map[string]any, len(model))
			for key, value := range model {
				if modelFields[key] {
					clean[key] = value
				}
			}
			// WebUI edits the singular field; do not let an old alias override it.
			if value, ok := clean["maxOutputToken"]; ok {
				clean["maxOutputTokens"] = value
			}
			filtered = append(filtered, clean)
		}
		out["models"] = filtered
	}
	for _, field := range []string{"activeModels", "modelOrder"} {
		if value, exists := out[field]; exists {
			items, ok := value.([]any)
			if !ok {
				return nil, fmt.Errorf("provider %s must be an array of strings", field)
			}
			for _, item := range items {
				if _, ok := item.(string); !ok {
					return nil, fmt.Errorf("provider %s must be an array of strings", field)
				}
			}
		}
	}
	return out, nil
}

func asString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func apiForProviderType(providerType, requestFormat string) string {
	switch providerType {
	case "claude_code":
		return "anthropic-messages"
	case "gemini":
		return "google-generative-ai"
	case "deepseek":
		return "openai-completions"
	case "xai":
		return "openai-responses"
	default:
		if requestFormat != "" {
			return requestFormat
		}
		return "openai-responses"
	}
}
