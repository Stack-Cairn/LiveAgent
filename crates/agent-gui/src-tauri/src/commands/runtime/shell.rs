use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::runtime::shell_runner::{run_shell_script, ShellRunRegistry, ShellRunResponse};
use crate::runtime::shell_session::{ShellSessionManager, ShellSessionResponse};

#[derive(Debug, Serialize)]
pub struct ShellCancelResponse {
    cancelled: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn shell_run(
    registry: State<'_, Arc<ShellRunRegistry>>,
    workdir: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    max_timeout_ms: Option<u64>,
    provider_id: Option<String>,
    run_id: Option<String>,
) -> Result<ShellRunResponse, String> {
    let normalized_run_id = run_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let cancel_token = normalized_run_id.as_deref().map(|id| registry.register(id));
    let registered_token = cancel_token.clone();

    let join_result = tauri::async_runtime::spawn_blocking(move || {
        run_shell_script(
            workdir,
            command,
            cwd,
            timeout_ms,
            max_timeout_ms,
            provider_id,
            cancel_token,
        )
    })
    .await;

    if let (Some(run_id), Some(token)) = (normalized_run_id.as_deref(), registered_token.as_ref()) {
        registry.unregister(run_id, token);
    }

    join_result.map_err(|e| format!("shell_run join failed: {e}"))?
}

/// Cancels any run registered in the shared `ShellRunRegistry` — shell
/// commands, MCP tool calls, and SSH exec all park their cancel tokens there.
#[tauri::command(rename_all = "snake_case")]
pub fn runtime_cancel(
    registry: State<'_, Arc<ShellRunRegistry>>,
    run_id: String,
) -> ShellCancelResponse {
    ShellCancelResponse {
        cancelled: registry.cancel(run_id.trim()),
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "snake_case")]
pub async fn shell_session_start(
    manager: State<'_, Arc<ShellSessionManager>>,
    session_id: String,
    workdir: String,
    command: String,
    cwd: Option<String>,
    yield_time_ms: Option<u64>,
    timeout_ms: Option<u64>,
    max_timeout_ms: Option<u64>,
) -> Result<ShellSessionResponse, String> {
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || {
        manager.start(
            session_id,
            workdir,
            command,
            cwd,
            yield_time_ms,
            timeout_ms,
            max_timeout_ms,
        )
    })
    .await
    .map_err(|error| format!("shell_session_start join failed: {error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn shell_session_wait(
    manager: State<'_, Arc<ShellSessionManager>>,
    session_id: String,
    cursor: Option<u64>,
    yield_time_ms: Option<u64>,
) -> Result<ShellSessionResponse, String> {
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || manager.wait(&session_id, cursor, yield_time_ms))
        .await
        .map_err(|error| format!("shell_session_wait join failed: {error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn shell_session_stop(
    manager: State<'_, Arc<ShellSessionManager>>,
    session_id: String,
    cursor: Option<u64>,
) -> Result<ShellSessionResponse, String> {
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || manager.stop(&session_id, cursor))
        .await
        .map_err(|error| format!("shell_session_stop join failed: {error}"))?
}
