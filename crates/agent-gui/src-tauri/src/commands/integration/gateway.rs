use std::sync::Arc;

use serde_json::Value;

use crate::commands::settings::{load_remote_settings, open_db, parse_remote_settings_payload};
use crate::services::gateway::{
    GatewayChatClaimedRequest, GatewayChatQueueEventInput, GatewayChatQueueResponseInput,
    GatewayChatRuntimeSnapshot, GatewayController, GatewayStatusSnapshot,
};
use crate::services::tunnel::{
    GatewayTunnelCreateInput, GatewayTunnelUpdateInput, TunnelStatePayload,
};
use crate::services::workspace_watch::WatchSource;

#[tauri::command]
pub async fn gateway_connect(
    payload: Option<Value>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    let mut config = tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        let persisted = load_remote_settings(&conn)?;
        let mut requested = match payload {
            Some(value) => parse_remote_settings_payload(value)?,
            None => persisted.clone(),
        };
        // Agent ID 始终取本地持久化身份，调用方不能借连接命令临时覆盖。
        requested.agent_id = persisted.agent_id;
        Ok::<_, String>(requested)
    })
    .await
    .map_err(|e| format!("gateway_connect join 失败：{e}"))??;
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
pub fn gateway_nudge_connection(
    reason: Option<String>,
    force_reconnect: Option<bool>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<bool, String> {
    gateway_controller.nudge_connection(
        reason.as_deref().unwrap_or("runtime_wake"),
        force_reconnect.unwrap_or(false),
    )
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_send_chat_event(
    request_id: String,
    event: Value,
    worker_id: Option<String>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .send_chat_event(request_id, event, worker_id)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_claim_next(
    worker_id: String,
    lease_ms: Option<u64>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<Option<GatewayChatClaimedRequest>, String> {
    gateway_controller
        .claim_next_chat_request(worker_id, lease_ms)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_mark_started(
    request_id: String,
    conversation_id: String,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .mark_chat_request_started(request_id, conversation_id, worker_id)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_mark_local_started(
    request_id: String,
    conversation_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .mark_local_chat_run_started(request_id, conversation_id)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_mark_queued_in_gui(
    request_id: String,
    conversation_id: String,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .mark_chat_request_queued_in_gui(request_id, conversation_id, worker_id)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_complete(
    request_id: String,
    conversation_id: String,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .complete_chat_request(request_id, conversation_id, worker_id)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_fail(
    request_id: String,
    conversation_id: Option<String>,
    error_code: String,
    message: String,
    terminal: bool,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .fail_chat_request(
            request_id,
            conversation_id,
            error_code,
            message,
            terminal,
            worker_id,
        )
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_cancel_request(
    request_id: String,
    conversation_id: String,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .cancel_chat_request(request_id, conversation_id, worker_id)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn gateway_chat_heartbeat(
    request_id: String,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.heartbeat_chat_request(request_id, worker_id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_chat_runtime_heartbeat(
    worker_id: String,
    state: String,
    visible: bool,
    active_run_count: u32,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .publish_chat_runtime_status(worker_id, state, visible, active_run_count)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn gateway_chat_release_lease(
    request_id: String,
    worker_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.release_chat_request_lease(request_id, worker_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn gateway_chat_queue_respond(
    input: GatewayChatQueueResponseInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.respond_chat_queue_request(input)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_publish_chat_queue_event(
    input: GatewayChatQueueEventInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.publish_chat_queue_event(input).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_publish_chat_runtime_snapshot(
    input: GatewayChatRuntimeSnapshot,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .publish_chat_runtime_snapshot(input)
        .await
}

#[tauri::command]
pub async fn gateway_publish_settings_sync(
    payload: Value,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.publish_settings_sync(payload).await
}

#[tauri::command]
pub fn gateway_tunnel_state(
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<TunnelStatePayload, String> {
    Ok(gateway_controller.tunnel_state())
}

#[tauri::command]
pub async fn gateway_tunnel_create(
    input: GatewayTunnelCreateInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.tunnel_create(input).await
}

#[tauri::command]
pub async fn gateway_tunnel_update(
    input: GatewayTunnelUpdateInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.tunnel_update(input).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_tunnel_close(
    tunnel_id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.tunnel_close(tunnel_id).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn gateway_tunnel_check(
    tunnel_id: Option<String>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller.tunnel_check(tunnel_id).await
}

#[tauri::command]
pub fn workspace_watch_set(
    workdirs: Vec<String>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    gateway_controller
        .workspace_watch
        .set_desired(WatchSource::Local, workdirs);
    Ok(())
}
