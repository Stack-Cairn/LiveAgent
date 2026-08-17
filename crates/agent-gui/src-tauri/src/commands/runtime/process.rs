use std::sync::Arc;

use tauri::State;

use crate::runtime::managed_process::{
    ManagedProcessLogResponse, ManagedProcessRegistry, ManagedProcessSnapshot,
    ManagedProcessStartResponse, ManagedProcessStatusResponse, ManagedProcessStopResponse,
};
use crate::runtime::sandbox::SandboxOptions;

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub fn managed_process_start(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    workdir: String,
    command: String,
    cwd: Option<String>,
    label: Option<String>,
    isolated: Option<bool>,
    sandbox: Option<bool>,
    sandbox_allow_network: Option<bool>,
) -> Result<ManagedProcessStartResponse, String> {
    let sandbox_options = (sandbox == Some(true)).then(|| SandboxOptions {
        allow_network: sandbox_allow_network.unwrap_or(true),
    });
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
