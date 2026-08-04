//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use crate::commands::memory::*;
use crate::{
    commands::chat_history,
    services::memory::{
        MemoryAcceptArgs, MemoryBatchArgs, MemoryBatchResponse, MemoryDeleteArgs,
        MemoryDeleteProjectArgs, MemoryDeleteProjectResponse, MemoryListArgs, MemoryListResponse,
        MemoryMutationResponse, MemoryOrganizeDueClaimArgs, MemoryOrganizeDueClaimResponse,
        MemoryOrganizeRun, MemoryOrganizeRunClearHistoryResponse, MemoryOrganizeRunCreateArgs,
        MemoryOrganizeRunCreateResponse, MemoryOrganizeRunListArgs, MemoryOrganizeRunListResponse,
        MemoryOrganizeRunReadArgs, MemoryOrganizeRunUpdateArgs, MemoryOverviewResponse,
        MemoryPathsInfo, MemoryQuotaSummaryArgs, MemoryQuotaSummaryResponse, MemoryReadArgs,
        MemoryReadResponse, MemoryRecentRejectionsArgs, MemoryRecentRejectionsResponse,
        MemorySearchArgs, MemorySearchResponse, MemoryStore, MemoryUpdateArgs, MemoryWriteArgs,
    },
};
use std::sync::Arc;

#[tauri::command]
pub async fn memory_list(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemoryListArgs,
) -> Result<MemoryListResponse, String> {
    crate::commands::memory::memory_list(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_read(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemoryReadArgs,
) -> Result<MemoryReadResponse, String> {
    crate::commands::memory::memory_read(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_search(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemorySearchArgs,
) -> Result<MemorySearchResponse, String> {
    crate::commands::memory::memory_search(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_write(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemoryWriteArgs,
) -> Result<MemoryMutationResponse, String> {
    crate::commands::memory::memory_write(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_update(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemoryUpdateArgs,
) -> Result<MemoryMutationResponse, String> {
    crate::commands::memory::memory_update(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_delete(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemoryDeleteArgs,
) -> Result<MemoryMutationResponse, String> {
    crate::commands::memory::memory_delete(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_delete_project(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemoryDeleteProjectArgs,
) -> Result<MemoryDeleteProjectResponse, String> {
    crate::commands::memory::memory_delete_project(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_accept(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemoryAcceptArgs,
) -> Result<MemoryMutationResponse, String> {
    crate::commands::memory::memory_accept(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_apply_batch(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemoryBatchArgs,
) -> Result<MemoryBatchResponse, String> {
    crate::commands::memory::memory_apply_batch(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_organize_run_create(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemoryOrganizeRunCreateArgs,
) -> Result<MemoryOrganizeRunCreateResponse, String> {
    crate::commands::memory::memory_organize_run_create(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_organize_run_update(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemoryOrganizeRunUpdateArgs,
) -> Result<Option<MemoryOrganizeRun>, String> {
    crate::commands::memory::memory_organize_run_update(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_organize_run_list(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: Option<MemoryOrganizeRunListArgs>,
) -> Result<MemoryOrganizeRunListResponse, String> {
    crate::commands::memory::memory_organize_run_list(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_organize_run_read(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemoryOrganizeRunReadArgs,
) -> Result<Option<MemoryOrganizeRun>, String> {
    crate::commands::memory::memory_organize_run_read(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_organize_run_clear_history(
    state: tauri::State<'_, Arc<MemoryStore>>,
) -> Result<MemoryOrganizeRunClearHistoryResponse, String> {
    crate::commands::memory::memory_organize_run_clear_history(state.inner()).await
}

#[tauri::command]
pub async fn memory_organize_due_claim(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemoryOrganizeDueClaimArgs,
) -> Result<MemoryOrganizeDueClaimResponse, String> {
    crate::commands::memory::memory_organize_due_claim(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_organize_due_complete(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: MemoryOrganizeRunUpdateArgs,
) -> Result<Option<MemoryOrganizeRun>, String> {
    crate::commands::memory::memory_organize_due_complete(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_index_overview(
    state: tauri::State<'_, Arc<MemoryStore>>,
    workdir: Option<String>,
) -> Result<MemoryOverviewResponse, String> {
    crate::commands::memory::memory_index_overview(state.inner(), workdir).await
}

#[tauri::command]
pub async fn memory_paths_info(
    state: tauri::State<'_, Arc<MemoryStore>>,
) -> Result<MemoryPathsInfo, String> {
    crate::commands::memory::memory_paths_info(state.inner()).await
}

#[tauri::command]
pub async fn memory_recent_rejections(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: Option<MemoryRecentRejectionsArgs>,
) -> Result<MemoryRecentRejectionsResponse, String> {
    crate::commands::memory::memory_recent_rejections(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_today_local_date(
    state: tauri::State<'_, Arc<MemoryStore>>,
    rollover_hour: Option<u32>,
) -> Result<String, String> {
    crate::commands::memory::memory_today_local_date(state.inner(), rollover_hour).await
}

#[tauri::command]
pub async fn memory_today_daily(
    state: tauri::State<'_, Arc<MemoryStore>>,
    rollover_hour: Option<u32>,
) -> Result<Option<MemoryReadResponse>, String> {
    crate::commands::memory::memory_today_daily(state.inner(), rollover_hour).await
}

#[tauri::command]
pub async fn memory_quota_summary(
    state: tauri::State<'_, Arc<MemoryStore>>,
    args: Option<MemoryQuotaSummaryArgs>,
) -> Result<MemoryQuotaSummaryResponse, String> {
    crate::commands::memory::memory_quota_summary(state.inner(), args).await
}

#[tauri::command]
pub async fn memory_wipe_all(
    state: tauri::State<'_, Arc<MemoryStore>>,
) -> Result<MemoryPathsInfo, String> {
    crate::commands::memory::memory_wipe_all(state.inner()).await
}
