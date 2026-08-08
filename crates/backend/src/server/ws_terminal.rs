//! 终端流式 WebSocket 端点（`/ws/terminal`）。
//!
//! 认证与 `/api/events` 相同：浏览器 WebSocket API 设不了 Authorization header，
//! 握手时用 `?token=` 校验（handler 自己验，不走 bearer 中间件）。
//!
//! 协议（JSON 帧）：
//!
//! ```text
//! 上行 {"kind":"attach","sessionId":"...","maxBytes":65536}
//!      {"kind":"input","sessionId":"...","data":"<base64>"}
//!      {"kind":"resize","sessionId":"...","cols":80,"rows":24}
//!      {"kind":"detach","sessionId":"..."}
//! 下行 {"kind":"snapshot","sessionId":"...","session":{...},"bytes":"<base64>",
//!        "startOffset":0,"endOffset":1024,"truncated":false}
//!      {"kind":"output","sessionId":"...","bytes":"<base64>",
//!        "startOffset":1024,"endOffset":2048}
//!      {"kind":"event","event":{...}}
//!      {"kind":"error","error":"..."}
//! ```
//!
//! 输出帧必须无损（客户端靠 offset 拼流），所以订阅走 registry 的每连接
//! `std::sync::mpsc` 通道而不是 EventBus 的丢帧 broadcast。std 通道不能直接
//! await，用 [`bridge_std_channel`] 桥接进 tokio channel。

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use base64::Engine as _;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;

use crate::runtime::terminal::{
    TerminalEventPayload, TerminalSessionRegistry, TerminalStreamEventPayload,
    TerminalStreamSnapshotResponse,
};
use crate::server::state::AppState;

/// 桥接队列容量。输出不能丢帧，容量只影响背压节奏，不影响正确性。
const BRIDGE_CAPACITY: usize = 256;

/// WebSocket 连接的 query 参数。与 ws.rs 的 `WsConnectQuery` 同形，字段是私有的，
/// 这里定义一份本地拷贝。
#[derive(Debug, Deserialize)]
pub struct WsConnectQuery {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
enum ClientFrame {
    Attach {
        session_id: String,
        #[serde(default)]
        max_bytes: Option<usize>,
    },
    Input {
        session_id: String,
        data: String,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Detach {
        session_id: String,
    },
}

pub async fn handler(
    State(state): State<AppState>,
    Query(query): Query<WsConnectQuery>,
    upgrade: WebSocketUpgrade,
) -> Result<impl axum::response::IntoResponse, axum::http::StatusCode> {
    let token = query.token;
    if let Some(token_str) = token {
        if !state.auth.verify(&token_str) {
            return Err(axum::http::StatusCode::UNAUTHORIZED);
        }
    } else {
        return Err(axum::http::StatusCode::UNAUTHORIZED);
    }

    let registry = state.terminals;
    Ok(upgrade.on_upgrade(move |socket| handle_socket(socket, registry)))
}

async fn handle_socket(socket: WebSocket, registry: Arc<TerminalSessionRegistry>) {
    let (mut sender, mut receiver) = socket.split();

    // 每连接一条订阅。guard 在本函数末尾 drop，自动从 registry 注销订阅者。
    let (std_stream_rx, _stream_guard) = registry.subscribe_stream();
    let (std_event_rx, _event_guard) = registry.subscribe();
    let (stream_tx, mut stream_rx) = tokio::sync::mpsc::channel(BRIDGE_CAPACITY);
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(BRIDGE_CAPACITY);
    tokio::spawn(bridge_std_channel(std_stream_rx, stream_tx));
    tokio::spawn(bridge_std_channel(std_event_rx, event_tx));

    let mut attached: HashSet<String> = HashSet::new();

    loop {
        tokio::select! {
            event = stream_rx.recv() => {
                match event {
                    Some(event) => {
                        if attached.contains(&event.payload.session_id) {
                            let frame = output_frame(&event.payload);
                            if send_frame(&mut sender, &frame).await {
                                break;
                            }
                        }
                    }
                    None => break,
                }
            }
            event = event_rx.recv() => {
                match event {
                    Some(event) => {
                        let frame = event_frame(&event.payload);
                        if send_frame(&mut sender, &frame).await {
                            break;
                        }
                    }
                    None => break,
                }
            }
            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if handle_client_message(&registry, &mut attached, &mut sender, &text).await {
                            break;
                        }
                    }
                    // Ping/Binary 等一律忽略；None/Err/Close 表示连接结束。
                    Some(Ok(_)) => continue,
                    _ => break,
                }
            }
        }
    }
}

