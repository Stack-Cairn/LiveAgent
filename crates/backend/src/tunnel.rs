//! 隧道数据面:每条隧道一个独立监听端口,原样反代到本机目标。
//!
//! ## 为什么是「一隧道一端口」
//!
//! 挂子路径(`/t/<id>/`)时,dev server 吐的 `<script src="/assets/main.js">`
//! 会打到隧道之外,于是必须重写它发出的每一个 URL——HTML 属性、CSS `url()`、
//! 以及运行时的 fetch/XHR/WebSocket(Go 版 `tunnel_rewrite.go` 约 1000 行)。
//!
//! 独立端口下这个绝对路径本来就是对的。**重写代码为 0 行**——不是写得更好,
//! 是整类问题不存在。这就是「重新设计数据结构让特殊情况消失」。
//!
//! ## 认证
//!
//! 浏览器标签页发不了 `Authorization` 头,所以后端密码在这里用不上。改用:
//!
//! ```text
//! 首访 http://host:port/?t=<token>  →  校验 → Set-Cookie → 302 到干净路径
//! 后续 http://host:port/...          →  带 cookie 直接放行
//! ```
//!
//! 这与旧架构靠「不可猜的 slug」做能力凭证是同一强度,但更好一点:端口可以被
//! 扫到,token 不能。token 常量时间比较,与主 API 的密码校验同一标准。

use std::collections::HashMap;
use std::net::{Ipv4Addr, TcpListener};
use std::sync::{Arc, Mutex};

use crate::services::tunnel::{TunnelBinding, TunnelDataPlane as TunnelDataPlaneTrait};
use axum::body::Body;
use axum::extract::ws::{Message as AxumMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use subtle::ConstantTimeEq;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// 首访 token 的 query 参数名。
const ACCESS_QUERY_KEY: &str = "t";

/// 放行 cookie 的名字。带隧道 id 后缀,这样多条隧道的 cookie 互不覆盖
/// （虽然端口不同本就隔离，但同源策略对 cookie 只看域名不看端口）。
const ACCESS_COOKIE_PREFIX: &str = "liveagent_tunnel_";

/// 逐跳头:按 RFC 9110,代理必须剥掉这些,不能转发给上游。
fn is_hop_by_hop(name: &str, request: bool) -> bool {
    match name.to_ascii_lowercase().as_str() {
        "connection"
        | "keep-alive"
        | "proxy-authenticate"
        | "proxy-authorization"
        | "proxy-connection"
        | "te"
        | "trailer"
        | "transfer-encoding"
        | "upgrade" => true,
        // Host 必须换成上游的，否则 dev server 的 vhost 匹配会错。
        "host" => request,
        _ => false,
    }
}

/// 单条隧道的运行句柄。drop 掉 sender 即通知监听和所有在途 WebSocket 桥退出——
/// 「关隧道」必须切断已建立的会话,不然撤销只是不再接新连接。
struct RunningTunnel {
    _shutdown: watch::Sender<()>,
}

/// 所有在跑的隧道监听。
///
/// `HashMap<id, RunningTunnel>` —— 移除一条即触发它的 `Drop`,监听随之关闭。
/// 不需要单独的 stop 逻辑,这是让「关隧道」这个特殊情况消失的最省事写法。
#[derive(Default)]
pub struct TunnelDataPlane {
    running: Mutex<HashMap<String, RunningTunnel>>,
}

impl TunnelDataPlane {
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前在跑的隧道数量。诊断与测试用。
    pub fn running_count(&self) -> usize {
        self.running.lock().map(|r| r.len()).unwrap_or(0)
    }
}

impl TunnelDataPlaneTrait for TunnelDataPlane {
    /// 起一条隧道的监听,返回内核分配的实际端口。
    ///
    /// 端口由**这里**分配并全程持有:`TcpListener::bind(port 0)` 拿到的 listener
    /// 直接交给 axum,中间没有释放窗口。所以不存在「探测到端口 → 释放 →
    /// 重绑时已被抢走」的竞态——这正是端口分配放在数据面而不是 store 的原因。
    fn start(&self, binding: TunnelBinding) -> Result<u16, String> {
        // 同 id 已在跑就先停掉：update 改目标要重建监听。
        self.stop(&binding.id);

        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .map_err(|e| format!("隧道 {} 绑定端口失败：{e}", binding.id))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("隧道 {} 设置 nonblocking 失败：{e}", binding.id))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("隧道 {} 读取端口失败：{e}", binding.id))?
            .port();

        let (shutdown_tx, shutdown_rx) = watch::channel(());
        let state = Arc::new(TunnelProxyState {
            id: binding.id.clone(),
            target: binding.target_url.clone(),
            access_token: binding.access_token.clone(),
            shutdown: shutdown_rx,
            client: reqwest::Client::builder()
                // 目标恒为本机/内网：显式忽略环境代理，否则 OS 级 HTTP_PROXY
                // 会劫持本地转发，隧道直接不可用。
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| format!("创建隧道 HTTP 客户端失败：{e}"))?,
        });

        let mut shutdown = state.shutdown.clone();
        let app = Router::new()
            .fallback(handle_tunnel_request)
            .with_state(state);
        let id = binding.id.clone();
        tokio::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("隧道 {id} 转换监听器失败：{error}");
                    return;
                }
            };
            // sender 被 drop（stop / 重建）→ changed() 出错 → 触发关闭。
            let server = axum::serve(listener, app).with_graceful_shutdown(async move {
                let _ = shutdown.changed().await;
            });
            if let Err(error) = server.await {
                eprintln!("隧道 {id} 的监听意外退出：{error}");
            }
        });

        match self.running.lock() {
            Ok(mut running) => {
                running.insert(
                    binding.id,
                    RunningTunnel {
                        _shutdown: shutdown_tx,
                    },
                );
                Ok(port)
            }
            // 拿不到锁直接返回错误：shutdown_tx 随之 drop，刚起的服务自行关闭，
            // 不会留下没人管得着的监听。
            Err(_) => Err("tunnel data plane lock poisoned".to_string()),
        }
    }

    fn stop(&self, tunnel_id: &str) {
        if let Ok(mut running) = self.running.lock() {
            running.remove(tunnel_id);
        }
    }
}

