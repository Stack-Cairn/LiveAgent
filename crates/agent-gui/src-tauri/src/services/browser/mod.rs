//! 浏览器自动化服务（原生 Browser 工具，见 docs/design/browser-automation.md）。
//! BrowserManager 持有至多一个浏览器会话：首个动作按需拉起浏览器并附着页面，
//! 进程随 app 退出或 browser_close 一并回收。

mod cdp;
mod launcher;
mod page;
mod snapshot;
pub mod types;

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;

use cdp::CdpConnection;
use launcher::{discover_browser_executable, launch_browser, LaunchedBrowser};
use page::PageSession;
use types::{
    effective_timeout_ms, BrowserActionArgs, BrowserActionResponse, BrowserStatusResponse,
};

struct ActiveBrowser {
    launched: LaunchedBrowser,
    page: PageSession,
}

#[derive(Default)]
pub struct BrowserManager {
    active: Mutex<Option<ActiveBrowser>>,
}

impl BrowserManager {
    /// app 真正退出时的清理钩子（Drop 不保证被调）。
    pub fn shutdown_cleanup(&self) {
        if let Ok(mut guard) = self.active.try_lock() {
            // 取出即触发 LaunchedBrowser::drop → kill 进程树。
            guard.take();
        }
    }

    pub async fn close(&self) -> Result<(), String> {
        self.active.lock().await.take();
        Ok(())
    }

    pub async fn status(&self) -> BrowserStatusResponse {
        let guard = self.active.lock().await;
        match guard.as_ref() {
            Some(active) if active.page.is_connected() => {
                let (url, title) = active
                    .page
                    .current_url_and_title()
                    .await
                    .unwrap_or_default();
                BrowserStatusResponse {
                    running: true,
                    url: Some(url),
                    title: Some(title),
                    executable: Some(active.launched.executable.display().to_string()),
                }
            }
            _ => BrowserStatusResponse {
                running: false,
                url: None,
                title: None,
                executable: discover_browser_executable().map(|path| path.display().to_string()),
            },
        }
    }

    pub async fn execute(&self, args: BrowserActionArgs) -> Result<BrowserActionResponse, String> {
        let mut guard = self.active.lock().await;
        // 连接失效（用户手关浏览器等）则丢弃重建。
        if guard
            .as_ref()
            .map(|active| !active.page.is_connected())
            .unwrap_or(false)
        {
            guard.take();
        }
        if guard.is_none() {
            *guard = Some(start_browser().await?);
        }
        let active = guard.as_mut().expect("browser session just ensured");

        let timeout = Duration::from_millis(effective_timeout_ms(args.timeout_ms));
        let action = args.action.trim().to_string();
        let mut result_text: Option<String> = None;
        let mut screenshot: Option<(String, String)> = None;

        match action.as_str() {
            "navigate" => {
                let url = required(&args.url, "navigate", "url")?;
                active.page.navigate(&url, timeout).await?;
            }
            "snapshot" => {}
            "click" => {
                let ref_id = required(&args.ref_id, "click", "ref")?;
                active.page.click(&ref_id, timeout).await?;
            }
            "type" => {
                let ref_id = required(&args.ref_id, "type", "ref")?;
                let text = required(&args.text, "type", "text")?;
                active
                    .page
                    .type_text(&ref_id, &text, args.submit.unwrap_or(false), timeout)
                    .await?;
            }
            "screenshot" => {
                screenshot = Some(active.page.screenshot(timeout).await?);
            }
            "eval" => {
                let expression = required(&args.expression, "eval", "expression")?;
                result_text = Some(active.page.eval(&expression, timeout).await?);
            }
            "wait" => match (&args.selector, args.time_ms) {
                (Some(selector), _) if !selector.trim().is_empty() => {
                    active.page.wait_for_selector(selector, timeout).await?;
                    result_text = Some(format!("selector \"{selector}\" 已出现"));
                }
                (_, Some(time_ms)) => {
                    tokio::time::sleep(Duration::from_millis(time_ms.min(60_000))).await;
                    result_text = Some(format!("已等待 {}ms", time_ms.min(60_000)));
                }
                _ => return Err("wait 需要 selector 或 timeMs 之一".to_string()),
            },
            "back" => {
                active.page.back(timeout).await?;
            }
            other => {
                return Err(format!(
                    "未知 action \"{other}\"（支持 navigate/snapshot/click/type/screenshot/eval/wait/back）"
                ));
            }
        }

        // 页面状态回传：改变页面的动作默认附带新 snapshot，供模型下一步定位。
        let default_include = matches!(
            action.as_str(),
            "navigate" | "snapshot" | "click" | "type" | "back" | "wait"
        );
        let include_snapshot = args.include_snapshot.unwrap_or(default_include);
        let snapshot_text = if include_snapshot {
            Some(active.page.snapshot(timeout).await?)
        } else {
            None
        };
        let (url, title) = active
            .page
            .current_url_and_title()
            .await
            .unwrap_or_default();

        Ok(BrowserActionResponse {
            action,
            url: Some(url),
            title: Some(title),
            snapshot: snapshot_text,
            result: result_text,
            screenshot_base64: screenshot.as_ref().map(|(data, _)| data.clone()),
            screenshot_mime: screenshot.map(|(_, mime)| mime),
        })
    }
}

fn required(value: &Option<String>, action: &str, field: &str) -> Result<String, String> {
    value
        .as_ref()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .ok_or_else(|| format!("{action} 缺少必需参数 {field}"))
}

async fn start_browser() -> Result<ActiveBrowser, String> {
    let executable = discover_browser_executable().ok_or_else(|| {
        "未检测到 Chrome/Edge/Chromium。浏览器自动化需要已安装的 Chromium 系浏览器。".to_string()
    })?;
    let launched = tauri::async_runtime::spawn_blocking({
        let executable = executable.clone();
        move || launch_browser(&executable)
    })
    .await
    .map_err(|e| format!("启动浏览器任务 join 失败：{e}"))??;

    let ws_url = fetch_browser_ws_url(launched.debug_port).await?;
    let connection = CdpConnection::connect(&ws_url).await?;
    let page = PageSession::attach(connection).await?;
    Ok(ActiveBrowser { launched, page })
}

/// `GET http://127.0.0.1:<port>/json/version` → webSocketDebuggerUrl。
async fn fetch_browser_ws_url(port: u16) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{port}/json/version");
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求 DevTools 元数据失败：{e}"))?;
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("解析 DevTools 元数据失败：{e}"))?;
    body.get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "DevTools 元数据缺少 webSocketDebuggerUrl".to_string())
}

/// 供状态查询暴露独立 profile 路径（诊断用）。
#[allow(dead_code)]
pub fn profile_dir() -> Result<PathBuf, String> {
    launcher::automation_profile_dir()
}
