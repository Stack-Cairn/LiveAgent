//! 嵌入式浏览器面板（右侧停靠区 / 工作台里的 Browser 面板）的后端。
//!
//! 与自动化工具（BrowserManager）完全独立：以 headless 方式拉起一个使用
//! `data_root()/embedded-browser-profile` 独立 profile 的 Chromium 系浏览器，
//! 通过 CDP 管理多标签页、把活动标签页的 screencast 帧推给前端渲染，并把前端
//! 的鼠标/键盘输入转发回页面。调试端口只监听 127.0.0.1，`cdp_endpoint()`
//! 暴露给后续"Agent 附着到当前面板"能力使用。

use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use super::cdp::{CdpConnection, CdpEvent};
use super::cookie_import::{CdpCaller, ImportTarget};
use super::fetch_browser_ws_url;
use super::launcher::{discover_browser_executable, launch_browser_with, LaunchedBrowser};
use crate::runtime::process::signal_process_tree_by_pid;

/// 活动标签页的 screencast 帧（JPEG base64）。
pub const EMBEDDED_BROWSER_FRAME_EVENT: &str = "embedded-browser://frame";
/// 标签页/会话状态快照（每次变化推送完整快照，前端无需做增量合并）。
pub const EMBEDDED_BROWSER_STATE_EVENT: &str = "embedded-browser://state";
/// 单个面板的标签页上限：防止页面脚本无限 window.open 拖垮进程。
pub const MAX_EMBEDDED_TABS: usize = 32;

const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// 元素拾取等待用户点击，给足时间；取消走 `cancel_pick_element`。
const PICK_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PICKER_SCRIPT: &str = include_str!("embedded_picker.js");
const PICKER_CANCEL_SCRIPT: &str = "(() => { const picker = window.__liveagentElementPicker; if (picker && typeof picker.cancel === 'function') { picker.cancel(); return true; } return false; })()";
const SCREENCAST_JPEG_QUALITY: u32 = 80;

/// CDP Input 修饰键位掩码（CDP 自己的定义：Alt=1, Ctrl=2, Meta=4, Shift=8）。
pub const MODIFIER_CTRL: u32 = 2;
pub const MODIFIER_META: u32 = 4;
pub const MODIFIER_SHIFT: u32 = 8;

/// 事件推送回调：`(事件名, payload)`。lib.rs 用 AppHandle::emit 实现；
/// 测试里换成 channel，免得依赖 Tauri 运行时。
pub type EmbeddedBrowserEmitter = Arc<dyn Fn(&'static str, Value) + Send + Sync>;

/// 面板专用 profile：与自动化工具的 `browser-profile`、用户日常浏览器都隔离。
pub fn embedded_profile_dir() -> Result<PathBuf, String> {
    let root =
        crate::runtime::data_home::data_root().ok_or_else(|| "无法定位用户主目录".to_string())?;
    Ok(root.join("embedded-browser-profile"))
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedViewport {
    /// CSS 像素宽度（面板内帧区域的尺寸）。
    pub width: u32,
    pub height: u32,
    /// 设备像素比，决定 screencast 帧的实际分辨率（Retina 下为 2）。
    #[serde(default = "default_scale_factor")]
    pub device_scale_factor: f64,
}

fn default_scale_factor() -> f64 {
    1.0
}

impl Default for EmbeddedViewport {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 800,
            device_scale_factor: 1.0,
        }
    }
}

impl EmbeddedViewport {
    /// 夹到合理区间：面板拖到极窄时也给页面留最小布局宽度，DPR 非法值回落 1。
    pub fn sanitized(self) -> Self {
        let scale = if self.device_scale_factor.is_finite() {
            self.device_scale_factor.clamp(1.0, 3.0)
        } else {
            1.0
        };
        Self {
            width: self.width.clamp(160, 4096),
            height: self.height.clamp(120, 4096),
            device_scale_factor: scale,
        }
    }

