//! K-brain's web search fallback service over the desktop-owned Gateway. The WebUI reads
//! and writes it as `kbrainWebSearch`, like the memory switch: the value lives in K-brain's
//! `/v1/settings` (`webSearch`, capability web_search_fallback) and never in LiveAgent's
//! own settings. The API key only ever travels from the WebUI to K-brain; K-brain reports
//! whether one is configured, never the key.

use reqwest::header::AUTHORIZATION;
use serde_json::{Map, Value};

use crate::services::kbrain_backend::KBrainBackendConnection;

pub(crate) const KBRAIN_WEB_SEARCH_FIELD: &str = "kbrainWebSearch";
const BACKEND_FIELD: &str = "webSearch";

/// The web search section of a K-brain settings document, limited to the documented
/// read-only view; None for a backend without it, so the WebUI treats search as
/// unsupported rather than unconfigured.
pub(crate) fn web_search_from_settings(settings: &Value) -> Option<Value> {
    let source = settings.get(BACKEND_FIELD)?.as_object()?;
    let available = source.get("available")?.as_bool()?;
    let mut out = Map::new();
    out.insert("available".into(), Value::Bool(available));
    for field in ["provider", "baseUrl", "apiKeySource", "reason"] {
        if let Some(text) = source.get(field).and_then(Value::as_str) {
            out.insert(field.into(), Value::String(text.into()));
        }
    }
    if let Some(max) = source.get("maxResults").filter(|value| value.is_number()) {
        out.insert("maxResults".into(), max.clone());
    }
    if let Some(configured) = source.get("apiKeyConfigured").and_then(Value::as_bool) {
        out.insert("apiKeyConfigured".into(), Value::Bool(configured));
    }
    if let Some(providers) = source.get("providers").and_then(Value::as_array) {
        out.insert(
            "providers".into(),
            Value::Array(
                providers
                    .iter()
                    .filter(|provider| provider.is_string())
                    .cloned()
                    .collect(),
            ),
        );
    }
    Some(Value::Object(out))
}

/// Removes `kbrainWebSearch` from a WebUI settings update and returns K-brain's
/// `webSearch` update. Only the editable fields are forwarded (provider, apiKey,
/// clearApiKey, baseUrl, maxResults); an empty key keeps the stored one and the
/// read-only fields of a GET body are dropped. K-brain checks the provider name,
/// the URL and the 0-10 range on write.
pub(crate) fn take_web_search_update(update: &mut Value) -> Result<Option<Value>, String> {
    let Some(map) = update.as_object_mut() else {
        return Ok(None);
    };
    let Some(value) = map.remove(KBRAIN_WEB_SEARCH_FIELD) else {
        return Ok(None);
    };
    let invalid = || {
        "kbrainWebSearch must be an object with string provider, apiKey and baseUrl, boolean clearApiKey and numeric maxResults"
            .to_string()
    };
    let source = value.as_object().ok_or_else(invalid)?;
    let text = |field: &str| -> Result<Option<String>, String> {
        match source.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.trim().to_string())),
            Some(_) => Err(invalid()),
        }
    };
    let mut out = Map::new();
    if let Some(provider) = text("provider")? {
        out.insert("provider".into(), Value::String(provider));
    }
    let key = text("apiKey")?.unwrap_or_default();
    if !key.is_empty() {
        out.insert("apiKey".into(), Value::String(key.clone()));
    }
    match source.get("clearApiKey") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => {}
        Some(Value::Bool(true)) => {
            if !key.is_empty() {
                return Err("cannot replace and clear the web search API key together".into());
            }
            out.insert("clearApiKey".into(), Value::Bool(true));
        }
        Some(_) => return Err(invalid()),
    }
    if let Some(base_url) = text("baseUrl")? {
        out.insert("baseUrl".into(), Value::String(base_url));
    }
    match source.get("maxResults") {
        None | Some(Value::Null) => {}
        Some(max) if max.is_number() => {
            out.insert("maxResults".into(), max.clone());
        }
        Some(_) => return Err(invalid()),
    }
    Ok(Some(Value::Object(out)))
}

