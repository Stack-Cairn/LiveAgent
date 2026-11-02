use super::{CronOccurrenceQuery, CronOccurrencesResponse};
use crate::services::planning::backend;

pub async fn query(
    app: tauri::AppHandle,
    range: CronOccurrenceQuery,
) -> Result<CronOccurrencesResponse, String> {
    let value = backend::request(
        &app,
        "cron.occurrences",
        serde_json::json!({"from": range.from, "to": range.to}),
    )
    .await?;
    serde_json::from_value(value).map_err(|e| e.to_string())
}
