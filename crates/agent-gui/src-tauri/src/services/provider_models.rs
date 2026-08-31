use std::{future::Future, time::Duration};

use futures_util::StreamExt;
use reqwest::{Client, StatusCode, Url};
use serde_json::Value;

const ANTHROPIC_API_VERSION: &str = "2023-06-01";
const MAX_PROVIDER_MODELS_RESPONSE_BYTES: usize = 2 << 20;
const PROVIDER_MODELS_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const PROVIDER_MODELS_TIMEOUT_MESSAGE: &str = "供应商模型列表请求超时（10 秒）";
const CODEX_MODELS_SUFFIXES: [&str; 3] = ["/chat/completions", "/responses", "/response"];

#[derive(Clone, Debug)]
struct ProviderModelsAttempt {
    url: Url,
    headers: Vec<(String, String)>,
}

#[derive(Debug)]
struct ProviderModelsFailure {
    status: Option<StatusCode>,
    message: String,
}

pub async fn fetch_provider_models(
    provider_type: &str,
    base_url: &str,
    api_key: &str,
    use_system_proxy: bool,
    models_url: Option<&str>,
    is_full_url: bool,
    custom_headers: &[(String, String)],
) -> Result<String, String> {
    // 与本地反代的 x-liveagent-use-system-proxy 语义一致：勾选时代理配置异常
    // fail fast，绝不静默降级；未勾选一律直连（忽略环境代理）。
    let client = if use_system_proxy {
        crate::services::system_proxy::cached_client()
            .map_err(|error| format!("App proxy unavailable: {error}"))?
    } else {
        direct_client()?
    };
    with_provider_models_timeout(
        PROVIDER_MODELS_REQUEST_TIMEOUT,
        fetch_provider_models_with_client(
            &client,
            provider_type,
            base_url,
            api_key,
            models_url,
            is_full_url,
            custom_headers,
        ),
    )
    .await
}

fn direct_client() -> Result<Client, String> {
    static CLIENT: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = Client::builder()
        .no_proxy()
        .build()
        .map_err(|_| "创建直连 HTTP 客户端失败".to_string())?;
    Ok(CLIENT.get_or_init(|| client).clone())
}

async fn fetch_provider_models_with_client(
    client: &Client,
    provider_type: &str,
    base_url: &str,
    api_key: &str,
    models_url: Option<&str>,
    is_full_url: bool,
    custom_headers: &[(String, String)],
) -> Result<String, String> {
    let attempts = build_provider_models_attempts_with_override(
        provider_type,
        base_url,
        api_key,
        models_url,
        is_full_url,
        custom_headers,
    )?;
    let mut failures = Vec::new();
    let mut empty_result = None;

    for attempt in attempts {
        let mut request = client.get(attempt.url);
        for (name, value) in attempt.headers {
            request = request.header(name, value);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(_) => {
                failures.push(ProviderModelsFailure {
                    status: None,
                    message: "无法通过桌面端代理请求供应商模型列表".to_string(),
                });
                continue;
            }
        };
        let status = response.status();
        let body = match read_limited_response(response).await {
            Ok(body) => body,
            Err(message) => {
                failures.push(ProviderModelsFailure {
                    status: Some(status),
                    message,
                });
                continue;
            }
        };
        if !status.is_success() {
            failures.push(ProviderModelsFailure {
                status: Some(status),
                message: extract_provider_models_error(&body, status),
            });
            continue;
        }
        let payload = match serde_json::from_slice::<Value>(&body) {
            Ok(payload) => payload,
            Err(_) => {
                failures.push(ProviderModelsFailure {
                    status: Some(status),
                    message: "供应商模型列表响应不是有效 JSON".to_string(),
                });
                continue;
            }
        };
        let serialized = serde_json::to_string(&payload)
            .map_err(|error| format!("序列化供应商模型列表失败：{error}"))?;
        if provider_models_payload_has_entries(&payload) {
            return Ok(serialized);
        }
        empty_result = Some(serialized);
    }

    if let Some(result) = empty_result {
        return Ok(result);
    }
    Err(pick_provider_models_failure(failures))
}

