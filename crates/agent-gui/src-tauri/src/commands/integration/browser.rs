use std::sync::Arc;

use serde::Serialize;
use tauri::{Manager, State};

use crate::services::browser::types::{
    BrowserActionArgs, BrowserActionResponse, BrowserStatusResponse,
};
use crate::services::browser::BrowserManager;

#[tauri::command]
pub async fn browser_action(
    state: State<'_, Arc<BrowserManager>>,
    args: BrowserActionArgs,
) -> Result<BrowserActionResponse, String> {
    let manager = Arc::clone(&state);
    let mut args = args;
    // 浏览器接入模式以持久化设置为唯一权威（同 load_runtime_command_safety_mode
    // 范式）：不信任渲染进程/网关透传，改设置后下一次动作即生效。
    args.browser_mode = Some(
        crate::commands::settings::load_runtime_browser_automation_mode(),
    );
    manager.execute(args).await
}

#[tauri::command]
pub async fn browser_status(
    state: State<'_, Arc<BrowserManager>>,
) -> Result<BrowserStatusResponse, String> {
    let manager = Arc::clone(&state);
    Ok(manager.status().await)
}

#[tauri::command]
pub async fn browser_close(state: State<'_, Arc<BrowserManager>>) -> Result<(), String> {
    let manager = Arc::clone(&state);
    manager.close().await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserExtensionInstallInfo {
    /// 扩展是否已连上桥接服务（已连即视为安装完成）。
    pub connected: bool,
    /// 扩展源码目录（chrome://extensions「加载已解压的扩展程序」的目标）。
    /// dev 跑仓库源码目录；打包后为 bundle resources 内路径。找不到为 None。
    pub extension_dir: Option<String>,
}

/// 设置页安装引导：返回扩展连接状态与本机扩展目录。Chrome 不允许外部进程
/// 静默安装扩展（企业策略除外），能自动化的上限就是给出目录 + 步骤引导。
#[tauri::command]
pub fn browser_extension_install_info(
    app: tauri::AppHandle,
    state: State<'_, Arc<BrowserManager>>,
) -> BrowserExtensionInstallInfo {
    let connected = state.extension_connected();
    // 打包产物：bundle resources 下的 browser-extension/（tauri.conf.json
    // resources 声明）；dev：仓库内 crates/agent-gui/browser-extension/。
    let extension_dir = app
        .path()
        .resolve("browser-extension", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|path| path.join("manifest.json").is_file())
        .or_else(|| {
            let dev_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(|gui| gui.join("browser-extension"));
            dev_dir.filter(|path| path.join("manifest.json").is_file())
        })
        .map(|path| path.display().to_string());
    BrowserExtensionInstallInfo {
        connected,
        extension_dir,
    }
}

/// 在系统文件管理器中打开扩展目录（引导用户去 chrome://extensions 加载）。
#[tauri::command]
pub fn browser_extension_reveal_dir(
    app: tauri::AppHandle,
    state: State<'_, Arc<BrowserManager>>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let info = browser_extension_install_info(app.clone(), state);
    let dir = info
        .extension_dir
        .ok_or_else(|| "未找到浏览器扩展目录".to_string())?;
    app.opener()
        .open_path(dir, None::<String>)
        .map_err(|e| format!("打开扩展目录失败：{e}"))
}