struct TunnelProxyState {
    id: String,
    target: String,
    access_token: String,
    /// sender 一 drop（隧道被关/重建）就触发,WS 桥靠它在关隧道时立刻断开。
    shutdown: watch::Receiver<()>,
    client: reqwest::Client,
}

/// 常量时间比较访问 token。与主 API 的密码校验同一标准:长度不等也走完比较,
/// 不给出可用于推断长度的时序差异。
fn token_matches(expected: &str, presented: &str) -> bool {
    let expected = expected.as_bytes();
    let presented = presented.as_bytes();
    let len_eq = expected.len() == presented.len();
    let to_compare = if len_eq {
        presented.to_vec()
    } else {
        vec![0u8; expected.len()]
    };
    let data_eq: bool = expected.ct_eq(&to_compare).into();
    len_eq && data_eq
}

fn cookie_name(tunnel_id: &str) -> String {
    format!("{ACCESS_COOKIE_PREFIX}{tunnel_id}")
}

/// 从 Cookie 头里取某个 cookie 的值。
fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let part = part.trim();
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        if key.trim() == name {
            return Some(value.trim().to_string());
        }
    }
    None
}

/// 从 query string 里取 `t` 参数,并返回剥掉它之后的 query。
///
/// 剥掉是为了 302 到干净路径——token 留在地址栏会被用户复制粘贴到别处,
/// 也会进浏览器历史和 Referer。
fn take_access_token(query: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(query) = query else {
        return (None, None);
    };
    let mut token = None;
    let mut rest = Vec::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => (pair, ""),
        };
        if key == ACCESS_QUERY_KEY && token.is_none() {
            token = Some(percent_decode(value));
        } else {
            rest.push(pair);
        }
    }
    let rest = (!rest.is_empty()).then(|| rest.join("&"));
    (token, rest)
}

/// 最小 percent-decode。token 是 base64url(只含 `A-Za-z0-9_-`),正常情况下
/// 不会被编码;但浏览器/中间件可能顺手编码,这里兜住。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 认证判定的三种结果。抽成枚举而不是在 handler 里塞 if/else,
/// 是为了让它可以被单测——handler 本身要跑网络,测不了。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AccessDecision {
    /// 放行,继续反代。
    Allow,
    /// token 正确:种 cookie 并 302 到剥掉 token 的路径。
    GrantAndRedirect { location: String },
    /// 没有有效凭证。
    Deny,
}

