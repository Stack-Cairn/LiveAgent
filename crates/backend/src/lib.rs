//! LiveAgent 后端：HTTP/WS 服务 + 核心能力（工具、存储、运行时）。
//!
//! 这是后端**唯一的对外网络入口**（决策 5）。桌面壳和 WebUI 打的是同一套 API，
//! 调的是本 crate 里同一批函数——所以工具行为不可能两边不一致。
//!
//! chat 引擎是 `pi --mode rpc` 子进程，由 `pi` 模块管理（每会话一进程），
//! 事件经翻译层直接进 EventBus。前端契约见 docs/design/pi-rpc-event-contract.md。
//!
//! 核心能力模块（`commands` / `runtime` / `services` / `storage`）**不含任何 UI
//! 框架依赖**——见 Cargo.toml 的编译期防线说明。两个消费者：
//! - `crates/frontend/src-tauri` 桌面壳，通过 `#[tauri::command]` 薄包装调用
//! - 本 crate 的 HTTP/WS 服务，通过 JSON 路由调用
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
pub mod commands;
pub mod events;
pub mod pi;
pub mod runtime;
pub mod server;
pub mod services;
pub mod storage;

use std::sync::{Arc, OnceLock};

static APP_VERSION: OnceLock<String> = OnceLock::new();

/// 由宿主进程在启动时注入版本号。
///
/// 版本是**部署事实**不是核心事实：它来自 `package.json` / git tag，由打包流程决定。
/// 搬迁前 `app_version()` 靠 src-tauri 的 build.rs 塞 `env!`，那条路在这里走不通——
/// 核心模块编译时根本不知道自己会被装进哪个产物。所以改成注入。
///
/// 重复注入是无操作（`OnceLock`），因为「谁先启动」不该影响结果。
pub fn set_app_version(version: impl Into<String>) {
    let _ = APP_VERSION.set(version.into());
}

/// 宿主未注入时返回 `0.0.0-unknown`，不 panic：版本号只用于 MCP `clientInfo`
/// 这类自报家门的场合，拿不到不该让整个后端起不来。
pub fn app_version() -> &'static str {
    APP_VERSION
        .get()
        .map(String::as_str)
        .unwrap_or("0.0.0-unknown")
}

use axum::routing::get;
use axum::Router;

use crate::server::state::AppState;

/// 组装整个应用的路由。
///
/// `/healthz` 故意放在认证之外：探活不该需要密码，否则容器编排拿不到健康状态。
/// 它也**不泄露任何信息**——只回 `ok`。
pub fn build_router(state: AppState) -> Router {
    let protected =
        server::api_router()
            .route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                server::auth::require_bearer,
            ))
            // WS 不能过 bearer 中间件：浏览器 WebSocket API 设不了 Authorization
            // header。ws_handler 自己用 ?token= 做等价校验。
            .merge(server::ws::router());

    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest("/api", protected)
        // 浏览器前端（vite dev / WebUI）跨源访问：认证是 Bearer token 而非
        // cookie/同源，permissive CORS 不引入新的攻击面。
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state)
}

/// 构造后端状态：装好全部 registry，并把事件总线接到 WS sink 和各发事件方。
///
/// 对照桌面壳 `.setup()` 的接线（frontend lib.rs:765-784）：
///  - WS sink 注册进 EventBus（纯后端模式下 WS 客户端才能收到事件）
///  - managed_process / terminal / sftp 三个 registry 调 set_event_bus（否则
///    这些子系统的事件根本到不了总线，P2-31 验收时发现的实际缺口）
///  - automation notifier + scheduler.start()（定时任务才跑得起来）
///  - managed process 的 startup_reconcile / monitor（进程快照自愈）
///
/// 隧道**不在**这里恢复：`TunnelStore::initialize` 要读库还要起监听，是 async
/// 且会失败的。放进 `serve` 前由调用方显式 await，见 `main.rs`。
pub fn build_state(auth: Arc<server::auth::AuthConfig>, backend_port: u16) -> Result<AppState, String> {
    use crate::events::EventBus;
    use crate::services::automation::AutomationNotifier;
    use crate::services::tunnel::TunnelStore;

    let events = Arc::new(EventBus::new());
    // 建表。桌面壳在 setup 第一行做这件事（frontend lib.rs:730）；纯后端模式下
    // 漏掉它，chat_history_* 全部报 "no such table: chatHistory"——路由可达、
    // 契约测试全绿，但功能是坏的。P2-31 用 curl 实测时抓到的。
    crate::commands::history_db::initialize_history_db()
        .map_err(|e| format!("初始化 history 库失败：{e}"))?;
    let automation_store = Arc::new(
        crate::services::automation::AutomationStore::open()
            .map_err(|e| format!("打开 automation 存储失败：{e}"))?,
    );
    let automation_scheduler = Arc::new(
        crate::services::automation::AutomationScheduler::new(Arc::clone(&automation_store)),
    );
    let memory_store = Arc::new(
        crate::services::memory::MemoryStore::open()
            .map_err(|e| format!("打开 memory 存储失败：{e}"))?,
    );

    // 这两个不是 Default：SftpSessionRegistry 复用终端的 SSH 连接，
    // WorkspaceWatchService 要往总线上发变更，都得先有依赖才能建。
    let terminals: Arc<crate::runtime::terminal::TerminalSessionRegistry> =
        Arc::new(Default::default());
    let sftp = Arc::new(crate::runtime::sftp::SftpSessionRegistry::new(
        Arc::clone(&terminals),
    ));
    let workspace_watch = Arc::new(
        crate::services::workspace_watch::WorkspaceWatchService::new(Arc::clone(&events)),
    );
    let tunnels = Arc::new(TunnelStore::new(
        Arc::clone(&events),
        Arc::new(crate::services::tunnel::data_plane::TunnelDataPlane::new()),
    ));

    // 事件接线（顺序与桌面壳 setup 一致）。
    let ws_sink = Arc::new(crate::server::ws::WsEventSink::new());
    events.register(ws_sink.clone());
    terminals.set_event_bus(Arc::clone(&events));
    sftp.set_event_bus(Arc::clone(&events));
    let managed_processes: Arc<crate::runtime::managed_process::ManagedProcessRegistry> =
        Arc::new(Default::default());
    managed_processes.set_event_bus(Arc::clone(&events));
    managed_processes.spawn_startup_reconcile();
    managed_processes.spawn_monitor();
    automation_store.set_notifier(AutomationNotifier {
        events: Arc::clone(&events),
        scheduler: Arc::downgrade(&automation_scheduler),
    });
    Arc::clone(&automation_scheduler).start();

    // 审批注册表要同时给 HTTP 路由（前端应答）和 pi 会话（发起审批）用，
    // 所以先建再分发——两边必须是同一张 pending 表，否则应答找不到请求。
    let approvals = Arc::new(crate::approval::ApprovalRegistry::new());
    let pi_sessions = Arc::new(crate::pi::PiSessionManager::new(
        Arc::clone(&events),
        Arc::clone(&approvals),
    ));

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
        ws_sink,
        approvals,
        pi_sessions,
        backend_port,
    })
}
