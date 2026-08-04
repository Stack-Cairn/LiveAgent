//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use crate::commands::cron::*;
use crate::services::automation::{
    validate_cron_expression, AutomationApplyInput, AutomationSnapshot, AutomationStore,
    CompletePromptRunInput, CronApplyResponse, CronRunNowResponse, CronRunRecord,
    HooksApplyResponse, PromptCompletionResponse, PromptRunRequest,
};
use std::sync::Arc;

#[tauri::command(rename_all = "snake_case")]
pub async fn cron_validate_expression(expression: String) -> Result<(), String> {
    crate::commands::cron::cron_validate_expression(expression).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_snapshot(
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<AutomationSnapshot, String> {
    crate::commands::cron::automation_snapshot(store.inner()).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_cron_apply(
    input: AutomationApplyInput,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<CronApplyResponse, String> {
    crate::commands::cron::automation_cron_apply(input, store.inner()).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_hooks_apply(
    input: AutomationApplyInput,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<HooksApplyResponse, String> {
    crate::commands::cron::automation_hooks_apply(input, store.inner()).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_list_runs(
    task_id: String,
    limit: Option<usize>,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<Vec<CronRunRecord>, String> {
    crate::commands::cron::automation_list_runs(task_id, limit, store.inner()).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_clear_runs(
    task_id: String,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<usize, String> {
    crate::commands::cron::automation_clear_runs(task_id, store.inner()).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_run_cron_now(
    task_id: String,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<CronRunNowResponse, String> {
    crate::commands::cron::automation_run_cron_now(task_id, store.inner()).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_claim_prompt_runs(
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<Vec<PromptRunRequest>, String> {
    crate::commands::cron::automation_claim_prompt_runs(store.inner()).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_release_prompt_run(
    execution_id: String,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<(), String> {
    crate::commands::cron::automation_release_prompt_run(execution_id, store.inner()).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn automation_complete_prompt_run(
    input: CompletePromptRunInput,
    store: tauri::State<'_, Arc<AutomationStore>>,
) -> Result<PromptCompletionResponse, String> {
    crate::commands::cron::automation_complete_prompt_run(input, store.inner()).await
}
