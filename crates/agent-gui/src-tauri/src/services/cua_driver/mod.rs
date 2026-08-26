//! `cua-driver` 的探测 / 安装 / 权限查询。
//!
//! 计算机操作能力本身**不经过这里**——`cua-driver mcp` 是一个标准的
//! stdio MCP server，由 `commands/integration/mcp.rs` 那套通用 MCP
//! client 驱动，工具由 `tools/list` 自动发现。这个模块只负责它前面那
//! 一小段引导：用户机器上有没有这个二进制、装在哪、要不要装、macOS
//! 的 TCC 授权给了没有。
//!
//! 设计原则是**把活都推给上游**。版本检查、下载、解压、更新、授权引导
//! 上游 CLI 全都有（`install.sh` / `update --apply` / `permissions
//! grant` / `doctor`），这里不重新实现，只做三件事：
//!
//! 1. 找到二进制（GUI 进程的 PATH 通常不含 `~/.local/bin`，必须补候选路径）；
//! 2. 问 `cua-driver manifest` 要 MCP 调用方式，而不是硬编码 `["mcp"]`；
//! 3. 需要安装时，转调官方安装脚本并把输出流式转发给前端。
//!
//! macOS 上刻意**不**使用 `mcp --direct`：那会让 MCP 进程沿用宿主
//! （LiveAgent.app）的 TCC 归属，等于要求 LiveAgent 自己去拿
//! Accessibility 与 Screen Recording 授权。默认模式经 CuaDriver.app
//! 的守护进程代理，授权归它，宿主不需要任何 TCC 权限。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// 单次外部命令的等待上限。`manifest` / `permissions status` 都在 1 秒
/// 内返回；留足余量给冷启动的守护进程握手。
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// 安装脚本的进度事件名。前端 `CuaDriverSetupCard` 监听它滚动日志。
pub const INSTALL_PROGRESS_EVENT: &str = "cua_driver_install_progress";

/// 官方安装脚本来源。展示给用户看的就是这个域名——必须与实际执行的
/// URL 一致，否则确认对话框就是在骗人。
const INSTALL_SCRIPT_URL_UNIX: &str = "https://cua.ai/driver/install.sh";
const INSTALL_SCRIPT_URL_WINDOWS: &str = "https://cua.ai/driver/install.ps1";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaDriverProbe {
    pub installed: bool,
    /// 二进制绝对路径。写进 MCP server 配置的就是它——不用裸名字，
    /// 因为 MCP 子进程继承的是 GUI 进程那份窄 PATH。
    pub path: Option<String>,
    pub version: Option<String>,
    /// `manifest.mcp_invocation` 给出的调用方式。上游若改了子命令，
    /// 这里跟着变，不需要我们发版。
    pub mcp_command: Option<String>,
    pub mcp_args: Vec<String>,
    /// 探测失败的原因（未安装是正常状态，不算错误，此时为 None）。
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaDriverPermissions {
    /// 只有 macOS 有 TCC 门槛；其他平台恒 false，前端据此隐藏整段。
    pub supported: bool,
    pub accessibility: bool,
    pub screen_recording: bool,
    /// 授权归属的 bundle id（正常是 `com.trycua.driver`）。守护进程没起
    /// 来时上游会报 unknown，此时两个布尔值不可信。
    pub attributed_to: Option<String>,
    pub daemon_running: bool,
    pub error: Option<String>,
}

/// 安装命令预览。**只描述，不执行**——UI 必须先把 `display` 原样展示
/// 给用户确认，才允许调 `install`。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCommandPreview {
    pub program: String,
    pub args: Vec<String>,
    /// 可直接粘进终端的完整命令。用户也可以选择自己去终端跑这一条。
    pub display: String,
    /// 脚本来源 URL，用于在确认文案里点明「这会从网络下载并执行脚本」。
    pub source_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    /// `stdout` | `stderr` | `done` | `failed`
    pub stream: String,
    pub line: String,
}

// ───────── 探测 ─────────

/// 在 PATH 与平台候选目录里找 `cua-driver`。
///
/// 必须自己 walk 而不是靠 `Command::new("cua-driver")`：macOS 上从
/// Finder / Dock 启动的 GUI 进程拿到的是 launchd 的默认 PATH，不含
/// `~/.local/bin`，而那正是官方安装脚本的默认落点。
fn find_binary() -> Option<PathBuf> {
    if let Some(found) = find_in_path("cua-driver") {
        return Some(found);
    }
    candidate_paths().into_iter().find(|p| p.is_file())
}

fn find_in_path(binary: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(target_os = "windows")]
        {
            let with_exe = dir.join(format!("{binary}.exe"));
            if with_exe.is_file() {
                return Some(with_exe);
            }
        }
    }
    None
}

