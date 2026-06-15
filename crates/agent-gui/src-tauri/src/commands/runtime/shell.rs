use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::runtime::shell_runner::{run_shell_script, ShellRunRegistry, ShellRunResponse};

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

    if let Some(run_id) = normalized_run_id {
        registry.unregister(&run_id);
    }

    join_result.map_err(|e| format!("shell_run join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub fn shell_cancel(
    registry: State<'_, Arc<ShellRunRegistry>>,
    run_id: String,
) -> ShellCancelResponse {
    ShellCancelResponse {
        cancelled: registry.cancel(run_id.trim()),
    }
}
