package kbrain

import (
	"encoding/json"
	"strings"
	"testing"
)

// Fourth review (2aa05c4e): the Go relay and the desktop agent's Rust bridge
// (services/gateway/kbrain_memory.rs) must agree on the kbrainMemory contract.
func TestReview4MemorySwitchContractMatchesDesktopBridge(t *testing.T) {
	// Rust take_switch_update accepts these and writes {"memory":{"enabled":X}}.
	for input, want := range map[string]string{
		`{"kbrainMemory":{"enabled":true}}`:            `{"memory":{"enabled":true}}`,
		`{"kbrainMemory":{"enabled":false,"extra":1}}`: `{"memory":{"enabled":false}}`,
	} {
		update, err := settingsUpdateForKBrain(json.RawMessage(input))
		if err != nil || string(update) != want {
			t.Fatalf("%s: got %s %v, want %s", input, update, err, want)
		}
	}
	// Rust rejects these with 400 before touching K-brain.
	for _, bad := range []string{`{"kbrainMemory":true}`, `{"kbrainMemory":{"enabled":null}}`, `{"kbrainMemory":[]}`, `{"kbrainMemory":{"enabled":1}}`} {
		if _, err := settingsUpdateForKBrain(json.RawMessage(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	// Rust switch_from_settings drops a non-boolean switch; Go passes the raw value
	// through, and the shared loadMemorySwitch treats both as "unsupported".
	projected, err := settingsProjectionForGateway(json.RawMessage(`{"providers":[],"memory":{"enabled":"no"}}`))
	if err != nil || !strings.Contains(string(projected), `"kbrainMemory":{"enabled":"no"}`) {
		t.Fatalf("projection: %s %v", projected, err)
	}
}
