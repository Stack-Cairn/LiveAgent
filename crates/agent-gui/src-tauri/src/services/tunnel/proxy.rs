//! Stateless tunnel data plane: every HTTP_REQUEST_START / WS_DIAL frame
//! carries its own target URL, so per-stream registries are keyed only by
//! stream_id.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use reqwest::header::{HeaderName, HeaderValue};
use reqwest::Url;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::header::SEC_WEBSOCKET_PROTOCOL,
        protocol::{frame::coding::CloseCode, CloseFrame},
        Message,
    },
};

use crate::services::gateway::{now_unix_seconds, proto, GatewayController};

use super::validate_tunnel_target_url;

const TUNNEL_BODY_CHUNK_SIZE: usize = 64 * 1024;
const TUNNEL_HTTP_BODY_CHANNEL_DEPTH: usize = 64;
const TUNNEL_WS_CHANNEL_DEPTH: usize = 128;

type TunnelHttpBodySender = mpsc::Sender<Result<Vec<u8>, io::Error>>;

#[derive(Default)]
pub struct TunnelProxy {
    http_streams: Mutex<HashMap<String, TunnelHttpBodySender>>,
    ws_streams: Mutex<HashMap<String, mpsc::Sender<proto::TunnelFrame>>>,
}

impl TunnelProxy {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn handle_frame(
        &self,
        controller: &Arc<GatewayController>,
        frame: proto::TunnelFrame,
    ) -> Result<(), String> {
        let stream_id = frame.stream_id.trim().to_string();
        if stream_id.is_empty() {
            return Ok(());
        }
        match frame.kind() {
            proto::TunnelFrameKind::HttpRequestStart => {
                if let Err(error) = self.start_http_stream(controller, &stream_id, &frame) {
                    spawn_tunnel_frame_error(controller, stream_id, error);
                }
                Ok(())
            }
            proto::TunnelFrameKind::HttpRequestBody => {
                let sender = self
                    .http_streams
                    .lock()
                    .map_err(|_| "gateway tunnel http stream lock poisoned".to_string())?
                    .get(&stream_id)
                    .cloned();
                if let Some(sender) = sender {
                    match sender.try_send(Ok(frame.body)) {
                        Ok(()) => {}
                        Err(mpsc::error::TrySendError::Full(_)) => {
                            self.remove_http_stream(&stream_id);
                            spawn_tunnel_frame_error(
                                controller,
                                stream_id,
                                "local tunnel request body queue is full".to_string(),
                            );
                        }
                        Err(mpsc::error::TrySendError::Closed(_)) => {}
                    }
                }
                Ok(())
            }
            proto::TunnelFrameKind::HttpRequestEnd => {
                self.remove_http_stream(&stream_id);
                Ok(())
            }
            proto::TunnelFrameKind::WsDial => {
                if let Err(error) = self.start_ws_stream(controller, &stream_id, &frame) {
                    spawn_tunnel_ws_dial_error(controller, stream_id, error);
                }
                Ok(())
            }
            proto::TunnelFrameKind::WsFrame
            | proto::TunnelFrameKind::WsClose
            | proto::TunnelFrameKind::Cancel => {
                let terminal_frame = matches!(
                    frame.kind(),
                    proto::TunnelFrameKind::WsClose | proto::TunnelFrameKind::Cancel
                );
                if matches!(frame.kind(), proto::TunnelFrameKind::Cancel) {
                    self.remove_http_stream(&stream_id);
                }
                let sender = self
                    .ws_streams
                    .lock()
                    .map_err(|_| "gateway tunnel websocket stream lock poisoned".to_string())?
                    .get(&stream_id)
                    .cloned();
                if let Some(sender) = sender {
                    match sender.try_send(frame) {
                        Ok(()) => {}
                        Err(mpsc::error::TrySendError::Full(_)) => {
                            self.remove_ws_stream(&stream_id);
                            if !terminal_frame {
                                spawn_tunnel_frame_error(
                                    controller,
                                    stream_id,
                                    "local tunnel websocket queue is full".to_string(),
                                );
                            }
                        }
                        Err(mpsc::error::TrySendError::Closed(_)) => {}
                    }
                }
                Ok(())
            }
            proto::TunnelFrameKind::Ping => {
                let controller = Arc::clone(controller);
                tauri::async_runtime::spawn(async move {
                    let _ = send_tunnel_frame(
                        &controller,
                        proto::TunnelFrame {
                            stream_id,
                            kind: proto::TunnelFrameKind::Pong as i32,
                            ..Default::default()
                        },
                    )
                    .await;
                });
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn start_http_stream(
        &self,
        controller: &Arc<GatewayController>,
        stream_id: &str,
        frame: &proto::TunnelFrame,
    ) -> Result<(), String> {
        let target = validate_tunnel_target_url(&frame.target_url)?;
        let upstream_url = build_tunnel_upstream_url(&target.url, &frame.path)?;
        let method = frame.method.trim().to_string();
        let headers = frame.headers.clone();
        let (body_tx, body_rx) =
            mpsc::channel::<Result<Vec<u8>, io::Error>>(TUNNEL_HTTP_BODY_CHANNEL_DEPTH);
        self.http_streams
            .lock()
            .map_err(|_| "gateway tunnel http stream lock poisoned".to_string())?
            .insert(stream_id.to_string(), body_tx);

        let controller = Arc::clone(controller);
        let stream_id = stream_id.to_string();
        tauri::async_runtime::spawn(async move {
            run_tunnel_http_request(
                controller,
                stream_id,
                method,
                upstream_url,
                headers,
                body_rx,
            )
            .await;
        });
        Ok(())
    }

    fn start_ws_stream(
        &self,
        controller: &Arc<GatewayController>,
        stream_id: &str,
        frame: &proto::TunnelFrame,
    ) -> Result<(), String> {
        let target = validate_tunnel_target_url(&frame.target_url)?;
        let upstream_url = build_tunnel_upstream_ws_url(&target.url, &frame.path)?;
        let headers = frame.headers.clone();
        let (gateway_tx, gateway_rx) = mpsc::channel::<proto::TunnelFrame>(TUNNEL_WS_CHANNEL_DEPTH);
        self.ws_streams
            .lock()
            .map_err(|_| "gateway tunnel websocket stream lock poisoned".to_string())?
            .insert(stream_id.to_string(), gateway_tx);

        let controller = Arc::clone(controller);
        let stream_id = stream_id.to_string();
        tauri::async_runtime::spawn(async move {
            run_tunnel_websocket(controller, stream_id, upstream_url, headers, gateway_rx).await;
        });
        Ok(())
    }

    fn remove_http_stream(&self, stream_id: &str) {
        if let Ok(mut streams) = self.http_streams.lock() {
            streams.remove(stream_id.trim());
        }
    }

    fn remove_ws_stream(&self, stream_id: &str) {
        if let Ok(mut streams) = self.ws_streams.lock() {
            streams.remove(stream_id.trim());
        }
    }
}

fn spawn_tunnel_frame_error(controller: &Arc<GatewayController>, stream_id: String, error: String) {
    let controller = Arc::clone(controller);
    tauri::async_runtime::spawn(async move {
        let _ = send_tunnel_frame(
            &controller,
            proto::TunnelFrame {
                stream_id,
                kind: proto::TunnelFrameKind::Error as i32,
                error,
                ..Default::default()
            },
        )
        .await;
    });
}

fn spawn_tunnel_ws_dial_error(
    controller: &Arc<GatewayController>,
    stream_id: String,
    error: String,
) {
    let controller = Arc::clone(controller);
    tauri::async_runtime::spawn(async move {
        let _ = send_tunnel_frame(
            &controller,
            proto::TunnelFrame {
                stream_id,
                kind: proto::TunnelFrameKind::WsDialError as i32,
                error,
                ..Default::default()
            },
        )
        .await;
    });
}

async fn run_tunnel_http_request(
    controller: Arc<GatewayController>,
    stream_id: String,
    method: String,
    upstream_url: Url,
    headers: Vec<proto::TunnelHeader>,
    body_rx: mpsc::Receiver<Result<Vec<u8>, io::Error>>,
) {
    let result = async {
        let method = reqwest::Method::from_bytes(method.trim().as_bytes())
            .map_err(|e| format!("invalid tunnel request method: {e}"))?;
        let body = reqwest::Body::wrap_stream(ReceiverStream::new(body_rx));
        // 隧道目标恒为本机/内网服务：显式忽略环境代理，
        // 防止 OS 级 HTTP(S)_PROXY 劫持本地转发导致隧道不可用。
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("failed to build local tunnel HTTP client: {e}"))?;
        let request =
            apply_tunnel_request_headers(client.request(method, upstream_url).body(body), &headers);
        let response = request
            .send()
            .await
            .map_err(|e| format!("local tunnel request failed: {e}"))?;
        let status = u32::from(response.status().as_u16());
        let response_headers = tunnel_response_headers(response.headers());
        send_tunnel_frame(
            &controller,
            proto::TunnelFrame {
                stream_id: stream_id.clone(),
                kind: proto::TunnelFrameKind::HttpResponseStart as i32,
                status,
                headers: response_headers,
                ..Default::default()
            },
        )
        .await?;

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("local tunnel response stream failed: {e}"))?;
            if chunk.is_empty() {
                continue;
            }
            for part in chunk.chunks(TUNNEL_BODY_CHUNK_SIZE) {
                send_tunnel_frame(
                    &controller,
                    proto::TunnelFrame {
                        stream_id: stream_id.clone(),
                        kind: proto::TunnelFrameKind::HttpResponseBody as i32,
                        body: part.to_vec(),
                        ..Default::default()
                    },
                )
                .await?;
            }
        }

        send_tunnel_frame(
            &controller,
            proto::TunnelFrame {
                stream_id: stream_id.clone(),
                kind: proto::TunnelFrameKind::HttpResponseEnd as i32,
                ..Default::default()
            },
        )
        .await
    }
    .await;

