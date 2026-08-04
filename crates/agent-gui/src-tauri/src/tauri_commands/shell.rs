//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use agent_core::commands::shell::*;
use agent_core::runtime::shell_runner::{run_shell_script, ShellRunRegistry, ShellRunResponse};
use serde::Serialize;
use std::sync::Arc;

#[tauri::command(rename_all = "snake_case")]
pub async fn shell_run(
    registry: tauri::State<'_, Arc<ShellRunRegistry>>,
    workdir: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    max_timeout_ms: Option<u64>,
    provider_id: Option<String>,
    run_id: Option<String>,
) -> Result<ShellRunResponse, String> {
    agent_core::commands::shell::shell_run(
        registry.inner(),
        workdir,
        command,
        cwd,
        timeout_ms,
        max_timeout_ms,
        provider_id,
        run_id,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn runtime_cancel(
    registry: tauri::State<'_, Arc<ShellRunRegistry>>,
    run_id: String,
) -> ShellCancelResponse {
    agent_core::commands::shell::runtime_cancel(registry.inner(), run_id)
}
