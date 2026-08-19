package session

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestSettingsSyncConsumesSTTSecretsBeforeBrowserBroadcast(t *testing.T) {
	manager := NewManager()
	var receivedSecret string
	manager.SetSTTSettingsSyncHandler(func(_ context.Context, raw json.RawMessage) (any, error) {
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			return nil, err
		}
		providers := payload["providers"].(map[string]any)
		aliyun := providers["aliyun_dashscope"].(map[string]any)
		receivedSecret = aliyun["apiKey"].(string)
		return map[string]any{
			"provider": "aliyun_dashscope",
			"providers": map[string]any{
				"aliyun_dashscope": map[string]any{
					"id":         "aliyun_dashscope",
					"configured": true,
					"apiKey":     "",
				},
			},
		}, nil
	})

	subscription, cleanup := manager.SubscribeSettingsSync()
	defer cleanup()
	manager.broadcastSettingsSync("desktop-a", &gatewayv2.SettingsSyncEvent{SettingsJson: `{
  "theme":"dark",
  "sttSecretSync":{
    "provider":"aliyun_dashscope",
    "providers":{"aliyun_dashscope":{"apiKey":"server-only-secret"}}
  }
}`})

	if receivedSecret != "server-only-secret" {
		t.Fatalf("private handler received secret %q", receivedSecret)
	}
	select {
	case tagged := <-subscription:
		var public map[string]any
		if err := json.Unmarshal([]byte(tagged.Event.GetSettingsJson()), &public); err != nil {
			t.Fatal(err)
		}
		if _, leaked := public[sttSecretSyncField]; leaked {
			t.Fatal("private STT field leaked to settings subscriber")
		}
		sttPayload := public["stt"].(map[string]any)
		provider := sttPayload["providers"].(map[string]any)["aliyun_dashscope"].(map[string]any)
		if provider["apiKey"] != "" || provider["configured"] != true {
			t.Fatalf("unexpected public STT payload: %#v", provider)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for settings broadcast")
	}
}
