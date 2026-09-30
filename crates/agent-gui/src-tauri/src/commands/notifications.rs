use std::collections::HashMap;
use std::sync::Arc;

use tauri::State;

use crate::services::notifications::{
    self, Notice, NotificationKind, NotificationService, NotifyOutcome,
};

/// Agent `Notify` 两次系统通知的最小间隔：防止循环调用刷屏。
const AGENT_NOTIFY_MIN_INTERVAL_MS: i64 = 30_000;

/// 前端按界面语言推送的通知文案（标题模板等）。
#[tauri::command]
pub fn notifications_set_labels(
    labels: HashMap<String, String>,
    service: State<'_, Arc<NotificationService>>,
) {
    service.set_labels(labels);
}

/// 设置页「发送测试通知」：不受类别开关影响。
#[tauri::command]
pub fn notifications_test(
    service: State<'_, Arc<NotificationService>>,
) -> Result<NotifyOutcome, String> {
    service.notify(Notice::new(
        NotificationKind::Test,
        service.label("testTitle", "LiveAgent test notification", &[]),
        service.label(
            "testBody",
            "If you can see this, system notifications are working.",
            &[],
        ),
    ))
}

/// Agent `Notify` 工具。
#[tauri::command]
pub fn notifications_notify(
    title: String,
    body: Option<String>,
    service: State<'_, Arc<NotificationService>>,
) -> Result<NotifyOutcome, String> {
    service.notify(
        Notice::new(
            NotificationKind::AgentMessage,
            title,
            body.unwrap_or_default(),
        )
        .throttled("agent", AGENT_NOTIFY_MIN_INTERVAL_MS),
    )
}

/// 打开系统的通知设置（macOS / Windows）。
#[tauri::command]
pub fn notifications_open_settings(app: tauri::AppHandle) -> Result<(), String> {
    notifications::open_system_settings(&app)
}
