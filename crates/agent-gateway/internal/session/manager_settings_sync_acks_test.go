package session

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// The WebUI only releases locally pending settings once the desktop's ack table
// names its seq, and discards snapshots older than one it applied by their
// version. Gateway re-serializes the snapshot when it strips the STT sidecar, so
// both must survive that round trip (and the plain path).
func TestSettingsSyncKeepsAppliedClientSeqsForBrowsers(t *testing.T) {
	manager := NewManager()
	manager.SetSTTSettingsSyncHandler(func(context.Context, json.RawMessage) (any, error) {
		return map[string]any{"provider": "aliyun_dashscope"}, nil
	})
	subscription, cleanup := manager.SubscribeSettingsSync()
	defer cleanup()

	for name, settingsJSON := range map[string]string{
		"with STT sidecar": `{"theme":"dark","appliedClientSeqs":{"tab-a":{"seq":3},"tab-b":{"seq":1,"error":"disk full"}},` +
			`"settingsSyncVersion":{"epoch":"desktop-1","generation":7},"sttSecretSync":{"provider":"aliyun_dashscope"}}`,
		"plain": `{"theme":"dark","appliedClientSeqs":{"tab-a":{"seq":3},"tab-b":{"seq":1,"error":"disk full"}},` +
			`"settingsSyncVersion":{"epoch":"desktop-1","generation":7}}`,
	} {
		t.Run(name, func(t *testing.T) {
			manager.broadcastSettingsSync("desktop-a", &gatewayv2.SettingsSyncEvent{SettingsJson: settingsJSON})
			select {
			case tagged := <-subscription:
				var public map[string]any
				if err := json.Unmarshal([]byte(tagged.Event.GetSettingsJson()), &public); err != nil {
					t.Fatal(err)
				}
				acks, ok := public["appliedClientSeqs"].(map[string]any)
				if !ok {
					t.Fatalf("ack table dropped from browser snapshot: %#v", public)
				}
				tabA := acks["tab-a"].(map[string]any)
				tabB := acks["tab-b"].(map[string]any)
				if tabA["seq"] != float64(3) || tabB["seq"] != float64(1) || tabB["error"] != "disk full" {
					t.Fatalf("unexpected ack table: %#v", acks)
				}
				version, ok := public["settingsSyncVersion"].(map[string]any)
				if !ok || version["epoch"] != "desktop-1" || version["generation"] != float64(7) {
					t.Fatalf("snapshot version dropped or changed: %#v", public["settingsSyncVersion"])
				}
				if _, leaked := public[sttSecretSyncField]; leaked {
					t.Fatal("private STT field leaked to settings subscriber")
				}
			case <-time.After(time.Second):
				t.Fatal("timed out waiting for settings broadcast")
			}
		})
	}
}
