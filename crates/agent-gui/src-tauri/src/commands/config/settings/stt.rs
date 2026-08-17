const STT_CONFIG_ID: &str = "default";
const VOLCENGINE_SEED_V3_ENDPOINT: &str =
    "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const STT_SECRET_FIELDS: &[&str] = &[
    "apiKey",
    "secretId",
    "secretKey",
    "accessToken",
    "baiduApiKey",
];

fn provider_configured(provider_id: Option<&str>, provider: &Map<String, Value>) -> bool {
    validate_provider(provider_id.unwrap_or_default(), provider).is_ok()
}

fn provider_text<'a>(provider: &'a Map<String, Value>, field: &str) -> &'a str {
    provider
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
}

fn require_provider_text<'a>(
    provider: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<&'a str, String> {
    let value = provider_text(provider, field);
    if value.is_empty() {
        Err(format!("{label} 不能为空"))
    } else {
        Ok(value)
    }
}

fn validate_websocket_url(provider: &Map<String, Value>) -> Result<(), String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let endpoint = require_provider_text(provider, "websocketUrl", "WebSocket 地址")?;
    let request = endpoint
        .into_client_request()
        .map_err(|_| "WebSocket 地址必须是完整的 wss:// 地址".to_string())?;
    let has_user_info = request
        .uri()
        .authority()
        .is_some_and(|authority| authority.as_str().contains('@'));
    if request.uri().scheme_str() != Some("wss")
        || request.uri().host().is_none()
        || has_user_info
    {
        return Err("WebSocket 地址必须是完整的 wss:// 地址".to_string());
    }
    Ok(())
}

fn require_positive_integer(
    provider: &Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<(), String> {
    let value = require_provider_text(provider, field, label)?;
    if value.parse::<u64>().is_ok_and(|value| value > 0) {
        Ok(())
    } else {
        Err(format!("{label} 必须是大于 0 的数字"))
    }
}

fn validate_provider(provider_id: &str, provider: &Map<String, Value>) -> Result<(), String> {
    match provider_id {
        "aliyun_dashscope" => {
            validate_websocket_url(provider)?;
            require_provider_text(provider, "model", "模型名称")?;
            require_provider_text(provider, "apiKey", "API Key")?;
        }
        "tencent_cloud" => {
            require_positive_integer(provider, "appId", "腾讯 AppId")?;
            require_provider_text(provider, "engineModelType", "腾讯引擎模型")?;
            require_provider_text(provider, "secretId", "腾讯 SecretId")?;
            require_provider_text(provider, "secretKey", "腾讯 SecretKey")?;
        }
        "volcengine_v2" => {
            validate_websocket_url(provider)?;
            require_provider_text(provider, "appId", "火山 v2 App ID")?;
            require_provider_text(provider, "cluster", "火山 v2 Cluster")?;
            require_provider_text(provider, "accessToken", "火山 v2 Access Token")?;
        }
        "volcengine_seed_v3" => {
            validate_websocket_url(provider)?;
            require_provider_text(provider, "appId", "火山 Seed v3 App ID")?;
            require_provider_text(provider, "accessToken", "火山 Seed v3 Access Token")?;
            require_provider_text(provider, "resourceId", "火山 Seed v3 Resource ID")?;
        }
        "baidu_cloud" => {
            validate_websocket_url(provider)?;
            require_positive_integer(provider, "baiduAppId", "百度 App ID")?;
            require_positive_integer(provider, "devPid", "百度 dev_pid")?;
            require_provider_text(provider, "baiduApiKey", "百度 API Key")?;
        }
        _ => return Err("未知 STT 供应商".to_string()),
    }
    Ok(())
}

pub(crate) fn load_stt_raw(conn: &Connection) -> Result<Option<Value>, String> {
    let payload: Option<String> = conn
        .query_row(
            &format!("SELECT payload_json FROM {STT_SETTINGS_TABLE} WHERE config_id = ?1"),
            params![STT_CONFIG_ID],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("load STT settings failed: {error}"))?;
    payload
        .map(|raw| {
            serde_json::from_str(&raw)
                .map_err(|error| format!("decode STT settings failed: {error}"))
        })
        .transpose()
}

pub(crate) fn redact_stt_secrets(value: &mut Value) {
    let Some(providers) = value.get_mut("providers").and_then(Value::as_object_mut) else {
        return;
    };
    for provider in providers.values_mut().filter_map(Value::as_object_mut) {
        let provider_id = provider.get("id").and_then(Value::as_str);
        let configured = provider_configured(provider_id, provider);
        for field in STT_SECRET_FIELDS {
            if provider.contains_key(*field) {
                provider.insert((*field).to_string(), Value::String(String::new()));
            }
        }
        provider.insert("configured".to_string(), Value::Bool(configured));
        provider.remove("clearSecrets");
    }
}

pub(crate) fn load_stt_redacted(conn: &Connection) -> Result<Option<Value>, String> {
    let mut value = load_stt_raw(conn)?;
    if let Some(payload) = value.as_mut() {
        redact_stt_secrets(payload);
    }
    Ok(value)
}

pub(crate) fn load_stt_secret(
    conn: &Connection,
    provider_id: &str,
    field: &str,
) -> Result<String, String> {
    let provider_id = provider_id.trim();
    let field = field.trim();
    if !STT_SECRET_FIELDS.contains(&field) {
        return Err("不允许查看该 STT 字段".to_string());
    }
    let payload = load_stt_raw(conn)?.ok_or_else(|| "STT 尚未配置".to_string())?;
    let provider = payload
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|providers| providers.get(provider_id))
        .and_then(Value::as_object)
        .ok_or_else(|| "STT 供应商配置不存在".to_string())?;
    Ok(provider_text(provider, field).to_string())
}

