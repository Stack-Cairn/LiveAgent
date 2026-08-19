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

impl GatewayController {
    pub(crate) async fn current_settings_snapshot(&self) -> Result<Value, String> {
        let cached_snapshot = self
            .settings_snapshot
            .lock()
            .map_err(|_| "gateway settings snapshot lock poisoned".to_string())?
            .clone();

        let db_snapshot = tauri::async_runtime::spawn_blocking(move || {
            let conn = open_db()?;
            load_gateway_settings_sync_snapshot(&conn)
        })
        .await
        .map_err(|e| format!("load gateway settings snapshot join failed: {e}"))??;

        let snapshot = merge_settings_sync_snapshot(db_snapshot, cached_snapshot.as_ref())?;
        self.store_settings_snapshot(snapshot)
    }

    pub(crate) fn store_settings_snapshot(&self, payload: Value) -> Result<Value, String> {
        let snapshot =
            redact_gateway_settings_sync_payload(normalize_settings_sync_payload(payload)?)?;
        let mut guard = self
            .settings_snapshot
            .lock()
            .map_err(|_| "gateway settings snapshot lock poisoned".to_string())?;
        *guard = Some(snapshot.clone());
        Ok(snapshot)
    }
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
