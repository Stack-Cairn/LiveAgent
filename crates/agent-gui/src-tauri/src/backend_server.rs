//! Tauri 壳内嵌后端服务启动。
//!
//! 直接在壳内启动 agent-backend 的 HTTP 服务，避免与独立 agent-backend 共享库文件冲突。
//! 前端打到 Rust、Rust 反向代理请求到 Node。
//!
//! 决策：壳与独立 agent-backend 不能同机并跑（同一 ~/.liveagent 库）——
//! 壳内嵌就是为了避开这个。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;

/// 后端服务状态。
#[derive(Clone)]
pub struct BackendServer {
    /// HTTP 服务监听的端口。
    pub port: u16,
    /// 认证密码（生成的随机字符串）。
    pub password: String,
    /// Node 引擎进程句柄。持有这个句柄直到后端服务关闭，保证引擎进程生命周期。
    pub engine: std::sync::Arc<tokio::sync::Mutex<Option<agent_backend::engine_process::EngineProcess>>>,
}

/// 启动内嵌后端服务，并可选启动 Node 引擎。
///
/// 执行流程：
/// 1. 找一个空闲端口
/// 2. 生成随机密码和内部 token
/// 3. 构造后端状态
/// 4. 启动 HTTP 服务（async 任务）
/// 5. 如果提供了 bundle_path，启动 Node 引擎
/// 6. 返回服务元数据给前端
pub async fn start_backend_server(engine_bundle: Option<std::path::PathBuf>) -> Result<BackendServer, String> {
    // 找一个空闲的 TCP 端口。
    let port = find_free_port().await?;

    // 生成密码和内部 token。
    let password = agent_backend::auth::generate_password();
    let internal_token = agent_backend::auth::generate_password();

    // 生成认证配置。
    let auth = std::sync::Arc::new(agent_backend::auth::AuthConfig::new(password.clone(), internal_token.clone()));

    // 构造后端状态。
    let state = agent_backend::build_state(auth, internal_token, port)
        .map_err(|e| format!("构造后端状态失败：{e}"))?;

    // 启动 Node 引擎（如果提供了 bundle 路径）。
    // 这必须在 HTTP 服务启动之前，因为引擎需要就绪探测。
    let engine = if let Some(bundle_path) = engine_bundle {
        match agent_backend::engine_process::spawn_engine(state.clone(), bundle_path).await {
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

    // 启动 HTTP 服务（运行在后台）。
    // 注意：这里不 await，服务在后台持续运行。如果 tokio runtime 退出，服务自动停止。
    tokio::spawn(async move {
        let app = agent_backend::build_router(state);
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

    Ok(BackendServer { port, password, engine })
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

