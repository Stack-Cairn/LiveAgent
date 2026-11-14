use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{Manager, State};

use crate::services::browser::embedded::{
    EmbeddedBrowserCdpEndpoint, EmbeddedBrowserManager, EmbeddedBrowserState, EmbeddedKeyInput,
    EmbeddedMouseInput, EmbeddedViewport,
};
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
    args.browser_mode = Some(crate::commands::settings::load_runtime_browser_automation_mode());
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

// ---- 嵌入式浏览器面板（右侧停靠区 / 工作台 Browser 面板）----
// 与上面的 Browser 自动化工具相互独立：独立 profile、独立进程。

#[tauri::command]
pub async fn embedded_browser_status(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
) -> Result<EmbeddedBrowserState, String> {
    Ok(state.state())
}

/// 面板 CDP 端点（未运行时为 null），供 Agent 附着到面板当前页面。
#[tauri::command]
pub async fn embedded_browser_cdp_endpoint(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
) -> Result<Option<EmbeddedBrowserCdpEndpoint>, String> {
    Ok(state.cdp_endpoint())
}

#[tauri::command]
pub async fn embedded_browser_open(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
    url: Option<String>,
    viewport: Option<EmbeddedViewport>,
) -> Result<EmbeddedBrowserState, String> {
    let manager = Arc::clone(&state);
    manager.open(url, viewport).await
}

#[tauri::command]
pub async fn embedded_browser_navigate(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
    tab_id: Option<String>,
    url: String,
) -> Result<EmbeddedBrowserState, String> {
    let manager = Arc::clone(&state);
    manager.navigate(tab_id, url).await
}

/// `action`：back / forward / reload / stop。
#[tauri::command]
pub async fn embedded_browser_history(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
    tab_id: Option<String>,
    action: String,
) -> Result<EmbeddedBrowserState, String> {
    let manager = Arc::clone(&state);
    manager.history(tab_id, action.trim()).await
}

#[tauri::command]
pub async fn embedded_browser_resize(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
    viewport: EmbeddedViewport,
) -> Result<(), String> {
    let manager = Arc::clone(&state);
    manager.resize(viewport).await
}

#[tauri::command]
pub async fn embedded_browser_new_tab(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
    url: Option<String>,
) -> Result<EmbeddedBrowserState, String> {
    let manager = Arc::clone(&state);
    manager.new_tab(url).await
}

#[tauri::command]
pub async fn embedded_browser_close_tab(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
    tab_id: String,
) -> Result<EmbeddedBrowserState, String> {
    let manager = Arc::clone(&state);
    manager.close_tab(tab_id).await
}

#[tauri::command]
pub async fn embedded_browser_activate_tab(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
    tab_id: String,
) -> Result<EmbeddedBrowserState, String> {
    let manager = Arc::clone(&state);
    manager.activate_tab(tab_id).await
}

#[tauri::command]
pub async fn embedded_browser_mouse(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
    input: EmbeddedMouseInput,
) -> Result<(), String> {
    let manager = Arc::clone(&state);
    manager.mouse(input).await
}

#[tauri::command]
pub async fn embedded_browser_key(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
    input: EmbeddedKeyInput,
) -> Result<(), String> {
    let manager = Arc::clone(&state);
    manager.key(input).await
}

#[tauri::command]
pub async fn embedded_browser_insert_text(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
    text: String,
) -> Result<(), String> {
    let manager = Arc::clone(&state);
    manager.insert_text(text).await
}

/// 活动标签页视口 PNG（base64）。
#[tauri::command]
pub async fn embedded_browser_screenshot(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
) -> Result<String, String> {
    let manager = Arc::clone(&state);
    manager.screenshot().await
}

/// 等待用户在面板中点选元素；取消返回 null。
#[tauri::command]
pub async fn embedded_browser_pick_element(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
) -> Result<Option<serde_json::Value>, String> {
    let manager = Arc::clone(&state);
    manager.pick_element().await
}

#[tauri::command]
pub async fn embedded_browser_cancel_pick(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
) -> Result<(), String> {
    let manager = Arc::clone(&state);
    manager.cancel_pick_element().await
}

#[tauri::command]
pub async fn embedded_browser_close(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
) -> Result<(), String> {
    let manager = Arc::clone(&state);
    manager.close().await
}

