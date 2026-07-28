use std::{
    net::{Ipv4Addr, TcpListener},
    sync::Arc,
    time::Duration,
};

use axum::{
    body::{to_bytes, Body},
    extract::{OriginalUri, Path, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::Response,
    routing::{any, get},
    Router,
};
use base64::Engine as _;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::net::TcpListener as TokioTcpListener;
use uuid::Uuid;

const ACCESS_CONTROL_REQUEST_HEADERS: &str = "access-control-request-headers";
const ACCESS_CONTROL_REQUEST_METHOD: &str = "access-control-request-method";
const ACCESS_CONTROL_PREFIX: &str = "access-control-";
const CONTENT_LENGTH: &str = "content-length";
const CONTENT_TYPE: &str = "content-type";
const CONNECTION: &str = "connection";
const HOST: &str = "host";
const KEEP_ALIVE: &str = "keep-alive";
const ORIGIN: &str = "origin";
const PROXY_AUTHENTICATE: &str = "proxy-authenticate";
const PROXY_AUTHORIZATION: &str = "proxy-authorization";
const PROXY_CONNECTION: &str = "proxy-connection";
const PROXY_PREFIX: &str = "x-liveagent-";
const PROXY_TOKEN_HEADER: &str = "x-liveagent-proxy-token";
const REFERER: &str = "referer";
const TE: &str = "te";
const TRAILER: &str = "trailer";
const TRANSFER_ENCODING: &str = "transfer-encoding";
const UPGRADE: &str = "upgrade";
const UPSTREAM_ORIGIN_HEADER: &str = "x-liveagent-upstream-origin";
const UPSTREAM_HEADERS_HEADER: &str = "x-liveagent-upstream-headers";
const UPSTREAM_HEADERS_MAX_BYTES: usize = 8 * 1024;
const USE_SYSTEM_PROXY_HEADER: &str = "x-liveagent-use-system-proxy";
const DEFAULT_ALLOW_HEADERS: &str = "authorization,content-type,x-api-key,x-goog-api-key,anthropic-version,x-liveagent-upstream-origin,x-liveagent-upstream-headers,x-liveagent-proxy-token,x-liveagent-use-system-proxy";
const ALLOW_METHODS_VALUE: &str = "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD";
const VARY_VALUE: &str = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";
const IMAGE_PROXY_MAX_BYTES: usize = 25 * 1024 * 1024;
const IMAGE_PROXY_TIMEOUT_SECS: u64 = 20;
const IMAGE_PROXY_ACCEPT: &str = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
const IMAGE_PROXY_ACCEPT_LANGUAGE: &str = "en-US,en;q=0.9";
const IMAGE_PROXY_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

#[derive(Clone, Debug, Serialize)]
pub struct ProxyServerInfo {
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub token: String,
}

pub struct ProxyServerState {
    info: ProxyServerInfo,
    client: reqwest::Client,
}

#[derive(Deserialize)]
struct ProxyRoutePath {
    provider: String,
    #[serde(rename = "rest")]
    _rest: Option<String>,
}

#[derive(Deserialize)]
struct ImageProxyQuery {
    url: String,
}

#[tauri::command]
pub fn proxy_get_server_info(state: tauri::State<'_, Arc<ProxyServerState>>) -> ProxyServerInfo {
    state.info.clone()
}

pub fn start_proxy_server() -> Result<Arc<ProxyServerState>, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|err| format!("绑定本地代理端口失败：{err}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|err| format!("设置本地代理监听为 nonblocking 失败：{err}"))?;
    let addr = listener
        .local_addr()
        .map_err(|err| format!("读取本地代理地址失败：{err}"))?;

    let state = Arc::new(ProxyServerState {
        info: ProxyServerInfo {
            base_url: format!("http://{addr}"),
            token: Uuid::new_v4().to_string(),
        },
        client: reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|err| format!("创建本地代理 HTTP 客户端失败：{err}"))?,
    });

    let app = Router::new()
        .route("/image-proxy", get(handle_image_proxy))
        .route("/proxy/{provider}", any(handle_proxy))
        .route("/proxy/{provider}/{*rest}", any(handle_proxy))
        .with_state(state.clone());

    tauri::async_runtime::spawn(async move {
        let listener = match TokioTcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("failed to convert local proxy listener: {err}");
                return;
            }
        };
        if let Err(err) = axum::serve(listener, app).await {
            eprintln!("local proxy server stopped unexpectedly: {err}");
        }
    });

    Ok(state)
}

