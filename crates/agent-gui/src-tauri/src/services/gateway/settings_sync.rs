use std::collections::HashSet;

use serde_json::Value;
use uuid::Uuid;

use crate::commands::settings::{
    load_gateway_settings_sync_snapshot, load_stt_raw, open_db,
    redact_gateway_settings_sync_payload, PROVIDER_API_KEY_UPDATES_FIELD,
    PROVIDER_USAGE_QUERY_SECRET_UPDATES_FIELD, SSH_PATCH_FIELD, SSH_SECRET_UPDATES_FIELD,
    STT_SECRET_SYNC_FIELD, STT_SECRET_UPDATE_FIELD, SYSTEM_PROXY_PASSWORD_UPDATE_FIELD,
};

use super::*;

/// A cache read that keeps losing to newer stores gives up after this many tries.
const SETTINGS_READ_ATTEMPTS: usize = 3;

impl GatewayController {
    /// The current snapshot plus the stamp it must be published with.
    pub(crate) async fn current_settings_snapshot_stamped(
        &self,
    ) -> Result<(Value, SettingsSyncStamp), String> {
        let (snapshot, _backend, stamp) = self.settings_snapshot_and_backend().await?;
        Ok((snapshot, stamp))
    }

    /// The settings.get answer: the snapshot plus K-brain's memory switch, memory organizer
    /// schedule, AI approval reviewer and web search service taken from the same K-brain settings read, so a successful answer always
    /// carries them for a backend that has them. Neither is cached or synced as LiveAgent
    /// settings.
    pub(crate) async fn settings_get_snapshot(&self) -> Result<Value, String> {
        let (mut snapshot, backend, stamp) = self.settings_snapshot_and_backend().await?;
        if let Some(map) = snapshot.as_object_mut() {
            if let Some(switch) = super::kbrain_memory::switch_from_settings(&backend) {
                map.insert(
                    super::kbrain_memory::KBRAIN_MEMORY_FIELD.to_string(),
                    switch,
                );
            }
            if let Some(organizer) = super::kbrain_memory::organizer_from_settings(&backend) {
                map.insert(
                    super::kbrain_memory::KBRAIN_MEMORY_ORGANIZER_FIELD.to_string(),
                    organizer,
                );
            }
            if let Some(approval) = super::kbrain_ai_approval::approval_from_settings(&backend) {
                map.insert(
                    super::kbrain_ai_approval::AI_APPROVAL_FIELD.to_string(),
                    approval,
                );
            }
            if let Some(web_search) = super::kbrain_web_search::web_search_from_settings(&backend) {
                map.insert(
                    super::kbrain_web_search::KBRAIN_WEB_SEARCH_FIELD.to_string(),
                    web_search,
                );
            }
        }
        Ok(attach_settings_sync_stamp(snapshot, &stamp))
    }

    pub(crate) fn applied_client_seqs_value(&self) -> Value {
        self.applied_settings_client_seqs
            .lock()
            .map(|table| table.to_value())
            .unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
    }

    pub(crate) fn record_settings_sync_acks(&self, acks: &[SettingsSyncAck]) {
        if acks.is_empty() {
            return;
        }
        if let Ok(mut table) = self.applied_settings_client_seqs.lock() {
            for ack in acks {
                table.record(ack);
            }
        }
    }

    /// Assembles the snapshot from the cache, the settings DB and K-brain, and writes it
    /// back only if no newer snapshot was stored while it was being assembled; otherwise
    /// it reads again. The stamp names the cache generation the result belongs to.
    async fn settings_snapshot_and_backend(
        &self,
    ) -> Result<(Value, Value, SettingsSyncStamp), String> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            // Acks are recorded under the cache lock together with their snapshot (see
            // store_settings_snapshot_with_acks), so reading both under it yields acks
            // that the cached content already reflects, and none it does not.
            let (cached_snapshot, read_at, epoch, acks) = {
                let cache = self
                    .settings_snapshot
                    .lock()
                    .map_err(|_| "gateway settings snapshot lock poisoned".to_string())?;
                let acks = self.applied_client_seqs_value();
                (
                    cache.value.clone(),
                    cache.generation,
                    cache.epoch.clone(),
                    acks,
                )
            };

