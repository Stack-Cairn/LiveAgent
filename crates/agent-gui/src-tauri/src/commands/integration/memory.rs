use std::sync::Arc;

use tauri::State;

use crate::{
    commands::chat_history,
    services::memory::{
        MemoryAcceptArgs, MemoryBatchArgs, MemoryBatchResponse, MemoryDeleteArgs,
        MemoryDeleteProjectArgs, MemoryDeleteProjectResponse, MemoryListArgs, MemoryListResponse,
        MemoryMutationResponse, MemoryOrganizeDueClaimArgs, MemoryOrganizeDueClaimResponse,
        MemoryOrganizeRun, MemoryOrganizeRunClearHistoryResponse, MemoryOrganizeRunCreateArgs,
        MemoryOrganizeRunCreateResponse, MemoryOrganizeRunListArgs, MemoryOrganizeRunListResponse,
        MemoryOrganizeRunReadArgs, MemoryOrganizeRunUpdateArgs, MemoryOverviewResponse,
        MemoryPathsInfo, MemoryReadArgs, MemoryReadResponse, MemoryRecentRejectionsArgs,
        MemoryRecentRejectionsResponse, MemorySearchArgs, MemorySearchResponse, MemoryStore,
        MemoryUpdateArgs, MemoryWriteArgs,
    },
};

#[tauri::command]
pub async fn memory_list(
    state: State<'_, Arc<MemoryStore>>,
    args: MemoryListArgs,
) -> Result<MemoryListResponse, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.list(args))
        .await
        .map_err(|e| format!("memory_list join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_read(
    state: State<'_, Arc<MemoryStore>>,
    args: MemoryReadArgs,
) -> Result<MemoryReadResponse, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.read(args))
        .await
        .map_err(|e| format!("memory_read join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_search(
    state: State<'_, Arc<MemoryStore>>,
    args: MemorySearchArgs,
) -> Result<MemorySearchResponse, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let history_args = args.clone();
        let mut response = store.search(args)?;
        response.history_matches =
            chat_history::search_chat_history_for_memory_sync(&history_args)?;
        Ok(response)
    })
    .await
    .map_err(|e| format!("memory_search join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_write(
    state: State<'_, Arc<MemoryStore>>,
    args: MemoryWriteArgs,
) -> Result<MemoryMutationResponse, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.write(args))
        .await
        .map_err(|e| format!("memory_write join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_update(
    state: State<'_, Arc<MemoryStore>>,
    args: MemoryUpdateArgs,
) -> Result<MemoryMutationResponse, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.update(args))
        .await
        .map_err(|e| format!("memory_update join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_delete(
    state: State<'_, Arc<MemoryStore>>,
    args: MemoryDeleteArgs,
) -> Result<MemoryMutationResponse, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.delete(args))
        .await
        .map_err(|e| format!("memory_delete join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_delete_project(
    state: State<'_, Arc<MemoryStore>>,
    args: MemoryDeleteProjectArgs,
) -> Result<MemoryDeleteProjectResponse, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.delete_project(args))
        .await
        .map_err(|e| format!("memory_delete_project join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_accept(
    state: State<'_, Arc<MemoryStore>>,
    args: MemoryAcceptArgs,
) -> Result<MemoryMutationResponse, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.accept(args))
        .await
        .map_err(|e| format!("memory_accept join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_apply_batch(
    state: State<'_, Arc<MemoryStore>>,
    args: MemoryBatchArgs,
) -> Result<MemoryBatchResponse, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.apply_batch(args))
        .await
        .map_err(|e| format!("memory_apply_batch join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_organize_run_create(
    state: State<'_, Arc<MemoryStore>>,
    args: MemoryOrganizeRunCreateArgs,
) -> Result<MemoryOrganizeRunCreateResponse, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.organize_run_create(args))
        .await
        .map_err(|e| format!("memory_organize_run_create join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_organize_run_update(
    state: State<'_, Arc<MemoryStore>>,
    args: MemoryOrganizeRunUpdateArgs,
) -> Result<Option<MemoryOrganizeRun>, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.organize_run_update(args))
        .await
        .map_err(|e| format!("memory_organize_run_update join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_organize_run_list(
    state: State<'_, Arc<MemoryStore>>,
    args: Option<MemoryOrganizeRunListArgs>,
) -> Result<MemoryOrganizeRunListResponse, String> {
    let store = Arc::clone(&state);
    let resolved = args.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || store.organize_run_list(resolved))
        .await
        .map_err(|e| format!("memory_organize_run_list join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_organize_run_read(
    state: State<'_, Arc<MemoryStore>>,
    args: MemoryOrganizeRunReadArgs,
) -> Result<Option<MemoryOrganizeRun>, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.organize_run_read(args))
        .await
        .map_err(|e| format!("memory_organize_run_read join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_organize_run_clear_history(
    state: State<'_, Arc<MemoryStore>>,
) -> Result<MemoryOrganizeRunClearHistoryResponse, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.organize_run_clear_history())
        .await
        .map_err(|e| format!("memory_organize_run_clear_history join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_organize_due_claim(
    state: State<'_, Arc<MemoryStore>>,
    args: MemoryOrganizeDueClaimArgs,
) -> Result<MemoryOrganizeDueClaimResponse, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.organize_due_claim(args))
        .await
        .map_err(|e| format!("memory_organize_due_claim join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_organize_due_complete(
    state: State<'_, Arc<MemoryStore>>,
    args: MemoryOrganizeRunUpdateArgs,
) -> Result<Option<MemoryOrganizeRun>, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.organize_due_complete(args))
        .await
        .map_err(|e| format!("memory_organize_due_complete join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_index_overview(
    state: State<'_, Arc<MemoryStore>>,
    workdir: Option<String>,
) -> Result<MemoryOverviewResponse, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.overview(workdir))
        .await
        .map_err(|e| format!("memory_index_overview join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_paths_info(
    state: State<'_, Arc<MemoryStore>>,
) -> Result<MemoryPathsInfo, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.paths_info())
        .await
        .map_err(|e| format!("memory_paths_info join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_recent_rejections(
    state: State<'_, Arc<MemoryStore>>,
    args: Option<MemoryRecentRejectionsArgs>,
) -> Result<MemoryRecentRejectionsResponse, String> {
    let store = Arc::clone(&state);
    let resolved = args.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || store.recent_rejections(resolved))
        .await
        .map_err(|e| format!("memory_recent_rejections join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_today_local_date(
    state: State<'_, Arc<MemoryStore>>,
    rollover_hour: Option<u32>,
) -> Result<String, String> {
    Ok(state.today_local_date(rollover_hour))
}

#[tauri::command]
pub async fn memory_today_daily(
    state: State<'_, Arc<MemoryStore>>,
    rollover_hour: Option<u32>,
) -> Result<Option<MemoryReadResponse>, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.today_daily(rollover_hour))
        .await
        .map_err(|e| format!("memory_today_daily join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_wipe_all(
    state: State<'_, Arc<MemoryStore>>,
) -> Result<MemoryPathsInfo, String> {
    let store = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || store.wipe_all())
        .await
        .map_err(|e| format!("memory_wipe_all join 失败：{e}"))?
}