    controller.tunnel_proxy.remove_http_stream(&stream_id);
    if let Err(error) = result {
        let _ = send_tunnel_frame(
            &controller,
            proto::TunnelFrame {
                stream_id,
                kind: proto::TunnelFrameKind::Error as i32,
                error,
                ..Default::default()
            },
        )
        .await;
    }
}

async fn run_tunnel_websocket(
    controller: Arc<GatewayController>,
    stream_id: String,
    upstream_url: Url,
    headers: Vec<proto::TunnelHeader>,
    mut gateway_rx: mpsc::Receiver<proto::TunnelFrame>,
) {
    let mut request = match upstream_url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => {
            controller.tunnel_proxy.remove_ws_stream(&stream_id);
            let _ = send_tunnel_frame(
                &controller,
                proto::TunnelFrame {
                    stream_id,
                    kind: proto::TunnelFrameKind::WsDialError as i32,
                    error: format!("invalid local tunnel websocket request: {error}"),
                    ..Default::default()
                },
            )
            .await;
            return;
        }
    };
    apply_tunnel_ws_request_headers(&mut request, &headers, &upstream_url);
    let (ws_stream, response) = match connect_async(request).await {
        Ok(result) => result,
        Err(error) => {
            controller.tunnel_proxy.remove_ws_stream(&stream_id);
            let _ = send_tunnel_frame(
                &controller,
                proto::TunnelFrame {
                    stream_id,
                    kind: proto::TunnelFrameKind::WsDialError as i32,
                    error: format!("local tunnel websocket failed: {error}"),
                    ..Default::default()
                },
            )
            .await;
            return;
        }
    };
    let ws_subprotocol = response
        .headers()
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();

    if send_tunnel_frame(
        &controller,
        proto::TunnelFrame {
            stream_id: stream_id.clone(),
            kind: proto::TunnelFrameKind::WsDialOk as i32,
            ws_subprotocol,
            ..Default::default()
        },
    )
    .await
    .is_err()
    {
        controller.tunnel_proxy.remove_ws_stream(&stream_id);
        return;
    }

    // Ok(Some(...)) carries the upstream close code/reason when the local
    // service initiated the shutdown.
    let result: Result<Option<(u32, String)>, String> = async {
        let mut upstream_close: Option<(u32, String)> = None;
        let (mut local_write, mut local_read) = ws_stream.split();
        loop {
            tokio::select! {
                incoming = gateway_rx.recv() => {
                    let Some(frame) = incoming else {
                        break;
                    };
                    match frame.kind() {
                        proto::TunnelFrameKind::WsFrame => {
                            if frame.ws_message_type() == proto::TunnelWsMessageType::Text {
                                let text = String::from_utf8_lossy(&frame.body).to_string();
                                local_write
                                    .send(Message::Text(text.into()))
                                    .await
                                    .map_err(|e| format!("local websocket send failed: {e}"))?;
                            } else {
                                local_write
                                    .send(Message::Binary(frame.body.into()))
                                    .await
                                    .map_err(|e| format!("local websocket send failed: {e}"))?;
                            }
                        }
                        proto::TunnelFrameKind::WsClose => {
                            let close_frame = (frame.ws_close_code > 0).then(|| CloseFrame {
                                code: CloseCode::from(
                                    u16::try_from(frame.ws_close_code).unwrap_or(1000),
                                ),
                                reason: frame.ws_close_reason.clone().into(),
                            });
                            let _ = local_write.send(Message::Close(close_frame)).await;
                            break;
                        }
                        proto::TunnelFrameKind::Cancel => {
                            let _ = local_write.send(Message::Close(None)).await;
                            break;
                        }
                        _ => {}
                    }
                }
                local = local_read.next() => {
                    let Some(local) = local else {
                        break;
                    };
                    let message = local.map_err(|e| format!("local websocket read failed: {e}"))?;
                    match message {
                        Message::Text(text) => {
                            send_tunnel_frame(
                                &controller,
                                proto::TunnelFrame {
                                    stream_id: stream_id.clone(),
                                    kind: proto::TunnelFrameKind::WsFrame as i32,
                                    ws_message_type: proto::TunnelWsMessageType::Text as i32,
                                    body: text.to_string().into_bytes(),
                                    ..Default::default()
                                },
                            )
                            .await?;
                        }
                        Message::Binary(data) => {
                            send_tunnel_frame(
                                &controller,
                                proto::TunnelFrame {
                                    stream_id: stream_id.clone(),
                                    kind: proto::TunnelFrameKind::WsFrame as i32,
                                    ws_message_type: proto::TunnelWsMessageType::Binary as i32,
                                    body: data.to_vec(),
                                    ..Default::default()
                                },
                            )
                            .await?;
                        }
                        Message::Ping(data) => {
                            let _ = local_write.send(Message::Pong(data)).await;
                        }
                        Message::Close(close) => {
                            upstream_close = close.map(|frame| {
                                (
                                    u32::from(u16::from(frame.code)),
                                    frame.reason.as_str().to_string(),
                                )
                            });
                            break;
                        }
                        Message::Pong(_) | Message::Frame(_) => {}
                    }
                }
            }
        }
        Ok(upstream_close)
    }
    .await;

    controller.tunnel_proxy.remove_ws_stream(&stream_id);
    match result {
        Ok(upstream_close) => {
            let (ws_close_code, ws_close_reason) = upstream_close.unwrap_or((0, String::new()));
            let _ = send_tunnel_frame(
                &controller,
                proto::TunnelFrame {
                    stream_id,
                    kind: proto::TunnelFrameKind::WsClose as i32,
                    ws_close_code,
                    ws_close_reason,
                    ..Default::default()
                },
            )
            .await;
        }
        Err(error) => {
            let _ = send_tunnel_frame(
                &controller,
                proto::TunnelFrame {
                    stream_id,
                    kind: proto::TunnelFrameKind::Error as i32,
                    error,
                    ..Default::default()
                },
            )
            .await;
        }
    }
}

