// 模型连通测试：前端按路由拼好最小生成请求（URL / 头 / 体），桌面端只负责
// 发一次 POST 并原样带回状态码、耗时与截断后的响应体，成功 / 失败的归类留在
// 前端（summarizeModelCheckResponse）。客户端与模型列表拉取同一套（系统代理开关、
// 直连忽略环境代理）；这里不打任何含请求头的日志，Key 不落盘。

use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::{header::HeaderName, header::HeaderValue, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const MIN_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_TIMEOUT: Duration = Duration::from_secs(120);
/// 读取上限：非流式最小请求的响应不该超过这个量，超出直接判失败。
const MAX_RESPONSE_BYTES: usize = 1 << 20;
/// 返回前端的响应体上限（字符边界截断）。
const MAX_BODY_CHARS: usize = 4096;

#[derive(Debug, Deserialize)]
pub struct ProviderCheckRequest {
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Value,
    #[serde(default)]
    pub use_system_proxy: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderCheckResponse {
    pub status: u16,
    pub latency_ms: u64,
    pub body: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn provider_check_model(
    url: String,
    headers: Vec<(String, String)>,
    body: Value,
    use_system_proxy: bool,
    timeout_ms: Option<u64>,
) -> Result<ProviderCheckResponse, String> {
    check_provider_model(ProviderCheckRequest {
        url,
        headers,
        body,
        use_system_proxy,
        timeout_ms,
    })
    .await
}

pub async fn check_provider_model(
    request: ProviderCheckRequest,
) -> Result<ProviderCheckResponse, String> {
    let client = if request.use_system_proxy {
        crate::services::system_proxy::cached_client()
            .map_err(|error| format!("App proxy unavailable: {error}"))?
    } else {
        crate::services::provider_models::direct_client()?
    };
    check_provider_model_with_client(&client, request).await
}

pub(crate) fn resolve_timeout(timeout_ms: Option<u64>) -> Duration {
    timeout_ms
        .map(Duration::from_millis)
        .map(|timeout| timeout.clamp(MIN_TIMEOUT, MAX_TIMEOUT))
        .unwrap_or(DEFAULT_TIMEOUT)
}

/// 只接受 http(s) 绝对地址；reqwest 自身也只会跟随到 http(s)，其它 scheme 的
/// 重定向按请求失败处理，不会把 Key 带去别的协议。
pub(crate) fn validate_check_url(raw: &str) -> Result<Url, String> {
    let url = crate::services::provider_models::parse_http_url(raw, "请求地址")?;
    if url.fragment().is_some() {
        return Err("请求地址不能包含片段".to_string());
    }
    Ok(url)
}

fn build_headers(headers: &[(String, String)]) -> Result<reqwest::header::HeaderMap, String> {
    let mut map = reqwest::header::HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        // 出错信息只带头名，不带取值：鉴权头取值就是 Key。
        let header_name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| format!("请求头名无效：{name}"))?;
        let header_value =
            HeaderValue::from_str(value).map_err(|_| format!("请求头取值无效：{name}"))?;
        map.insert(header_name, header_value);
    }
    Ok(map)
}

pub(crate) fn truncate_body(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    match text.char_indices().nth(MAX_BODY_CHARS) {
        Some((index, _)) => text[..index].to_string(),
        None => text.into_owned(),
    }
}

async fn read_limited_body(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("响应过大".to_string());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "读取响应失败".to_string())?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("响应过大".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn check_provider_model_with_client(
    client: &Client,
    request: ProviderCheckRequest,
) -> Result<ProviderCheckResponse, String> {
    let url = validate_check_url(&request.url)?;
    let headers = build_headers(&request.headers)?;
    let timeout = resolve_timeout(request.timeout_ms);
    let started = Instant::now();
    let send = client
        .post(url)
        .headers(headers)
        .json(&request.body)
        .timeout(timeout)
        .send();
    let response = match tokio::time::timeout(timeout, send).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return Err(if error.is_timeout() {
                format!("请求超时（{} 秒）", timeout.as_secs())
            } else if error.is_connect() {
                "无法连接到供应商".to_string()
            } else {
                "请求发送失败".to_string()
            });
        }
        Err(_) => return Err(format!("请求超时（{} 秒）", timeout.as_secs())),
    };
    let status = response.status().as_u16();
    let remaining = timeout.saturating_sub(started.elapsed());
    let body = tokio::time::timeout(remaining, read_limited_body(response))
        .await
        .map_err(|_| format!("请求超时（{} 秒）", timeout.as_secs()))??;
    Ok(ProviderCheckResponse {
        status,
        latency_ms: started.elapsed().as_millis() as u64,
        body: truncate_body(&body),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn provider_check_url_only_accepts_http_schemes() {
        assert!(validate_check_url("https://api.example.com/v1/chat/completions").is_ok());
        assert!(validate_check_url("http://127.0.0.1:8080/v1/responses").is_ok());
        assert!(validate_check_url("ftp://api.example.com/v1").is_err());
        assert!(validate_check_url("file:///etc/passwd").is_err());
        assert!(validate_check_url("https://user:pass@api.example.com/v1").is_err());
        assert!(validate_check_url("https://api.example.com/v1#frag").is_err());
        assert!(validate_check_url("/v1/chat/completions").is_err());
    }

    #[test]
    fn provider_check_timeout_is_clamped() {
        assert_eq!(resolve_timeout(None), Duration::from_secs(30));
        assert_eq!(resolve_timeout(Some(0)), Duration::from_secs(1));
        assert_eq!(resolve_timeout(Some(5_000)), Duration::from_secs(5));
        assert_eq!(resolve_timeout(Some(600_000)), Duration::from_secs(120));
    }

    #[test]
    fn provider_check_body_truncates_on_char_boundary() {
        let short = truncate_body("{\"ok\":true}".as_bytes());
        assert_eq!(short, "{\"ok\":true}");
        let long = "中".repeat(MAX_BODY_CHARS + 10);
        let truncated = truncate_body(long.as_bytes());
        assert_eq!(truncated.chars().count(), MAX_BODY_CHARS);
        assert!(truncated.chars().all(|character| character == '中'));
    }

    #[test]
    fn provider_check_headers_reject_injection_without_echoing_values() {
        let error = build_headers(&[(
            "authorization".to_string(),
            "Bearer sk-secret\r\nx-evil: 1".to_string(),
        )])
        .expect_err("CR/LF must be rejected");
        assert!(!error.contains("sk-secret"));
        assert!(error.contains("authorization"));
        assert!(build_headers(&[("bad name".to_string(), "v".to_string())]).is_err());
        let ok = build_headers(&[
            ("".to_string(), "ignored".to_string()),
            ("x-api-key".to_string(), "k".to_string()),
        ])
        .expect("valid headers");
        assert_eq!(ok.len(), 1);
    }

    #[tokio::test]
    async fn provider_check_posts_json_and_returns_status_latency_body() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
        let address = listener.local_addr().expect("address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            let mut buffer = [0u8; 2048];
            loop {
                let read = stream.read(&mut buffer).expect("read request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&request);
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let head = &text[..head_end];
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if request.len() >= head_end + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8_lossy(&request).into_owned();
            let body = r#"{"choices":[{"message":{"content":"hi"}}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("write response");
            request
        });
        let client = Client::builder().no_proxy().build().expect("client");
        let result = check_provider_model_with_client(
            &client,
            ProviderCheckRequest {
                url: format!("http://{address}/v1/chat/completions"),
                headers: vec![
                    ("authorization".to_string(), "Bearer test-key".to_string()),
                    ("content-type".to_string(), "application/json".to_string()),
                ],
                body: serde_json::json!({ "model": "gpt-test", "max_tokens": 8 }),
                use_system_proxy: false,
                timeout_ms: Some(5_000),
            },
        )
        .await
        .expect("check succeeds");
        let request = server.join().expect("server thread");
        assert!(
            request.starts_with("POST /v1/chat/completions "),
            "{request}"
        );
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-key"));
        let body_start = request.find("\r\n\r\n").expect("request body") + 4;
        let sent: Value = serde_json::from_str(&request[body_start..]).expect("json body");
        assert_eq!(
            sent,
            serde_json::json!({ "model": "gpt-test", "max_tokens": 8 })
        );
        assert_eq!(result.status, 200);
        assert_eq!(result.body, r#"{"choices":[{"message":{"content":"hi"}}]}"#);
    }

    #[tokio::test]
    async fn provider_check_reports_connection_failure_without_panicking() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
        let address = listener.local_addr().expect("address");
        drop(listener);
        let client = Client::builder().no_proxy().build().expect("client");
        let error = check_provider_model_with_client(
            &client,
            ProviderCheckRequest {
                url: format!("http://{address}/v1/messages"),
                headers: vec![],
                body: Value::Null,
                use_system_proxy: false,
                timeout_ms: Some(2_000),
            },
        )
        .await
        .expect_err("closed port must fail");
        assert!(!error.is_empty());
    }
}
