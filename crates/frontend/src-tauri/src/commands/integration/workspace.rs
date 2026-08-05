use std::sync::Arc;

use backend::services::workspace_watch::{WatchSource, WorkspaceWatchService};

#[tauri::command]
pub fn workspace_watch_set(
    workdirs: Vec<String>,
    workspace_watch: tauri::State<'_, Arc<WorkspaceWatchService>>,
) -> Result<(), String> {
    workspace_watch.set_desired(WatchSource::Local, workdirs);
    Ok(())
}
