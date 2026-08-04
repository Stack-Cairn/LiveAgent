//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use crate::commands::process::*;
use crate::runtime::managed_process::{
    ManagedProcessLogResponse, ManagedProcessRegistry, ManagedProcessSnapshot,
    ManagedProcessStartResponse, ManagedProcessStatusResponse, ManagedProcessStopResponse,
};
use std::sync::Arc;

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_start(
    registry: tauri::State<'_, Arc<ManagedProcessRegistry>>,
    workdir: String,
    command: String,
    cwd: Option<String>,
    label: Option<String>,
    isolated: Option<bool>,
) -> Result<ManagedProcessStartResponse, String> {
    crate::commands::process::managed_process_start(
        registry.inner(),
        workdir,
        command,
        cwd,
        label,
        isolated,
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_status(
    registry: tauri::State<'_, Arc<ManagedProcessRegistry>>,
    process_id: Option<String>,
) -> Result<ManagedProcessStatusResponse, String> {
    crate::commands::process::managed_process_status(registry.inner(), process_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_stop(
    registry: tauri::State<'_, Arc<ManagedProcessRegistry>>,
    process_id: String,
) -> Result<ManagedProcessStopResponse, String> {
    crate::commands::process::managed_process_stop(registry.inner(), process_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_read_log(
    registry: tauri::State<'_, Arc<ManagedProcessRegistry>>,
    process_id: String,
    max_bytes: Option<u64>,
) -> Result<ManagedProcessLogResponse, String> {
    crate::commands::process::managed_process_read_log(registry.inner(), process_id, max_bytes)
}

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_snapshot(
    registry: tauri::State<'_, Arc<ManagedProcessRegistry>>,
) -> Result<ManagedProcessSnapshot, String> {
    crate::commands::process::managed_process_snapshot(registry.inner())
}

#[tauri::command(rename_all = "snake_case")]
pub fn managed_process_clear(
    registry: tauri::State<'_, Arc<ManagedProcessRegistry>>,
    process_id: Option<String>,
) -> Result<ManagedProcessSnapshot, String> {
    crate::commands::process::managed_process_clear(registry.inner(), process_id)
}
