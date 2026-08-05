//! 后端进程共享状态。
//!
//! 桌面壳用 `tauri::State` 逐个注入这些 registry；这里换成一个 `AppState`，
//! 因为 axum 的 extractor 只认一个 state 类型。装的是**同一批 Arc**——
//! agent-core 的函数签名两边通用，行为不可能不一致。
//!
//! 决策 9：一个后端支持多前端同时连。所以 registry 是**进程级共享**的，
//! 不按连接分。9 个持有句柄的命令（git_clone_repository_*、shell_run、
//! runtime_cancel、hook_*）需要的会话隔离是 P2-24 的独立议题，不在这里糊。

use std::sync::Arc;

use agent_core::commands::git::GitCloneTaskRegistry;
use agent_core::commands::hook::HookScopeRegistry;
use agent_core::commands::mcp::McpRuntimeManager;
use agent_core::events::EventBus;
use agent_core::runtime::managed_process::ManagedProcessRegistry;
use agent_core::runtime::sftp::SftpSessionRegistry;
use agent_core::runtime::shell_runner::ShellRunRegistry;
use agent_core::runtime::terminal::TerminalSessionRegistry;
use agent_core::services::automation::{AutomationScheduler, AutomationStore};
use agent_core::services::memory::MemoryStore;
use agent_core::services::power_activity::PowerActivityManager;
use agent_core::services::provider_usage::ProviderUsageService;
use agent_core::services::tunnel::TunnelStore;
use agent_core::services::workspace_watch::WorkspaceWatchService;
use tokio::sync::RwLock;

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
    pub auth: Arc<crate::auth::AuthConfig>,
    /// 内部服务 token（Node 引擎⇄Rust 后端）。spawn 子进程时经环境变量传出。
    pub internal_token: String,
    /// WS 事件流入口：EventBus 往里写，每个 `/api/events` 连接订阅它。
    pub ws_sink: Arc<crate::ws::WsEventSink>,
    /// 工具审批注册表。
    pub approvals: Arc<crate::approval::ApprovalRegistry>,
    /// Node 引擎监听端口。127.0.0.1:node_port 为反向代理目标。未启动时为 None。
    pub node_port: Arc<RwLock<Option<u16>>>,
}
