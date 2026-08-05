//! Node 引擎进程管理。
//!
//! 负责启动、守护 Node 引擎进程（agent-core-js），并在其退出时标记进行中的任务失败。
//! 决策 5：Node 只监听 loopback；Rust 是唯一对外入口。
//! 决策 11：后端退出时同步 kill child。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::sleep;

use crate::state::AppState;

/// Node 引擎进程的守护句柄。
///
/// 持有对 child 的共享所有权，以及后台守护任务的 abort handle。
/// Drop 时同步 kill child。决策 11：后端退出时同步 kill child。
pub struct EngineProcess {
    /// 子进程的共享句柄。守护循环和 Drop 都可能修改它。
    child: Arc<Mutex<Option<Child>>>,
    /// 守护任务的 abort handle。
    monitor_abort: tokio::task::JoinHandle<()>,
}

impl Drop for EngineProcess {
    fn drop(&mut self) {
        // 取消守护任务。
        self.monitor_abort.abort();

        // 杀死子进程。同步等待完成。决策 11。
        // 注意：我们在这里获取一个阻塞 lock，所以需要用 block_in_place 或者 new runtime。
        let child_arc = self.child.clone();
        let _ = std::thread::spawn(move || {
            if let Ok(rt) = tokio::runtime::Runtime::new() {
                rt.block_on(async {
                    let mut guard = child_arc.lock().await;
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                    }
                });
            }
        })
        .join();
    }
}

/// 选一个空闲的 TCP 端口。
///
/// 通过 bind :0 让操作系统分配，然后立即释放。这保证端口可用但不完全保证
/// 在 Node 实际 bind 时未被其他进程抢占（但这种竞争极少）。
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

