use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener, ToSocketAddrs},
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
const UPSTREAM_URL_HEADER: &str = "x-liveagent-upstream-url";
const UPSTREAM_HEADERS_HEADER: &str = "x-liveagent-upstream-headers";
const UPSTREAM_HEADERS_MAX_BYTES: usize = 8 * 1024;
const USE_SYSTEM_PROXY_HEADER: &str = "x-liveagent-use-system-proxy";
const DEFAULT_ALLOW_HEADERS: &str = "authorization,content-type,x-api-key,x-goog-api-key,anthropic-version,x-liveagent-upstream-origin,x-liveagent-upstream-url,x-liveagent-upstream-headers,x-liveagent-proxy-token,x-liveagent-use-system-proxy";
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
    // 纵深防御:非 WebView 来源的 fetch(恶意网页)直接拒绝。
    if !image_proxy_origin_allowed(&headers) {
        return error_response(
            StatusCode::FORBIDDEN,
            "Image proxy origin is not allowed",
            &headers,
        );
    }
    let target_url = match validate_image_proxy_url(&query.url) {
        Ok(url) => url,
        Err(message) => return error_response(StatusCode::BAD_REQUEST, &message, &headers),
    };
    // 连接前解析:主机名若解析到回环/内网/元数据段(DNS rebinding),在出网前拒绝。
    if image_proxy_host_resolves_to_blocked(&target_url).await {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Image URL host resolves to a blocked IP range",
            &headers,
        );
    }

    // 图片外链与商店链路同语义:恒随应用代理出网(未启用=直连,配置异常
    // 502 fail fast)。<img> 请求无法携带自定义头,因此不走 per-request 开关。
    // 走 async_client_builder 而非 cached_client:reqwest 0.13 的重定向策略是
    // client 级配置,每次 30x 跳转都要重新校验目标(字面 IP + DNS 解析),
    // 公网 URL 经重定向指向内网地址的链路在此被切断。
    let client = match crate::services::system_proxy::async_client_builder() {
        Ok(builder) => builder
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if validate_image_proxy_redirect_target(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build(),
        Err(error) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                &format!("App proxy unavailable: {error}"),
                &headers,
            );
        }
    };
    let client = match client {
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
    // SSRF 防护:拒绝指向本机/内网/云元数据/保留段的字面 IP 目标(与网关 Go 侧
    // outbound_http.go 的 blocked prefixes 对齐)。本地代理以应用身份出网,
    // 若放行 127.0.0.1 / 169.254.169.254 等目标,任何本机页面或提示注入的
    // 模型输出图片 URL 都能用它探测/访问内网服务。注意:图片外链(<img>)请求
    // 不带 Origin,来源校验挡不住,此处是唯一且必须的主防线。
    if let Some(host) = url.host_str() {
        let host = host.trim_start_matches('[').trim_end_matches(']');
        // 回环主机名(无拨号时 DNS 检查,字面拦截,与 Go 侧 127.0.0.0/8 等价)。
        let host_lower = host.to_ascii_lowercase();
        if host_lower == "localhost" || host_lower == "localhost.localdomain" {
            return Err("Image URL host is in a blocked IP range".to_string());
        }
        if let Ok(ip) = host.parse::<IpAddr>() {
            if is_blocked_image_proxy_ip(ip) {
                return Err("Image URL host is in a blocked IP range".to_string());
            }
        }
    }
    Ok(url)
}

/// 判断 IPv4 字面地址是否属于禁止出网访问的段(与 Go 侧 outbound_http.go 对齐,
/// 出站代理语义:回环/私网/link-local/多播/保留全部拒绝)。
fn is_blocked_image_proxy_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    let [a, b, c, _] = octets;
    // 0.0.0.0/8、10.0.0.0/8、127.0.0.0/8、169.254.0.0/16、172.16.0.0/12、
    // 192.0.0.0/24、192.0.2.0/24、192.88.99.0/24、192.168.0.0/16、
    // 198.18.0.0/15、198.51.100.0/24、203.0.113.0/24、224.0.0.0/4、
    // 240.0.0.0/4(含广播)、100.64.0.0/10
    (a == 0)
        || (a == 10)
        || (a == 100 && (64..=127).contains(&b))
        || (a == 127)
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (18..=19).contains(&b))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || (a >= 224)
}

/// 统一入口:IPv4-mapped IPv6(::ffff:a.b.c.d)先 unmap 还原为 IPv4 再走
/// IPv4 黑名单(与网关 Go 侧 outbound_http.go 的 Unmap() 先例一致)。
fn is_blocked_image_proxy_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_image_proxy_ipv4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_blocked_image_proxy_ipv4(v4),
            None => is_blocked_image_proxy_ipv6(v6),
        },
    }
}

