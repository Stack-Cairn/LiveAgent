//! 代码库索引 command 层（docs/design/code-index.md）。
//!
//! memory command 同款：spawn_blocking 包装同步 service 调用。service 是进程级
//! 单例（watch sink 与 command 共享），无需 State 注入。

use crate::services::code_index::{
    global_code_index_service, CodeIndexDisableArgs, CodeIndexEnableArgs, CodeIndexJobCancelArgs,
    CodeIndexJobSnapshot, CodeIndexRebuildArgs, CodeIndexSearchArgs, CodeIndexSearchResponse,
    CodeIndexStatusArgs, CodeIndexStatusResponse, CodeIndexWarmArgs,
};

#[tauri::command]
pub async fn code_index_enable(args: CodeIndexEnableArgs) -> Result<CodeIndexJobSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || global_code_index_service().enable(args))
        .await
        .map_err(|e| format!("code_index_enable join 失败：{e}"))?
}

#[tauri::command]
pub async fn code_index_disable(args: CodeIndexDisableArgs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || global_code_index_service().disable(args))
        .await
        .map_err(|e| format!("code_index_disable join 失败：{e}"))?
}

#[tauri::command]
pub async fn code_index_rebuild(
    args: CodeIndexRebuildArgs,
) -> Result<CodeIndexJobSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || global_code_index_service().rebuild(args))
        .await
        .map_err(|e| format!("code_index_rebuild join 失败：{e}"))?
}

#[tauri::command]
pub async fn code_index_status(
    args: CodeIndexStatusArgs,
) -> Result<CodeIndexStatusResponse, String> {
    tauri::async_runtime::spawn_blocking(move || global_code_index_service().status(args))
        .await
        .map_err(|e| format!("code_index_status join 失败：{e}"))?
}

#[tauri::command]
pub async fn code_index_job_cancel(
    args: CodeIndexJobCancelArgs,
) -> Result<CodeIndexJobSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || global_code_index_service().job_cancel(args))
        .await
        .map_err(|e| format!("code_index_job_cancel join 失败：{e}"))?
}

#[tauri::command]
pub async fn code_index_search(
    args: CodeIndexSearchArgs,
) -> Result<CodeIndexSearchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || global_code_index_service().search(args))
        .await
        .map_err(|e| format!("code_index_search join 失败：{e}"))?
}

/// 预热 embedding 模型（fire-and-forget）：CodeSearch 工具注册时调用，
/// 避免应用重启后的第一波检索因模型未加载而降级词法。
#[tauri::command]
pub async fn code_index_warm(args: CodeIndexWarmArgs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || global_code_index_service().warm(args))
        .await
        .map_err(|e| format!("code_index_warm join 失败：{e}"))
}
