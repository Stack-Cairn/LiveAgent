package session

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

const sttSecretSyncField = "sttSecretSync"

// SetSTTSettingsSyncHandler wires the trusted desktop-agent credential sync to
// the Gateway STT store. The private field is always removed before snapshots
// are cached or events are fanned out to browser subscribers.
func (m *Manager) SetSTTSettingsSyncHandler(
	handler func(context.Context, json.RawMessage) (any, error),
) {
	m.sttSettingsSync = handler
}

func (m *Manager) consumePrivateSTTSettings(event *gatewayv2.SettingsSyncEvent) *gatewayv2.SettingsSyncEvent {
	if event == nil {
		return nil
	}
	payload, ok := parseSettingsJSON(event.GetSettingsJson())
	if !ok {
		return event
	}
	private, exists := payload[sttSecretSyncField]
	if !exists {
		return event
	}
	// Delete first and on every path: private credentials must never enter a
	// browser-visible snapshot, including when persistence or decoding fails.
	delete(payload, sttSecretSyncField)
	if m.sttSettingsSync != nil {
		raw, err := json.Marshal(private)
		if err == nil {
			var redacted any
			redacted, err = m.sttSettingsSync(context.Background(), raw)
			if err == nil {
				payload["stt"] = redacted
			}
		}
		if err != nil {
			slog.Warn("sync desktop STT settings to gateway failed", "err", err)
		}
	}
	settingsJSON, err := json.Marshal(payload)
	if err != nil {
		// The parsed payload was valid JSON and deleting a map key cannot make it
		// unmarshalable in normal operation. Drop the event if that invariant is
		// ever violated rather than risk forwarding the original private field.
		slog.Error("sanitize STT settings sync payload failed", "err", err)
		return nil
	}
	return &gatewayv2.SettingsSyncEvent{SettingsJson: string(settingsJSON)}
}

func (m *Manager) SubscribeSettingsSync() (<-chan Tagged[*gatewayv2.SettingsSyncEvent], func()) {
	ch := make(chan Tagged[*gatewayv2.SettingsSyncEvent], 64)

	m.syncHub.settingsMu.Lock()
	subID := m.syncHub.nextSettingsSubID
	m.syncHub.nextSettingsSubID += 1
	m.syncHub.settingsSubscribers[subID] = ch
	m.syncHub.settingsMu.Unlock()

	cleanup := func() {
		m.syncHub.settingsMu.Lock()
		// Do not close the channel here: broadcastSettingsSync sends after
		// copying subscribers, so closing can race with an in-flight send.
		delete(m.syncHub.settingsSubscribers, subID)
		m.syncHub.settingsMu.Unlock()
	}

	return ch, cleanup
}

// settingsRemoteBool 读取目标 Agent settings 快照里 remote.<key> 的布尔门控；
// Agent 不存在或未同步过 settings 时一律 false（默认拒绝）。
func (m *Manager) settingsRemoteBool(agentID, key string) bool {
	entry := m.entryFor(agentID)
	if entry == nil {
		return false
	}
	entry.settingsSnapshotMu.RLock()
	defer entry.settingsSnapshotMu.RUnlock()

	remote, ok := entry.settingsSnapshot["remote"].(map[string]any)
	if !ok {
		return false
	}
	enabled, ok := remote[key].(bool)
	return ok && enabled
}

func (m *Manager) WebTerminalEnabled(agentID string) bool {
	return m.settingsRemoteBool(agentID, "enableWebTerminal")
}

func (m *Manager) WebSshTerminalEnabled(agentID string) bool {
	return m.settingsRemoteBool(agentID, "enableWebSshTerminal")
}

func (m *Manager) WebGitEnabled(agentID string) bool {
	return m.settingsRemoteBool(agentID, "enableWebGit")
}

// WebAutomationEnabled 门控远程 cron/hooks 管理（cron.manage 直通臂）。
// 与 terminal/git/tunnels 同款 fail-closed：Agent 不存在或未同步过设置时一律 false。
func (m *Manager) WebAutomationEnabled(agentID string) bool {
	return m.settingsRemoteBool(agentID, "enableWebAutomation")
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

func (m *Manager) ApplySettingsJSON(agentID, settingsJSON string) {
	payload, ok := parseSettingsJSON(settingsJSON)
	if !ok {
		return
	}
	entry := m.entryOrCreate(agentID)
	if entry == nil {
		return
	}
	entry.settingsSnapshotMu.Lock()
	if _, hasIncomingRemote := payload["remote"]; !hasIncomingRemote {
		if existingRemote, hasExistingRemote := entry.settingsSnapshot["remote"]; hasExistingRemote {
			payload["remote"] = existingRemote
		}
	}
	entry.settingsSnapshot = payload
	entry.settingsSnapshotMu.Unlock()
}

func (m *Manager) ApplySettingsJSONPreservingRemote(agentID, settingsJSON string) {
	payload, ok := parseSettingsJSON(settingsJSON)
	if !ok {
		return
	}
	entry := m.entryOrCreate(agentID)
	if entry == nil {
		return
	}
	entry.settingsSnapshotMu.Lock()
	if existingRemote, ok := entry.settingsSnapshot["remote"]; ok {
		payload["remote"] = existingRemote
	} else {
		delete(payload, "remote")
	}
	entry.settingsSnapshot = payload
	entry.settingsSnapshotMu.Unlock()
}

func (m *Manager) broadcastSettingsSync(agentID string, event *gatewayv2.SettingsSyncEvent) {
	event = m.consumePrivateSTTSettings(event)
	if event == nil {
		return
	}
	m.ApplySettingsJSON(agentID, event.GetSettingsJson())

	m.syncHub.settingsMu.Lock()
	subscribers := make([]chan Tagged[*gatewayv2.SettingsSyncEvent], 0, len(m.syncHub.settingsSubscribers))
	for _, ch := range m.syncHub.settingsSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.syncHub.settingsMu.Unlock()

	tagged := Tagged[*gatewayv2.SettingsSyncEvent]{AgentID: agentID, Event: event}
	for _, ch := range subscribers {
		select {
		case ch <- tagged:
		default:
		}
	}
}
