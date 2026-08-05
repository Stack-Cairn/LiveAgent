//! 传输无关的事件出口。
//!
//! 背景：后端逻辑（runtime / services / commands）此前把两个消费者硬编码在发事件的地方——
//! 一个是 Tauri 的 `AppHandle::emit`，一个是 `GatewayController`。这让「谁在监听」
//! 变成了后端代码的编译期依赖，后端因此既离不开 Tauri 也离不开 Gateway。
//!
//! 现在后端只认识 `EventSink`。谁想收事件谁自己注册：桌面壳注册 `TauriEventSink`，
//! Gateway 注册自己的，HTTP 后端注册 WebSocket sink。加一个消费者不需要改任何发事件的代码。
//!
//! payload 统一用 `serde_json::Value`：这些类型本来就要过 JSON IPC 才能到前端，
//! 且新架构的线上协议就是 JSON（见 docs/architecture/backend-boundary.md），
//! 没有第二种表示值得维护。

use std::sync::{Arc, RwLock};

use serde::Serialize;

/// 事件消费者。实现者自行决定把事件送到哪里（webview、WebSocket、日志……）。
///
/// 必须是非阻塞的：sink 在业务线程上被同步调用，慢 sink 会拖住发事件的一方。
/// 需要排队就自己在实现里排。
pub trait EventSink: Send + Sync {
    fn emit_json(&self, event: &str, payload: serde_json::Value);
}

/// 事件总线：把一条事件扇出给所有已注册的 sink。
///
/// 自身也实现 `EventSink`，所以可以嵌套（例如把一组 sink 打包成一个）。
#[derive(Default)]
pub struct EventBus {
    sinks: RwLock<Vec<Arc<dyn EventSink>>>,
}

impl EventBus {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, sink: Arc<dyn EventSink>) {
        match self.sinks.write() {
            Ok(mut sinks) => sinks.push(sink),
            // 锁中毒说明某个 sink 在 emit 里 panic 了。这里不跟着 panic：
            // 事件出口坏掉不该连累正在跑的 agent 任务。
            Err(error) => eprintln!("EventBus::register 拿锁失败（锁已中毒）: {error}"),
        }
    }

    /// 发一条事件。序列化失败只记日志不 panic——事件是旁路，不该影响主流程。
    pub fn emit<T: Serialize>(&self, event: &str, payload: T) {
        match serde_json::to_value(payload) {
            Ok(value) => self.emit_json(event, value),
            Err(error) => eprintln!("事件 {event} 序列化失败: {error}"),
        }
    }
}

impl EventSink for EventBus {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        let sinks = match self.sinks.read() {
            Ok(sinks) => sinks.clone(),
            Err(error) => {
                eprintln!("EventBus::emit_json 拿锁失败（锁已中毒）: {error}");
                return;
            }
        };
        for sink in &sinks {
            sink.emit_json(event, payload.clone());
        }
    }
}

/// 没有任何消费者的总线。用于测试，以及后端在壳尚未接上时的启动窗口期。
pub struct NullSink;

impl EventSink for NullSink {
    fn emit_json(&self, _event: &str, _payload: serde_json::Value) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingSink {
        seen: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl EventSink for RecordingSink {
        fn emit_json(&self, event: &str, payload: serde_json::Value) {
            self.seen
                .lock()
                .expect("recording sink lock")
                .push((event.to_string(), payload));
        }
    }

    #[test]
    fn fans_out_to_every_registered_sink() {
        let bus = EventBus::new();
        let a = Arc::new(RecordingSink::default());
        let b = Arc::new(RecordingSink::default());
        bus.register(a.clone());
        bus.register(b.clone());

        bus.emit("terminal:event", serde_json::json!({ "kind": "output" }));

        for sink in [&a, &b] {
            let seen = sink.seen.lock().expect("recording sink lock");
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].0, "terminal:event");
            assert_eq!(seen[0].1["kind"], "output");
        }
    }

    #[test]
    fn emitting_without_sinks_is_a_noop() {
        let bus = EventBus::new();
        bus.emit("terminal:event", serde_json::json!({}));
    }

    #[test]
    fn serialization_failure_does_not_panic() {
        struct Unserializable;
        impl Serialize for Unserializable {
            fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
                Err(serde::ser::Error::custom("boom"))
            }
        }

        let bus = EventBus::new();
        let sink = Arc::new(RecordingSink::default());
        bus.register(sink.clone());

        bus.emit("bad:event", Unserializable);

        assert!(sink.seen.lock().expect("recording sink lock").is_empty());
    }

    #[test]
    fn buses_nest() {
        let inner = Arc::new(EventBus::new());
        let leaf = Arc::new(RecordingSink::default());
        inner.register(leaf.clone());

        let outer = EventBus::new();
        outer.register(inner);
        outer.emit("nested", serde_json::json!(1));

        assert_eq!(leaf.seen.lock().expect("recording sink lock").len(), 1);
    }
}
