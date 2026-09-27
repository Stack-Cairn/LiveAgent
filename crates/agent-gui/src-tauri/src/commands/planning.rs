use crate::services::planning::{self, Mutation, MutationResult, PlanningStore, Query, Snapshot};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn planning_query(
    store: State<'_, Arc<PlanningStore>>,
    query: Option<Query>,
) -> Result<Snapshot, String> {
    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || store.snapshot(query.unwrap_or_default()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn planning_mutate(
    app: tauri::AppHandle,
    store: State<'_, Arc<PlanningStore>>,
    input: Mutation,
) -> Result<MutationResult, String> {
    let store = Arc::clone(&store);
    let response = tauri::async_runtime::spawn_blocking(move || store.mutate(input))
        .await
        .map_err(|e| e.to_string())??;
    if response.status == "ok" {
        planning::changed(&app, response.seq);
    }
    Ok(response)
}

/// Localized labels for backend-originated UI (reminder notifications).
#[tauri::command]
pub fn planning_set_labels(notification_title: String) {
    planning::set_notification_title(notification_title);
}

#[tauri::command]
pub async fn planning_export(store: State<'_, Arc<PlanningStore>>) -> Result<Snapshot, String> {
    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || store.export())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn planning_import(
    app: tauri::AppHandle,
    store: State<'_, Arc<PlanningStore>>,
    snapshot: Snapshot,
) -> Result<(), String> {
    let store = Arc::clone(&store);
    let store2 = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || store2.import(snapshot))
        .await
        .map_err(|e| e.to_string())??;
    planning::changed(&app, store.snapshot(Query::default())?.seq);
    Ok(())
}