            let db_snapshot = tauri::async_runtime::spawn_blocking(move || {
                let conn = open_db()?;
                load_gateway_settings_sync_snapshot(&conn)
            })
            .await
            .map_err(|e| format!("load gateway settings snapshot join failed: {e}"))??;

            let mut snapshot = merge_settings_sync_snapshot(db_snapshot, cached_snapshot.as_ref())?;
            let backend =
                crate::services::gateway_bridge::kbrain_gateway_settings(self.app_handle.clone())
                    .await?;
            apply_kbrain_model_settings(&mut snapshot, &backend)?;
            let mcp = crate::services::gateway_bridge::kbrain_gateway_mcp_settings(
                self.app_handle.clone(),
            )
            .await?;
            apply_kbrain_mcp_settings(&mut snapshot, &mcp)?;
            let snapshot = prepare_settings_snapshot(snapshot)?;
            if let Some(generation) =
                self.store_prepared_snapshot(snapshot.clone(), Some(read_at))?
            {
                let stamp = SettingsSyncStamp {
                    acks,
                    epoch,
                    generation,
                };
                return Ok((snapshot, backend, stamp));
            }
            if attempt >= SETTINGS_READ_ATTEMPTS {
                // Stamped with the generation it was read at, so a WebUI that already
                // applied a newer snapshot discards it.
                let stamp = SettingsSyncStamp {
                    acks,
                    epoch,
                    generation: read_at,
                };
                return Ok((snapshot, backend, stamp));
            }
        }
    }

    /// Stores unconditionally and records `acks` in the same critical section, so no
    /// reader can see this snapshot without its acks or the acks without the snapshot.
    /// Lock order is cache, then ack table, everywhere both are held.
    pub(crate) fn store_settings_snapshot_with_acks(
        &self,
        payload: Value,
        acks: &[SettingsSyncAck],
    ) -> Result<(Value, SettingsSyncStamp), String> {
        let snapshot = prepare_settings_snapshot(payload)?;
        let mut cache = self
            .settings_snapshot
            .lock()
            .map_err(|_| "gateway settings snapshot lock poisoned".to_string())?;
        cache.store(snapshot.clone(), None);
        self.record_settings_sync_acks(acks);
        let stamp = SettingsSyncStamp {
            acks: self.applied_client_seqs_value(),
            epoch: cache.epoch.clone(),
            generation: cache.generation,
        };
        Ok((snapshot, stamp))
    }

    pub(crate) fn store_settings_snapshot(&self, payload: Value) -> Result<Value, String> {
        Ok(self.store_settings_snapshot_with_acks(payload, &[])?.0)
    }

    /// Stores a snapshot assembled from a cache read at `read_at`, unless a newer one
    /// was stored meanwhile. Returns whether it was stored.
    pub(crate) fn store_settings_snapshot_read_at(
        &self,
        payload: Value,
        read_at: u64,
    ) -> Result<bool, String> {
        let snapshot = prepare_settings_snapshot(payload)?;
        Ok(self
            .store_prepared_snapshot(snapshot, Some(read_at))?
            .is_some())
    }

    /// Stores `merged` (an update overlaid on the snapshot read at `read_at`); if a newer
    /// snapshot was stored meanwhile, overlays the update on that one instead.
    pub(crate) async fn store_merged_settings_update(
        &self,
        merged: Value,
        read_at: u64,
        update: &Value,
    ) -> Result<(), String> {
        if self.store_settings_snapshot_read_at(merged.clone(), read_at)? {
            return Ok(());
        }
        let mut last = merged;
        for _ in 1..SETTINGS_READ_ATTEMPTS {
            let (current, stamp) = self.current_settings_snapshot_stamped().await?;
            last = merge_settings_update_into_snapshot(current, update.clone())?;
            if self.store_settings_snapshot_read_at(last.clone(), stamp.generation)? {
                return Ok(());
            }
        }
        self.store_settings_snapshot(last).map(|_| ())
    }

    fn store_prepared_snapshot(
        &self,
        snapshot: Value,
        read_at: Option<u64>,
    ) -> Result<Option<u64>, String> {
        let mut cache = self
            .settings_snapshot
            .lock()
            .map_err(|_| "gateway settings snapshot lock poisoned".to_string())?;
        Ok(cache.store(snapshot, read_at).then_some(cache.generation))
    }
}