    fn screencast_max(self) -> (u32, u32) {
        let scale = self.device_scale_factor;
        (
            (f64::from(self.width) * scale).round() as u32,
            (f64::from(self.height) * scale).round() as u32,
        )
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedTabState {
    pub id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    /// 最近一次导航失败原因（net::ERR_* 等）；重新开始加载时清空。
    pub error: Option<String>,
}

/// 供"Agent 附着到当前面板"后续能力使用的 CDP 端点。仅监听 127.0.0.1。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserCdpEndpoint {
    pub port: u16,
    /// `http://127.0.0.1:<port>`：`/json/version`、`/json/list` 等 HTTP 入口。
    pub http_url: String,
    /// browser-level WebSocket（`ws://127.0.0.1:<port>/devtools/browser/<id>`）。
    pub websocket_url: String,
    /// 面板当前活动标签页的 targetId（可直接 Target.attachToTarget）。
    pub active_target_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserState {
    pub running: bool,
    /// 本机是否探测到可用的 Chromium 系浏览器（面板据此提示安装）。
    pub browser_available: bool,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<EmbeddedTabState>,
    pub viewport: Option<EmbeddedViewport>,
    pub cdp: Option<EmbeddedBrowserCdpEndpoint>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedMouseInput {
    /// `move` / `down` / `up` / `wheel`。
    pub kind: String,
    /// 页面视口内的 CSS 像素坐标（前端已按帧显示尺寸换算）。
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub button: Option<String>,
    #[serde(default)]
    pub buttons: Option<u32>,
    #[serde(default)]
    pub click_count: Option<u32>,
    #[serde(default)]
    pub modifiers: Option<u32>,
    #[serde(default)]
    pub delta_x: Option<f64>,
    #[serde(default)]
    pub delta_y: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedKeyInput {
    /// `down` / `up`。
    pub kind: String,
    /// DOM `KeyboardEvent.key`。
    pub key: String,
    /// DOM `KeyboardEvent.code`。
    #[serde(default)]
    pub code: String,
    /// DOM `KeyboardEvent.keyCode`（Windows 虚拟键码，CDP 需要它触发默认行为）。
    #[serde(default)]
    pub key_code: u32,
    #[serde(default)]
    pub modifiers: u32,
}

struct TabEntry {
    state: EmbeddedTabState,
    session_id: String,
}

struct TabsModel {
    tabs: Vec<TabEntry>,
    active: Option<String>,
    viewport: EmbeddedViewport,
    /// 正在 screencast 的标签页 session（只给活动标签页推帧）。
    screencast_session: Option<String>,
}

impl TabsModel {
    fn find(&self, tab_id: &str) -> Option<&TabEntry> {
        self.tabs.iter().find(|tab| tab.state.id == tab_id)
    }

    fn find_mut(&mut self, tab_id: &str) -> Option<&mut TabEntry> {
        self.tabs.iter_mut().find(|tab| tab.state.id == tab_id)
    }

    fn find_by_session_mut(&mut self, session_id: &str) -> Option<&mut TabEntry> {
        self.tabs
            .iter_mut()
            .find(|tab| tab.session_id == session_id)
    }

    fn session_of(&self, tab_id: &str) -> Option<String> {
        self.find(tab_id).map(|tab| tab.session_id.clone())
    }

    fn tab_of_session(&self, session_id: &str) -> Option<String> {
        self.tabs
            .iter()
            .find(|tab| tab.session_id == session_id)
            .map(|tab| tab.state.id.clone())
    }

    /// 移除标签页并在它是活动页时挑选邻居（优先右侧，与常见浏览器一致）。
    /// 返回新的活动标签页 id（若活动页发生变化）。
    fn remove(&mut self, tab_id: &str) -> Option<Option<String>> {
        let index = self.tabs.iter().position(|tab| tab.state.id == tab_id)?;
        let removed = self.tabs.remove(index);
        if self.screencast_session.as_deref() == Some(removed.session_id.as_str()) {
            self.screencast_session = None;
        }
        if self.active.as_deref() != Some(tab_id) {
            return Some(None);
        }
        let next = self
            .tabs
            .get(index)
            .or_else(|| index.checked_sub(1).and_then(|prev| self.tabs.get(prev)))
            .map(|tab| tab.state.id.clone());
        self.active = next.clone();
        Some(next)
    }
}

struct SessionCore {
    connection: Arc<CdpConnection>,
    port: u16,
    websocket_url: String,
    tabs: StdMutex<TabsModel>,
    emitter: Option<EmbeddedBrowserEmitter>,
}

impl SessionCore {
    fn model(&self) -> std::sync::MutexGuard<'_, TabsModel> {
        // 锁中毒只可能来自持锁时 panic；状态仍是一致的数据结构，继续使用。
        self.tabs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn endpoint(&self) -> EmbeddedBrowserCdpEndpoint {
        EmbeddedBrowserCdpEndpoint {
            port: self.port,
            http_url: format!("http://127.0.0.1:{}", self.port),
            websocket_url: self.websocket_url.clone(),
            active_target_id: self.model().active.clone(),
        }
    }

    fn snapshot(&self) -> EmbeddedBrowserState {
        let model = self.model();
        EmbeddedBrowserState {
            running: !self.connection.is_closed(),
            browser_available: true,
            active_tab_id: model.active.clone(),
            tabs: model.tabs.iter().map(|tab| tab.state.clone()).collect(),
            viewport: Some(model.viewport),
            cdp: Some(EmbeddedBrowserCdpEndpoint {
                port: self.port,
                http_url: format!("http://127.0.0.1:{}", self.port),
                websocket_url: self.websocket_url.clone(),
                active_target_id: model.active.clone(),
            }),
        }
    }

    fn emit(&self, event: &'static str, payload: Value) {
        if let Some(emitter) = &self.emitter {
            emitter(event, payload);
        }
    }

    fn emit_state(&self) {
        let snapshot = self.snapshot();
        if let Ok(payload) = serde_json::to_value(snapshot) {
            self.emit(EMBEDDED_BROWSER_STATE_EVENT, payload);
        }
    }

    async fn call(
        &self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.connection
            .call(session_id, method, params, CALL_TIMEOUT)
            .await
    }

    fn active_session(&self) -> Result<(String, String), String> {
        let model = self.model();
        let active = model
            .active
            .clone()
            .ok_or_else(|| "浏览器面板没有活动标签页".to_string())?;
        let session = model
            .session_of(&active)
            .ok_or_else(|| "活动标签页已失效".to_string())?;
        Ok((active, session))
    }

    fn resolve_tab(&self, tab_id: Option<&str>) -> Result<(String, String), String> {
        match tab_id.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => {
                let session = self
                    .model()
                    .session_of(id)
                    .ok_or_else(|| format!("标签页不存在：{id}"))?;
                Ok((id.to_string(), session))
            }
            None => self.active_session(),
        }
    }

    /// attach 一个 page target 并做面板所需的初始化；不改变活动标签页。
    async fn attach_tab(&self, target_id: &str) -> Result<(), String> {
        let attached = self
            .call(
                None,
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
            )
            .await?;
        let session_id = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Target.attachToTarget 未返回 sessionId".to_string())?;
        self.call(Some(&session_id), "Page.enable", json!({}))
            .await?;
        // headless 下页面默认处于"失焦"状态：光标不闪、focus 事件不触发。
        let _ = self
            .call(
                Some(&session_id),
                "Emulation.setFocusEmulationEnabled",
                json!({ "enabled": true }),
            )
            .await;
        let viewport = self.model().viewport;
        let _ = self.apply_viewport(&session_id, viewport).await;

        let info = self
            .call(
                None,
                "Target.getTargetInfo",
                json!({ "targetId": target_id }),
            )
            .await
            .ok()
            .and_then(|value| value.get("targetInfo").cloned())
            .unwrap_or(Value::Null);
        let state = EmbeddedTabState {
            id: target_id.to_string(),
            url: info
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            title: info
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            ..Default::default()
        };
        let mut model = self.model();
        if model.find(target_id).is_none() {
            model.tabs.push(TabEntry { state, session_id });
        }
        Ok(())
    }

    async fn apply_viewport(
        &self,
        session_id: &str,
        viewport: EmbeddedViewport,
    ) -> Result<(), String> {
        self.call(
            Some(session_id),
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": viewport.width,
                "height": viewport.height,
                "deviceScaleFactor": viewport.device_scale_factor,
                "mobile": false,
            }),
        )
        .await
        .map(|_| ())
    }

    async fn start_screencast(
        &self,
        session_id: &str,
        viewport: EmbeddedViewport,
    ) -> Result<(), String> {
        let (max_width, max_height) = viewport.screencast_max();
        self.call(
            Some(session_id),
            "Page.startScreencast",
            json!({
                "format": "jpeg",
                "quality": SCREENCAST_JPEG_QUALITY,
                "maxWidth": max_width,
                "maxHeight": max_height,
                "everyNthFrame": 1,
            }),
        )
        .await
        .map(|_| ())
    }

    /// 切换活动标签页：停掉旧页 screencast、对新页套用视口并开始推帧。
    async fn activate(&self, tab_id: &str) -> Result<(), String> {
        let (previous, next, viewport) = {
            let mut model = self.model();
            let next = model
                .session_of(tab_id)
                .ok_or_else(|| format!("标签页不存在：{tab_id}"))?;
            model.active = Some(tab_id.to_string());
            let previous = model.screencast_session.replace(next.clone());
            (previous, next, model.viewport)
        };
        if let Some(previous) = previous.filter(|previous| previous != &next) {
            let _ = self
                .call(Some(&previous), "Page.stopScreencast", json!({}))
                .await;
        }
        let _ = self
            .call(None, "Target.activateTarget", json!({ "targetId": tab_id }))
            .await;
        self.apply_viewport(&next, viewport).await?;
        self.start_screencast(&next, viewport).await?;
        self.refresh_history(tab_id, &next).await;
        self.emit_state();
        Ok(())
    }

    /// 重新拉取前进/后退可用性与 url/title。headless 下标题变化不一定触发
    /// targetInfoChanged，加载结束/同文档导航时以此兜底。
    async fn refresh_history(&self, tab_id: &str, session_id: &str) {
        if let Ok(history) = self
            .call(Some(session_id), "Page.getNavigationHistory", json!({}))
            .await
        {
            let (can_back, can_forward) = history_flags(&history);
            if let Some(tab) = self.model().find_mut(tab_id) {
                tab.state.can_go_back = can_back;
                tab.state.can_go_forward = can_forward;
            }
        }
        let info = self
            .call(None, "Target.getTargetInfo", json!({ "targetId": tab_id }))
            .await
            .ok()
            .and_then(|value| value.get("targetInfo").cloned());
        if let Some(info) = info {
            if let Some(tab) = self.model().find_mut(tab_id) {
                if let Some(url) = info.get("url").and_then(Value::as_str) {
                    tab.state.url = url.to_string();
                }
                if let Some(title) = info.get("title").and_then(Value::as_str) {
                    tab.state.title = title.to_string();
                }
            }
        }
    }

    async fn create_tab(&self, url: &str) -> Result<String, String> {
        if self.model().tabs.len() >= MAX_EMBEDDED_TABS {
            return Err(format!(
                "浏览器面板最多同时打开 {MAX_EMBEDDED_TABS} 个标签页"
            ));
        }
        let created = self
            .call(None, "Target.createTarget", json!({ "url": url }))
            .await?;
        let target_id = created
            .get("targetId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Target.createTarget 未返回 targetId".to_string())?;
        self.attach_tab(&target_id).await?;
        Ok(target_id)
    }

    /// 标签页消失（关闭/崩溃/页面 window.close()）后的收尾：活动页变化则切到
    /// 邻居；最后一个标签页也没了时补一个空白页，面板始终有可交互的标签页。
    async fn handle_tab_removed(&self, tab_id: &str) {
        let outcome = self.model().remove(tab_id);
        let Some(next_active) = outcome else {
            return;
        };
        if let Some(next) = next_active {
            let _ = self.activate(&next).await;
            return;
        }
        let empty = self.model().tabs.is_empty();
        if empty {
            if let Ok(created) = self.create_tab("about:blank").await {
                let _ = self.activate(&created).await;
                return;
            }
        }
        self.emit_state();
    }

    async fn navigate(&self, tab_id: &str, session_id: &str, url: &str) -> Result<(), String> {
        if let Some(tab) = self.model().find_mut(tab_id) {
            tab.state.error = None;
            tab.state.loading = true;
        }
        self.emit_state();
        let result = self
            .call(Some(session_id), "Page.navigate", json!({ "url": url }))
            .await;
        let error = match &result {
            Ok(value) => value
                .get("errorText")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string),
            Err(error) => Some(error.clone()),
        };
        if let Some(error) = error {
            if let Some(tab) = self.model().find_mut(tab_id) {
                tab.state.error = Some(error);
                tab.state.loading = false;
                tab.state.url = url.to_string();
            }
            self.emit_state();
        }
        result.map(|_| ())
    }
}