/// 判定一次请求能否访问隧道。纯函数,不碰网络。
pub(crate) fn decide_access(
    expected_token: &str,
    tunnel_id: &str,
    headers: &HeaderMap,
    path: &str,
    query: Option<&str>,
) -> AccessDecision {
    // 先看 query 里的 token：带对了就换成 cookie，链接可以反复使用。
    let (presented, rest) = take_access_token(query);
    if let Some(presented) = presented {
        if token_matches(expected_token, &presented) {
            let location = match rest {
                Some(rest) => format!("{path}?{rest}"),
                None => path.to_string(),
            };
            return AccessDecision::GrantAndRedirect { location };
        }
        return AccessDecision::Deny;
    }
    // 再看 cookie。
    match cookie_value(headers, &cookie_name(tunnel_id)) {
        Some(value) if token_matches(expected_token, &value) => AccessDecision::Allow,
        _ => AccessDecision::Deny,
    }
}

/// 隧道的统一入口:先认证,再按是否 WebSocket 升级分流。
///
/// 拿整个 `Request` 而不是 `Option<WebSocketUpgrade>`:后者在 axum 0.8 需要
/// `OptionalFromRequestParts`,而 `WebSocketUpgrade` 只实现了 `FromRequestParts`。
async fn handle_tunnel_request(
    State(state): State<Arc<TunnelProxyState>>,
    request: axum::extract::Request,
) -> Response {
    let uri = request.uri().clone();
    let method = request.method().clone();
    let headers = request.headers().clone();
    let path = uri.path().to_string();
    let query = uri.query();

    match decide_access(&state.access_token, &state.id, &headers, &path, query) {
        AccessDecision::Allow => {}
        AccessDecision::GrantAndRedirect { location } => {
            // HttpOnly：页面脚本读不到 token，XSS 也偷不走。
            // SameSite=Lax：跨站请求不带 cookie，挡住 CSRF 式的隧道探测。
            // 不设 Secure：隧道是 http 的（目标就是本机 http 服务），
            // 设了浏览器会直接丢弃这个 cookie。
            let cookie = format!(
                "{}={}; Path=/; HttpOnly; SameSite=Lax",
                cookie_name(&state.id),
                state.access_token
            );
            let mut response = Response::builder()
                .status(StatusCode::FOUND)
                .header(axum::http::header::LOCATION, location)
                .body(Body::empty())
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
            if let Ok(value) = HeaderValue::from_str(&cookie) {
                response
                    .headers_mut()
                    .insert(axum::http::header::SET_COOKIE, value);
            }
            return response;
        }
        AccessDecision::Deny => {
            return (
                StatusCode::UNAUTHORIZED,
                "tunnel access token required or invalid",
            )
                .into_response();
        }
    }

    if is_websocket_upgrade(&headers) {
        let (mut parts, _) = request.into_parts();
        return match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(upgrade) => proxy_websocket(state, upgrade, uri, headers),
            Err(rejection) => rejection.into_response(),
        };
    }
    proxy_http(state, method, uri, headers, request.into_body()).await
}

/// 是否是 WebSocket 升级请求。`Connection` 是逗号分隔的 token 列表,
/// 所以要按 token 找 `upgrade` 而不是整串比较。
fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    let has_upgrade_token = headers
        .get(axum::http::header::CONNECTION)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
        })
        .unwrap_or(false);
    let is_websocket = headers
        .get(axum::http::header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);
    has_upgrade_token && is_websocket
}

/// 拼上游 URL:目标的 base path + 请求路径,query 原样带上。
///
/// 目标可以带路径(`http://localhost:3000/app`),这时请求 `/api/x` 要落到
/// `/app/api/x`——与旧实现的 `build_tunnel_upstream_url` 语义一致。
pub(crate) fn upstream_url(target: &str, uri: &Uri) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(target).map_err(|e| format!("隧道目标不是合法 URL：{e}"))?;
    let base = url.path().trim_end_matches('/').to_string();
    let path = uri.path();
    let joined = if base.is_empty() {
        path.to_string()
    } else if path == "/" {
        format!("{base}/")
    } else {
        format!("{base}{path}")
    };
    url.set_path(&joined);
    url.set_query(uri.query().filter(|q| !q.is_empty()));
    url.set_fragment(None);
    Ok(url)
}