fn prepare_settings_snapshot(payload: Value) -> Result<Value, String> {
    let mut snapshot =
        redact_gateway_settings_sync_payload(normalize_settings_sync_payload(payload)?)?;
    // Sync bookkeeping is attached on the way out only, never cached as settings.
    if let Some(map) = snapshot.as_object_mut() {
        map.remove(APPLIED_CLIENT_SEQS_FIELD);
        map.remove(SETTINGS_SYNC_VERSION_FIELD);
        map.remove(SYNC_CLIENT_FIELD);
    }
    Ok(snapshot)
}

/// Cached settings snapshot. `generation` bumps on every store so a slow read can tell
/// whether it is still the latest; `epoch` is new for every desktop process, so a WebUI
/// can tell a restarted desktop (generation back to 1, ack table empty) from an old one.
#[derive(Debug)]
pub(crate) struct SettingsSnapshotCache {
    value: Option<Value>,
    generation: u64,
    epoch: String,
}

impl Default for SettingsSnapshotCache {
    fn default() -> Self {
        Self {
            value: None,
            generation: 0,
            epoch: Uuid::new_v4().to_string(),
        }
    }
}

impl SettingsSnapshotCache {
    pub(crate) fn store(&mut self, snapshot: Value, read_at: Option<u64>) -> bool {
        if read_at.is_some_and(|generation| generation != self.generation) {
            return false;
        }
        self.value = Some(snapshot);
        self.generation += 1;
        true
    }

    #[cfg(test)]
    pub(crate) fn value(&self) -> Option<&Value> {
        self.value.as_ref()
    }
}

/// What an outbound snapshot carries besides settings: the acks it reflects and the
/// cache generation (within this desktop process) it was read or stored at.
pub(crate) struct SettingsSyncStamp {
    pub(crate) acks: Value,
    pub(crate) epoch: String,
    pub(crate) generation: u64,
}

pub(crate) fn apply_kbrain_mcp_settings(
    snapshot: &mut Value,
    backend: &Value,
) -> Result<(), String> {
    let settings = backend
        .get("settings")
        .filter(|settings| settings.get("servers").is_some_and(Value::is_array))
        .ok_or_else(|| "K-brain MCP response is missing servers".to_string())?;
    snapshot["mcp"] = settings.clone();
    // Empty selections are omitted by the backend; never retain stale SQLite ids.
    if !snapshot["mcp"].get("selected").is_some_and(Value::is_array) {
        snapshot["mcp"]["selected"] = serde_json::json!([]);
    }
    Ok(())
}

pub(crate) fn apply_kbrain_model_settings(
    snapshot: &mut Value,
    backend: &Value,
) -> Result<(), String> {
    let providers = backend
        .get("providers")
        .and_then(Value::as_array)
        .ok_or_else(|| "K-brain settings response is missing providers".to_string())?;
    snapshot["customProviders"] = Value::Array(providers.clone());
    snapshot["selectedModel"] = match (
        backend
            .get("defaultProvider")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty()),
        backend
            .get("defaultModel")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty()),
    ) {
        (Some(provider), Some(model)) => {
            serde_json::json!({"customProviderId": provider, "model": model})
        }
        _ => Value::Null,
    };
    Ok(())
}

pub(crate) fn merge_settings_sync_snapshot(
    snapshot: Value,
    cached: Option<&Value>,
) -> Result<Value, String> {
    let mut merged = match snapshot {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };

    if let Some(Value::Object(cached_map)) = cached {
        for field in UI_ONLY_SETTINGS_SYNC_FIELDS {
            if let Some(value) = cached_map.get(*field) {
                merged.insert((*field).to_string(), value.clone());
            }
        }
    }

    Ok(Value::Object(merged))
}

