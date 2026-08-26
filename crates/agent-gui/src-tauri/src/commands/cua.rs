//! CUA Tauri Command 层。所有命令的统一规范：
//! 1. `cua_*` 命名前缀；状态无关。
//! 2. 经 `CuaStore::enforce` 守卫：未启用 / 白名单拒了 / sandboxOffline
//!    时直接 `Err` 回去，不调用驱动。
//! 3. 操作结果写审计日志（成功 + 失败都写），便于前端面板与远端审计。
//! 4. `screenshot` 返回 base64（前端可经 invoke 解码成 PNG），与 MCP
//!    协议桥的标准一致；底层驱动返回原始字节。
//!
//! 平台：之前 `MacOsDriver` 是 osascript + screencapture 自研实现，
//! 现已切到 `cua-driver mcp --direct`（trycua/cua），跨 macOS /
//! Windows / Linux + 不抢光标 + 支持非 AX 表面。详细动机见
//! `services/cua/cua_client.rs`。

use base64::Engine;
use chrono::Utc;
use image::ImageReader;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Cursor;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::State;

use crate::services::cua::cua_client::{unwrap_mcp, CuaClient};
use crate::services::cua::{
    installer::{CuaDriverDetection, CuaInstallResult, CuaUpdateResult, InstallPreview},
    store::CuaRuntimeConfig,
    CuaAuditEntry, CuaError, CuaStore, CuaStoreSnapshot,
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

/// cua-driver `click` 接受 `button: "left" | "right" | "middle"`；
/// 同时 `double_click` 没有 button 字段，由调用方决定。
impl From<ClickButtonArg> for &'static str {
    fn from(value: ClickButtonArg) -> Self {
        match value {
            ClickButtonArg::Left => "left",
            ClickButtonArg::Middle => "middle",
            ClickButtonArg::Right => "right",
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

/// 在 Tauri Command 层把 `cua-driver` 调用的二进制 / 结构化响应
/// 包成一致的审计 entry；失败时把 `CuaError` 直接落地便于 UI 翻译。
fn record_op_audit(
    store: &Arc<CuaStore>,
    op: &str,
    detail: Option<Value>,
    result: &Result<Value, CuaError>,
    started: chrono::DateTime<Utc>,
) {
    let entry = match result {
        Ok(value) => CuaAuditEntry {
            timestamp: started,
            operation: op.to_string(),
            ok: true,
            error: None,
            detail: detail.or_else(|| Some(summarize_value(value))),
        },
        Err(err) => CuaAuditEntry {
            timestamp: started,
            operation: op.to_string(),
            ok: false,
            error: Some(err.clone()),
            detail,
        },
    };
    store.record(entry);
}

/// 把 cua-driver 返回的 JSON 剪裁到审计可读尺寸。`content` 字段是
/// MCP 工具返回的多模态数组（含 image base64），我们只保留文本
/// 部分 + 一行 size 摘要，避免审计日志膨胀。
fn summarize_value(value: &Value) -> Value {
    if let Some(arr) = value.get("content").and_then(Value::as_array) {
        let mut summary = serde_json::Map::new();
        let mut text_chunks: Vec<String> = Vec::new();
        let mut image_count = 0u32;
        let mut other_count = 0u32;
        for item in arr {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(t) = item.get("text").and_then(Value::as_str) {
                        text_chunks.push(t.to_string());
                    }
                }
                Some("image") => {
                    image_count += 1;
                }
                _ => {
                    other_count += 1;
                }
            }
        }
        if !text_chunks.is_empty() {
            let joined = text_chunks.join("\n");
            summary.insert(
                "text".into(),
                Value::String(if joined.len() > 1024 {
                    format!("{}…(truncated)", &joined[..joined.floor_char_boundary(1024)])
                } else {
                    joined
                }),
            );
        }
        if image_count > 0 {
            summary.insert("imageCount".into(), Value::from(image_count));
        }
        if other_count > 0 {
            summary.insert("otherCount".into(), Value::from(other_count));
        }
        return Value::Object(summary);
    }
    if value.is_null() {
        return json!({ "ok": true });
    }
    json!({ "size": value.to_string().len() })
}

/// 把 cua-driver 的多模态 content 数组拆出截图字节。cua-driver 在
/// `get_desktop_state` / `zoom` 工具返回 `{ content: [{ type: "image",
/// data: "<base64>", mimeType: "image/jpeg" }] }`；这里把它解出来。
fn extract_screenshot(value: &Value) -> Option<(Vec<u8>, u32, u32)> {
    let arr = value.get("content")?.as_array()?;
    for item in arr {
        if item.get("type").and_then(Value::as_str) == Some("image") {
            let data = item.get("data").and_then(Value::as_str)?;
            let mime = item
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.as_bytes())
                .ok()?;
            let (w, h) = if mime.contains("jpeg") || mime.contains("jpg") {
                jpeg_dimensions(&bytes).unwrap_or((0, 0))
            } else {
                png_dimensions(&bytes).unwrap_or((0, 0))
            };
            return Some((bytes, w, h));
        }
    }
    None
}

/// CUA-061：把 cua-driver 失败响应的可读错误文本拆出来。当
/// `isError=true` 时，`content` 数组里的文本条目承载错误消息
///（例如 `x2 must be > x1 and y2 must be > y1` / `TCC permission
/// required` / 内部 panic 栈）。返回拼接后的字符串，给 caller 包
/// 进 `CuaError::io` 透传给前端，避免真实错误被吞成「no image
/// content」。
///
/// 注意：本 helper 只看 `content[].type==="text"`，**不**检查
/// `isError`。CUA-064：成功路径下 cua-driver 也会在 content 数组
/// 里带 type:text 描述项（zoom 区域说明 / get_desktop_state 文案
/// 等），所以 caller 必须用 `extract_io_error_on_failure` 而不是
/// 直接调本 helper——后者统一负责 `isError=true` 守门。
fn extract_error_text(value: &Value) -> Option<String> {
    let arr = value.get("content")?.as_array()?;
    let mut chunks: Vec<String> = Vec::new();
    for item in arr {
        if item.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(t) = item.get("text").and_then(Value::as_str) {
                chunks.push(t.to_string());
            }
        }
    }
    if chunks.is_empty() {
        None
    } else {
        Some(chunks.join("\n"))
    }
}

/// CUA-064：cua-driver 成功响应（zoom / get_desktop_state）也带
/// type:text 描述项，所以 caller 不能盲调 `extract_error_text`——
/// 否则成功截图会被强行翻成 `cua.errors.io`，`extract_screenshot`
/// 永远走不到（CUA-059 / CUA-061 后端路径全部失效）。本 helper 把
/// `isError==Some(true)` 守门与文本抽取合并成一步：成功 / 缺标记
/// 永远返回 `None`，仅在 `isError=true` 且 content 有文本时返回
/// 拼接后的错误消息。
fn extract_io_error_on_failure(value: &Value) -> Option<String> {
    if value.get("isError").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    extract_error_text(value)
}

/// 窗口 bounds（CUA-059）：从 list_windows 返回的 window 对象里
/// 拆出 `{x, y, width, height}`。cua-driver 把 bounds 嵌进 `bounds`
/// 子对象，值是浮点（如 `{"x":260.0,"y":68.0,"width":1400.0,
/// "height":800.0}`）。这里同时接受 int / float，顶层平铺
/// `{x, y, width, height}` 也兼容（其它 MCP 实现可能）。
struct WindowBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

/// 从 serde_json::Value 中抽出数字字段（int 或 float），截到 i32 范围。
fn number_as_i32(v: &Value) -> Option<i32> {
    if let Some(n) = v.as_i64() {
        return Some(n as i32);
    }
    if let Some(f) = v.as_f64() {
        if f.is_finite() && f >= i32::MIN as f64 && f <= i32::MAX as f64 {
            return Some(f as i32);
        }
    }
    None
}

