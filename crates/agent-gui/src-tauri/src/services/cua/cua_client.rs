//! cua-driver MCP client。
//!
//! 历史：之前的 `driver.rs` 是 osascript + screencapture 自研实现，仅
//! macOS / 单线程 / 抢光标 / 看不到 Chromium 等非 AX 表面；reviewer 要求
//! 改用上游 `cua-driver`（[trycua/cua](https://github.com/trycua/cua)，MIT），
//! 它跨 macOS / Windows / Linux、AX + 像素双路径、按窗口寻址、不抢光标。
//!
//! 协议：`cua-driver mcp --direct` 起一个 stdio JSON-RPC server（每条消息
//! 一行 newline-delimited JSON，符合 MCP 2025-06-18）。我们用
//! `Arc<Mutex<Inner>>` 持单一长连子进程，调用方拿锁后写入
//! `{jsonrpc,id,method,params}` → 从 stdout 读直到匹配 id。30 秒
//! 同步超时，子进程死了下一次调用重新 spawn。
//!
//! 设计边界：
//! - **不做沙箱 / 白名单 / audit**：那是 `CuaStore::enforce` 的活；
//!   这里只负责把 MCP 调用落地。
//! - **不缓冲任何状态**：除 `next_id` 之外的会话字段（session / cursor
//!   theme 之类）由调用方在 args 里按需指定；持久化的 MCP session 留给
//!   上层 policy 决定。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::error::CuaError;

/// 单次调用的同步超时。cua-driver 大多数 op（点击 / 截图 / 找 pid）
/// 都在 1-5 秒内完成；留给 `start_session` / `bring_to_front` 等
/// 复合路径 30 秒缓冲。超出即报 `io("timeout after 30s")` 让上层
/// 把它转成结构化 `CuaError::io`。
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// 轮询读 stdout 的间隔。read_line 是阻塞的，每次最多等这么久就回
/// 一次 deadline 检查 + child 状态探测。
const READ_SLICE: Duration = Duration::from_millis(250);

/// `health_report` 的 bundle_identity 缓存有效期。短到能在「用户重新授权 /
/// 重启 CuaDriver.app」后尽快恢复有效，长到不至于每次截屏都重发一次
/// health_report（每次 ~200ms；同帧多次调用浪费）。
const BUNDLE_ATTRIBUTION_CACHE: Duration = Duration::from_secs(60);

/// cua-driver 可执行文件名（与 `installer::find_cua_driver` 同源；
/// 这里直接 `Command::new` 让 OS 走 PATH，不再做二次候选目录 walk，
/// 启动期由 installer 把 PATH 准备好）。
const CUA_DRIVER_BIN: &str = "cua-driver";

/// 共享给 Tauri Command 的薄包装。`spawn` 懒：第一个调用方拿锁时
/// 才起子进程；后续命中复用句柄。
#[derive(Clone)]
pub struct CuaClient {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    /// 懒启动的子进程句柄。第一次 `call` 时若为 None 就 spawn。
    child: Option<RunningProcess>,
    /// MCP 请求 id 自增；初始化握手与后续 tools/call 共享同一计数器。
    next_id: AtomicU64,
    /// `health_report.bundle_identity` 缓存 + 取样时间。`None` 表示
    /// 还没取过；超时或子进程重启后会重新拉一次（CUA-051）。
    bundle_attribution: Mutex<Option<(bool, Instant)>>,
}

/// 拆出 stdio 句柄后剩下的子进程字段。
struct RunningProcess {
    child: Child,
    stdout: BufReader<ChildStdout>,
    stdin: ChildStdin,
    /// stderr 我们不消费，但保留 handle 防止子进程写阻塞；drop 时
    /// 自动 close。调用方不直接读。
    _stderr: Option<ChildStderr>,
}

