//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use agent_core::commands::hook::*;
use agent_core::runtime::shell_runner::{
    run_shell_script_with_envs, ShellCancelFlag, ShellCancelToken, ShellRunResponse,
};
use agent_core::runtime::task_runner::{
    build_http_client, resolve_workdir, run_single_http_request, HttpRequestInput,
};
use agent_core::services::automation::validate::{MAX_HOOK_TIMEOUT_MS, MIN_HOOK_TIMEOUT_MS};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[tauri::command(rename_all = "snake_case")]
pub async fn hook_run_script(
    workdir: Option<String>,
    script: String,
    timeout_ms: Option<u64>,
    scope_id: Option<String>,
    context: Option<HashMap<String, String>>,
    registry: tauri::State<'_, Arc<HookScopeRegistry>>,
) -> Result<ShellRunResponse, String> {
    agent_core::commands::hook::hook_run_script(
        workdir,
        script,
        timeout_ms,
        scope_id,
        context,
        registry.inner(),
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn hook_run_http_requests(
    requests: Vec<HttpRequestInput>,
    scope_id: Option<String>,
    registry: tauri::State<'_, Arc<HookScopeRegistry>>,
) -> Result<HookHttpRunResponse, String> {
    agent_core::commands::hook::hook_run_http_requests(requests, scope_id, registry.inner()).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn hook_cancel_scope(
    scope_id: String,
    registry: tauri::State<'_, Arc<HookScopeRegistry>>,
) -> Result<(), String> {
    agent_core::commands::hook::hook_cancel_scope(scope_id, registry.inner()).await
}
