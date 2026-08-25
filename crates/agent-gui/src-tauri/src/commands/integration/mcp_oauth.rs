//! MCP OAuth 命令（docs/design/mcp-oauth.md §5）。
//!
//! 三条命令都只搬运状态与元数据，token 本体永不过前端边界：
//! - `mcp_oauth_authorize`：交互授权（弹系统浏览器，阻塞至回调/超时），只由
//!   MCP Hub 的 Connect 手势触发。
//! - `mcp_oauth_status`：授权状态查询（server 卡片徽章）。
//! - `mcp_oauth_clear`：断开授权/删除 server 时清理 keychain 条目。

use super::mcp::{run_blocking, McpServerConfig};
use crate::services::mcp_oauth::{self, OauthStatusInfo};
use tauri_plugin_opener::OpenerExt;

fn oauth_server_of(server: &McpServerConfig) -> Result<mcp_oauth::OauthServer, String> {
    if !matches!(server.transport.as_deref().unwrap_or("stdio").trim(), "http" | "sse") {
        return Err("仅 http/sse transport 支持 OAuth".to_string());
    }
    server
        .oauth_server()
        .ok_or_else(|| "MCP server 缺少 url，无法执行 OAuth".to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_authorize(
    app: tauri::AppHandle,
    server: McpServerConfig,
) -> Result<OauthStatusInfo, String> {
    let target = oauth_server_of(&server)?;
    // 授权流阻塞数分钟（等浏览器回调），必须 offload；浏览器打开经 opener 插件
    // 走系统默认浏览器。
    run_blocking("mcp_oauth_authorize", move || {
        mcp_oauth::authorize(&target, &|url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| format!("打开系统浏览器失败：{e}"))
        })
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_status(server: McpServerConfig) -> Result<OauthStatusInfo, String> {
    let target = oauth_server_of(&server)?;
    run_blocking("mcp_oauth_status", move || Ok(mcp_oauth::status(&target))).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_clear(server_id: String) -> Result<(), String> {
    run_blocking("mcp_oauth_clear", move || {
        let id = server_id.trim().to_string();
        if id.is_empty() {
            return Err("server_id 不能为空".to_string());
        }
        mcp_oauth::clear(&id)
    })
    .await
}
