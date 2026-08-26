use std::sync::Arc;

use tauri::State;

use crate::services::browser::types::{
    BrowserActionArgs, BrowserActionResponse, BrowserStatusResponse,
};
use crate::services::browser::BrowserManager;

#[tauri::command]
pub async fn browser_action(
    state: State<'_, Arc<BrowserManager>>,
    args: BrowserActionArgs,
) -> Result<BrowserActionResponse, String> {
    let manager = Arc::clone(&state);
    manager.execute(args).await
}

#[tauri::command]
pub async fn browser_status(
    state: State<'_, Arc<BrowserManager>>,
) -> Result<BrowserStatusResponse, String> {
    let manager = Arc::clone(&state);
    Ok(manager.status().await)
}

#[tauri::command]
pub async fn browser_close(state: State<'_, Arc<BrowserManager>>) -> Result<(), String> {
    let manager = Arc::clone(&state);
    manager.close().await
}