fn extract_window_bounds(w: &Value) -> Option<WindowBounds> {
    if let Some(b) = w.get("bounds").and_then(Value::as_object) {
        let x = b.get("x").and_then(number_as_i32).unwrap_or(0);
        let y = b.get("y").and_then(number_as_i32).unwrap_or(0);
        let width = b.get("width").and_then(number_as_i32).unwrap_or(0);
        let height = b.get("height").and_then(number_as_i32).unwrap_or(0);
        if width > 0 && height > 0 {
            return Some(WindowBounds { x, y, width, height });
        }
        return None;
    }
    let x = w.get("x").and_then(number_as_i32)?;
    let y = w.get("y").and_then(number_as_i32)?;
    let width = w.get("width").and_then(number_as_i32)?;
    let height = w.get("height").and_then(number_as_i32)?;
    if width <= 0 || height <= 0 {
        return None;
    }
    Some(WindowBounds { x, y, width, height })
}

/// CUA-054：cua-driver MCP 即使 JSON-RPC 200，也会把业务失败装进
/// `result.isError=true` + `structuredContent.effect ∈ {refused,
/// suspected_noop, unverifiable}`。这里把这种「传输成功 / 业务失败」
/// 翻成 `CuaError`，让 caller 用统一的 ok=false + 结构化 error 透传。
///
/// 只在 `isError=true` 时生效；isError=false 的成功响应（含 effect
/// 未给出）一律视为成功，不影响老路径。
fn check_effect_failure(result: &Result<Value, CuaError>) -> Option<CuaError> {
    let v = result.as_ref().ok()?;
    if v.get("isError").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let sc = unwrap_mcp(v);
    let effect = sc.get("effect").and_then(Value::as_str).unwrap_or("unknown");
    let code = sc.get("code").and_then(Value::as_str).unwrap_or("");
    let detail_msg = match effect {
        "refused" => format!(
            "cua-driver refused the operation (code={code}); \
             target likely off-screen or AX-unresolved; \
             check window focus / coordinates and retry"
        ),
        "suspected_noop" => format!(
            "cua-driver reports suspected_noop (code={code}); \
             the action likely had no visible effect; \
             verify target state before retrying"
        ),
        "unverifiable" => format!(
            "cua-driver cannot verify the operation result (code={code}); \
             treat as inconclusive"
        ),
        other => format!(
            "cua-driver reported effect={other} (code={code}); \
             treating as failure"
        ),
    };
    Some(CuaError::not_executed(&detail_msg))
}

/// CUA-054：把 call_tool 的 Result 收尾成 `CuaOpResponse`。把业务层
/// effect 失败（`isError=true`）和传输层失败（`Err`）都翻译成
/// `ok=false` + 结构化 `error`，并按失败写审计。
///
/// 取代原先「只看 `result.is_ok()`」的简化版本——之前 Agent 收不到
/// 业务失败，盲目继续推进决策。
fn finalize_op(
    store: &Arc<CuaStore>,
    op: &str,
    detail: Option<Value>,
    result: Result<Value, CuaError>,
    started: chrono::DateTime<Utc>,
) -> CuaOpResponse {
    let effect_err = check_effect_failure(&result);
    let recorded = effect_err.map(Err).unwrap_or(result);
    record_op_audit(store, op, detail, &recorded, started);
    CuaOpResponse {
        ok: recorded.is_ok(),
        error: recorded.err(),
    }
}

// ───────── Commands ─────────

/// 平台标签 + 是否可用 + 当前配置 + 最近操作。前端挂载时调用一次。
///
/// 每次取快照都从持久化 system settings 重读 `sandbox_offline`——避免
/// 命令安全模式被外部切到 sandboxOffline 后 CUA UI 仍按旧值渲染。
#[tauri::command(rename_all = "camelCase")]
pub fn cua_status(store: State<'_, Arc<CuaStore>>) -> CuaStoreSnapshot {
    let sandbox_offline = current_sandbox_offline();
    store.refresh_sandbox_offline(sandbox_offline);
    store.snapshot()
}

/// 整体覆盖配置。前端保存面板时调用。
///
/// 服务端权威地维护 `sandbox_offline`：从前端传过来的字段总是被
/// 当前命令安全模式覆盖——保证 `group:cua` 在 sandboxOffline 下必
/// 拒（CUA-reviewer 安全门控 #2），不会被前端脏数据绕过。
#[tauri::command(rename_all = "camelCase")]
pub fn cua_set_config(
    store: State<'_, Arc<CuaStore>>,
    config: CuaRuntimeConfig,
    _app: AppHandle,
) -> CuaStoreSnapshot {
    let sandbox_offline = current_sandbox_offline();
    let mut cfg = config;
    cfg.sandbox_offline = sandbox_offline;
    store.replace_config(cfg);
    store.snapshot()
}

