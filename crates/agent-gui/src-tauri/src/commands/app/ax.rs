//! 无障碍（AX）辅助命令。
//!
//! 这两个命令服务于「外部自动化工具驱动 LiveAgent 自身窗口」的场景
//! ——典型是用 `cua-driver` 跑端到端测试时，需要主窗口真的在前台、且
//! NSWindow / WKWebView 的 AX 注解已重新广播，否则拿到的 AX 树是空的。
//!
//! 它们与「LiveAgent 能操作用户电脑」这个功能无关：那条链路已改为把
//! `cua-driver mcp` 当作一个普通 MCP server 接入 MCP Hub，不再有专属
//! 的 Tauri 命令层。
//!
//! 真正的实现在 `crate::cua_window_ready` / `crate::cua_refresh_a11y`
//! （`lib.rs`，因为要触碰 `force_activate_main_window` 与平台相关的
//! NSWindow 细节）；这里只是命令桥。

/// 把主窗口重新推到最前并等待 `is_focused()` 落住，让后续的 AX 查询
/// 能找到 WebView。
#[tauri::command(rename_all = "camelCase")]
pub async fn cua_window_ready(
    window: tauri::WebviewWindow,
) -> Result<crate::CuaWindowReadyResponse, String> {
    Ok(crate::cua_window_ready(window).await)
}

/// 在路由切换、overlay 打开 / 关闭、外部工具主动唤起等场景重新触发
/// NSWindow / WKWebView 的 AX 注解，并回弹广播一次
/// `UIElementCreatedNotification`。
#[tauri::command(rename_all = "camelCase")]
pub fn cua_refresh_a11y(window: tauri::WebviewWindow) -> crate::CuaRefreshA11yResponse {
    crate::cua_refresh_a11y(&window)
}