fn ipv6_in_range(addr: Ipv6Addr, network: Ipv6Addr, prefix_len: u32) -> bool {
    if prefix_len == 0 {
        return true;
    }
    let mask = u128::MAX << (128 - prefix_len);
    (u128::from_be_bytes(addr.octets()) & mask) == (u128::from_be_bytes(network.octets()) & mask)
}

/// IPv6 禁止段,与 Go 侧 outbound_http.go 的 blocked prefixes 逐项对齐:
/// 未指定/回环、NAT64、Discard-only、Teredo/文档段、6to4、ULA、link-local、多播。
fn is_blocked_image_proxy_ipv6(ip: Ipv6Addr) -> bool {
    const BLOCKED_PREFIXES: &[(&str, u32)] = &[
        ("::", 128),
        ("::1", 128),
        ("64:ff9b::", 96),
        ("64:ff9b:1::", 48),
        ("100::", 64),
        ("2001::", 23),
        ("2001::", 32),
        ("2001:2::", 48),
        ("2001:10::", 28),
        ("2001:20::", 28),
        ("2001:db8::", 32),
        ("2002::", 16),
        ("3fff::", 20),
        ("5f00::", 16),
        ("fc00::", 7),
        ("fe80::", 10),
        ("ff00::", 8),
    ];
    BLOCKED_PREFIXES.iter().any(|(network, prefix_len)| {
        // 静态字面量在编译期已由 Go 侧同表验证格式,parse 不会失败。
        let network = network
            .parse::<Ipv6Addr>()
            .expect("static blocked ipv6 prefix must parse");
        ipv6_in_range(ip, network, *prefix_len)
    })
}

/// 解析目标主机的全部地址,任一命中黑名单即拒绝(fail-closed:解析失败也拒绝)。
/// 覆盖 DNS rebinding——攻击者域名可解析到回环/内网地址,字面校验挡不住。
async fn image_proxy_host_resolves_to_blocked(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return true;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    // 字面 IP 已在 validate_image_proxy_url 中校验,这里只处理主机名。
    if host.parse::<IpAddr>().is_ok() {
        return false;
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let addresses = match tokio::net::lookup_host((host, port)).await {
        Ok(addresses) => addresses,
        Err(_) => return true,
    };
    addresses
        .into_iter()
        .any(|address| is_blocked_image_proxy_ip(address.ip()))
}

/// 重定向目标的校验(每次跳转都重新过一遍):scheme/凭据/字面 IP/主机名解析
/// 全部地址。主机名解析为同步阻塞调用——重定向跳数极少且受 OS DNS 超时约束,
/// 在 reqwest 同步 redirect policy 回调内是唯一可行形态;失败一律拒绝(fail-closed)。
fn validate_image_proxy_redirect_target(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let host_lower = host.to_ascii_lowercase();
    if host_lower == "localhost" || host_lower == "localhost.localdomain" {
        return false;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return !is_blocked_image_proxy_ip(ip);
    }
    let port = url.port_or_known_default().unwrap_or(80);
    match (host, port).to_socket_addrs() {
        Ok(addresses) => !addresses
            .into_iter()
            .any(|address| is_blocked_image_proxy_ip(address.ip())),
        Err(_) => false,
    }
}

/// 本地来源校验:image-proxy 端点无 token(<img> 无法携带自定义头),以 Origin
/// 白名单作纵深防御——只允许空 Origin(非浏览器)、Tauri WebView 来源或同源
/// 请求;恶意网页的 fetch 携带其自身 Origin,会被拒绝。注意浏览器 <img> 请求
/// 不带 Origin,该检查不拦截 img 路径(由上面的 IP 黑名单兜底)。
fn image_proxy_origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) else {
        return true;
    };
    let origin = origin.trim();
    if origin.is_empty() {
        return true;
    }
    match origin.to_ascii_lowercase().as_str() {
        // Tauri WebView 的来源(Windows/macOS/Linux 桌面)。
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost" => true,
        _ => false,
    }
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
    let upstream_url = match headers.get(UPSTREAM_URL_HEADER) {
        Some(value) => match value.to_str() {
            Ok(value) => Some(value),
            Err(_) => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    &format!("Request header is not valid UTF-8: {UPSTREAM_URL_HEADER}"),
                    &headers,
                )
            }
        },
        None => None,
    };
    let target_result = match upstream_url {
        Some(upstream_url) => {
            build_full_target_url(upstream_url, upstream_origin, original_uri.query())
        }
        None => build_target_url(&provider, original_path_and_query, upstream_origin),
    };
    let target_url = match target_result {
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

fn build_full_target_url(
    upstream_url: &str,
    upstream_origin: &str,
    passthrough_query: Option<&str>,
) -> Result<Url, String> {
    let origin =
        Url::parse(upstream_origin).map_err(|err| format!("Invalid upstream Origin: {err}"))?;
    if !origin.has_host() || !origin.username().is_empty() || origin.password().is_some() {
        return Err("Upstream Origin must be a valid absolute URL".to_string());
    }
    if origin.path() != "/" || origin.query().is_some() || origin.fragment().is_some() {
        return Err("Upstream Origin may contain only the scheme, host, and port".to_string());
    }

    let mut target =
        Url::parse(upstream_url.trim()).map_err(|err| format!("Invalid upstream URL: {err}"))?;
    if !matches!(target.scheme(), "http" | "https")
        || !target.has_host()
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err(
            "Upstream URL must be a valid HTTP(S) absolute URL without credentials".to_string(),
        );
    }
    if target.fragment().is_some() {
        return Err("Upstream URL cannot include a fragment".to_string());
    }
    if target.origin() != origin.origin() {
        return Err("Upstream URL must use the configured upstream Origin".to_string());
    }

    append_missing_query_pairs(&mut target, passthrough_query);
    Ok(target)
}

