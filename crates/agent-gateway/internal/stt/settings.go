package stt

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/liveagent/agent-gateway/internal/db"
)

var providerIDs = []string{"aliyun_dashscope", "tencent_cloud", "volcengine_v2", "volcengine_seed_v3", "baidu_cloud"}
var secretFields = []string{"apiKey", "secretId", "secretKey", "accessToken", "baiduApiKey"}

func providerDefaults(id string) map[string]any {
	provider := map[string]any{"id": id, "configured": false, "websocketUrl": "", "model": "", "apiKey": "", "appId": "", "secretId": "", "secretKey": "", "accessToken": "", "cluster": "", "resourceId": "", "engineModelType": "16k_zh", "baiduAppId": "", "baiduApiKey": "", "devPid": ""}
	switch id {
	case "aliyun_dashscope":
		provider["websocketUrl"] = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/"
		provider["model"] = "paraformer-realtime-v2"
	case "volcengine_v2":
		provider["websocketUrl"] = "wss://openspeech.bytedance.com/api/v2/asr"
	case "volcengine_seed_v3":
		provider["websocketUrl"] = volcengineSeedV3Endpoint
	case "baidu_cloud":
		provider["websocketUrl"] = "wss://vop.baidu.com/realtime_asr"
	}
	return provider
}

type Settings struct {
	Enabled         bool                      `json:"enabled"`
	Provider        *string                   `json:"provider"`
	Providers       map[string]map[string]any `json:"providers"`
	AllowIncomplete bool                      `json:"allowIncomplete,omitempty"`
}
type Store struct{ pool *sql.DB }

func NewStore(database *db.DB) (*Store, error) {
	if database == nil || !database.Enabled() {
		return nil, errors.New("gateway database is required")
	}
	s := &Store{pool: database.Pool()}
	_, err := s.pool.Exec(`CREATE TABLE IF NOT EXISTS stt_settings (config_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000))`)
	return s, err
}

func defaults() Settings {
	providers := map[string]map[string]any{}
	for _, id := range providerIDs {
		providers[id] = providerDefaults(id)
	}
	return Settings{Enabled: false, Providers: providers}
}

func (s *Store) raw(ctx context.Context) (Settings, error) {
	current := defaults()
	var payload string
	err := s.pool.QueryRowContext(ctx, `SELECT payload_json FROM stt_settings WHERE config_id='default'`).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return current, nil
	}
	if err != nil {
		return current, err
	}
	if err := json.Unmarshal([]byte(payload), &current); err != nil {
		return defaults(), err
	}
	if current.Providers == nil {
		current.Providers = map[string]map[string]any{}
	}
	for _, id := range providerIDs {
		normalized := providerDefaults(id)
		for key, value := range current.Providers[id] {
			normalized[key] = value
		}
		if id == "aliyun_dashscope" && normalized["model"] == "paraformer-realtime-8k-v2" {
			normalized["model"] = "paraformer-realtime-v2"
		}
		current.Providers[id] = normalized
	}
	return current, nil
}

func configured(id string, p map[string]any) bool {
	return validateProvider(id, p) == nil
}

func requiredProviderValue(p map[string]any, field, label string) (string, error) {
	value := strings.TrimSpace(stringValue(p, field))
	if value == "" {
		return "", errors.New(label + " is required")
	}
	return value, nil
}

func validateProviderWebSocket(p map[string]any) error {
	_, err := websocketEndpoint(p, "")
	return err
}

func requirePositiveProviderInteger(p map[string]any, field, label string) error {
	value, err := requiredProviderValue(p, field, label)
	if err != nil {
		return err
	}
	numeric, err := strconv.ParseUint(value, 10, 64)
	if err != nil || numeric == 0 {
		return errors.New(label + " must be a positive decimal integer")
	}
	return nil
}

func validateProvider(id string, p map[string]any) error {
	switch id {
	case "aliyun_dashscope":
		if err := validateProviderWebSocket(p); err != nil {
			return err
		}
		if _, err := requiredProviderValue(p, "model", "DashScope model"); err != nil {
			return err
		}
		_, err := requiredProviderValue(p, "apiKey", "DashScope API key")
		return err
	case "tencent_cloud":
		if err := requirePositiveProviderInteger(p, "appId", "Tencent AppId"); err != nil {
			return err
		}
		for _, item := range [][2]string{{"engineModelType", "Tencent engine model"}, {"secretId", "Tencent SecretId"}, {"secretKey", "Tencent SecretKey"}} {
			if _, err := requiredProviderValue(p, item[0], item[1]); err != nil {
				return err
			}
		}
		return nil
	case "volcengine_v2":
		if err := validateProviderWebSocket(p); err != nil {
			return err
		}
		for _, item := range [][2]string{{"appId", "Volcengine v2 App ID"}, {"cluster", "Volcengine v2 Cluster"}, {"accessToken", "Volcengine v2 Access Token"}} {
			if _, err := requiredProviderValue(p, item[0], item[1]); err != nil {
				return err
			}
		}
		return nil
	case "volcengine_seed_v3":
		if err := validateProviderWebSocket(p); err != nil {
			return err
		}
		for _, item := range [][2]string{{"appId", "Volcengine Seed v3 App ID"}, {"accessToken", "Volcengine Seed v3 Access Token"}, {"resourceId", "Volcengine Seed v3 Resource ID"}} {
			if _, err := requiredProviderValue(p, item[0], item[1]); err != nil {
				return err
			}
		}
		return nil
	case "baidu_cloud":
		if err := validateProviderWebSocket(p); err != nil {
			return err
		}
		if err := requirePositiveProviderInteger(p, "baiduAppId", "Baidu App ID"); err != nil {
			return err
		}
		if err := requirePositiveProviderInteger(p, "devPid", "Baidu dev_pid"); err != nil {
			return err
		}
		_, err := requiredProviderValue(p, "baiduApiKey", "Baidu API key")
		return err
	}
	return errors.New("unknown STT provider")
}