pub(crate) fn write_web_search(
    connection: &KBrainBackendConnection,
    web_search: &Value,
) -> Result<(), String> {
    let response = super::kbrain_memory::client()?
        .put(format!("{}/v1/settings", connection.base_url))
        .header(AUTHORIZATION, format!("Bearer {}", connection.token))
        .json(&serde_json::json!({ BACKEND_FIELD: web_search }))
        .send()
        .map_err(|error| format!("save web search failed: {}", error.without_url()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    // K-brain explains a rejected value (unknown provider, bad URL, range) in its error
    // body; pass that on so the WebUI can show why the save failed.
    let reason = response
        .json::<Value>()
        .ok()
        .and_then(|body| body.get("error").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();
    Err(if reason.is_empty() {
        format!("save web search failed: HTTP {status}")
    } else {
        format!("save web search failed: {reason}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::time::Duration;

    #[test]
    fn web_search_is_read_only_from_a_backend_that_reports_it() {
        assert_eq!(
            web_search_from_settings(&json!({
                "webSearch": {
                    "provider": "tavily", "maxResults": 0, "apiKeyConfigured": true,
                    "apiKeySource": "env", "available": true,
                    "providers": ["tavily", "brave", 3], "apiKey": "never-relayed", "extra": 1
                }
            })),
            Some(json!({
                "provider": "tavily", "maxResults": 0, "apiKeyConfigured": true,
                "apiKeySource": "env", "available": true, "providers": ["tavily", "brave"]
            }))
        );
        assert_eq!(
            web_search_from_settings(&json!({
                "webSearch": {
                    "provider": "searxng", "maxResults": 0, "apiKeyConfigured": false,
                    "available": false, "reason": "webSearch.baseUrl is required for searxng"
                }
            })),
            Some(json!({
                "provider": "searxng", "maxResults": 0, "apiKeyConfigured": false,
                "available": false, "reason": "webSearch.baseUrl is required for searxng"
            }))
        );
        assert_eq!(web_search_from_settings(&json!({ "providers": [] })), None);
        assert_eq!(
            web_search_from_settings(&json!({ "webSearch": { "provider": "tavily" } })),
            None
        );
        assert_eq!(
            web_search_from_settings(&json!({ "webSearch": "tavily" })),
            None
        );
    }

    #[test]
    fn web_search_update_is_taken_out_of_the_liveagent_settings_update() {
        let mut update = json!({
            "kbrainWebSearch": {
                "provider": " searxng ", "baseUrl": " http://127.0.0.1:8888 ", "maxResults": 5
            },
            "theme": "dark"
        });
        assert_eq!(
            take_web_search_update(&mut update),
            Ok(Some(json!({
                "provider": "searxng", "baseUrl": "http://127.0.0.1:8888", "maxResults": 5
            })))
        );
        assert_eq!(update, json!({ "theme": "dark" }));

        // A new key is forwarded trimmed; an empty one keeps the stored key.
        let mut key = json!({ "kbrainWebSearch": { "apiKey": " tvly-new " } });
        assert_eq!(
            take_web_search_update(&mut key),
            Ok(Some(json!({ "apiKey": "tvly-new" })))
        );
        let mut keep = json!({ "kbrainWebSearch": { "provider": "tavily", "apiKey": "" } });
        assert_eq!(
            take_web_search_update(&mut keep),
            Ok(Some(json!({ "provider": "tavily" })))
        );
        let mut clear = json!({ "kbrainWebSearch": { "clearApiKey": true } });
        assert_eq!(
            take_web_search_update(&mut clear),
            Ok(Some(json!({ "clearApiKey": true })))
        );
        // A GET body put back: K-brain owns the read-only fields.
        let mut echoed = json!({ "kbrainWebSearch": {
            "provider": "brave", "maxResults": 0, "apiKeyConfigured": true,
            "apiKeySource": "env", "available": true, "reason": "", "providers": ["tavily"]
        } });
        assert_eq!(
            take_web_search_update(&mut echoed),
            Ok(Some(json!({ "provider": "brave", "maxResults": 0 })))
        );

        let mut untouched = json!({ "theme": "dark" });
        assert_eq!(take_web_search_update(&mut untouched), Ok(None));
        assert_eq!(untouched, json!({ "theme": "dark" }));

        for bad in [
            json!({ "kbrainWebSearch": null }),
            json!({ "kbrainWebSearch": [] }),
            json!({ "kbrainWebSearch": true }),
            json!({ "kbrainWebSearch": { "provider": 1 } }),
            json!({ "kbrainWebSearch": { "apiKey": true } }),
            json!({ "kbrainWebSearch": { "clearApiKey": "yes" } }),
            json!({ "kbrainWebSearch": { "maxResults": "5" } }),
            json!({ "kbrainWebSearch": { "apiKey": "k", "clearApiKey": true } }),
        ] {
            let mut update = bad;
            assert!(take_web_search_update(&mut update).is_err(), "{update}");
        }
    }

    const TOKEN: &str = "web-search-secret-token";

    /// One request: answers `status` with `body` and returns the raw request.
    fn kbrain_stub(
        status: &'static str,
        body: &'static str,
    ) -> (KBrainBackendConnection, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind stub");
        let base_url = format!("http://{}", listener.local_addr().expect("stub addr"));
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream
                .set_read_timeout(Some(Duration::from_millis(500)))
                .expect("read timeout");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => request.extend_from_slice(&chunk[..read]),
                }
                let text = String::from_utf8_lossy(&request);
                if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    if rest.len() >= length {
                        break;
                    }
                }
            }
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            String::from_utf8_lossy(&request).into_owned()
        });
        let connection = KBrainBackendConnection {
            base_url,
            token: TOKEN.into(),
            protocol_version: "web-search".into(),
            storage_id: "web-search".into(),
        };
        (connection, handle)
    }

    #[test]
    fn web_search_is_written_to_kbrain_settings_only() {
        let (connection, handle) = kbrain_stub("200 OK", "{}");
        let web_search = json!({ "provider": "tavily", "apiKey": "tvly-new" });
        assert_eq!(write_web_search(&connection, &web_search), Ok(()));
        let request = handle.join().expect("stub");
        assert!(request.starts_with("PUT /v1/settings "), "{request}");
        assert!(request.contains(&format!("Bearer {TOKEN}")));
        let body = request.split_once("\r\n\r\n").expect("body").1;
        assert_eq!(
            serde_json::from_str::<Value>(body).expect("json body"),
            json!({ "webSearch": web_search })
        );
    }

    #[test]
    fn rejected_web_search_reports_kbrain_reason_without_token_url_or_key() {
        let (connection, handle) = kbrain_stub(
            "400 Bad Request",
            r#"{"error":"webSearch.baseUrl must be an http or https URL"}"#,
        );
        let base_url = connection.base_url.clone();
        let error = write_web_search(
            &connection,
            &json!({ "baseUrl": "ftp://x", "apiKey": "tvly-secret" }),
        )
        .unwrap_err();
        handle.join().expect("stub");
        assert_eq!(
            error,
            "save web search failed: webSearch.baseUrl must be an http or https URL"
        );
        assert!(!error.contains(TOKEN) && !error.contains(&base_url));
        assert!(!error.contains("tvly-secret"));

        let (connection, handle) = kbrain_stub("500 Internal Server Error", "not json");
        let error = write_web_search(&connection, &json!({ "maxResults": 5 })).unwrap_err();
        handle.join().expect("stub");
        assert!(error.contains("500"), "{error}");
        assert!(!error.contains(TOKEN));
    }
}