/// `Page.frameNavigated` 的主 frame 是否真的到达了页面：Chromium 的网络错误页
/// 也会提交一次导航，但带 `unreachableUrl`（url 为 chrome-error://），此时
/// 应保留 `Page.navigate` 记下的错误，让面板显示错误说明。
fn navigation_reached_page(params: &Value) -> bool {
    let Some(frame) = params.get("frame") else {
        return false;
    };
    let unreachable = frame
        .get("unreachableUrl")
        .and_then(Value::as_str)
        .is_some_and(|url| !url.is_empty());
    let error_page = frame
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(|url| url.starts_with("chrome-error://"));
    !unreachable && !error_page
}

fn history_flags(history: &Value) -> (bool, bool) {
    let current = history
        .get("currentIndex")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let len = history
        .get("entries")
        .and_then(Value::as_array)
        .map(|entries| entries.len() as i64)
        .unwrap_or(0);
    (current > 0, current + 1 < len)
}

/// 地址校验：面板只允许 http/https 与空白页（file:、javascript:、chrome:
/// 等一律拒绝）。地址栏的补全（补 scheme、搜索词）在前端完成。
pub fn validate_navigation_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("地址不能为空".to_string());
    }
    if trimmed == "about:blank" {
        return Ok(trimmed.to_string());
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|e| format!("无效的地址：{e}"))?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some_and(|host| !host.is_empty()) => {
            Ok(parsed.to_string())
        }
        "http" | "https" => Err("地址缺少主机名".to_string()),
        other => Err(format!("浏览器面板不支持 {other}: 协议")),
    }
}

/// 前端鼠标事件 → `Input.dispatchMouseEvent` 参数。
pub fn build_mouse_params(input: &EmbeddedMouseInput) -> Result<Value, String> {
    let kind = match input.kind.as_str() {
        "move" => "mouseMoved",
        "down" => "mousePressed",
        "up" => "mouseReleased",
        "wheel" => "mouseWheel",
        other => return Err(format!("未知鼠标事件类型：{other}")),
    };
    if !input.x.is_finite() || !input.y.is_finite() {
        return Err("鼠标坐标非法".to_string());
    }
    let button = match input.button.as_deref() {
        Some("left") | Some("middle") | Some("right") | Some("back") | Some("forward") => {
            input.button.clone().unwrap_or_default()
        }
        _ if kind == "mousePressed" || kind == "mouseReleased" => "left".to_string(),
        _ => "none".to_string(),
    };
    let mut params = json!({
        "type": kind,
        "x": input.x.max(0.0),
        "y": input.y.max(0.0),
        "button": button,
        "buttons": input.buttons.unwrap_or(0),
        "modifiers": input.modifiers.unwrap_or(0) & 0b1111,
    });
    if kind == "mousePressed" || kind == "mouseReleased" {
        params["clickCount"] = json!(input.click_count.unwrap_or(1).clamp(1, 3));
    }
    if kind == "mouseWheel" {
        params["deltaX"] = json!(finite_or_zero(input.delta_x));
        params["deltaY"] = json!(finite_or_zero(input.delta_y));
    }
    Ok(params)
}

fn finite_or_zero(value: Option<f64>) -> f64 {
    value.filter(|value| value.is_finite()).unwrap_or(0.0)
}

/// 前端键盘事件 → `Input.dispatchKeyEvent` 参数。
///
/// 可打印字符（无 Ctrl/Cmd）用 `keyDown` + text 让页面产生输入；其它键用
/// `rawKeyDown` 只触发默认行为。macOS 上 headless 浏览器不会把 Cmd+A 之类
/// 映射成编辑命令，这里显式附带 `commands`。粘贴不走这里：前端在 paste
/// 事件里读剪贴板文本后调用 insert_text。
pub fn build_key_params(input: &EmbeddedKeyInput, mac_editing: bool) -> Result<Value, String> {
    let modifiers = input.modifiers & 0b1111;
    let primary = if mac_editing {
        MODIFIER_META
    } else {
        MODIFIER_CTRL
    };
    let shortcut = modifiers & (MODIFIER_CTRL | MODIFIER_META) != 0;
    let text = key_text(&input.key).filter(|_| !shortcut);
    let mut params = json!({
        "key": input.key,
        "code": input.code,
        "windowsVirtualKeyCode": input.key_code,
        "nativeVirtualKeyCode": input.key_code,
        "modifiers": modifiers,
    });
    match input.kind.as_str() {
        "down" => {
            if let Some(text) = text {
                params["type"] = json!("keyDown");
                params["text"] = json!(text);
                params["unmodifiedText"] = json!(text);
            } else {
                params["type"] = json!("rawKeyDown");
            }
            if modifiers & primary != 0 {
                if let Some(command) = editing_command(&input.key, modifiers & MODIFIER_SHIFT != 0)
                {
                    params["commands"] = json!([command]);
                }
            }
        }
        "up" => {
            params["type"] = json!("keyUp");
        }
        other => return Err(format!("未知键盘事件类型：{other}")),
    }
    Ok(params)
}

fn key_text(key: &str) -> Option<String> {
    if key == "Enter" {
        return Some("\r".to_string());
    }
    let mut chars = key.chars();
    let first = chars.next()?;
    if chars.next().is_none() && !first.is_control() {
        Some(first.to_string())
    } else {
        None
    }
}

fn editing_command(key: &str, shift: bool) -> Option<&'static str> {
    match (key.to_ascii_lowercase().as_str(), shift) {
        ("a", false) => Some("selectAll"),
        ("c", false) => Some("copy"),
        ("x", false) => Some("cut"),
        ("z", false) => Some("undo"),
        ("z", true) | ("y", false) => Some("redo"),
        _ => None,
    }
}

/// 拾取脚本在页面跳转时会被销毁；这类错误等同于用户取消。
fn is_context_destroyed(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("context was destroyed")
        || lower.contains("cannot find context")
        || lower.contains("target closed")
        || lower.contains("连接已关闭")
}

pub struct EmbeddedBrowserManager {
    /// 串行化启动/关闭；持有浏览器子进程句柄（Drop 即杀进程树）。
    lifecycle: Mutex<Option<LaunchedBrowser>>,
    /// 当前会话核心的同步镜像：普通命令与 `cdp_endpoint()` 不必等 lifecycle 锁
    /// （元素拾取会长时间挂起，不能阻塞其他输入）。
    core: StdMutex<Option<Arc<SessionCore>>>,
    /// shutdown 时 lifecycle 锁被占用的兜底 kill 依据。
    child_pid: StdMutex<Option<u32>>,
    emitter: StdMutex<Option<EmbeddedBrowserEmitter>>,
    viewport: StdMutex<EmbeddedViewport>,
}

impl Default for EmbeddedBrowserManager {
    fn default() -> Self {
        Self {
            lifecycle: Mutex::new(None),
            core: StdMutex::new(None),
            child_pid: StdMutex::new(None),
            emitter: StdMutex::new(None),
            viewport: StdMutex::new(EmbeddedViewport::default()),
        }
    }
}

impl EmbeddedBrowserManager {
    pub fn set_emitter(&self, emitter: EmbeddedBrowserEmitter) {
        if let Ok(mut guard) = self.emitter.lock() {
            *guard = Some(emitter);
        }
    }

    fn live_core(&self) -> Option<Arc<SessionCore>> {
        self.core
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .filter(|core| !core.connection.is_closed())
    }

    fn require_core(&self) -> Result<Arc<SessionCore>, String> {
        self.live_core()
            .ok_or_else(|| "浏览器面板未启动".to_string())
    }

