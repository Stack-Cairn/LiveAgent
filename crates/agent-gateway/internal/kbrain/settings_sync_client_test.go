package kbrain

import (
	"encoding/json"
	"strings"
	"testing"
)

// The relay answers settings.get without an appliedClientSeqs table, so the WebUI
// never sends its syncClient marker here. Pin the reason: an unknown top-level
// field is rejected, which would fail the whole save if the WebUI ever sent one.
func TestRelaySettingsUpdateRejectsSyncClientMarker(t *testing.T) {
	_, err := settingsUpdateForKBrain(json.RawMessage(`{"selectedModel":null,"syncClient":{"id":"tab","seq":1}}`))
	if err == nil || !strings.Contains(err.Error(), `"syncClient"`) {
		t.Fatalf("relay must reject the marker it cannot acknowledge, got %v", err)
	}
}
