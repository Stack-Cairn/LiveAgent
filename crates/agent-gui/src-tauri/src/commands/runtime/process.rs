use std::sync::Arc;

use tauri::State;

use crate::runtime::managed_process::{
    ManagedProcessLogResponse, ManagedProcessRegistry, ManagedProcessStartResponse,
    ManagedProcessStatusResponse, ManagedProcessStopResponse,
};

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_start(
    registry: State<'_, Arc<ManagedProcessRegistry>>,
    workdir: String,
    command: String,
    cwd: Option<String>,
    label: Option<String>,
) -> Result<ManagedProcessStartResponse, String> {
    registry.start(workdir, command, cwd, label)
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
