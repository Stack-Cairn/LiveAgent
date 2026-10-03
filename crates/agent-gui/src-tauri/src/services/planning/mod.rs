mod calendar_import;
mod hierarchy;
pub mod store;
pub mod subscription;
mod task_import;
#[cfg(test)]
mod tests;
pub mod time;
mod trash;
pub mod types;
use crate::services::notifications::{Notice, NotificationKind, NotificationService};
use std::sync::Arc;
pub use store::PlanningStore;
use tauri::{Emitter, Manager};
pub use types::*;

pub async fn handle_request(
    app: &tauri::AppHandle,
    request: crate::services::gateway::proto::PlanningRequest,
) -> Result<crate::services::gateway::proto::PlanningResponse, String> {
    let store = Arc::clone(app.state::<Arc<PlanningStore>>().inner());
    let action = request.action.clone();
    let raw = request.input_json;
    if raw.len() > 4_000_000 {
        return Err("E:request_too_large".into());
    }
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
            let input = if raw.is_empty() { "{}" } else { &raw };
            match action.as_str() {
                "query" => serde_json::to_value(
                    store.snapshot(serde_json::from_str(input).map_err(|e| e.to_string())?)?,
                )
                .map_err(|e| e.to_string()),
                "mutate" => serde_json::to_value(
                    store.mutate(serde_json::from_str(input).map_err(|e| e.to_string())?)?,
                )
                .map_err(|e| e.to_string()),
                "export" => serde_json::to_value(store.export()?).map_err(|e| e.to_string()),
                action if action.starts_with("subscription.") => {
                    let input: serde_json::Value =
                        serde_json::from_str(input).map_err(|e| e.to_string())?;
                    Ok(store.subscription(action, &input)?.0)
                }
                "import" => {
                    store.import(serde_json::from_str(input).map_err(|e| e.to_string())?)?;
                    Ok(serde_json::Value::Null)
                }
                _ => Err("E:unknown_request".into()),
            }
        })
        .await
        .map_err(|e| e.to_string())??;
    if request.action == "mutate"
        || request.action == "import"
        || request.action.starts_with("subscription.")
    {
        changed(
            app,
            app.state::<Arc<PlanningStore>>()
                .snapshot(Query::default())?
                .seq,
        );
    }
    Ok(crate::services::gateway::proto::PlanningResponse {
        result_json: result.to_string(),
    })
}

pub fn changed(app: &tauri::AppHandle, seq: u64) {
    let _ = app.emit("planning:changed", seq);
    if let Some(controller) = app.try_state::<Arc<crate::services::gateway::GatewayController>>() {
        let controller = Arc::clone(controller.inner());
        tauri::async_runtime::spawn(async move {
            let _ = controller.publish_planning_changed(seq).await;
        });
    }
}

/// 到点超过这个时长才被领取的提醒（应用长时间未运行 / 睡眠）只视为已处理，不再补弹。
pub const STALE_REMINDER_MS: i64 = 24 * 60 * 60 * 1000;

pub fn is_stale_reminder(reminder: &Reminder, now: i64) -> bool {
    now - reminder.snoozed_until.unwrap_or(reminder.trigger_at) > STALE_REMINDER_MS
}

/// 提醒投递结果是否算已处理：只有系统通知真正失败才保留原有退避重试；
/// 类别关闭、节流、环境关闭或过期都视为已通知。
fn deliver_reminder(notifications: &NotificationService, reminder: &Reminder, now: i64) -> bool {
    if is_stale_reminder(reminder, now) {
        return true;
    }
    let notice = Notice::new(
        NotificationKind::PlanningReminder,
        notifications.label(
            "planningReminderTitle",
            "LiveAgent · Calendar reminder",
            &[],
        ),
        &reminder.title,
    );
    match notifications.notify(notice) {
        Ok(_) => true,
        Err(error) => {
            eprintln!("planning reminder notification: {error}");
            false
        }
    }
}

pub fn start(
    app: tauri::AppHandle,
    store: Arc<PlanningStore>,
    notifications: Arc<NotificationService>,
) {
    tauri::async_runtime::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(30));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            timer.tick().await;
            let worker = Arc::clone(&store);
            let claimed =
                tauri::async_runtime::spawn_blocking(move || worker.claim_reminders(store::now()))
                    .await;
            match claimed {
                Ok(Ok(reminders)) => {
                    for reminder in reminders {
                        let worker = Arc::clone(&store);
                        let notifications = Arc::clone(&notifications);
                        let _ = tauri::async_runtime::spawn_blocking(move || {
                            let success = deliver_reminder(&notifications, &reminder, store::now());
                            worker.finish_notification(&reminder, success, store::now())
                        })
                        .await;
                    }
                    if let Ok(s) = store.snapshot(Query::default()) {
                        changed(&app, s.seq);
                    }
                }
                Ok(Err(error)) => eprintln!("planning reminder: {error}"),
                Err(error) => eprintln!("planning worker: {error}"),
            }
        }
    });
}