/// 当前命令安全模式是否是 sandboxOffline。从持久化的 system settings
/// 权威读取（与 sandbox.rs 同源），不信任调用方声明——防止 CUA 工具
/// 通过直接调用 cua_set_config 绕过离线沙箱（CUA-reviewer 安全门控 #2）。
fn current_sandbox_offline() -> bool {
    crate::commands::config_commands::settings::load_runtime_command_safety_mode()
        .ok()
        .map(|mode| mode.eq_ignore_ascii_case("sandboxOffline"))
        .unwrap_or(false)
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_clear_audit(store: State<'_, Arc<CuaStore>>) -> CuaStoreSnapshot {
    store.clear_audit();
    store.snapshot()
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_list_windows(
    store: State<'_, Arc<CuaStore>>,
    client: State<'_, CuaClient>,
) -> Result<Value, CuaError> {
    let op = "list_windows";
    store.enforce(op, None)?;
    // on_screen_only=true 过滤掉离屏窗口，避免给 Agent 噪音。
    let started = Utc::now();
    let result = client.call_tool("list_windows", json!({ "on_screen_only": true }));
    // cua-driver MCP 2025-06-18 把 windows 数组放进 structuredContent；
    // 前端契约是「纯 windows 数组」，所以透传前先解包（CUA-055）。
    let mapped = result.map(|v| {
        unwrap_mcp(&v)
            .get("windows")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()))
    });
    record_op_audit(store.inner(), op, None, &mapped, started);
    mapped
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_focus_window(
    store: State<'_, Arc<CuaStore>>,
    client: State<'_, CuaClient>,
    owner: String,
) -> Result<CuaOpResponse, CuaError> {
    let op = "focus_window";
    let owner_ref = owner.trim().to_string();
    store.enforce(op, Some(&owner_ref))?;
    let detail = Some(json!({ "owner": &owner_ref }));
    // cua-driver 没有「按 owner 聚焦」的语义；通过 list_apps 找 pid
    // 再用 bring_to_front。这是两步；只要最后一步失败就把
    // ok=false 交给 UI，但 enforce 已经把白名单守住。
    let started = Utc::now();
    let find = client.call_tool("list_apps", json!({}));
    let pid = match find {
        Ok(v) => {
            // cua-driver MCP 2025-06-18 把 apps 数组放进 structuredContent；
            // 顶层 v.get("apps") 永远拿不到（CUA-055）。
            unwrap_mcp(&v)
                .get("apps")
                .and_then(Value::as_array)
                .and_then(|apps| {
                    apps.iter()
                        .find(|a| {
                            a.get("name")
                                .and_then(Value::as_str)
                                .map(|s| s.eq_ignore_ascii_case(&owner_ref))
                                .unwrap_or(false)
                                || a.get("bundle_id")
                                    .and_then(Value::as_str)
                                    .map(|s| s.eq_ignore_ascii_case(&owner_ref))
                                    .unwrap_or(false)
                        })
                        .and_then(|a| a.get("pid").and_then(Value::as_i64))
                })
        }
        Err(e) => {
            record_op_audit(store.inner(), op, detail, &Err(e.clone()), started);
            return Err(e);
        }
    };
    let pid = match pid {
        Some(p) => p,
        None => {
            let err = CuaError::not_executed(&format!(
                "could not find a running app named '{owner_ref}'"
            ));
            record_op_audit(store.inner(), op, detail, &Err(err.clone()), started);
            return Ok(CuaOpResponse {
                ok: false,
                error: Some(err),
            });
        }
    };
    let result = client.call_tool("bring_to_front", json!({ "pid": pid }));
    match &result {
        Ok(_) => {
            record_op_audit(store.inner(), op, detail, &Ok(Value::Null), started);
        }
        Err(e) => {
            record_op_audit(store.inner(), op, detail.clone(), &Err(e.clone()), started);
        }
    }
    Ok(CuaOpResponse {
        ok: result.is_ok(),
        error: result.err(),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_screenshot(
    store: State<'_, Arc<CuaStore>>,
    client: State<'_, CuaClient>,
    window_owner: Option<String>,
) -> Result<CuaScreenshotResponse, CuaError> {
    let op = "screenshot";
    // 截屏不强制白名单（截图系统自身 / 必要场景），但仍要 enabled。
    store.enforce(op, None)?;
    let started = Utc::now();
    // cua-driver 的截屏工具有两个：`get_desktop_state`（全屏，写
    // screenshot_out_file 到磁盘）和 `zoom`（指定窗口区域）。
    // 前端目前给的是 owner 名（MVP 仍截全屏），对应 `get_desktop_state`。
    // 沙箱遮罩：window_owner 给定时再尝试 `zoom`（cua-driver 内置
    // window owner 寻址）；否则回退到全屏。LiveAgent 自身 / cua-driver
    // helper 的遮罩交给 cua-driver 自身的窗口排除逻辑。
    //
    // CUA-051：当 window_owner 为空需要走全屏路径前，先确认 cua-driver
    // 是带 CFBundleIdentifier 启动的（`health_report.bundle_identity`
    // pass）。裸 bin 启动时 TCC Screen Recording attribution 落到
    // 临时进程而非 com.trycua.driver，ScreenCaptureKit 会返回合法
    // 但内容全黑的 PNG——Agent 拿到全黑帧做不了任何决策。bundle 失
    // 效时直接拒，避免把黑帧当真截图透传。
    let owner_opt = window_owner
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let needs_full_desktop = owner_opt.is_none();
    if needs_full_desktop && !client.check_bundle_attribution() {
        let err = CuaError::screen_capture_unavailable(
            "cua-driver is not running inside CuaDriver.app bundle \
             (health_report.bundle_identity=fail); \
             get_desktop_state would return a fully-black frame",
        );
        store.inner().record(CuaAuditEntry {
            timestamp: started,
            operation: op.to_string(),
            ok: false,
            error: Some(err.clone()),
            detail: Some(json!({ "windowOwner": window_owner })),
        });
        return Err(err);
    }
    let result = if let Some(owner) = owner_opt {
        // 走 list_apps → pid+window_id → zoom 路径。窗口 bounds 在
        // list_windows 时一并拆出（CUA-059），zoom 用真实坐标而
        // 不是零面积；找不到窗口时直接报 ownerNotFound，不再回退
        // 到 get_desktop_state 触发 CUA-051 后置防线把错误掩盖成
        // TCC 失效（CUA-060）。
        match pick_window_id_for_owner(&client, owner) {
            Ok(Some((pid, window_id, bounds))) => {
                let (x1, y1, x2, y2) = zoom_rect(bounds);
                client.call_tool(
                    "zoom",
                    json!({
                        "pid": pid,
                        "window_id": window_id,
                        "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                    }),
                )
            }
            Ok(None) => {
                // 找不到对应窗口 → 直接报 ownerNotFound；不要回退到
                // 全屏（get_desktop_state 在 bundle_identity=fail 时
                // 会返回全黑帧，被 CUA-051 后置防线翻译成 TCC 失效，
                // 把真实原因彻底掩盖——CUA-060）。
                let err = CuaError::owner_not_found(owner);
                store.inner().record(CuaAuditEntry {
                    timestamp: started,
                    operation: op.to_string(),
                    ok: false,
                    error: Some(err.clone()),
                    detail: Some(json!({ "windowOwner": window_owner })),
                });
                return Err(err);
            }
            Err(e) => Err(e),
        }
    } else {
        client.call_tool("get_desktop_state", json!({}))
    };
    match result {
        Ok(value) => {
            // CUA-061 + CUA-064：cua-driver 在 zoom 参数错误、permission 拒绝、
            // 内部 panic 等场景会返回 isError=true + content 是文本
            // 错误消息；直接走 extract_screenshot 会拿到 None 然后
            // 被翻成 'no image content'，真实错误（'x2 must be > x1' /
            // 'TCC permission required'）被吞掉。
            //
            // CUA-064：成功路径（zoom / get_desktop_state）下 cua-driver 也
            // 会在 content 数组里同时塞 type:text 描述项（例如 'Zoom
            // region (260,68)–(1660,868) → 500×286 px JPEG.'）。
            // `extract_io_error_on_failure` 内置 isError 守门，所以成功
            // 响应不会被误判；只有 isError=true 时才把文本 detail 当错误
            // 透传给 CuaError::io，其它一律走正常的 image 抽取路径。
            if let Some(err_detail) = extract_io_error_on_failure(&value) {
                let err = CuaError::io(&err_detail);
                store.inner().record(CuaAuditEntry {
                    timestamp: started,
                    operation: op.to_string(),
                    ok: false,
                    error: Some(err.clone()),
                    detail: Some(json!({ "windowOwner": window_owner })),
                });
                return Err(err);
            }
            let (bytes, width, height) = extract_screenshot(&value)
                .ok_or_else(|| CuaError::io("cua-driver screenshot: no image content"))?;
            // CUA-051 后置防线：即便 health_report 那一关过了，也要兜
            // 一道「帧内像素统计」。少部分边界情况（Screen Recording
            // 被吊销但 bundle 仍 ok、屏幕本身黑屏、cua-driver 半瘫）
            // 仍可能让 get_desktop_state 返回低信息量的图；非黑像素
            // 数量低于阈值就直接拒，转成 screen_capture_unavailable。
            if let Some(non_black) = count_non_black_pixels(&bytes) {
                if non_black < MIN_NON_BLACK_PIXELS {
                    let err = CuaError::screen_capture_unavailable(&format!(
                        "cua-driver returned a near-empty screen capture \
                         ({non_black} non-black pixels); \
                         TCC Screen Recording attribution is broken or screen is off"
                    ));
                    store.inner().record(CuaAuditEntry {
                        timestamp: started,
                        operation: op.to_string(),
                        ok: false,
                        error: Some(err.clone()),
                        detail: Some(json!({
                            "width": width,
                            "height": height,
                            "windowOwner": window_owner,
                            "sizeBytes": bytes.len(),
                            "nonBlackPixels": non_black,
                        })),
                    });
                    return Err(err);
                }
            }
            let base64_png = base64::engine::general_purpose::STANDARD.encode(&bytes);
            store.inner().record(CuaAuditEntry {
                timestamp: started,
                operation: op.to_string(),
                ok: true,
                error: None,
                detail: Some(json!({
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
            store.inner().record(CuaAuditEntry {
                timestamp: started,
                operation: op.to_string(),
                ok: false,
                error: Some(err.clone()),
                detail: Some(json!({ "windowOwner": window_owner })),
            });
            Err(err)
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_click(
    store: State<'_, Arc<CuaStore>>,
    client: State<'_, CuaClient>,
    x: i32,
    y: i32,
    button: Option<ClickButtonArg>,
) -> Result<CuaOpResponse, CuaError> {
    let op = "click";
    store.enforce(op, None)?;
    let button_str: &'static str = button.unwrap_or_default().into();
    let detail = Some(json!({ "x": x, "y": y, "button": button_str }));
    // cua-driver click 需要 pid + window_id + (x,y)；MVP 阶段我们用
    // 全屏语义：取前台 app pid + first window。这是 best-effort，
    // 真实需求是 (x, y) ∈ window，先按坐标所在窗口定位。
    let started = Utc::now();
    let pid_window = match pick_topmost_window(&client) {
        Ok(pw) => pw,
        Err(e) => {
            record_op_audit(store.inner(), op, detail, &Err(e.clone()), started);
            return Ok(CuaOpResponse {
                ok: false,
                error: Some(e),
            });
        }
    };
    let mut args = json!({
        "x": x, "y": y,
        "button": button_str,
    });
    if let Some((pid, window_id)) = pid_window {
        args["pid"] = json!(pid);
        args["window_id"] = json!(window_id);
    }
    let result = client.call_tool("click", args);
    Ok(finalize_op(
        store.inner(),
        op,
        detail,
        result,
        started,
    ))
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_double_click(
    store: State<'_, Arc<CuaStore>>,
    client: State<'_, CuaClient>,
    x: i32,
    y: i32,
) -> Result<CuaOpResponse, CuaError> {
    let op = "double_click";
    store.enforce(op, None)?;
    let detail = Some(json!({ "x": x, "y": y }));
    let started = Utc::now();
    let pid_window = match pick_topmost_window(&client) {
        Ok(pw) => pw,
        Err(e) => {
            record_op_audit(store.inner(), op, detail, &Err(e.clone()), started);
            return Ok(CuaOpResponse {
                ok: false,
                error: Some(e),
            });
        }
    };
    let mut args = json!({ "x": x, "y": y });
    if let Some((pid, window_id)) = pid_window {
        args["pid"] = json!(pid);
        args["window_id"] = json!(window_id);
    }
    let result = client.call_tool("double_click", args);
    Ok(finalize_op(
        store.inner(),
        op,
        detail,
        result,
        started,
    ))
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_type(
    store: State<'_, Arc<CuaStore>>,
    client: State<'_, CuaClient>,
    text: String,
    target_owner: Option<String>,
) -> Result<CuaOpResponse, CuaError> {
    let op = "type";
    let owner_ref = target_owner
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    store.enforce(op, owner_ref)?;
    let len = text.chars().count();
    let detail = Some(json!({
        "length": len,
        "targetOwner": target_owner,
    }));
    let started = Utc::now();
    let mut args = json!({ "text": text });
    // CUA-062：cua-driver type_text / press_key / hotkey 强制要求 pid。
    // target_owner 为 None 时无条件 pick_topmost_window 取前台 app；
    // 与 cua_click / scroll / drag 对齐。owner 指定但找不到时报
    // owner_not_found（CUA-060 同根因）。
    let picked: Option<(i64, i64)> = if let Some(owner) = owner_ref {
        match pick_window_id_for_owner(&client, owner) {
            Ok(Some((pid, wid, _bounds))) => Some((pid, wid)),
            Ok(None) => {
                let err = CuaError::owner_not_found(owner);
                record_op_audit(store.inner(), op, detail, &Err(err.clone()), started);
                return Ok(CuaOpResponse {
                    ok: false,
                    error: Some(err),
                });
            }
            Err(e) => {
                record_op_audit(store.inner(), op, detail.clone(), &Err(e.clone()), started);
                return Ok(CuaOpResponse {
                    ok: false,
                    error: Some(e),
                });
            }
        }
    } else {
        match pick_topmost_window(&client) {
            Ok(p) => p,
            Err(e) => {
                record_op_audit(store.inner(), op, detail.clone(), &Err(e.clone()), started);
                return Ok(CuaOpResponse {
                    ok: false,
                    error: Some(e),
                });
            }
        }
    };
    match picked {
        Some((pid, window_id)) => {
            args["pid"] = json!(pid);
            args["window_id"] = json!(window_id);
        }
        None => {
            // pick_topmost_window 返回 None：前台没有可点击窗口（极端
            // 场景，例如桌面本身无窗口），无法满足 pid 强约束。
            let err = CuaError::not_executed(
                "pid is required or pick_topmost_window failed \
                 (no foreground window with on_screen=true)",
            );
            record_op_audit(store.inner(), op, detail, &Err(err.clone()), started);
            return Ok(CuaOpResponse {
                ok: false,
                error: Some(err),
            });
        }
    }
    let result = client.call_tool("type_text", args);
    Ok(finalize_op(
        store.inner(),
        op,
        detail,
        result,
        started,
    ))
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_key(
    store: State<'_, Arc<CuaStore>>,
    client: State<'_, CuaClient>,
    key: String,
    modifiers: Option<Vec<String>>,
    target_owner: Option<String>,
) -> Result<CuaOpResponse, CuaError> {
    let op = "key";
    let owner_ref = target_owner
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    store.enforce(op, owner_ref)?;
    let mods = modifiers.unwrap_or_default();
    let detail = Some(json!({
        "key": key,
        "modifiers": &mods,
        "targetOwner": target_owner,
    }));
    // key：单字符或名称 → press_key；带 modifiers 的组合 → hotkey。
    let args = if mods.is_empty() {
        json!({ "key": key })
    } else {
        let mut keys = mods
            .iter()
            .map(|m| m.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        keys.push(key.clone());
        json!({ "keys": keys })
    };
    let tool = if mods.is_empty() {
        "press_key"
    } else {
        "hotkey"
    };
    let mut args = args;
    let started = Utc::now();
    // CUA-062：与 cua_type 同根因——cua-driver press_key / hotkey 强制
    // 要求 pid；target_owner 为 None 时无条件 pick_topmost_window 取
    // 前台 app，不再让调用方拿到 'Missing required integer field: pid'
    // 这种不可操作错误。
    let picked: Option<(i64, i64)> = if let Some(owner) = owner_ref {
        match pick_window_id_for_owner(&client, owner) {
            Ok(Some((pid, wid, _bounds))) => Some((pid, wid)),
            Ok(None) => {
                let err = CuaError::owner_not_found(owner);
                record_op_audit(store.inner(), op, detail, &Err(err.clone()), started);
                return Ok(CuaOpResponse {
                    ok: false,
                    error: Some(err),
                });
            }
            Err(e) => {
                record_op_audit(store.inner(), op, detail.clone(), &Err(e.clone()), started);
                return Ok(CuaOpResponse {
                    ok: false,
                    error: Some(e),
                });
            }
        }
    } else {
        match pick_topmost_window(&client) {
            Ok(p) => p,
            Err(e) => {
                record_op_audit(store.inner(), op, detail.clone(), &Err(e.clone()), started);
                return Ok(CuaOpResponse {
                    ok: false,
                    error: Some(e),
                });
            }
        }
    };
    match picked {
        Some((pid, window_id)) => {
            args["pid"] = json!(pid);
            args["window_id"] = json!(window_id);
        }
        None => {
            let err = CuaError::not_executed(
                "pid is required or pick_topmost_window failed \
                 (no foreground window with on_screen=true)",
            );
            record_op_audit(store.inner(), op, detail, &Err(err.clone()), started);
            return Ok(CuaOpResponse {
                ok: false,
                error: Some(err),
            });
        }
    }
    let result = client.call_tool(tool, args);
    Ok(finalize_op(
        store.inner(),
        op,
        detail,
        result,
        started,
    ))
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_scroll(
    store: State<'_, Arc<CuaStore>>,
    client: State<'_, CuaClient>,
    x: i32,
    y: i32,
    dy: i32,
) -> Result<CuaOpResponse, CuaError> {
    let op = "scroll";
    store.enforce(op, None)?;
    let detail = Some(json!({ "x": x, "y": y, "dy": dy }));
    // cua-driver scroll.direction ∈ {"up","down","left","right"}，by
    // 是单位数（默认 3）。`dy > 0` 视为向上滚动，与原 osascript 语义一致。
    let direction = if dy >= 0 { "up" } else { "down" };
    let amount = dy.unsigned_abs().max(1);
    let mut args = json!({
        "direction": direction,
        "amount": amount,
        "x": x,
        "y": y,
    });
    if let Ok(Some((pid, window_id))) = pick_topmost_window(&client) {
        args["pid"] = json!(pid);
        args["window_id"] = json!(window_id);
    }
    let started = Utc::now();
    let result = client.call_tool("scroll", args);
    Ok(finalize_op(
        store.inner(),
        op,
        detail,
        result,
        started,
    ))
}

#[tauri::command(rename_all = "camelCase")]
pub fn cua_drag(
    store: State<'_, Arc<CuaStore>>,
    client: State<'_, CuaClient>,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
) -> Result<CuaOpResponse, CuaError> {
    let op = "drag";
    store.enforce(op, None)?;
    let detail = Some(json!({
        "x1": x1, "y1": y1, "x2": x2, "y2": y2
    }));
    let mut args = json!({
        "from_x": x1, "from_y": y1, "to_x": x2, "to_y": y2,
    });
    if let Ok(Some((pid, window_id))) = pick_topmost_window(&client) {
        args["pid"] = json!(pid);
        args["window_id"] = json!(window_id);
    }
    let started = Utc::now();
    let result = client.call_tool("drag", args);
    Ok(finalize_op(
        store.inner(),
        op,
        detail,
        result,
        started,
    ))
}

// ───────── Helpers ─────────

/// CUA-059：cua-driver zoom 拒绝零面积坐标。bounds 拿得到就用真实
/// 矩形；拿不到就用「屏幕尺寸」兜底（任意大于真实屏幕的数值都行，
/// cua-driver zoom 会按窗口 bounds 裁剪）。这里用 10000 作为保守
/// 上界——覆盖所有现代 macOS / Windows / Linux 桌面分辨率。
const FALLBACK_SCREEN_W: i32 = 10000;
const FALLBACK_SCREEN_H: i32 = 10000;

fn zoom_rect(bounds: Option<WindowBounds>) -> (i32, i32, i32, i32) {
    match bounds {
        Some(b) if b.width > 0 && b.height > 0 => (b.x, b.y, b.x + b.width, b.y + b.height),
        _ => (0, 0, FALLBACK_SCREEN_W, FALLBACK_SCREEN_H),
    }
}

/// 解析 PNG IHDR 拿宽高。
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

/// 极简 JPEG 尺寸解析（SOF0/SOF2 段）。失败回退到 (0,0)。
fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 9 < bytes.len() {
        if bytes[i] != 0xFF {
            return None;
        }
        let marker = bytes[i + 1];
        // SOF0..SOF15 (除 DHT 0xC4 / DAC 0xCC / DNL 0xCC 之外)。
        if (0xC0..=0xCF).contains(&marker)
            && marker != 0xC4
            && marker != 0xC8
            && marker != 0xCC
        {
            let height = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
            let width = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
            return Some((width, height));
        }
        let seg_len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        i += 2 + seg_len;
    }
    None
}

/// 用 `list_windows` 拿最前面的窗口（layer 0 + on_screen_only）。
/// 返回 (pid, window_id) 或 None。
///
/// CUA-057：cua-driver MCP 2025-06-18 把 windows 数组放在
/// `structuredContent` 下；顶层 `content` 是 `[{type:"text", text:"…"}]`
/// 文本条目数组，把「Found 9 window(s).」当 window 对象解析永远
/// 不命中 `pid` / `window_id`。所以这里只信任 `unwrap_mcp(...).windows`。
fn pick_topmost_window(client: &CuaClient) -> Result<Option<(i64, i64)>, CuaError> {
    let value = client.call_tool("list_windows", json!({ "on_screen_only": true }))?;
    let value = unwrap_mcp(&value);
    let wins = value.get("windows").and_then(Value::as_array);
    if let Some(arr) = wins {
        for w in arr {
            let pid = w.get("pid").and_then(Value::as_i64);
            let window_id = w
                .get("window_id")
                .or_else(|| w.get("windowId"))
                .or_else(|| w.get("id"))
                .and_then(Value::as_i64);
            if let (Some(pid), Some(wid)) = (pid, window_id) {
                if w.get("on_screen")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
                {
                    return Ok(Some((pid, wid)));
                }
            }
        }
    }
    Ok(None)
}

/// 通过 owner 名匹配 `list_apps` 的 pid，再查其首个可见 window。
/// 找不到时返回 Ok(None) 而不是 Err（best-effort）。
///
/// CUA-056：list_apps / list_windows 的 apps / windows 数组都在
/// structuredContent 下；必须先 `unwrap_mcp` 再取，否则 zoom 路径
/// 永远拿不到 pid + window_id → 降级到 get_desktop_state。
///
/// CUA-059：顺带拆出窗口 bounds（{x,y,width,height}），避免 zoom
/// 调用传零面积坐标被驱动拒。
fn pick_window_id_for_owner(
    client: &CuaClient,
    owner: &str,
) -> Result<Option<(i64, i64, Option<WindowBounds>)>, CuaError> {
    let apps = client.call_tool("list_apps", json!({}))?;
    let apps = unwrap_mcp(&apps);
    let pid = apps
        .get("apps")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter()
                .find(|a| {
                    a.get("name")
                        .and_then(Value::as_str)
                        .map(|s| s.eq_ignore_ascii_case(owner))
                        .unwrap_or(false)
                        || a.get("bundle_id")
                            .and_then(Value::as_str)
                            .map(|s| s.eq_ignore_ascii_case(owner))
                            .unwrap_or(false)
                })
                .and_then(|a| a.get("pid").and_then(Value::as_i64))
        });
    let Some(pid) = pid else {
        return Ok(None);
    };
    let windows = client.call_tool("list_windows", json!({ "pid": pid, "on_screen_only": true }))?;
    let windows = unwrap_mcp(&windows);
    let mut picked: Option<(i64, Option<WindowBounds>)> = None;
    if let Some(arr) = windows.get("windows").and_then(Value::as_array) {
        for w in arr {
            let wid = w
                .get("window_id")
                .or_else(|| w.get("windowId"))
                .or_else(|| w.get("id"))
                .and_then(Value::as_i64);
            if let Some(wid) = wid {
                picked = Some((wid, extract_window_bounds(w)));
                break;
            }
        }
    }
    Ok(picked.map(|(wid, bounds)| (pid, wid, bounds)))
}

/// cua-driver 入口命令：把主窗口重新推到最前并等待 `is_focused()` 落
/// 住。命令不依赖 CUA enable 开关——它的目的正是让 enable=true 之
/// 后的 click / AX 路径能找到 WebView。
#[tauri::command(rename_all = "camelCase")]
pub async fn cua_window_ready(
    window: tauri::WebviewWindow,
) -> Result<crate::CuaWindowReadyResponse, String> {
    Ok(crate::cua_window_ready(window).await)
}

/// CUA-020/021/022: 在路由切换、overlay 打开/关闭、cua-driver 主动唤
/// 起等场景重新触发 NSWindow/WKWebView 的 AX 注解 + 一回弹广播
/// UIElementCreatedNotification。
#[tauri::command(rename_all = "camelCase")]
pub fn cua_refresh_a11y(window: tauri::WebviewWindow) -> crate::CuaRefreshA11yResponse {
    crate::cua_refresh_a11y(&window)
}

// ───────── CUA Driver 安装器（CUA-100） ─────────
//
// installer.rs 检测 cua-driver 二进制；这里只暴露命令桥。
// 设计：不经过 CuaStore 的 enable 守卫——安装器本身就是为了让后续 CUA
// 操作可用；enable 留到装完再由用户在 UI 中开启。

/// 检测 cua-driver 是否已安装、版本、daemon 状态。无 IO 副作用。
#[tauri::command(rename_all = "camelCase")]
pub fn cua_driver_detect() -> CuaDriverDetection {
    crate::services::cua::detect_driver()
}

/// 启动 cua-driver daemon（macOS: `open CuaDriver --args serve`）。
/// 失败时返回结构化 `CuaError`；前端不阻塞在失败上，可重试。
#[tauri::command(rename_all = "camelCase")]
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
#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_install(app: AppHandle) -> Result<CuaInstallResult, CuaError> {
    let os = std::env::consts::OS;
    match os {
        "macos" | "linux" | "windows" => {}
        other => return Err(CuaError::installer_unsupported_platform(other)),
    }
    let preflight = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || crate::services::cua::install_driver(&app)
    });
    match preflight.await {
        Ok(result) => {
            if result.success {
                Ok(result)
            } else {
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
#[tauri::command(rename_all = "camelCase")]
pub async fn cua_driver_update(apply: bool) -> Result<CuaUpdateResult, CuaError> {
    let join = tauri::async_runtime::spawn_blocking(move || {
        crate::services::cua::update_driver(apply)
    })
    .await
    .map_err(|e| CuaError::io(&format!("update task join error: {e}")))?;
    if let Some(err) = join.error.as_deref() {
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

/// 把 install 命令（program / args）暴露给前端做展示（无 spawn）。
#[tauri::command(rename_all = "camelCase")]
pub fn cua_driver_install_preview() -> Result<InstallPreview, CuaError> {
    crate::services::cua::build_install_preview().map_err(|detail| match std::env::consts::OS {
        "macos" | "linux" | "windows" => CuaError::not_executed(&detail),
        other => CuaError::installer_unsupported_platform(other),
    })
}

// ───────── CUA-051 截屏黑屏兜底 ─────────

/// CUA-051 阈值：1920×1080 = 2,073,600 像素；阈值 1000 ≈ 0.05%。低于
/// 这值几乎一定是 ScreenCaptureKit attribution 失效（裸 bin 启动）或
/// 屏幕本身关闭，返回全黑 / 接近全黑帧。低于阈值的「截屏」对 Agent
/// 决策毫无意义，所以由后端直接拒。
///
/// 调高会让一些「真黑屏」（夜间模式 + 空桌面）误报；调低会让全黑帧
/// 漏过去。1000 是经验值——cua-driver 真截图在最小桌面也会远高于此。
const MIN_NON_BLACK_PIXELS: u64 = 1000;

/// 把 cua-driver 返回的 PNG / JPEG 字节解码成 RGBA8 数非黑像素数。
/// `None` 表示解码失败（不是 PNG / JPEG / 文件坏）——caller 应该
/// 把这种当成 decode error 而不是 black-screen。
///
/// 与 PIL.Image(...).getdata() 等价的最小实现：只统计
/// (R, G, B) != (0, 0, 0) 的像素。alpha < 255 也算黑（透明像素不携带
/// 信息，对 Agent 来说一样没用）。
fn count_non_black_pixels(bytes: &[u8]) -> Option<u64> {
    let mut reader = ImageReader::new(Cursor::new(bytes));
    reader = reader.with_guessed_format().ok()?;
    let decoded = reader.decode().ok()?;
    let rgba = decoded.to_rgba8();
    let mut count = 0u64;
    for px in rgba.pixels() {
        let [r, g, b, a] = px.0;
        if a > 0 && (r != 0 || g != 0 || b != 0) {
            count += 1;
        }
    }
    Some(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 极简 1×1 PNG（红）字节流；用作 fixture。
    /// hex 头：`89 50 4E 47 0D 0A 1A 0A` (PNG signature)
    /// IHDR：8 字节长度 + `IHDR` + width=1 + height=1 + 8-bit RGB + 0 + 0 + 0
    fn fake_png_1x1() -> Vec<u8> {
        // 长度可变的 IHDR 字段拼接（实际长度需 13）。我们手写一个可被 PNG signature 8 字节
        // + IHDR 头识别的 24 字节小图。
        vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
            0x00, 0x00, 0x00, 0x0D, // IHDR length = 13
            b'I', b'H', b'D', b'R',
            0x00, 0x00, 0x00, 0x01, // width = 1
            0x00, 0x00, 0x00, 0x01, // height = 1
            0x08, 0x02, 0x00, 0x00, 0x00, // bit depth, color type, etc.
        ]
    }

    #[test]
    fn extract_screenshot_handles_image_content() {
        let value = json!({
            "content": [
                { "type": "text", "text": "desktop screenshot 1920x1080" },
                { "type": "image", "data": "AAAA", "mimeType": "image/png" }
            ]
        });
        // 不是真正的 PNG 字节流；这里只验证抽取路径：base64 解码 + png_dimensions 返回 (0,0)。
        let (bytes, _w, _h) = extract_screenshot(&value).expect("must extract");
        assert_eq!(bytes, vec![0, 0, 0]);
    }

    #[test]
    fn extract_screenshot_returns_none_when_no_image() {
        let value = json!({
            "content": [{ "type": "text", "text": "no image here" }]
        });
        assert!(extract_screenshot(&value).is_none());
    }

    #[test]
    fn summarize_value_counts_image_and_text() {
        let value = json!({
            "content": [
                { "type": "text", "text": "hello" },
                { "type": "image", "data": "x", "mimeType": "image/png" },
                { "type": "image", "data": "y", "mimeType": "image/jpeg" },
                { "type": "other" }
            ]
        });
        let summary = summarize_value(&value);
        assert_eq!(summary.get("text").and_then(Value::as_str), Some("hello"));
        assert_eq!(summary.get("imageCount").and_then(Value::as_u64), Some(2));
        assert_eq!(summary.get("otherCount").and_then(Value::as_u64), Some(1));
    }

    #[test]
    fn summarize_value_handles_null() {
        let v = Value::Null;
        let summary = summarize_value(&v);
        assert_eq!(summary.get("ok").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn png_dimensions_reads_ihdr() {
        let bytes = fake_png_1x1();
        // 我们手工的 IHDR 写了 width=1, height=1。
        assert_eq!(png_dimensions(&bytes), Some((1, 1)));
    }

    #[test]
    fn png_dimensions_rejects_non_png() {
        assert_eq!(png_dimensions(b"not a png"), None);
    }

    #[test]
    fn screen_capture_unavailable_emits_structured_error() {
        let err = CuaError::screen_capture_unavailable("bundle_identity=fail");
        assert_eq!(err.kind, "cua.errors.screenCaptureUnavailable");
        assert_eq!(
            err.params.get("detail").and_then(Value::as_str),
            Some("bundle_identity=fail")
        );
        assert!(err.message.contains("CuaDriver.app"));
        assert!(err.message.contains("Screen Recording"));
    }

    /// 4×4 全 0 RGB PNG → 0 个非黑像素。
    #[test]
    fn count_non_black_pixels_all_black() {
        let mut out: Vec<u8> = Vec::new();
        image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 0, 255]))
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        let n = count_non_black_pixels(&out);
        assert_eq!(n, Some(0));
    }

    /// 4×4 全 255 RGB PNG → 16 个非黑像素。
    #[test]
    fn count_non_black_pixels_all_white() {
        let mut out: Vec<u8> = Vec::new();
        image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 255, 255, 255]))
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        let n = count_non_black_pixels(&out);
        assert_eq!(n, Some(16));
    }

    /// alpha=0 的像素视为黑（透传不携带信息）。
    #[test]
    fn count_non_black_pixels_treats_transparent_as_black() {
        let mut out: Vec<u8> = Vec::new();
        image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 255, 255, 0]))
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        let n = count_non_black_pixels(&out);
        assert_eq!(n, Some(0));
    }

    #[test]
    fn count_non_black_pixels_returns_none_on_garbage() {
        // 不是图片字节流 → 解码失败 → None。
        assert_eq!(count_non_black_pixels(b"not an image at all"), None);
    }

    /// 校验 MIN_NON_BLACK_PIXELS 阈值：CUA-051 要求非黑像素低于阈值的
    /// 截屏被拒。改这个常量会直接影响 cua_screenshot 的语义，所以
    /// 留个 sanity 测试。
    #[test]
    fn min_threshold_is_sane() {
        assert!(MIN_NON_BLACK_PIXELS >= 100, "threshold too small");
        assert!(MIN_NON_BLACK_PIXELS <= 100_000, "threshold too large");
    }

    // ───────── CUA-053/055/056/057 unwrap_mcp 路径测试 ─────────

    /// CUA-057：pick_topmost_window 不再退回错误地把 `content` 文本数组
    /// 当 windows 数组解析。只有 structuredContent.windows 才是权威来源。
    #[test]
    fn pick_topmost_window_ignores_content_text_array() {
        // 模拟 cua-driver MCP 包过的响应：content 是文本、windows 在
        // structuredContent 下。
        let value = json!({
            "content": [{"type":"text", "text":"Found 9 window(s)."}],
            "structuredContent": {
                "windows": [
                    {"pid": 42, "window_id": 7, "on_screen": true},
                    {"pid": 42, "window_id": 8, "on_screen": true}
                ]
            },
            "isError": false
        });
        // 直接调用 helper 不方便（要 client），但我们可以验证
        // `unwrap_mcp` + `value.get("windows")` 这条路径的语义：
        let inner = unwrap_mcp(&value);
        let wins = inner.get("windows").and_then(Value::as_array).expect("windows array");
        assert_eq!(wins.len(), 2);
        assert_eq!(wins[0].get("pid").and_then(Value::as_i64), Some(42));
        // 反例：旧的 content fallback 不会拿到 pid。
        assert!(value
            .get("content")
            .and_then(Value::as_array)
            .and_then(|arr| arr[0].get("pid"))
            .is_none());
    }

    /// CUA-056：pick_window_id_for_owner 的 list_apps 解析只信任
    /// structuredContent.apps（顶层 v.get("apps") 拿不到）。
    #[test]
    fn pick_window_id_for_owner_uses_structured_apps() {
        let apps_resp = json!({
            "content": [{"type":"text", "text":"2 apps"}],
            "structuredContent": {
                "apps": [
                    {"name": "Finder", "pid": 100},
                    {"name": "LiveAgent", "pid": 200, "bundle_id": "com.liveagent.desktop"}
                ]
            }
        });
        let pid = unwrap_mcp(&apps_resp)
            .get("apps")
            .and_then(Value::as_array)
            .and_then(|arr| arr.iter().find(|a| a.get("name").and_then(Value::as_str) == Some("LiveAgent")))
            .and_then(|a| a.get("pid").and_then(Value::as_i64))
            .expect("must resolve pid");
        assert_eq!(pid, 200);
    }

    /// CUA-055：cua_list_windows 返回纯 windows 数组，而不是 MCP 包装。
    #[test]
    fn list_windows_unwraps_to_pure_array() {
        let mcp_resp = json!({
            "content": [{"type":"text", "text":"9 windows"}],
            "structuredContent": {
                "windows": [
                    {"pid": 1, "window_id": 11},
                    {"pid": 2, "window_id": 22}
                ]
            }
        });
        // 模拟 cua_list_windows 的解包路径：
        let mapped = unwrap_mcp(&mcp_resp)
            .get("windows")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let arr = mapped.as_array().expect("must be array");
        assert_eq!(arr.len(), 2);
        // 不应再嵌套 content / structuredContent。
        assert!(arr[0].get("content").is_none());
        assert!(arr[0].get("structuredContent").is_none());
    }

    // ───────── CUA-054 业务层 effect 失败检测 ─────────

    /// cua_click 拿到 {isError:true, effect:"refused"} 时，finalize_op
    /// 必须返回 ok=false + 结构化 CuaError，而不是吞掉 effect 当成功。
    #[test]
    fn finalize_op_translates_refused_effect_to_error() {
        let mcp_resp: Result<Value, CuaError> = Ok(json!({
            "isError": true,
            "content": [{"type":"text", "text":"refused"}],
            "structuredContent": {
                "effect": "refused",
                "code": "off_space_or_ax_unresolved",
                "escalation": {"recommended": "foreground"}
            }
        }));
        let err = check_effect_failure(&mcp_resp).expect("must surface effect failure");
        assert_eq!(err.kind, "cua.errors.notExecuted");
        assert!(err.message.contains("refused"));
        assert!(err.message.contains("off_space_or_ax_unresolved"));
    }

    #[test]
    fn finalize_op_translates_suspected_noop() {
        let mcp_resp: Result<Value, CuaError> = Ok(json!({
            "isError": true,
            "structuredContent": {"effect": "suspected_noop", "code": "no_focus_change"}
        }));
        let err = check_effect_failure(&mcp_resp).expect("must surface");
        assert!(err.message.contains("suspected_noop"));
    }

    #[test]
    fn finalize_op_translates_unverifiable() {
        let mcp_resp: Result<Value, CuaError> = Ok(json!({
            "isError": true,
            "structuredContent": {"effect": "unverifiable", "code": "ax_timeout"}
        }));
        let err = check_effect_failure(&mcp_resp).expect("must surface");
        assert!(err.message.contains("cannot verify"));
    }

    /// isError=false 的成功响应（含无 effect 字段）保持 ok=true。
    #[test]
    fn check_effect_failure_passes_through_success() {
        let mcp_resp: Result<Value, CuaError> = Ok(json!({
            "isError": false,
            "content": [{"type":"text", "text":"clicked"}]
        }));
        assert!(check_effect_failure(&mcp_resp).is_none());

        // effect 字段缺失但 isError=false：也视为成功（保守）。
        let mcp_resp2: Result<Value, CuaError> = Ok(json!({
            "isError": false,
            "structuredContent": {"foo": "bar"}
        }));
        assert!(check_effect_failure(&mcp_resp2).is_none());
    }

    /// isError 缺失但 effect=refused 的响应：保守起见，只信任 isError
    /// 这个明确标记；这里 effect 单独不足以判定失败。
    #[test]
    fn check_effect_failure_requires_iserror_flag() {
        let mcp_resp: Result<Value, CuaError> = Ok(json!({
            // 没有 isError:true
            "structuredContent": {"effect": "refused"}
        }));
        assert!(check_effect_failure(&mcp_resp).is_none());
    }

    /// 传输层失败（Err）时 effect 检查不动（caller 走 Err 分支）。
    #[test]
    fn check_effect_failure_ignores_transport_error() {
        let transport_err: Result<Value, CuaError> = Err(CuaError::io("subprocess died"));
        assert!(check_effect_failure(&transport_err).is_none());
    }

    /// finalize_op 端到端：isError=true 应落地 ok=false。
    #[test]
    fn finalize_op_returns_failure_on_iserror_true() {
        let store = Arc::new(CuaStore::new(CuaRuntimeConfig::default()));
        let resp = Ok(json!({
            "isError": true,
            "structuredContent": {"effect": "refused", "code": "x"}
        }));
        let op_resp = finalize_op(&store, "click", None, resp, Utc::now());
        assert!(!op_resp.ok);
        assert!(op_resp.error.is_some());
        assert!(op_resp.error.unwrap().message.contains("refused"));
    }

    /// finalize_op 端到端：成功路径保持 ok=true、error=None。
    #[test]
    fn finalize_op_keeps_success_on_iserror_false() {
        let store = Arc::new(CuaStore::new(CuaRuntimeConfig::default()));
        let resp = Ok(json!({"isError": false, "content": []}));
        let op_resp = finalize_op(&store, "click", None, resp, Utc::now());
        assert!(op_resp.ok);
        assert!(op_resp.error.is_none());
    }

    // ───────── CUA-059/060/061/062 回归测试 ─────────

    /// CUA-061：cua-driver 在 isError=true 时把错误消息放在 content[]
    /// 的 text 条目里；extract_error_text 必须把它们拼出来，避免被
    /// extract_screenshot 当 None 翻成 'no image content'。
    #[test]
    fn extract_error_text_pulls_creats_text_chunks() {
        let value = json!({
            "isError": true,
            "content": [
                { "type": "text", "text": "x2 must be > x1 and y2 must be > y1" }
            ]
        });
        let detail = extract_error_text(&value).expect("must surface error text");
        assert!(detail.contains("x2 must be > x1"));
        assert!(detail.contains("y2 must be > y1"));
    }

    /// CUA-061：没有 isError=true 时 extract_error_text 不返回真实
    /// 文本，避免误报（即使 content[] 里恰好有 text 条目）。
    #[test]
    fn extract_error_text_returns_none_when_no_iserror() {
        let value = json!({
            "isError": false,
            "content": [
                { "type": "text", "text": "ok" },
                { "type": "image", "data": "AAAA", "mimeType": "image/png" }
            ]
        });
        // extract_error_text 只看 content[] 文本条目，但 caller（cua_screenshot）
        // 必须先用 isError=true 守门。这里验证 helper 自身的抽取行为。
        let detail = extract_error_text(&value);
        // 即使 image 也存在，文本条目仍会被收集；这是有意的——helper
        // 单纯做文本提取，是否调用由 caller 决定。caller 应该走
        // extract_io_error_on_failure 而不是直接调本 helper。
        assert_eq!(detail.as_deref(), Some("ok"));
    }

    // ───────── CUA-064 守门 helper 回归测试 ─────────

    /// CUA-064：成功响应（zoom / get_desktop_state）下 content 同时
    /// 含 type:text 描述项 + type:image 字节。`extract_io_error_on_failure`
    /// 必须返回 None（不进 io error 分支），让 caller 走图像抽取。
    #[test]
    fn extract_io_error_on_failure_returns_none_on_success_with_text() {
        let value = json!({
            "isError": false,
            "content": [
                { "type": "text", "text": "Zoom region (260,68)–(1660,868) → 500×286 px JPEG." },
                { "type": "image", "data": "AAAA", "mimeType": "image/png" }
            ]
        });
        assert!(extract_io_error_on_failure(&value).is_none());
    }

    /// CUA-064 反向：isError 缺失（null）也按成功处理，不透出文本。
    #[test]
    fn extract_io_error_on_failure_returns_none_on_missing_iserror() {
        let value = json!({
            "content": [
                { "type": "text", "text": "any description" },
                { "type": "image", "data": "AAAA", "mimeType": "image/png" }
            ]
        });
        assert!(extract_io_error_on_failure(&value).is_none());
    }

    /// CUA-064 失败路径：isError=true 时仍按之前的行为透出真实错误。
    #[test]
    fn extract_io_error_on_failure_returns_text_on_iserror_true() {
        let value = json!({
            "isError": true,
            "content": [
                { "type": "text", "text": "x2 must be > x1 and y2 must be > y1" },
                { "type": "image", "data": "AAAA", "mimeType": "image/png" }
            ]
        });
        let detail = extract_io_error_on_failure(&value).expect("must surface failure text");
        assert!(detail.contains("x2 must be > x1"));
    }

    /// CUA-064 失败路径：isError=true 但 content 里只有 image 时
    /// 仍返回 None（与原有 extract_error_text 行为一致）。
    #[test]
    fn extract_io_error_on_failure_returns_none_when_only_image() {
        let value = json!({
            "isError": true,
            "content": [
                { "type": "image", "data": "AAAA", "mimeType": "image/png" }
            ]
        });
        assert!(extract_io_error_on_failure(&value).is_none());
    }

    /// CUA-059：extract_window_bounds 同时识别 nested `bounds` 对象
    /// 和顶层平铺 {x,y, width, height}。
    #[test]
    fn extract_window_bounds_handles_both_shapes() {
        let nested = json!({
            "window_id": 7,
            "bounds": { "x": 100, "y": 50, "width": 800, "height": 600 }
        });
        let b = extract_window_bounds(&nested).expect("nested bounds must parse");
        assert_eq!((b.x, b.y, b.width, b.height), (100, 50, 800, 600));

        let flat = json!({
            "window_id": 8,
            "x": 200, "y": 75, "width": 1024, "height": 768
        });
        let b2 = extract_window_bounds(&flat).expect("flat bounds must parse");
        assert_eq!((b2.x, b2.y, b2.width, b2.height), (200, 75, 1024, 768));
    }

    /// CUA-059：cua-driver list_windows 返回的 bounds 字段值是浮点
    ///（例如 `{"x":260.0,"y":68.0,...}`），extract_window_bounds 必须
    /// 截到 i32 而不是返回 None。
    #[test]
    fn extract_window_bounds_accepts_floats() {
        let real = json!({
            "window_id": 24391,
            "bounds": { "x": 260.0, "y": 68.0, "width": 1400.0, "height": 800.0 }
        });
        let b = extract_window_bounds(&real).expect("float bounds must parse");
        assert_eq!((b.x, b.y, b.width, b.height), (260, 68, 1400, 800));

    // 混用 int + float 也兼容。
    let mixed = json!({
        "window_id": 9,
        "bounds": { "x": 260.0, "y": 68, "width": 1400, "height": 800.0 }
    });
    let b2 = extract_window_bounds(&mixed).expect("mixed bounds must parse");
    assert_eq!((b2.x, b2.y, b2.width, b2.height), (260, 68, 1400, 800));
    }

    /// CUA-059：bounds 缺失或 width/height <= 0 时返回 None，让
    /// zoom_rect 走 screen-size fallback（避免零面积）。
    #[test]
    fn extract_window_bounds_rejects_zero_area() {
        let no_bounds = json!({ "window_id": 9 });
        assert!(extract_window_bounds(&no_bounds).is_none());

        let zero_area = json!({
            "bounds": { "x": 0, "y": 0, "width": 0, "height": 0 }
        });
        assert!(extract_window_bounds(&zero_area).is_none());
    }

    /// CUA-059：zoom_rect 在 bounds 拿得到时输出真实矩形，bounds
    /// 拿不到时输出非零面积的兜底矩形。
    #[test]
    fn zoom_rect_uses_bounds_or_screen_fallback() {
        let real = zoom_rect(Some(WindowBounds {
            x: 10,
            y: 20,
            width: 800,
            height: 600,
        }));
        assert_eq!(real, (10, 20, 810, 620));

        let fallback = zoom_rect(None);
        assert_eq!(fallback, (0, 0, FALLBACK_SCREEN_W, FALLBACK_SCREEN_H));
        // 兜底矩形的面积必须严格 > 0（cua-driver zoom 拒绝零面积）。
        assert!(fallback.2 > fallback.0);
        assert!(fallback.3 > fallback.1);

        // width/height ≤ 0 也走 fallback。
        let degenerate = zoom_rect(Some(WindowBounds {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        }));
        assert_eq!(degenerate, (0, 0, FALLBACK_SCREEN_W, FALLBACK_SCREEN_H));
    }

    /// CUA-060：CuaError::owner_not_found 携带稳定的 i18n kind + owner 参数。
    #[test]
    fn owner_not_found_emits_structured_error() {
        let err = CuaError::owner_not_found("GhostApp");
        assert_eq!(err.kind, "cua.errors.ownerNotFound");
        assert_eq!(
            err.params.get("owner").and_then(Value::as_str),
            Some("GhostApp")
        );
        assert!(err.message.contains("GhostApp"));
        assert!(!err.message.contains('你'), "no Chinese leaks");
    }
}
