use std::sync::Arc;

use tauri::State;

use crate::runtime::managed_process::{
    ManagedProcessLogResponse, ManagedProcessRegistry, ManagedProcessSnapshot,
    ManagedProcessStartResponse, ManagedProcessStatusResponse, ManagedProcessStopResponse,
    ManagedProcessWaitResponse,
};
use crate::runtime::sandbox::{resolve_effective_options, SandboxOptions};

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub fn managed_process_start(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    workdir: String,
    command: String,
    cwd: Option<String>,
    label: Option<String>,
    isolated: Option<bool>,
    sandbox: bool,
    sandbox_allow_network: bool,
) -> Result<ManagedProcessStartResponse, String> {
    // 请求侧声明只能加严;下限由后端回查持久化的 commandSafetyMode 得出(P1#3)。
    let sandbox_options = resolve_effective_options(sandbox.then_some(SandboxOptions {
        allow_network: sandbox_allow_network,
    }))?;
    registry.start(
        workdir,
        command,
        cwd,
        label,
        isolated.unwrap_or(false),
        sandbox_options,
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_status(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    process_id: Option<String>,
) -> Result<ManagedProcessStatusResponse, String> {
    registry.status(process_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_stop(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    process_id: String,
) -> Result<ManagedProcessStopResponse, String> {
    registry.stop(process_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_read_log(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    process_id: String,
    max_bytes: Option<u64>,
) -> Result<ManagedProcessLogResponse, String> {
    registry.read_log(process_id, max_bytes)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn managed_process_wait(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    process_id: String,
    cursor: Option<u64>,
    yield_time_ms: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<ManagedProcessWaitResponse, String> {
    let registry = Arc::clone(registry.inner());
    tauri::async_runtime::spawn_blocking(move || {
        registry.wait(process_id, cursor, yield_time_ms, max_bytes)
    })
    .await
    .map_err(|error| format!("managed_process_wait join failed: {error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_snapshot(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
) -> Result<ManagedProcessSnapshot, String> {
    registry.snapshot()
}

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_clear(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    process_id: Option<String>,
) -> Result<ManagedProcessSnapshot, String> {
    registry.clear(process_id)
}