    /// 面板背后浏览器的 CDP 端点（未运行时为 None）。供 Agent 附着到用户正在
    /// 看的页面：拿 `websocket_url` 建 browser-level 连接，再 attach
    /// `active_target_id`。
    pub fn cdp_endpoint(&self) -> Option<EmbeddedBrowserCdpEndpoint> {
        self.live_core().map(|core| core.endpoint())
    }

    pub fn state(&self) -> EmbeddedBrowserState {
        match self.live_core() {
            Some(core) => core.snapshot(),
            None => EmbeddedBrowserState {
                running: false,
                browser_available: discover_browser_executable().is_some(),
                viewport: self.viewport.lock().ok().map(|guard| *guard),
                ..Default::default()
            },
        }
    }

    /// 确保浏览器已启动（必要时拉起），可选地设置视口并在活动标签页打开地址。
    pub async fn open(
        &self,
        url: Option<String>,
        viewport: Option<EmbeddedViewport>,
    ) -> Result<EmbeddedBrowserState, String> {
        if let Some(viewport) = viewport {
            if let Ok(mut guard) = self.viewport.lock() {
                *guard = viewport.sanitized();
            }
        }
        let core = self.ensure_started().await?;
        if let Some(viewport) = viewport {
            self.apply_viewport(&core, viewport.sanitized()).await?;
        }
        if let Some(url) = url.filter(|url| !url.trim().is_empty()) {
            let url = validate_navigation_url(&url)?;
            let (tab_id, session_id) = core.active_session()?;
            core.navigate(&tab_id, &session_id, &url).await?;
        }
        Ok(core.snapshot())
    }

    async fn ensure_started(&self) -> Result<Arc<SessionCore>, String> {
        let mut lifecycle = self.lifecycle.lock().await;
        if let Some(core) = self.live_core() {
            if lifecycle.is_some() {
                return Ok(core);
            }
        }
        // 旧会话失效（浏览器崩溃/被外部杀掉）：丢弃句柄即回收残余进程树。
        lifecycle.take();
        if let Ok(mut core) = self.core.lock() {
            core.take();
        }
        self.record_child_pid(None);

        let executable = discover_browser_executable().ok_or_else(|| {
            "未检测到 Chrome/Edge/Chromium：浏览器面板需要本机已安装 Chromium 系浏览器。"
                .to_string()
        })?;
        let profile_dir = embedded_profile_dir()?;
        let viewport = self.viewport.lock().map(|guard| *guard).unwrap_or_default();
        let launched = tauri::async_runtime::spawn_blocking({
            let executable = executable.clone();
            let args = embedded_launch_args(viewport);
            move || launch_browser_with(&executable, &profile_dir, &args)
        })
        .await
        .map_err(|e| format!("启动浏览器任务 join 失败：{e}"))??;
        let port = launched.debug_port;
        self.record_child_pid(Some(launched.child_pid()));

        let websocket_url = fetch_browser_ws_url(port).await?;
        let connection = CdpConnection::connect(&websocket_url).await?;
        let events = connection.subscribe();
        let emitter = self.emitter.lock().ok().and_then(|guard| guard.clone());
        let core = Arc::new(SessionCore {
            connection,
            port,
            websocket_url,
            tabs: StdMutex::new(TabsModel {
                tabs: Vec::new(),
                active: None,
                viewport,
                screencast_session: None,
            }),
            emitter,
        });
        tauri::async_runtime::spawn(run_event_loop(Arc::downgrade(&core), events));

        core.call(
            None,
            "Target.setDiscoverTargets",
            json!({ "discover": true }),
        )
        .await?;
        let initial = initial_page_target(&core).await?;
        let first = match initial {
            Some(target_id) => {
                core.attach_tab(&target_id).await?;
                target_id
            }
            None => core.create_tab("about:blank").await?,
        };

        *lifecycle = Some(launched);
        if let Ok(mut guard) = self.core.lock() {
            *guard = Some(Arc::clone(&core));
        }
        core.activate(&first).await?;
        Ok(core)
    }

    async fn apply_viewport(
        &self,
        core: &SessionCore,
        viewport: EmbeddedViewport,
    ) -> Result<(), String> {
        let session = {
            let mut model = core.model();
            if model.viewport == viewport {
                return Ok(());
            }
            model.viewport = viewport;
            model.screencast_session.clone()
        };
        if let Some(session) = session {
            core.apply_viewport(&session, viewport).await?;
            // 帧尺寸上限随视口变化，重启 screencast 让分辨率跟上。
            let _ = core
                .call(Some(&session), "Page.stopScreencast", json!({}))
                .await;
            core.start_screencast(&session, viewport).await?;
        }
        core.emit_state();
        Ok(())
    }

    pub async fn resize(&self, viewport: EmbeddedViewport) -> Result<(), String> {
        let viewport = viewport.sanitized();
        if let Ok(mut guard) = self.viewport.lock() {
            *guard = viewport;
        }
        match self.live_core() {
            Some(core) => self.apply_viewport(&core, viewport).await,
            None => Ok(()),
        }
    }

    pub async fn navigate(
        &self,
        tab_id: Option<String>,
        url: String,
    ) -> Result<EmbeddedBrowserState, String> {
        let url = validate_navigation_url(&url)?;
        let core = self.ensure_started().await?;
        let (tab_id, session_id) = core.resolve_tab(tab_id.as_deref())?;
        core.navigate(&tab_id, &session_id, &url).await?;
        Ok(core.snapshot())
    }

    /// `back` / `forward` / `reload` / `stop`。
    pub async fn history(
        &self,
        tab_id: Option<String>,
        action: &str,
    ) -> Result<EmbeddedBrowserState, String> {
        let core = self.require_core()?;
        let (tab_id, session_id) = core.resolve_tab(tab_id.as_deref())?;
        match action {
            "back" | "forward" => {
                let history = core
                    .call(Some(&session_id), "Page.getNavigationHistory", json!({}))
                    .await?;
                let current = history
                    .get("currentIndex")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let target = if action == "back" {
                    current - 1
                } else {
                    current + 1
                };
                let entry_id = usize::try_from(target)
                    .ok()
                    .and_then(|index| {
                        history
                            .get("entries")
                            .and_then(Value::as_array)
                            .and_then(|entries| entries.get(index))
                    })
                    .and_then(|entry| entry.get("id"))
                    .and_then(Value::as_i64);
                if let Some(entry_id) = entry_id {
                    core.call(
                        Some(&session_id),
                        "Page.navigateToHistoryEntry",
                        json!({ "entryId": entry_id }),
                    )
                    .await?;
                }
            }
            "reload" => {
                if let Some(tab) = core.model().find_mut(&tab_id) {
                    tab.state.error = None;
                }
                core.call(Some(&session_id), "Page.reload", json!({}))
                    .await?;
            }
            "stop" => {
                core.call(Some(&session_id), "Page.stopLoading", json!({}))
                    .await?;
            }
            other => return Err(format!("未知导航动作：{other}")),
        }
        Ok(core.snapshot())
    }

    pub async fn new_tab(&self, url: Option<String>) -> Result<EmbeddedBrowserState, String> {
        let url = match url.filter(|url| !url.trim().is_empty()) {
            Some(url) => validate_navigation_url(&url)?,
            None => "about:blank".to_string(),
        };
        let core = self.ensure_started().await?;
        let tab_id = core.create_tab(&url).await?;
        core.activate(&tab_id).await?;
        Ok(core.snapshot())
    }

    pub async fn close_tab(&self, tab_id: String) -> Result<EmbeddedBrowserState, String> {
        let core = self.require_core()?;
        if core.model().find(&tab_id).is_none() {
            return Err(format!("标签页不存在：{tab_id}"));
        }
        let _ = core
            .call(None, "Target.closeTarget", json!({ "targetId": tab_id }))
            .await;
        // 不等 targetDestroyed 事件：直接收尾，事件后到时 remove 已是 no-op。
        core.handle_tab_removed(&tab_id).await;
        Ok(core.snapshot())
    }

    pub async fn activate_tab(&self, tab_id: String) -> Result<EmbeddedBrowserState, String> {
        let core = self.require_core()?;
        core.activate(&tab_id).await?;
        Ok(core.snapshot())
    }

