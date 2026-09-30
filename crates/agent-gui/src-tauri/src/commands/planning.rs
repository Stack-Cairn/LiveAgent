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

/// `subscription.create|update|refresh|delete`; also reachable from WebUI via the gateway.
#[tauri::command]
pub async fn planning_subscription(
    app: tauri::AppHandle,
    store: State<'_, Arc<PlanningStore>>,
    action: String,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let store = Arc::clone(&store);
    let (value, seq) =
        tauri::async_runtime::spawn_blocking(move || store.subscription(&action, &input))
            .await
            .map_err(|e| e.to_string())??;
    planning::changed(&app, seq);
    Ok(value)
}

/// Desktop refresh loop: claim subscriptions that are due.
#[tauri::command]
pub async fn planning_subscription_due(
    store: State<'_, Arc<PlanningStore>>,
) -> Result<Vec<String>, String> {
    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || store.due_subscriptions(planning::store::now()))
        .await
        .map_err(|e| e.to_string())?
}

/// Download the feed through the app proxy; the URL never leaves the backend.
#[tauri::command]
pub async fn planning_subscription_fetch(
    store: State<'_, Arc<PlanningStore>>,
    id: String,
) -> Result<String, String> {
    const MAX_BYTES: usize = 10 * 1024 * 1024;
    let url = store.subscription_url(&id)?;
    let fail = |detail: String| format!("E:subscription_fetch_failed:{detail}");
    let response = crate::services::system_proxy::cached_client()
        .map_err(fail)?
        .get(&url)
        .header(
            reqwest::header::ACCEPT,
            "text/calendar, text/plain;q=0.9, */*;q=0.1",
        )
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| fail(e.without_url().to_string()))?;
    if !response.status().is_success() {
        return Err(fail(format!("HTTP {}", response.status().as_u16())));
    }
    if response
        .content_length()
        .is_some_and(|len| len as usize > MAX_BYTES)
    {
        return Err("E:subscription_too_large".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| fail(e.without_url().to_string()))?;
    if bytes.len() > MAX_BYTES {
        return Err("E:subscription_too_large".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "E:subscription_not_ics".into())
}

#[tauri::command]
pub async fn planning_subscription_sync(
    app: tauri::AppHandle,
    store: State<'_, Arc<PlanningStore>>,
    id: String,
    entries: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let store = Arc::clone(&store);
    let (value, seq) =
        tauri::async_runtime::spawn_blocking(move || store.sync_subscription(&id, &entries))
            .await
            .map_err(|e| e.to_string())??;
    planning::changed(&app, seq);
    Ok(value)
}

#[tauri::command]
pub async fn planning_subscription_fail(
    app: tauri::AppHandle,
    store: State<'_, Arc<PlanningStore>>,
    id: String,
    error: String,
) -> Result<(), String> {
    let store = Arc::clone(&store);
    let seq = tauri::async_runtime::spawn_blocking(move || store.fail_subscription(&id, &error))
        .await
        .map_err(|e| e.to_string())??;
    planning::changed(&app, seq);
    Ok(())
}
