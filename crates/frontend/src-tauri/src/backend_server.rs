//! Tauri 壳内嵌后端服务启动。
//!
//! 直接在壳内启动 backend 的 HTTP 服务，避免与独立 backend 共享库文件冲突。
//! 前端打到 Rust，chat 引擎是 Rust 按会话拉起的 `pi --mode rpc` 子进程。
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
    /// pi 会话表。持有它是为了壳退出时能把子进程收干净。
    pi_sessions: std::sync::Arc<backend::pi::PiSessionManager>,
}

impl BackendServer {
    /// 壳退出时收掉所有 pi 会话进程。
    pub fn shutdown_sessions(&self) {
        self.pi_sessions.shutdown_all();
    }
}

/// 启动内嵌后端服务。
///
/// 执行流程：
/// 1. 找一个空闲端口
/// 2. 构造后端状态（固定默认密码）
/// 3. 构造后端状态
/// 4. 启动 HTTP 服务（async 任务）
/// 5. 返回服务元数据给前端
///
/// 这里不再拉起 chat 引擎：pi 进程由 `PiSessionManager` 在首次 chat_send
/// 时按会话惰性启动，壳启动路径上没有引擎就绪这一步了。
pub async fn start_backend_server() -> Result<BackendServer, String> {
    // 找一个空闲的 TCP 端口。
    let port = find_free_port().await?;

    // 桌面端只在 127.0.0.1 上服务自己，本不需要密码。为了和独立后端
    // 共用同一条认证路径，直接注入固定默认密码，不另走特例。
    let password = backend::server::auth::DEFAULT_PASSWORD.to_string();

    // 生成认证配置。
    let auth = std::sync::Arc::new(backend::server::auth::AuthConfig::new(password.clone()));

    // 构造后端状态。
    let state = backend::build_state(auth, port)
        .map_err(|e| format!("构造后端状态失败：{e}"))?;
    let pi_sessions = std::sync::Arc::clone(&state.pi_sessions);

    // 启动 HTTP 服务（运行在后台）。
    // 注意：这里不 await，服务在后台持续运行。如果 tokio runtime 退出，服务自动停止。
    tokio::spawn(async move {
        let app = backend::build_router(state);
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));

        if let Err(e) = axum::serve(
            TcpListener::bind(addr).await.expect("绑定 localhost 端口失败"),
            app,
        )
        .await
        {
            eprintln!("后端 HTTP 服务崩溃：{e}");
        }
    });

    Ok(BackendServer {
        port,
        password,
        pi_sessions,
    })
}

/// 选一个空闲的 TCP 端口。
///
/// 通过 bind :0 让操作系统分配，然后立即释放。
async fn find_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind 失败：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("获取本地地址失败：{e}"))?
        .port();
    drop(listener);
    Ok(port)
}

