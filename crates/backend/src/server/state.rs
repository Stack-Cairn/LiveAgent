//! 后端进程共享状态。
//!
//! 桌面壳用 `tauri::State` 逐个注入这些 registry；这里换成一个 `AppState`，
//! 因为 axum 的 extractor 只认一个 state 类型。装的是**同一批 Arc**——
//! backend 的函数签名两边通用，行为不可能不一致。
//!
//! 决策 9：一个后端支持多前端同时连。所以 registry 是**进程级共享**的，
//! 不按连接分。9 个持有句柄的命令（git_clone_repository_*、shell_run、
//! runtime_cancel、hook_*）需要的会话隔离是 P2-24 的独立议题，不在这里糊。

use std::sync::Arc;

use crate::commands::git::GitCloneTaskRegistry;
use crate::commands::hook::HookScopeRegistry;
use crate::commands::mcp::McpRuntimeManager;
use crate::events::EventBus;
use crate::runtime::managed_process::ManagedProcessRegistry;
use crate::runtime::sftp::SftpSessionRegistry;
use crate::runtime::shell_runner::ShellRunRegistry;
use crate::runtime::terminal::TerminalSessionRegistry;
use crate::services::automation::{AutomationScheduler, AutomationStore};
use crate::services::memory::MemoryStore;
use crate::services::power_activity::PowerActivityManager;
use crate::services::provider_usage::ProviderUsageService;
use crate::services::tunnel::TunnelStore;
use crate::services::workspace_watch::WorkspaceWatchService;

#[derive(Clone)]
pub struct AppState {
    pub events: Arc<EventBus>,
    pub automation_store: Arc<AutomationStore>,
    pub automation_scheduler: Arc<AutomationScheduler>,
    pub memory_store: Arc<MemoryStore>,
    pub provider_usage: Arc<ProviderUsageService>,
    pub power_activity: Arc<PowerActivityManager>,
    pub managed_processes: Arc<ManagedProcessRegistry>,
    pub terminals: Arc<TerminalSessionRegistry>,
    pub sftp: Arc<SftpSessionRegistry>,
    pub shell_runs: Arc<ShellRunRegistry>,
    pub git_clone_tasks: Arc<GitCloneTaskRegistry>,
    pub hook_scopes: Arc<HookScopeRegistry>,
    pub mcp: Arc<McpRuntimeManager>,
    pub workspace_watch: Arc<WorkspaceWatchService>,
    /// 隧道状态。数据面（真正的监听）藏在它内部持有的 `TunnelDataPlane` 里，
    /// 所以这里只需要一个句柄——命令层不该直接碰监听。
    pub tunnels: Arc<TunnelStore>,
    /// 认证凭据。密码即 Bearer token（决策 7）。用户密码和内部 token 都存这里。
    pub auth: Arc<crate::server::auth::AuthConfig>,
    /// 内部服务 token。与用户密码同权，供内部调用方走 Bearer 认证。
    pub internal_token: String,
    /// WS 事件流入口：EventBus 往里写，每个 `/api/events` 连接订阅它。
    pub ws_sink: Arc<crate::server::ws::WsEventSink>,
    /// 工具审批注册表。
    pub approvals: Arc<crate::approval::ApprovalRegistry>,
    /// pi 引擎会话表。每个 conversationId 一个 `pi --mode rpc` 子进程。
    pub pi_sessions: Arc<crate::pi::PiSessionManager>,
    /// HTTP 后端监听端口。
    pub backend_port: u16,
}