func stringValue(provider map[string]any, field string) string {
	value, _ := provider[field].(string)
	return value
}

func redact(settings Settings) Settings {
	settings.AllowIncomplete = false
	for id, provider := range settings.Providers {
		provider["configured"] = configured(id, provider)
		for _, field := range secretFields {
			provider[field] = ""
		}
		delete(provider, "clearSecrets")
	}
	return settings
}
func (s *Store) Get(ctx context.Context) (Settings, error) {
	current, err := s.raw(ctx)
	if err != nil {
		return current, err
	}
	return redact(current), nil
}

func (s *Store) Update(ctx context.Context, incoming Settings) (Settings, error) {
	current, err := s.raw(ctx)
	if err != nil {
		return Settings{}, err
	}
	if incoming.Providers == nil {
		return Settings{}, errors.New("providers are required")
	}
	selectedCleared := false
	for _, id := range providerIDs {
		next, ok := incoming.Providers[id]
		if !ok {
			next = current.Providers[id]
		}
		old := current.Providers[id]
		clear, _ := next["clearSecrets"].(bool)
		if incoming.Provider != nil && *incoming.Provider == id {
			selectedCleared = clear
		}
		delete(next, "clearSecrets")
		delete(next, "configured")
		for _, field := range secretFields {
			value, _ := next[field].(string)
			if clear {
				next[field] = ""
			} else if strings.TrimSpace(value) == "" {
				next[field] = old[field]
			} else {
				next[field] = strings.TrimSpace(value)
			}
		}
		next["id"] = id
		current.Providers[id] = next
	}
	if incoming.Provider != nil && !selectedCleared && !incoming.AllowIncomplete {
		provider, ok := current.Providers[*incoming.Provider]
		if !ok {
			return Settings{}, errors.New("selected STT provider is unknown")
		}
		if err := validateProvider(*incoming.Provider, provider); err != nil {
			return Settings{}, err
		}
	}
	current.Enabled = incoming.Enabled
	current.Provider = incoming.Provider
	current.AllowIncomplete = false
	payload, err := json.Marshal(current)
	if err != nil {
		return Settings{}, err
	}
	_, err = s.pool.ExecContext(ctx, `INSERT INTO stt_settings(config_id,payload_json,updated_at) VALUES('default',?,unixepoch('subsec')*1000) ON CONFLICT(config_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`, string(payload))
	if err != nil {
		return Settings{}, err
	}
	return redact(current), nil
}

// SyncFromDesktop replaces the Gateway runtime copy with the desktop's raw,
// authoritative STT settings. Unlike Update, blank secrets are real values
// here (including an explicit clear already consumed by the desktop store),
// so they must not preserve stale Gateway credentials.
func (s *Store) SyncFromDesktop(ctx context.Context, incoming Settings) (Settings, error) {
	if incoming.Providers == nil {
		return Settings{}, errors.New("providers are required")
	}
	next := defaults()
	if incoming.Provider != nil {
		if _, known := next.Providers[*incoming.Provider]; !known {
			return Settings{}, errors.New("selected STT provider is unknown")
		}
		provider := strings.TrimSpace(*incoming.Provider)
		incoming.Provider = &provider
	}
	for _, id := range providerIDs {
		provider := next.Providers[id]
		for key, value := range incoming.Providers[id] {
			provider[key] = value
		}
		provider["id"] = id
		delete(provider, "configured")
		delete(provider, "clearSecrets")
		for _, field := range secretFields {
			provider[field] = strings.TrimSpace(stringValue(provider, field))
		}
		next.Providers[id] = provider
	}
	next.Provider = incoming.Provider
	next.Enabled = incoming.Enabled
	next.AllowIncomplete = false
	payload, err := json.Marshal(next)
	if err != nil {
		return Settings{}, err
	}
	_, err = s.pool.ExecContext(ctx, `INSERT INTO stt_settings(config_id,payload_json,updated_at) VALUES('default',?,unixepoch('subsec')*1000) ON CONFLICT(config_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`, string(payload))
	if err != nil {
		return Settings{}, err
	}
	return redact(next), nil
}

func (s *Store) Provider(ctx context.Context, id string) (map[string]any, error) {
	current, err := s.raw(ctx)
	if err != nil {
		return nil, err
	}
	p, ok := current.Providers[id]
	if !ok || !configured(id, p) {
		return nil, errors.New("STT provider is not configured")
	}
	return p, nil
}