/// 把 std 阻塞通道桥接进 tokio channel。std 通道不能 await，每次 recv 都经
/// `spawn_blocking` 转异步；receiver 随结果一起返回，select 取消不会丢。
/// 退出路径：tokio 侧 receiver 被 drop → send 失败；或 guard 注销 → 通道断开
/// → recv 返回 Err。
async fn bridge_std_channel<T: Send + 'static>(
    mut rx: std::sync::mpsc::Receiver<T>,
    tx: tokio::sync::mpsc::Sender<T>,
) {
    loop {
        let handle = tokio::task::spawn_blocking(move || {
            let result = rx.recv();
            (result, rx)
        });
        let (result, next_rx) = match handle.await {
            Ok(pair) => pair,
            // 阻塞任务 panic：receiver 已丢，连接语义已破坏，退出。
            Err(_) => break,
        };
        rx = next_rx;
        match result {
            Ok(event) => {
                if tx.send(event).await.is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

/// 处理一条上行帧；返回 true 表示发送失败，连接该断开。
async fn handle_client_message(
    registry: &Arc<TerminalSessionRegistry>,
    attached: &mut HashSet<String>,
    sender: &mut SplitSink<WebSocket, Message>,
    text: &str,
) -> bool {
    let frame = match serde_json::from_str::<ClientFrame>(text) {
        Ok(frame) => frame,
        Err(err) => return send_error(sender, format!("无效帧：{err}")).await,
    };
    match frame {
        ClientFrame::Attach { session_id, max_bytes } => {
            match registry.stream_attach(session_id.clone(), max_bytes) {
                Ok(snapshot) => {
                    attached.insert(session_id);
                    send_frame(sender, &snapshot_frame(&snapshot)).await
                }
                Err(err) => send_error(sender, err).await,
            }
        }
        ClientFrame::Input { session_id, data } => {
            let bytes = match base64::engine::general_purpose::STANDARD.decode(data) {
                Ok(bytes) => bytes,
                Err(err) => return send_error(sender, format!("无效 base64：{err}")).await,
            };
            // WS 是数据面订阅者，收的是 echo dispatch 的 remote 路；输入必须标
            // Remote origin，否则 echo 被路由进 local 路（EventBus，迁移后已无
            // 订阅者），remote 路要等行尾才 flush——表现为「打字不渲染，回车才渲染」。
            match registry.input_bytes_from_remote(session_id, bytes) {
                Ok(()) => false,
                Err(err) => send_error(sender, err).await,
            }
        }
        ClientFrame::Resize { session_id, cols, rows } => {
            match registry.stream_resize(session_id, cols, rows) {
                Ok(()) => false,
                Err(err) => send_error(sender, err).await,
            }
        }
        ClientFrame::Detach { session_id } => {
            attached.remove(&session_id);
            false
        }
    }
}

/// 发一帧；返回 true 表示发送失败，连接该断开。
async fn send_frame(sender: &mut SplitSink<WebSocket, Message>, frame: &serde_json::Value) -> bool {
    match serde_json::to_string(frame) {
        Ok(text) => sender.send(Message::Text(text.into())).await.is_err(),
        Err(err) => {
            eprintln!("WebSocket 终端帧序列化失败：{err}");
            true
        }
    }
}

async fn send_error(sender: &mut SplitSink<WebSocket, Message>, message: String) -> bool {
    send_frame(sender, &serde_json::json!({ "kind": "error", "error": message })).await
}

fn snapshot_frame(snapshot: &TerminalStreamSnapshotResponse) -> serde_json::Value {
    serde_json::json!({
        "kind": "snapshot",
        "sessionId": &snapshot.session.id,
        "session": &snapshot.session,
        "bytes": base64::engine::general_purpose::STANDARD.encode(&snapshot.bytes),
        "startOffset": snapshot.output_start_offset,
        "endOffset": snapshot.output_end_offset,
        "truncated": snapshot.truncated,
    })
}

fn output_frame(payload: &TerminalStreamEventPayload) -> serde_json::Value {
    serde_json::json!({
        "kind": "output",
        "sessionId": &payload.session_id,
        "bytes": base64::engine::general_purpose::STANDARD.encode(&payload.bytes),
        "startOffset": payload.start_offset,
        "endOffset": payload.end_offset,
    })
}

fn event_frame(payload: &TerminalEventPayload) -> serde_json::Value {
    serde_json::json!({
        "kind": "event",
        "event": payload,
    })
}

pub fn router() -> axum::Router<AppState> {
    axum::Router::new().route("/ws/terminal", axum::routing::get(handler))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_attach_frame() {
        let frame: ClientFrame =
            serde_json::from_str(r#"{"kind":"attach","sessionId":"abc","maxBytes":65536}"#).unwrap();
        match frame {
            ClientFrame::Attach { session_id, max_bytes } => {
                assert_eq!(session_id, "abc");
                assert_eq!(max_bytes, Some(65536));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_attach_frame_without_max_bytes() {
        let frame: ClientFrame =
            serde_json::from_str(r#"{"kind":"attach","sessionId":"abc"}"#).unwrap();
        match frame {
            ClientFrame::Attach { session_id, max_bytes } => {
                assert_eq!(session_id, "abc");
                assert_eq!(max_bytes, None);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_input_frame() {
        let frame: ClientFrame =
            serde_json::from_str(r#"{"kind":"input","sessionId":"abc","data":"aGVsbG8="}"#).unwrap();
        match frame {
            ClientFrame::Input { session_id, data } => {
                assert_eq!(session_id, "abc");
                assert_eq!(data, "aGVsbG8=");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_resize_frame() {
        let frame: ClientFrame =
            serde_json::from_str(r#"{"kind":"resize","sessionId":"abc","cols":80,"rows":24}"#)
                .unwrap();
        match frame {
            ClientFrame::Resize { session_id, cols, rows } => {
                assert_eq!(session_id, "abc");
                assert_eq!((cols, rows), (80, 24));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_detach_frame() {
        let frame: ClientFrame =
            serde_json::from_str(r#"{"kind":"detach","sessionId":"abc"}"#).unwrap();
        assert!(matches!(
            frame,
            ClientFrame::Detach { session_id } if session_id == "abc"
        ));
    }

    #[test]
    fn output_frame_matches_protocol_shape() {
        let payload = TerminalStreamEventPayload {
            kind: "output".to_string(),
            session_id: "abc".to_string(),
            project_path_key: "proj".to_string(),
            start_offset: 1024,
            end_offset: 2048,
            bytes: b"hello".to_vec(),
        };
        let value = output_frame(&payload);
        assert_eq!(value["kind"], "output");
        assert_eq!(value["sessionId"], "abc");
        assert_eq!(value["bytes"], "aGVsbG8=");
        assert_eq!(value["startOffset"], 1024);
        assert_eq!(value["endOffset"], 2048);
    }
}