async fn with_provider_models_timeout(
    timeout: Duration,
    request: impl Future<Output = Result<String, String>>,
) -> Result<String, String> {
    tokio::time::timeout(timeout, request)
        .await
        .map_err(|_| PROVIDER_MODELS_TIMEOUT_MESSAGE.to_string())?
}

async fn read_limited_response(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_MODELS_RESPONSE_BYTES as u64)
    {
        return Err("供应商模型列表响应过大".to_string());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "读取供应商模型列表响应失败".to_string())?;
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_MODELS_RESPONSE_BYTES {
            return Err("供应商模型列表响应过大".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn parse_http_url(raw: &str, label: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| format!("{label} 必须是绝对 URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(format!("{label} 必须是有效的 HTTP(S) 绝对 URL"));
    }
    Ok(url)
}

fn normalize_provider_base_url(provider_type: &str, raw: &str) -> Result<Url, String> {
    validate_provider_type(provider_type)?;
    let mut url = parse_http_url(raw, "Base URL")?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Base URL 不能包含查询参数或片段".to_string());
    }

    let mut path = url.path().trim_end_matches('/').to_string();
    if matches!(provider_type, "codex" | "xai" | "deepseek") {
        let lower = path.to_ascii_lowercase();
        if let Some(suffix) = CODEX_MODELS_SUFFIXES
            .iter()
            .find(|suffix| lower.ends_with(**suffix))
        {
            path.truncate(path.len() - suffix.len());
        }
    } else if provider_type == "gemini" {
        let lower = path.to_ascii_lowercase();
        if let Some(suffix) = [":streamgeneratecontent", ":generatecontent"]
            .iter()
            .find(|suffix| lower.ends_with(**suffix))
        {
            path.truncate(path.len() - suffix.len());
        }
        if let Some(models_index) = path.to_ascii_lowercase().rfind("/models") {
            let after_models = &path[models_index + "/models".len()..];
            if after_models.is_empty() || after_models.starts_with('/') {
                path.truncate(models_index);
            }
        }
    }
    url.set_path(if path.is_empty() { "/" } else { &path });
    Ok(url)
}

fn validate_provider_type(provider_type: &str) -> Result<(), String> {
    if matches!(
        provider_type,
        "claude_code" | "codex" | "gemini" | "xai" | "deepseek"
    ) {
        Ok(())
    } else {
        Err("不支持的供应商类型".to_string())
    }
}

fn normalize_provider_models_url(raw: &str) -> Result<Url, String> {
    let url = parse_http_url(raw, "模型列表 URL")?;
    if url.fragment().is_some() {
        return Err("模型列表 URL 不能包含片段".to_string());
    }
    Ok(url)
}

fn build_provider_models_url(provider_type: &str, base_url: &Url, official: bool) -> Url {
    let mut url = base_url.clone();
    let mut api_root = url.path().trim_end_matches('/').to_string();
    if api_root.to_ascii_lowercase().ends_with("/models") {
        api_root.truncate(api_root.len() - "/models".len());
    }
    if is_api_version_path(&api_root) {
        api_root.truncate(api_root.rfind('/').unwrap_or(0));
    }
    let version_path = if official && provider_type == "gemini" {
        "v1beta"
    } else {
        "v1"
    };
    let next_path = format!("{api_root}/{version_path}/models");
    url.set_path(&next_path);
    url
}

fn is_api_version_path(path: &str) -> bool {
    let lower = path
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let Some(version) = lower.strip_prefix('v') else {
        return false;
    };
    let digits = version.strip_suffix("beta").unwrap_or(version);
    !digits.is_empty() && digits.chars().all(|character| character.is_ascii_digit())
}

#[cfg(test)]
fn build_provider_models_attempts(
    provider_type: &str,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<ProviderModelsAttempt>, String> {
    build_provider_models_attempts_with_override(provider_type, base_url, api_key, None, false, &[])
}

fn build_provider_models_attempts_with_override(
    provider_type: &str,
    base_url: &str,
    api_key: &str,
    models_url: Option<&str>,
    is_full_url: bool,
    custom_headers: &[(String, String)],
) -> Result<Vec<ProviderModelsAttempt>, String> {
    validate_provider_type(provider_type)?;
    let explicit_url = if provider_type == "gemini" {
        None
    } else {
        models_url
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(normalize_provider_models_url)
            .transpose()?
    };
    let base_url = match explicit_url.as_ref() {
        Some(url) => url.clone(),
        None if is_full_url => normalize_provider_full_url(base_url)?,
        None => normalize_provider_base_url(provider_type, base_url)?,
    };
    let [default_attempt, official_attempt] = [false, true].map(|official| ProviderModelsAttempt {
        url: explicit_url
            .as_ref()
            .cloned()
            .unwrap_or_else(|| build_provider_models_url(provider_type, &base_url, official)),
        headers: merge_custom_headers(
            build_provider_models_headers(provider_type, api_key, official),
            custom_headers,
        ),
    });
    // codex/xai/deepseek 的官方形式与统一首次尝试完全一致，重复请求同一端点没有意义，收敛为一次。
    let mut attempts = vec![default_attempt];
    if official_attempt.url != attempts[0].url || official_attempt.headers != attempts[0].headers {
        attempts.push(official_attempt);
    }
    Ok(attempts)
}

// 完整端点模式：从聊天端点推导 models API 根。与前端
// deriveModelsBaseUrlFromFullUrl 逻辑一致（优先截到 /v1/，否则去掉末段）。
fn normalize_provider_full_url(raw: &str) -> Result<Url, String> {
    let mut url = parse_http_url(raw, "Base URL")?;
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/').to_string();
    let lower = path.to_ascii_lowercase();
    let derived_path = if let Some(version_index) = lower.find("/v1/") {
        path[..version_index + "/v1".len()].to_string()
    } else if let Some(separator_index) = path.rfind('/') {
        if separator_index > 0 {
            path[..separator_index].to_string()
        } else {
            "/".to_string()
        }
    } else {
        "/".to_string()
    };
    url.set_path(&derived_path);
    Ok(url)
}

// 首次尝试统一 /v1/models + authorization Bearer；失败后回退到各家官方形式
// （gemini v1beta + x-goog-api-key、claude_code x-api-key）。每次请求仍只带单一鉴权头。
fn build_provider_models_headers(
    provider_type: &str,
    api_key: &str,
    official: bool,
) -> Vec<(&'static str, String)> {
    let mut headers = vec![("content-type", "application/json".to_string())];
    if !official {
        headers.push(("authorization", format!("Bearer {api_key}")));
        return headers;
    }
    match provider_type {
        "gemini" => {
            headers.push(("x-goog-api-key", api_key.to_string()));
        }
        "claude_code" => {
            headers.push(("x-api-key", api_key.to_string()));
            headers.push(("anthropic-version", ANTHROPIC_API_VERSION.to_string()));
        }
        _ => {
            headers.push(("authorization", format!("Bearer {api_key}")));
        }
    }
    headers
}

// KEEP IN SYNC: crates/agent-ui/src/lib/providers/customHeaders.ts 的
// RESERVED_CUSTOM_HEADER_KEYS / RESERVED_CUSTOM_HEADER_KEY_PREFIX。鉴权头与
// host/content-length 属保留头：用户改不了，自定义头也不得顶掉它们。
const RESERVED_CUSTOM_HEADER_KEYS: [&str; 6] = [
    "authorization",
    "x-api-key",
    "x-goog-api-key",
    "anthropic-beta",
    "host",
    "content-length",
];
const RESERVED_CUSTOM_HEADER_KEY_PREFIX: &str = "x-liveagent-";

fn is_valid_custom_header_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || "!#$%&'*+-.^_`|~".contains(character)
        })
}

