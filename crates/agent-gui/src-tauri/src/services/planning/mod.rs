pub mod backend;
#[cfg(test)]
mod calendar_import;
#[cfg(test)]
mod hierarchy;
mod legacy;
pub mod notification;
#[cfg(test)]
pub mod store;
#[cfg(test)]
pub mod subscription;
#[cfg(test)]
mod task_import;
#[cfg(test)]
mod tests;
#[cfg(test)]
pub mod time;
#[cfg(test)]
mod trash;
pub mod types;
use crate::services::notification_prefs::{self, Category};
use std::sync::{Arc, RwLock};
#[cfg(test)]
pub use store::PlanningStore;
use tauri::{Emitter, Manager};
pub use types::*;

/// Reminder notification title, pushed by the frontend in the UI language
/// (the backend has no locale of its own, same as the tray menu).
static NOTIFICATION_TITLE: RwLock<String> = RwLock::new(String::new());

pub fn set_notification_title(title: String) {
    if let Ok(mut current) = NOTIFICATION_TITLE.write() {
        *current = title.chars().take(120).collect();
    }
}

fn notification_title() -> String {
    NOTIFICATION_TITLE
        .read()
        .ok()
        .filter(|title| !title.trim().is_empty())
        .map(|title| title.clone())
        .unwrap_or_else(|| "LiveAgent".into())
}

pub async fn handle_request(
    app: &tauri::AppHandle,
    request: crate::services::gateway::proto::PlanningRequest,
) -> Result<crate::services::gateway::proto::PlanningResponse, String> {
    if request.input_json.len() > 4_000_000 {
        return Err("E:request_too_large".into());
    }
    let input = if request.input_json.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&request.input_json).map_err(|e| e.to_string())?
    };
    let result = backend::request(app, &request.action, input).await?;
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

/// When a claimed reminder came due: its trigger time, or a later snooze.
fn reminder_due_at(reminder: &serde_json::Value) -> i64 {
    let at = |key: &str| reminder[key].as_f64().map(|value| value as i64);
    match (at("triggerAt"), at("snoozedUntil")) {
        (Some(trigger), Some(snoozed)) => trigger.max(snoozed),
        (trigger, snoozed) => trigger.or(snoozed).unwrap_or(0),
    }
}

pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(30));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            timer.tick().await;
            if notification::disabled() {
                continue;
            }
            // Until the frontend pushes its switches, leave reminders pending.
            if notification_prefs::allows(Category::Calendar).is_none() {
                continue;
            }
            let claimed = backend::request(&app, "reminders.claim", serde_json::json!({})).await;
            if let Ok(serde_json::Value::Array(reminders)) = claimed {
                for mut reminder in reminders {
                    // Off now, or off when it came due: settle the reminder as
                    // handled so turning the switch back on does not replay it.
                    let due = reminder_due_at(&reminder);
                    let allowed = notification_prefs::allows(Category::Calendar) == Some(true)
                        && !notification_prefs::suppressed(Category::Calendar, due);
                    let success = if allowed {
                        let delivery = notification::deliver(
                            &app,
                            reminder["id"].as_str().unwrap_or("").to_string(),
                            notification_title(),
                            reminder["title"].as_str().unwrap_or("").to_string(),
                            false,
                        )
                        .await;
                        if let Err(error) = &delivery {
                            eprintln!("[planning] notification delivery failed: {error}");
                        }
                        delivery.is_ok()
                    } else {
                        true
                    };
                    reminder["success"] = serde_json::json!(success);
                    let _ = backend::request(&app, "reminders.finish", reminder).await;
                }
            }
        }
    });
}

#[cfg(test)]
mod reminder_due_tests {
    use super::reminder_due_at;

    #[test]
    fn due_time_is_the_later_of_trigger_and_snooze() {
        let due = |value| reminder_due_at(&value);
        assert_eq!(
            due(serde_json::json!({"triggerAt": 100, "snoozedUntil": 0})),
            100
        );
        assert_eq!(
            due(serde_json::json!({"triggerAt": 100, "snoozedUntil": 500})),
            500
        );
        assert_eq!(due(serde_json::json!({"snoozedUntil": 500})), 500);
        assert_eq!(due(serde_json::json!({})), 0);
    }
}
