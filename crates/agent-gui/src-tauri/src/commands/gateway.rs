use std::sync::Arc;

use serde_json::Value;

use crate::commands::settings::{load_remote_settings, open_db, parse_remote_settings_payload};
use crate::services::gateway::{
    build_history_sync_activity, GatewayController, GatewayStatusSnapshot,
};

#[tauri::command]
pub async fn gateway_connect(
    payload: Option<Value>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    let mut config = match payload {
        Some(value) => parse_remote_settings_payload(value)?,
        None => tauri::async_runtime::spawn_blocking(move || {
            let conn = open_db()?;
            load_remote_settings(&conn)
        })
        .await
        .map_err(|e| format!("gateway_connect join 失败：{e}"))??,
    };
    config.enabled = true;
    gateway_controller.apply_config(config)
}

#[tauri::command]
pub fn gateway_disconnect(
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.disconnect_runtime()
}

#[tauri::command]
pub fn gateway_status(
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<GatewayStatusSnapshot, String> {
    Ok(gateway_controller.status())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_send_chat_event(
    request_id: String,
    event: Value,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.send_chat_event(request_id, event).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_publish_conversation_activity(
    conversation_id: String,
    running: bool,
    workdir: Option<String>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .publish_history_sync(build_history_sync_activity(
            conversation_id,
            running,
            workdir,
        ))
        .await;
    Ok(())
}

#[tauri::command]
pub async fn gateway_publish_settings_sync(
    payload: Value,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.publish_settings_sync(payload).await
}
