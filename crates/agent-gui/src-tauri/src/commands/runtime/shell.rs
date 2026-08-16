use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::runtime::sandbox::SandboxOptions;
use crate::runtime::shell_runner::{
    run_shell_script_with_envs, ShellRunRegistry, ShellRunResponse,
};

#[derive(Debug, Serialize)]
pub struct ShellCancelResponse {
    cancelled: bool,
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn shell_run(
    registry: State<'_, Arc<ShellRunRegistry>>,
    workdir: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    max_timeout_ms: Option<u64>,
    provider_id: Option<String>,
    run_id: Option<String>,
    sandbox: Option<bool>,
    sandbox_allow_network: Option<bool>,
) -> Result<ShellRunResponse, String> {
    let normalized_run_id = run_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let cancel_token = normalized_run_id.as_deref().map(|id| registry.register(id));
    let registered_token = cancel_token.clone();
    let sandbox_options = (sandbox == Some(true)).then(|| SandboxOptions {
        allow_network: sandbox_allow_network.unwrap_or(true),
    });

    let join_result = tauri::async_runtime::spawn_blocking(move || {
        run_shell_script_with_envs(
            workdir,
            command,
            cwd,
            timeout_ms,
            max_timeout_ms,
            provider_id,
            cancel_token,
            &[],
            sandbox_options,
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
