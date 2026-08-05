//! 后端进程入口。
//!
//! 用法：
//! ```text
//! agent-backend --port 8443 [--password <pw>] [--tls-cert a.pem --tls-key b.pem]
//! ```
//!
//! 不给 `--password` 就动态生成一个并打印到 stderr（决策 8：本地密码初始化
//! 动态生成、可改）。打到 stderr 而不是 stdout，是为了让 stdout 能被管道消费。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use agent_backend::{auth, build_router, build_state, tls};

struct Args {
    port: u16,
    password: Option<String>,
    tls_cert: Option<PathBuf>,
    tls_key: Option<PathBuf>,
}

/// 手写参数解析而不是引 clap：四个参数，clap 会带进来一整棵依赖树。
fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        port: 8443,
        password: None,
        tls_cert: None,
        tls_key: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut take = |name: &str| it.next().ok_or_else(|| format!("{name} 需要一个值"));
        match flag.as_str() {
            "--port" => {
                args.port = take("--port")?
                    .parse()
                    .map_err(|_| "--port 必须是 1-65535 的整数".to_string())?;
            }
            "--password" => args.password = Some(take("--password")?),
            "--tls-cert" => args.tls_cert = Some(PathBuf::from(take("--tls-cert")?)),
            "--tls-key" => args.tls_key = Some(PathBuf::from(take("--tls-key")?)),
            "--help" | "-h" => {
                println!(
                    "agent-backend --port <PORT> [--password <PW>] [--tls-cert <PEM> --tls-key <PEM>]"
                );
                std::process::exit(0);
            }
            other => return Err(format!("未知参数：{other}")),
        }
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

    // 生成内部 token（Rust⇄Node 通信）。
    let internal_token = auth::generate_password();
    eprintln!("内部 token（供 Node 引擎使用）：{internal_token}");

    let state = build_state(Arc::new(auth::AuthConfig::new(password, internal_token.clone())), internal_token)?;
    // 恢复上次留下的隧道：读库、给存活的重新起监听。端口和 token 是本次进程
    // 新分配的，所以链接会变——这是有意的（见 services/tunnel/store.rs 文档）。
    // 失败只记日志不中止：隧道起不来不该让整个后端服务不起来。
    if let Err(error) = state.tunnels.initialize().await {
        eprintln!("恢复隧道失败：{error}");
    }
    // 周期清扫过期隧道：TTL 的强制执行就在这里，不起它 TTL 只是显示值。
    state.tunnels.spawn_sweeper();
    let app = build_router(state);
    let addr = SocketAddr::from(([0, 0, 0, 0], args.port));

    match tls::from_args(args.tls_cert, args.tls_key)? {
        Some(paths) => {
            let config = tls::load(&paths).await?;
            eprintln!("agent-backend 监听 https://{addr}");
            axum_server::bind_rustls(addr, config)
                .serve(app.into_make_service())
                .await?;
        }
        None => {
            eprintln!("agent-backend 监听 http://{addr}（无 TLS）");
            let listener = tokio::net::TcpListener::bind(addr).await?;
            axum::serve(listener, app).await?;
        }
    }
    Ok(())
}
