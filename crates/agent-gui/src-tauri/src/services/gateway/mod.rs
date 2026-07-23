//! 网关控制器模块（拆分自原单文件 gateway.rs，代码逐字迁移，行为不变）。
//!
//! - [`types`]：对外事件 / DTO 类型与事件名常量
//! - [`controller`]：`GatewayController` 生命周期与公开 API（new/start/apply_config/publish_*）
//! - [`connection`]：WebSocket 连接主循环、出站通道与端点构建
//! - [`envelope_handler`]：网关入站信封（`GatewayEnvelope`）分发
//! - [`terminal`]：终端请求处理、终端流与 proto 转换
//! - [`sftp`]：SFTP 请求处理与 proto 转换
//! - [`chat`]：聊天命令、聊天队列与聊天事件信封构建
//! - [`chat_inbox`]：远程聊天收件箱、租约管理与 chat run ledger 记账
//! - [`settings_sync`]：设置同步快照合并与信封构建
//! - [`history_sync`]：会话历史同步事件与信封构建
//! - [`util`]：时间戳与 JSON 字段工具

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use crate::commands::git::GitCloneTaskRegistry;
use crate::commands::settings::RemoteSettingsPayload;
use crate::runtime::managed_process::ManagedProcessRegistry;
use crate::runtime::sftp::SftpSessionRegistry;
use crate::runtime::terminal::TerminalSessionRegistry;
use crate::services::automation::AutomationStore;
use crate::services::chat_run_ledger::ChatRunLedger;
use crate::services::memory::MemoryStore;
use crate::services::tunnel::{TunnelProxy, TunnelStore};
use crate::services::workspace_watch::WorkspaceWatchService;

/// 网关 v2 protobuf 生成模块。业务消息与帧壳属于同一包。
/// 仅生成消息，不生成客户端或服务端。
pub mod gateway_proto {
    #[allow(dead_code)]
    pub mod v2 {
        include!(concat!(env!("OUT_DIR"), "/liveagent.gateway.v2.rs"));
    }
}

pub use gateway_proto::v2 as proto;

mod chat;
mod chat_inbox;
mod connection;
mod controller;
mod envelope_handler;
mod history_sync;
mod managed_process;
mod settings_sync;
mod sftp;
mod terminal;
#[cfg(test)]
mod tests;
mod types;
mod util;
mod ws_transport;

pub(crate) use chat::*;
pub(crate) use chat_inbox::*;
pub(crate) use connection::*;
pub(crate) use history_sync::*;
pub use history_sync::{build_history_sync_delete, build_history_sync_upsert};
pub(crate) use settings_sync::*;
pub(crate) use sftp::*;
pub(crate) use terminal::*;
pub use types::*;
pub(crate) use util::*;
pub(crate) use ws_transport::*;