/// 关闭面板浏览器并删除其 profile（cookies、缓存、导入的登录态）。
#[tauri::command]
pub async fn embedded_browser_clear_data(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
) -> Result<(), String> {
    let manager = Arc::clone(&state);
    manager.clear_browsing_data().await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserExtensionInstallInfo {
    /// 扩展是否已连上桥接服务（已连即视为安装完成）。
    pub connected: bool,
    /// 扩展安装目录（chrome://extensions「加载已解压的扩展程序」的目标），
    /// 固定为 `~/.liveagent/extension`。同步失败（找不到内置资源）为 None。
    pub extension_dir: Option<String>,
}

/// 扩展的稳定安装目录：`~/.liveagent/extension`。Chrome 加载解压扩展记录的
/// 是绝对路径——若直接指向 bundle resources，应用更新（安装目录整体替换）
/// 或 .app 移动后即失效；固定到 .liveagent 下路径终身稳定，内容由每次启动
/// 的同步保持最新。
fn liveagent_extension_dir() -> Option<PathBuf> {
    // Chrome 记录的是绝对路径，自定义数据目录时也固定留在默认根目录。
    crate::runtime::data_home::default_data_root().map(|root| root.join("extension"))
}

/// 同步数据源：打包产物为 bundle resources 下的 browser-extension/
/// （tauri.conf.json `bundle.resources` 声明）；dev 下 Tauri 把 resources
/// 拷到 target/debug/，再兜底仓库内 crates/agent-gui/browser-extension/。
fn bundled_extension_source(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .resolve("browser-extension", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|path| path.join("manifest.json").is_file())
        .or_else(|| {
            let dev_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(|gui| gui.join("browser-extension"));
            dev_dir.filter(|path| path.join("manifest.json").is_file())
        })
}

/// 应用启动时把内置扩展同步到 `~/.liveagent/extension`（整目录替换）。
/// 应用更新后重启即拿到新版扩展文件，Chrome 里已加载的目录无需重选。
pub fn sync_bundled_browser_extension(app: &tauri::AppHandle) -> Result<(), String> {
    let source =
        bundled_extension_source(app).ok_or_else(|| "未找到内置浏览器扩展资源".to_string())?;
    let dest = liveagent_extension_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    replace_extension_dir(&source, &dest)
}

/// 用 source 的内容整体替换 dest。先删后拷避免旧版本残留文件；删除失败
/// （如个别文件被外部进程占用）不阻断，退化为按文件覆盖。
fn replace_extension_dir(source: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        let _ = std::fs::remove_dir_all(dest);
    }
    std::fs::create_dir_all(dest).map_err(|e| format!("创建扩展目录失败：{e}"))?;
    for entry in walkdir::WalkDir::new(source)
        .follow_links(false)
        .min_depth(1)
    {
        let entry = entry.map_err(|e| format!("读取扩展资源失败：{e}"))?;
        let rel = entry
            .path()
            .strip_prefix(source)
            .map_err(|e| format!("计算扩展相对路径失败：{e}"))?;
        let target = dest.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("创建扩展目录失败：{e}"))?;
        } else if entry.file_type().is_file() {
            std::fs::copy(entry.path(), &target)
                .map_err(|e| format!("复制扩展文件 {} 失败：{e}", rel.display()))?;
        }
    }
    Ok(())
}

/// 设置页安装引导：返回扩展连接状态与本机扩展目录。Chrome 不允许外部进程
/// 静默安装扩展（企业策略除外），能自动化的上限就是给出目录 + 步骤引导。
#[tauri::command]
pub fn browser_extension_install_info(
    app: tauri::AppHandle,
    state: State<'_, Arc<BrowserManager>>,
) -> BrowserExtensionInstallInfo {
    let connected = state.extension_connected();
    // 常态下启动同步已就位，这里只做存在性检查（5s 轮询须廉价）；目录被
    // 用户手动删除等情况按需补一次同步自愈。
    let extension_dir = liveagent_extension_dir()
        .and_then(|dir| {
            if !dir.join("manifest.json").is_file() {
                sync_bundled_browser_extension(&app).ok()?;
            }
            Some(dir)
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

#[cfg(test)]
mod tests {
    use super::replace_extension_dir;

    #[test]
    fn replace_extension_dir_copies_nested_and_removes_stale_files() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source");
        std::fs::create_dir_all(source.join("icons")).unwrap();
        std::fs::write(source.join("manifest.json"), b"{}").unwrap();
        std::fs::write(source.join("icons").join("icon.png"), b"png").unwrap();

        // dest 已存在旧版本：残留文件必须被清掉，否则可能破坏扩展加载。
        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("stale.js"), b"old").unwrap();

        replace_extension_dir(&source, &dest).unwrap();

        assert!(dest.join("manifest.json").is_file());
        assert_eq!(
            std::fs::read(dest.join("icons").join("icon.png")).unwrap(),
            b"png"
        );
        assert!(!dest.join("stale.js").exists());
    }
}