pub(crate) fn merge_settings_update_into_snapshot(
    snapshot: Value,
    update: Value,
) -> Result<Value, String> {
    let mut merged = match snapshot {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };
    let update = match update {
        Value::Object(map) => map,
        _ => return Err("gateway settings update payload must be an object".to_string()),
    };

    for (field, value) in update {
        // Remote settings and automation snapshots are desktop-owned (loaded
        // from the local DB on every snapshot rebuild); never let a remote
        // client overwrite them. Automation edits go through the versioned
        // cron.manage apply protocol instead.
        if field == "remote"
            || field == "automationCron"
            || field == "automationHooks"
            || field == "hooks"
            || field == "cron"
        {
            continue;
        }
        merged.insert(field, value);
    }

    Ok(Value::Object(merged))
}

pub(crate) fn attach_stt_secret_sync(
    mut snapshot: Value,
    raw_stt: Option<Value>,
) -> Result<Value, String> {
    let settings = snapshot
        .as_object_mut()
        .ok_or_else(|| "gateway settings sync payload must be an object".to_string())?;
    settings.remove(STT_SECRET_SYNC_FIELD);
    if let Some(stt) = raw_stt {
        settings.insert(STT_SECRET_SYNC_FIELD.to_string(), stt);
    }
    Ok(snapshot)
}

pub(crate) async fn attach_current_stt_secret_sync(snapshot: Value) -> Result<Value, String> {
    let raw_stt = tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        load_stt_raw(&conn)
    })
    .await
    .map_err(|e| format!("load private STT sync join failed: {e}"))??;
    attach_stt_secret_sync(snapshot, raw_stt)
}

fn workspace_project_ids(
    payload: &Value,
    payload_label: &str,
) -> Result<Option<HashSet<String>>, String> {
    let map = payload
        .as_object()
        .ok_or_else(|| format!("{payload_label} must be an object"))?;
    let Some(system) = map.get("system") else {
        return Ok(None);
    };
    let system = system
        .as_object()
        .ok_or_else(|| format!("{payload_label}.system must be an object"))?;
    let Some(projects) = system.get("workspaceProjects") else {
        return Ok(None);
    };
    let projects = projects
        .as_array()
        .ok_or_else(|| format!("{payload_label}.system.workspaceProjects must be an array"))?;

    let mut ids = HashSet::with_capacity(projects.len());
    for project in projects {
        let id = project
            .as_object()
            .and_then(|item| item.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                format!(
                    "{payload_label}.system.workspaceProjects entries must include a non-empty id"
                )
            })?;
        ids.insert(id.to_string());
    }
    Ok(Some(ids))
}

pub(crate) fn removed_workspace_project_ids(
    current_snapshot: &Value,
    update: &Value,
) -> Result<Vec<String>, String> {
    let Some(updated_ids) = workspace_project_ids(update, "gateway settings update")? else {
        return Ok(Vec::new());
    };
    let current_ids =
        workspace_project_ids(current_snapshot, "current settings snapshot")?.unwrap_or_default();
    let mut removed = current_ids
        .difference(&updated_ids)
        .cloned()
        .collect::<Vec<_>>();
    removed.sort();
    Ok(removed)
}

pub(crate) fn build_settings_sync_envelope(payload: Value) -> Result<proto::AgentEnvelope, String> {
    Ok(proto::AgentEnvelope {
        request_id: format!("settings-sync-{}", Uuid::new_v4()),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::SettingsSync(
            proto::SettingsSyncEvent {
                settings_json: serialize_settings_sync_payload(&payload)?,
            },
        )),
    })
}

pub(crate) fn normalize_settings_sync_payload(payload: Value) -> Result<Value, String> {
    match payload {
        Value::Null => Ok(Value::Object(serde_json::Map::new())),
        Value::Object(_) => Ok(payload),
        _ => Err("gateway settings sync payload must be an object".to_string()),
    }
}

