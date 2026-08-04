//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use agent_core::commands::settings::*;
use agent_core::events::EventBus;
use agent_core::runtime::project_path::project_path_key as normalize_project_path_key;
use agent_core::services::automation::AutomationScheduler;
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
    agent_core::commands::settings::settings_load_all().await
}

#[tauri::command]
pub async fn settings_save_providers(payload: Value) -> Result<(), String> {
    agent_core::commands::settings::settings_save_providers(payload).await
}

#[tauri::command]
pub async fn settings_save_system(
    payload: Value,
    automation_scheduler: tauri::State<'_, Arc<AutomationScheduler>>,
) -> Result<(), String> {
    agent_core::commands::settings::settings_save_system(payload, automation_scheduler.inner())
        .await
}

#[tauri::command]
pub async fn settings_save_mcp(payload: Value) -> Result<(), String> {
    agent_core::commands::settings::settings_save_mcp(payload).await
}

// 从 State<GatewayController> 换成 State<EventBus>：实现侧已经不认识 Gateway 了，
// 它只发 settings:remote-saved，由 GatewayEventSink 接住去调 apply_config。
// State 参数不是 JSON key，前端契约不受影响。
#[tauri::command]
pub async fn settings_save_remote(
    payload: Value,
    events: tauri::State<'_, Arc<EventBus>>,
) -> Result<(), String> {
    agent_core::commands::settings::settings_save_remote(payload, events.inner()).await
}

#[tauri::command]
pub async fn settings_save_memory(payload: Value) -> Result<(), String> {
    agent_core::commands::settings::settings_save_memory(payload).await
}

#[tauri::command]
pub async fn settings_save_agents(payload: Value) -> Result<(), String> {
    agent_core::commands::settings::settings_save_agents(payload).await
}

#[tauri::command]
pub async fn settings_save_ssh(payload: Value) -> Result<(), String> {
    agent_core::commands::settings::settings_save_ssh(payload).await
}

#[tauri::command]
pub async fn settings_apply_ssh_patch(payload: Value) -> Result<SshPatchApplyResponse, String> {
    agent_core::commands::settings::settings_apply_ssh_patch(payload).await
}

#[tauri::command]
pub async fn settings_reset_ssh_known_host(
    host: String,
    port: u16,
) -> Result<SshKnownHostResetResponse, String> {
    agent_core::commands::settings::settings_reset_ssh_known_host(host, port).await
}

#[tauri::command]
pub async fn settings_list_cherry_studio_providers() -> Result<CherryProvidersResponse, String> {
    agent_core::commands::settings::settings_list_cherry_studio_providers().await
}

#[tauri::command]
pub async fn settings_list_cherry_studio_providers_from_path(
    data_path: String,
) -> Result<CherryProvidersResponse, String> {
    agent_core::commands::settings::settings_list_cherry_studio_providers_from_path(data_path).await
}

#[tauri::command]
pub async fn settings_list_ccswitch_providers() -> Result<CcsProvidersResponse, String> {
    agent_core::commands::settings::settings_list_ccswitch_providers().await
}