fn candidate_paths() -> Vec<PathBuf> {
    let home = dirs::home_dir();
    let mut out: Vec<PathBuf> = Vec::new();

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = home.as_ref() {
            out.push(home.join(".local/bin/cua-driver"));
            out.push(home.join(".cua/bin/cua-driver"));
        }
        out.push(PathBuf::from("/usr/local/bin/cua-driver"));
        out.push(PathBuf::from("/opt/homebrew/bin/cua-driver"));
    }

    #[cfg(target_os = "macos")]
    {
        // 装了 CuaDriver.app 但没建 PATH 软链的情况。
        out.push(PathBuf::from(
            "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
        ));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(home) = home.as_ref() {
            out.push(home.join(".local\\bin\\cua-driver.exe"));
            out.push(home.join("AppData\\Local\\Programs\\cua-driver\\cua-driver.exe"));
        }
    }

    let _ = &home;
    out
}

fn run_capture(program: &Path, args: &[&str]) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to spawn {}: {error}", program.display()))?;

    let status = match child
        .wait_timeout(PROBE_TIMEOUT)
        .map_err(|error| format!("wait failed: {error}"))?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "{} {} timed out after {}s",
                program.display(),
                args.join(" "),
                PROBE_TIMEOUT.as_secs()
            ));
        }
    };

    let output = child
        .wait_with_output()
        .map_err(|error| format!("failed to collect output: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // 有些子命令（如 permissions status）业务失败也走非零退出但仍
        // 打了有效 JSON；把 stdout 一并带回去，让调用方决定怎么解析。
        return Err(format!(
            "exit {}: {}",
            status.code().unwrap_or(-1),
            if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                stderr.trim()
            }
        ));
    }
    Ok(stdout)
}

