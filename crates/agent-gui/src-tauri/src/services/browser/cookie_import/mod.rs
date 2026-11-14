//! 从本机已安装的 Chromium 系浏览器（Chrome/Edge/Chromium/Brave）导入登录态
//! （cookies）到内置浏览器面板的独立 profile。用户在面板菜单里手动触发，纯本地。
//!
//! 流程：
//! 1. `list_source_profiles`：按平台枚举浏览器 user-data 目录，读 `Local State`
//!    的 `profile.info_cache` 列出 profile；
//! 2. `read_cookies`：把 `Cookies` SQLite（含 -wal/-journal）复制到私有临时目录
//!    再读，避免与运行中的浏览器争锁；按平台方案解密 `encrypted_value`；
//!    转成 CDP `Network.CookieParam`；
//! 3. `apply_cookies_via_cdp`：browser-level `Storage.setCookies` 分批写入。
//!
//! 密钥获取（macOS Keychain / Linux secret service / Windows DPAPI）全部经
//! `KeyProvider` trait，测试注入假实现，绝不触碰真实钥匙串。
//!
//! 已知限制：Windows Chrome 127+ 的 app-bound 加密（`v20`）第三方无法解密，
//! 这类 cookie 计入 skipped（reason = appBoundEncryption）而非整体失败；
//! localStorage（LevelDB）暂不导入。

mod apply;
mod crypto;
mod discovery;
mod keys;
mod reader;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

// 部分类型目前只有测试与 trait 签名引用。
pub(crate) use apply::IN_APP_BROWSER_NOT_RUNNING;
#[allow(unused_imports)]
pub use apply::{apply_cookies_via_cdp, ApplyReport, CdpCaller, ImportTarget};
#[allow(unused_imports)]
pub use discovery::{list_source_profiles, BrowserKind, CookieCrypto, SourceProfile};
#[allow(unused_imports)]
pub use keys::{import_key_provider, KeyProvider, SystemKeyProvider};
pub use reader::read_cookies;

/// 只导入指定站点的 cookie；`domains` 为空表示全部。匹配规则：host 等于该域名
/// 或是其子域（`example.com` 命中 `.example.com`、`a.example.com`）。
#[derive(Clone, Debug, Default)]
pub struct CookieFilter {
    pub domains: Vec<String>,
}

impl CookieFilter {
    pub fn new(domains: impl IntoIterator<Item = String>) -> Self {
        let domains = domains
            .into_iter()
            .map(|domain| domain.trim().trim_start_matches('.').to_ascii_lowercase())
            .filter(|domain| !domain.is_empty())
            .collect();
        Self { domains }
    }

    pub fn matches(&self, host_key: &str) -> bool {
        if self.domains.is_empty() {
            return true;
        }
        let host = host_key.trim_start_matches('.').to_ascii_lowercase();
        self.domains.iter().any(|domain| {
            host == *domain
                || (host.len() > domain.len()
                    && host.ends_with(domain.as_str())
                    && host.as_bytes()[host.len() - domain.len() - 1] == b'.')
        })
    }
}

/// cookie 被跳过的原因（稳定的 camelCase 代码，前端据此本地化展示）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    /// 已过期的持久 cookie。
    Expired,
    /// Windows Chrome 127+ app-bound 加密（`v20`），只有浏览器自身的提权服务
    /// 能解出密钥，第三方无法解密。
    AppBoundEncryption,
    /// 解密所需密钥拿不到（用户拒绝钥匙串授权、secret service 不可用等）。
    KeyUnavailable,
    /// 解密失败（密钥不匹配、数据损坏、明文非 UTF-8）。
    DecryptFailed,
    /// 未知的加密前缀/格式。
    UnsupportedEncryption,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedCookies {
    pub reason: SkipReason,
    pub count: usize,
}

/// `read_cookies` 的结果。`cookies` 含明文 cookie 值，只在后端内存里流转、
/// 直接交给 CDP——刻意不实现 Serialize，防止误把它返回给渲染进程或写日志。
#[derive(Debug, Default)]
pub struct ImportReport {
    /// CDP `Network.CookieParam` 对象。
    pub cookies: Vec<Value>,
    /// 按原因聚合的跳过计数（按 reason 排序，count > 0）。
    pub skipped: Vec<SkippedCookies>,
    /// 通过域名过滤的 cookie 行数（= cookies.len() + skipped 总数）。
    pub total: usize,
    /// 解密密钥获取失败的说明（如用户拒绝钥匙串授权），供 UI 提示；无则 None。
    pub key_error: Option<String>,
}

/// 一次完整导入的计数摘要（返回给前端，不含任何 cookie 值）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub total: usize,
    pub imported: usize,
    pub failed: usize,
    pub skipped: Vec<SkippedCookies>,
    pub key_error: Option<String>,
    /// CDP 写入失败的前几条错误信息（截断），便于诊断。
    pub errors: Vec<String>,
}

/// 完整导入：先确认目标浏览器可用（避免白弹一次钥匙串授权），再读源 profile
/// 的 cookies（阻塞 IO + 可能的系统授权弹窗，放 blocking 线程），最后经 CDP 写入。
pub async fn import_cookies(
    target: &dyn ImportTarget,
    profile: SourceProfile,
    keys: Arc<dyn KeyProvider>,
    filter: CookieFilter,
) -> Result<ImportSummary, String> {
    let caller = target.cdp_caller().await?;
    let report = tauri::async_runtime::spawn_blocking(move || {
        read_cookies(&profile, keys.as_ref(), &filter)
    })
    .await
    .map_err(|e| format!("读取浏览器 cookies 任务 join 失败：{e}"))??;
    let applied = apply_cookies_via_cdp(caller.as_ref(), &report.cookies).await;
    Ok(ImportSummary {
        total: report.total,
        imported: applied.applied,
        failed: applied.failed,
        skipped: report.skipped,
        key_error: report.key_error,
        errors: applied.errors,
    })
}