async fn handle_image_proxy(Query(query): Query<ImageProxyQuery>, headers: HeaderMap) -> Response {
    let target_url = match validate_image_proxy_url(&query.url) {
        Ok(url) => url,
        Err(message) => return error_response(StatusCode::BAD_REQUEST, &message, &headers),
    };

    // 图片外链与商店链路同语义：恒随应用代理出网（未启用=直连，配置异常
    // 502 fail fast）。<img> 请求无法携带自定义头，因此不走 per-request 开关。
    let client = match crate::services::system_proxy::cached_client() {
        Ok(client) => client,
        Err(error) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                &format!("App proxy unavailable: {error}"),
                &headers,
            );
        }
    };
    let image_request = client
        .get(target_url.clone())
        .timeout(Duration::from_secs(IMAGE_PROXY_TIMEOUT_SECS));

    let upstream_response = match apply_image_proxy_request_headers(image_request, &target_url)
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to load image through local proxy: {err}"),
                &headers,
            );
        }
    };

    let status = upstream_response.status();
    if !status.is_success() {
        return error_response(
            StatusCode::BAD_GATEWAY,
            &format!("Image proxy upstream returned HTTP status {status}"),
            &headers,
        );
    }

    if let Some(content_length) = upstream_response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
    {
        if content_length > IMAGE_PROXY_MAX_BYTES {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Image proxy response is too large",
                &headers,
            );
        }
    }

    let content_type = upstream_response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = match upstream_response.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to read image proxy response: {err}"),
                &headers,
            );
        }
    };
    if bytes.len() > IMAGE_PROXY_MAX_BYTES {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Image proxy response is too large",
            &headers,
        );
    }

    let mime_type = match resolve_image_proxy_mime(content_type.as_deref(), &bytes) {
        Ok(mime_type) => mime_type,
        Err(message) => return error_response(StatusCode::BAD_GATEWAY, &message, &headers),
    };

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", mime_type)
        .header("Content-Length", bytes.len().to_string())
        .header("Cache-Control", "private, max-age=300")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .body(Body::from(bytes))
        .expect("image proxy response builder must succeed");
    apply_cors_headers(response.headers_mut(), &headers);
    response
}

fn validate_image_proxy_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|err| format!("Image URL must be absolute: {err}"))?;
    match url.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(format!(
                "Image proxy only supports http and https, got {scheme}"
            ));
        }
    }
    if !url.has_host() || !url.username().is_empty() || url.password().is_some() {
        return Err(
            "Image URL must be a valid absolute URL without embedded credentials".to_string(),
        );
    }
    Ok(url)
}

fn image_proxy_referer(target_url: &Url) -> String {
    format!("{}/", target_url.origin().ascii_serialization())
}

fn apply_image_proxy_request_headers(
    request: reqwest::RequestBuilder,
    target_url: &Url,
) -> reqwest::RequestBuilder {
    request
        .header("Accept", IMAGE_PROXY_ACCEPT)
        .header("Accept-Language", IMAGE_PROXY_ACCEPT_LANGUAGE)
        .header("User-Agent", IMAGE_PROXY_USER_AGENT)
        .header("Referer", image_proxy_referer(target_url))
}

fn normalize_image_proxy_mime(value: &str) -> Option<&'static str> {
    let mime = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match mime.as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        "image/bmp" => Some("image/bmp"),
        "image/svg+xml" => Some("image/svg+xml"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("image/x-icon"),
        _ => None,
    }
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let prefix_len = bytes.len().min(1024);
    let prefix = String::from_utf8_lossy(&bytes[..prefix_len]);
    let trimmed = prefix.trim_start_matches('\u{feff}').trim_start();
    trimmed.starts_with("<svg") || trimmed.contains("<svg")
}

fn infer_image_proxy_mime_from_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    if looks_like_svg(bytes) {
        return Some("image/svg+xml");
    }
    None
}