pub(crate) fn build_local_settings_update_event_payload(payload: Value) -> Result<Value, String> {
    let mut event = match payload {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };
    let provider_api_key_updates = event.remove(PROVIDER_API_KEY_UPDATES_FIELD);
    let provider_usage_query_secret_updates =
        event.remove(PROVIDER_USAGE_QUERY_SECRET_UPDATES_FIELD);
    let ssh_secret_updates = event.remove(SSH_SECRET_UPDATES_FIELD);
    let system_proxy_password_update = event.remove(SYSTEM_PROXY_PASSWORD_UPDATE_FIELD);
    let stt_secret_update = event.remove(STT_SECRET_UPDATE_FIELD);
    event.remove("remote");
    let mut public_event = match redact_gateway_settings_sync_payload(Value::Object(event))? {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };
    if let Some(updates) = provider_api_key_updates {
        public_event.insert(PROVIDER_API_KEY_UPDATES_FIELD.to_string(), updates);
    }
    if let Some(updates) = provider_usage_query_secret_updates {
        public_event.insert(
            PROVIDER_USAGE_QUERY_SECRET_UPDATES_FIELD.to_string(),
            updates,
        );
    }
    if let Some(updates) = ssh_secret_updates {
        public_event.insert(SSH_SECRET_UPDATES_FIELD.to_string(), updates);
    }
    if let Some(update) = system_proxy_password_update {
        public_event.insert(SYSTEM_PROXY_PASSWORD_UPDATE_FIELD.to_string(), update);
    }
    if let Some(update) = stt_secret_update {
        public_event.insert(STT_SECRET_UPDATE_FIELD.to_string(), update);
    }
    Ok(Value::Object(public_event))
}

pub(crate) fn build_local_settings_update_event_payload_with_ssh(
    payload: Value,
    ssh: Value,
) -> Result<Value, String> {
    let mut event = match payload {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };
    let provider_api_key_updates = event.remove(PROVIDER_API_KEY_UPDATES_FIELD);
    let provider_usage_query_secret_updates =
        event.remove(PROVIDER_USAGE_QUERY_SECRET_UPDATES_FIELD);
    let ssh_secret_updates = event.remove(SSH_SECRET_UPDATES_FIELD);
    let system_proxy_password_update = event.remove(SYSTEM_PROXY_PASSWORD_UPDATE_FIELD);
    let stt_secret_update = event.remove(STT_SECRET_UPDATE_FIELD);
    event.remove("remote");
    event.remove(SSH_PATCH_FIELD);
    event.insert("ssh".to_string(), ssh);
    let mut public_event = match redact_gateway_settings_sync_payload(Value::Object(event))? {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };
    if let Some(updates) = provider_api_key_updates {
        public_event.insert(PROVIDER_API_KEY_UPDATES_FIELD.to_string(), updates);
    }
    if let Some(updates) = provider_usage_query_secret_updates {
        public_event.insert(
            PROVIDER_USAGE_QUERY_SECRET_UPDATES_FIELD.to_string(),
            updates,
        );
    }
    if let Some(updates) = ssh_secret_updates {
        public_event.insert(SSH_SECRET_UPDATES_FIELD.to_string(), updates);
    }
    if let Some(update) = system_proxy_password_update {
        public_event.insert(SYSTEM_PROXY_PASSWORD_UPDATE_FIELD.to_string(), update);
    }
    if let Some(update) = stt_secret_update {
        public_event.insert(STT_SECRET_UPDATE_FIELD.to_string(), update);
    }
    Ok(Value::Object(public_event))
}

pub(crate) fn parse_settings_sync_payload(raw: &str) -> Result<Value, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    let payload = serde_json::from_str::<Value>(trimmed)
        .map_err(|e| format!("parse gateway settings sync payload failed: {e}"))?;
    normalize_settings_sync_payload(payload)
}

pub(crate) fn serialize_settings_sync_payload(payload: &Value) -> Result<String, String> {
    serde_json::to_string(payload)
        .map_err(|e| format!("serialize gateway settings sync payload failed: {e}"))
}

/// WebUI → desktop: which tab sent a settings update and its per-tab sequence.
pub(crate) const SYNC_CLIENT_FIELD: &str = "syncClient";
/// Desktop → WebUI: highest sequence handled per tab, attached to every snapshot.
pub(crate) const APPLIED_CLIENT_SEQS_FIELD: &str = "appliedClientSeqs";
/// Desktop → WebUI: `{ epoch, generation }` of the cached snapshot this one was read at.
pub(crate) const SETTINGS_SYNC_VERSION_FIELD: &str = "settingsSyncVersion";
const MAX_SYNC_CLIENT_ID_LEN: usize = 128;
const MAX_TRACKED_SYNC_CLIENTS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SettingsSyncClient {
    pub id: String,
    pub seq: u64,
}

