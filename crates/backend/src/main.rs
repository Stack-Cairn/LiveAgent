//! 后端进程入口。
//!
//! 用法：
//! ```text
//! backend --port 8443 [--password <pw>] [--tls-cert a.pem --tls-key b.pem] \
//!     [--data-dir <dir>]
//! ```
//!
//! 每个参数都有对应的环境变量兜底（argv 优先）：`PORT`、
//! `LIVEAGENT_BACKEND_PASSWORD`、`LIVEAGENT_TLS_CERT`/`LIVEAGENT_TLS_KEY`、
//! `LIVEAGENT_DATA_DIR`。容器平台（Railway 等）
//! 只会给环境变量，以前靠一层 entrypoint 脚本翻译，现在后端直接认。
//!
//! 不给密码就动态生成一个并打印到 stderr（决策 8：本地密码初始化
//! 动态生成、可改）。打到 stderr 而不是 stdout，是为了让 stdout 能被管道消费。
//!
//! chat 引擎是按会话拉起的 `pi --mode rpc` 子进程，默认取 PATH 上的 `pi`，
//! 用 `LIVEAGENT_PI_BIN` 覆盖。它没有对应的 argv 参数——引擎位置是部署事实，
//! 不是每次启动要调的旋钮。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use backend::server::{auth, tls};
use backend::{build_router, build_state};

struct Args {
    port: u16,
    password: Option<String>,
    tls_cert: Option<PathBuf>,
    tls_key: Option<PathBuf>,
}

/// 非空环境变量，空串按未设置处理（`FOO=` 是平台 UI 里清空后留下的残渣）。
fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// 手写参数解析而不是引 clap：六个参数，clap 会带进来一整棵依赖树。
/// argv 没给的项从环境变量补齐，之后不再有第二条配置路径。
fn parse_args() -> Result<Args, String> {
    let mut port: Option<u16> = None;
    let mut args = Args {
        port: 0,
        password: None,
        tls_cert: None,
        tls_key: None,
    };
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
            "--tls-cert" => args.tls_cert = Some(PathBuf::from(take("--tls-cert")?)),
            "--tls-key" => args.tls_key = Some(PathBuf::from(take("--tls-key")?)),
            "--data-dir" => data_dir = Some(PathBuf::from(take("--data-dir")?)),
            "--help" | "-h" => {
                println!(
                    "backend [--port <PORT>] [--password <PW>] [--tls-cert <PEM> --tls-key <PEM>] [--data-dir <DIR>]\n\
                     环境变量兜底：PORT、LIVEAGENT_BACKEND_PASSWORD、LIVEAGENT_TLS_CERT/LIVEAGENT_TLS_KEY、LIVEAGENT_DATA_DIR\n\
                     chat 引擎：默认调 PATH 上的 pi，LIVEAGENT_PI_BIN 可覆盖"
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
    args.tls_cert = args.tls_cert.or_else(|| env_var("LIVEAGENT_TLS_CERT").map(PathBuf::from));
    args.tls_key = args.tls_key.or_else(|| env_var("LIVEAGENT_TLS_KEY").map(PathBuf::from));

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
            let generated = auth::generate_password();
            eprintln!("未提供 --password，本次启动的密码是：{generated}");
            generated
        }
    };

    // 生成内部 token（内部调用方走 Bearer 认证用）。
    let internal_token = auth::generate_password();

    let state = build_state(Arc::new(auth::AuthConfig::new(password, internal_token.clone())), internal_token, args.port)?;
    // 恢复上次留下的隧道：读库、给存活的重新起监听。端口和 token 是本次进程
    // 新分配的，所以链接会变——这是有意的（见 services/tunnel/store.rs 文档）。
    // 失败只记日志不中止：隧道起不来不该让整个后端服务不起来。
    if let Err(error) = state.tunnels.initialize().await {
        eprintln!("恢复隧道失败：{error}");
    }
    // 周期清扫过期隧道：TTL 的强制执行就在这里，不起它 TTL 只是显示值。
    state.tunnels.spawn_sweeper();

    // chat 引擎不在这里启动：pi 进程由 PiSessionManager 在首次 chat_send
    // 时按会话惰性拉起。退出时统一收掉（决策 11：不留孤儿子进程）。
    let pi_sessions = std::sync::Arc::clone(&state.pi_sessions);

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

    let server_future = match tls::from_args(args.tls_cert, args.tls_key)? {
        Some(paths) => {
            let config = tls::load(&paths).await?;
            eprintln!("backend 监听 https://{addr}");
            tokio::select! {
                result = axum_server::bind_rustls(addr, config)
                    .serve(app.into_make_service()) => {
                    result?
                },
                _ = shutdown_rx.recv() => {
                    pi_sessions.shutdown_all();
                    return Ok(());
                }
            };
            Ok(())
        }
        None => {
            eprintln!("backend 监听 http://{addr}（无 TLS）");
            let listener = tokio::net::TcpListener::bind(addr).await?;
            tokio::select! {
                result = axum::serve(listener, app) => {
                    result?
                },
                _ = shutdown_rx.recv() => {
                    pi_sessions.shutdown_all();
                    return Ok(());
                }
            };
            Ok(())
        }
    };
    server_future
}