/// 探测安装状态。未安装不是错误——返回 `installed: false, error: None`。
pub fn probe() -> CuaDriverProbe {
    let Some(path) = find_binary() else {
        return CuaDriverProbe::default();
    };

    let mut probe = CuaDriverProbe {
        installed: true,
        path: Some(path.to_string_lossy().into_owned()),
        ..Default::default()
    };

    match run_capture(&path, &["manifest"]) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(manifest) => {
                probe.version = manifest
                    .get("binary_version")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let invocation = manifest.get("mcp_invocation");
                probe.mcp_command = invocation
                    .and_then(|v| v.get("command"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                probe.mcp_args = invocation
                    .and_then(|v| v.get("args"))
                    .and_then(Value::as_array)
                    .map(|args| {
                        args.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
            }
            Err(error) => probe.error = Some(format!("failed to parse manifest: {error}")),
        },
        Err(error) => probe.error = Some(error),
    }

    // manifest 没给出调用方式（老版本 / 解析失败）时回落到已知形态。
    // 刻意不加 `--direct`：见模块头注释。
    if probe.mcp_command.is_none() {
        probe.mcp_command = probe.path.clone();
        probe.mcp_args = vec!["mcp".to_string()];
    }

    probe
}

// ───────── 宿主自身身份 ─────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfIdentity {
    pub pid: u32,
    pub bundle_id: Option<String>,
}

/// LiveAgent 自己的进程身份，供前端把 cua-driver 的视野裁掉宿主窗口。
///
/// 让模型操作 LiveAgent 自己的界面是危险的自指：它能点掉自己的审批弹窗、
/// 改自己的权限策略、或者直接把自己关了。过滤在前端做（Rust 侧的
/// `mcp_call_tool` 是所有 MCP server 共用的通道，不该塞 cua 专属逻辑），
/// 这里只提供比对用的事实。
pub fn self_identity() -> SelfIdentity {
    SelfIdentity {
        pid: std::process::id(),
        bundle_id: option_env!("TAURI_BUNDLE_IDENTIFIER").map(str::to_owned),
    }
}

// ───────── 权限（macOS） ─────────

pub fn permissions_status() -> CuaDriverPermissions {
    if !cfg!(target_os = "macos") {
        return CuaDriverPermissions::default();
    }
    let Some(path) = find_binary() else {
        return CuaDriverPermissions {
            supported: true,
            error: Some("cua-driver not installed".into()),
            ..Default::default()
        };
    };

    // 守护进程状态单独问一次：`permissions status` 在守护进程没起来时
    // 只会报 unknown，不区分「没装」和「没跑」，对用户不可读。
    let daemon_running = run_capture(&path, &["status"])
        .map(|out| out.contains("is running"))
        .unwrap_or(false);

    match run_capture(&path, &["permissions", "status", "--json"]) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(payload) => CuaDriverPermissions {
                supported: true,
                accessibility: payload
                    .get("accessibility")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                screen_recording: payload
                    .get("screen_recording")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                attributed_to: payload
                    .get("source")
                    .and_then(|source| source.get("bundle_id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                daemon_running,
                error: None,
            },
            Err(error) => CuaDriverPermissions {
                supported: true,
                daemon_running,
                error: Some(format!("failed to parse permissions payload: {error}")),
                ..Default::default()
            },
        },
        Err(error) => CuaDriverPermissions {
            supported: true,
            daemon_running,
            error: Some(error),
            ..Default::default()
        },
    }
}

/// 触发上游的授权引导。会弹系统对话框并把 CuaDriver.app 拉起来，
/// 归属正确的 bundle identity——这是唯一正确的授权路径，只读的
/// `permissions status` 永远不会触发它。
pub fn permissions_grant() -> Result<CuaDriverPermissions, String> {
    if !cfg!(target_os = "macos") {
        return Ok(CuaDriverPermissions::default());
    }
    let path = find_binary().ok_or_else(|| "cua-driver not installed".to_string())?;
    run_capture(&path, &["permissions", "grant"])?;
    Ok(permissions_status())
}

// ───────── 安装 ─────────

/// 描述将要执行的安装命令。**不执行任何东西。**
///
/// 存在的理由就是让 UI 能在动手之前把命令原文摆到用户面前：这条命令
/// 会从网络拉一段 shell 脚本直接执行，用户有权在看到全文之后再决定。
pub fn install_command_preview() -> InstallCommandPreview {
    if cfg!(target_os = "windows") {
        let inner = format!("irm {INSTALL_SCRIPT_URL_WINDOWS} | iex");
        InstallCommandPreview {
            program: "powershell".into(),
            args: vec!["-NoProfile".into(), "-Command".into(), inner.clone()],
            display: format!("powershell -NoProfile -Command \"{inner}\""),
            source_url: INSTALL_SCRIPT_URL_WINDOWS.into(),
        }
    } else {
        let inner = format!("$(curl -fsSL {INSTALL_SCRIPT_URL_UNIX})");
        InstallCommandPreview {
            program: "/bin/bash".into(),
            args: vec!["-c".into(), inner.clone()],
            display: format!("/bin/bash -c \"{inner}\""),
            source_url: INSTALL_SCRIPT_URL_UNIX.into(),
        }
    }
}

/// 执行官方安装脚本，把 stdout / stderr 逐行 emit 给前端。
///
/// 调用方（Tauri command）必须确保用户已经在看到
/// `install_command_preview().display` 之后显式确认过。
pub fn install(app: &AppHandle) -> Result<CuaDriverProbe, String> {
    let preview = install_command_preview();
    let mut child = Command::new(&preview.program)
        .args(&preview.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to launch installer: {error}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pump = |handle: Option<Box<dyn std::io::Read + Send>>, stream: &'static str| {
        let app = app.clone();
        handle.map(|reader| {
            std::thread::spawn(move || {
                use std::io::BufRead;
                for line in std::io::BufReader::new(reader).lines().map_while(Result::ok) {
                    let _ = app.emit(
                        INSTALL_PROGRESS_EVENT,
                        InstallProgress {
                            stream: stream.to_string(),
                            line,
                        },
                    );
                }
            })
        })
    };
    let out_pump = pump(
        stdout.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        "stdout",
    );
    let err_pump = pump(
        stderr.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        "stderr",
    );

    let status = child
        .wait()
        .map_err(|error| format!("installer wait failed: {error}"))?;
    if let Some(handle) = out_pump {
        let _ = handle.join();
    }
    if let Some(handle) = err_pump {
        let _ = handle.join();
    }

    if !status.success() {
        let message = format!("installer exited with {}", status.code().unwrap_or(-1));
        let _ = app.emit(
            INSTALL_PROGRESS_EVENT,
            InstallProgress {
                stream: "failed".into(),
                line: message.clone(),
            },
        );
        return Err(message);
    }

    let probe = probe();
    let _ = app.emit(
        INSTALL_PROGRESS_EVENT,
        InstallProgress {
            stream: "done".into(),
            line: probe
                .version
                .clone()
                .map(|version| format!("cua-driver {version}"))
                .unwrap_or_else(|| "installed".into()),
        },
    );
    Ok(probe)
}

use wait_timeout::ChildExt;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_preview_never_executes_and_matches_its_source_url() {
        let preview = install_command_preview();
        // 展示给用户的命令必须真的包含那个 URL——确认对话框的全部意义
        // 就在于「看到的即将执行的」。
        assert!(preview.display.contains(&preview.source_url));
        assert!(preview.args.iter().any(|arg| arg.contains(&preview.source_url)));
    }

    #[test]
    fn probe_reports_not_installed_without_error() {
        // 未安装是正常状态，不该被前端当成故障红条渲染。
        let probe = CuaDriverProbe::default();
        assert!(!probe.installed);
        assert!(probe.error.is_none());
    }

    #[test]
    fn candidate_paths_cover_the_official_install_location() {
        let paths = candidate_paths();
        assert!(
            paths.iter().any(|p| p.to_string_lossy().contains(".local")),
            "官方安装脚本默认落在 ~/.local/bin，GUI 进程的 PATH 通常不含它"
        );
    }
}
