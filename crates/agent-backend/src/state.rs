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
use agent_core::services::workspace_watch::WorkspaceWatchService;

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
    /// 认证凭据。密码即 Bearer token（决策 7）。
    pub auth: Arc<crate::auth::AuthConfig>,
}
