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

pub mod approval;
pub mod auth;
pub mod engine_process;
pub mod engine_proxy;
pub mod json;
pub mod routes;
pub mod routes_gen;
pub mod ssrf;
pub mod state;
pub mod tls;
pub mod tunnel;
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
                auth::require_bearer_with_identity,
            ));

    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest("/api", protected)
        .with_state(state)
}

/// 构造后端状态：装好全部 registry，并把事件总线接到 WS sink 和各发事件方。
///
/// 对照桌面壳 `.setup()` 的接线（agent-gui lib.rs:765-784）：
///  - WS sink 注册进 EventBus（纯后端模式下 WS 客户端才能收到事件）
///  - managed_process / terminal / sftp 三个 registry 调 set_event_bus（否则
///    这些子系统的事件根本到不了总线，P2-31 验收时发现的实际缺口）
///  - automation notifier + scheduler.start()（定时任务才跑得起来）
///  - managed process 的 startup_reconcile / monitor（进程快照自愈）
///
/// 隧道**不在**这里恢复：`TunnelStore::initialize` 要读库还要起监听，是 async
/// 且会失败的。放进 `serve` 前由调用方显式 await，见 `main.rs`。
pub fn build_state(auth: Arc<auth::AuthConfig>, internal_token: String, backend_port: u16) -> Result<AppState, String> {
    use agent_core::events::EventBus;
    use agent_core::services::automation::AutomationNotifier;
    use agent_core::services::tunnel::TunnelStore;

    let events = Arc::new(EventBus::new());
    // 建表。桌面壳在 setup 第一行做这件事（agent-gui lib.rs:730）；纯后端模式下
    // 漏掉它，chat_history_* 全部报 "no such table: chatHistory"——路由可达、
    // 契约测试全绿，但功能是坏的。P2-31 用 curl 实测时抓到的。
    agent_core::commands::history_db::initialize_history_db()
        .map_err(|e| format!("初始化 history 库失败：{e}"))?;
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
    let tunnels = Arc::new(TunnelStore::new(
        Arc::clone(&events),
        Arc::new(crate::tunnel::TunnelDataPlane::new()),
    ));

    // 事件接线（顺序与桌面壳 setup 一致）。
    let ws_sink = Arc::new(crate::ws::WsEventSink::new());
    events.register(ws_sink.clone());
    terminals.set_event_bus(Arc::clone(&events));
    sftp.set_event_bus(Arc::clone(&events));
    let managed_processes: Arc<agent_core::runtime::managed_process::ManagedProcessRegistry> =
        Arc::new(Default::default());
    managed_processes.set_event_bus(Arc::clone(&events));
    managed_processes.spawn_startup_reconcile();
    managed_processes.spawn_monitor();
    automation_store.set_notifier(AutomationNotifier {
        events: Arc::clone(&events),
        scheduler: Arc::downgrade(&automation_scheduler),
    });
    Arc::clone(&automation_scheduler).start();

    Ok(AppState {
        events,
        automation_store,
        automation_scheduler,
        memory_store,
        provider_usage: Arc::new(Default::default()),
        power_activity: Arc::new(Default::default()),
        managed_processes,
        terminals,
        sftp,
        shell_runs: Arc::new(Default::default()),
        git_clone_tasks: Arc::new(Default::default()),
        hook_scopes: Arc::new(Default::default()),
        mcp: Arc::new(Default::default()),
        workspace_watch,
        tunnels,
        auth,
        internal_token,
        ws_sink,
        approvals: Arc::new(crate::approval::ApprovalRegistry::new()),
        node_port: Arc::new(tokio::sync::RwLock::new(None)),
        backend_port,
    })
}