impl CuaClient {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                child: None,
                next_id: AtomicU64::new(1),
                bundle_attribution: Mutex::new(None),
            })),
        }
    }

    /// 调用一次 MCP 工具，返回 `result` 字段（结构化 JSON）。
    /// 错误一律翻译成 `CuaError`（i18n key + 英文 message），由
    /// Command 层直接透传给前端。
    pub fn call_tool(&self, tool: &str, arguments: Value) -> Result<Value, CuaError> {
        let (proc, id) = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|e| CuaError::io(&format!("cua client lock poisoned: {e}")))?;
            // 子进程死了 / 没起 → 重启一次。重启失败直接报错，不无限重试。
            let needs_respawn = match &mut guard.child {
                None => true,
                Some(p) => child_exited(&mut p.child),
            };
            if needs_respawn {
                guard.child = None;
                let spawned = spawn_cua_driver()?;
                guard.child = Some(spawned);
            }
            let id = guard.next_id.fetch_add(1, Ordering::SeqCst);
            let proc = guard
                .child
                .as_mut()
                .expect("just spawned")
                as *mut RunningProcess;
            // SAFETY: 整段 call_tool 全程持锁 `guard`，proc 不会被独占
            // 借用之外的其它路径触碰。把 `&mut guard.child.as_mut()`
            // 重借用转成裸指针，再在锁里重新借回来。
            (unsafe { &mut *proc }, id)
        };

        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {
                "name": tool,
                "arguments": arguments,
            }
        });
        let mut line = serde_json::to_string(&request)
            .map_err(|e| CuaError::io(&format!("serialize mcp request: {e}")))?;
        line.push('\n');

        proc.stdin
            .write_all(line.as_bytes())
            .map_err(|e| CuaError::io(&format!("write mcp request: {e}")))?;
        proc.stdin
            .flush()
            .map_err(|e| CuaError::io(&format!("flush mcp request: {e}")))?;

        // 阻塞读直到拿到匹配 id 的响应。带 30 秒总超时。
        let deadline = Instant::now() + CALL_TIMEOUT;
        loop {
            if Instant::now() >= deadline {
                return Err(CuaError::io(&format!(
                    "cua-driver mcp call '{tool}' timed out after {}s",
                    CALL_TIMEOUT.as_secs()
                )));
            }
            let slice_deadline = Instant::now() + READ_SLICE;
            let mut buf = String::new();
            loop {
                if Instant::now() >= slice_deadline {
                    break;
                }
                if child_exited(&mut proc.child) {
                    self.shutdown();
                    return Err(CuaError::io("cua-driver exited mid-call"));
                }
                let mut temp = String::new();
                match proc.stdout.read_line(&mut temp) {
                    Ok(0) => {
                        // EOF：子进程关了 stdout。
                        self.shutdown();
                        return Err(CuaError::io(
                            "cua-driver stdout closed unexpectedly",
                        ));
                    }
                    Ok(_) => {
                        buf.push_str(&temp);
                        if buf.ends_with('\n') {
                            break;
                        }
                    }
                    Err(e) => {
                        return Err(CuaError::io(&format!("read mcp response: {e}")));
                    }
                }
            }
            if buf.is_empty() {
                // 本轮 slice 没读到完整行 → 检查总 deadline 后再继续。
                continue;
            }
            // 解析 JSON-RPC 响应。
            let parsed: Value = match serde_json::from_str(buf.trim()) {
                Ok(v) => v,
                Err(_) => {
                    // 可能收到 cua-driver 的 stderr 噪音（启动 banner 等）
                    // 混入 stdout；遇到非 JSON 行就跳过等下一行。
                    continue;
                }
            };
            // 匹配 id；服务端可能并发推送 notifications/... 等无 id 帧，
            // 那些在 MCP 2025-06-18 之前是 server→client；这里跳过。
            let resp_id = parsed.get("id").and_then(Value::as_u64);
            if resp_id != Some(id) {
                continue;
            }
            // 错误响应：把 MCP error 转成 CuaError。
            if let Some(err) = parsed.get("error") {
                let code = err.get("code").and_then(Value::as_i64).unwrap_or(-1);
                let msg = err
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                return Err(map_mcp_error(code, &msg));
            }
            return Ok(parsed.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// 关掉子进程。下次调用会重新 spawn。
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(mut proc) = guard.child.take() {
                let _ = proc.child.kill();
                let _ = proc.child.wait();
            }
        }
    }

    /// CUA-051：检测 cua-driver 是否带 CFBundleIdentifier 启动。
    /// `true` 表示 health_report 中 `bundle_identity` 为 pass，可以
    /// 信任 `get_desktop_state` 返回真实屏幕像素；`false` 表示该路径
    /// 会返回全黑帧（TCC Screen Recording attribution 失效），调用方
    /// 应该改走 `zoom`（按窗口寻址，attribution 不依赖 bundle）或直接
    /// 报 `screen_capture_unavailable`。
    ///
    /// 结果缓存 `BUNDLE_ATTRIBUTION_CACHE`（60s），避免每次截屏都发
    /// health_report 浪费时间。子进程重启 / `shutdown()` 后下次调用
    /// 会重发——`bundle_attribution` 是与 child 同寿命的字段。
    pub fn check_bundle_attribution(&self) -> bool {
        // fast path：缓存有效就直接返回。
        if let Ok(guard) = self.inner.lock() {
            if let Ok(attr) = guard.bundle_attribution.lock() {
                if let Some((ok, at)) = *attr {
                    if at.elapsed() < BUNDLE_ATTRIBUTION_CACHE {
                        return ok;
                    }
                }
            }
        }
        // slow path：调 health_report 拿 bundle_identity。失败 / 超时
        // 一律按 fail 处理（保守；宁可错杀不要返回全黑帧）。
        let parsed = self
            .call_tool("health_report", json!({}))
            .ok()
            .and_then(|v| v.get("checks").and_then(Value::as_array).cloned())
            .and_then(|checks| {
                checks
                    .into_iter()
                    .find(|c| c.get("name").and_then(Value::as_str) == Some("bundle_identity"))
            });
        let ok = parsed
            .as_ref()
            .and_then(|c| c.get("status").and_then(Value::as_str))
            .map(|s| s == "pass")
            .unwrap_or(false);
        if let Ok(guard) = self.inner.lock() {
            if let Ok(mut attr) = guard.bundle_attribution.lock() {
                *attr = Some((ok, Instant::now()));
            }
        }
        ok
    }
}

