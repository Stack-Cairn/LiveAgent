//! K-brain's memory master switch over the desktop-owned Gateway. The WebUI reads and
//! writes it as `kbrainMemory` (its `memory` key is LiveAgent's organizer settings); the
//! value lives in K-brain's `/v1/settings`, never in LiveAgent's own settings.

use std::sync::Arc;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::AUTHORIZATION;
use serde_json::{json, Value};
use tauri::Manager as _;

use crate::services::kbrain_backend::{KBrainBackendConnection, KBrainBackendState};

pub(crate) const KBRAIN_MEMORY_FIELD: &str = "kbrainMemory";

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

fn client() -> Result<Client, String> {
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
}
