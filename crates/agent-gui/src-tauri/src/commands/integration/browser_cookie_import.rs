//! 内置浏览器面板「从本机浏览器导入登录态」：列出本机浏览器 profile，把选中
//! profile 的 cookies 导入面板浏览器的独立 profile。返回值只含计数，绝不回传
//! cookie 值。

use std::sync::Arc;

use tauri::State;

use crate::services::browser::cookie_import::{
    import_cookies, import_key_provider, list_source_profiles, BrowserKind, CookieFilter,
    ImportSummary, SourceProfile,
};
use crate::services::browser::embedded::EmbeddedBrowserManager;

#[tauri::command]
pub async fn embedded_browser_import_sources() -> Result<Vec<SourceProfile>, String> {
    tauri::async_runtime::spawn_blocking(list_source_profiles)
        .await
        .map_err(|e| format!("枚举浏览器 profile 失败：{e}"))
}

/// 前端传 `{ browser, profileDir, domains? }`。源 profile 按 (browser, profileDir)
/// 在重新枚举的结果里匹配，不接受渲染进程给的任意路径。面板浏览器未运行时
/// 先拉起（headless，与面板共用会话），再导入。
#[tauri::command]
pub async fn embedded_browser_import_cookies(
    state: State<'_, Arc<EmbeddedBrowserManager>>,
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
    manager.open(None, None).await?;
    import_cookies(
        manager.as_ref(),
        profile,
        import_key_provider(),
        CookieFilter::new(domains.unwrap_or_default()),
    )
    .await
}