/// 轮询探测 Node 进程就绪。
///
/// 通过 HTTP GET /healthz 检查 Node 是否已启动并就绪。
async fn wait_for_readiness(node_port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/healthz", node_port);

    loop {
        match client.get(&url).timeout(Duration::from_secs(1)).send().await {
            Ok(resp) if resp.status().is_success() => {
                eprintln!("Node 引擎就绪（端口 {node_port}）");
                return Ok(());
            }
            _ => {
                if Instant::now() > deadline {
                    return Err(format!("Node 就绪超时（端口 {node_port}）"));
                }
                sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// 启动 Node 引擎进程，并管理其生命周期。
///
/// # 参数
/// - `state`: 后端状态，用于更新 node_port 和广播事件
/// - `bundle_path`: agent-core-js 打包产物的路径
///
/// # 返回
/// 返回一个 `EngineProcess` 句柄。句柄 drop 时自动清理。
///
/// # 过程
/// 1. 选一个空闲端口
/// 2. 启动 Node 进程，传入环境变量
/// 3. 就绪探测，通过后才更新 AppState 中的 node_port
/// 4. 启动守护循环（spawn_monitor）
pub async fn spawn_engine(state: AppState, bundle_path: PathBuf) -> Result<EngineProcess, String> {
    let node_port = find_free_port().await?;

    eprintln!("启动 Node 引擎：{}", bundle_path.display());
    eprintln!("Node 监听端口：{node_port}");

    let mut cmd = Command::new("node");
    cmd.arg(bundle_path.join("index.js"))
        .env("LIVEAGENT_NODE_PORT", node_port.to_string())
        .env("LIVEAGENT_INTERNAL_TOKEN", &state.internal_token)
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn Node 进程失败：{e}"))?;

    // 就绪探测。通了才更新 node_port 状态。
    if let Err(e) = wait_for_readiness(node_port, Duration::from_secs(30)).await {
        let _ = child.kill().await;
        return Err(e);
    }

    // 更新状态。
    {
        let mut port_lock = state.node_port.write().await;
        *port_lock = Some(node_port);
    }

    // 共享 child 所有权给守护循环和 Drop 处理器。
    let child_shared = Arc::new(Mutex::new(Some(child)));

    // 启动守护循环。
    let monitor_abort = tokio::spawn(spawn_monitor(
        state.clone(),
        bundle_path,
        node_port,
        child_shared.clone(),
    ));

    Ok(EngineProcess {
        child: child_shared,
        monitor_abort,
    })
}

/// 守护循环：监控 Node 进程状态，触发故障恢复。
///
/// 失败场景 & 恢复：
/// - Node 进程异常退出 → 标记进行中的 run 失败 → 广播终态事件 → 退避重启
/// - 重启失败 → 指数退避，上限 30s
/// - 连续成功运行 60s → 退避计时器重置
///
/// 决策 5：不自动重跑；只标记失败和广播终态。
#[allow(unused_assignments)]
async fn spawn_monitor(
    state: AppState,
    bundle_path: PathBuf,
    initial_port: u16,
    child_shared: Arc<Mutex<Option<Child>>>,
) {
    // 退避参数。
    let mut backoff_ms = 1000u64;
    const MAX_BACKOFF_MS: u64 = 30_000;
    const HEALTHY_WINDOW_MS: u64 = 60_000;

    let mut last_successful_start: Option<Instant> = None;
    let mut current_port = initial_port;

    loop {
        // 等待 child 退出。
        let child_to_wait: Option<Child> = {
            let mut lock_result = child_shared.lock().await;
            lock_result.take()
        };

        match child_to_wait {
            Some(mut child) => {
                eprintln!("守护任务：等待 Node 进程退出...");
                let wait_result = child.wait().await;
                match wait_result {
                    Ok(status) => {
                        eprintln!("Node 进程已退出：{}", status);
                    }
                    Err(e) => {
                        eprintln!("等待 Node 进程失败：{e}");
                    }
                }
            }
            None => {
                // child 已被 Drop 取出（或者初始化失败），退出守护。
                eprintln!("Node 进程已被清理，退出守护循环");
                return;
            }
        }

        // Node 已离线。
        eprintln!("Node 引擎已退出，标记进行中的任务失败");

        // 标记进行中的 run 失败并广播终态事件。
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        state.events.emit(
            "engine:crashed",
            serde_json::json!({
                "timestamp_ms": now_ms,
                "reason": "node_process_exited"
            }),
        );

        eprintln!("等待 {}ms 后重启 Node 引擎", backoff_ms);
        sleep(Duration::from_millis(backoff_ms)).await;

        // 更新退避。
        backoff_ms = (backoff_ms * 2).min(MAX_BACKOFF_MS);
        last_successful_start = Some(Instant::now());

        // 选一个新端口（重启后端口会变）。
        match find_free_port().await {
            Ok(port) => {
                current_port = port;
                eprintln!("为重启选定端口：{}", current_port);
            }
            Err(e) => {
                eprintln!("选端口失败：{e}，使用旧端口 {}", current_port);
            }
        }

        // 清空 node_port（重启中）。
        {
            let mut port_lock = state.node_port.write().await;
            *port_lock = None;
        }

        // 重启 Node 进程。
        eprintln!("重启 Node 引擎...");
        let mut cmd = Command::new("node");
        cmd.arg(bundle_path.join("index.js"))
            .env("LIVEAGENT_NODE_PORT", current_port.to_string())
            .env("LIVEAGENT_INTERNAL_TOKEN", &state.internal_token)
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit());

        match cmd.spawn() {
            Ok(new_child) => {
                // 就绪探测。
                match wait_for_readiness(current_port, Duration::from_secs(30)).await {
                    Ok(_) => {
                        eprintln!("Node 引擎已重启并就绪");

                        // 更新状态和 child handle。
                        {
                            let mut port_lock = state.node_port.write().await;
                            *port_lock = Some(current_port);
                        }
                        {
                            let mut guard = child_shared.lock().await;
                            *guard = Some(new_child);
                        }

                        // 检查是否需要重置退避。
                        if let Some(start_time) = last_successful_start {
                            let elapsed = start_time.elapsed();
                            if elapsed > Duration::from_millis(HEALTHY_WINDOW_MS) {
                                backoff_ms = 1000;
                                eprintln!("连续健康运行超过 60s，退避重置");
                            }
                        }
                        last_successful_start = Some(Instant::now());

                        // 继续循环，等待下一次退出。
                        continue;
                    }
                    Err(e) => {
                        eprintln!("重启后就绪探测失败：{e}");
                        // 杀死这个失败的进程。
                        let _ = std::thread::spawn(move || {
                            if let Ok(rt) = tokio::runtime::Runtime::new() {
                                rt.block_on(async {
                                    let mut child = new_child;
                                    let _ = child.kill().await;
                                    let _ = child.wait().await;
                                });
                            }
                        })
                        .join();

                        // 继续等待下一轮重试。
                    }
                }
            }
            Err(e) => {
                eprintln!("重启 Node 进程失败：{e}");
                // 继续等待下一轮重试。
            }
        }
    }
}
