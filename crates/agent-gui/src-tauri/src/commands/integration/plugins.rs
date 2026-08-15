use serde_json::Value;

use crate::services::plugins::{
    self, ConversationPromptPluginRequest, PluginConfigUpdate, PluginHookDispatchRequest,
    PluginHookDispatchResult, PluginInstallOptions, PluginInventoryItem, PluginInvocationResult,
    PluginTurnSnapshot,
};

async fn run_blocking<R: Send + 'static>(
    label: &'static str,
    operation: impl FnOnce() -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("{label} join failed: {error}"))?
}

#[tauri::command]
pub async fn plugin_list(workspace: Option<String>) -> Result<Vec<PluginInventoryItem>, String> {
    run_blocking("plugin_list", move || {
        plugins::inventory(workspace.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn plugin_install(
    source_path: String,
    options: PluginInstallOptions,
) -> Result<PluginInventoryItem, String> {
    run_blocking("plugin_install", move || {
        plugins::install(&source_path, options)
    })
    .await
}

#[tauri::command]
pub async fn plugin_create_prompt(
    request: ConversationPromptPluginRequest,
) -> Result<PluginInventoryItem, String> {
    run_blocking("plugin_create_prompt", move || {
        plugins::create_prompt_plugin(request)
    })
    .await
}

#[tauri::command]
pub async fn plugin_set_enabled(
    plugin_id: String,
    workspace: Option<String>,
    enabled: bool,
) -> Result<i64, String> {
    run_blocking("plugin_set_enabled", move || {
        plugins::enable(&plugin_id, workspace.as_deref(), enabled)
    })
    .await
}

#[tauri::command]
pub async fn plugin_set_grants(plugin_id: String, permissions: Vec<String>) -> Result<i64, String> {
    run_blocking("plugin_set_grants", move || {
        plugins::grant(&plugin_id, permissions)
    })
    .await
}

#[tauri::command]
pub async fn plugin_uninstall(plugin_id: String) -> Result<(), String> {
    run_blocking("plugin_uninstall", move || plugins::uninstall(&plugin_id)).await
}

#[tauri::command]
pub async fn plugin_update_config(update: PluginConfigUpdate) -> Result<i64, String> {
    run_blocking("plugin_update_config", move || plugins::configure(update)).await
}

#[tauri::command]
pub async fn plugin_prepare_turn(workspace: String) -> Result<PluginTurnSnapshot, String> {
    run_blocking("plugin_prepare_turn", move || {
        plugins::prepare_turn(&workspace)
    })
    .await
}

#[tauri::command]
pub async fn plugin_invoke_tool(
    workspace: String,
    plugin_id: String,
    model_name: String,
    generation: i64,
    arguments: Value,
) -> Result<PluginInvocationResult, String> {
    run_blocking("plugin_invoke_tool", move || {
        plugins::invoke_tool(&workspace, &plugin_id, &model_name, generation, arguments)
    })
    .await
}

#[tauri::command]
pub async fn plugin_dispatch_hook(
    request: PluginHookDispatchRequest,
) -> Result<Vec<PluginHookDispatchResult>, String> {
    run_blocking("plugin_dispatch_hook", move || {
        plugins::dispatch_hook(request)
    })
    .await
}

#[tauri::command]
pub fn plugin_api_version() -> &'static str {
    plugins::plugin_api_version()
}
