use crate::services::kbrain_backend::{KBrainBackendConnection, KBrainBackendState};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;

pub async fn migrate_on_demand(app: &tauri::AppHandle) -> Result<(), String> {
    let state = Arc::clone(app.state::<Arc<KBrainBackendState>>().inner());
    let handle = app.clone();
    let connection = tauri::async_runtime::spawn_blocking(move || state.ensure_started(&handle))
        .await
        .map_err(|e| e.to_string())??;
    migrate(app, &connection).await
}

pub async fn request(app: &tauri::AppHandle, action: &str, input: Value) -> Result<Value, String> {
    let state = Arc::clone(app.state::<Arc<KBrainBackendState>>().inner());
    let handle = app.clone();
    let connection = tauri::async_runtime::spawn_blocking(move || state.ensure_started(&handle))
        .await
        .map_err(|e| e.to_string())??;
    if matches!(action, "query" | "export" | "mutate" | "import") || action.starts_with("subscription.") {
        migrate(app, &connection).await?;
    }
    send(&connection, action, input).await
}

pub async fn send(
    connection: &KBrainBackendConnection,
    action: &str,
    input: Value,
) -> Result<Value, String> {
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!(
            "{}/v1/planning",
            connection.base_url.trim_end_matches('/')
        ))
        .bearer_auth(&connection.token)
        .json(&json!({"action":action,"input":input}))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body["error"]
            .as_str()
            .unwrap_or("K-brain Planning request failed")
            .to_string());
    }
    Ok(body)
}

pub async fn migrate(
    _app: &tauri::AppHandle,
    connection: &KBrainBackendConnection,
) -> Result<(), String> {
    let input = tauri::async_runtime::spawn_blocking(super::legacy::read)
        .await
        .map_err(|e| e.to_string())??;
    if let Some(input) = input {
        send(connection, "migrate", input).await?;
    }
    Ok(())
}