async fn proxy_http(
    state: Arc<TunnelProxyState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let url = match upstream_url(&state.target, &uri) {
        Ok(url) => url,
        Err(error) => return (StatusCode::BAD_GATEWAY, error).into_response(),
    };

    let mut request = state.client.request(method, url);
    for (name, value) in headers.iter() {
        if is_hop_by_hop(name.as_str(), true) {
            continue;
        }
        // Cookie 头要剥掉隧道自己的那个：上游服务不该看到它，
        // 更不该有机会把它回显出去。
        if name == axum::http::header::COOKIE {
            if let Some(filtered) = strip_tunnel_cookie(value, &cookie_name(&state.id)) {
                if let Ok(value) = HeaderValue::from_str(&filtered) {
                    request = request.header(name.clone(), value);
                }
            }
            continue;
        }
        request = request.header(name.clone(), value.clone());
    }

    // 流式转发请求体：大文件上传不该先在内存里攒齐。
    let stream = body.into_data_stream();
    let request = request.body(reqwest::Body::wrap_stream(stream));

    let upstream = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("隧道目标不可达：{error}"),
            )
                .into_response()
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = Response::builder().status(status);
    for (name, value) in upstream.headers().iter() {
        if is_hop_by_hop(name.as_str(), false) {
            continue;
        }
        response = response.header(name.clone(), value.clone());
    }
    // 响应体同样流式回传。
    let stream = upstream.bytes_stream();
    response
        .body(Body::from_stream(stream))
        .unwrap_or_else(|error| {
            (
                StatusCode::BAD_GATEWAY,
                format!("组装隧道响应失败：{error}"),
            )
                .into_response()
        })
}

/// 从 Cookie 头里剥掉隧道自己的 cookie,返回剩下的;全空则返回 None。
pub(crate) fn strip_tunnel_cookie(value: &HeaderValue, name: &str) -> Option<String> {
    let raw = value.to_str().ok()?;
    let kept: Vec<&str> = raw
        .split(';')
        .map(str::trim)
        .filter(|part| {
            !part.is_empty()
                && part
                    .split_once('=')
                    .map(|(key, _)| key.trim() != name)
                    .unwrap_or(true)
        })
        .collect();
    (!kept.is_empty()).then(|| kept.join("; "))
}

fn proxy_websocket(
    state: Arc<TunnelProxyState>,
    upgrade: WebSocketUpgrade,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let mut url = match upstream_url(&state.target, &uri) {
        Ok(url) => url,
        Err(error) => return (StatusCode::BAD_GATEWAY, error).into_response(),
    };
    if url.set_scheme("ws").is_err() {
        return (StatusCode::BAD_GATEWAY, "无法构造 WebSocket 上游地址").into_response();
    }

    upgrade.on_upgrade(move |socket| async move {
        let shutdown = state.shutdown.clone();
        if let Err(error) = bridge_websocket(socket, url.clone(), headers, &state.id, shutdown).await
        {
            eprintln!("隧道 {} 的 WebSocket 转发失败：{error}", state.id);
        }
    })
}

