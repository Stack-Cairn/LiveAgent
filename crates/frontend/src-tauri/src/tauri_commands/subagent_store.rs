//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 backend，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use backend::commands::subagent_store::*;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::{
    collections::HashSet,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[tauri::command]
pub async fn subagent_identity_upsert(
    input: SubagentIdentityUpsertInput,
) -> Result<SubagentIdentityRecord, String> {
    backend::commands::subagent_store::subagent_identity_upsert(input).await
}

#[tauri::command]
pub async fn subagent_identity_list(
    input: SubagentIdentityListInput,
) -> Result<Vec<SubagentIdentityRecord>, String> {
    backend::commands::subagent_store::subagent_identity_list(input).await
}

#[tauri::command]
pub async fn subagent_run_save(input: SubagentRunSaveInput) -> Result<(), String> {
    backend::commands::subagent_store::subagent_run_save(input).await
}

#[tauri::command]
pub async fn subagent_run_list(
    input: SubagentRunListInput,
) -> Result<Vec<SubagentRunRecord>, String> {
    backend::commands::subagent_store::subagent_run_list(input).await
}

#[tauri::command]
pub async fn subagent_run_load(
    input: SubagentRunLoadInput,
) -> Result<Option<SubagentRunStateRecord>, String> {
    backend::commands::subagent_store::subagent_run_load(input).await
}

#[tauri::command]
pub async fn subagent_run_prune(
    input: SubagentRunPruneInput,
) -> Result<SubagentPruneResult, String> {
    backend::commands::subagent_store::subagent_run_prune(input).await
}

#[tauri::command]
pub async fn subagent_message_append(
    input: SubagentMessageAppendInput,
) -> Result<SubagentMessageRecord, String> {
    backend::commands::subagent_store::subagent_message_append(input).await
}

#[tauri::command]
pub async fn subagent_message_list(
    input: SubagentMessageListInput,
) -> Result<Vec<SubagentMessageRecord>, String> {
    backend::commands::subagent_store::subagent_message_list(input).await
}