// 取值只允许可见 ASCII 与水平制表符：CR/LF 会造成 header 注入。
fn is_valid_custom_header_value(value: &str) -> bool {
    value
        .chars()
        .all(|character| character == '\t' || ('\x20'..='\x7e').contains(&character))
}

fn is_reserved_custom_header_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    RESERVED_CUSTOM_HEADER_KEYS.contains(&normalized.as_str())
        || normalized.starts_with(RESERVED_CUSTOM_HEADER_KEY_PREFIX)
}

/// 把用户显式配置的自定义请求头并入自动装配的头集合。非法键名/取值与保留头
/// 直接丢弃（与前端 mergeCustomHeaders 同语义），同名头大小写不敏感地覆盖。
fn merge_custom_headers(
    base: Vec<(&'static str, String)>,
    custom_headers: &[(String, String)],
) -> Vec<(String, String)> {
    let mut merged: Vec<(String, String)> = base
        .into_iter()
        .map(|(name, value)| (name.to_string(), value))
        .collect();

    for (key, value) in custom_headers {
        if !is_valid_custom_header_key(key)
            || !is_valid_custom_header_value(value)
            || is_reserved_custom_header_key(key)
        {
            continue;
        }
        let normalized = key.to_ascii_lowercase();
        merged.retain(|(name, _)| name.to_ascii_lowercase() != normalized);
        merged.push((key.clone(), value.clone()));
    }

    merged
}

fn provider_models_payload_has_entries(payload: &Value) -> bool {
    match payload {
        Value::Array(items) => !items.is_empty(),
        Value::Object(object) => ["data", "models"].iter().any(|key| {
            object
                .get(*key)
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
        }),
        _ => false,
    }
}

fn extract_provider_models_error(body: &[u8], status: StatusCode) -> String {
    if let Ok(Value::Object(payload)) = serde_json::from_slice::<Value>(body) {
        for key in ["error", "message"] {
            if let Some(message) = payload.get(key).and_then(Value::as_str) {
                let message = message.trim();
                if !message.is_empty() {
                    return message.to_string();
                }
            }
        }
    }
    let raw = String::from_utf8_lossy(body);
    let raw = raw.trim();
    if raw.is_empty() {
        format!("供应商模型列表请求返回 HTTP {status}")
    } else {
        raw.chars().take(2048).collect()
    }
}

fn pick_provider_models_failure(failures: Vec<ProviderModelsFailure>) -> String {
    failures
        .iter()
        .rev()
        .find(|failure| {
            !matches!(
                failure.status,
                Some(StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED)
            )
        })
        .or_else(|| failures.last())
        .map(|failure| failure.message.clone())
        .unwrap_or_else(|| "请求供应商模型列表失败".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn provider_model_urls_match_frontend_contract() {
        let gemini = build_provider_models_attempts(
            "gemini",
            "https://relay.example.com/v1beta/models/gemini-pro:generateContent",
            "key",
        )
        .expect("gemini attempts");
        assert_eq!(gemini.len(), 2);
        assert_eq!(
            gemini[0].url.as_str(),
            "https://relay.example.com/v1/models"
        );
        assert_eq!(
            gemini[1].url.as_str(),
            "https://relay.example.com/v1beta/models"
        );

        // claude_code URL 不随 official 变化，但官方鉴权头不同，保留重试。
        let claude =
            build_provider_models_attempts("claude_code", "https://relay.example.com", "key")
                .expect("claude attempts");
        assert_eq!(claude.len(), 2);
        assert_eq!(claude[0].url, claude[1].url);

        // codex/xai/deepseek 官方形式与统一首次尝试完全一致，收敛为一次请求。
        let codex = build_provider_models_attempts(
            "codex",
            "https://relay.example.com/v1/responses",
            "key",
        )
        .expect("codex attempts");
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].url.as_str(), "https://relay.example.com/v1/models");

        let deepseek = build_provider_models_attempts(
            "deepseek",
            "https://api.deepseek.com/v1/chat/completions",
            "key",
        )
        .expect("deepseek attempts");
        assert_eq!(deepseek.len(), 1);
        assert_eq!(
            deepseek[0].url.as_str(),
            "https://api.deepseek.com/v1/models"
        );
    }

    #[test]
    fn provider_model_full_url_derives_nested_models_endpoint() {
        let attempts = build_provider_models_attempts_with_override(
            "codex",
            "https://relay.example.com/custom/v1/chat/completions?region=cn",
            "key",
            None,
            true,
            &[],
        )
        .expect("full URL attempts");

        assert_eq!(attempts.len(), 1);
        assert_eq!(
            attempts[0].url.as_str(),
            "https://relay.example.com/custom/v1/models"
        );
    }

    #[test]
    fn provider_model_urls_reject_credentials_and_queries() {
        assert!(
            build_provider_models_attempts("codex", "https://user:pass@example.com/v1", "key")
                .is_err()
        );
        assert!(build_provider_models_attempts(
            "codex",
            "https://example.com/v1?token=secret",
            "key"
        )
        .is_err());
    }

    #[test]
    fn provider_models_url_override_is_exact_and_allows_query_auth() {
        let attempts = build_provider_models_attempts_with_override(
            "claude_code",
            "https://unused.example.com/v1beta",
            "key",
            Some("https://models.example.com/catalog?api-version=2026-01"),
            false,
            &[],
        )
        .expect("models URL override attempts");

        assert_eq!(attempts.len(), 2);
        assert!(attempts.iter().all(|attempt| {
            attempt.url.as_str() == "https://models.example.com/catalog?api-version=2026-01"
        }));
        assert!(build_provider_models_attempts_with_override(
            "codex",
            "",
            "key",
            Some("https://user:pass@example.com/models"),
            false,
            &[],
        )
        .is_err());

        let gemini = build_provider_models_attempts_with_override(
            "gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            "key",
            Some("https://ignored.example.com/custom/models"),
            false,
            &[],
        )
        .expect("gemini keeps automatic model discovery");
        assert_eq!(
            gemini[0].url.as_str(),
            "https://generativelanguage.googleapis.com/v1/models"
        );
    }

    #[test]
    fn provider_model_headers_never_forge_a_client_identity() {
        for provider_type in ["claude_code", "codex", "gemini", "xai", "deepseek"] {
            for official in [false, true] {
                let headers = build_provider_models_headers(provider_type, "key", official);
                let names = headers
                    .iter()
                    .map(|(name, _)| name.to_ascii_lowercase())
                    .collect::<Vec<_>>();

                // 不开启伪装就照实发：既不带 UA，也不带 SDK 指纹头。伪装只能由用户
                // 在设置里显式写进自定义请求头，经 merge_custom_headers 落到请求上。
                assert!(
                    !names.iter().any(|name| name == "user-agent"),
                    "{provider_type}"
                );
                assert!(!names.iter().any(|name| name.starts_with("x-stainless-")));
                for forbidden in [
                    "x-app",
                    "anthropic-beta",
                    "anthropic-dangerous-direct-browser-access",
                    "session_id",
                    "conversation_id",
                ] {
                    assert!(!names.iter().any(|name| name == forbidden), "{forbidden}");
                }
            }
        }
    }

    #[test]
    fn provider_model_custom_headers_override_identity_but_not_auth() {
        let custom = [
            ("User-Agent".to_string(), "my-relay-client/9.9".to_string()),
            ("X-Request-ID".to_string(), "abc123".to_string()),
            // 保留头：鉴权与 host/content-length 不可被顶掉。
            ("authorization".to_string(), "Bearer stolen".to_string()),
            ("Host".to_string(), "evil.example.com".to_string()),
            ("x-liveagent-proxy-token".to_string(), "leak".to_string()),
            // 非法键名/取值直接丢弃（CR/LF 会造成 header 注入）。
            ("Bad Key".to_string(), "value".to_string()),
            ("X-Inject".to_string(), "a\r\nX-Evil: 1".to_string()),
        ];
        let attempts = build_provider_models_attempts_with_override(
            "claude_code",
            "https://relay.example.com",
            "key",
            None,
            false,
            &custom,
        )
        .expect("attempts with custom headers");

        for attempt in &attempts {
            let get = |wanted: &str| {
                attempt
                    .headers
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(wanted))
                    .map(|(_, value)| value.clone())
            };
            // UA 只可能来自用户显式配置——这里就是它落到请求上的唯一路径。
            assert_eq!(get("user-agent").as_deref(), Some("my-relay-client/9.9"));
            assert_eq!(get("x-request-id").as_deref(), Some("abc123"));
            assert_eq!(get("host"), None);
            assert_eq!(get("x-liveagent-proxy-token"), None);
            assert_eq!(get("bad key"), None);
            assert_eq!(get("x-inject"), None);
            assert_ne!(get("authorization").as_deref(), Some("Bearer stolen"));
        }
        // 鉴权头仍恰好一条，自定义头不得让 attempts 分裂成重复请求。
        assert_eq!(attempts.len(), 2);
    }

    #[test]
    fn provider_model_headers_use_authorization_then_official_auth() {
        for (provider_type, official_expected) in [
            ("claude_code", "x-api-key"),
            ("codex", "authorization"),
            ("gemini", "x-goog-api-key"),
            ("xai", "authorization"),
            ("deepseek", "authorization"),
        ] {
            for (official, expected) in [(false, "authorization"), (true, official_expected)] {
                let headers = build_provider_models_headers(provider_type, "key", official);
                let auth_names = headers
                    .iter()
                    .map(|(name, _)| name.to_ascii_lowercase())
                    .filter(|name| {
                        matches!(
                            name.as_str(),
                            "authorization" | "x-api-key" | "x-goog-api-key"
                        )
                    })
                    .collect::<Vec<_>>();
                assert_eq!(auth_names, vec![expected.to_string()], "{provider_type}");
            }
        }
    }

    #[tokio::test]
    async fn provider_models_request_uses_explicit_proxy_client() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind proxy listener");
        let proxy_address = listener.local_addr().expect("proxy address");
        let proxy_thread = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept proxy request");
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut buffer).expect("read proxy request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            let request = String::from_utf8_lossy(&request);
            assert!(request.starts_with("GET http://provider.invalid/v1/models "));
            let body = r#"{"data":[{"id":"gpt-test"}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("write proxy response");
        });
        let client = Client::builder()
            .no_proxy()
            .proxy(
                reqwest::Proxy::all(format!("http://{proxy_address}"))
                    .expect("configure test proxy"),
            )
            .build()
            .expect("build proxy client");

        let result = fetch_provider_models_with_client(
            &client,
            "codex",
            "http://provider.invalid",
            "test-key",
            None,
            false,
            &[],
        )
        .await
        .expect("fetch provider models");
        proxy_thread.join().expect("proxy thread");
        assert_eq!(
            serde_json::from_str::<Value>(&result).expect("models json"),
            serde_json::json!({ "data": [{ "id": "gpt-test" }] })
        );
    }

    #[tokio::test]
    async fn provider_models_request_has_total_timeout() {
        assert_eq!(PROVIDER_MODELS_REQUEST_TIMEOUT, Duration::from_secs(10));

        let error = with_provider_models_timeout(
            Duration::from_millis(25),
            std::future::pending::<Result<String, String>>(),
        )
        .await
        .expect_err("provider model request should time out");

        assert_eq!(error, PROVIDER_MODELS_TIMEOUT_MESSAGE);
    }
}
