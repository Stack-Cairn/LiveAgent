//! 经 CDP 把 cookies 写入 LiveAgent 自有浏览器（browser-level `Storage.setCookies`）。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::super::cdp::CdpConnection;

/// 每批 cookie 数。`Storage.setCookies` 只要有一条字段非法就整批报错，批次
/// 适中可把失败后的逐条重试控制在小范围。
pub(crate) const SET_COOKIES_BATCH: usize = 100;
const CDP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REPORTED_ERRORS: usize = 5;

/// browser-level CDP 调用的最小抽象（测试用假实现记录调用）。
#[async_trait]
pub trait CdpCaller: Send + Sync {
    async fn call_browser(&self, method: &str, params: Value) -> Result<Value, String>;

    /// 连接已断开时提前终止逐条重试，避免对死连接逐条超时。
    fn is_closed(&self) -> bool {
        false
    }
}

#[async_trait]
impl CdpCaller for CdpConnection {
    async fn call_browser(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call(None, method, params, CDP_TIMEOUT).await
    }

    fn is_closed(&self) -> bool {
        CdpConnection::is_closed(self)
    }
}

/// 导入目标：能给出"LiveAgent 自有 profile 浏览器"的 browser-level CDP 连接。
/// 由内置浏览器面板（`EmbeddedBrowserManager`，独立 profile）实现；自动化工具
/// 的 BrowserManager 可能驱动用户日常浏览器（extension 模式），不作为导入目标。
#[async_trait]
pub trait ImportTarget: Send + Sync {
    async fn cdp_caller(&self) -> Result<Arc<dyn CdpCaller>, String>;
}

pub(crate) const IN_APP_BROWSER_NOT_RUNNING: &str =
    "内置浏览器未运行：请先打开 LiveAgent 的浏览器面板，再导入登录态。";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ApplyReport {
    pub applied: usize,
    pub failed: usize,
    /// 前几条失败信息（截断）。
    pub errors: Vec<String>,
}

impl ApplyReport {
    fn record_error(&mut self, error: String) {
        if self.errors.len() < MAX_REPORTED_ERRORS {
            self.errors.push(error);
        }
    }
}

/// 分批 `Storage.setCookies`（不带 browserContextId = 默认上下文，即持久 profile）。
/// 某批失败（单条非法会拖垮整批）时逐条重试，把坏 cookie 隔离出来。
pub async fn apply_cookies_via_cdp(caller: &dyn CdpCaller, cookies: &[Value]) -> ApplyReport {
    let mut report = ApplyReport::default();
    for batch in cookies.chunks(SET_COOKIES_BATCH) {
        if caller.is_closed() {
            report.failed += batch.len();
            continue;
        }
        match set_cookies(caller, batch).await {
            Ok(()) => report.applied += batch.len(),
            Err(batch_error) if batch.len() == 1 => {
                report.failed += 1;
                report.record_error(batch_error);
            }
            Err(_) => {
                for cookie in batch {
                    if caller.is_closed() {
                        report.failed += 1;
                        continue;
                    }
                    match set_cookies(caller, std::slice::from_ref(cookie)).await {
                        Ok(()) => report.applied += 1,
                        Err(error) => {
                            report.failed += 1;
                            let name = cookie.get("name").and_then(Value::as_str).unwrap_or("?");
                            report.record_error(format!("{name}: {error}"));
                        }
                    }
                }
            }
        }
    }
    report
}

async fn set_cookies(caller: &dyn CdpCaller, batch: &[Value]) -> Result<(), String> {
    caller
        .call_browser("Storage.setCookies", json!({ "cookies": batch }))
        .await
        .map(|_| ())
}
