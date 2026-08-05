//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 backend，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use backend::commands::settings::*;
use backend::events::EventBus;
use backend::runtime::project_path::project_path_key as normalize_project_path_key;
use backend::services::automation::AutomationScheduler;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Number, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[tauri::command]
pub async fn settings_load_all() -> Result<SettingsLoadResponse, String> {
    backend::commands::settings::settings_load_all().await
}

#[tauri::command]
pub async fn settings_save_providers(payload: Value) -> Result<(), String> {
    backend::commands::settings::settings_save_providers(payload).await
}

#[tauri::command]
pub async fn settings_save_system(
    payload: Value,
    automation_scheduler: tauri::State<'_, Arc<AutomationScheduler>>,
) -> Result<(), String> {
    backend::commands::settings::settings_save_system(payload, automation_scheduler.inner())
        .await
}

#[tauri::command]
pub async fn settings_save_mcp(payload: Value) -> Result<(), String> {
    backend::commands::settings::settings_save_mcp(payload).await
}

// 保存后只发 settings:remote-saved；谁关心远程访问权限变了自己去订阅。
// State 参数不是 JSON key，前端契约不受影响。
#[tauri::command]
pub async fn settings_save_remote(
    payload: Value,
    events: tauri::State<'_, Arc<EventBus>>,
) -> Result<(), String> {
    backend::commands::settings::settings_save_remote(payload, events.inner()).await
}

#[tauri::command]
pub async fn settings_save_memory(payload: Value) -> Result<(), String> {
    backend::commands::settings::settings_save_memory(payload).await
}

#[tauri::command]
pub async fn settings_save_agents(payload: Value) -> Result<(), String> {
    backend::commands::settings::settings_save_agents(payload).await
}

#[tauri::command]
pub async fn settings_save_ssh(payload: Value) -> Result<(), String> {
    backend::commands::settings::settings_save_ssh(payload).await
}

#[tauri::command]
pub async fn settings_apply_ssh_patch(payload: Value) -> Result<SshPatchApplyResponse, String> {
    backend::commands::settings::settings_apply_ssh_patch(payload).await
}

#[tauri::command]
pub async fn settings_reset_ssh_known_host(
    host: String,
    port: u16,
) -> Result<SshKnownHostResetResponse, String> {
    backend::commands::settings::settings_reset_ssh_known_host(host, port).await
}

#[tauri::command]
pub async fn settings_list_cherry_studio_providers() -> Result<CherryProvidersResponse, String> {
    backend::commands::settings::settings_list_cherry_studio_providers().await
}

#[tauri::command]
pub async fn settings_list_cherry_studio_providers_from_path(
    data_path: String,
) -> Result<CherryProvidersResponse, String> {
    backend::commands::settings::settings_list_cherry_studio_providers_from_path(data_path).await
}

#[tauri::command]
pub async fn settings_list_ccswitch_providers() -> Result<CcsProvidersResponse, String> {
    backend::commands::settings::settings_list_ccswitch_providers().await
}
