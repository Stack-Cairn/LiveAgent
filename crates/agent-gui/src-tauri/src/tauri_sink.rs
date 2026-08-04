//! 把 `EventSink` 接到 Tauri webview 上。
//!
//! 这是桌面壳独有的东西，**不会**跟随 runtime/services/commands 迁入 agent-core——
//! agent-core 必须编译时就不认识 Tauri。

use tauri::{AppHandle, Emitter};

use agent_core::events::EventSink;

pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        // emit 失败通常意味着 webview 已经销毁（退出竞态）。这属于正常情况，
        // 只记日志：事件是旁路，丢一条不该影响正在跑的任务。
        if let Err(error) = self.app.emit(event, payload) {
            eprintln!("emit {event} 到 webview 失败: {error}");
        }
    }
}
