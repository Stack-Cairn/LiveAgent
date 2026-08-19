package stt

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// TestConfiguredDesktopProvidersLive is an opt-in diagnostic for real provider
// credentials. Normal test runs never access a user's desktop settings or the
// network; set LIVEAGENT_STT_LIVE_DB to an explicit config.sqlite path to run it.
func TestConfiguredDesktopProvidersLive(t *testing.T) {
	databasePath := os.Getenv("LIVEAGENT_STT_LIVE_DB")
	if databasePath == "" {
		t.Skip("set LIVEAGENT_STT_LIVE_DB to run real STT provider probes")
	}

	database, err := sql.Open("sqlite", "file:"+databasePath+"?mode=ro")
	if err != nil {
		t.Fatalf("open desktop STT settings: %v", err)
	}
	defer database.Close()

	var payload string
	if err := database.QueryRow(`SELECT payload_json FROM stt_settings WHERE config_id = 'default'`).Scan(&payload); err != nil {
		t.Fatalf("load desktop STT settings: %v", err)
	}
	var settings Settings
	if err := json.Unmarshal([]byte(payload), &settings); err != nil {
		t.Fatalf("decode desktop STT settings: %v", err)
	}

	tested := 0
	for _, providerID := range providerIDs {
		config := settings.Providers[providerID]
		if !configured(providerID, config) {
			continue
		}
		adapter := adapterFor(providerID)
		if adapter == nil {
			t.Fatalf("missing adapter for %s", providerID)
		}
		tested++
		t.Run(providerID, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			result, probeErr := adapter.Test(ctx, config)
			if probeErr != nil {
				t.Errorf("result=%s provider_message=%s", resultForError(probeErr), sanitizeError(probeErr.Error(), config))
				return
			}
			t.Logf("result=%s", result)
		})
	}
	if tested == 0 {
		t.Fatal("desktop STT settings contain no configured providers")
	}
}
