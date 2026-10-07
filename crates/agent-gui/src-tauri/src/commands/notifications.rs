use std::collections::HashMap;
use std::sync::Arc;

use tauri::State;

use crate::services::notifications::{
    self, Notice, NotificationKind, NotificationService, NotifyOutcome, PermissionState,
};

/// Agent `Notify` 两次系统通知的最小间隔：防止循环调用刷屏。
const AGENT_NOTIFY_MIN_INTERVAL_MS: i64 = 30_000;

/// 投递与权限查询会等待系统回调（请求授权时要等用户操作），放到后台线程，不占主线程。
async fn blocking<T: Send + 'static>(
    service: &State<'_, Arc<NotificationService>>,
    task: impl FnOnce(&NotificationService) -> T + Send + 'static,
) -> Result<T, String> {
    let service = Arc::clone(service);
    tauri::async_runtime::spawn_blocking(move || task(&service))
        .await
        .map_err(|error| error.to_string())
}

/// 前端按界面语言推送的通知文案（标题模板等）。
#[tauri::command]
pub fn notifications_set_labels(
    labels: HashMap<String, String>,
    service: State<'_, Arc<NotificationService>>,
) {
    service.set_labels(labels);
}

/// Agent `Notify` 工具。
#[tauri::command]
pub async fn notifications_notify(
    title: String,
    body: Option<String>,
    service: State<'_, Arc<NotificationService>>,
) -> Result<NotifyOutcome, String> {
    blocking(&service, move |service| {
        service.notify(
            Notice::new(
                NotificationKind::AgentMessage,
                title,
                body.unwrap_or_default(),
            )
            .throttled("agent", AGENT_NOTIFY_MIN_INTERVAL_MS),
        )
    })
    .await?
}

/// 系统通知权限（macOS 原生通道可读到真实状态，其余为 `unknown`）。
#[tauri::command]
pub async fn notifications_permission(
    service: State<'_, Arc<NotificationService>>,
) -> Result<PermissionState, String> {
    blocking(&service, |service| service.permission()).await
}

/// 请求系统通知权限（macOS 首次弹出系统授权对话框）。
#[tauri::command]
pub async fn notifications_request_permission(
    service: State<'_, Arc<NotificationService>>,
) -> Result<PermissionState, String> {
    blocking(&service, |service| service.request_permission()).await?
}

/// 打开系统的通知设置（macOS / Windows）。
#[tauri::command]
pub fn notifications_open_settings(app: tauri::AppHandle) -> Result<(), String> {
    notifications::open_system_settings(&app)
}
