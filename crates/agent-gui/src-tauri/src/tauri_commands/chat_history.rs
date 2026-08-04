//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use agent_core::commands::chat_history::*;
use agent_core::commands::{history_db, subagent_store};
use agent_core::events::EventBus;
use agent_core::services::memory::{MemoryHistorySearchMatch, MemorySearchArgs};
use chrono::{Local, LocalResult, NaiveDate, TimeZone};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[tauri::command]
pub async fn chat_history_replace_from_message(
    id: String,
    base_message_ref: ChatHistoryMessageRef,
    replacement_message: Value,
    max_messages: i64,
    expected_revision: String,
    events: tauri::State<'_, Arc<EventBus>>,
) -> Result<ChatHistoryWindowRecord, String> {
    agent_core::commands::chat_history::chat_history_replace_from_message(
        id,
        base_message_ref,
        replacement_message,
        max_messages,
        expected_revision,
        events.inner(),
    )
    .await
}

#[tauri::command]
pub async fn chat_history_delete(
    id: String,
    events: tauri::State<'_, Arc<EventBus>>,
) -> Result<(), String> {
    agent_core::commands::chat_history::chat_history_delete(id, events.inner()).await
}

#[tauri::command]
pub async fn chat_history_list(
    page: i64,
    page_size: i64,
    cwd: Option<String>,
    cwd_empty: Option<bool>,
) -> Result<ChatHistoryListResponse, String> {
    agent_core::commands::chat_history::chat_history_list(page, page_size, cwd, cwd_empty).await
}

#[tauri::command]
pub async fn chat_history_workdirs() -> Result<ChatHistoryWorkdirsResponse, String> {
    agent_core::commands::chat_history::chat_history_workdirs().await
}

#[tauri::command]
pub async fn chat_history_shared_list(
    page: i64,
    page_size: i64,
) -> Result<ChatHistoryListResponse, String> {
    agent_core::commands::chat_history::chat_history_shared_list(page, page_size).await
}

#[tauri::command]
pub async fn chat_history_search(
    args: ChatHistorySearchArgs,
) -> Result<ChatHistorySearchResponse, String> {
    agent_core::commands::chat_history::chat_history_search(args).await
}

#[tauri::command]
pub async fn chat_history_get_window(
    id: String,
    max_messages: i64,
    before_offset: Option<i64>,
    expected_revision: Option<String>,
    include_active_segment: bool,
) -> Result<ChatHistoryWindowRecord, String> {
    agent_core::commands::chat_history::chat_history_get_window(
        id,
        max_messages,
        before_offset,
        expected_revision,
        include_active_segment,
    )
    .await
}

#[tauri::command]
pub async fn chat_history_upsert(
    input: ChatHistoryUpsertInput,
    events: tauri::State<'_, Arc<EventBus>>,
) -> Result<ChatHistorySummary, String> {
    agent_core::commands::chat_history::chat_history_upsert(input, events.inner()).await
}

#[tauri::command]
pub async fn chat_history_upsert_active_segment(
    input: ChatHistorySegmentMutationInput,
    events: tauri::State<'_, Arc<EventBus>>,
) -> Result<ChatHistorySummary, String> {
    agent_core::commands::chat_history::chat_history_upsert_active_segment(input, events.inner())
        .await
}

#[tauri::command]
pub async fn chat_history_append_segment(
    input: ChatHistorySegmentMutationInput,
    events: tauri::State<'_, Arc<EventBus>>,
) -> Result<ChatHistorySummary, String> {
    agent_core::commands::chat_history::chat_history_append_segment(input, events.inner()).await
}

#[tauri::command]
pub async fn chat_history_rename(
    id: String,
    title: String,
    events: tauri::State<'_, Arc<EventBus>>,
) -> Result<ChatHistorySummary, String> {
    agent_core::commands::chat_history::chat_history_rename(id, title, events.inner()).await
}

#[tauri::command]
pub async fn chat_history_set_pinned(
    id: String,
    is_pinned: bool,
    events: tauri::State<'_, Arc<EventBus>>,
) -> Result<ChatHistorySummary, String> {
    agent_core::commands::chat_history::chat_history_set_pinned(id, is_pinned, events.inner()).await
}

#[tauri::command]
pub async fn chat_history_set_model(
    id: String,
    selected_model_json: String,
    events: tauri::State<'_, Arc<EventBus>>,
) -> Result<ChatHistorySummary, String> {
    agent_core::commands::chat_history::chat_history_set_model(
        id,
        selected_model_json,
        events.inner(),
    )
    .await
}

#[tauri::command]
pub async fn chat_history_share_get(id: String) -> Result<ChatHistoryShareStatus, String> {
    agent_core::commands::chat_history::chat_history_share_get(id).await
}

#[tauri::command]
pub async fn chat_history_share_set(
    id: String,
    enabled: bool,
    redact_tool_content: Option<bool>,
    events: tauri::State<'_, Arc<EventBus>>,
) -> Result<ChatHistoryShareStatus, String> {
    agent_core::commands::chat_history::chat_history_share_set(
        id,
        enabled,
        redact_tool_content,
        events.inner(),
    )
    .await
}

#[tauri::command]
pub async fn chat_history_branch(
    id: String,
    base_message_ref: ChatHistoryMessageRef,
    events: tauri::State<'_, Arc<EventBus>>,
) -> Result<ChatHistorySummary, String> {
    agent_core::commands::chat_history::chat_history_branch(id, base_message_ref, events.inner())
        .await
}
