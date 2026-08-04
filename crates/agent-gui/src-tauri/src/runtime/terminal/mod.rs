//! 终端运行时模块（拆分自原单文件 terminal.rs，代码逐字迁移，行为不变）。
//!
//! - [`types`]：对外 DTO / 事件负载与响应结构
//! - [`state`]：会话内部状态（会话表项、SSH 会话运行时、挂起提示等）
//! - [`output`]：输出环形缓冲、回显判定与尾部读取
//! - [`registry`]：`TerminalSessionRegistry` 核心生命周期（创建/列表/输入/尺寸/关闭/订阅）
//! - [`ssh_session`]：SSH 会话编排（创建/提示应答/重连/延迟/exec）
//! - [`tabs`]：SSH 终端标签页快照与清理
//! - [`events`]：事件广播与终端流分发
//! - [`ssh_connect`]：SSH 传输建立与 HTTP/SOCKS5 代理
//! - [`ssh_auth`]：SSH 认证材料解析、身份路径展开与键盘交互认证
//! - [`ssh_channel`]：SSH shell/exec/SFTP 通道
//! - [`ssh_io`]：SSH 会话 IO 泵与重连执行器
//! - [`shell`]：本地 shell 解析、PTY 环境与进程清理
//! - [`util`]：小型辅助函数

use std::collections::HashMap;
use std::sync::atomic::AtomicUsize;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use agent_core::events::EventBus;

mod events;
mod output;
mod registry;
mod shell;
mod ssh_auth;
mod ssh_channel;
mod ssh_connect;
mod ssh_io;
mod ssh_local_forward;
mod ssh_session;
mod state;
mod tabs;
#[cfg(test)]
mod tests;
mod types;
mod util;

pub(crate) use output::*;
pub use shell::terminal_shell_options;
pub(crate) use shell::*;
pub(crate) use ssh_auth::*;
pub(crate) use ssh_channel::*;
pub(crate) use ssh_connect::*;
pub(crate) use ssh_io::*;
pub(crate) use ssh_local_forward::*;
pub(crate) use state::*;
pub use types::*;
pub(crate) use util::*;

pub(crate) const DEFAULT_ROWS: u16 = 24;
pub(crate) const DEFAULT_COLS: u16 = 80;
pub(crate) const MAX_RING_CHUNKS: usize = 4096;
pub(crate) const MAX_TAIL_BYTES: usize = 256 * 1024;
pub(crate) const SSH_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const SSH_RECONNECT_MAX_ATTEMPTS: u8 = 3;
pub(crate) const SSH_RECONNECT_DELAYS: [Duration; 3] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
];
pub(crate) const SSH_RECONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);
pub(crate) const SSH_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
pub(crate) const SSH_KEEPALIVE_MAX_MISSES: usize = 3;
pub(crate) const SSH_STATUS_CONNECTED: &str = "connected";
pub(crate) const SSH_STATUS_RECONNECTING: &str = "reconnecting";
pub(crate) const SSH_STATUS_DISCONNECTED: &str = "disconnected";
pub const TERMINAL_EVENT_NAME: &str = "terminal:event";
pub const TERMINAL_STREAM_EVENT_NAME: &str = "terminal:stream";
pub const SSH_LOCAL_FORWARD_EVENT_NAME: &str = "terminal:ssh-local-forward";
pub(crate) const SSH_LOCAL_FORWARD_CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const SSH_LOCAL_FORWARD_MAX_PER_SESSION: usize = 8;
pub(crate) const SSH_LOCAL_FORWARD_MAX_CONNECTIONS: usize = 32;
pub(crate) const SSH_LOCAL_FORWARD_MAX_GLOBAL_CONNECTIONS: usize = 128;
pub(crate) const SSH_EXEC_DEFAULT_MAX_BYTES: usize = 64 * 1024;
pub(crate) const SSH_EXEC_MAX_BYTES: usize = 256 * 1024;
pub(crate) const SSH_EXEC_DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const SSH_EXEC_MAX_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct TerminalSessionRegistry {
    sessions: Mutex<HashMap<String, Arc<TerminalSessionEntry>>>,
    pending_ssh_prompts: Mutex<HashMap<String, PendingSshPrompt>>,
    ssh_terminal_tabs_tx: Mutex<()>,
    ssh_terminal_tabs: Mutex<HashMap<String, SshTerminalTabsState>>,
    events: Mutex<Option<Arc<EventBus>>>,
    subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<TerminalEvent>>>>,
    stream_subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<TerminalStreamEvent>>>>,
    echo_dispatch: Mutex<HashMap<String, TerminalEchoDispatchState>>,
    ssh_local_forwards: SshLocalForwardRegistry,
    next_subscriber_id: AtomicUsize,
}

impl Drop for TerminalSessionRegistry {
    fn drop(&mut self) {
        self.ssh_local_forwards.cancel_all();
        if let Ok(sessions) = self.sessions.get_mut() {
            for entry in sessions.values() {
                terminate_terminal_entry(entry);
            }
            sessions.clear();
        }
    }
}
