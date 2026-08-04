//! LiveAgent 后端 HTTP/WS 服务。
//!
//! 这是后端**唯一的对外网络入口**（决策 5）。桌面壳和 Node 引擎打的是同一套 API，
//! 调的是 agent-core 里同一批函数——所以工具行为不可能两边不一致。
//!
//! ## 路由约定：命令式，不做 REST 化
//!
//! ```text
//! invoke("git_status", { workdir })   →   POST /api/git_status   { "workdir": "..." }
//! ```
//!
//! 前端**现在**就在用这些命令名和参数对象（`#[tauri::command]` 的参数名就是 JSON key）。
//! 1:1 映射让阶段 4 是机械替换；REST 化等于做 195 次独立设计决策，
//! 每次都是一个破坏前端的机会。这是消除特殊情况，不是制造 195 个。
//!
//! `rename_all` 逐命令沿用现状，不统一——部分命令写了 `snake_case`，部分没写
//! （默认 camelCase）。已知不一致的有 `git_clone_repository_tasks`、
//! `chat_history_replace_from_message`。统一它们就是破坏前端。
//!
//! 流式端点是唯一例外，走 WS（`/api/events`）。

pub mod auth;
pub mod routes;
pub mod ssrf;
pub mod state;
pub mod tls;
pub mod ws;

use std::sync::Arc;

use axum::routing::get;
use axum::Router;

use crate::state::AppState;

/// 组装整个应用的路由。
///
/// `/healthz` 故意放在认证之外：探活不该需要密码，否则容器编排拿不到健康状态。
/// 它也**不泄露任何信息**——只回 `ok`。
pub fn build_router(state: AppState) -> Router {
    let protected =
        routes::api_router()
            .merge(ws::router())
            .route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::require_bearer,
            ));

    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest("/api", protected)
        .with_state(state)
}

/// 构造一个只挂了 registry、没接任何事件消费者的后端状态。
///
/// 事件 sink 由调用方注册：本地模式下桌面壳注册自己的，纯后端模式下注册 WS sink。
pub fn build_state(auth: Arc<auth::AuthConfig>) -> Result<AppState, String> {
    use agent_core::events::EventBus;

    let events = Arc::new(EventBus::new());
    let automation_store = Arc::new(
        agent_core::services::automation::AutomationStore::open()
            .map_err(|e| format!("打开 automation 存储失败：{e}"))?,
    );
    let automation_scheduler = Arc::new(
        agent_core::services::automation::AutomationScheduler::new(Arc::clone(&automation_store)),
    );
    let memory_store = Arc::new(
        agent_core::services::memory::MemoryStore::open()
            .map_err(|e| format!("打开 memory 存储失败：{e}"))?,
    );

    // 这两个不是 Default：SftpSessionRegistry 复用终端的 SSH 连接，
    // WorkspaceWatchService 要往总线上发变更，都得先有依赖才能建。
    let terminals: Arc<agent_core::runtime::terminal::TerminalSessionRegistry> =
        Arc::new(Default::default());
    let sftp = Arc::new(agent_core::runtime::sftp::SftpSessionRegistry::new(
        Arc::clone(&terminals),
    ));
    let workspace_watch = Arc::new(
        agent_core::services::workspace_watch::WorkspaceWatchService::new(Arc::clone(&events)),
    );

    Ok(AppState {
        events,
        automation_store,
        automation_scheduler,
        memory_store,
        provider_usage: Arc::new(Default::default()),
        power_activity: Arc::new(Default::default()),
        managed_processes: Arc::new(Default::default()),
        terminals,
        sftp,
        shell_runs: Arc::new(Default::default()),
        git_clone_tasks: Arc::new(Default::default()),
        hook_scopes: Arc::new(Default::default()),
        mcp: Arc::new(Default::default()),
        workspace_watch,
        auth,
    })
}
