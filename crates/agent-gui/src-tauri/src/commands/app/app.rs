use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::runtime::terminal::TerminalSessionRegistry;

#[allow(dead_code)]
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacOsTrafficLightMetrics {
    pub top: f64,
    pub left: f64,
    pub width: f64,
    pub height: f64,
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
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};

    let ns_window_ptr = window
        .ns_window()
        .map_err(|error| format!("failed to get native macOS window: {error}"))?;
    if ns_window_ptr.is_null() {
        return Ok(None);
    }

    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast::<NSWindow>() };
    let Some(close_button) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
        return Ok(None);
    };

    let close_frame = NSView::frame(&close_button);
    let close_screen_frame = ns_window.convertRectToScreen(close_frame);
    let window_frame = ns_window.frame();
    let top_from_top_edge = close_screen_frame.origin.y - window_frame.origin.y;
    let top_from_bottom_edge = window_frame.origin.y + window_frame.size.height
        - (close_screen_frame.origin.y + close_screen_frame.size.height);
    let top = [top_from_top_edge, top_from_bottom_edge]
        .into_iter()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .min_by(|left, right| left.partial_cmp(right).unwrap())
        .unwrap_or(top_from_bottom_edge);
    let left = close_screen_frame.origin.x - window_frame.origin.x;
    let width = close_screen_frame.size.width;
    let height = close_screen_frame.size.height;

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
