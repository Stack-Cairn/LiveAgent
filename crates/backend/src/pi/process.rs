//! `pi --mode rpc` 子进程管理。
//!
//! 一个 `PiProcess` = 一个 pi 进程 = 一个会话（pi 一进程只有一个活动会话）。
//! 三条泵各占一个 tokio 任务：stdin 写、stdout 读、stderr 转日志。
//!
//! stdout 上响应和事件混在一起，分流规则只有一条：
//! **有等待者的响应给等待者，其余一律进事件管道**。失败响应即使没人等也要
//! 转成 `CommandFailed` 事件——`prompt` 是发完不等的，preflight 失败
//! （没配 key、模型不存在）只在响应里出现一次，丢了前端就永远等不到终态。
//!
//! 决策 11 沿用：进程句柄 drop 时 kill child，不留孤儿。

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::protocol::{self, PiEvent, PiLine, PiResponse};

/// 启动一个 pi 会话进程所需的全部信息。
pub struct PiSpawnConfig {
    /// pi 可执行文件。默认走 PATH 上的 `pi`，`LIVEAGENT_PI_BIN` 可覆盖。
    pub bin: String,
    /// pi 的 `--session-id`。用 conversationId，会话文件因此可跨进程复用。
    pub session_id: String,
    /// pi 的 `--session-dir`。
    pub session_dir: PathBuf,
    /// 子进程工作目录。给 None 就继承后端进程的 cwd。
    pub workdir: Option<PathBuf>,
    /// 审批扩展的路径（`-e`）。没有它 pi 不会有任何工具审批。
    pub extension: Option<PathBuf>,
}

pub struct PiProcess {
    stdin_tx: mpsc::UnboundedSender<String>,
    /// 等待响应的命令：id → oneshot。超时的等待者由发起方自己摘掉。
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<PiResponse>>>>,
    child: Mutex<Child>,
    next_id: AtomicU64,
    tasks: Vec<JoinHandle<()>>,
}

impl PiProcess {
    /// 拉起进程并接好三条泵。返回事件管道的接收端，由调用方接进翻译层。
    ///
    /// 同步函数：`Command::spawn` 本身不 await，只要求在 tokio 运行时上下文里
    /// 调用。这让会话表的锁可以是普通 `std::sync::Mutex`——建会话的临界区
    /// 里没有 await 点，也就不需要异步锁。
    pub fn spawn(config: PiSpawnConfig) -> Result<(Self, mpsc::UnboundedReceiver<PiEvent>), String> {
        let mut command = Command::new(&config.bin);
        command
            .arg("--mode")
            .arg("rpc")
            .arg("--session-id")
            .arg(&config.session_id)
            .arg("--session-dir")
            .arg(&config.session_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(extension) = &config.extension {
            command.arg("--extension").arg(extension);
        }
        if let Some(workdir) = &config.workdir {
            command.current_dir(workdir);
        }

        let mut child = command.spawn().map_err(|e| {
            format!(
                "启动 pi 失败（{}）：{e}。设 LIVEAGENT_PI_BIN 指向 pi 可执行文件",
                config.bin
            )
        })?;

        let stdin = child.stdin.take().ok_or("拿不到 pi stdin")?;
        let stdout = child.stdout.take().ok_or("拿不到 pi stdout")?;
        let stderr = child.stderr.take().ok_or("拿不到 pi stderr")?;

        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<PiResponse>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<String>();
        let (event_tx, event_rx) = mpsc::unbounded_channel::<PiEvent>();

        let tasks = vec![
            tokio::spawn(pump_stdin(stdin, stdin_rx)),
            tokio::spawn(pump_stdout(stdout, Arc::clone(&pending), event_tx)),
            tokio::spawn(pump_stderr(stderr, config.session_id.clone())),
        ];

        Ok((
            Self {
                stdin_tx,
                pending,
                child: Mutex::new(child),
                next_id: AtomicU64::new(1),
                tasks,
            },
            event_rx,
        ))
    }

    /// 发一条命令，不等响应。失败响应会经事件管道回来。
    pub fn send(&self, command: Value) -> Result<(), String> {
        self.stdin_tx
            .send(command.to_string())
            .map_err(|_| "pi 进程已退出".to_string())
    }

    /// stdin 写入端的克隆。审批要在独立任务里应答（一次审批最长 3 分钟，
    /// 挂在事件泵上会把同会话的 token 增量一起堵死），那个任务只需要写的能力，
    /// 给它一个 sender 就不用把整个会话搬进去。
    pub fn stdin_sender(&self) -> mpsc::UnboundedSender<String> {
        self.stdin_tx.clone()
    }

    /// 发一条命令并等它的响应。超时按失败处理并摘掉等待者。
    pub async fn request(&self, mut command: Value, timeout: Duration) -> Result<PiResponse, String> {
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let Some(object) = command.as_object_mut() else {
            return Err("命令必须是 JSON 对象".to_string());
        };
        object.insert("id".to_string(), Value::String(id.clone()));

        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "pi 等待表锁中毒".to_string())?
            .insert(id.clone(), tx);

        if let Err(error) = self.send(command) {
            self.forget(&id);
            return Err(error);
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(response)) => Ok(response),
            // 通道断了 = stdout 泵没了 = 进程没了。
            Ok(Err(_)) => {
                self.forget(&id);
                Err("pi 进程已退出".to_string())
            }
            Err(_) => {
                self.forget(&id);
                Err("等待 pi 响应超时".to_string())
            }
        }
    }

    fn forget(&self, id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(id);
        }
    }

    /// 子进程是否已经退出。顺带收尸（`try_wait` 会 reap）。
    ///
    /// 会话表靠它判断手里的进程还能不能用：pi 崩了之后，下一次 chat_send
    /// 直接换一个新的，而不是把这个会话永久判死。锁拿不到就当活着——
    /// 误判活着最多下一条消息报错，误判死了会白杀一个正在跑的进程。
    pub fn has_exited(&self) -> bool {
        match self.child.lock() {
            Ok(mut child) => matches!(child.try_wait(), Ok(Some(_))),
            Err(_) => false,
        }
    }
}

