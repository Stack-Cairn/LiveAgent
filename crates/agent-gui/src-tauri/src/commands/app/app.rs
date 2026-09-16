use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::runtime::terminal::TerminalSessionRegistry;

pub type CloseWindowBehaviorState = AtomicU8;

pub const CLOSE_WINDOW_BEHAVIOR_MINIMIZE: u8 = 0;
pub const CLOSE_WINDOW_BEHAVIOR_EXIT: u8 = 1;

/// 已注册全局快捷键 -> 动作 的映射，供插件回调反查动作。
#[derive(Default)]
pub struct GlobalShortcutRegistry {
    entries: Mutex<Vec<(Shortcut, String)>>,
}

/// 主窗口置顶状态（快捷键切换用；独立 newtype 避免与其他 AtomicBool 状态类型冲突）。
#[derive(Default)]
pub struct WindowPinState(pub AtomicBool);

#[derive(Default)]
pub struct FrontendReadyState(pub AtomicBool);

/// 前端查询当前置顶状态（webview 重载后恢复置顶指示器）。
#[tauri::command]
pub fn app_window_pinned(pin_state: State<'_, Arc<WindowPinState>>) -> bool {
    pin_state.0.load(Ordering::SeqCst)
}

/// HTML 的静态启动骨架完成同步布局后再显示原生窗口，避免 WebView
/// 导航到首个可绘制帧之间暴露系统默认白色背景。
#[tauri::command]
pub fn app_frontend_ready(
    window: tauri::WebviewWindow,
    ready_state: State<'_, Arc<FrontendReadyState>>,
) -> Result<(), String> {
    if window.label() == crate::MAIN_WINDOW_LABEL {
        ready_state.0.store(true, Ordering::SeqCst);
    }
    if window.is_visible().unwrap_or(false) {
        return Ok(());
    }
    window
        .show()
        .map_err(|error| format!("failed to show frontend-ready window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("failed to focus frontend-ready window: {error}"))
}

const CONVERSATION_WINDOW_LABEL_PREFIX: &str = "conversation-";
const MAX_CONVERSATION_ID_LENGTH: usize = 256;
const MAX_CONVERSATION_WINDOW_TITLE_LENGTH: usize = 96;

fn normalize_conversation_window_id(conversation_id: &str) -> Result<&str, String> {
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return Err("conversation_id is required".to_string());
    }
    if conversation_id.chars().count() > MAX_CONVERSATION_ID_LENGTH {
        return Err("conversation_id is too long".to_string());
    }
    Ok(conversation_id)
}

fn conversation_window_label(conversation_id: &str) -> String {
    let digest = Sha256::digest(conversation_id.as_bytes());
    let suffix = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{CONVERSATION_WINDOW_LABEL_PREFIX}{suffix}")
}

fn normalize_conversation_window_title(title: Option<&str>) -> String {
    let title = title
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut chars = title.chars();
    let shortened = chars
        .by_ref()
        .take(MAX_CONVERSATION_WINDOW_TITLE_LENGTH)
        .collect::<String>();
    let suffix = if chars.next().is_some() { "…" } else { "" };
    if shortened.is_empty() {
        "LiveAgent".to_string()
    } else {
        format!("{shortened}{suffix} — LiveAgent")
    }
}

fn focus_conversation_window(app: &AppHandle, conversation_id: &str) -> Result<bool, String> {
    let conversation_id = normalize_conversation_window_id(conversation_id)?;
    let label = conversation_window_label(conversation_id);
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(false);
    };

    window
        .show()
        .map_err(|error| format!("failed to show conversation window: {error}"))?;
    window
        .unminimize()
        .map_err(|error| format!("failed to restore conversation window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("failed to focus conversation window: {error}"))?;
    Ok(true)
}

/// Focuses the independent window that owns this conversation, if one exists.
/// The main window calls this before opening history so one conversation never
/// has two simultaneously editable desktop views.
#[tauri::command]
pub fn app_focus_conversation_window(
    app: AppHandle,
    conversation_id: String,
) -> Result<bool, String> {
    focus_conversation_window(&app, &conversation_id)
}

/// Opens an idle conversation in its own native window. Labels are derived
/// from the complete conversation id, so repeated requests reuse and focus the
/// same window without exposing user-controlled ids as Tauri labels.
#[tauri::command]
pub async fn app_open_conversation_window(
    app: AppHandle,
    conversation_id: String,
    title: Option<String>,
) -> Result<String, String> {
    let conversation_id = normalize_conversation_window_id(&conversation_id)?.to_string();
    let label = conversation_window_label(&conversation_id);
    let window_title = normalize_conversation_window_title(title.as_deref());

    if let Some(window) = app.get_webview_window(&label) {
        window
            .set_title(&window_title)
            .map_err(|error| format!("failed to update conversation window title: {error}"))?;
        focus_conversation_window(&app, &conversation_id)?;
        return Ok(label);
    }

    let route = format!(
        "index.html?appWindow=conversation&conversationId={}&conversationTitle={}",
        urlencoding::encode(&conversation_id),
        urlencoding::encode(title.as_deref().unwrap_or_default().trim()),
    );
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(route.into()))
        .title(window_title)
        .inner_size(1100.0, 760.0)
        .min_inner_size(760.0, 560.0)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .visible(false);
    #[cfg(target_os = "windows")]
    {
        builder = builder.decorations(false);
    }
    builder
        .build()
        .map_err(|error| format!("failed to create conversation window: {error}"))?;

    Ok(label)
}

/// 前端主动切换置顶（置顶指示器点击取消）；状态变更仍经
/// `global-shortcut:pin-changed` 事件广播回前端。
#[tauri::command]
pub fn app_toggle_window_pin(app: AppHandle) {
    crate::toggle_main_window_pin(&app);
}

/// 软件内快捷键复用全局快捷键的动作总线，且要求调用窗口当前有焦点。
#[tauri::command]
pub fn app_run_shortcut(app: AppHandle, window: tauri::WebviewWindow, action: String) {
    if window.is_focused().unwrap_or(false) {
        crate::run_shortcut_action(&app, &action);
    }
}

impl GlobalShortcutRegistry {
    pub fn lookup_action(&self, shortcut: &Shortcut) -> Option<String> {
        let entries = self.entries.lock().ok()?;
        entries
            .iter()
            .find(|(registered, _)| registered == shortcut)
            .map(|(_, action)| action.clone())
    }

    fn replace(&self, next: Vec<(Shortcut, String)>) {
        if let Ok(mut entries) = self.entries.lock() {
            *entries = next;
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutBinding {
    pub action: String,
    pub accelerator: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutFailure {
    pub action: String,
    pub accelerator: String,
    pub error: String,
}

/// 全量替换式注册：本命令是插件注册的唯一入口，`unregister_all` 会清掉
/// 插件上的所有快捷键。日后若有其他模块要注册全局快捷键，必须并入本命令
/// 的 bindings 走同一条替换路径，不能自行调用插件 register。
#[tauri::command]
pub fn app_set_global_shortcuts(
    app: AppHandle,
    bindings: Vec<GlobalShortcutBinding>,
    registry: State<'_, Arc<GlobalShortcutRegistry>>,
) -> Result<Vec<GlobalShortcutFailure>, String> {
    let manager = app.global_shortcut();
    manager
        .unregister_all()
        .map_err(|error| format!("failed to unregister global shortcuts: {error}"))?;

    let mut entries: Vec<(Shortcut, String)> = Vec::new();
    let mut failures: Vec<GlobalShortcutFailure> = Vec::new();
    for binding in bindings {
        let action = binding.action.trim().to_string();
        let accelerator = binding.accelerator.trim().to_string();
        if action.is_empty() || accelerator.is_empty() {
            continue;
        }
        match accelerator.parse::<Shortcut>() {
            Ok(shortcut) => match manager.register(shortcut) {
                Ok(()) => entries.push((shortcut, action)),
                Err(error) => failures.push(GlobalShortcutFailure {
                    action,
                    accelerator,
                    error: error.to_string(),
                }),
            },
            Err(error) => failures.push(GlobalShortcutFailure {
                action,
                accelerator,
                error: error.to_string(),
            }),
        }
    }
    registry.replace(entries);
    Ok(failures)
}

pub fn parse_close_window_behavior(value: &str) -> u8 {
    if value.trim().eq_ignore_ascii_case("exit") {
        CLOSE_WINDOW_BEHAVIOR_EXIT
    } else {
        CLOSE_WINDOW_BEHAVIOR_MINIMIZE
    }
}

pub fn is_close_window_exit(state: &CloseWindowBehaviorState) -> bool {
    state.load(Ordering::SeqCst) == CLOSE_WINDOW_BEHAVIOR_EXIT
}

#[allow(dead_code)]
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacOsTrafficLightMetrics {
    pub top: f64,
    pub left: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePlatformResponse {
    pub platform: &'static str,
}

#[tauri::command]
pub fn app_runtime_platform() -> RuntimePlatformResponse {
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    RuntimePlatformResponse { platform }
}

#[tauri::command]
pub fn app_set_close_window_behavior(
    behavior: String,
    close_window_behavior: State<'_, Arc<CloseWindowBehaviorState>>,
) -> Result<(), String> {
    close_window_behavior.store(parse_close_window_behavior(&behavior), Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn app_confirmed_exit(
    app: AppHandle,
    allow_exit: State<'_, Arc<AtomicBool>>,
    terminal_registry: State<'_, Arc<TerminalSessionRegistry>>,
) -> Result<(), String> {
    terminal_registry.close_all()?;
    allow_exit.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

#[allow(dead_code)]
#[tauri::command]
pub async fn app_macos_traffic_light_metrics(
    window: tauri::Window,
) -> Result<Option<MacOsTrafficLightMetrics>, String> {
    read_macos_traffic_light_metrics(window).await
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
async fn read_macos_traffic_light_metrics(
    _window: tauri::Window,
) -> Result<Option<MacOsTrafficLightMetrics>, String> {
    Ok(None)
}

#[cfg(target_os = "macos")]
#[allow(dead_code)]
async fn read_macos_traffic_light_metrics(
    window: tauri::Window,
) -> Result<Option<MacOsTrafficLightMetrics>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let window_for_task = window.clone();
    window
        .run_on_main_thread(move || {
            let result = read_macos_traffic_light_metrics_on_main_thread(&window_for_task);
            let _ = tx.send(result);
        })
        .map_err(|error| format!("failed to read macOS traffic light metrics: {error}"))?;

    rx.await
        .map_err(|_| "failed to receive macOS traffic light metrics".to_string())?
}

#[cfg(target_os = "macos")]
#[allow(dead_code)]
fn read_macos_traffic_light_metrics_on_main_thread(
    window: &tauri::Window,
) -> Result<Option<MacOsTrafficLightMetrics>, String> {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    let ns_window_ptr = window
        .ns_window()
        .map_err(|error| format!("failed to get native macOS window: {error}"))?;
    if ns_window_ptr.is_null() {
        return Ok(None);
    }

    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast::<NSWindow>() };
    let window_frame = ns_window.frame();

    let button_frames = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .filter_map(|button| ns_window.standardWindowButton(button))
    .map(|button| macos_window_button_screen_frame(ns_window, &button))
    .collect::<Vec<_>>();

    if button_frames.is_empty() {
        return Ok(None);
    }

    let min_x = button_frames
        .iter()
        .map(|frame| frame.0)
        .fold(f64::INFINITY, f64::min);
    let min_y = button_frames
        .iter()
        .map(|frame| frame.1)
        .fold(f64::INFINITY, f64::min);
    let max_x = button_frames
        .iter()
        .map(|frame| frame.0 + frame.2)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = button_frames
        .iter()
        .map(|frame| frame.1 + frame.3)
        .fold(f64::NEG_INFINITY, f64::max);
    let width = max_x - min_x;
    let height = max_y - min_y;
    let top_from_top_edge = min_y - window_frame.origin.y;
    let top_from_bottom_edge = window_frame.origin.y + window_frame.size.height - max_y;
    let top = [top_from_top_edge, top_from_bottom_edge]
        .into_iter()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .min_by(|left, right| left.partial_cmp(right).unwrap())
        .unwrap_or(top_from_bottom_edge);
    let left = min_x - window_frame.origin.x;

    if [top, left, width, height]
        .iter()
        .any(|value| !value.is_finite())
        || width <= 0.0
        || height <= 0.0
    {
        return Ok(None);
    }

    Ok(Some(MacOsTrafficLightMetrics {
        top,
        left,
        width,
        height,
    }))
}

#[cfg(target_os = "macos")]
#[allow(dead_code)]
fn macos_window_button_screen_frame(
    ns_window: &objc2_app_kit::NSWindow,
    button: &objc2_app_kit::NSButton,
) -> (f64, f64, f64, f64) {
    use objc2_app_kit::NSView;

    let frame = NSView::frame(button);
    let window_frame = unsafe {
        NSView::superview(button)
            .map(|superview| superview.convertRect_toView(frame, None))
            .unwrap_or(frame)
    };
    let screen_frame = ns_window.convertRectToScreen(window_frame);
    (
        screen_frame.origin.x,
        screen_frame.origin.y,
        screen_frame.size.width,
        screen_frame.size.height,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_window_behavior_parser_accepts_exit_and_defaults_to_minimize() {
        assert_eq!(
            parse_close_window_behavior("exit"),
            CLOSE_WINDOW_BEHAVIOR_EXIT
        );
        assert_eq!(
            parse_close_window_behavior(" EXIT "),
            CLOSE_WINDOW_BEHAVIOR_EXIT
        );
        assert_eq!(
            parse_close_window_behavior("tray"),
            CLOSE_WINDOW_BEHAVIOR_MINIMIZE
        );
    }

    #[test]
    fn close_window_exit_reads_shared_state() {
        let state = CloseWindowBehaviorState::new(CLOSE_WINDOW_BEHAVIOR_MINIMIZE);
        assert!(!is_close_window_exit(&state));
        state.store(CLOSE_WINDOW_BEHAVIOR_EXIT, Ordering::SeqCst);
        assert!(is_close_window_exit(&state));
    }

    #[test]
    fn conversation_window_labels_are_stable_and_safe() {
        let first = conversation_window_label("conversation/with spaces");
        assert_eq!(first, conversation_window_label("conversation/with spaces"));
        assert_ne!(first, conversation_window_label("another-conversation"));
        assert!(first.starts_with(CONVERSATION_WINDOW_LABEL_PREFIX));
        assert!(first
            .strip_prefix(CONVERSATION_WINDOW_LABEL_PREFIX)
            .unwrap()
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn conversation_window_title_is_trimmed_and_bounded() {
        assert_eq!(normalize_conversation_window_title(None), "LiveAgent");
        assert_eq!(
            normalize_conversation_window_title(Some("  My   conversation  ")),
            "My conversation — LiveAgent"
        );
        let long_title = "会".repeat(MAX_CONVERSATION_WINDOW_TITLE_LENGTH + 1);
        let normalized = normalize_conversation_window_title(Some(&long_title));
        assert!(normalized.starts_with(&"会".repeat(MAX_CONVERSATION_WINDOW_TITLE_LENGTH)));
        assert!(normalized.ends_with("… — LiveAgent"));
    }
}
