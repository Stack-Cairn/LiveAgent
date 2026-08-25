use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, State};
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
    ready_state.0.store(true, Ordering::SeqCst);
    if window.is_visible().unwrap_or(false) {
        crate::force_activate_main_window(&window);
        return Ok(());
    }
    window
        .show()
        .map_err(|error| format!("failed to show frontend-ready window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("failed to focus frontend-ready window: {error}"))?;
    // CUA-007: macOS-only NSApp.activate + makeKeyAndOrderFront ensures the
    // window reaches the frontmost-ordinary window state so cua-driver's
    // `bring_to_front` and foreground delivery actually land on the
    // WebView. `set_focus` alone can leave the window below the
    // loginwindow or another system surface in a dev sandbox.
    crate::force_activate_main_window(&window);
    Ok(())
}

/// 前端主动切换置顶（置顶指示器点击取消）；状态变更仍经
/// `global-shortcut:pin-changed` 事件广播回前端。
#[tauri::command]
pub fn app_toggle_window_pin(app: AppHandle) {
    crate::toggle_main_window_pin(&app);
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
}
