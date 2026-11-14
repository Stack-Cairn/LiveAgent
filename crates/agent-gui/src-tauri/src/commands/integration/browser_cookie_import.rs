//! 设置页「导入 Chrome 登录态」：列出本机浏览器 profile，把选中 profile 的
//! cookies 导入 LiveAgent 自有浏览器。返回值只含计数，绝不回传 cookie 值。

use std::sync::Arc;

use tauri::State;

use crate::services::browser::cookie_import::{
    import_cookies, list_source_profiles, BrowserKind, CookieFilter, ImportSummary, SourceProfile,
    SystemKeyProvider,
};
use crate::services::browser::BrowserManager;

#[tauri::command]
pub async fn browser_import_sources() -> Result<Vec<SourceProfile>, String> {
    tauri::async_runtime::spawn_blocking(list_source_profiles)
        .await
        .map_err(|e| format!("枚举浏览器 profile 失败：{e}"))
}

/// 前端传 `{ browser, profileDir, domains? }`。源 profile 按 (browser, profileDir)
/// 在重新枚举的结果里匹配，不接受渲染进程给的任意路径。
#[tauri::command]
pub async fn browser_import_cookies(
    state: State<'_, Arc<BrowserManager>>,
    browser: String,
    profile_dir: String,
    domains: Option<Vec<String>>,
) -> Result<ImportSummary, String> {
    let kind = BrowserKind::parse(&browser).ok_or_else(|| format!("不支持的浏览器：{browser}"))?;
    let profile = tauri::async_runtime::spawn_blocking(list_source_profiles)
        .await
        .map_err(|e| format!("枚举浏览器 profile 失败：{e}"))?
        .into_iter()
        .find(|profile| profile.browser == kind && profile.profile_dir == profile_dir)
        .ok_or_else(|| format!("未找到 {} 的 profile「{profile_dir}」", kind.display_name()))?;
    let manager = Arc::clone(&state);
    import_cookies(
        manager.as_ref(),
        profile,
        Arc::new(SystemKeyProvider),
        CookieFilter::new(domains.unwrap_or_default()),
    )
    .await
}
