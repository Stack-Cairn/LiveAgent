//! 把 LiveAgent 的自定义 provider 配置渲染成 pi 的 models.json。
//!
//! 一份 models.json 只含**一个** provider：pi 进程按会话隔离的 agent dir
//! （`PI_CODING_AGENT_DIR`）启动，切 provider 就重写文件、重启进程。
//! provider key 直接用 LiveAgent 的 customProviderId，`set_model` 因此
//! 一次命中，不需要任何按模型名反查 provider 的猜测逻辑。

use serde_json::{json, Map, Value};

/// 从 provider_settings 的 payload 渲染 models.json 内容（紧凑 JSON 字符串）。
///
/// `selected_model_id` 保证出现在模型表里：用户点得到的模型必须切得过去，
/// 即使设置页的 activeModels 还没来得及包含它。
pub fn build_models_json(
    provider_id: &str,
    provider: &Value,
    selected_model_id: &str,
) -> Result<String, String> {
    let payload = provider
        .as_object()
        .ok_or_else(|| "供应商配置不是 JSON 对象".to_string())?;

    let provider_type = required_str(payload, "type")?;
    let api = match (provider_type, optional_str(payload, "requestFormat")) {
        ("claude_code", _) => "anthropic-messages",
        ("gemini", _) => "google-generative-ai",
        ("codex", Some("openai-completions")) => "openai-completions",
        ("codex", _) => "openai-responses",
        ("xai", _) => "openai-completions",
        (other, _) => return Err(format!("不支持的供应商类型：{other}")),
    };

    let base_url = required_str(payload, "baseUrl")?
        .trim()
        .trim_end_matches('/')
        .to_string();
    if base_url.is_empty() {
        return Err("供应商缺少 Base URL".to_string());
    }

    let mut entry = Map::new();
    if let Some(name) = optional_str(payload, "name").map(str::trim).filter(|n| !n.is_empty()) {
        entry.insert("name".to_string(), Value::String(name.to_string()));
    }
    entry.insert("baseUrl".to_string(), Value::String(base_url));
    entry.insert("api".to_string(), Value::String(api.to_string()));
    if let Some(key) = optional_str(payload, "apiKey").map(str::trim).filter(|k| !k.is_empty()) {
        entry.insert("apiKey".to_string(), Value::String(key.to_string()));
    }
    if let Some(headers) = custom_headers(payload) {
        entry.insert("headers".to_string(), headers);
    }
    entry.insert(
        "models".to_string(),
        Value::Array(model_entries(payload, selected_model_id)),
    );

    Ok(json!({ "providers": { provider_id: entry } }).to_string())
}

/// 模型表：activeModels 非空则按它过滤，空则全收；所选模型缺席时补一条
/// 只有 id 的最小条目（context/maxTokens 走 pi 的缺省）。
fn model_entries(payload: &Map<String, Value>, selected_model_id: &str) -> Vec<Value> {
    let active: Vec<&str> = payload
        .get("activeModels")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    let mut entries = Vec::new();
    let mut has_selected = false;
    for model in payload
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = model.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if id.is_empty() || (!active.is_empty() && !active.contains(&id)) {
            continue;
        }
        has_selected |= id == selected_model_id;

        let mut entry = Map::new();
        entry.insert("id".to_string(), Value::String(id.to_string()));
        if let Some(window) = positive_number(model.get("contextWindow")) {
            entry.insert("contextWindow".to_string(), window);
        }
        if let Some(max) = positive_number(model.get("maxOutputToken")) {
            entry.insert("maxTokens".to_string(), max);
        }
        entries.push(Value::Object(entry));
    }

    if !has_selected && !selected_model_id.trim().is_empty() {
        entries.push(json!({ "id": selected_model_id }));
    }
    entries
}

fn custom_headers(payload: &Map<String, Value>) -> Option<Value> {
    let items = payload.get("customHeaders")?.as_array()?;
    let mut headers = Map::new();
    for item in items {
        let key = item.get("key").and_then(Value::as_str).map(str::trim);
        let value = item.get("value").and_then(Value::as_str);
        if let (Some(key), Some(value)) = (key, value) {
            if !key.is_empty() {
                headers.insert(key.to_string(), Value::String(value.to_string()));
            }
        }
    }
    (!headers.is_empty()).then_some(Value::Object(headers))
}

