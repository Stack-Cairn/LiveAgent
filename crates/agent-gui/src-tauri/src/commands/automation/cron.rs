use crate::services::cron::{
    clear_logs_sync, list_logs_sync, validate_cron_expression, CronCompletePromptRunInput,
    CronExecutionLogRecord, CronManager, CronPromptRunCompletionResult, CronPromptRunRequest,
};
use std::sync::Arc;

#[tauri::command(rename_all = "snake_case")]
pub async fn cron_validate_expression(expression: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || validate_cron_expression(&expression))
        .await
        .map_err(|e| format!("cron_validate_expression join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn cron_list_logs(
    task_id: String,
    limit: Option<usize>,
) -> Result<Vec<CronExecutionLogRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || list_logs_sync(task_id, limit.unwrap_or(100)))
        .await
        .map_err(|e| format!("cron_list_logs join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn cron_clear_logs(task_id: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || clear_logs_sync(task_id))
        .await
        .map_err(|e| format!("cron_clear_logs join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn cron_take_pending_prompt_runs(
    cron_manager: tauri::State<'_, Arc<CronManager>>,
) -> Result<Vec<CronPromptRunRequest>, String> {
    cron_manager.take_pending_prompt_runs()
}

#[tauri::command(rename_all = "snake_case")]
pub async fn cron_complete_prompt_run(
    input: CronCompletePromptRunInput,
    cron_manager: tauri::State<'_, Arc<CronManager>>,
) -> Result<CronPromptRunCompletionResult, String> {
    Arc::clone(cron_manager.inner())
        .complete_prompt_run(input)
        .await
}
