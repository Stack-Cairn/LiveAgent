//! Tauri 壳内嵌后端服务启动。
//!
//! 直接在壳内启动 backend 的 HTTP 服务，避免与独立 backend 共享库文件冲突。
//! 前端打到 Rust，Rust 反向代理 chat 请求到 Node 引擎（core bundle）。
//!
//! 决策：壳与独立 backend 不能同机并跑（同一 ~/.liveagent 库）——
//! 壳内嵌就是为了避开这个。

use tokio::net::TcpListener;

/// 后端服务状态。
#[derive(Clone)]
pub struct BackendServer {
    /// HTTP 服务监听的端口。
    pub port: u16,
    /// 认证密码（固定默认值，壳注入给前端）。
    pub password: String,
    /// Node 引擎进程句柄。持有它直到壳退出，drop 即同步 kill 子进程。
    engine: std::sync::Arc<tokio::sync::Mutex<Option<backend::engine_process::EngineProcess>>>,
}

impl BackendServer {
    /// 壳退出时关闭 Node 引擎。EngineProcess 的 Drop 会同步 kill child。
    pub fn shutdown_engine(&self) {
        // 同步上下文里用 try_lock：除守护循环外没人长期持锁，失败时
        // EngineProcess 的 kill_on_drop 仍会兜底。
        if let Ok(mut guard) = self.engine.try_lock() {
            drop(guard.take());
        }
    }
}

/// 启动内嵌后端服务，并可选启动 Node 引擎。
///
/// 执行流程：
/// 1. bind :0 拿系统分配的空闲端口（监听立即生效，没有「先探测再 bind」的窗口）
/// 2. 构造后端状态（固定默认密码），启动 HTTP 服务（async 任务）
/// 3. 如果提供了 bundle 路径，启动 Node 引擎（失败降级为纯 API 模式）
/// 4. 返回服务元数据给前端
///
/// 顺序是硬约束：Node 引擎启动即回调 backend（cron claim、事件回流），
/// 监听必须先于 spawn 生效，否则引擎启动窗口内的回调全部 ECONNREFUSED。
pub async fn start_backend_server(
    engine_bundle: Option<std::path::PathBuf>,
) -> Result<BackendServer, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("绑定 localhost 端口失败：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("获取本地地址失败：{e}"))?
        .port();

    // 桌面端只在 127.0.0.1 上服务自己，本不需要密码。为了和独立后端
    // 共用同一条认证路径，直接注入固定默认密码，不另走特例。
    let password = backend::server::auth::DEFAULT_PASSWORD.to_string();

    // 生成认证配置。
    let auth = std::sync::Arc::new(backend::server::auth::AuthConfig::new(password.clone()));

    // 构造后端状态。
    let state = backend::build_state(auth, port)
        .map_err(|e| format!("构造后端状态失败：{e}"))?;

    // 启动 HTTP 服务（运行在后台）。listener 已 bind，内核在排队连接，
    // 此后 spawn 的 Node 引擎随时可以回调。
    // 注意：这里不 await，服务在后台持续运行。如果 tokio runtime 退出，服务自动停止。
    let app = backend::build_router(state.clone());
    tokio::spawn(async move {
        // 认证只看 Bearer 凭据（Node 引擎带 spawn 时下发的引擎凭据），
        // 对端地址不参与判断，所以不需要 with_connect_info。
        if let Err(e) = axum::serve(listener, app.into_make_service()).await {
            eprintln!("后端 HTTP 服务崩溃：{e}");
        }
    });

    // 启动 Node 引擎（如果提供了 bundle 路径）。
    let engine = if let Some(bundle_path) = engine_bundle {
        match backend::engine_process::spawn_engine(state, bundle_path).await {
            Ok(engine_process) => {
                eprintln!("Node 引擎启动成功");
                std::sync::Arc::new(tokio::sync::Mutex::new(Some(engine_process)))
            }
            Err(e) => {
                eprintln!("警告：启动 Node 引擎失败，纯 API 模式继续运行：{e}");
                std::sync::Arc::new(tokio::sync::Mutex::new(None))
            }
        }
    } else {
        eprintln!("未提供 Node 引擎 bundle，纯 API 模式运行");
        std::sync::Arc::new(tokio::sync::Mutex::new(None))
    };

    Ok(BackendServer { port, password, engine })
}
