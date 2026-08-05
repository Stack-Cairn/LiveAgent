//! 后端服务相关的 Tauri 命令。

use serde::Serialize;
use tauri::State;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 后端端点信息：前端用这些参数连接内嵌后端。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendEndpoint {
    /// HTTP 服务监听的主机（壳内嵌后端总是 127.0.0.1）。
    pub host: String,
    /// HTTP 服务监听的端口（127.0.0.1）。
    pub port: u16,
    /// 认证密码（作为 Bearer token）。
    pub password: String,
}

/// 获取后端服务的端点信息。
///
/// 前端在启动后调用一次获取连接参数，然后用这些参数打 loopback HTTP。
#[tauri::command]
pub fn get_backend_endpoint(
    endpoint: State<'_, Arc<RwLock<Option<BackendEndpoint>>>>,
) -> Result<BackendEndpoint, String> {
    // 这是同步命令，但 RwLock 是异步的。在这里直接调用 blocking_lock。
    let lock = endpoint.blocking_read();
    lock.clone()
        .ok_or_else(|| "后端服务尚未启动".to_string())
}