pub(crate) fn load_stt_provider_runtime(provider_id: &str) -> Result<Map<String, Value>, String> {
    let conn = open_db()?;
    let payload = load_stt_raw(&conn)?.ok_or_else(|| "STT 尚未配置".to_string())?;
    let mut provider = payload
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|providers| providers.get(provider_id))
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| "STT 供应商配置不存在".to_string())?;
    if provider_id == "volcengine_seed_v3" && provider_text(&provider, "websocketUrl").is_empty() {
        provider.insert(
            "websocketUrl".to_string(),
            Value::String(VOLCENGINE_SEED_V3_ENDPOINT.to_string()),
        );
    }
    if !provider_configured(Some(provider_id), &provider) {
        return Err("STT 供应商配置不完整".to_string());
    }
    Ok(provider)
}

pub(crate) fn save_stt(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let mut next = expect_object(payload, "settings_save_stt payload")?;
    let selected_provider = next
        .get("provider")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut current = load_stt_raw(conn)?
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let current_providers = current
        .remove("providers")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let Some(next_providers) = next.get_mut("providers").and_then(Value::as_object_mut) else {
        return Err("settings_save_stt payload.providers must be an object".to_string());
    };
    let mut selected_secrets_cleared = false;
    for (provider_id, provider_value) in next_providers.iter_mut() {
        let Some(provider) = provider_value.as_object_mut() else {
            return Err(format!("STT provider {provider_id} must be an object"));
        };
        let old = current_providers
            .get(provider_id)
            .and_then(Value::as_object);
        let clear = provider
            .remove("clearSecrets")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if selected_provider.as_deref() == Some(provider_id) {
            selected_secrets_cleared = clear;
        }
        provider.remove("configured");
        for field in STT_SECRET_FIELDS {
            let incoming = provider
                .get(*field)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if clear {
                provider.insert((*field).to_string(), Value::String(String::new()));
            } else if incoming.is_empty() {
                if let Some(existing) = old.and_then(|item| item.get(*field)).cloned() {
                    provider.insert((*field).to_string(), existing);
                }
            } else {
                provider.insert((*field).to_string(), Value::String(incoming));
            }
        }
    }
    if let Some(provider_id) = selected_provider.as_deref() {
        if !selected_secrets_cleared {
            let provider = next_providers
                .get(provider_id)
                .and_then(Value::as_object)
                .ok_or_else(|| "当前 STT 供应商配置不存在".to_string())?;
            validate_provider(provider_id, provider)?;
        }
    }
    let payload_json = serde_json::to_string(&Value::Object(next))
        .map_err(|error| format!("encode STT settings failed: {error}"))?;
    conn.execute(
        &format!(
            "INSERT INTO {STT_SETTINGS_TABLE} (config_id, payload_json, updated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(config_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at"
        ),
        params![STT_CONFIG_ID, payload_json, now_ms()],
    )
    .map_err(|error| format!("save STT settings failed: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod stt_tests {
    use super::*;
    use serde_json::json;

    fn provider(id: &str) -> Map<String, Value> {
        let mut value = Map::new();
        value.insert("id".into(), Value::String(id.into()));
        value
    }

    #[test]
    fn provider_validation_requires_each_secret_and_numeric_baidu_ids() {
        let mut aliyun = provider("aliyun_dashscope");
        aliyun.insert("websocketUrl".into(), json!("wss://example.com/stt"));
        aliyun.insert("model".into(), json!("model"));
        aliyun.insert("apiKey".into(), json!("key"));
        assert!(provider_configured(Some("aliyun_dashscope"), &aliyun));

        let mut tencent = provider("tencent_cloud");
        for (key, value) in [
            ("appId", "1"),
            ("secretId", "id"),
            ("secretKey", "key"),
            ("engineModelType", "16k_zh"),
        ] {
            tencent.insert(key.into(), json!(value));
        }
        assert!(provider_configured(Some("tencent_cloud"), &tencent));
        tencent.insert("appId".into(), json!("not-numeric"));
        assert!(!provider_configured(Some("tencent_cloud"), &tencent));
        tencent.insert("appId".into(), json!("1"));
        tencent.remove("secretKey");
        assert!(!provider_configured(Some("tencent_cloud"), &tencent));

        let mut v2 = provider("volcengine_v2");
        v2.insert("websocketUrl".into(), json!("wss://example.com/stt"));
        for (key, value) in [("appId", "app"), ("accessToken", "token"), ("cluster", "router")] {
            v2.insert(key.into(), json!(value));
        }
        assert!(provider_configured(Some("volcengine_v2"), &v2));

        let mut v3 = provider("volcengine_seed_v3");
        v3.insert("websocketUrl".into(), json!(VOLCENGINE_SEED_V3_ENDPOINT));
        for (key, value) in [("appId", "app"), ("accessToken", "token"), ("resourceId", "resource")] {
            v3.insert(key.into(), json!(value));
        }
        assert!(provider_configured(Some("volcengine_seed_v3"), &v3));

        let mut baidu = provider("baidu_cloud");
        baidu.insert("websocketUrl".into(), json!("wss://example.com/stt"));
        baidu.insert("baiduAppId".into(), json!("123"));
        baidu.insert("baiduApiKey".into(), json!("key"));
        baidu.insert("devPid".into(), json!("1537"));
        assert!(provider_configured(Some("baidu_cloud"), &baidu));
        baidu.insert("devPid".into(), json!("model-name"));
        assert!(!provider_configured(Some("baidu_cloud"), &baidu));

        aliyun.insert("websocketUrl".into(), json!("https://example.com/stt"));
        assert!(!provider_configured(Some("aliyun_dashscope"), &aliyun));
        v3.insert("websocketUrl".into(), json!("wss://user@example.com/stt"));
        assert!(!provider_configured(Some("volcengine_seed_v3"), &v3));
    }

    #[test]
    fn redaction_marks_configured_without_exposing_secrets() {
        let mut payload = json!({
            "providers": {
                "aliyun_dashscope": {
                    "id": "aliyun_dashscope",
                    "websocketUrl": "wss://example.com/stt",
                    "model": "model",
                    "apiKey": "secret",
                    "clearSecrets": true
                }
            }
        });
        redact_stt_secrets(&mut payload);
        let provider = &payload["providers"]["aliyun_dashscope"];
        assert_eq!(provider["apiKey"], "");
        assert_eq!(provider["configured"], true);
        assert!(provider.get("clearSecrets").is_none());
        assert!(!payload.to_string().contains("secret"));
    }

    #[test]
    fn error_sanitization_replaces_all_supported_credentials() {
        let config = serde_json::from_value(json!({
            "apiKey": "dash-secret",
            "secretId": "tencent-id",
            "secretKey": "tencent-secret",
            "accessToken": "volc-token",
            "baiduApiKey": "baidu-secret"
        }))
        .expect("map");
        let sanitized = crate::services::stt::sanitize_error(
            "dash-secret/tencent-id/tencent-secret/volc-token/baidu-secret",
            &config,
        );
        assert!(!sanitized.contains("dash-secret"));
        assert!(!sanitized.contains("tencent-secret"));
        assert_eq!(sanitized.matches("[redacted]").count(), 5);
    }

    #[test]
    fn save_rejects_invalid_selected_provider_but_allows_explicit_clear() {
        let mut conn = Connection::open_in_memory().expect("in-memory STT database");
        conn.execute_batch(
            "CREATE TABLE stt_settings (
                config_id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .expect("create STT settings table");

        let invalid = json!({
            "provider": "tencent_cloud",
            "providers": {
                "tencent_cloud": {
                    "id": "tencent_cloud",
                    "appId": "not-numeric",
                    "engineModelType": "16k_zh",
                    "secretId": "id",
                    "secretKey": "key"
                }
            }
        });
        let error = save_stt(&mut conn, invalid).expect_err("invalid Tencent AppId must fail");
        assert!(error.contains("大于 0 的数字"));

        let clear = json!({
            "provider": "tencent_cloud",
            "providers": {
                "tencent_cloud": {
                    "id": "tencent_cloud",
                    "clearSecrets": true
                }
            }
        });
        save_stt(&mut conn, clear).expect("explicit secret clearing must remain valid");
        assert!(load_stt_raw(&conn).expect("load cleared settings").is_some());
    }
}
