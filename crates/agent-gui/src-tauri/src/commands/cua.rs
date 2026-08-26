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
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::AppHandle;
use tauri::State;

use crate::services::cua::cua_client::CuaClient;
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

fn run_op<F>(
    store: &Arc<CuaStore>,
    op: &str,
    detail: Option<Value>,
    f: F,
) -> Result<(), CuaError>
where
    F: FnOnce() -> Result<Value, CuaError>,
{
    let started = Utc::now();
    let result = f();
    record_op_audit(store, op, detail, &result, started);
    result.map(|_| ())
}

// ───────── Commands ─────────

/// 平台标签 + 是否可用 + 当前配置 + 最近操作。前端挂载时调用一次。
///
/// 每次取快照都从持久化 system settings 重读 `sandbox_offline`——避免
/// 命令安全模式被外部切到 sandboxOffline 后 CUA UI 仍按旧值渲染。
#[tauri::command(rename_all = "snake_case")]
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
#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
pub fn cua_clear_audit(store: State<'_, Arc<CuaStore>>) -> CuaStoreSnapshot {
    store.clear_audit();
    store.snapshot()
}

#[tauri::command(rename_all = "snake_case")]
pub fn cua_list_windows(
    store: State<'_, Arc<CuaStore>>,
    client: State<'_, CuaClient>,
) -> Result<Value, CuaError> {
    let op = "list_windows";
    store.enforce(op, None)?;
    // on_screen_only=true 过滤掉离屏窗口，避免给 Agent 噪音。
    let started = Utc::now();
    let result = client.call_tool("list_windows", json!({ "on_screen_only": true }));
    record_op_audit(store.inner(), op, None, &result, started);
    result
}

#[tauri::command(rename_all = "snake_case")]
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
        Ok(v) => v
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
            }),
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

#[tauri::command(rename_all = "snake_case")]
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
    let result = if let Some(owner) = window_owner.as_deref().filter(|s| !s.is_empty()) {
        // 走 list_apps → pid+window_id → zoom 路径，给一个 5s 缓存避免
        // 每次截屏都 list_apps。这里偷懒：直接传 owner 字符串到
        // get_desktop_state（不支持）；退化：list_apps 后取第一个匹配
        // owner 的 window_state，再 zoom 整窗口。
        match pick_window_id_for_owner(&client, owner) {
            Ok(Some((pid, window_id))) => client.call_tool(
                "zoom",
                json!({
                    "pid": pid,
                    "window_id": window_id,
                    "x1": 0, "y1": 0, "x2": 0, "y2": 0,
                }),
            ),
            Ok(None) => client.call_tool(
                "get_desktop_state",
                json!({}),
            ),
            Err(e) => Err(e),
        }
    } else {
        client.call_tool("get_desktop_state", json!({}))
    };
    match result {
        Ok(value) => {
            let (bytes, width, height) = extract_screenshot(&value)
                .ok_or_else(|| CuaError::io("cua-driver screenshot: no image content"))?;
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

#[tauri::command(rename_all = "snake_case")]
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
    match &result {
        Ok(v) => record_op_audit(store.inner(), op, detail, &Ok(v.clone()), started),
        Err(e) => record_op_audit(store.inner(), op, detail, &Err(e.clone()), started),
    }
    Ok(CuaOpResponse {
        ok: result.is_ok(),
        error: result.err(),
    })
}

#[tauri::command(rename_all = "snake_case")]
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
    match &result {
        Ok(v) => record_op_audit(store.inner(), op, detail, &Ok(v.clone()), started),
        Err(e) => record_op_audit(store.inner(), op, detail, &Err(e.clone()), started),
    }
    Ok(CuaOpResponse {
        ok: result.is_ok(),
        error: result.err(),
    })
}

#[tauri::command(rename_all = "snake_case")]
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
    let mut args = json!({ "text": text });
    if let Some(owner) = owner_ref {
        if let Ok(Some((pid, window_id))) = pick_window_id_for_owner(&client, owner) {
            args["pid"] = json!(pid);
            args["window_id"] = json!(window_id);
        }
    }
    run_op(store.inner(), op, detail, || {
        client.call_tool("type_text", args.clone())
    })?;
    Ok(CuaOpResponse {
        ok: true,
        error: None,
    })
}

