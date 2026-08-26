//! CDP（Chrome DevTools Protocol）WebSocket 客户端：请求按自增 id 配对响应，
//! 事件按 method 广播给一次性等待者。仅连 127.0.0.1 调试端口，无 TLS。
//! 结构仿 services/stt 的会话模式：读循环独立 task，命令走 mpsc。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

/// 一次性事件等待者：`(method, 期望的 sessionId, 结果通道)`。
type EventWaiter = (String, Option<String>, oneshot::Sender<Value>);
/// 请求 id → 响应通道。
type PendingMap = HashMap<u64, oneshot::Sender<Result<Value, String>>>;

pub(crate) struct CdpConnection {
    next_id: AtomicU64,
    outbound: mpsc::UnboundedSender<Message>,
    pending: Arc<Mutex<PendingMap>>,
    event_waiters: Arc<Mutex<Vec<EventWaiter>>>,
    closed: Arc<Mutex<bool>>,
}

impl CdpConnection {
    /// 连接 browser-level WebSocket（ws://127.0.0.1:<port>/devtools/browser/...）。
    pub(crate) async fn connect(ws_url: &str) -> Result<Arc<Self>, String> {
        let (stream, _) = connect_async(ws_url)
            .await
            .map_err(|e| format!("连接 CDP WebSocket 失败：{e}"))?;
        let (mut sink, mut source) = stream.split();

        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Message>();
        let connection = Arc::new(Self {
            next_id: AtomicU64::new(1),
            outbound: outbound_tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            event_waiters: Arc::new(Mutex::new(Vec::new())),
            closed: Arc::new(Mutex::new(false)),
        });

        tauri::async_runtime::spawn(async move {
            while let Some(message) = outbound_rx.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        let reader_conn = Arc::clone(&connection);
        tauri::async_runtime::spawn(async move {
            while let Some(frame) = source.next().await {
                match frame {
                    Ok(Message::Text(text)) => reader_conn.dispatch_frame(text.as_ref()),
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            reader_conn.mark_closed();
        });

        Ok(connection)
    }

    fn mark_closed(&self) {
        if let Ok(mut closed) = self.closed.lock() {
            *closed = true;
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err("CDP 连接已关闭".to_string()));
            }
        }
        if let Ok(mut waiters) = self.event_waiters.lock() {
            waiters.clear();
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.lock().map(|guard| *guard).unwrap_or(true)
    }

    fn dispatch_frame(&self, raw: &str) {
        let Ok(value) = serde_json::from_str::<Value>(raw) else {
            return;
        };
        if let Some(id) = value.get("id").and_then(Value::as_u64) {
            let sender = self
                .pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&id));
            if let Some(sender) = sender {
                let outcome = if let Some(error) = value.get("error") {
                    let message = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown CDP error");
                    Err(format!("CDP 错误：{message}"))
                } else {
                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = sender.send(outcome);
            }
            return;
        }
        if let Some(method) = value.get("method").and_then(Value::as_str) {
            let session_id = value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            if let Ok(mut waiters) = self.event_waiters.lock() {
                // 先清掉接收端已放弃（超时/提前返回）的等待者：既防 Vec 泄漏，
                // 也避免这些僵尸条目被后续同名事件"命中"。
                waiters.retain(|(_, _, sender)| !sender.is_closed());
                let mut index = 0;
                while index < waiters.len() {
                    let matches = waiters[index].0 == method
                        && match (&waiters[index].1, &session_id) {
                            (Some(expected), Some(actual)) => expected == actual,
                            (Some(_), None) => false,
                            (None, _) => true,
                        };
                    if matches {
                        let (_, _, sender) = waiters.swap_remove(index);
                        let _ = sender.send(params.clone());
                    } else {
                        index += 1;
                    }
                }
            }
        }
    }

    /// 发送 CDP 命令并等待响应。`session_id` 为 None 时是 browser-level 命令。
    pub(crate) async fn call(
        &self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if self.is_closed() {
            return Err("CDP 连接已关闭".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut payload = json!({ "id": id, "method": method, "params": params });
        if let Some(session_id) = session_id {
            payload["sessionId"] = Value::String(session_id.to_string());
        }
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "CDP pending 锁中毒".to_string())?
            .insert(id, tx);
        self.outbound
            .send(Message::Text(payload.to_string().into()))
            .map_err(|_| "CDP 发送通道已关闭".to_string())?;

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err("CDP 响应通道被丢弃".to_string()),
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(format!("CDP 命令超时（{method}）"))
            }
        }
    }

    /// 注册一次性事件等待者；返回的 receiver 在事件到达时收到 params。
    pub(crate) fn wait_event(
        &self,
        method: &str,
        session_id: Option<&str>,
    ) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut waiters) = self.event_waiters.lock() {
            waiters.push((method.to_string(), session_id.map(str::to_string), tx));
        }
        rx
    }
}
