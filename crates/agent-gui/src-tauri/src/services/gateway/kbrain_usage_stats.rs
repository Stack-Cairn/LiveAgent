//! Settings → Usage over the desktop-owned Gateway. The WebUI asks for K-brain's
//! cross-session token usage (`usage_stats`); the desktop relays it read-only to
//! K-brain's `GET /v1/usage/stats` and returns the JSON as is. A K-brain without
//! `capabilities.usage_stats` answers `unsupported`, so the page can ask for an
//! update instead of showing a failure.

use std::io::Read as _;
use std::sync::Arc;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::AUTHORIZATION;
use reqwest::StatusCode;
use serde_json::Value;
use tauri::Manager as _;

use super::gateway_proto::v2 as proto;
use crate::services::kbrain_backend::{KBrainBackendConnection, KBrainBackendState};

/// 52 full weeks plus the current one, the heatmap's range.
pub(crate) const DEFAULT_DAYS: i32 = 371;
/// Two years; a larger range is refused before K-brain aggregates it.
pub(crate) const MAX_DAYS: i32 = 1100;
const MAX_TIMEZONE_LEN: usize = 64;
const MAX_ANSWER_BYTES: u64 = 8 << 20;
const CAPABILITY: &str = "usage_stats";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// K-brain's query string for a WebUI request: days 0 means the default range and an
/// empty time zone lets K-brain use its own. Only IANA name characters are accepted,
/// so the time zone cannot add query parameters.
pub(crate) fn usage_stats_query(days: i32, timezone: &str) -> Result<String, String> {
    let days = if days == 0 { DEFAULT_DAYS } else { days };
    if !(1..=MAX_DAYS).contains(&days) {
        return Err(format!(
            "invalid usage stats request: days must be between 1 and {MAX_DAYS}"
        ));
    }
    let timezone = timezone.trim();
    let valid_timezone = timezone.len() <= MAX_TIMEZONE_LEN
        && timezone
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'));
    if !valid_timezone {
        return Err(
            "invalid usage stats request: timezone must be an IANA time zone name".to_string(),
        );
    }
    let mut query = format!("?days={days}");
    if !timezone.is_empty() {
        query.push_str(&format!("&tz={}", urlencoding::encode(timezone)));
    }
    Ok(query)
}

pub(crate) fn supports_usage_stats(health: &Value) -> bool {
    health
        .get("capabilities")
        .and_then(|caps| caps.get(CAPABILITY))
        .and_then(Value::as_f64)
        .is_some_and(|version| version >= 1.0)
}

/// Gateway entry: starts K-brain when needed, like the other settings pages. Blocking;
/// the envelope handler runs it off the dispatch loop.
pub(crate) fn handle_usage_stats(
    app: &tauri::AppHandle,
    request: proto::UsageStatsRequest,
) -> Result<proto::UsageStatsResponse, String> {
    let query = usage_stats_query(request.days, &request.timezone)?;
    let backend = app
        .try_state::<Arc<KBrainBackendState>>()
        .ok_or_else(|| "K-brain backend state is unavailable".to_string())?;
    let connection = backend.ensure_started(app)?;
    fetch_usage_stats(&connection, &query)
}

fn client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("failed to create K-brain client: {error}"))
}

fn unsupported() -> proto::UsageStatsResponse {
    proto::UsageStatsResponse {
        result_json: String::new(),
        unsupported: true,
    }
}

