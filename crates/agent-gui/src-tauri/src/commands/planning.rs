use crate::services::planning::{self, backend, Mutation, MutationResult, Query, Snapshot};
use serde_json::{json, Value};

#[tauri::command]
pub async fn planning_migrate_legacy(app: tauri::AppHandle) -> Result<(), String> {
    backend::migrate_on_demand(&app).await
}

#[tauri::command]
pub async fn planning_notification_test(app: tauri::AppHandle) -> Result<(), String> {
    planning::notification::deliver(
        &app,
        format!("planning-test-{}", uuid::Uuid::new_v4()),
        "LiveAgent".into(),
        "日程通知测试 / Calendar notification test".into(),
        true,
    )
    .await
}

#[tauri::command]
pub async fn planning_query(
    app: tauri::AppHandle,
    query: Option<Query>,
) -> Result<Snapshot, String> {
    serde_json::from_value(backend::request(&app, "query", json!(query.unwrap_or_default())).await?)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn planning_mutate(
    app: tauri::AppHandle,
    input: Mutation,
) -> Result<MutationResult, String> {
    let result: MutationResult =
        serde_json::from_value(backend::request(&app, "mutate", json!(input)).await?)
            .map_err(|e| e.to_string())?;
    if result.status == "ok" {
        planning::changed(&app, result.seq);
    }
    Ok(result)
}
#[tauri::command]
pub fn planning_set_labels(notification_title: String) {
    planning::set_notification_title(notification_title);
}
#[tauri::command]
pub async fn planning_export(app: tauri::AppHandle) -> Result<Snapshot, String> {
    serde_json::from_value(backend::request(&app, "export", json!({})).await?)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn planning_import(app: tauri::AppHandle, snapshot: Snapshot) -> Result<(), String> {
    backend::request(&app, "import", json!(snapshot)).await?;
    Ok(())
}
#[tauri::command]
pub async fn planning_subscription(
    app: tauri::AppHandle,
    action: String,
    input: Value,
) -> Result<Value, String> {
    backend::request(&app, &action, input).await
}