fn split_tunnel_path_and_query(input: &str) -> (&str, Option<&str>) {
    let trimmed = input.trim();
    match trimmed.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (trimmed, None),
    }
}

fn normalize_tunnel_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return "/".to_string();
    }
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

fn join_tunnel_paths(base_path: &str, rest_path: &str) -> String {
    let base = normalize_tunnel_path(base_path);
    let rest = normalize_tunnel_path(rest_path);
    if base == "/" {
        return rest;
    }
    if rest == "/" {
        return format!("{}/", base.trim_end_matches('/'));
    }
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        rest.trim_start_matches('/')
    )
}

fn build_tunnel_upstream_url(base: &Url, public_path: &str) -> Result<Url, String> {
    let (path, query) = split_tunnel_path_and_query(public_path);
    let mut url = base.clone();
    let joined_path = join_tunnel_paths(url.path(), path);
    url.set_path(&joined_path);
    url.set_query(query.filter(|value| !value.is_empty()));
    url.set_fragment(None);
    Ok(url)
}

fn build_tunnel_upstream_ws_url(base: &Url, public_path: &str) -> Result<Url, String> {
    let mut url = build_tunnel_upstream_url(base, public_path)?;
    url.set_scheme("ws")
        .map_err(|_| "failed to build websocket tunnel target URL".to_string())?;
    Ok(url)
}

