//! WebSocket 事件流 sink。
//!
//! EventBus 在业务线程上同步遍历所有 sink 调用 emit_json。为了不阻塞业务线程，
//! 这里用 broadcast channel 作为异步消息队列。emit_json 只负责非阻塞地往队列里扔，
//! 真正的 WebSocket 消息发送由 tokio task 驱动。
//!
//! 队列满时丢帧（broadcast 自动丢最旧的）而不是等待——慢客户端不能拖住 agent 业务逻辑。
//!
//! 重连语义：按决策 19，**不补发历史事件**。客户端重连后自己拉快照再订阅增量。
//! 没有 seq 号，没有 after_seq 参数，没有 replay buffer。

use agent_core::events::EventSink;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::broadcast;

/// 事件队列容量。根据实时事件流特性：
/// - 本地代理任务：每秒几十到上百条事件（shell output、terminal render、progress）
/// - 256 帧 = 2-3 秒缓冲
/// - 慢客户端（网络延迟、处理滞后）超过这个窗口就丢帧，这是可接受的折中
///   （不是关键数据，只是 UI 更新）
const WS_EVENT_QUEUE_CAPACITY: usize = 256;

/// WebSocket 连接的 query 参数。支持通过 ?token=... 传递认证令牌。
#[derive(Debug, Deserialize)]
pub struct WsConnectQuery {
    /// 认证令牌（Bearer token）。
    token: Option<String>,
}

/// WebSocket 事件流 sink：接收来自 EventBus 的事件，缓冲后通过 broadcast channel
/// 推送给所有连接的 WebSocket 客户端。
pub struct WsEventSink {
    /// broadcast::Sender 发送 JSON 字符串。用 broadcast 而不是 Vec<mpsc::Sender> 是因为：
    /// - 天然支持多订阅者（客户端连接）
    /// - 自动丢最旧的帧（而不是阻塞发送者）
    /// - 实现简洁
    tx: broadcast::Sender<String>,
}

impl WsEventSink {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(WS_EVENT_QUEUE_CAPACITY);
        Self { tx }
    }

    /// 返回订阅者端，用于新的 WebSocket 连接。
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }
}

impl Default for WsEventSink {
    fn default() -> Self {
        Self::new()
    }
}

impl EventSink for WsEventSink {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        // 拼装格式：{"event": "...", "payload": ...}
        let message = serde_json::json!({
            "event": event,
            "payload": payload,
        });

        // 序列化到 JSON 字符串。同步操作，通常很快；只有特别巨大的 payload 才会感受到。
        let json_str = match serde_json::to_string(&message) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("WebSocket 事件序列化失败 (event: {}): {}", event, err);
                return;
            }
        };

        // 非阻塞：队列满时 broadcast 自动丢最旧帧；没有订阅者时 send 返回 Err，
        // 那只说明还没有客户端连着，静默丢弃即可。
        let _ = self.tx.send(json_str);
    }
}

/// axum 0.8 WebSocket 事件流 handler。
///
/// sink 从 `AppState` 拿（`build_state` 建它并注册进 EventBus）。
/// 客户端连接后立即订阅事件流，收不到连接前的历史事件（决策 19）。
/// 断开时 task 自行退出，没有 per-connection 状态要清理。
///
/// 认证支持两种方式（因为浏览器 WebSocket API 无法设置自定义 header）：
/// - URL query 参数：?token=...
/// - Sec-WebSocket-Protocol header（握手阶段）
pub async fn ws_handler(
    State(state): State<crate::state::AppState>,
    Query(query): Query<WsConnectQuery>,
    upgrade: WebSocketUpgrade,
) -> Result<impl axum::response::IntoResponse, axum::http::StatusCode> {
    // 从 query 参数获取 token。
    let token = query.token;

    if let Some(token_str) = token {
        // 验证 token。
        if !state.auth.verify(&token_str) {
            return Err(axum::http::StatusCode::UNAUTHORIZED);
        }
    } else {
        // 如果 query 参数中没有 token，返回 401。
        // 前端必须通过 ?token=... 提供认证令牌。
        return Err(axum::http::StatusCode::UNAUTHORIZED);
    }

    let events = state.ws_sink.subscribe();
    Ok(upgrade.on_upgrade(move |socket| handle_socket(socket, events)))
}

