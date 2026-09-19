// 图像生成的发送链路（设计文档 §6.7）。与 provider_check 同构：前端按路由拼好
// 请求（URL / 头 / 体），桌面端只负责发一次 POST 并原样带回状态码、耗时与响应
// 体，成功 / 失败的归类与图片抽取留在前端（parseImageGenerationResponse）。
//
// 与连通测试的三处差别，都是"生图响应比聊天响应大得多"带来的：
//  - 缺省超时 120 秒（出图慢），上限 300 秒；
//  - 响应上限 64MB，且**不截断**——截断会把 base64 图片切坏；
//  - 另有 provider_download_image，供 dall-e 那种只回 URL 的结果落地。
//
// 响应体原样回传（不在 Rust 侧抽 base64 换占位）是刻意的：图片抽取规则要同时
// 覆盖 OpenAI Images 的 data[].b64_json / url 与 Gemini 的 inlineData，还要认
// 中转的 snake_case 变体。那份逻辑已经在 TS 侧（imageGeneration.ts）写好并有
// 单测，再在 Rust 复刻一份就成了两个必须同步的解析器。代价是一次最多 64MB 的
// 字符串过 IPC；工具侧把 count 压到 4 张以内来兜住这个量。
//
// 这里同样不打任何含请求头的日志，Key 不落盘。

