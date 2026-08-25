//! CUA Tauri Command 层。所有命令的统一规范：
//! 1. `cua_*` 命名前缀；状态无关。
//! 2. 经 `CuaStore::enforce` 守卫：未启用 / 白名单拒了就直接 `Err` 回去，
//!    不调用驱动。
//! 3. 操作结果写审计日志（成功 + 失败都写），便于前端面板与远端审计。
//! 4. `screenshot` 返回 base64（前端可经 invoke 解码成 PNG），与 MCP
//!    协议桥的标准一致；底层驱动返回原始字节。
//!
//! 平台：非 macOS 上 `cua_status.available=false`、其余命令返回
//! 结构化 `CuaError`（kind + i18n params + 英文 message），由前端按
//! 当前 locale 翻译——避免之前中文硬编码字串跨 IPC 泄漏（CUA-006）。

use base64::Engine;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::AppHandle;
use tauri::State;

use crate::services::cua::{
    installer::{CuaDriverDetection, CuaInstallResult, CuaUpdateResult, InstallPreview},
    store::CuaRuntimeConfig,
    ClickButton, CuaAuditEntry, CuaError, CuaStore, CuaStoreSnapshot, PlatformError, WindowInfo,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaScreenshotResponse {
    pub width: u32,
    pub height: u32,
    pub base64_png: String,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClickButtonArg {
    #[default]
    Left,
    Middle,
    Right,
}

impl From<ClickButtonArg> for ClickButton {
    fn from(value: ClickButtonArg) -> Self {
        match value {
            ClickButtonArg::Left => ClickButton::Left,
            ClickButtonArg::Middle => ClickButton::Middle,
            ClickButtonArg::Right => ClickButton::Right,
        }
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaOpResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CuaError>,
}

/// 把驱动层错误转成跨 IPC 的结构化错误。`platform_driver` 调用方需要
/// `?` 后再调一次 `PlatformError::into()`。
fn map_platform_error(err: PlatformError) -> CuaError {
    match err {
        PlatformError::Unsupported(os) => CuaError::unsupported_platform(&os),
        PlatformError::PermissionRequired {
            permission_key,
            permission,
        } => CuaError::permission_required(permission_key, permission),
        PlatformError::NotExecuted(detail) => CuaError::not_executed(&detail),
        PlatformError::Io(detail) => CuaError::io(&detail),
    }
}

fn record_audit(
    store: &Arc<CuaStore>,
    op: &str,
    detail: Option<serde_json::Value>,
    result: &Result<(), PlatformError>,
    started: chrono::DateTime<Utc>,
) {
    let entry = match result {
        Ok(()) => CuaAuditEntry {
            timestamp: started,
            operation: op.to_string(),
            ok: true,
            error: None,
            detail,
        },
        Err(err) => CuaAuditEntry {
            timestamp: started,
            operation: op.to_string(),
            ok: false,
            error: Some(map_platform_error(err.clone())),
            detail,
        },
    };
    store.record(entry);
}

fn run_with_audit<F>(
    store: &Arc<CuaStore>,
    op: &str,
    detail: Option<serde_json::Value>,
    f: F,
) -> Result<(), CuaError>
where
    F: FnOnce() -> Result<(), PlatformError>,
{
    let started = Utc::now();
    let result = f();
    record_audit(store, op, detail, &result, started);
    result.map_err(map_platform_error)
}

// ───────── Commands ─────────

/// 平台标签 + 是否可用 + 当前配置 + 最近操作。前端挂载时调用一次。
#[tauri::command(rename_all = "snake_case")]
pub fn cua_status(store: State<'_, Arc<CuaStore>>) -> CuaStoreSnapshot {
    store.snapshot()
}

/// 整体覆盖配置。前端保存面板时调用。
#[tauri::command(rename_all = "snake_case")]
pub fn cua_set_config(
    store: State<'_, Arc<CuaStore>>,
    config: CuaRuntimeConfig,
) -> CuaStoreSnapshot {
    store.replace_config(config);
    store.snapshot()
}

#[tauri::command(rename_all = "snake_case")]
pub fn cua_clear_audit(store: State<'_, Arc<CuaStore>>) -> CuaStoreSnapshot {
    store.clear_audit();
    store.snapshot()
}

#[tauri::command(rename_all = "snake_case")]
pub fn cua_list_windows(store: State<'_, Arc<CuaStore>>) -> Result<Vec<WindowInfo>, CuaError> {
    let op = "list_windows";
    store.enforce(op, None)?;
    let driver = crate::services::cua::platform_driver();
    let started = Utc::now();
    let result = driver.list_windows();
    record_audit(store.inner(), op, None, &result.clone().map(|_| ()), started);
    result.map_err(map_platform_error)
}

#[tauri::command(rename_all = "snake_case")]
pub fn cua_focus_window(
    store: State<'_, Arc<CuaStore>>,
    owner: String,
) -> Result<CuaOpResponse, CuaError> {
    let op = "focus_window";
    let owner_ref = owner.trim().to_string();
    store.enforce(op, Some(&owner_ref))?;
    let driver = crate::services::cua::platform_driver();
    let started = Utc::now();
    let detail = serde_json::json!({ "owner": &owner_ref });
    let result = driver.focus_window(&owner_ref);
    record_audit(store.inner(), op, Some(detail), &result, started);
    // 焦点失败不该让调用方 abort —— best-effort；把 ok=false + error 一起返回。
    Ok(CuaOpResponse {
        ok: result.is_ok(),
        error: result.err().map(map_platform_error),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cua_screenshot(
    store: State<'_, Arc<CuaStore>>,
    window_owner: Option<String>,
) -> Result<CuaScreenshotResponse, CuaError> {
    let op = "screenshot";
    // 截屏不强制白名单（截图系统自身 / 必要场景），但仍要 enabled。
    store.enforce(op, None)?;
    let driver = crate::services::cua::platform_driver();
    let started = Utc::now();
    let result = driver.screenshot(window_owner.as_deref());
    match result {
        Ok(bytes) => {
            let (width, height) = png_dimensions(&bytes).unwrap_or((0, 0));
            let base64_png = base64::engine::general_purpose::STANDARD.encode(&bytes);
            store.inner().record(CuaAuditEntry {
                timestamp: started,
                operation: op.to_string(),
                ok: true,
                error: None,
                detail: Some(serde_json::json!({
                    "width": width,
                    "height": height,
                    "windowOwner": window_owner,
                    "sizeBytes": bytes.len(),
                })),
            });
            Ok(CuaScreenshotResponse {
                width,
                height,
                base64_png,
            })
        }
        Err(err) => {
            let err = map_platform_error(err);
            store.inner().record(CuaAuditEntry {
                timestamp: started,
                operation: op.to_string(),
                ok: false,
                error: Some(err.clone()),
                detail: Some(serde_json::json!({ "windowOwner": window_owner })),
            });
            Err(err)
        }
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn cua_click(
    store: State<'_, Arc<CuaStore>>,
    x: i32,
    y: i32,
    button: Option<ClickButtonArg>,
) -> Result<CuaOpResponse, CuaError> {
    let op = "click";
    store.enforce(op, None)?;
    let button: ClickButton = button.unwrap_or_default().into();
    let detail = Some(serde_json::json!({
        "x": x, "y": y, "button": format!("{:?}", button)
    }));
    let driver = crate::services::cua::platform_driver();
    run_with_audit(store.inner(), op, detail, || driver.click(x, y, button))?;
    Ok(CuaOpResponse {
        ok: true,
        error: None,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cua_double_click(
    store: State<'_, Arc<CuaStore>>,
    x: i32,
    y: i32,
) -> Result<CuaOpResponse, CuaError> {
    let op = "double_click";
    store.enforce(op, None)?;
    let detail = Some(serde_json::json!({ "x": x, "y": y }));
    let driver = crate::services::cua::platform_driver();
    run_with_audit(store.inner(), op, detail, || driver.double_click(x, y))?;
    Ok(CuaOpResponse {
        ok: true,
        error: None,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cua_type(
    store: State<'_, Arc<CuaStore>>,
    text: String,
    target_owner: Option<String>,
) -> Result<CuaOpResponse, CuaError> {
    let op = "type";
    let owner_ref = target_owner.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    store.enforce(op, owner_ref)?;
    let len = text.chars().count();
    let detail = Some(serde_json::json!({
        "length": len,
        "targetOwner": target_owner,
    }));
    let driver = crate::services::cua::platform_driver();
    run_with_audit(store.inner(), op, detail, || driver.type_text(&text))?;
    Ok(CuaOpResponse {
        ok: true,
        error: None,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cua_key(
    store: State<'_, Arc<CuaStore>>,
    key: String,
    modifiers: Option<Vec<String>>,
    target_owner: Option<String>,
) -> Result<CuaOpResponse, CuaError> {
    let op = "key";
    let owner_ref = target_owner.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    store.enforce(op, owner_ref)?;
    let mods = modifiers.unwrap_or_default();
    let detail = Some(serde_json::json!({
        "key": key,
        "modifiers": &mods,
        "targetOwner": target_owner,
    }));
    let driver = crate::services::cua::platform_driver();
    run_with_audit(store.inner(), op, detail, || {
        driver.press_key(&key, &mods)
    })?;
    Ok(CuaOpResponse {
        ok: true,
        error: None,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cua_scroll(
    store: State<'_, Arc<CuaStore>>,
    x: i32,
    y: i32,
    dy: i32,
) -> Result<CuaOpResponse, CuaError> {
    let op = "scroll";
    store.enforce(op, None)?;
    let detail = Some(serde_json::json!({ "x": x, "y": y, "dy": dy }));
    let driver = crate::services::cua::platform_driver();
    run_with_audit(store.inner(), op, detail, || driver.scroll(x, y, dy))?;
    Ok(CuaOpResponse {
        ok: true,
        error: None,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn cua_drag(
    store: State<'_, Arc<CuaStore>>,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
) -> Result<CuaOpResponse, CuaError> {
    let op = "drag";
    store.enforce(op, None)?;
    let detail = Some(serde_json::json!({
        "x1": x1, "y1": y1, "x2": x2, "y2": y2
    }));
    let driver = crate::services::cua::platform_driver();
    run_with_audit(store.inner(), op, detail, || driver.drag(x1, y1, x2, y2))?;
    Ok(CuaOpResponse {
        ok: true,
        error: None,
    })
}

// ───────── Helpers ─────────

/// 单元辅助：从 PNG 字节流解析 width / height（仅取 IHDR 头 8 个字节）。
fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 {
        return None;
    }
    if &bytes[..8] != b"\x89PNG\r\n\x1a\n".as_slice() {
        return None;
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Some((width, height))
}

/// cua-driver 入口命令：把主窗口重新推到最前并等待 `is_focused()` 落
/// 住。命令不依赖 CUA enable 开关——它的目的正是让 enable=true 之
/// 后的 click / AX 路径能找到 WebView（任何一次失败都让
/// `bring_to_front` + foreground HID 落入 `unverifiable` / `ax_window_unresolved`）。
#[tauri::command(rename_all = "snake_case")]
pub async fn cua_window_ready(
    window: tauri::WebviewWindow,
) -> Result<crate::CuaWindowReadyResponse, String> {
    Ok(crate::cua_window_ready(window).await)
}

/// CUA-020/021/022: 在路由切换、overlay 打开/关闭、cua-driver 主动唤
/// 起等场景重新触发 NSWindow/WKWebView 的 AX 注解 + 一回弹广播
/// UIElementCreatedNotification。`force_activate_main_window` 内部的
/// 注解是幂等的（NSWindow 已 setAccessibilityEnabled=true 不再变化），
/// 但 `makeFirstResponder + becomeFirstResponder` 在 WKWebView 被 hot
/// reload 重建后必须重跑，否则 cua-driver 的 foreground HID 会落到
/// content view 而不是 renderer，前端反馈 `effect: unverifiable`。
///
/// 不依赖 CUA enable 开关——这是「先把 WebView 修好」，与
/// `cua_window_ready` 是同一族操作。返回值为可序列化诊断字段，便于前
/// 端 / 远端验证调用确实落地。
#[tauri::command(rename_all = "snake_case")]
pub fn cua_refresh_a11y(window: tauri::WebviewWindow) -> crate::CuaRefreshA11yResponse {
    crate::cua_refresh_a11y(&window)
}

// ───────── CUA Driver 安装器（CUA-100） ─────────
//
// 设计：不经过 CuaStore 的 enable 守卫——安装器本身就是为了让后续 CUA
// 操作可用；enable 留到装完再由用户在 UI 中开启。

/// 检测 cua-driver 是否已安装、版本、daemon 状态。无 IO 副作用。
#[tauri::command(rename_all = "snake_case")]
pub fn cua_driver_detect() -> CuaDriverDetection {
    crate::services::cua::detect_driver()
}

/// 启动 cua-driver daemon（macOS: `open CuaDriver --args serve`）。
/// 失败时返回结构化 `CuaError`；前端不阻塞在失败上，可重试。
#[tauri::command(rename_all = "snake_case")]
pub fn cua_driver_start_daemon(app: AppHandle) -> Result<CuaOpResponse, CuaError> {
    crate::services::cua::start_driver_daemon(&app)
        .map(|started| CuaOpResponse {
            ok: started,
            error: None,
        })
        .map_err(|detail| match std::env::consts::OS {
            "macos" | "linux" | "windows" => CuaError::not_executed(&detail),
            other => CuaError::installer_unsupported_platform(other),
        })
}

/// 安装 cua-driver。30 分钟超时；进度经 `cua_install_progress` 事件
/// 推送。装完自动尝试 start_daemon。
///
/// 这里用 `spawn_blocking` 把同步阻塞 IO 移出 Tauri 异步运行时——安装
/// 脚本最长可能跑几分钟，期间不能让 Tauri runtime 卡住。
#[tauri::command(rename_all = "snake_case")]
pub async fn cua_driver_install(app: AppHandle) -> Result<CuaInstallResult, CuaError> {
    let os = std::env::consts::OS;
    // 不支持平台：直接拒绝，不下到 spawn_blocking。
    match os {
        "macos" | "linux" | "windows" => {}
        other => return Err(CuaError::installer_unsupported_platform(other)),
    }
    // 探测 install 脚本：网络 / curl 不可用时立刻失败，避免长等待。
    let preflight = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || crate::services::cua::install_driver(&app)
    });
    match preflight.await {
        Ok(result) => {
            if result.success {
                Ok(result)
            } else {
                // 把 installer 文本错误归到最有意义的 kind 上。
                let detail = result.error.unwrap_or_else(|| "unknown".into());
                let lower = detail.to_lowercase();
                let err = if lower.contains("timeout") {
                    CuaError::installer_timeout(30)
                } else if lower.contains("network")
                    || lower.contains("dns")
                    || lower.contains("could not resolve")
                    || lower.contains("connection refused")
                {
                    CuaError::installer_network_unavailable(&detail)
                } else if lower.contains("permission") || lower.contains("denied") {
                    CuaError::installer_permission_denied(&detail)
                } else {
                    CuaError::installer_curl_failed(&detail)
                };
                Err(err)
            }
        }
        Err(join_err) => Err(CuaError::io(&format!(
            "installer task join error: {join_err}"
        ))),
    }
}

/// 检查更新 +（可选）应用。`apply=false` 时只跑 `check-update`。
#[tauri::command(rename_all = "snake_case")]
pub async fn cua_driver_update(apply: bool) -> Result<CuaUpdateResult, CuaError> {
    // 同步逻辑交给 blocking pool；install 路径已经示范，这里一致处理。
    let join = tauri::async_runtime::spawn_blocking(move || {
        crate::services::cua::update_driver(apply)
    })
    .await
    .map_err(|e| CuaError::io(&format!("update task join error: {e}")))?;
    if let Some(err) = join.error.as_deref() {
        // check-update 自身可能因为未安装驱动而失败——但前端应有前置
        // detect 守卫；这里仍把网络 / 通用 IO 区分。
        let lower = err.to_lowercase();
        let mapped = if lower.contains("network")
            || lower.contains("dns")
            || lower.contains("connection")
        {
            CuaError::installer_network_unavailable(err)
        } else {
            CuaError::installer_curl_failed(err)
        };
        Err(mapped)
    } else {
        Ok(join)
    }
}

/// 把 install 命令（program / args）暴露给前端做展示（无 spawn）。主
/// 要给设置面板「即将运行的命令」用，UI 自行展示。Linux 上额外带
/// apt 依赖检查结果。
#[tauri::command(rename_all = "snake_case")]
pub fn cua_driver_install_preview() -> Result<InstallPreview, CuaError> {
    crate::services::cua::build_install_preview().map_err(|detail| match std::env::consts::OS {
        "macos" | "linux" | "windows" => CuaError::not_executed(&detail),
        other => CuaError::installer_unsupported_platform(other),
    })
}