//! K-brain's memory master switch over the desktop-owned Gateway. The WebUI reads and
//! writes it as `kbrainMemory` (its `memory` key is LiveAgent's organizer settings); the
//! value lives in K-brain's `/v1/settings`, never in LiveAgent's own settings. K-brain's
//! memory organizer schedule travels the same way as `kbrainMemoryOrganizer`.

use std::sync::Arc;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::AUTHORIZATION;
use serde_json::{json, Value};
use tauri::Manager as _;

use crate::services::kbrain_backend::{KBrainBackendConnection, KBrainBackendState};

pub(crate) const KBRAIN_MEMORY_FIELD: &str = "kbrainMemory";
pub(crate) const KBRAIN_MEMORY_ORGANIZER_FIELD: &str = "kbrainMemoryOrganizer";

/// The running K-brain, without starting one.
pub(crate) fn running_kbrain(app: &tauri::AppHandle) -> Option<KBrainBackendConnection> {
    app.try_state::<Arc<KBrainBackendState>>()?
        .running_connection()
}

/// The switch from a K-brain settings document; None for a backend without it.
pub(crate) fn switch_from_settings(settings: &Value) -> Option<Value> {
    let enabled = settings.get("memory")?.get("enabled")?.as_bool()?;
    Some(json!({ "enabled": enabled }))
}

/// Removes `kbrainMemory` from a WebUI settings update and returns the requested state.
pub(crate) fn take_switch_update(update: &mut Value) -> Result<Option<bool>, String> {
    let Some(map) = update.as_object_mut() else {
        return Ok(None);
    };
    let Some(value) = map.remove(KBRAIN_MEMORY_FIELD) else {
        return Ok(None);
    };
    value
        .get("enabled")
        .and_then(Value::as_bool)
        .map(Some)
        .ok_or_else(|| "kbrainMemory must be an object with boolean enabled".to_string())
}

/// The organizer schedule from a K-brain settings document; None for a backend without it.
pub(crate) fn organizer_from_settings(settings: &Value) -> Option<Value> {
    let organizer = settings.get("memoryOrganizer")?;
    let enabled = organizer.get("enabled")?.as_bool()?;
    let interval_hours = organizer.get("intervalHours")?.as_f64()?;
    Some(json!({ "enabled": enabled, "intervalHours": interval_hours }))
}

/// Removes `kbrainMemoryOrganizer` from a WebUI settings update and returns the
/// K-brain `memoryOrganizer` update: `enabled` and/or `intervalHours`, which K-brain
/// validates (1 to 168 hours).
pub(crate) fn take_organizer_update(update: &mut Value) -> Result<Option<Value>, String> {
    const INVALID: &str =
        "kbrainMemoryOrganizer must be an object with boolean enabled and/or numeric intervalHours";
    let Some(map) = update.as_object_mut() else {
        return Ok(None);
    };
    let Some(value) = map.remove(KBRAIN_MEMORY_ORGANIZER_FIELD) else {
        return Ok(None);
    };
    let object = value.as_object().ok_or_else(|| INVALID.to_string())?;
    let mut out = serde_json::Map::new();
    // null counts as absent, as in the Gateway relay (settings.go memoryOrganizerUpdate).
    if let Some(enabled) = object.get("enabled").filter(|value| !value.is_null()) {
        out.insert(
            "enabled".to_string(),
            Value::Bool(enabled.as_bool().ok_or_else(|| INVALID.to_string())?),
        );
    }
    if let Some(hours) = object.get("intervalHours").filter(|value| !value.is_null()) {
        if !hours.is_number() {
            return Err(INVALID.to_string());
        }
        out.insert("intervalHours".to_string(), hours.clone());
    }
    if out.is_empty() {
        return Err(INVALID.to_string());
    }
    Ok(Some(Value::Object(out)))
}

pub(super) fn client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("failed to create K-brain client: {error}"))
}