fn required_str<'a>(payload: &'a Map<String, Value>, field: &str) -> Result<&'a str, String> {
    optional_str(payload, field).ok_or_else(|| format!("供应商配置缺少 {field}"))
}

fn optional_str<'a>(payload: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    payload.get(field).and_then(Value::as_str)
}

fn positive_number(value: Option<&Value>) -> Option<Value> {
    let number = value?.as_f64()?;
    (number > 0.0 && number.is_finite()).then(|| json!(number as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(extra: Value) -> Value {
        let mut base = json!({
            "type": "claude_code",
            "name": "My Claude",
            "baseUrl": "https://relay.example.com/",
            "apiKey": "sk-test",
            "models": [
                { "id": "claude-fable-5", "contextWindow": 1000000, "maxOutputToken": 128000 },
                { "id": "claude-haiku-4-5", "contextWindow": 200000, "maxOutputToken": 64000 }
            ],
            "activeModels": ["claude-fable-5"]
        });
        if let (Some(target), Some(source)) = (base.as_object_mut(), extra.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        base
    }

    fn parse(result: Result<String, String>) -> Value {
        serde_json::from_str(&result.expect("models.json")).expect("valid json")
    }

    #[test]
    fn renders_a_single_provider_keyed_by_custom_provider_id() {
        let rendered = parse(build_models_json("my-claude", &provider(json!({})), "claude-fable-5"));
        let entry = &rendered["providers"]["my-claude"];
        assert_eq!(rendered["providers"].as_object().unwrap().len(), 1);
        assert_eq!(entry["api"], "anthropic-messages");
        assert_eq!(entry["baseUrl"], "https://relay.example.com");
        assert_eq!(entry["apiKey"], "sk-test");
        assert_eq!(entry["name"], "My Claude");
        // activeModels 过滤掉了未激活的 haiku。
        let models = entry["models"].as_array().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["id"], "claude-fable-5");
        assert_eq!(models[0]["contextWindow"], 1000000);
        assert_eq!(models[0]["maxTokens"], 128000);
    }

    #[test]
    fn the_selected_model_is_always_present() {
        let rendered = parse(build_models_json("p", &provider(json!({})), "claude-sonnet-5"));
        let models = rendered["providers"]["p"]["models"].as_array().unwrap();
        assert!(models.iter().any(|m| m["id"] == "claude-sonnet-5"));
    }

    #[test]
    fn empty_active_models_means_every_model() {
        let rendered = parse(build_models_json(
            "p",
            &provider(json!({ "activeModels": [] })),
            "claude-fable-5",
        ));
        assert_eq!(rendered["providers"]["p"]["models"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn api_follows_provider_type_and_codex_request_format() {
        for (extra, expected) in [
            (json!({ "type": "gemini" }), "google-generative-ai"),
            (json!({ "type": "xai" }), "openai-completions"),
            (json!({ "type": "codex" }), "openai-responses"),
            (
                json!({ "type": "codex", "requestFormat": "openai-completions" }),
                "openai-completions",
            ),
        ] {
            let rendered = parse(build_models_json("p", &provider(extra), "m"));
            assert_eq!(rendered["providers"]["p"]["api"], expected);
        }
    }

    #[test]
    fn custom_headers_and_blank_api_key_are_handled() {
        let rendered = parse(build_models_json(
            "p",
            &provider(json!({
                "apiKey": "  ",
                "customHeaders": [
                    { "key": "x-custom", "value": "1" },
                    { "key": "", "value": "dropped" }
                ]
            })),
            "claude-fable-5",
        ));
        let entry = &rendered["providers"]["p"];
        assert!(entry.get("apiKey").is_none());
        assert_eq!(entry["headers"], json!({ "x-custom": "1" }));
    }

    #[test]
    fn unknown_provider_type_or_missing_base_url_is_rejected() {
        assert!(build_models_json("p", &provider(json!({ "type": "nope" })), "m").is_err());
        assert!(build_models_json("p", &provider(json!({ "baseUrl": "  " })), "m").is_err());
        assert!(build_models_json("p", &json!("not-an-object"), "m").is_err());
    }
}
