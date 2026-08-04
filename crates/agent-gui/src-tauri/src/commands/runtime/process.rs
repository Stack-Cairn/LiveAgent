use std::sync::Arc;

use tauri::State;

use crate::runtime::managed_process::{
    ManagedProcessLogResponse, ManagedProcessRegistry, ManagedProcessSnapshot,
    ManagedProcessStartResponse, ManagedProcessStatusResponse, ManagedProcessStopResponse,
};

pub fn managed_process_start(
    registry: &Arc<ManagedProcessRegistry>,
    workdir: String,
    command: String,
    cwd: Option<String>,
    label: Option<String>,
    isolated: Option<bool>,
) -> Result<ManagedProcessStartResponse, String> {
    registry.start(workdir, command, cwd, label, isolated.unwrap_or(false))
}

pub fn managed_process_status(
    registry: &Arc<ManagedProcessRegistry>,
    process_id: Option<String>,
) -> Result<ManagedProcessStatusResponse, String> {
    registry.status(process_id)
}

pub fn managed_process_stop(
    registry: &Arc<ManagedProcessRegistry>,
    process_id: String,
) -> Result<ManagedProcessStopResponse, String> {
    registry.stop(process_id)
}

pub fn managed_process_read_log(
    registry: &Arc<ManagedProcessRegistry>,
    process_id: String,
    max_bytes: Option<u64>,
) -> Result<ManagedProcessLogResponse, String> {
    registry.read_log(process_id, max_bytes)
}

pub fn managed_process_snapshot(
    registry: &Arc<ManagedProcessRegistry>,
) -> Result<ManagedProcessSnapshot, String> {
    registry.snapshot()
}

pub fn managed_process_clear(
    registry: &Arc<ManagedProcessRegistry>,
    process_id: Option<String>,
) -> Result<ManagedProcessSnapshot, String> {
    registry.clear(process_id)
}