fn should_drop_tunnel_header(name: &str, request: bool) -> bool {
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
        "host" => request,
        _ => false,
    }
}

fn apply_tunnel_request_headers(
    mut builder: reqwest::RequestBuilder,
    headers: &[proto::TunnelHeader],
) -> reqwest::RequestBuilder {
    for header in headers {
        let name = header.name.trim();
        if name.is_empty() || should_drop_tunnel_header(name, true) {
            continue;
        }
        let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        let Ok(header_value) = HeaderValue::from_str(&header.value) else {
            continue;
        };
        builder = builder.header(header_name, header_value);
    }
    builder
}

fn tunnel_response_headers(headers: &reqwest::header::HeaderMap) -> Vec<proto::TunnelHeader> {
    let mut out = Vec::new();
    for (name, value) in headers.iter() {
        let name_text = name.as_str();
        if should_drop_tunnel_header(name_text, false) {
            continue;
        }
        let Ok(value_text) = value.to_str() else {
            continue;
        };
        out.push(proto::TunnelHeader {
            name: name_text.to_string(),
            value: value_text.to_string(),
        });
    }
    out
}

fn apply_tunnel_ws_request_headers(
    request: &mut tokio_tungstenite::tungstenite::http::Request<()>,
    headers: &[proto::TunnelHeader],
    upstream_url: &Url,
) {
    let target_origin = tunnel_target_origin(upstream_url);
    for header in headers {
        let name = header.name.trim();
        if name.is_empty() || should_drop_tunnel_ws_header(name) {
            continue;
        }
        let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        let value = if header_name.as_str().eq_ignore_ascii_case("origin") {
            target_origin.as_str()
        } else {
            header.value.as_str()
        };
        let Ok(header_value) = HeaderValue::from_str(value) else {
            continue;
        };
        request.headers_mut().append(header_name, header_value);
    }
    if !headers
        .iter()
        .any(|header| header.name.eq_ignore_ascii_case("origin"))
    {
        if let Ok(header_value) = HeaderValue::from_str(&target_origin) {
            request
                .headers_mut()
                .insert(HeaderName::from_static("origin"), header_value);
        }
    }
}