/// 把浏览器侧的 WebSocket 与上游的 WebSocket 对接。
async fn bridge_websocket(
    downstream: WebSocket,
    url: reqwest::Url,
    headers: HeaderMap,
    tunnel_id: &str,
    mut shutdown: watch::Receiver<()>,
) -> Result<(), String> {
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("构造 WebSocket 请求失败：{e}"))?;
    // 转发子协议等业务头，但握手相关的头必须由 tungstenite 自己生成。
    let cookie_name = cookie_name(tunnel_id);
    for (name, value) in headers.iter() {
        if is_hop_by_hop(name.as_str(), true) || is_ws_handshake_header(name.as_str()) {
            continue;
        }
        if name == axum::http::header::COOKIE {
            if let Some(filtered) = strip_tunnel_cookie(value, &cookie_name) {
                if let Ok(value) = HeaderValue::from_str(&filtered) {
                    request.headers_mut().append(name.clone(), value);
                }
            }
            continue;
        }
        // Origin 换成上游自己的：dev server 常按 Origin 做同源校验，
        // 透传浏览器的 Origin 会被拒。
        if name.as_str().eq_ignore_ascii_case("origin") {
            continue;
        }
        request.headers_mut().append(name.clone(), value.clone());
    }
    if let Ok(origin) = HeaderValue::from_str(&upstream_origin(&url)) {
        request
            .headers_mut()
            .insert(HeaderName::from_static("origin"), origin);
    }

    let (upstream, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("连接上游 WebSocket 失败：{e}"))?;

    let (mut down_tx, mut down_rx) = downstream.split();
    let (mut up_tx, mut up_rx) = upstream.split();

    loop {
        tokio::select! {
            // 隧道被关闭/重建：立刻切断两侧，「撤销」必须对已打开的会话生效。
            _ = shutdown.changed() => {
                let _ = down_tx.send(AxumMessage::Close(None)).await;
                let _ = up_tx.send(WsMessage::Close(None)).await;
                break;
            }
            incoming = down_rx.next() => {
                let Some(message) = incoming else { break };
                let message = message.map_err(|e| format!("读取浏览器帧失败：{e}"))?;
                match message {
                    AxumMessage::Text(text) => up_tx
                        .send(WsMessage::Text(text.as_str().into()))
                        .await
                        .map_err(|e| format!("转发文本帧失败：{e}"))?,
                    AxumMessage::Binary(data) => up_tx
                        .send(WsMessage::Binary(data.to_vec().into()))
                        .await
                        .map_err(|e| format!("转发二进制帧失败：{e}"))?,
                    AxumMessage::Ping(data) => up_tx
                        .send(WsMessage::Ping(data.to_vec().into()))
                        .await
                        .map_err(|e| format!("转发 ping 失败：{e}"))?,
                    AxumMessage::Pong(data) => up_tx
                        .send(WsMessage::Pong(data.to_vec().into()))
                        .await
                        .map_err(|e| format!("转发 pong 失败：{e}"))?,
                    AxumMessage::Close(frame) => {
                        let close = frame.map(|f| CloseFrame {
                            code: CloseCode::from(u16::from(f.code)),
                            reason: f.reason.as_str().into(),
                        });
                        let _ = up_tx.send(WsMessage::Close(close)).await;
                        break;
                    }
                }
            }
            incoming = up_rx.next() => {
                let Some(message) = incoming else { break };
                let message = message.map_err(|e| format!("读取上游帧失败：{e}"))?;
                match message {
                    WsMessage::Text(text) => down_tx
                        .send(AxumMessage::Text(text.as_str().into()))
                        .await
                        .map_err(|e| format!("回传文本帧失败：{e}"))?,
                    WsMessage::Binary(data) => down_tx
                        .send(AxumMessage::Binary(data.to_vec().into()))
                        .await
                        .map_err(|e| format!("回传二进制帧失败：{e}"))?,
                    WsMessage::Ping(data) => down_tx
                        .send(AxumMessage::Ping(data.to_vec().into()))
                        .await
                        .map_err(|e| format!("回传 ping 失败：{e}"))?,
                    WsMessage::Pong(data) => down_tx
                        .send(AxumMessage::Pong(data.to_vec().into()))
                        .await
                        .map_err(|e| format!("回传 pong 失败：{e}"))?,
                    WsMessage::Close(frame) => {
                        let close = frame.map(|f| axum::extract::ws::CloseFrame {
                            code: u16::from(f.code),
                            reason: f.reason.as_str().into(),
                        });
                        let _ = down_tx.send(AxumMessage::Close(close)).await;
                        break;
                    }
                    WsMessage::Frame(_) => {}
                }
            }
        }
    }
    Ok(())
}

fn is_ws_handshake_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "sec-websocket-key"
            | "sec-websocket-version"
            | "sec-websocket-extensions"
            | "sec-websocket-accept"
            | "sec-websocket-protocol"
    )
}

