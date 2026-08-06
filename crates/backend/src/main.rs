//! 后端进程入口。
//!
//! 用法：
//! ```text
//! backend --port 8443 [--password <pw>] [--data-dir <dir>]
//! ```
//!
//! 每个参数都有对应的环境变量兜底（argv 优先）：`PORT`、
//! `LIVEAGENT_BACKEND_PASSWORD`、`LIVEAGENT_DATA_DIR`。容器平台（Railway 等）
//! 只会给环境变量，以前靠一层 entrypoint 脚本翻译，现在后端直接认。
//!
//! 不给密码就用默认值 `pleasechangethepassword` 并在 stderr 警告（决策 8）。
//! 传输加密不归这个进程管：对外部署放在平台/反代的 TLS 终结之后。
//!
//! chat 引擎是 Node 子进程（core bundle），用 `--engine-bundle` 指向打包产物
//! 目录（内含 index.js），环境变量兜底 `LIVEAGENT_ENGINE_BUNDLE`。
//! 不给则纯 API 模式运行（chat 三条路由 503）。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use backend::server::auth;
use backend::{build_router, build_state, engine_process};

struct Args {
    port: u16,
    password: Option<String>,
    engine_bundle: Option<PathBuf>,
}

/// 非空环境变量，空串按未设置处理（`FOO=` 是平台 UI 里清空后留下的残渣）。
fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// 手写参数解析而不是引 clap：三个参数，clap 会带进来一整棵依赖树。
/// argv 没给的项从环境变量补齐，之后不再有第二条配置路径。
fn parse_args() -> Result<Args, String> {
    let mut port: Option<u16> = None;
    let mut args = Args { port: 0, password: None, engine_bundle: None };
    let mut data_dir: Option<PathBuf> = None;
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut take = |name: &str| it.next().ok_or_else(|| format!("{name} 需要一个值"));
        match flag.as_str() {
            "--port" => {
                port = Some(
                    take("--port")?
                        .parse()
                        .map_err(|_| "--port 必须是 1-65535 的整数".to_string())?,
                );
            }
            "--password" => args.password = Some(take("--password")?),
            "--engine-bundle" => {
                args.engine_bundle = Some(PathBuf::from(take("--engine-bundle")?))
            }
            "--data-dir" => data_dir = Some(PathBuf::from(take("--data-dir")?)),
            "--help" | "-h" => {
                println!(
                    "backend [--port <PORT>] [--password <PW>] [--engine-bundle <DIR>] [--data-dir <DIR>]\n\
                     环境变量兜底：PORT、LIVEAGENT_BACKEND_PASSWORD、LIVEAGENT_ENGINE_BUNDLE、LIVEAGENT_DATA_DIR\n\
                     --engine-bundle 指向 Node 引擎打包产物目录（内含 index.js），不给则纯 API 模式"
                );
                std::process::exit(0);
            }
            other => return Err(format!("未知参数：{other}")),
        }
    }

    // env 兜底。做完之后下游只看 Args，不再碰环境变量。
    let env_port = env_var("PORT")
        .map(|v| v.parse().map_err(|_| "PORT 必须是 1-65535 的整数".to_string()))
        .transpose()?;
    args.port = port.or(env_port).unwrap_or(8443);
    args.password = args.password.or_else(|| env_var("LIVEAGENT_BACKEND_PASSWORD"));
    args.engine_bundle = args
        .engine_bundle
        .or_else(|| env_var("LIVEAGENT_ENGINE_BUNDLE").map(PathBuf::from));

    // 数据目录反着走：backend 的路径解析只认 LIVEAGENT_DATA_DIR 环境变量
    // （见 backend::storage），--data-dir 就翻译成它。这里还在 main 的
    // 单线程早期，set_var 安全。都不设则 storage 落回 ~/.liveagent——
    // 桌面壳的路径行为不变。
    if let Some(dir) = data_dir {
        std::env::set_var(backend::storage::DATA_DIR_ENV, dir);
    }

    Ok(args)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args()?;

    let password = match args.password {
        Some(password) => password,
        None => {
            eprintln!(
                "警告：未提供 --password，使用默认密码 {}。对外部署前务必改掉。",
                auth::DEFAULT_PASSWORD
            );
            auth::DEFAULT_PASSWORD.to_string()
        }
    };

    let state = build_state(Arc::new(auth::AuthConfig::new(password)), args.port)?;
    // 恢复上次留下的隧道：读库、给存活的重新起监听。端口和 token 是本次进程
    // 新分配的，所以链接会变——这是有意的（见 services/tunnel/store.rs 文档）。
    // 失败只记日志不中止：隧道起不来不该让整个后端服务不起来。
    if let Err(error) = state.tunnels.initialize().await {
        eprintln!("恢复隧道失败：{error}");
    }
    // 周期清扫过期隧道：TTL 的强制执行就在这里，不起它 TTL 只是显示值。
    state.tunnels.spawn_sweeper();

    // 启动 Node 引擎（如果提供了 bundle）。句柄要活到进程退出，
    // drop 即同步 kill 子进程（决策 11：不留孤儿）。
    let _engine = if let Some(bundle_path) = args.engine_bundle.clone() {
        match engine_process::spawn_engine(state.clone(), bundle_path).await {
            Ok(engine) => Some(engine),
            Err(e) => {
                eprintln!("警告：启动 Node 引擎失败，纯 API 模式继续运行：{e}");
                None
            }
        }
    } else {
        eprintln!("未提供 --engine-bundle，纯 API 模式运行");
        None
    };

    let app = build_router(state);
    let addr = SocketAddr::from(([0, 0, 0, 0], args.port));

    // 处理 SIGTERM/SIGINT，确保退出时收掉 pi 子进程。
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::mpsc::channel(1);
    tokio::spawn(async move {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("设置 SIGTERM handler 失败");
        let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
            .expect("设置 SIGINT handler 失败");
        tokio::select! {
            _ = sigterm.recv() => {
                eprintln!("收到 SIGTERM，关闭...");
            }
            _ = sigint.recv() => {
                eprintln!("收到 SIGINT，关闭...");
            }
        }
        let _ = shutdown_tx.send(()).await;
    });

    eprintln!("backend 监听 http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    // with_connect_info：认证中间件靠对端地址做 loopback 豁免（本机 Node 引擎）。
    tokio::select! {
        result = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()) => result?,
        _ = shutdown_rx.recv() => {
            drop(_engine);
        }
    }
    Ok(())
}
