use std::sync::Arc;

use backend::services::provider_usage::{ProviderUsageResult, ProviderUsageService};

#[tauri::command]
pub async fn provider_usage_query(
    provider_id: String,
    refresh: bool,
    provider_usage_service: tauri::State<'_, Arc<ProviderUsageService>>,
) -> Result<ProviderUsageResult, String> {
    Ok(provider_usage_service.query(&provider_id, refresh).await)
}

#[tauri::command]
pub async fn provider_usage_test(
    provider_id: String,
    config_json: String,
    provider_usage_service: tauri::State<'_, Arc<ProviderUsageService>>,
) -> Result<ProviderUsageResult, String> {
    Ok(provider_usage_service
        .test(&provider_id, &config_json)
        .await)
}