fn resolve_image_proxy_mime(
    content_type: Option<&str>,
    bytes: &[u8],
) -> Result<&'static str, String> {
    if let Some(mime) = content_type.and_then(normalize_image_proxy_mime) {
        return Ok(mime);
    }
    if let Some(mime) = infer_image_proxy_mime_from_bytes(bytes) {
        return Ok(mime);
    }
    Err("Image proxy upstream response is not a supported image".to_string())
}

async fn handle_proxy(
    State(state): State<Arc<ProxyServerState>>,
    Path(ProxyRoutePath { provider, .. }): Path<ProxyRoutePath>,
    method: Method,
    headers: HeaderMap,
    OriginalUri(original_uri): OriginalUri,
    body: Body,
) -> Response {
    if method == Method::OPTIONS {
        return preflight_response(&headers);
    }

    match required_header(&headers, PROXY_TOKEN_HEADER) {
        Ok(value) if value == state.info.token => {}
        Ok(_) => return error_response(StatusCode::FORBIDDEN, "Invalid proxy token", &headers),
        Err(response) => return response,
    }

    let upstream_origin = match required_header(&headers, UPSTREAM_ORIGIN_HEADER) {
        Ok(value) => value,
        Err(response) => return response,
    };

    let original_path_and_query = original_uri
        .path_and_query()
        .map(axum::http::uri::PathAndQuery::as_str)
        .unwrap_or("/");
    let target_url = match build_target_url(&provider, original_path_and_query, upstream_origin) {
        Ok(url) => url,
        Err(message) => return error_response(StatusCode::BAD_REQUEST, &message, &headers),
    };

    let body_bytes = match to_bytes(body, usize::MAX).await {
        Ok(bytes) => bytes,
        Err(err) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                &format!("Failed to read the proxy request body: {err}"),
                &headers,
            );
        }
    };

    let use_system_proxy = headers
        .get(USE_SYSTEM_PROXY_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == "1");
    // 系统代理未启用时 cached_client 返回直连 client（勾选但全局关闭 = 直连）；
    // 代理配置异常则 fail fast，绝不静默降级为直连。
    let client = if use_system_proxy {
        match crate::services::system_proxy::cached_client() {
            Ok(client) => client,
            Err(error) => {
                return error_response(
                    StatusCode::BAD_GATEWAY,
                    &format!("App proxy unavailable: {error}"),
                    &headers,
                );
            }
        }
    } else {
        state.client.clone()
    };
    let upstream_request_headers = match build_upstream_request_headers(&headers) {
        Ok(upstream_request_headers) => upstream_request_headers,
        Err(message) => return error_response(StatusCode::BAD_REQUEST, &message, &headers),
    };
    let mut request = client
        .request(method, target_url)
        .headers(upstream_request_headers);
    if !body_bytes.is_empty() {
        request = request.body(body_bytes);
    }

    let upstream_response = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to forward the proxy request upstream: {err}"),
                &headers,
            );
        }
    };

    let status = upstream_response.status();
    let upstream_headers = upstream_response.headers().clone();
    let body = Body::from_stream(upstream_response.bytes_stream());
    let mut response = Response::builder()
        .status(status)
        .body(body)
        .unwrap_or_else(|err| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from(format!(
                    "Failed to build the proxy response: {err}"
                )))
                .expect("proxy response builder fallback must succeed")
        });

    for (name, value) in &upstream_headers {
        if should_forward_response_header(name) {
            response.headers_mut().append(name, value.clone());
        }
    }
    apply_cors_headers(response.headers_mut(), &headers);
    response
}

fn build_target_url(
    provider: &str,
    original_path_and_query: &str,
    upstream_origin: &str,
) -> Result<Url, String> {
    let origin =
        Url::parse(upstream_origin).map_err(|err| format!("Invalid upstream Origin: {err}"))?;
    if !origin.has_host() || !origin.username().is_empty() || origin.password().is_some() {
        return Err("Upstream Origin must be a valid absolute URL".to_string());
    }
    if origin.path() != "/" || origin.query().is_some() || origin.fragment().is_some() {
        return Err("Upstream Origin may contain only the scheme, host, and port".to_string());
    }

    let prefix = format!("/proxy/{provider}");
    let suffix = original_path_and_query
        .strip_prefix(&prefix)
        .ok_or_else(|| "Invalid proxy path prefix".to_string())?;
    let resolved = if suffix.is_empty() { "/" } else { suffix };
    // “//” 开头的后缀会被 Url::join 当作 scheme-relative 引用改写目标主机，
    // 显式拒绝，防止请求被重定向到 upstream origin 之外的主机。
    if resolved.starts_with("//") {
        return Err("Proxy request path must not begin with //".to_string());
    }

    origin
        .join(resolved)
        .map_err(|err| format!("Failed to construct the upstream request URL: {err}"))
}