impl Drop for PiProcess {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
        // `start_kill` 是同步的，正好能在 Drop 里用：发完信号就走，
        // 剩下的收尸交给 `kill_on_drop` 注册的运行时清理。
        if let Ok(mut child) = self.child.lock() {
            let _ = child.start_kill();
        }
    }
}

async fn pump_stdin(mut stdin: tokio::process::ChildStdin, mut rx: mpsc::UnboundedReceiver<String>) {
    while let Some(line) = rx.recv().await {
        if stdin.write_all(line.as_bytes()).await.is_err()
            || stdin.write_all(b"\n").await.is_err()
            || stdin.flush().await.is_err()
        {
            break;
        }
    }
}

async fn pump_stdout(
    stdout: tokio::process::ChildStdout,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<PiResponse>>>>,
    event_tx: mpsc::UnboundedSender<PiEvent>,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        match protocol::parse_line(&line) {
            Some(PiLine::Response(response)) => {
                let waiter = response
                    .id
                    .as_ref()
                    .and_then(|id| pending.lock().ok()?.remove(id));
                match waiter {
                    Some(tx) => {
                        let _ = tx.send(response);
                    }
                    // 没人等的失败响应：合成事件，否则这次失败无声无息。
                    None if !response.success => {
                        let event = PiEvent::CommandFailed {
                            command: response.command,
                            error: response.error.unwrap_or_else(|| "pi 未给出错误信息".to_string()),
                        };
                        if event_tx.send(event).is_err() {
                            return;
                        }
                    }
                    None => {}
                }
            }
            Some(PiLine::Event(event)) => {
                if event_tx.send(event).is_err() {
                    return;
                }
            }
            None => {}
        }
    }
    // stdout 关闭即进程结束。补一条，让还在等终态的会话收得到。
    let _ = event_tx.send(PiEvent::ProcessExited);
}

async fn pump_stderr(stderr: tokio::process::ChildStderr, session_id: String) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if !line.trim().is_empty() {
            eprintln!("[pi {session_id}] {line}");
        }
    }
}