impl Default for CuaClient {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CuaClient {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn child_exited(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(Some(_)))
}

/// 起一个 `cua-driver mcp --direct` 子进程。stdout / stdin 都 pipe。
/// `--host-bundle-id` 给一个非空占位（cua-driver 关心 TCC attribution，
/// LiveAgent 主程序 bundle id 即可，不强求精确）。
fn spawn_cua_driver() -> Result<RunningProcess, CuaError> {
    let mut cmd = Command::new(CUA_DRIVER_BIN);
    cmd.arg("mcp")
        .arg("--direct")
        .arg("--host-bundle-id")
        .arg("com.liveagent.desktop");
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| CuaError::io(&format!("failed to spawn cua-driver mcp: {e}")))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| CuaError::io("cua-driver stdin missing"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CuaError::io("cua-driver stdout missing"))?;
    let stderr = child.stderr.take();
    Ok(RunningProcess {
        child,
        stdout: BufReader::new(stdout),
        stdin,
        _stderr: stderr,
    })
}

/// 把 MCP `error.code` + message 翻成稳定的 `CuaError`。
/// cua-driver 用 `code` 表示语义（permission / unsupported / io），
/// 我们把已知 code 映射到 i18n kind，其余走 io 兜底。
fn map_mcp_error(code: i64, message: &str) -> CuaError {
    match code {
        // MCP 标准错误码：-32001 ~ -32099 是服务端自定义。
        -32001 => CuaError::permission_required("accessibility", "Accessibility"),
        -32002 => CuaError::permission_required("screen-recording", "Screen Recording"),
        // -32601 method not found：MCP 协议层错误，可能是工具名拼错。
        -32601 => CuaError::not_executed(&format!(
            "cua-driver does not know this tool: {message}"
        )),
        _ => CuaError::io(&format!("cua-driver mcp error {code}: {message}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_error_maps_permission_codes() {
        let e = map_mcp_error(-32001, "AX denied");
        assert_eq!(e.kind, "cua.errors.permissionRequired");
        assert_eq!(
            e.params.get("permissionKey").and_then(Value::as_str),
            Some("accessibility")
        );
    }

    #[test]
    fn mcp_error_maps_unknown_code_to_io() {
        let e = map_mcp_error(-99999, "wat");
        assert_eq!(e.kind, "cua.errors.io");
        assert!(e.message.contains("cua-driver"));
    }

    #[test]
    fn map_mcp_error_method_not_found_is_not_executed() {
        let e = map_mcp_error(-32601, "unknown tool");
        assert_eq!(e.kind, "cua.errors.notExecuted");
    }

    #[test]
    fn client_can_be_cloned() {
        let c = CuaClient::new();
        let _c2 = c.clone();
        assert!(Arc::strong_count(&c.inner) >= 2);
    }
}