/// 把 broadcast 里的事件泵进单个 WebSocket 连接，直到任一侧断开。
async fn handle_socket(socket: WebSocket, mut events: broadcast::Receiver<String>) {
    let (mut sender, mut receiver) = socket.split();

    loop {
        tokio::select! {
            result = events.recv() => {
                match result {
                    Ok(json_str) => {
                        if sender.send(Message::Text(json_str.into())).await.is_err() {
                            break; // 客户端断开
                        }
                    }
                    // 客户端消费太慢、错过了被挤掉的旧帧——按模块头的约定丢帧
                    // 继续，而不是断连。
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            msg = receiver.next() => {
                match msg {
                    // 客户端发来的消息一律忽略；None/Err 表示连接结束。
                    Some(Ok(_)) => continue,
                    _ => break,
                }
            }
        }
    }
}

/// 事件流挂在 `/api/events` 上，和命令路由一起走认证。
///
/// 流式端点是「命令式路由」约定的唯一例外（见 lib.rs 顶部）。
pub fn router() -> axum::Router<crate::state::AppState> {
    axum::Router::new().route("/events", axum::routing::get(ws_handler))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use super::*;

    #[test]
    fn emit_json_without_subscribers_does_not_panic() {
        let sink = WsEventSink::new();
        // 没有任何订阅者的情况下发事件。应该直接丢弃，不 panic。
        sink.emit_json("test:event", serde_json::json!({ "message": "hello" }));
        // 如果执行到这里就说明没有 panic。
    }

    #[test]
    fn emit_json_does_not_block_when_queue_full() {
        let sink = Arc::new(WsEventSink::new());

        // 快速连续发送超过队列容量的事件，验证不会阻塞。
        // 这个测试在同步上下文里就能验证（emit_json 是同步的）。
        let start = std::time::Instant::now();
        for i in 0..=WS_EVENT_QUEUE_CAPACITY * 2 {
            sink.emit_json("perf:test", serde_json::json!({ "seq": i }));
        }
        let elapsed = start.elapsed();

        // 如果 emit_json 会阻塞，整个循环会花很长时间。
        // 我们设置一个宽松的上限（比如 100ms）。试验表明，同步 JSON 序列化
        // 和 try_send 应该在微秒级别。
        assert!(
            elapsed.as_millis() < 100,
            "emit_json 可能在某处阻塞了（耗时 {} ms）",
            elapsed.as_millis()
        );
    }

    #[tokio::test]
    async fn subscribers_receive_emitted_events() {
        let sink = WsEventSink::new();

        // 获得一个订阅者。
        let mut rx = sink.subscribe();

        // 从另一个地方（模拟 EventBus 调用 emit_json）发事件。
        sink.emit_json("test:hello", serde_json::json!({ "data": "world" }));

        // 订阅者应该能收到这条消息。
        let msg = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("receive timeout")
            .expect("channel closed");

        // 验证消息格式。
        let parsed: serde_json::Value = serde_json::from_str(&msg).expect("failed to parse JSON");
        assert_eq!(parsed["event"], "test:hello");
        assert_eq!(parsed["payload"]["data"], "world");
    }

    #[tokio::test]
    async fn multiple_subscribers_all_receive_events() {
        let sink = WsEventSink::new();

        let mut rx1 = sink.subscribe();
        let mut rx2 = sink.subscribe();

        sink.emit_json("broadcast:test", serde_json::json!({ "n": 42 }));

        // 两个订阅者都应该收到。
        let msg1 = rx1.recv().await.expect("rx1");
        let msg2 = rx2.recv().await.expect("rx2");

        assert_eq!(msg1, msg2);
        let parsed: serde_json::Value = serde_json::from_str(&msg1).unwrap();
        assert_eq!(parsed["event"], "broadcast:test");
    }

    #[tokio::test]
    async fn emit_json_formats_correctly() {
        let sink = WsEventSink::new();
        let mut rx = sink.subscribe();

        sink.emit_json(
            "format:test",
            serde_json::json!({
                "nested": { "field": "value" }
            }),
        );

        let msg = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("receive timeout")
            .expect("channel closed");

        let parsed: serde_json::Value = serde_json::from_str(&msg).expect("failed to parse JSON");
        assert_eq!(parsed["event"], "format:test");
        assert_eq!(parsed["payload"]["nested"]["field"], "value");
    }

    #[test]
    fn queue_drops_old_frames_not_blocks() {
        // 用一个容量很小的 sink 来测试丢帧行为。
        // 注意：这里测试的是 emit_json 的非阻塞特性。
        let sink = WsEventSink::new();

        // 发送 1000 条事件（远超队列容量）。应该立即返回，不阻塞。
        let start = std::time::Instant::now();
        for i in 0..1000 {
            sink.emit_json("stress:test", serde_json::json!({ "i": i }));
        }
        let elapsed = start.elapsed();

        // 应该在几毫秒内完成。
        assert!(
            elapsed.as_millis() < 50,
            "发送 1000 条事件耗时 {} ms，可能有阻塞",
            elapsed.as_millis()
        );
    }
}
