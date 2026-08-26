//! `cua-driver` 引导命令桥。
//!
//! 只覆盖「装没装 / 装一下 / 授权了没」这段引导；真正的计算机操作能力
//! 走通用 MCP 链路（`cua-driver mcp` 是一个普通 stdio MCP server，由
//! `commands/integration/mcp.rs` 驱动，工具从 `tools/list` 发现）。
//!
//! 放在 `integration/` 而不是自成一域，正是因为它属于 MCP 接入的一部分。

use tauri::AppHandle;

use crate::services::cua_driver::{
    self, CuaDriverPermissions, CuaDriverProbe, InstallCommandPreview,
};

/// 探测二进制位置、版本与 MCP 调用方式。未安装返回 `installed: false`，
/// 不是错误。只读，无副作用。
#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_probe() -> Result<CuaDriverProbe, String> {
    tauri::async_runtime::spawn_blocking(cua_driver::probe)
        .await
        .map_err(|error| format!("cua_driver_probe join failed: {error}"))
}

/// 返回将要执行的安装命令**全文**，不执行。
///
/// UI 必须先把 `display` 展示给用户并取得显式确认，才允许调
/// `cua_driver_install`：那条命令会从网络下载一段 shell 脚本并直接
/// 执行，用户有权先看清楚。
#[tauri::command(rename_all = "camelCase")]
pub fn cua_driver_install_command() -> InstallCommandPreview {
    cua_driver::install_command_preview()
}

/// 执行官方安装脚本，进度经 `cua_driver_install_progress` 事件流式回传。
///
/// 前置条件由 UI 保证：用户已看过 `cua_driver_install_command` 的输出
/// 并确认。这里不做二次弹窗——后端没有 UI 上下文，弹不出可信的确认。
#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_install(app: AppHandle) -> Result<CuaDriverProbe, String> {
    tauri::async_runtime::spawn_blocking(move || cua_driver::install(&app))
        .await
        .map_err(|error| format!("cua_driver_install join failed: {error}"))?
}

/// 读取 macOS 的 Accessibility / Screen Recording 授权状态。只读，
/// 不触发系统授权弹窗。非 macOS 返回 `supported: false`。
#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_permissions_status() -> Result<CuaDriverPermissions, String> {
    tauri::async_runtime::spawn_blocking(cua_driver::permissions_status)
        .await
        .map_err(|error| format!("cua_driver_permissions_status join failed: {error}"))
}

/// 触发上游的授权引导：拉起 CuaDriver.app 并请求两项权限。会弹系统
/// 对话框——授权归属 CuaDriver.app（而非 LiveAgent），这是上游推荐的
/// 唯一正确路径。
#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_permissions_grant() -> Result<CuaDriverPermissions, String> {
    tauri::async_runtime::spawn_blocking(cua_driver::permissions_grant)
        .await
        .map_err(|error| format!("cua_driver_permissions_grant join failed: {error}"))?
}
