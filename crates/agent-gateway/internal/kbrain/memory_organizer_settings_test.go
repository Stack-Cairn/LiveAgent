package kbrain

import (
	"encoding/json"
	"strings"
	"testing"
)

// The Go relay and the desktop agent's Rust bridge (services/gateway/kbrain_memory.rs)
// must agree on the kbrainMemoryOrganizer contract.
func TestMemoryOrganizerSettingsContractMatchesDesktopBridge(t *testing.T) {
	for input, want := range map[string]string{
		`{"kbrainMemoryOrganizer":{"enabled":false}}`:                     `{"memoryOrganizer":{"enabled":false}}`,
		`{"kbrainMemoryOrganizer":{"intervalHours":6,"extra":1}}`:         `{"memoryOrganizer":{"intervalHours":6}}`,
		`{"kbrainMemoryOrganizer":{"enabled":true,"intervalHours":1.5}}`:  `{"memoryOrganizer":{"enabled":true,"intervalHours":1.5}}`,
		`{"kbrainMemoryOrganizer":{"enabled":true,"intervalHours":null}}`: `{"memoryOrganizer":{"enabled":true}}`,
	} {
		update, err := settingsUpdateForKBrain(json.RawMessage(input))
		if err != nil || string(update) != want {
			t.Fatalf("%s: got %s %v, want %s", input, update, err, want)
		}
	}
	for _, bad := range []string{
		`{"kbrainMemoryOrganizer":true}`,
		`{"kbrainMemoryOrganizer":null}`,
		`{"kbrainMemoryOrganizer":{}}`,
		`{"kbrainMemoryOrganizer":[]}`,
		`{"kbrainMemoryOrganizer":{"enabled":1}}`,
		`{"kbrainMemoryOrganizer":{"intervalHours":"24"}}`,
	} {
		if _, err := settingsUpdateForKBrain(json.RawMessage(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	// The range is K-brain's to check: a value out of range is forwarded and refused there.
	if update, err := settingsUpdateForKBrain(json.RawMessage(`{"kbrainMemoryOrganizer":{"intervalHours":500}}`)); err != nil || string(update) != `{"memoryOrganizer":{"intervalHours":500}}` {
		t.Fatalf("out of range: %s %v", update, err)
	}

	projected, err := settingsProjectionForGateway(json.RawMessage(`{"providers":[],"memoryOrganizer":{"enabled":true,"intervalHours":24}}`))
	if err != nil || !strings.Contains(string(projected), `"kbrainMemoryOrganizer":{"enabled":true,"intervalHours":24}`) {
		t.Fatalf("projection: %s %v", projected, err)
	}
	legacy, err := settingsProjectionForGateway(json.RawMessage(`{"providers":[]}`))
	if err != nil || strings.Contains(string(legacy), "kbrainMemoryOrganizer") {
		t.Fatalf("older backend projection: %s %v", legacy, err)
	}
}