fn required_header<'a>(headers: &'a HeaderMap, name: &'static str) -> Result<&'a str, Response> {
    let Some(value) = headers.get(name) else {
        return Err(error_response(
            if name == PROXY_TOKEN_HEADER {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::BAD_REQUEST
            },
            &format!("Missing request header: {name}"),
            headers,
        ));
    };

    value.to_str().map_err(|_| {
        error_response(
            if name == PROXY_TOKEN_HEADER {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::BAD_REQUEST
            },
            &format!("Request header is not valid UTF-8: {name}"),
            headers,
        )
    })
}

fn preflight_response(request_headers: &HeaderMap) -> Response {
    let mut response = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Body::empty())
        .expect("preflight response builder must succeed");
    apply_cors_headers(response.headers_mut(), request_headers);
    response
}

fn error_response(status: StatusCode, message: &str, request_headers: &HeaderMap) -> Response {
    let mut response = Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(Body::from(message.to_string()))
        .expect("error response builder must succeed");
    apply_cors_headers(response.headers_mut(), request_headers);
    response
}

fn apply_cors_headers(headers: &mut HeaderMap, request_headers: &HeaderMap) {
    headers.insert(
        HeaderName::from_static("access-control-allow-origin"),
        HeaderValue::from_static("*"),
    );
    headers.insert(
        HeaderName::from_static("access-control-allow-methods"),
        HeaderValue::from_static(ALLOW_METHODS_VALUE),
    );
    headers.insert(
        HeaderName::from_static("access-control-allow-headers"),
        build_allow_headers_value(request_headers),
    );
    headers.insert(
        HeaderName::from_static("vary"),
        HeaderValue::from_static(VARY_VALUE),
    );
}

fn build_allow_headers_value(request_headers: &HeaderMap) -> HeaderValue {
    request_headers
        .get(ACCESS_CONTROL_REQUEST_HEADERS)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| HeaderValue::from_str(value).ok())
        .unwrap_or_else(|| HeaderValue::from_static(DEFAULT_ALLOW_HEADERS))
}

fn should_forward_request_header(name: &HeaderName) -> bool {
    let lowered = name.as_str();
    !matches!(
        lowered,
        HOST | CONTENT_LENGTH
            | CONNECTION
            | KEEP_ALIVE
            | PROXY_CONNECTION
            | PROXY_AUTHENTICATE
            | PROXY_AUTHORIZATION
            | TE
            | TRAILER
            | TRANSFER_ENCODING
            | UPGRADE
            | ORIGIN
            | REFERER
            | ACCESS_CONTROL_REQUEST_METHOD
            | ACCESS_CONTROL_REQUEST_HEADERS
    ) && !lowered.starts_with(ACCESS_CONTROL_PREFIX)
        && !lowered.starts_with(PROXY_PREFIX)
}

/// 覆盖包的拒绝清单**窄于** should_forward_request_header：只拒会破坏请求本身的
/// 头（host / content-length / hop-by-hop）与本地反代的内部命名空间。
///
/// 有意放行 origin / referer / cookie —— 常规拷贝过滤器的职责是剥掉 *WebView 自己
/// 注入的* Origin/Referer，而不是否决用户在供应商配置里显式写下的同名头。
fn is_protected_upstream_override(name: &HeaderName) -> bool {
    let lowered = name.as_str();
    matches!(
        lowered,
        HOST | CONTENT_LENGTH
            | CONNECTION
            | KEEP_ALIVE
            | PROXY_CONNECTION
            | PROXY_AUTHENTICATE
            | PROXY_AUTHORIZATION
            | TE
            | TRAILER
            | TRANSFER_ENCODING
            | UPGRADE
    ) || lowered.starts_with(PROXY_PREFIX)
}