fn should_drop_tunnel_ws_header(name: &str) -> bool {
    if should_drop_tunnel_header(name, true) {
        return true;
    }
    matches!(
        name.to_ascii_lowercase().as_str(),
        "sec-websocket-key"
            | "sec-websocket-version"
            | "sec-websocket-extensions"
            | "sec-websocket-accept"
    )
}

fn tunnel_target_origin(url: &Url) -> String {
    match url.port() {
        Some(port) => format!(
            "{}://{}:{port}",
            url.scheme(),
            url.host_str().unwrap_or("localhost")
        ),
        None => format!(
            "{}://{}",
            url.scheme(),
            url.host_str().unwrap_or("localhost")
        ),
    }
}

async fn send_tunnel_frame(
    controller: &GatewayController,
    frame: proto::TunnelFrame,
) -> Result<(), String> {
    controller
        .send_agent_envelope(proto::AgentEnvelope {
            request_id: format!("tunnel-frame-{}", frame.stream_id.trim()),
            timestamp: now_unix_seconds(),
            payload: Some(proto::agent_envelope::Payload::TunnelFrame(frame)),
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::{build_tunnel_upstream_url, build_tunnel_upstream_ws_url};
    use crate::services::tunnel::validate_tunnel_target_url;

    #[test]
    fn build_tunnel_upstream_url_preserves_base_path_and_query() {
        let target = validate_tunnel_target_url("http://localhost:3000/app").unwrap();
        let upstream = build_tunnel_upstream_url(&target.url, "/api/users?page=1").unwrap();
        assert_eq!(
            upstream.as_str(),
            "http://localhost:3000/app/api/users?page=1"
        );

        let root_target = validate_tunnel_target_url("http://127.0.0.1:5173").unwrap();
        let root_upstream = build_tunnel_upstream_url(&root_target.url, "/").unwrap();
        assert_eq!(root_upstream.as_str(), "http://127.0.0.1:5173/");
    }

    #[test]
    fn build_tunnel_upstream_ws_url_switches_scheme() {
        let target = validate_tunnel_target_url("http://localhost:3000/app").unwrap();
        let upstream = build_tunnel_upstream_ws_url(&target.url, "/socket?token=1").unwrap();
        assert_eq!(upstream.as_str(), "ws://localhost:3000/app/socket?token=1");
    }
}