/// One settings update the desktop finished handling (`error` when saving failed).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct SettingsSyncAck {
    pub id: String,
    pub seq: u64,
    #[serde(default)]
    pub error: Option<String>,
}

fn valid_sync_client_id(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= MAX_SYNC_CLIENT_ID_LEN
}

/// Every snapshot leaving the desktop carries the ack table, even when empty (its
/// presence tells the WebUI this desktop understands `syncClient` markers), and its
/// version, so the WebUI can discard a snapshot older than one it already applied.
pub(crate) fn attach_settings_sync_stamp(mut snapshot: Value, stamp: &SettingsSyncStamp) -> Value {
    if let Some(map) = snapshot.as_object_mut() {
        map.insert(APPLIED_CLIENT_SEQS_FIELD.to_string(), stamp.acks.clone());
        map.insert(
            SETTINGS_SYNC_VERSION_FIELD.to_string(),
            serde_json::json!({ "epoch": stamp.epoch, "generation": stamp.generation }),
        );
    }
    snapshot
}

/// Removes the WebUI marker (and any stray ack table) from an update so neither
/// is merged into settings.
pub(crate) fn take_settings_sync_client(
    payload: &mut Value,
) -> Result<Option<SettingsSyncClient>, String> {
    let Some(map) = payload.as_object_mut() else {
        return Ok(None);
    };
    map.remove(APPLIED_CLIENT_SEQS_FIELD);
    map.remove(SETTINGS_SYNC_VERSION_FIELD);
    let Some(raw) = map.remove(SYNC_CLIENT_FIELD) else {
        return Ok(None);
    };
    let client = serde_json::from_value::<SettingsSyncClient>(raw)
        .map_err(|error| format!("invalid settings sync client marker: {error}"))?;
    if !valid_sync_client_id(&client.id) || client.seq == 0 {
        return Err("invalid settings sync client marker".to_string());
    }
    Ok(Some(client))
}

/// Hands the marker to the desktop frontend with the update, so the ack is
/// published from the same ordered save chain as the resulting snapshot.
pub(crate) fn with_settings_sync_client(
    mut event_payload: Value,
    client: Option<&SettingsSyncClient>,
) -> Value {
    if let (Some(client), Some(map)) = (client, event_payload.as_object_mut()) {
        map.insert(
            SYNC_CLIENT_FIELD.to_string(),
            serde_json::json!({ "id": client.id, "seq": client.seq }),
        );
    }
    event_payload
}

/// Per-tab highest handled sequence. Kept per client so two WebUI tabs never
/// overwrite each other's acks; the least recently acknowledged tab is evicted.
#[derive(Debug, Default)]
pub(crate) struct AppliedClientSeqs {
    entries: Vec<(String, u64, Option<String>)>,
}

impl AppliedClientSeqs {
    pub(crate) fn record(&mut self, ack: &SettingsSyncAck) {
        if !valid_sync_client_id(&ack.id) || ack.seq == 0 {
            return;
        }
        let error = ack
            .error
            .as_ref()
            .map(|error| error.trim().to_string())
            .filter(|error| !error.is_empty());
        let mut entry = (ack.id.clone(), ack.seq, error);
        if let Some(position) = self.entries.iter().position(|(id, _, _)| *id == ack.id) {
            let existing = self.entries.remove(position);
            if existing.1 > ack.seq {
                entry = existing;
            }
        }
        self.entries.push(entry);
        if self.entries.len() > MAX_TRACKED_SYNC_CLIENTS {
            self.entries.remove(0);
        }
    }

    pub(crate) fn to_value(&self) -> Value {
        let mut map = serde_json::Map::new();
        for (id, seq, error) in &self.entries {
            let mut ack = serde_json::Map::new();
            ack.insert("seq".to_string(), Value::from(*seq));
            if let Some(error) = error {
                ack.insert("error".to_string(), Value::String(error.clone()));
            }
            map.insert(id.clone(), Value::Object(ack));
        }
        Value::Object(map)
    }
}