#[tauri::command(rename_all = "snake_case")]
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
    if let Some(owner) = owner_ref {
        if let Ok(Some((pid, window_id))) = pick_window_id_for_owner(&client, owner) {
            args["pid"] = json!(pid);
            args["window_id"] = json!(window_id);
        }
    }
    run_op(store.inner(), op, detail, || {
        client.call_tool(tool, args.clone())
    })?;
    Ok(CuaOpResponse {
        ok: true,
        error: None,
    })
}

#[tauri::command(rename_all = "snake_case")]
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
    run_op(store.inner(), op, detail, || {
        client.call_tool("scroll", args.clone())
    })?;
    Ok(CuaOpResponse {
        ok: true,
        error: None,
    })
}

#[tauri::command(rename_all = "snake_case")]
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
    run_op(store.inner(), op, detail, || {
        client.call_tool("drag", args.clone())
    })?;
    Ok(CuaOpResponse {
        ok: true,
        error: None,
    })
}

// ───────── Helpers ─────────

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
fn pick_topmost_window(client: &CuaClient) -> Result<Option<(i64, i64)>, CuaError> {
    let value = client.call_tool("list_windows", json!({ "on_screen_only": true }))?;
    let wins = value
        .get("windows")
        .and_then(Value::as_array)
        .or_else(|| value.get("content").and_then(Value::as_array));
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
fn pick_window_id_for_owner(
    client: &CuaClient,
    owner: &str,
) -> Result<Option<(i64, i64)>, CuaError> {
    let apps = client.call_tool("list_apps", json!({}))?;
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
    let wid = windows
        .get("windows")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter().find_map(|w| {
                w.get("window_id")
                    .or_else(|| w.get("windowId"))
                    .or_else(|| w.get("id"))
                    .and_then(Value::as_i64)
            })
        });
    Ok(wid.map(|w| (pid, w)))
}

/// cua-driver 入口命令：把主窗口重新推到最前并等待 `is_focused()` 落
/// 住。命令不依赖 CUA enable 开关——它的目的正是让 enable=true 之
/// 后的 click / AX 路径能找到 WebView。
#[tauri::command(rename_all = "snake_case")]
pub async fn cua_window_ready(
    window: tauri::WebviewWindow,
) -> Result<crate::CuaWindowReadyResponse, String> {
    Ok(crate::cua_window_ready(window).await)
}

/// CUA-020/021/022: 在路由切换、overlay 打开/关闭、cua-driver 主动唤
/// 起等场景重新触发 NSWindow/WKWebView 的 AX 注解 + 一回弹广播
/// UIElementCreatedNotification。
#[tauri::command(rename_all = "snake_case")]
pub fn cua_refresh_a11y(window: tauri::WebviewWindow) -> crate::CuaRefreshA11yResponse {
    crate::cua_refresh_a11y(&window)
}

// ───────── CUA Driver 安装器（CUA-100） ─────────
//
// installer.rs 检测 cua-driver 二进制；这里只暴露命令桥。
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
#[tauri::command(rename_all = "snake_case")]
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
#[tauri::command(rename_all = "snake_case")]
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
#[tauri::command(rename_all = "snake_case")]
pub fn cua_driver_install_preview() -> Result<InstallPreview, CuaError> {
    crate::services::cua::build_install_preview().map_err(|detail| match std::env::consts::OS {
        "macos" | "linux" | "windows" => CuaError::not_executed(&detail),
        other => CuaError::installer_unsupported_platform(other),
    })
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
        let mut bytes = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
            0x00, 0x00, 0x00, 0x0D, // IHDR length = 13
            b'I', b'H', b'D', b'R',
            0x00, 0x00, 0x00, 0x01, // width = 1
            0x00, 0x00, 0x00, 0x01, // height = 1
            0x08, 0x02, 0x00, 0x00, 0x00, // bit depth, color type, etc.
        ];
        bytes
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
}