    pub async fn mouse(&self, input: EmbeddedMouseInput) -> Result<(), String> {
        let params = build_mouse_params(&input)?;
        let core = self.require_core()?;
        let (_, session_id) = core.active_session()?;
        core.call(Some(&session_id), "Input.dispatchMouseEvent", params)
            .await
            .map(|_| ())
    }

    pub async fn key(&self, input: EmbeddedKeyInput) -> Result<(), String> {
        let params = build_key_params(&input, cfg!(target_os = "macos"))?;
        let core = self.require_core()?;
        let (_, session_id) = core.active_session()?;
        core.call(Some(&session_id), "Input.dispatchKeyEvent", params)
            .await
            .map(|_| ())
    }

    pub async fn insert_text(&self, text: String) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        let core = self.require_core()?;
        let (_, session_id) = core.active_session()?;
        core.call(
            Some(&session_id),
            "Input.insertText",
            json!({ "text": text }),
        )
        .await
        .map(|_| ())
    }

    /// 活动标签页当前视口的 PNG 截图（base64）。
    pub async fn screenshot(&self) -> Result<String, String> {
        let core = self.require_core()?;
        let (_, session_id) = core.active_session()?;
        let shot = core
            .connection
            .call(
                Some(&session_id),
                "Page.captureScreenshot",
                json!({ "format": "png", "captureBeyondViewport": false }),
                Duration::from_secs(30),
            )
            .await?;
        shot.get("data")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "截图结果缺少 data".to_string())
    }

    /// 在活动标签页注入拾取器，等待用户点击；取消/跳转返回 None。
    pub async fn pick_element(&self) -> Result<Option<Value>, String> {
        let core = self.require_core()?;
        let (_, session_id) = core.active_session()?;
        let evaluated = core
            .connection
            .call(
                Some(&session_id),
                "Runtime.evaluate",
                json!({
                    "expression": PICKER_SCRIPT,
                    "awaitPromise": true,
                    "returnByValue": true,
                    "userGesture": true,
                }),
                PICK_TIMEOUT,
            )
            .await;
        let evaluated = match evaluated {
            Ok(value) => value,
            Err(error) if is_context_destroyed(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        if let Some(details) = evaluated.get("exceptionDetails") {
            let text = details
                .get("exception")
                .and_then(|exception| exception.get("description"))
                .or_else(|| details.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            if is_context_destroyed(text) {
                return Ok(None);
            }
            return Err(format!("元素拾取失败：{text}"));
        }
        let value = evaluated
            .get("result")
            .and_then(|result| result.get("value"))
            .cloned()
            .unwrap_or(Value::Null);
        Ok(if value.is_object() { Some(value) } else { None })
    }

    pub async fn cancel_pick_element(&self) -> Result<(), String> {
        let Some(core) = self.live_core() else {
            return Ok(());
        };
        let Ok((_, session_id)) = core.active_session() else {
            return Ok(());
        };
        core.call(
            Some(&session_id),
            "Runtime.evaluate",
            json!({ "expression": PICKER_CANCEL_SCRIPT, "returnByValue": true }),
        )
        .await
        .map(|_| ())
    }

    pub async fn close(&self) -> Result<(), String> {
        let mut lifecycle = self.lifecycle.lock().await;
        let core = self.core.lock().ok().and_then(|mut guard| guard.take());
        // 取出即触发 LaunchedBrowser::drop → kill 进程树。
        lifecycle.take();
        self.record_child_pid(None);
        if let Some(emitter) = core.and_then(|core| core.emitter.clone()) {
            if let Ok(payload) = serde_json::to_value(self.state()) {
                emitter(EMBEDDED_BROWSER_STATE_EVENT, payload);
            }
        }
        Ok(())
    }

    /// 清除浏览数据：关闭浏览器后删除整个面板 profile（cookies、缓存、站点
    /// 存储、导入的登录态）。持有 lifecycle 锁，期间不会有并发启动。
    pub async fn clear_browsing_data(&self) -> Result<(), String> {
        let profile_dir = embedded_profile_dir()?;
        let mut lifecycle = self.lifecycle.lock().await;
        let core = self.core.lock().ok().and_then(|mut guard| guard.take());
        // LaunchedBrowser::drop 同步终止进程树，之后 profile 不再被占用。
        lifecycle.take();
        self.record_child_pid(None);
        let removed =
            tauri::async_runtime::spawn_blocking(move || remove_profile_dir(&profile_dir))
                .await
                .map_err(|e| format!("清除浏览数据任务失败：{e}"))?;
        drop(lifecycle);
        if let Some(emitter) = core.and_then(|core| core.emitter.clone()) {
            if let Ok(payload) = serde_json::to_value(self.state()) {
                emitter(EMBEDDED_BROWSER_STATE_EVENT, payload);
            }
        }
        removed
    }

    /// app 真正退出时的清理钩子（Drop 不保证被调）。
    pub fn shutdown_cleanup(&self) {
        if let Ok(mut core) = self.core.lock() {
            core.take();
        }
        if let Ok(mut guard) = self.lifecycle.try_lock() {
            guard.take();
        }
        // 兜底：启动中恰好退出时 try_lock 拿不到锁，按记录的 pid 直接杀进程树。
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
}

/// 登录态导入的目标就是面板浏览器的 browser-level 连接：`Storage.setCookies`
/// 不带 browserContextId 即写入默认上下文，也就是持久的面板 profile。未运行时
/// 直接报错（不在这里隐式拉起浏览器），调用方先 `open` 再导入。
#[async_trait::async_trait]
impl ImportTarget for EmbeddedBrowserManager {
    async fn cdp_caller(&self) -> Result<Arc<dyn CdpCaller>, String> {
        let core = self
            .live_core()
            .ok_or_else(|| super::cookie_import::IN_APP_BROWSER_NOT_RUNNING.to_string())?;
        let connection: Arc<dyn CdpCaller> = core.connection.clone();
        Ok(connection)
    }
}

/// 删除 profile 目录；浏览器刚被杀时个别文件可能还在释放，短暂重试。
fn remove_profile_dir(dir: &std::path::Path) -> Result<(), String> {
    let mut last_error = None;
    for _ in 0..10 {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err(format!(
        "清除浏览数据失败：{}",
        last_error.map(|e| e.to_string()).unwrap_or_default()
    ))
}

fn embedded_launch_args(viewport: EmbeddedViewport) -> Vec<String> {
    vec![
        "--headless=new".to_string(),
        format!("--window-size={},{}", viewport.width, viewport.height),
        "--hide-scrollbars".to_string(),
        "--mute-audio".to_string(),
        // 面板不可见时页面也不应被节流（screencast 依赖渲染）。
        "--disable-background-timer-throttling".to_string(),
        "--disable-renderer-backgrounding".to_string(),
        "--disable-backgrounding-occluded-windows".to_string(),
        // 避免 macOS 钥匙串授权弹窗：面板 profile 不需要系统级凭据加密。
        "--use-mock-keychain".to_string(),
        "--password-store=basic".to_string(),
        "about:blank".to_string(),
    ]
}

async fn initial_page_target(core: &SessionCore) -> Result<Option<String>, String> {
    let targets = core.call(None, "Target.getTargets", json!({})).await?;
    Ok(targets
        .get("targetInfos")
        .and_then(Value::as_array)
        .and_then(|infos| {
            infos
                .iter()
                .find(|info| info.get("type").and_then(Value::as_str) == Some("page"))
        })
        .and_then(|info| info.get("targetId").and_then(Value::as_str))
        .map(str::to_string))
}

async fn run_event_loop(core: Weak<SessionCore>, mut events: mpsc::UnboundedReceiver<CdpEvent>) {
    while let Some(event) = events.recv().await {
        let Some(core) = core.upgrade() else {
            break;
        };
        handle_event(core, event);
    }
    // 连接断开（浏览器退出/崩溃）：推一次快照让前端切到未运行状态。
    if let Some(core) = core.upgrade() {
        core.emit_state();
    }
}

fn handle_event(core: Arc<SessionCore>, event: CdpEvent) {
    let session = event.session_id.as_deref();
    let params = &event.params;
    match event.method.as_str() {
        "Page.screencastFrame" => {
            let Some(session) = session.map(str::to_string) else {
                return;
            };
            let ack_id = params.get("sessionId").cloned().unwrap_or(Value::Null);
            let (is_active, tab_id) = {
                let model = core.model();
                (
                    model.screencast_session.as_deref() == Some(session.as_str()),
                    model.tab_of_session(&session),
                )
            };
            if let (true, Some(tab_id)) = (is_active, tab_id) {
                let metadata = params.get("metadata").cloned().unwrap_or(Value::Null);
                core.emit(
                    EMBEDDED_BROWSER_FRAME_EVENT,
                    json!({
                        "tabId": tab_id,
                        "data": params.get("data").cloned().unwrap_or(Value::Null),
                        "deviceWidth": metadata.get("deviceWidth").cloned().unwrap_or(Value::Null),
                        "deviceHeight": metadata.get("deviceHeight").cloned().unwrap_or(Value::Null),
                        "timestamp": metadata.get("timestamp").cloned().unwrap_or(Value::Null),
                    }),
                );
            }
            // 必须 ack，否则浏览器停止推送后续帧。
            tauri::async_runtime::spawn(async move {
                let _ = core
                    .call(
                        Some(&session),
                        "Page.screencastFrameAck",
                        json!({ "sessionId": ack_id }),
                    )
                    .await;
            });
        }
        "Target.targetInfoChanged" => {
            let info = params.get("targetInfo").cloned().unwrap_or(Value::Null);
            let Some(target_id) = info.get("targetId").and_then(Value::as_str) else {
                return;
            };
            let changed = {
                let mut model = core.model();
                match model.find_mut(target_id) {
                    Some(tab) => {
                        let url = info.get("url").and_then(Value::as_str).unwrap_or_default();
                        let title = info
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let changed = tab.state.url != url || tab.state.title != title;
                        tab.state.url = url.to_string();
                        tab.state.title = title.to_string();
                        changed
                    }
                    None => false,
                }
            };
            if changed {
                core.emit_state();
            }
        }
        "Page.frameStartedLoading" | "Page.frameStoppedLoading" => {
            let Some(session) = session else {
                return;
            };
            let frame_id = params
                .get("frameId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let loading = event.method == "Page.frameStartedLoading";
            // 主 frame id 与 page target id 相同；子 frame 的加载不影响标签状态。
            let tab_id = {
                let mut model = core.model();
                match model.find_by_session_mut(session) {
                    // 不在这里清错误：导航失败后 Chromium 还会加载自己的错误页，
                    // 那次加载同样触发 frameStartedLoading，会把刚记下的错误抹掉。
                    // 错误改由成功的主 frame 导航（frameNavigated）清除。
                    Some(tab) if tab.state.id == frame_id => {
                        tab.state.loading = loading;
                        Some(tab.state.id.clone())
                    }
                    _ => None,
                }
            };
            if let Some(tab_id) = tab_id {
                core.emit_state();
                if !loading {
                    let session = session.to_string();
                    tauri::async_runtime::spawn(async move {
                        core.refresh_history(&tab_id, &session).await;
                        core.emit_state();
                    });
                }
            }
        }
        "Page.frameNavigated" | "Page.navigatedWithinDocument" => {
            let Some(session) = session.map(str::to_string) else {
                return;
            };
            let is_main = match event.method.as_str() {
                "Page.frameNavigated" => params
                    .get("frame")
                    .map(|frame| frame.get("parentId").is_none())
                    .unwrap_or(false),
                _ => core.model().tab_of_session(&session).is_some_and(|tab_id| {
                    params.get("frameId").and_then(Value::as_str) == Some(tab_id.as_str())
                }),
            };
            if !is_main {
                return;
            }
            let Some(tab_id) = core.model().tab_of_session(&session) else {
                return;
            };
            if event.method == "Page.frameNavigated" && navigation_reached_page(params) {
                if let Some(tab) = core.model().find_mut(&tab_id) {
                    tab.state.error = None;
                }
            }
            tauri::async_runtime::spawn(async move {
                core.refresh_history(&tab_id, &session).await;
                core.emit_state();
            });
        }
        "Target.targetCreated" => {
            // 页面内 window.open / target=_blank 打开的新页：opener 是面板里的
            // 标签页时收编为新标签页（其余目标——包括面板自己 createTarget 的——
            // 由各自调用方 attach，这里忽略）。
            let info = params.get("targetInfo").cloned().unwrap_or(Value::Null);
            if info.get("type").and_then(Value::as_str) != Some("page") {
                return;
            }
            let Some(target_id) = info
                .get("targetId")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                return;
            };
            let opener_known = info
                .get("openerId")
                .and_then(Value::as_str)
                .is_some_and(|opener| core.model().find(opener).is_some());
            if !opener_known {
                return;
            }
            tauri::async_runtime::spawn(async move {
                let at_cap = core.model().tabs.len() >= MAX_EMBEDDED_TABS;
                if at_cap {
                    let _ = core
                        .call(None, "Target.closeTarget", json!({ "targetId": target_id }))
                        .await;
                    return;
                }
                if core.attach_tab(&target_id).await.is_ok() {
                    let _ = core.activate(&target_id).await;
                }
            });
        }
        "Target.targetDestroyed" | "Target.detachedFromTarget" | "Target.targetCrashed" => {
            let target_id = params
                .get("targetId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    params
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .and_then(|session| core.model().tab_of_session(session))
                });
            let Some(target_id) = target_id else {
                return;
            };
            if core.model().find(&target_id).is_none() {
                return;
            }
            if event.method == "Target.targetCrashed" {
                if let Some(tab) = core.model().find_mut(&target_id) {
                    tab.state.loading = false;
                    tab.state.error = Some("页面已崩溃，点击刷新重新加载".to_string());
                }
                core.emit_state();
                return;
            }
            tauri::async_runtime::spawn(async move {
                core.handle_tab_removed(&target_id).await;
            });
        }
        "Page.javascriptDialogOpening" => {
            // headless 下没有原生对话框可点，弹框会卡住页面：alert/beforeunload
            // 直接确认，confirm/prompt 按取消处理。
            let Some(session) = session.map(str::to_string) else {
                return;
            };
            let accept = matches!(
                params.get("type").and_then(Value::as_str),
                Some("alert") | Some("beforeunload")
            );
            tauri::async_runtime::spawn(async move {
                let _ = core
                    .call(
                        Some(&session),
                        "Page.handleJavaScriptDialog",
                        json!({ "accept": accept }),
                    )
                    .await;
            });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::browser::cookie_import::{
        import_cookies, BrowserKind, CookieCrypto, CookieFilter, KeyProvider, SourceProfile,
        IN_APP_BROWSER_NOT_RUNNING,
    };

    #[derive(Default)]
    struct CountingKeys(StdMutex<usize>);

    impl KeyProvider for CountingKeys {
        fn safe_storage_password(&self, _: BrowserKind) -> Result<Option<Vec<u8>>, String> {
            *self.0.lock().unwrap() += 1;
            Ok(None)
        }

        fn dpapi_unprotect(&self, _: &[u8]) -> Result<Vec<u8>, String> {
            *self.0.lock().unwrap() += 1;
            Err("unused".to_string())
        }
    }

    #[test]
    fn import_target_requires_running_panel_browser_before_touching_keys() {
        let manager = EmbeddedBrowserManager::default();
        let tmp = tempfile::tempdir().unwrap();
        let keys = Arc::new(CountingKeys::default());
        let profile = SourceProfile {
            browser: BrowserKind::Chrome,
            browser_name: "Google Chrome".to_string(),
            profile_dir: "Default".to_string(),
            display_name: "Person 1".to_string(),
            user_data_dir: tmp.path().to_path_buf(),
            crypto: CookieCrypto::current(),
        };
        tauri::async_runtime::block_on(async {
            let error = match ImportTarget::cdp_caller(&manager).await {
                Ok(_) => panic!("a stopped panel browser must not be an import target"),
                Err(error) => error,
            };
            assert_eq!(error, IN_APP_BROWSER_NOT_RUNNING);
            let error = import_cookies(&manager, profile, keys.clone(), CookieFilter::default())
                .await
                .unwrap_err();
            assert_eq!(error, IN_APP_BROWSER_NOT_RUNNING);
        });
        assert_eq!(*keys.0.lock().unwrap(), 0, "no key store access");
    }

    #[test]
    fn remove_profile_dir_deletes_tree_and_tolerates_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let profile = tmp.path().join("embedded-browser-profile");
        std::fs::create_dir_all(profile.join("Default/Network")).unwrap();
        std::fs::write(profile.join("Default/Network/Cookies"), b"x").unwrap();
        remove_profile_dir(&profile).unwrap();
        assert!(!profile.exists());
        remove_profile_dir(&profile).unwrap();
    }

    fn key(kind: &str, key: &str, code: &str, key_code: u32, modifiers: u32) -> EmbeddedKeyInput {
        EmbeddedKeyInput {
            kind: kind.to_string(),
            key: key.to_string(),
            code: code.to_string(),
            key_code,
            modifiers,
        }
    }

    fn mouse(kind: &str, x: f64, y: f64) -> EmbeddedMouseInput {
        EmbeddedMouseInput {
            kind: kind.to_string(),
            x,
            y,
            button: None,
            buttons: None,
            click_count: None,
            modifiers: None,
            delta_x: None,
            delta_y: None,
        }
    }

    #[test]
    fn validate_url_accepts_http_and_blank_only() {
        assert_eq!(
            validate_navigation_url(" http://127.0.0.1:5173/app ").unwrap(),
            "http://127.0.0.1:5173/app"
        );
        assert_eq!(
            validate_navigation_url("https://example.com").unwrap(),
            "https://example.com/"
        );
        assert_eq!(
            validate_navigation_url("about:blank").unwrap(),
            "about:blank"
        );
        for rejected in [
            "",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "chrome://settings",
            "data:text/html,hi",
            "localhost:3000",
        ] {
            assert!(
                validate_navigation_url(rejected).is_err(),
                "{rejected} should be rejected"
            );
        }
    }

    #[test]
    fn viewport_is_clamped_and_scaled() {
        let viewport = EmbeddedViewport {
            width: 10,
            height: 99_999,
            device_scale_factor: f64::NAN,
        }
        .sanitized();
        assert_eq!(viewport.width, 160);
        assert_eq!(viewport.height, 4096);
        assert_eq!(viewport.device_scale_factor, 1.0);

        let retina = EmbeddedViewport {
            width: 640,
            height: 480,
            device_scale_factor: 2.0,
        }
        .sanitized();
        assert_eq!(retina.screencast_max(), (1280, 960));
    }

    #[test]
    fn printable_key_down_carries_text() {
        let params = build_key_params(&key("down", "a", "KeyA", 65, 0), true).unwrap();
        assert_eq!(params["type"], "keyDown");
        assert_eq!(params["text"], "a");
        assert_eq!(params["windowsVirtualKeyCode"], 65);
        assert!(params.get("commands").is_none());

        let enter = build_key_params(&key("down", "Enter", "Enter", 13, 0), true).unwrap();
        assert_eq!(enter["type"], "keyDown");
        assert_eq!(enter["text"], "\r");
    }

    #[test]
    fn non_printable_and_shortcut_keys_use_raw_key_down() {
        let backspace =
            build_key_params(&key("down", "Backspace", "Backspace", 8, 0), true).unwrap();
        assert_eq!(backspace["type"], "rawKeyDown");
        assert!(backspace.get("text").is_none());

        let select_all =
            build_key_params(&key("down", "a", "KeyA", 65, MODIFIER_META), true).unwrap();
        assert_eq!(select_all["type"], "rawKeyDown");
        assert_eq!(select_all["commands"], json!(["selectAll"]));
        assert!(select_all.get("text").is_none());

        let redo = build_key_params(
            &key("down", "Z", "KeyZ", 90, MODIFIER_META | MODIFIER_SHIFT),
            true,
        )
        .unwrap();
        assert_eq!(redo["commands"], json!(["redo"]));

        // 非 mac：Ctrl 才是编辑主键，Meta 不触发命令。
        let ctrl_copy =
            build_key_params(&key("down", "c", "KeyC", 67, MODIFIER_CTRL), false).unwrap();
        assert_eq!(ctrl_copy["commands"], json!(["copy"]));
        let meta_copy =
            build_key_params(&key("down", "c", "KeyC", 67, MODIFIER_META), false).unwrap();
        assert!(meta_copy.get("commands").is_none());

        let up = build_key_params(&key("up", "a", "KeyA", 65, 0), true).unwrap();
        assert_eq!(up["type"], "keyUp");
        assert!(build_key_params(&key("press", "a", "KeyA", 65, 0), true).is_err());
    }

    #[test]
    fn mouse_params_map_kinds_and_defaults() {
        let down = build_mouse_params(&mouse("down", 12.5, 40.0)).unwrap();
        assert_eq!(down["type"], "mousePressed");
        assert_eq!(down["button"], "left");
        assert_eq!(down["clickCount"], 1);

        let moved = build_mouse_params(&mouse("move", -3.0, 5.0)).unwrap();
        assert_eq!(moved["type"], "mouseMoved");
        assert_eq!(moved["button"], "none");
        assert_eq!(moved["x"], 0.0);
        assert!(moved.get("clickCount").is_none());

        let mut wheel = mouse("wheel", 1.0, 1.0);
        wheel.delta_y = Some(120.0);
        wheel.delta_x = Some(f64::INFINITY);
        let wheel = build_mouse_params(&wheel).unwrap();
        assert_eq!(wheel["type"], "mouseWheel");
        assert_eq!(wheel["deltaY"], 120.0);
        assert_eq!(wheel["deltaX"], 0.0);

        assert!(build_mouse_params(&mouse("drag", 0.0, 0.0)).is_err());
        assert!(build_mouse_params(&mouse("move", f64::NAN, 0.0)).is_err());
    }

    #[test]
    fn only_real_page_navigations_clear_load_errors() {
        assert!(navigation_reached_page(
            &json!({ "frame": { "id": "T", "url": "http://localhost:5173/" } })
        ));
        assert!(!navigation_reached_page(&json!({
            "frame": {
                "id": "T",
                "url": "chrome-error://chromewebdata/",
                "unreachableUrl": "http://localhost:9871/"
            }
        })));
        assert!(!navigation_reached_page(
            &json!({ "frame": { "id": "T", "url": "chrome-error://chromewebdata/" } })
        ));
        assert!(!navigation_reached_page(&json!({})));
    }

    #[test]
    fn history_flags_follow_current_index() {
        assert_eq!(history_flags(&json!({})), (false, false));
        let history = json!({ "currentIndex": 1, "entries": [{}, {}, {}] });
        assert_eq!(history_flags(&history), (true, true));
        let last = json!({ "currentIndex": 2, "entries": [{}, {}, {}] });
        assert_eq!(history_flags(&last), (true, false));
    }

    fn entry(id: &str) -> TabEntry {
        TabEntry {
            state: EmbeddedTabState {
                id: id.to_string(),
                ..Default::default()
            },
            session_id: format!("session-{id}"),
        }
    }

    #[test]
    fn removing_active_tab_prefers_right_neighbor() {
        let mut model = TabsModel {
            tabs: vec![entry("a"), entry("b"), entry("c")],
            active: Some("b".to_string()),
            viewport: EmbeddedViewport::default(),
            screencast_session: Some("session-b".to_string()),
        };
        assert_eq!(model.remove("b"), Some(Some("c".to_string())));
        assert_eq!(model.screencast_session, None);
        assert_eq!(model.remove("c"), Some(Some("a".to_string())));
        // 非活动页被移除：活动页不变。
        model.tabs.push(entry("d"));
        assert_eq!(model.remove("d"), Some(None));
        assert_eq!(model.active.as_deref(), Some("a"));
        assert_eq!(model.remove("missing"), None);
        assert_eq!(model.remove("a"), Some(None));
        assert!(model.tabs.is_empty());
        assert_eq!(model.active, None);
    }

    #[test]
    fn picker_script_is_a_single_expression() {
        let trimmed = PICKER_SCRIPT.trim_end();
        assert!(trimmed.ends_with("})()"));
        assert!(PICKER_SCRIPT.contains("__liveagentElementPicker"));
        assert!(PICKER_SCRIPT.contains("[masked password input]"));
    }

    #[test]
    fn context_destroyed_errors_count_as_cancel() {
        assert!(is_context_destroyed(
            "CDP 错误：Execution context was destroyed."
        ));
        assert!(is_context_destroyed("CDP 连接已关闭"));
        assert!(!is_context_destroyed("CDP 错误：Invalid parameters"));
    }
}

#[cfg(test)]
mod e2e_tests {
    use super::*;
    use base64::Engine;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const FIXTURE: &str = r#"<!doctype html><html><head><title>Embedded Fixture</title></head>
<body style="margin:0;font:16px sans-serif">
<h1 id="hero" style="margin:40px">Fixture heading</h1>
<input id="name" style="margin:0 40px" placeholder="type here">
<a id="next" href="/second" style="display:block;margin:40px">Second page</a>
</body></html>"#;

    async fn serve_fixture() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tauri::async_runtime::spawn(async move {
                    let mut buffer = [0u8; 4096];
                    let read = socket.read(&mut buffer).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..read]);
                    let body = if request.starts_with("GET /second") {
                        "<!doctype html><title>Second</title><p>second page</p>".to_string()
                    } else {
                        FIXTURE.to_string()
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        port
    }

    async fn wait_until<F: Fn(&EmbeddedBrowserState) -> bool>(
        manager: &EmbeddedBrowserManager,
        predicate: F,
    ) -> EmbeddedBrowserState {
        for _ in 0..100 {
            let state = manager.state();
            if predicate(&state) {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("condition not reached: {:?}", manager.state());
    }

    /// 嵌入式面板的手动 e2e：本地 fixture → 导航/帧/标签/拾取/截图/关闭。
    /// 需要本机已装 Chromium 系浏览器且设置隔离数据目录，不进 CI：
    /// `LIVEAGENT_DEV_HOME=<tmp> cargo test -p liveagent embedded_browser_e2e -- --ignored --nocapture`
    #[test]
    #[ignore = "requires an installed Chromium-family browser; manual acceptance evidence"]
    fn embedded_browser_e2e_manual() {
        assert!(
            std::env::var_os("LIVEAGENT_DEV_HOME").is_some(),
            "set LIVEAGENT_DEV_HOME to an isolated temp directory"
        );
        tauri::async_runtime::block_on(async {
            let port = serve_fixture().await;
            let manager = EmbeddedBrowserManager::default();
            let (tx, mut frames) = mpsc::unbounded_channel::<Value>();
            manager.set_emitter(Arc::new(move |event, payload| {
                if event == EMBEDDED_BROWSER_FRAME_EVENT {
                    let _ = tx.send(payload);
                }
            }));

            let url = format!("http://127.0.0.1:{port}/");
            manager
                .open(
                    Some(url.clone()),
                    Some(EmbeddedViewport {
                        width: 800,
                        height: 600,
                        device_scale_factor: 1.0,
                    }),
                )
                .await
                .expect("open should succeed");
            let state = wait_until(&manager, |state| {
                state
                    .tabs
                    .first()
                    .is_some_and(|tab| tab.title == "Embedded Fixture" && !tab.loading)
            })
            .await;
            println!("state after load: {state:?}");
            let endpoint = manager.cdp_endpoint().expect("cdp endpoint while running");
            assert!(endpoint.websocket_url.starts_with("ws://127.0.0.1:"));
            assert_eq!(endpoint.active_target_id, state.active_tab_id);

            let frame = tokio::time::timeout(Duration::from_secs(10), frames.recv())
                .await
                .expect("a screencast frame arrives")
                .expect("frame channel open");
            assert_eq!(frame["deviceWidth"], 800);
            assert!(frame["data"].as_str().is_some_and(|data| data.len() > 100));

            // 输入：点击输入框后键入文字。
            let click = |kind: &str, x: f64, y: f64| EmbeddedMouseInput {
                kind: kind.to_string(),
                x,
                y,
                button: Some("left".to_string()),
                buttons: Some(1),
                click_count: Some(1),
                modifiers: None,
                delta_x: None,
                delta_y: None,
            };
            let core = manager.live_core().expect("core while running");
            let (_, session_id) = core.active_session().unwrap();
            let rect = core
                .call(
                    Some(&session_id),
                    "Runtime.evaluate",
                    json!({
                        "expression": "(() => { const r = document.getElementById('name').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()",
                        "returnByValue": true,
                    }),
                )
                .await
                .unwrap();
            let center_x = rect["result"]["value"][0].as_f64().unwrap();
            let center_y = rect["result"]["value"][1].as_f64().unwrap();
            manager
                .mouse(click("down", center_x, center_y))
                .await
                .unwrap();
            manager
                .mouse(click("up", center_x, center_y))
                .await
                .unwrap();
            for ch in ["h", "i"] {
                manager
                    .key(EmbeddedKeyInput {
                        kind: "down".to_string(),
                        key: ch.to_string(),
                        code: format!("Key{}", ch.to_uppercase()),
                        key_code: u32::from(ch.to_uppercase().as_bytes()[0]),
                        modifiers: 0,
                    })
                    .await
                    .unwrap();
            }
            manager.insert_text(" there".to_string()).await.unwrap();
            let typed = core
                .call(
                    Some(&session_id),
                    "Runtime.evaluate",
                    json!({ "expression": "document.getElementById('name').value", "returnByValue": true }),
                )
                .await
                .unwrap();
            assert_eq!(typed["result"]["value"], "hi there");

            // 拾取：拾取器挂起期间派发点击，拿到元素描述。
            let picked = {
                let pick = manager.pick_element();
                let clicker = async {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    manager.mouse(click("move", 80.0, 60.0)).await.unwrap();
                    manager.mouse(click("down", 80.0, 60.0)).await.unwrap();
                    manager.mouse(click("up", 80.0, 60.0)).await.unwrap();
                };
                let (picked, _) = tokio::join!(pick, clicker);
                picked
                    .expect("pick succeeds")
                    .expect("an element was picked")
            };
            println!("picked: {picked}");
            assert_eq!(picked["tagName"], "h1");
            assert_eq!(picked["selector"], "#hero");

            let png = manager.screenshot().await.expect("screenshot");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(png)
                .unwrap();
            assert_eq!(&bytes[1..4], b"PNG");

            // 登录态导入目标：经面板浏览器的 browser-level 连接写入 cookie，
            // 页面刷新后可见。
            let caller = ImportTarget::cdp_caller(&manager)
                .await
                .expect("running panel browser is an import target");
            let applied = crate::services::browser::cookie_import::apply_cookies_via_cdp(
                caller.as_ref(),
                &[json!({
                    "name": "imported_session",
                    "value": "fixture",
                    "url": format!("http://127.0.0.1:{port}/"),
                })],
            )
            .await;
            assert_eq!((applied.applied, applied.failed), (1, 0));
            manager.history(None, "reload").await.unwrap();
            tokio::time::sleep(Duration::from_millis(500)).await;
            let (_, session_id) = core.active_session().unwrap();
            let cookie = core
                .call(
                    Some(&session_id),
                    "Runtime.evaluate",
                    json!({ "expression": "document.cookie", "returnByValue": true }),
                )
                .await
                .unwrap();
            assert!(cookie["result"]["value"]
                .as_str()
                .is_some_and(|value| value.contains("imported_session=fixture")));

            // 标签页：新开第二页再关闭。
            let state = manager
                .new_tab(Some(format!("http://127.0.0.1:{port}/second")))
                .await
                .expect("new tab");
            assert_eq!(state.tabs.len(), 2);
            let second = state.active_tab_id.clone().unwrap();
            let state = manager.close_tab(second).await.expect("close tab");
            assert_eq!(state.tabs.len(), 1);

            let pid = manager.child_pid.lock().unwrap().expect("pid recorded");
            manager.close().await.unwrap();
            assert!(!manager.state().running);
            assert!(manager.cdp_endpoint().is_none());
            tokio::time::sleep(Duration::from_millis(500)).await;
            let alive = std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(std::process::Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            assert!(!alive, "browser process {pid} should be gone");

            // 清除浏览数据：删除整个面板 profile。
            let profile_dir = embedded_profile_dir().unwrap();
            assert!(profile_dir.exists());
            manager.clear_browsing_data().await.unwrap();
            assert!(!profile_dir.exists());
        });
    }
}