use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use futures_util::StreamExt;
use reqwest::{header::HeaderName, header::HeaderValue, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 出图普遍在十几秒到一分钟之间，缺省给 120 秒。
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const MIN_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_TIMEOUT: Duration = Duration::from_secs(300);
/// 生成响应的读取上限：4 张高清 PNG 的 base64 也在这个量级以内。
const MAX_RESPONSE_BYTES: usize = 64 << 20;
/// 远端图片下载的读取上限。
const MAX_DOWNLOAD_BYTES: usize = 32 << 20;
/// 下载单张图片的缺省超时。
const DEFAULT_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
pub struct ProviderGenerateImageRequest {
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
pub struct ProviderGenerateImageResponse {
    pub status: u16,
    pub latency_ms: u64,
    /// 原样响应体（不截断）；解析在 TS 侧。
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct ProviderDownloadImageRequest {
    pub url: String,
    #[serde(default)]
    pub use_system_proxy: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderDownloadImageResponse {
    pub mime_type: String,
    /// 标准 base64（不带 data: 前缀），与工具侧的 ImageContent.data 同形。
    pub data: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn provider_generate_image(
    url: String,
    headers: Vec<(String, String)>,
    body: Value,
    use_system_proxy: bool,
    timeout_ms: Option<u64>,
) -> Result<ProviderGenerateImageResponse, String> {
    generate_provider_image(ProviderGenerateImageRequest {
        url,
        headers,
        body,
        use_system_proxy,
        timeout_ms,
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn provider_download_image(
    url: String,
    use_system_proxy: bool,
    timeout_ms: Option<u64>,
) -> Result<ProviderDownloadImageResponse, String> {
    download_provider_image(ProviderDownloadImageRequest {
        url,
        use_system_proxy,
        timeout_ms,
    })
    .await
}

fn resolve_client(use_system_proxy: bool) -> Result<Client, String> {
    if use_system_proxy {
        crate::services::system_proxy::cached_client()
            .map_err(|error| format!("App proxy unavailable: {error}"))
    } else {
        crate::services::provider_models::direct_client()
    }
}

pub async fn generate_provider_image(
    request: ProviderGenerateImageRequest,
) -> Result<ProviderGenerateImageResponse, String> {
    let client = resolve_client(request.use_system_proxy)?;
    generate_provider_image_with_client(&client, request).await
}

pub async fn download_provider_image(
    request: ProviderDownloadImageRequest,
) -> Result<ProviderDownloadImageResponse, String> {
    let client = resolve_client(request.use_system_proxy)?;
    download_provider_image_with_client(&client, request).await
}

pub(crate) fn resolve_generate_timeout(timeout_ms: Option<u64>) -> Duration {
    timeout_ms
        .map(Duration::from_millis)
        .map(|timeout| timeout.clamp(MIN_TIMEOUT, MAX_TIMEOUT))
        .unwrap_or(DEFAULT_TIMEOUT)
}

pub(crate) fn resolve_download_timeout(timeout_ms: Option<u64>) -> Duration {
    timeout_ms
        .map(Duration::from_millis)
        .map(|timeout| timeout.clamp(MIN_TIMEOUT, MAX_TIMEOUT))
        .unwrap_or(DEFAULT_DOWNLOAD_TIMEOUT)
}

/// 只接受 http(s) 绝对地址（与连通测试同一校验），并禁掉片段。
pub(crate) fn validate_image_url(raw: &str) -> Result<Url, String> {
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

async fn read_limited_body(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("响应过大".to_string());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "读取响应失败".to_string())?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err("响应过大".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn send_error_text(error: &reqwest::Error, timeout: Duration) -> String {
    if error.is_timeout() {
        format!("请求超时（{} 秒）", timeout.as_secs())
    } else if error.is_connect() {
        "无法连接到供应商".to_string()
    } else {
        "请求发送失败".to_string()
    }
}

async fn generate_provider_image_with_client(
    client: &Client,
    request: ProviderGenerateImageRequest,
) -> Result<ProviderGenerateImageResponse, String> {
    let url = validate_image_url(&request.url)?;
    let headers = build_headers(&request.headers)?;
    let timeout = resolve_generate_timeout(request.timeout_ms);
    let started = Instant::now();
    let send = client
        .post(url)
        .headers(headers)
        .json(&request.body)
        .timeout(timeout)
        .send();
    let response = match tokio::time::timeout(timeout, send).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(send_error_text(&error, timeout)),
        Err(_) => return Err(format!("请求超时（{} 秒）", timeout.as_secs())),
    };
    let status = response.status().as_u16();
    let remaining = timeout.saturating_sub(started.elapsed());
    let body = tokio::time::timeout(remaining, read_limited_body(response, MAX_RESPONSE_BYTES))
        .await
        .map_err(|_| format!("请求超时（{} 秒）", timeout.as_secs()))??;
    Ok(ProviderGenerateImageResponse {
        status,
        latency_ms: started.elapsed().as_millis() as u64,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

/// Content-Type 里的 MIME；没有或不是 image/* 时按 PNG 处理（多数 CDN 会给对）。
fn image_mime_type(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_string())
        .filter(|value| value.starts_with("image/"))
        .unwrap_or_else(|| "image/png".to_string())
}

async fn download_provider_image_with_client(
    client: &Client,
    request: ProviderDownloadImageRequest,
) -> Result<ProviderDownloadImageResponse, String> {
    let url = validate_image_url(&request.url)?;
    let timeout = resolve_download_timeout(request.timeout_ms);
    let started = Instant::now();
    let send = client.get(url).timeout(timeout).send();
    let response = match tokio::time::timeout(timeout, send).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(send_error_text(&error, timeout)),
        Err(_) => return Err(format!("请求超时（{} 秒）", timeout.as_secs())),
    };
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载图片失败：HTTP {}", status.as_u16()));
    }
    let mime_type = image_mime_type(&response);
    let remaining = timeout.saturating_sub(started.elapsed());
    let bytes = tokio::time::timeout(remaining, read_limited_body(response, MAX_DOWNLOAD_BYTES))
        .await
        .map_err(|_| format!("请求超时（{} 秒）", timeout.as_secs()))??;
    if bytes.is_empty() {
        return Err("下载图片失败：响应为空".to_string());
    }
    Ok(ProviderDownloadImageResponse {
        mime_type,
        data: BASE64_STANDARD.encode(&bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn image_generation_url_only_accepts_http_schemes() {
        assert!(validate_image_url("https://api.openai.com/v1/images/generations").is_ok());
        assert!(validate_image_url("http://127.0.0.1:8080/v1/images/generations").is_ok());
        assert!(validate_image_url("ftp://example.com/x").is_err());
        assert!(validate_image_url("file:///etc/passwd").is_err());
        assert!(validate_image_url("/v1/images/generations").is_err());
        assert!(validate_image_url("https://example.com/x#frag").is_err());
        // 地址里不得夹带凭据（parse_http_url 的规则）。
        assert!(validate_image_url("https://user:pass@example.com/x").is_err());
    }

    #[test]
    fn image_generation_timeouts_are_clamped_with_a_longer_default() {
        assert_eq!(resolve_generate_timeout(None), Duration::from_secs(120));
        assert_eq!(resolve_generate_timeout(Some(0)), MIN_TIMEOUT);
        assert_eq!(resolve_generate_timeout(Some(45_000)), Duration::from_secs(45));
        // 生图比连通测试慢，上限放到 300 秒，但仍然有上限。
        assert_eq!(resolve_generate_timeout(Some(9_999_999)), MAX_TIMEOUT);
        assert_eq!(resolve_download_timeout(None), Duration::from_secs(60));
        assert_eq!(resolve_download_timeout(Some(9_999_999)), MAX_TIMEOUT);
    }

    #[test]
    fn image_generation_headers_reject_injection_without_echoing_values() {
        assert!(build_headers(&[("X-Ok".into(), "value".into())]).is_ok());
        // 空头名跳过而不是报错（前端合并后可能留空项）。
        assert!(build_headers(&[("  ".into(), "value".into())]).is_ok());
        let bad_name = build_headers(&[("Bad Name".into(), "v".into())]).unwrap_err();
        assert!(bad_name.contains("Bad Name"));
        let bad_value =
            build_headers(&[("Authorization".into(), "Bearer sk-secret\r\nX: y".into())])
                .unwrap_err();
        assert!(bad_value.contains("Authorization"));
        assert!(!bad_value.contains("sk-secret"));
    }

    /// 单连接的最小 HTTP/1.1 服务：读完请求，回固定响应，并把请求原文交出来。
    fn serve_once(response: Vec<u8>) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let read = stream.read(&mut chunk).unwrap();
                if read == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&buffer).to_string();
                if let Some(index) = text.find("\r\n\r\n") {
                    let length = text
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("Content-Length: ")
                                .or_else(|| line.strip_prefix("content-length: "))
                        })
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if buffer.len() >= index + 4 + length {
                        break;
                    }
                }
            }
            stream.write_all(&response).unwrap();
            stream.flush().unwrap();
            String::from_utf8_lossy(&buffer).to_string()
        });
        (format!("http://{addr}"), handle)
    }

    fn direct_test_client() -> Client {
        Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn image_generation_posts_json_and_returns_the_body_untruncated() {
        // 响应体远超连通测试的 4KB 截断线：生图必须原样带回，截断会切坏 base64。
        let long_b64 = "A".repeat(20_000);
        let payload = format!("{{\"data\":[{{\"b64_json\":\"{long_b64}\"}}]}}");
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        );
        let (base, handle) = serve_once(response.into_bytes());
        let result = generate_provider_image_with_client(
            &direct_test_client(),
            ProviderGenerateImageRequest {
                url: format!("{base}/v1/images/generations"),
                headers: vec![("Authorization".into(), "Bearer sk-test".into())],
                body: serde_json::json!({ "model": "gpt-image-1", "prompt": "hi", "n": 1 }),
                use_system_proxy: false,
                timeout_ms: Some(10_000),
            },
        )
        .await
        .unwrap();
        assert_eq!(result.status, 200);
        assert_eq!(result.body.len(), payload.len());
        assert!(result.body.contains(&long_b64));

        let request = handle.join().unwrap();
        assert!(request.starts_with("POST /v1/images/generations "), "{request}");
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-test"));
        assert!(request.contains("\"prompt\":\"hi\""));
    }

    #[tokio::test]
    async fn image_generation_rejects_oversized_responses() {
        // Content-Length 声明超限：不读正文就拒。
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            (MAX_RESPONSE_BYTES as u64) + 1
        );
        let (base, _handle) = serve_once(response.into_bytes());
        let error = generate_provider_image_with_client(
            &direct_test_client(),
            ProviderGenerateImageRequest {
                url: format!("{base}/v1/images/generations"),
                headers: Vec::new(),
                body: serde_json::json!({}),
                use_system_proxy: false,
                timeout_ms: Some(5_000),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error, "响应过大");
    }

    #[tokio::test]
    async fn image_download_returns_base64_with_the_declared_mime_type() {
        let bytes = [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png; charset=binary\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        )
        .into_bytes();
        response.extend_from_slice(&bytes);
        let (base, _handle) = serve_once(response);
        let result = download_provider_image_with_client(
            &direct_test_client(),
            ProviderDownloadImageRequest {
                url: format!("{base}/a.png"),
                use_system_proxy: false,
                timeout_ms: Some(5_000),
            },
        )
        .await
        .unwrap();
        assert_eq!(result.mime_type, "image/png");
        assert_eq!(result.data, BASE64_STANDARD.encode(bytes));
    }

    #[tokio::test]
    async fn image_download_reports_http_failures() {
        let response = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let (base, _handle) = serve_once(response.as_bytes().to_vec());
        let error = download_provider_image_with_client(
            &direct_test_client(),
            ProviderDownloadImageRequest {
                url: format!("{base}/missing.png"),
                use_system_proxy: false,
                timeout_ms: Some(5_000),
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("404"));
    }

    #[tokio::test]
    async fn image_generation_reports_connection_failure_without_panicking() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let error = generate_provider_image_with_client(
            &direct_test_client(),
            ProviderGenerateImageRequest {
                url: format!("http://{addr}/v1/images/generations"),
                headers: Vec::new(),
                body: serde_json::json!({}),
                use_system_proxy: false,
                timeout_ms: Some(2_000),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error, "无法连接到供应商");
    }
}