/// 解出 x-liveagent-upstream-headers 覆盖包。畸形输入一律 Err（由调用方回 400）：
/// 静默跳过会把「自定义请求头没生效」变成难查的偶发问题。
fn decode_upstream_header_overrides(
    encoded: &str,
) -> Result<Vec<(HeaderName, HeaderValue)>, String> {
    if encoded.len() > UPSTREAM_HEADERS_MAX_BYTES {
        return Err(format!(
            "{UPSTREAM_HEADERS_HEADER} exceeds {UPSTREAM_HEADERS_MAX_BYTES} bytes"
        ));
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("{UPSTREAM_HEADERS_HEADER} is not valid base64: {error}"))?;
    if decoded.len() > UPSTREAM_HEADERS_MAX_BYTES {
        return Err(format!(
            "{UPSTREAM_HEADERS_HEADER} exceeds {UPSTREAM_HEADERS_MAX_BYTES} bytes"
        ));
    }
    let parsed: serde_json::Map<String, Value> =
        serde_json::from_slice(&decoded).map_err(|error| {
            format!("{UPSTREAM_HEADERS_HEADER} is not a valid JSON object: {error}")
        })?;

    let mut overrides = Vec::with_capacity(parsed.len());
    for (name, value) in parsed {
        let Value::String(value) = value else {
            return Err(format!(
                "{UPSTREAM_HEADERS_HEADER} entry \"{name}\" must be a string"
            ));
        };
        let header_name =
            HeaderName::from_bytes(name.to_ascii_lowercase().as_bytes()).map_err(|_| {
                format!("{UPSTREAM_HEADERS_HEADER} entry \"{name}\" is not a valid header name")
            })?;
        if is_protected_upstream_override(&header_name) {
            continue;
        }
        let header_value = HeaderValue::from_str(&value).map_err(|_| {
            format!("{UPSTREAM_HEADERS_HEADER} entry \"{name}\" has a value that is not valid for an HTTP header")
        })?;
        overrides.push((header_name, header_value));
    }
    Ok(overrides)
}

fn build_upstream_request_headers(headers: &HeaderMap) -> Result<HeaderMap, String> {
    let mut upstream_headers = HeaderMap::new();
    for (name, value) in headers {
        if should_forward_request_header(name) {
            upstream_headers.append(name, value.clone());
        }
    }
    // 覆盖包是转发前的最后一步：insert 替换掉 SDK 或 WebView 注入的同名头，
    // 让「自定义请求头覆盖内置默认头」在任意头名上都成立。
    if let Some(encoded) = headers.get(UPSTREAM_HEADERS_HEADER) {
        let encoded = encoded
            .to_str()
            .map_err(|_| format!("{UPSTREAM_HEADERS_HEADER} must be ASCII"))?;
        for (name, value) in decode_upstream_header_overrides(encoded)? {
            upstream_headers.insert(name, value);
        }
    }
    Ok(upstream_headers)
}

