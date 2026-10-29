//! K-brain's AI approval reviewer over the desktop-owned Gateway. The WebUI reads and
//! writes it as `aiApproval`, like the memory switch: the value lives in K-brain's
//! `/v1/settings` and never in LiveAgent's own settings.

use reqwest::header::AUTHORIZATION;
use serde_json::{Map, Value};

use crate::services::kbrain_backend::KBrainBackendConnection;

pub(crate) const AI_APPROVAL_FIELD: &str = "aiApproval";

const MODES: [&str; 3] = ["off", "risk_only", "auto"];
const TEXT_FIELDS: [&str; 2] = ["provider", "model"];

/// The reviewer configuration from a K-brain settings document; None for a backend
/// without one, so the WebUI treats it as unknown rather than unconfigured.
pub(crate) fn approval_from_settings(settings: &Value) -> Option<Value> {
    let source = settings.get(AI_APPROVAL_FIELD)?.as_object()?;
    let mode = source.get("mode")?.as_str()?;
    if !MODES.contains(&mode) {
        return None;
    }
    let mut out = Map::new();
    out.insert("mode".into(), Value::String(mode.into()));
    for field in TEXT_FIELDS {
        if let Some(text) = source.get(field).and_then(Value::as_str) {
            if !text.is_empty() {
                out.insert(field.into(), Value::String(text.into()));
            }
        }
    }
    Some(Value::Object(out))
}

/// Removes `aiApproval` from a WebUI settings update and returns it for K-brain.
/// K-brain still validates the reviewer provider and model on write.
pub(crate) fn take_approval_update(update: &mut Value) -> Result<Option<Value>, String> {
    let Some(map) = update.as_object_mut() else {
        return Ok(None);
    };
    let Some(value) = map.remove(AI_APPROVAL_FIELD) else {
        return Ok(None);
    };
    let invalid = || "aiApproval must be an object with mode off, risk_only or auto".to_string();
    let source = value.as_object().ok_or_else(invalid)?;
    let mode = source.get("mode").and_then(Value::as_str).ok_or_else(invalid)?;
    if !MODES.contains(&mode) {
        return Err(invalid());
    }
    let mut out = Map::new();
    out.insert("mode".into(), Value::String(mode.into()));
    for field in TEXT_FIELDS {
        match source.get(field) {
            None | Some(Value::Null) => {}
            Some(Value::String(text)) => {
                out.insert(field.into(), Value::String(text.trim().into()));
            }
            Some(_) => return Err(format!("aiApproval.{field} must be a string")),
        }
    }
    Ok(Some(Value::Object(out)))
}

pub(crate) fn write_approval(
    connection: &KBrainBackendConnection,
    approval: &Value,
) -> Result<(), String> {
    let response = super::kbrain_memory::client()?
        .put(format!("{}/v1/settings", connection.base_url))
        .header(AUTHORIZATION, format!("Bearer {}", connection.token))
        .json(&serde_json::json!({ AI_APPROVAL_FIELD: approval }))
        .send()
        .map_err(|error| format!("save AI approval failed: {}", error.without_url()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    // K-brain explains a rejected reviewer (missing or inactive model) in its error
    // body; pass that on so the WebUI can show why the save failed.
    let reason = response
        .json::<Value>()
        .ok()
        .and_then(|body| body.get("error").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();
    Err(if reason.is_empty() {
        format!("save AI approval failed: HTTP {status}")
    } else {
        format!("save AI approval failed: {reason}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::time::Duration;

    #[test]
    fn approval_is_read_only_from_a_backend_that_reports_it() {
        assert_eq!(
            approval_from_settings(&json!({
                "aiApproval": { "mode": "auto", "provider": "deepseek", "model": "flash", "extra": 1 }
            })),
            Some(json!({ "mode": "auto", "provider": "deepseek", "model": "flash" }))
        );
        assert_eq!(
            approval_from_settings(&json!({ "aiApproval": { "mode": "off", "provider": "" } })),
            Some(json!({ "mode": "off" }))
        );
        assert_eq!(approval_from_settings(&json!({ "providers": [] })), None);
        assert_eq!(
            approval_from_settings(&json!({ "aiApproval": { "mode": "always" } })),
            None
        );
        assert_eq!(approval_from_settings(&json!({ "aiApproval": "auto" })), None);
    }

    #[test]
    fn approval_update_is_taken_out_of_the_liveagent_settings_update() {
        let mut update = json!({
            "aiApproval": { "mode": "risk_only", "provider": " deepseek ", "model": "flash" },
            "theme": "dark"
        });
        assert_eq!(
            take_approval_update(&mut update),
            Ok(Some(json!({ "mode": "risk_only", "provider": "deepseek", "model": "flash" })))
        );
        assert_eq!(update, json!({ "theme": "dark" }));

        let mut untouched = json!({ "theme": "dark" });
        assert_eq!(take_approval_update(&mut untouched), Ok(None));
        assert_eq!(untouched, json!({ "theme": "dark" }));

        for bad in [
            json!({ "aiApproval": null }),
            json!({ "aiApproval": {} }),
            json!({ "aiApproval": { "mode": "always" } }),
            json!({ "aiApproval": { "mode": "auto", "model": 1 } }),
        ] {
            let mut update = bad;
            assert!(take_approval_update(&mut update).is_err());
        }
    }

    const TOKEN: &str = "ai-approval-secret-token";

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
            protocol_version: "ai-approval".into(),
            storage_id: "ai-approval".into(),
        };
        (connection, handle)
    }

    #[test]
    fn approval_is_written_to_kbrain_settings_only() {
        let (connection, handle) = kbrain_stub("200 OK", "{}");
        let approval = json!({ "mode": "auto", "provider": "deepseek", "model": "flash" });
        assert_eq!(write_approval(&connection, &approval), Ok(()));
        let request = handle.join().expect("stub");
        assert!(request.starts_with("PUT /v1/settings "), "{request}");
        assert!(request.contains(&format!("Bearer {TOKEN}")));
        let body = request.split_once("\r\n\r\n").expect("body").1;
        assert_eq!(
            serde_json::from_str::<Value>(body).expect("json body"),
            json!({ "aiApproval": approval })
        );
    }

    #[test]
    fn rejected_reviewer_reports_kbrain_reason_without_token_or_url() {
        let (connection, handle) = kbrain_stub(
            "400 Bad Request",
            r#"{"error":"aiApproval reviewer model is not active for its provider"}"#,
        );
        let base_url = connection.base_url.clone();
        let error = write_approval(&connection, &json!({ "mode": "auto" })).unwrap_err();
        handle.join().expect("stub");
        assert_eq!(
            error,
            "save AI approval failed: aiApproval reviewer model is not active for its provider"
        );
        assert!(!error.contains(TOKEN) && !error.contains(&base_url));

        let (connection, handle) = kbrain_stub("500 Internal Server Error", "not json");
        let error = write_approval(&connection, &json!({ "mode": "off" })).unwrap_err();
        handle.join().expect("stub");
        assert!(error.contains("500"), "{error}");
        assert!(!error.contains(TOKEN));
    }
}