pub(crate) fn write_switch(
    connection: &KBrainBackendConnection,
    enabled: bool,
) -> Result<(), String> {
    client()?
        .put(format!("{}/v1/settings", connection.base_url))
        .header(AUTHORIZATION, format!("Bearer {}", connection.token))
        .json(&json!({ "memory": { "enabled": enabled } }))
        .send()
        .and_then(|response| response.error_for_status())
        .map(|_| ())
        .map_err(|error| format!("save K-brain memory switch failed: {}", error.without_url()))
}

pub(crate) fn write_organizer(
    connection: &KBrainBackendConnection,
    organizer: &Value,
) -> Result<(), String> {
    let response = client()?
        .put(format!("{}/v1/settings", connection.base_url))
        .header(AUTHORIZATION, format!("Bearer {}", connection.token))
        .json(&json!({ "memoryOrganizer": organizer }))
        .send()
        .map_err(|error| {
            format!(
                "save K-brain memory organizer schedule failed: {}",
                error.without_url()
            )
        })?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    // K-brain answers {"error": "..."} (for example an interval out of range).
    let body = response.text().unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| value.get("error")?.as_str().map(str::to_string))
        .unwrap_or(body);
    Err(format!(
        "save K-brain memory organizer schedule failed ({status}): {}",
        message.trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_is_read_only_from_a_backend_that_reports_it() {
        assert_eq!(
            switch_from_settings(&json!({ "memory": { "enabled": false } })),
            Some(json!({ "enabled": false }))
        );
        assert_eq!(switch_from_settings(&json!({ "providers": [] })), None);
        assert_eq!(
            switch_from_settings(&json!({ "memory": { "enabled": "no" } })),
            None
        );
    }

    #[test]
    fn switch_update_is_taken_out_of_the_liveagent_settings_update() {
        let mut update = json!({ "kbrainMemory": { "enabled": false }, "theme": "dark" });
        assert_eq!(take_switch_update(&mut update), Ok(Some(false)));
        assert_eq!(update, json!({ "theme": "dark" }));

        let mut untouched = json!({ "theme": "dark" });
        assert_eq!(take_switch_update(&mut untouched), Ok(None));
        assert_eq!(untouched, json!({ "theme": "dark" }));

        for bad in [
            json!({ "kbrainMemory": null }),
            json!({ "kbrainMemory": {} }),
            json!({ "kbrainMemory": { "enabled": 1 } }),
        ] {
            let mut update = bad;
            assert!(take_switch_update(&mut update).is_err());
        }
    }

    #[test]
    fn organizer_is_read_only_from_a_backend_that_reports_it() {
        assert_eq!(
            organizer_from_settings(
                &json!({ "memoryOrganizer": { "enabled": false, "intervalHours": 6 } })
            ),
            Some(json!({ "enabled": false, "intervalHours": 6.0 }))
        );
        assert_eq!(
            organizer_from_settings(&json!({ "memory": { "enabled": true } })),
            None
        );
        assert_eq!(
            organizer_from_settings(&json!({ "memoryOrganizer": { "enabled": true } })),
            None
        );
    }

    #[test]
    fn organizer_update_is_taken_out_of_the_liveagent_settings_update() {
        let mut update = json!({
            "kbrainMemoryOrganizer": { "intervalHours": 12, "extra": 1 },
            "theme": "dark"
        });
        assert_eq!(
            take_organizer_update(&mut update),
            Ok(Some(json!({ "intervalHours": 12 })))
        );
        assert_eq!(update, json!({ "theme": "dark" }));

        let mut both =
            json!({ "kbrainMemoryOrganizer": { "enabled": false, "intervalHours": 1.5 } });
        assert_eq!(
            take_organizer_update(&mut both),
            Ok(Some(json!({ "enabled": false, "intervalHours": 1.5 })))
        );

        let mut untouched = json!({ "theme": "dark" });
        assert_eq!(take_organizer_update(&mut untouched), Ok(None));

        for bad in [
            json!({ "kbrainMemoryOrganizer": null }),
            json!({ "kbrainMemoryOrganizer": {} }),
            json!({ "kbrainMemoryOrganizer": { "enabled": 1 } }),
            json!({ "kbrainMemoryOrganizer": { "intervalHours": "24" } }),
        ] {
            let mut update = bad;
            assert!(take_organizer_update(&mut update).is_err());
        }
    }
}
