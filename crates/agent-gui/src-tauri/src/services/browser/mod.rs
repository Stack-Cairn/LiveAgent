//! 浏览器自动化服务（原生 Browser 工具，见 docs/design/browser-automation.md）。
//! BrowserManager 持有至多一个浏览器会话：首个动作按需拉起浏览器并附着页面，
//! 进程随 app 退出或 browser_close 一并回收。

mod cdp;
mod launcher;
mod page;
mod snapshot;
pub mod types;

use std::path::PathBuf;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;

use crate::runtime::process::signal_process_tree_by_pid;
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
    /// 当前浏览器进程 pid 的旁路记录：shutdown 时若 `active` 锁被执行中的
    /// 动作占着（try_lock 失败），仍能按 pid 杀进程树，避免退出后残留。
    child_pid: StdMutex<Option<u32>>,
}

impl BrowserManager {
    /// app 真正退出时的清理钩子（Drop 不保证被调）。
    pub fn shutdown_cleanup(&self) {
        if let Ok(mut guard) = self.active.try_lock() {
            // 取出即触发 LaunchedBrowser::drop → kill 进程树。
            guard.take();
        }
        // 兜底：退出瞬间恰有动作在执行时上面的 try_lock 拿不到锁，按记录的
        // pid 直接杀进程树（已死进程重复 signal 无害），防止 profile 被残留
        // 实例锁住导致下次启动失败。
        if let Ok(mut pid) = self.child_pid.lock() {
            if let Some(pid) = pid.take() {
                signal_process_tree_by_pid(pid, true);
            }
        }
    }

    fn record_child_pid(&self, pid: Option<u32>) {
        if let Ok(mut guard) = self.child_pid.lock() {
            *guard = pid;
        }
    }

    pub async fn close(&self) -> Result<(), String> {
        self.active.lock().await.take();
        self.record_child_pid(None);
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
        // 会话失效则丢弃重建。两类失效：WS 断开（用户整个退出浏览器），以及
        // WS 仍在但页面 target 没了（用户只关掉自动化窗口/标签页、tab 崩溃——
        // browser-level 连接不会因此断开）。target 探测走 browser-level 命令，
        // 不受页面 JS 卡死影响。
        let session_dead = match guard.as_ref() {
            Some(active) => !active.page.is_connected() || !active.page.target_alive().await,
            None => false,
        };
        if session_dead {
            guard.take();
            self.record_child_pid(None);
        }
        if guard.is_none() {
            let started = start_browser().await?;
            self.record_child_pid(Some(started.launched.child_pid()));
            *guard = Some(started);
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
                // text 只要求"有传"，不 trim 也不拒绝空串：前后空格可能是刻意
                // 输入，空串则表示清空字段（page 层做全选删除）。
                let text = args
                    .text
                    .clone()
                    .ok_or_else(|| "type 缺少必需参数 text".to_string())?;
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
            match active.page.snapshot(timeout).await {
                Ok(text) => Some(text),
                // snapshot 本身就是动作目的时失败必须上抛；附带 snapshot 失败
                // 则不能连累已成功执行的动作（如 click 触发导航后 AX 树短暂
                // 不可用）——否则模型会误判动作失败而重试，重复副作用。
                Err(err) if action == "snapshot" => return Err(err),
                Err(err) => {
                    let note = format!("动作已执行成功，但自动附带 snapshot 失败：{err}。可稍后单独执行 snapshot 重试。");
                    result_text = Some(match result_text.take() {
                        Some(prev) => format!("{prev}\n{note}"),
                        None => note,
                    });
                    None
                }
            }
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

#[cfg(test)]
mod e2e_tests {
    use super::*;
    use base64::Engine;

    /// 验收闭环手动 e2e：导航文档站 → a11y snapshot → 截图落盘。
    /// 需要本机已装 Chrome/Edge，不进 CI：
    /// `cargo test -p liveagent browser_e2e -- --ignored --nocapture`
    /// 截图输出路径可用 LIVEAGENT_BROWSER_E2E_SHOT 覆盖。
    #[test]
    #[ignore = "requires an installed Chromium-family browser; manual acceptance evidence"]
    fn browser_e2e_manual() {
        tauri::async_runtime::block_on(async {
            let manager = BrowserManager::default();

            let navigated = manager
                .execute(BrowserActionArgs {
                    action: "navigate".to_string(),
                    url: Some("https://tauri.app".to_string()),
                    ..Default::default()
                })
                .await
                .expect("navigate should succeed");
            let snapshot = navigated.snapshot.expect("navigate returns a snapshot");
            println!(
                "== navigate ==\nurl={:?} title={:?}\nsnapshot chars={} (~{} tokens)\n{}",
                navigated.url,
                navigated.title,
                snapshot.len(),
                snapshot.len() / 4,
                snapshot
            );
            assert!(snapshot.contains("[ref=e"), "snapshot should carry ref ids");
            assert!(snapshot.len() < 32_000, "snapshot must stay within budget");

            let shot = manager
                .execute(BrowserActionArgs {
                    action: "screenshot".to_string(),
                    ..Default::default()
                })
                .await
                .expect("screenshot should succeed");
            let data = shot
                .screenshot_base64
                .expect("screenshot returns base64 data");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&data)
                .expect("screenshot base64 decodes");
            let out = std::env::var("LIVEAGENT_BROWSER_E2E_SHOT")
                .unwrap_or_else(|_| "browser-e2e-screenshot.jpg".to_string());
            std::fs::write(&out, &bytes).expect("screenshot file writes");
            println!("== screenshot == {} bytes -> {out}", bytes.len());

            manager.close().await.expect("close should succeed");
        });
    }
}