fn upstream_origin(url: &reqwest::Url) -> String {
    let scheme = if url.scheme() == "wss" { "https" } else { "http" };
    let host = url.host_str().unwrap_or("localhost");
    match url.port() {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";

    fn headers_with_cookie(raw: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(axum::http::header::COOKIE, raw.parse().unwrap());
        headers
    }

    #[test]
    fn query_token_grants_and_redirects_to_clean_path() {
        let decision = decide_access(TOKEN, "tun_1", &HeaderMap::new(), "/", Some(&format!("t={TOKEN}")));
        assert_eq!(
            decision,
            AccessDecision::GrantAndRedirect {
                location: "/".to_string()
            },
            "token 必须从地址栏消失"
        );
    }

    #[test]
    fn query_token_preserves_other_query_params() {
        let decision = decide_access(
            TOKEN,
            "tun_1",
            &HeaderMap::new(),
            "/app",
            Some(&format!("a=1&t={TOKEN}&b=2")),
        );
        assert_eq!(
            decision,
            AccessDecision::GrantAndRedirect {
                location: "/app?a=1&b=2".to_string()
            },
            "只剥 token，其余 query 必须原样保留"
        );
    }

    #[test]
    fn percent_encoded_token_is_accepted() {
        let decision = decide_access(
            "a+b/c",
            "tun_1",
            &HeaderMap::new(),
            "/",
            Some("t=a%2Bb%2Fc"),
        );
        assert!(matches!(decision, AccessDecision::GrantAndRedirect { .. }));
    }

    #[test]
    fn wrong_query_token_is_denied_and_does_not_fall_back_to_cookie() {
        // 带了错 token 就直接拒，不能因为恰好有有效 cookie 就放行——
        // 否则「换个 token 试试」会被 cookie 掩盖成成功。
        let headers = headers_with_cookie(&format!("liveagent_tunnel_tun_1={TOKEN}"));
        assert_eq!(
            decide_access(TOKEN, "tun_1", &headers, "/", Some("t=wrong")),
            AccessDecision::Deny
        );
    }

    #[test]
    fn valid_cookie_allows_request() {
        let headers = headers_with_cookie(&format!("liveagent_tunnel_tun_1={TOKEN}"));
        assert_eq!(
            decide_access(TOKEN, "tun_1", &headers, "/assets/main.js", None),
            AccessDecision::Allow
        );
    }

    #[test]
    fn cookie_of_another_tunnel_does_not_grant_access() {
        let headers = headers_with_cookie(&format!("liveagent_tunnel_tun_OTHER={TOKEN}"));
        assert_eq!(
            decide_access(TOKEN, "tun_1", &headers, "/", None),
            AccessDecision::Deny,
            "cookie 名带 id，不能跨隧道复用"
        );
    }

    #[test]
    fn no_credentials_is_denied() {
        assert_eq!(
            decide_access(TOKEN, "tun_1", &HeaderMap::new(), "/", None),
            AccessDecision::Deny
        );
        assert_eq!(
            decide_access(TOKEN, "tun_1", &headers_with_cookie("other=1"), "/", None),
            AccessDecision::Deny
        );
    }

    #[test]
    fn token_comparison_rejects_prefixes_and_extensions() {
        assert!(token_matches(TOKEN, TOKEN));
        assert!(!token_matches(TOKEN, &TOKEN[..TOKEN.len() - 1]));
        assert!(!token_matches(TOKEN, &format!("{TOKEN}x")));
        assert!(!token_matches(TOKEN, ""));
    }

    #[test]
    fn upstream_url_maps_paths_one_to_one() {
        let uri: Uri = "/assets/main.js".parse().unwrap();
        assert_eq!(
            upstream_url("http://localhost:5173/", &uri).unwrap().as_str(),
            "http://localhost:5173/assets/main.js",
            "路径 1:1 —— 这正是不需要重写代码的原因"
        );
    }

    #[test]
    fn upstream_url_preserves_target_base_path_and_query() {
        let uri: Uri = "/api/users?page=1".parse().unwrap();
        assert_eq!(
            upstream_url("http://localhost:3000/app", &uri)
                .unwrap()
                .as_str(),
            "http://localhost:3000/app/api/users?page=1"
        );

        let root: Uri = "/".parse().unwrap();
        assert_eq!(
            upstream_url("http://localhost:3000/app", &root)
                .unwrap()
                .as_str(),
            "http://localhost:3000/app/"
        );
        assert_eq!(
            upstream_url("http://127.0.0.1:5173", &root).unwrap().as_str(),
            "http://127.0.0.1:5173/"
        );
    }

    #[test]
    fn hop_by_hop_headers_are_dropped_but_host_only_on_requests() {
        for name in ["connection", "upgrade", "transfer-encoding", "te", "trailer"] {
            assert!(is_hop_by_hop(name, true), "{name}");
            assert!(is_hop_by_hop(name, false), "{name}");
        }
        assert!(is_hop_by_hop("host", true), "请求要换 Host");
        assert!(!is_hop_by_hop("host", false), "响应没有 Host 可言");
        assert!(!is_hop_by_hop("content-type", true));
    }

    #[test]
    fn tunnel_cookie_is_stripped_before_reaching_upstream() {
        let value: HeaderValue = "a=1; liveagent_tunnel_tun_1=secret; b=2".parse().unwrap();
        assert_eq!(
            strip_tunnel_cookie(&value, "liveagent_tunnel_tun_1"),
            Some("a=1; b=2".to_string()),
            "上游不该看到隧道自己的 cookie"
        );

        let only: HeaderValue = "liveagent_tunnel_tun_1=secret".parse().unwrap();
        assert_eq!(
            strip_tunnel_cookie(&only, "liveagent_tunnel_tun_1"),
            None,
            "只剩空的就不发 Cookie 头"
        );
    }

    #[test]
    fn upstream_origin_matches_target_not_browser() {
        let url = reqwest::Url::parse("ws://localhost:5173/socket").unwrap();
        assert_eq!(upstream_origin(&url), "http://localhost:5173");
    }
}