fn should_forward_response_header(name: &HeaderName) -> bool {
    let lowered = name.as_str();
    !matches!(
        lowered,
        CONTENT_LENGTH
            | CONNECTION
            | KEEP_ALIVE
            | PROXY_CONNECTION
            | PROXY_AUTHENTICATE
            | PROXY_AUTHORIZATION
            | TE
            | TRAILER
            | TRANSFER_ENCODING
            | UPGRADE
            | "vary"
    ) && !lowered.starts_with(ACCESS_CONTROL_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_target_url_for_openai_v1_responses() {
        let target = build_target_url(
            "codex",
            "/proxy/codex/v1/responses",
            "https://api.openai.com",
        )
        .expect("target url should be built");

        assert_eq!(target.as_str(), "https://api.openai.com/v1/responses");
    }

    #[test]
    fn builds_target_url_for_nested_vendor_path() {
        let target = build_target_url(
            "claude_code",
            "/proxy/claude_code/api/coding/v1/messages?stream=true",
            "https://ark.cn-beijing.volces.com",
        )
        .expect("target url should be built");

        assert_eq!(
            target.as_str(),
            "https://ark.cn-beijing.volces.com/api/coding/v1/messages?stream=true"
        );
    }

    #[test]
    fn rejects_scheme_relative_proxy_suffix() {
        let err = build_target_url("hub", "/proxy/hub//servers/foo", "https://api.smithery.ai")
            .expect_err("scheme-relative suffix must be rejected");

        assert!(err.contains("//"));
    }

    #[test]
    fn builds_target_url_for_origin_root_with_query() {
        let target = build_target_url("hub", "/proxy/hub?probe=1", "https://clawhub.ai")
            .expect("root query target url should be built");

        assert_eq!(target.as_str(), "https://clawhub.ai/?probe=1");
    }

    #[test]
    fn rejects_upstream_origin_with_path() {
        let err = build_target_url(
            "codex",
            "/proxy/codex/v1/responses",
            "https://api.openai.com/v1",
        )
        .expect_err("origin with path should be rejected");

        assert!(err.contains("scheme, host, and port"));
    }

    #[test]
    fn echoes_requested_preflight_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static(ACCESS_CONTROL_REQUEST_HEADERS),
            HeaderValue::from_static("authorization,x-api-key,x-liveagent-proxy-token"),
        );

        assert_eq!(
            build_allow_headers_value(&headers),
            HeaderValue::from_static("authorization,x-api-key,x-liveagent-proxy-token")
        );
    }

    #[test]
    fn validates_image_proxy_urls() {
        assert!(validate_image_proxy_url("https://example.com/photo.png").is_ok());
        assert!(validate_image_proxy_url("http://example.com/photo.png").is_ok());
        assert!(validate_image_proxy_url("file:///tmp/photo.png").is_err());
        assert!(validate_image_proxy_url("https://user:pass@example.com/photo.png").is_err());
    }

    #[test]
    fn builds_origin_referer_for_image_proxy_requests() {
        let url = validate_image_proxy_url("https://example.com:8443/path/photo.png?size=large")
            .expect("image proxy url should be valid");

        assert_eq!(image_proxy_referer(&url), "https://example.com:8443/");
    }

    #[test]
    fn applies_image_proxy_request_headers() {
        let url = validate_image_proxy_url("https://example.com/path/photo.png")
            .expect("image proxy url should be valid");
        let request =
            apply_image_proxy_request_headers(reqwest::Client::new().get(url.clone()), &url)
                .build()
                .expect("request should be built");

        assert_eq!(
            request
                .headers()
                .get("Accept")
                .and_then(|value| value.to_str().ok()),
            Some(IMAGE_PROXY_ACCEPT)
        );
        assert_eq!(
            request
                .headers()
                .get("Accept-Language")
                .and_then(|value| value.to_str().ok()),
            Some(IMAGE_PROXY_ACCEPT_LANGUAGE)
        );
        assert_eq!(
            request
                .headers()
                .get("User-Agent")
                .and_then(|value| value.to_str().ok()),
            Some(IMAGE_PROXY_USER_AGENT)
        );
        assert_eq!(
            request
                .headers()
                .get("Referer")
                .and_then(|value| value.to_str().ok()),
            Some("https://example.com/")
        );
    }

    #[test]
    fn strips_proxy_and_hop_by_hop_request_headers() {
        assert!(!should_forward_request_header(&HeaderName::from_static(
            "host"
        )));
        assert!(!should_forward_request_header(&HeaderName::from_static(
            "origin"
        )));
        assert!(!should_forward_request_header(&HeaderName::from_static(
            "connection"
        )));
        assert!(!should_forward_request_header(&HeaderName::from_static(
            PROXY_TOKEN_HEADER
        )));
        assert!(!should_forward_request_header(&HeaderName::from_static(
            UPSTREAM_ORIGIN_HEADER
        )));
        assert!(should_forward_request_header(&HeaderName::from_static(
            "authorization"
        )));
        assert!(should_forward_request_header(&HeaderName::from_static(
            "x-api-key"
        )));
        assert!(should_forward_request_header(&HeaderName::from_static(
            "anthropic-version"
        )));
    }

    #[test]
    fn applies_explicit_upstream_header_overrides_last() {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("user-agent"),
            HeaderValue::from_static("WebView/1.0"),
        );
        headers.insert(
            HeaderName::from_static(CONTENT_TYPE),
            HeaderValue::from_static("application/json"),
        );
        headers.insert(
            HeaderName::from_static(UPSTREAM_HEADERS_HEADER),
            encoded_overrides(serde_json::json!({
                "User-Agent": "codex_cli_rs/0.72.0",
                "Content-Type": "application/custom+json",
                "X-Request-Id": "trace-1",
            })),
        );

        let upstream_headers = build_upstream_request_headers(&headers).expect("overrides decode");

        assert_eq!(
            header_str(&upstream_headers, "user-agent"),
            Some("codex_cli_rs/0.72.0")
        );
        assert_eq!(
            header_str(&upstream_headers, CONTENT_TYPE),
            Some("application/custom+json")
        );
        assert_eq!(
            header_str(&upstream_headers, "x-request-id"),
            Some("trace-1")
        );
        assert!(!upstream_headers.contains_key(UPSTREAM_HEADERS_HEADER));
    }

    #[test]
    fn upstream_overrides_restore_browser_forbidden_header_names() {
        // WebView 的 fetch 根本不会发出 Cookie / Referer；常规拷贝过滤器还会主动
        // 剥掉浏览器注入的 Referer。用户显式配置的同名头必须仍然送达上游。
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static(REFERER),
            HeaderValue::from_static("http://tauri.localhost"),
        );
        headers.insert(
            HeaderName::from_static(UPSTREAM_HEADERS_HEADER),
            encoded_overrides(serde_json::json!({
                "Cookie": "session=abc",
                "Referer": "https://relay.example/app",
            })),
        );

        let upstream_headers = build_upstream_request_headers(&headers).expect("overrides decode");

        assert_eq!(header_str(&upstream_headers, "cookie"), Some("session=abc"));
        assert_eq!(
            header_str(&upstream_headers, REFERER),
            Some("https://relay.example/app")
        );
    }

    #[test]
    fn upstream_overrides_skip_protected_header_names() {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static(UPSTREAM_HEADERS_HEADER),
            encoded_overrides(serde_json::json!({
                "Host": "attacker.example",
                "Content-Length": "0",
                "Connection": "close",
                "x-liveagent-proxy-token": "leaked",
                "X-Kept": "yes",
            })),
        );

        let upstream_headers = build_upstream_request_headers(&headers).expect("overrides decode");

        assert_eq!(header_str(&upstream_headers, "x-kept"), Some("yes"));
        for protected in ["host", "content-length", "connection", PROXY_TOKEN_HEADER] {
            assert!(
                !upstream_headers.contains_key(protected),
                "{protected} must not be settable through the override channel"
            );
        }
    }

    #[test]
    fn upstream_overrides_reject_malformed_payloads() {
        for encoded in ["not-base64!!", "eyJhIjo="] {
            assert!(decode_upstream_header_overrides(encoded).is_err());
        }
        // 合法 base64 但不是 JSON 对象
        assert!(decode_upstream_header_overrides(
            &base64::engine::general_purpose::STANDARD.encode(b"[1,2,3]")
        )
        .is_err());
        // 非字符串取值
        assert!(decode_upstream_header_overrides(
            &base64::engine::general_purpose::STANDARD.encode(br#"{"X-A":1}"#)
        )
        .is_err());
        // 头名非法
        assert!(decode_upstream_header_overrides(
            &base64::engine::general_purpose::STANDARD.encode(br#"{"Bad Header":"v"}"#)
        )
        .is_err());
        // 取值含 CR/LF（header 注入）
        assert!(decode_upstream_header_overrides(
            &base64::engine::general_purpose::STANDARD.encode(b"{\"X-A\":\"a\\r\\nb\"}")
        )
        .is_err());
        // 超限
        let oversized = "A".repeat(UPSTREAM_HEADERS_MAX_BYTES + 4);
        assert!(decode_upstream_header_overrides(&oversized).is_err());
    }

    fn encoded_overrides(value: serde_json::Value) -> HeaderValue {
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(&value).expect("serialize overrides"));
        HeaderValue::from_str(&encoded).expect("override header value")
    }

    fn header_str<K>(headers: &HeaderMap, name: K) -> Option<&str>
    where
        K: axum::http::header::AsHeaderName,
    {
        headers.get(name).and_then(|value| value.to_str().ok())
    }
}
