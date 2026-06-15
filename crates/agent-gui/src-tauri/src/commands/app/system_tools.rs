use reqwest::header::CONTENT_TYPE;
use serde::Serialize;
use std::time::Duration;

const TEST_URL: &str = "https://httpbin.org/get";

#[derive(Debug, Serialize)]
pub struct SystemHttpGetResponse {
    pub url: String,
    pub status: u16,
    pub ok: bool,
    pub body: String,
    pub content_type: Option<String>,
}

#[tauri::command]
pub async fn system_http_get_test() -> Result<SystemHttpGetResponse, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| format!("Failed to create the HTTP client: {e}"))?;

        let response = client
            .get(TEST_URL)
            .send()
            .map_err(|e| format!("Test endpoint request failed: {e}"))?;

        let status = response.status();
        let ok = status.is_success();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());
        let body = response
            .text()
            .map_err(|e| format!("Failed to read the test endpoint response: {e}"))?;

        Ok(SystemHttpGetResponse {
            url: TEST_URL.to_string(),
            status: status.as_u16(),
            ok,
            body,
            content_type,
        })
    })
    .await
    .map_err(|e| format!("system_http_get_test join failed: {e}"))?
}