pub(crate) const UI_ONLY_SETTINGS_SYNC_FIELDS: &[&str] = &[
    "skills",
    "chatRuntimeControls",
    "customSettings",
    "selectedModel",
    "theme",
    "locale",
];
// Small dedicated lane for latency-sensitive control replies (Pongs). It is
// merged into the same outbound envelope stream but never sits behind
// thousands of queued data envelopes, so wake probes stay answerable while a
// reply is streaming tokens through the saturated data queue.
pub(crate) const GATEWAY_OUTBOUND_CONTROL_QUEUE_DEPTH: usize = 64;
pub(crate) const GATEWAY_RECONNECT_MIN: Duration = Duration::from_millis(250);
pub(crate) const GATEWAY_RECONNECT_MAX: Duration = Duration::from_secs(5);
pub(crate) const GATEWAY_RECONNECT_STABLE_AFTER: Duration = Duration::from_secs(30);
// v2 主链路存活看门狗：ServerHello 未给心跳周期时的回退值，
// 以及静默超 3×心跳周期发 WS Ping 探活后的宽限时长。
pub(crate) const GATEWAY_WS_DEFAULT_HEARTBEAT_PERIOD: Duration = Duration::from_secs(30);
pub(crate) const GATEWAY_WS_PROBE_GRACE: Duration = Duration::from_secs(10);
pub(crate) const GATEWAY_POST_CONNECT_REPLAY_DELAY: Duration = Duration::from_millis(200);
pub(crate) const GATEWAY_TERMINAL_STREAM_RECONNECT_MIN: Duration = Duration::from_millis(250);
pub(crate) const GATEWAY_TERMINAL_STREAM_RECONNECT_MAX: Duration = Duration::from_secs(5);
pub(crate) const GATEWAY_TERMINAL_STREAM_STABLE_AFTER: Duration = Duration::from_secs(30);
pub(crate) const GATEWAY_TERMINAL_STREAM_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(5);
pub(crate) const GATEWAY_CHAT_LEASE_MS: u64 = 15_000;
pub(crate) const GATEWAY_CHAT_RUNNING_LEASE_MS: u64 = 30 * 60_000;
pub(crate) const GATEWAY_CHAT_LEASE_SWEEP_INTERVAL: Duration = Duration::from_secs(5);
// The gateway marks the chat runtime not-ready 15s after the last runtime
// status heartbeat. The webview timer that drives those heartbeats is
// throttled whenever the desktop window is hidden or occluded, so Rust
// re-publishes the last reported state on a steady cadence and only stops
// once the webview has been silent for the max age (a webview alive enough
// to matter refreshes the record at least once a minute even when heavily
// throttled) or has said "suspended".
pub(crate) const GATEWAY_RUNTIME_STATUS_REPUBLISH_INTERVAL: Duration = Duration::from_secs(5);
pub(crate) const GATEWAY_RUNTIME_STATUS_REPUBLISH_MAX_AGE: Duration = Duration::from_secs(10 * 60);
// A healthy webview stamps the republish record every ~2s; a gap beyond this
// window means its DOM timers are throttled (hidden/occluded window), so run
// keepalives are not firing either and ledger staleness proves nothing about
// the runs themselves.
pub(crate) const GATEWAY_WEBVIEW_REPORT_FRESH_WINDOW: Duration = Duration::from_secs(6);
pub(crate) const GATEWAY_CHAT_RUNTIME_WAKE_REQUEST_PREFIX: &str = "chat-runtime-wake-";
pub(crate) const GATEWAY_CHAT_RUNTIME_WAKE_EVENT: &str = "gateway:chat-runtime-wake";
pub(crate) const GATEWAY_CONNECTION_NUDGE_COOLDOWN: Duration = Duration::from_secs(1);

pub struct GatewayController {
    app_handle: tauri::AppHandle,
    automation_store: Arc<AutomationStore>,
    memory_store: Arc<MemoryStore>,
    terminal_registry: Arc<TerminalSessionRegistry>,
    sftp_registry: Arc<SftpSessionRegistry>,
    managed_process_registry: Arc<ManagedProcessRegistry>,
    pub(crate) git_clone_task_registry: Arc<GitCloneTaskRegistry>,
    config_tx: watch::Sender<RemoteSettingsPayload>,
    runner_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    status: Mutex<GatewayStatusSnapshot>,
    outbound_tx: Mutex<Option<mpsc::Sender<proto::AgentEnvelope>>>,
    outbound_control_tx: Mutex<Option<mpsc::Sender<proto::AgentEnvelope>>>,
    terminal_stream_tx: Mutex<Option<mpsc::Sender<proto::TerminalStreamFrame>>>,
    settings_snapshot: Mutex<Option<Value>>,
    remote_chat_inbox: Mutex<HashMap<String, RemoteChatInboxRecord>>,
    chat_run_ledger: Mutex<ChatRunLedger>,
    runtime_status_republish: Mutex<Option<RuntimeStatusRepublishRecord>>,
    last_connection_nudge: Mutex<Option<Instant>>,
    pub(crate) tunnel_store: TunnelStore,
    pub(crate) tunnel_proxy: TunnelProxy,
    pub(crate) workspace_watch: Arc<WorkspaceWatchService>,
    pending_chat_queue_requests: Mutex<HashMap<String, oneshot::Sender<proto::ChatQueueResponse>>>,
    terminal_forwarder_once: Once,
    terminal_stream_forwarder_once: Once,
    sftp_forwarder_once: Once,
    remote_chat_inbox_sweeper_once: Once,
    runtime_status_republisher_once: Once,
    pub(crate) tunnel_store_once: Once,
}
