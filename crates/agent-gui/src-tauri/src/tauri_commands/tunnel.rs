//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//!
//! ⚠️ 命令名从 `gateway_tunnel_*` 改为 `tunnel_*`（P2-30）：新架构里没有
//! gateway，隧道就是后端自己开的本机反向代理。这是阶段 2 里唯一一处**故意**
//! 改动前端契约的地方——旧名字指向一个即将不存在的组件。

#![allow(unused_imports)]

use agent_core::services::tunnel::{TunnelCreateInput, TunnelState, TunnelStore, TunnelUpdateInput};
use std::sync::Arc;

#[tauri::command]
pub fn tunnel_state(store: tauri::State<'_, Arc<TunnelStore>>) -> Result<TunnelState, String> {
    agent_core::commands::tunnel::tunnel_state(store.inner())
}

#[tauri::command]
pub async fn tunnel_create(
    input: TunnelCreateInput,
    store: tauri::State<'_, Arc<TunnelStore>>,
) -> Result<(), String> {
    agent_core::commands::tunnel::tunnel_create(input, store.inner())
        .await
        .map_err(|error| error.message)
}

#[tauri::command]
pub async fn tunnel_update(
    input: TunnelUpdateInput,
    store: tauri::State<'_, Arc<TunnelStore>>,
) -> Result<(), String> {
    agent_core::commands::tunnel::tunnel_update(input, store.inner())
        .await
        .map_err(|error| error.message)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn tunnel_close(
    tunnel_id: String,
    store: tauri::State<'_, Arc<TunnelStore>>,
) -> Result<(), String> {
    agent_core::commands::tunnel::tunnel_close(tunnel_id, store.inner())
        .await
        .map_err(|error| error.message)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn tunnel_check(
    tunnel_id: Option<String>,
    store: tauri::State<'_, Arc<TunnelStore>>,
) -> Result<(), String> {
    agent_core::commands::tunnel::tunnel_check(tunnel_id, store.inner())
        .await
        .map_err(|error| error.message)
}