/// Reads `/v1/health` then `/v1/usage/stats{query}`. Errors never carry the URL or the
/// token; a K-brain `{"error": ...}` body is passed on.
pub(crate) fn fetch_usage_stats(
    connection: &KBrainBackendConnection,
    query: &str,
) -> Result<proto::UsageStatsResponse, String> {
    let client = client()?;
    let get = |path: &str| {
        client
            .get(format!(
                "{}{path}",
                connection.base_url.trim_end_matches('/')
            ))
            .header(AUTHORIZATION, format!("Bearer {}", connection.token))
            .send()
            .map_err(|error| format!("usage stats request failed: {}", error.without_url()))
    };

    let health = get("/v1/health")?;
    if health.status() == StatusCode::NOT_FOUND {
        return Ok(unsupported());
    }
    if !health.status().is_success() {
        return Err(format!(
            "K-brain health check failed: HTTP {}",
            health.status()
        ));
    }
    let health: Value = health
        .json()
        .map_err(|error| format!("K-brain health was invalid JSON: {}", error.without_url()))?;
    if !supports_usage_stats(&health) {
        return Ok(unsupported());
    }

    let response = get(&format!("/v1/usage/stats{query}"))?;
    let status = response.status();
    let mut body = Vec::new();
    response
        .take(MAX_ANSWER_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|error| format!("read usage stats failed: {error}"))?;
    if body.len() as u64 > MAX_ANSWER_BYTES {
        return Err("K-brain usage stats response is too large".to_string());
    }
    if status == StatusCode::NOT_FOUND {
        // The capability was reported but the route is gone (downgraded backend).
        return Ok(unsupported());
    }
    let parsed = serde_json::from_slice::<Value>(&body);
    if !status.is_success() {
        let reason = parsed
            .ok()
            .and_then(|value| value.get("error").and_then(Value::as_str).map(str::to_owned))
            .map(|reason| reason.trim().to_string())
            .filter(|reason| !reason.is_empty());
        return Err(match reason {
            Some(reason) => format!("usage stats failed: {reason}"),
            None => format!("usage stats failed: HTTP {status}"),
        });
    }
    match parsed {
        Ok(Value::Object(_)) => Ok(proto::UsageStatsResponse {
            result_json: String::from_utf8_lossy(&body).into_owned(),
            unsupported: false,
        }),
        _ => Err("K-brain usage stats response is not a JSON object".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    const TOKEN: &str = "usage-stats-secret-token";

    /// Serves one answer per connection, in order, and returns the request lines.
    fn kbrain_stub(
        answers: Vec<(&'static str, String)>,
    ) -> (KBrainBackendConnection, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind stub");
        let base_url = format!("http://{}", listener.local_addr().expect("stub addr"));
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for (status, body) in answers {
                let (mut stream, _) = listener.accept().expect("accept");
                stream
                    .set_read_timeout(Some(Duration::from_millis(500)))
                    .expect("read timeout");
                let mut request = Vec::new();
                let mut chunk = [0_u8; 1024];
                while !String::from_utf8_lossy(&request).contains("\r\n\r\n") {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&chunk[..read]),
                    }
                }
                let text = String::from_utf8_lossy(&request).into_owned();
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                seen.push(text);
            }
            seen
        });
        let connection = KBrainBackendConnection {
            base_url,
            token: TOKEN.into(),
            protocol_version: "usage-stats".into(),
            storage_id: "usage-stats".into(),
        };
        (connection, handle)
    }

    fn health(capabilities: Value) -> (&'static str, String) {
        (
            "200 OK",
            json!({ "status": "ok", "capabilities": capabilities }).to_string(),
        )
    }

    #[test]
    fn query_keeps_range_and_timezone_within_bounds() {
        assert_eq!(usage_stats_query(0, ""), Ok("?days=371".to_string()));
        assert_eq!(
            usage_stats_query(371, " Asia/Shanghai "),
            Ok("?days=371&tz=Asia%2FShanghai".to_string())
        );
        assert_eq!(
            usage_stats_query(7, "Etc/GMT+8"),
            Ok("?days=7&tz=Etc%2FGMT%2B8".to_string())
        );
        // K-brain accepts up to 1100 days.
        assert_eq!(usage_stats_query(1100, ""), Ok("?days=1100".to_string()));
        for (days, timezone) in [
            (-1, ""),
            (MAX_DAYS + 1, ""),
            (30, "UTC&days=99999"),
            (30, "Asia/Shang hai"),
            (30, "../%2e%2e"),
        ] {
            assert!(
                usage_stats_query(days, timezone).is_err(),
                "{days} {timezone:?} must be rejected"
            );
        }
        assert!(usage_stats_query(30, &"A".repeat(65)).is_err());
    }

    #[test]
    fn capability_needs_usage_stats_version_one() {
        assert!(supports_usage_stats(&json!({"capabilities": {"usage_stats": 1}})));
        assert!(supports_usage_stats(&json!({"capabilities": {"usage_stats": 2}})));
        assert!(!supports_usage_stats(&json!({"capabilities": {"usage_stats": 0}})));
        assert!(!supports_usage_stats(&json!({"capabilities": {"usage_stats": true}})));
        assert!(!supports_usage_stats(&json!({"capabilities": {}})));
        assert!(!supports_usage_stats(&json!({})));
    }

    #[test]
    fn stats_are_relayed_as_is_with_the_bearer_token() {
        let stats = r#"{"timezone":"Asia/Shanghai","days":371,"totals":{"total":12},"daily":[],"models":[]}"#;
        let (connection, handle) = kbrain_stub(vec![
            health(json!({"usage_stats": 1})),
            ("200 OK", stats.to_string()),
        ]);
        let response =
            fetch_usage_stats(&connection, "?days=371&tz=Asia%2FShanghai").expect("relay");
        assert!(!response.unsupported);
        assert_eq!(response.result_json, stats);
        let requests = handle.join().expect("stub");
        assert!(requests[0].starts_with("GET /v1/health "));
        assert!(requests[1].starts_with("GET /v1/usage/stats?days=371&tz=Asia%2FShanghai "));
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains(&format!("authorization: bearer {TOKEN}")));
    }

    #[test]
    fn backend_without_capability_is_unsupported_and_not_asked() {
        let (connection, handle) = kbrain_stub(vec![health(json!({"permission_rules": 1}))]);
        let response = fetch_usage_stats(&connection, "?days=7").expect("relay");
        assert!(response.unsupported);
        assert!(response.result_json.is_empty());
        assert_eq!(handle.join().expect("stub").len(), 1);
    }

    #[test]
    fn missing_route_after_capability_is_unsupported() {
        let (connection, handle) = kbrain_stub(vec![
            health(json!({"usage_stats": 1})),
            ("404 Not Found", "404 page not found".to_string()),
        ]);
        assert!(
            fetch_usage_stats(&connection, "?days=7")
                .expect("relay")
                .unsupported
        );
        handle.join().expect("stub");
    }

    #[test]
    fn kbrain_errors_are_passed_on_without_token_or_url() {
        let cases = [
            (
                "400 Bad Request",
                r#"{"error":"unknown time zone"}"#,
                "usage stats failed: unknown time zone",
            ),
            (
                "500 Internal Server Error",
                "not json",
                "usage stats failed: HTTP 500 Internal Server Error",
            ),
            (
                "200 OK",
                "[1,2]",
                "K-brain usage stats response is not a JSON object",
            ),
        ];
        for (status, body, expected) in cases {
            let (connection, handle) = kbrain_stub(vec![
                health(json!({"usage_stats": 1})),
                (status, body.to_string()),
            ]);
            let error = fetch_usage_stats(&connection, "?days=7").expect_err("must fail");
            assert_eq!(error, expected);
            assert!(!error.contains(TOKEN) && !error.contains(&connection.base_url));
            handle.join().expect("stub");
        }
    }
}
