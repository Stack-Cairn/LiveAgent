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
    headers: Vec<(&'static str, String)>,
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
        fetch_provider_models_with_client(&client, provider_type, base_url, api_key),
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
) -> Result<String, String> {
    let attempts = build_provider_models_attempts(provider_type, base_url, api_key)?;
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

fn normalize_provider_base_url(provider_type: &str, raw: &str) -> Result<Url, String> {
    if !matches!(provider_type, "claude_code" | "codex" | "gemini" | "xai") {
        return Err("不支持的供应商类型".to_string());
    }
    let mut url = Url::parse(raw.trim()).map_err(|_| "Base URL 必须是绝对 URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Base URL 必须是有效的 HTTP(S) 绝对 URL".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Base URL 不能包含查询参数或片段".to_string());
    }

    let mut path = url.path().trim_end_matches('/').to_string();
    if provider_type == "codex" || provider_type == "xai" {
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

fn build_provider_models_attempts(
    provider_type: &str,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<ProviderModelsAttempt>, String> {
    let base_url = normalize_provider_base_url(provider_type, base_url)?;
    let [default_attempt, official_attempt] = [false, true].map(|official| ProviderModelsAttempt {
        url: build_provider_models_url(provider_type, &base_url, official),
        headers: build_provider_models_headers(provider_type, api_key, official),
    });
    // codex/xai 的官方形式与统一首次尝试完全一致，重复请求同一端点没有意义，收敛为一次。
    let mut attempts = vec![default_attempt];
    if official_attempt.url != attempts[0].url || official_attempt.headers != attempts[0].headers {
        attempts.push(official_attempt);
    }
    Ok(attempts)
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

        // codex/xai 官方形式与统一首次尝试完全一致，收敛为一次请求。
        let codex = build_provider_models_attempts(
            "codex",
            "https://relay.example.com/v1/responses",
            "key",
        )
        .expect("codex attempts");
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].url.as_str(), "https://relay.example.com/v1/models");
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
    fn provider_model_headers_exclude_inference_identity() {
        for provider_type in ["claude_code", "codex", "gemini", "xai"] {
            for official in [false, true] {
                let headers = build_provider_models_headers(provider_type, "key", official);
                let names = headers
                    .iter()
                    .map(|(name, _)| name.to_ascii_lowercase())
                    .collect::<Vec<_>>();

                assert!(!names.iter().any(|name| name.starts_with("x-stainless-")));
                for forbidden in [
                    "x-app",
                    "user-agent",
                    "anthropic-beta",
                    "anthropic-dangerous-direct-browser-access",
                    "session_id",
                    "conversation_id",
                ] {
                    assert!(!names.iter().any(|name| name == forbidden));
                }
            }
        }
    }

    #[test]
    fn provider_model_headers_use_authorization_then_official_auth() {
        for (provider_type, official_expected) in [
            ("claude_code", "x-api-key"),
            ("codex", "authorization"),
            ("gemini", "x-goog-api-key"),
            ("xai", "authorization"),
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
