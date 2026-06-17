package session

import (
	"encoding/json"
	"strings"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (m *Manager) SubscribeSettingsSync() (<-chan *gatewayv1.SettingsSyncEvent, func()) {
	ch := make(chan *gatewayv1.SettingsSyncEvent, 32)

	m.syncHub.settingsMu.Lock()
	subID := m.syncHub.nextSettingsSubID
	m.syncHub.nextSettingsSubID += 1
	m.syncHub.settingsSubscribers[subID] = ch
	m.syncHub.settingsMu.Unlock()

	cleanup := func() {
		m.syncHub.settingsMu.Lock()
		if _, ok := m.syncHub.settingsSubscribers[subID]; ok {
			// Do not close the channel here: broadcastSettingsSync sends after
			// copying subscribers, so closing can race with an in-flight send.
			delete(m.syncHub.settingsSubscribers, subID)
		}
		m.syncHub.settingsMu.Unlock()
	}

	return ch, cleanup
}

func (m *Manager) WebTerminalEnabled() bool {
	m.syncHub.settingsSnapshotMu.RLock()
	defer m.syncHub.settingsSnapshotMu.RUnlock()

	remote, ok := m.syncHub.settingsSnapshot["remote"].(map[string]any)
	if !ok {
		return false
	}
	enabled, ok := remote["enableWebTerminal"].(bool)
	return ok && enabled
}

func (m *Manager) WebSshTerminalEnabled() bool {
	m.syncHub.settingsSnapshotMu.RLock()
	defer m.syncHub.settingsSnapshotMu.RUnlock()

	remote, ok := m.syncHub.settingsSnapshot["remote"].(map[string]any)
	if !ok {
		return false
	}
	enabled, ok := remote["enableWebSshTerminal"].(bool)
	return ok && enabled
}

func (m *Manager) WebGitEnabled() bool {
	m.syncHub.settingsSnapshotMu.RLock()
	defer m.syncHub.settingsSnapshotMu.RUnlock()

	remote, ok := m.syncHub.settingsSnapshot["remote"].(map[string]any)
	if !ok {
		return false
	}
	enabled, ok := remote["enableWebGit"].(bool)
	return ok && enabled
}

func (m *Manager) updateSettingsSnapshot(event *gatewayv1.SettingsSyncEvent) {
	if event == nil {
		return
	}
	m.ApplySettingsJSON(event.GetSettingsJson())
}

func parseSettingsJSON(settingsJSON string) (map[string]any, bool) {
	raw := strings.TrimSpace(settingsJSON)
	if raw == "" {
		return nil, false
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil || payload == nil {
		return nil, false
	}
	return payload, true
}

func (m *Manager) ApplySettingsJSON(settingsJSON string) {
	payload, ok := parseSettingsJSON(settingsJSON)
	if !ok {
		return
	}
	m.syncHub.settingsSnapshotMu.Lock()
	if _, hasIncomingRemote := payload["remote"]; !hasIncomingRemote {
		if existingRemote, hasExistingRemote := m.syncHub.settingsSnapshot["remote"]; hasExistingRemote {
			payload["remote"] = existingRemote
		}
	}
	m.syncHub.settingsSnapshot = payload
	m.syncHub.settingsSnapshotMu.Unlock()
}

func (m *Manager) ApplySettingsJSONPreservingRemote(settingsJSON string) {
	payload, ok := parseSettingsJSON(settingsJSON)
	if !ok {
		return
	}
	m.syncHub.settingsSnapshotMu.Lock()
	if existingRemote, ok := m.syncHub.settingsSnapshot["remote"]; ok {
		payload["remote"] = existingRemote
	} else {
		delete(payload, "remote")
	}
	m.syncHub.settingsSnapshot = payload
	m.syncHub.settingsSnapshotMu.Unlock()
}

func (m *Manager) broadcastSettingsSync(event *gatewayv1.SettingsSyncEvent) {
	if event == nil {
		return
	}
	m.updateSettingsSnapshot(event)

	m.syncHub.settingsMu.Lock()
	subscribers := make([]chan *gatewayv1.SettingsSyncEvent, 0, len(m.syncHub.settingsSubscribers))
	for _, ch := range m.syncHub.settingsSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.syncHub.settingsMu.Unlock()

	for _, ch := range subscribers {
		select {
		case ch <- event:
		default:
		}
	}
}
