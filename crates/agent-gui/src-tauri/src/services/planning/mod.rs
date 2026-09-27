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
use std::sync::{Arc, RwLock};
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

pub fn start(app: tauri::AppHandle, store: Arc<PlanningStore>) {
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
                        use tauri_plugin_notification::NotificationExt;
                        let success = if std::env::var("LIVEAGENT_DISABLE_NOTIFICATIONS").as_deref()
                            == Ok("1")
                        {
                            true
                        } else {
                            app.notification()
                                .builder()
                                .title(notification_title())
                                .body(&reminder.title)
                                .show()
                                .is_ok()
                        };
                        let worker = Arc::clone(&store);
                        let _ = tauri::async_runtime::spawn_blocking(move || {
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