fn append_missing_query_pairs(target: &mut Url, passthrough_query: Option<&str>) {
    let Some(passthrough_query) = passthrough_query.filter(|query| !query.is_empty()) else {
        return;
    };
    let existing = target.query().unwrap_or_default();
    let existing_keys = existing
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| part.split_once('=').map_or(part, |(key, _)| key))
        .collect::<Vec<_>>();
    let additions = passthrough_query
        .split('&')
        .filter(|part| !part.is_empty())
        .filter(|part| {
            let key = part.split_once('=').map_or(*part, |(key, _)| key);
            !existing_keys.contains(&key)
        })
        .collect::<Vec<_>>();
    if additions.is_empty() {
        return;
    }
    let next = if existing.is_empty() {
        additions.join("&")
    } else {
        format!("{existing}&{}", additions.join("&"))
    };
    target.set_query(Some(&next));
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
    fn full_url_ignores_sdk_path_and_preserves_required_query() {
        let target = build_full_target_url(
            "https://relay.example.com/custom/final?region=cn",
            "https://relay.example.com",
            Some("alt=sse&region=ignored"),
        )
        .expect("full target url should be built");

        assert_eq!(
            target.as_str(),
            "https://relay.example.com/custom/final?region=cn&alt=sse"
        );
    }

    #[test]
    fn full_url_must_match_the_configured_origin() {
        let error = build_full_target_url(
            "https://other.example.com/v1/responses",
            "https://relay.example.com",
            None,
        )
        .expect_err("mismatched full URL origin must be rejected");

        assert!(error.contains("configured upstream Origin"));
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
    fn forwards_openrouter_session_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("x-session-id"),
            HeaderValue::from_static("session-123"),
        );

        let upstream_headers =
            build_upstream_request_headers(&headers).expect("build upstream headers");
        assert_eq!(
            upstream_headers.get("x-session-id"),
            Some(&HeaderValue::from_static("session-123"))
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
    fn rejects_ssrf_targets_in_image_proxy_urls() {
        // 回环 / 私网 / 云元数据 / link-local / 多播 / 保留 / 广播段全部拒绝。
        for value in [
            "http://127.0.0.1:3000/admin",
            "http://localhost:3000/admin",
            "http://[::1]:5173",
            "http://10.0.0.5:80/",
            "http://172.16.0.1:80/",
            "http://192.168.1.1:80/",
            "http://169.254.169.254/latest/meta-data/",
            "http://169.254.170.2/",
            "http://100.64.0.1:80/",
            "http://224.0.0.1:80/",
            "http://255.255.255.255:80/",
            "http://0.0.0.0:80/",
            "http://192.0.2.1:80/",
            "http://198.51.100.1:80/",
            "http://203.0.113.1:80/",
        ] {
            assert!(validate_image_proxy_url(value).is_err(), "{value}");
        }

        // 公网字面 IP 与域名不受影响。
        assert!(validate_image_proxy_url("http://8.8.8.8:8080/photo.png").is_ok());
        assert!(validate_image_proxy_url("https://example.com/photo.png").is_ok());
    }

    #[test]
    fn rejects_ipv6_and_mapped_ssrf_targets_in_image_proxy_urls() {
        // IPv6 禁止段:ULA / link-local / 多播 / 未指定 / NAT64 / 文档段。
        for value in [
            "http://[fc00::1]:80/",
            "http://[fd00:abcd::1]:80/",
            "http://[fe80::1]:80/",
            "http://[ff02::1]:80/",
            "http://[::]:80/",
            "http://[64:ff9b::1]:80/",
            "http://[2001:db8::1]:80/",
            "http://[2002:7f00:1::1]:80/",
        ] {
            assert!(validate_image_proxy_url(value).is_err(), "{value}");
        }

        // IPv4-mapped IPv6 先 unmap 再走 IPv4 黑名单:
        // ::ffff:127.0.0.1 / ::ffff:169.254.169.254 不得绕过。
        for value in [
            "http://[::ffff:127.0.0.1]:80/",
            "http://[::ffff:169.254.169.254]:80/latest/meta-data/",
            "http://[::ffff:10.0.0.5]:80/",
            "http://[::ffff:192.168.1.1]:80/",
        ] {
            assert!(validate_image_proxy_url(value).is_err(), "{value}");
        }

        // 公网 IPv6 与 mapped 公网 IPv4 不受影响。
        assert!(validate_image_proxy_url("http://[2001:4860:4860::8888]:80/").is_ok());
        assert!(validate_image_proxy_url("http://[2606:4700:4700::1111]:80/").is_ok());
        assert!(validate_image_proxy_url("http://[::ffff:8.8.8.8]:80/").is_ok());
    }

    #[test]
    fn image_proxy_redirect_targets_revalidate_every_hop() {
        // 字面 IP / 主机名 / mapped / scheme / 凭据的拒绝路径。
        for value in [
            "http://127.0.0.1:8080/next",
            "http://localhost:3000/next",
            "http://[::1]:5173/next",
            "http://[::ffff:127.0.0.1]:80/next",
            "http://[fe80::1]:80/next",
            "ftp://example.com/file",
            "https://user:pass@example.com/file",
        ] {
            let url = Url::parse(value).expect("redirect target url parses");
            assert!(!validate_image_proxy_redirect_target(&url), "{value}");
        }

        // 主机名解析到回环地址同样拒绝(DNS rebinding 的跳转形态)。
        // "localhost." 带尾点,不命中字面 localhost 拦截,但解析结果命中黑名单。
        let trailing_dot = Url::parse("http://localhost.:8080/next").expect("trailing-dot parses");
        assert!(
            !validate_image_proxy_redirect_target(&trailing_dot),
            "localhost. resolves to loopback and must be rejected"
        );

        // 公网字面 IP 放行(不依赖外部 DNS)。
        let public = Url::parse("http://8.8.8.8:80/photo.png").expect("public ip parses");
        assert!(validate_image_proxy_redirect_target(&public));
    }

    #[tokio::test]
    async fn image_proxy_dns_precheck_rejects_loopback_resolution() {
        // 主机名解析到回环地址:在出网前拒绝(fail-closed)。
        let localhost = Url::parse("http://localhost.:8080/photo.png").expect("localhost parses");
        assert!(image_proxy_host_resolves_to_blocked(&localhost).await);

        // 字面 IP 不做 DNS 解析(已在 validate 层拦截,这里直接放行给上层)。
        let literal = Url::parse("http://8.8.8.8:80/photo.png").expect("literal parses");
        assert!(!image_proxy_host_resolves_to_blocked(&literal).await);

        // 无法解析的域名按拒绝处理(fail-closed)。
        let nonexistent = Url::parse("http://nonexistent.invalid/photo.png").expect("parses");
        assert!(image_proxy_host_resolves_to_blocked(&nonexistent).await);
    }

    #[test]
    fn image_proxy_origin_check_blocks_foreign_web_pages() {
        use axum::http::HeaderMap;

        let empty = HeaderMap::new();
        assert!(image_proxy_origin_allowed(&empty), "no Origin allowed");

        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("origin", origin.parse().unwrap());
            assert!(image_proxy_origin_allowed(&headers), "{origin}");
        }

        for origin in ["https://evil.example", "http://127.0.0.1:3000", "null"] {
            let mut headers = HeaderMap::new();
            headers.insert("origin", origin.parse().unwrap());
            assert!(!image_proxy_origin_allowed(&headers), "{origin}");
        }
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
                "User-Agent": "custom-agent/1.0",
                "Content-Type": "application/custom+json",
                "X-Request-Id": "trace-1",
            })),
        );

        let upstream_headers = build_upstream_request_headers(&headers).expect("overrides decode");

        assert_eq!(
            header_str(&upstream_headers, "user-agent"),
            Some("custom-agent/1.0")
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
