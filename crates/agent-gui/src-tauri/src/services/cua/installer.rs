//! CUA Driver 安装 / 检测 / 更新模块。
//!
//! 设计目标：把 CUA 官方 install 脚本（`https://cua.ai/driver/install.sh` /
//! `install.ps1`）当成「可信外部脚本」对待——只通过 `Command::new` 直起官方
//! 提供的安装器，把 stdout / stderr 实时经 Tauri `emit("cua_install_progress")`
//! 回给前端；不在 Rust 内部复刻安装逻辑，避免与官方版本漂移。
//!
//! 检测：按平台在 PATH / 平台特定目录查找 `cua-driver` / `CuaDriver.app`，
//! 调用 `cua-driver --version` 与 `cua-driver doctor` 探测健康度。
//!
//! 不在模块内做任何权限校验 / 启用开关——安装器面向「需要驱动但还没装」
//! 的场景；上层 `cua_driver_*` Command 才是策略边界。

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const INSTALL_PROGRESS_EVENT: &str = "cua_install_progress";
/// 安装脚本最大允许运行时长。官方 `install.sh` 含下载 + 解压 + 自启动
/// autostart，最坏情况约 3-5 分钟；30 分钟已留足余量。
const INSTALL_TIMEOUT_SECS: u64 = 30 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallerStage {
    /// 开始：分配任务、准备 spawn。
    Starting,
    /// 下载 install 脚本中。
    Downloading,
    /// 正在执行安装。
    Installing,
    /// 启动 daemon（仅 macOS / Windows）。
    StartingDaemon,
    /// 安装 + 启动成功。
    Completed,
    /// 失败；详见 error 字段。
    Failed,
    /// 用户 / 守护进程主动取消。
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallerProgressEvent {
    pub stage: InstallerStage,
    /// 人类可读进度信息（英文；UI 自行翻译）。
    pub message: String,
    /// 累积的日志（最近 200 行）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_tail: Option<String>,
    /// 0..=100 的进度百分比。`None` 表示未知。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u32>,
}

/// 检测结果。安装成功但 daemon 仍未起来时 `installed=true` /
/// `daemon_running=false`，UI 据此给出不同 CTA。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaDriverDetection {
    /// 能否在 PATH 或平台特定位置找到 `cua-driver` / `CuaDriver.app`。
    pub installed: bool,
    /// `cua-driver --version` 输出解析出的版本字符串。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 解析出的可执行文件绝对路径。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 平台标签（"macos" / "windows" / "linux"）。
    pub platform: &'static str,
    /// 是否找到 CuaDriver.app（macOS 专属）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_bundle_installed: Option<bool>,
    /// daemon 进程是否在运行（macOS 下用 `pgrep CuaDriver` 探测）。
    pub daemon_running: bool,
    /// `cua-driver doctor` 的完整输出（已截到 8 KB）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doctor_output: Option<String>,
    /// 检测过程中的错误（路径找不到 / --version 失败等），非致命。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 安装结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaInstallResult {
    pub success: bool,
    /// 完整日志（已截到 64 KB），即使失败也返回。
    pub log: String,
    /// 成功后探测到的 cua-driver 版本。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    /// 安装后是否自动启动了 daemon。
    pub daemon_started: bool,
    /// 失败时的错误描述。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 更新结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaUpdateResult {
    /// 是否检测到新版本。
    pub update_available: bool,
    /// 完整 check-update 输出。
    pub log: String,
    /// 实际执行 update --apply 后才填。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_version: Option<String>,
    /// 失败时的错误描述。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ───────── 平台特定路径探测 ─────────

fn platform_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn home_dir() -> Option<PathBuf> {
    // 跨平台 home：`HOME` (Unix) / `USERPROFILE` (Windows) / `HOME` 兜底。
    if let Some(p) = std::env::var_os("HOME").filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(p));
    }
    if let Some(p) = std::env::var_os("USERPROFILE").filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(p));
    }
    if let Some(p) = dirs::home_dir() {
        return Some(p);
    }
    None
}

fn candidate_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let home = home_dir();
    match platform_label() {
        "macos" => {
            out.push(PathBuf::from("/Applications/CuaDriver.app/Contents/MacOS/cua-driver"));
            out.push(PathBuf::from("/Applications/CuaDriver.app"));
            if let Some(h) = &home {
                out.push(h.join(".local/bin/cua-driver"));
            }
        }
        "windows" => {
            if let Some(local) = std::env::var_os("LOCALAPPDATA").filter(|s| !s.is_empty()) {
                let base = PathBuf::from(local);
                out.push(base.join("Programs/Cua/cua-driver/bin/cua-driver.exe"));
                out.push(base.join("Programs/Cua/cua-driver/bin"));
            }
        }
        _ => {
            // linux
            if let Some(h) = &home {
                out.push(h.join(".cua-driver/packages/releases/cua-driver"));
                out.push(h.join(".local/bin/cua-driver"));
            }
        }
    }
    out
}

fn find_cua_driver() -> Option<PathBuf> {
    // 1) PATH 中：手工 walk env::split_paths(PATH) 找 `cua-driver`。
    if let Some(p) = find_in_path("cua-driver") {
        return Some(p);
    }
    // 2) 平台特定候选路径。
    for candidate in candidate_paths() {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_in_path(binary: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
        // Windows 走 .exe 后缀。
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

// ───────── 版本 / doctor / daemon 探测 ─────────

fn parse_version(output: &str) -> Option<String> {
    // 兼容 "cua-driver 0.3.1" / "0.3.1" / "v0.3.1 (commit abc)"。
    for token in output.split_whitespace() {
        let stripped = token.trim_start_matches('v').trim_end_matches(',');
        if stripped.is_empty() {
            continue;
        }
        // 至少 vX.Y 形式。
        if stripped
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
            && stripped.contains('.')
        {
            return Some(stripped.to_string());
        }
    }
    None
}

fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<std::process::Output, String> {
    // 简单同步 + 上层 `tokio::task::spawn_blocking` 把 IO 移出主线程。
    // 进程级 timeout 用 `wait-timeout` crate（已有依赖）。
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn: {e}"))?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                if let Some(mut s) = child.stdout.take() {
                    let _ = std::io::Read::read_to_end(&mut s, &mut stdout);
                }
                if let Some(mut s) = child.stderr.take() {
                    let _ = std::io::Read::read_to_end(&mut s, &mut stderr);
                }
                return Ok(std::process::Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err(format!("timeout after {:?}", timeout));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("try_wait failed: {e}")),
        }
    }
}

fn truncate_log(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // 保留尾部，便于排错（最新输出更有用）。
    let start = s.len() - max;
    let mut idx = start;
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    format!("…(truncated {start} bytes)…\n{}", &s[idx..])
}

// ───────── 对外 API ─────────

/// 检测 cua-driver 是否已安装、版本、daemon 状态。
pub fn detect() -> CuaDriverDetection {
    let mut det = CuaDriverDetection {
        installed: false,
        version: None,
        path: None,
        platform: platform_label(),
        app_bundle_installed: None,
        daemon_running: false,
        doctor_output: None,
        error: None,
    };

    // macOS 专属：探测 .app bundle 是否已安装（与可执行文件分离的状态）。
    #[cfg(target_os = "macos")]
    {
        det.app_bundle_installed = Some(PathBuf::from("/Applications/CuaDriver.app").exists());
    }

    let Some(bin) = find_cua_driver() else {
        det.error = Some("cua-driver not found in PATH or platform-specific locations".into());
        return det;
    };
    det.installed = true;
    det.path = Some(bin.display().to_string());

    // --version
    let mut version_cmd = Command::new(&bin);
    version_cmd.arg("--version");
    match run_with_timeout(version_cmd, Duration::from_secs(5)) {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if let Some(v) = parse_version(&stdout) {
                det.version = Some(v);
            } else {
                det.error = Some(format!(
                    "could not parse version from: {}",
                    stdout.trim()
                ));
            }
        }
        Ok(out) => {
            det.error = Some(format!(
                "cua-driver --version exited with status {:?}: {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Err(e) => {
            det.error = Some(e);
        }
    }

    // doctor（best-effort；失败不影响 installed 判定）
    let mut doctor_cmd = Command::new(&bin);
    doctor_cmd.arg("doctor");
    if let Ok(out) = run_with_timeout(doctor_cmd, Duration::from_secs(8)) {
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        det.doctor_output = Some(truncate_log(&combined, 8 * 1024));
    }

    // daemon 探测
    det.daemon_running = is_daemon_running();

    det
}

pub fn is_daemon_running() -> bool {
    // macOS / Linux：尝试 `pgrep -f CuaDriver`。Windows：tasklist。
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if let Ok(out) = Command::new("pgrep")
            .args(["-f", "CuaDriver"])
            .output()
        {
            if out.status.success() && !out.stdout.is_empty() {
                return true;
            }
        }
        // 兜底：cua-driver serve 进程。
        if let Ok(out) = Command::new("pgrep")
            .args(["-f", "cua-driver serve"])
            .output()
        {
            if out.status.success() && !out.stdout.is_empty() {
                return true;
            }
        }
        false
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq CuaDriver.exe", "/NH"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&out.stdout);
            return stdout.contains("CuaDriver.exe");
        }
        false
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

/// 按平台构建安装命令。返回 (program, args, description)——program 是
/// 实际要 spawn 的二进制（`bash` / `powershell`），args 是参数。
pub fn build_install_command() -> Result<InstallCommand, String> {
    let script_url = "https://cua.ai/driver/install.sh";
    let ps_url = "https://cua.ai/driver/install.ps1";
    match platform_label() {
        "macos" | "linux" => Ok(InstallCommand {
            program: "/bin/bash".to_string(),
            args: vec![
                "-c".to_string(),
                format!(
                    "set -e; curl -fsSL {script_url} | bash -s --; rc=$?; echo \"[install.sh exit code: $rc]\"; exit $rc"
                ),
            ],
            description: "macOS / Linux installer".to_string(),
            needs_sudo: false,
        }),
        "windows" => Ok(InstallCommand {
            program: "powershell.exe".to_string(),
            // PowerShell: `irm <url> | iex` 把脚本下载到内存并立即执行；
            // 末尾 `cua-driver autostart kick` 是官方安装器要求的最后一步。
            args: vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-Command".to_string(),
                format!("irm {ps_url} | iex; cua-driver autostart kick"),
            ],
            description: "Windows installer".to_string(),
            needs_sudo: false,
        }),
        other => Err(format!("unsupported platform for CUA driver install: {other}")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCommand {
    pub program: String,
    pub args: Vec<String>,
    pub description: String,
    /// Linux 上需要 sudo（apt 装依赖）；macOS / Windows 上不需要。
    pub needs_sudo: bool,
}

/// Linux 专属：检测并提示/安装 X11 / AT-SPI 依赖。当前只探测，不自动 sudo。
/// 返回 (apt_available: bool, missing: Vec<&'static str>)。
pub fn linux_check_apt_deps() -> (bool, Vec<&'static str>) {
    if !cfg!(target_os = "linux") {
        return (false, Vec::new());
    }
    // 简单探测 dpkg 是否可用。
    let has_dpkg = Command::new("dpkg-query")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if has_dpkg {
        let mut missing = Vec::new();
        for pkg in &["libxi6", "at-spi2-core"] {
            let ok = Command::new("dpkg-query")
                .args(["-W", "-f=${Status}", pkg])
                .output()
                .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("install ok"))
                .unwrap_or(false);
            if !ok {
                missing.push(*pkg);
            }
        }
        (true, missing)
    } else {
        (false, Vec::new())
    }
}

/// 给前端展示用：把即将执行的 install 命令 + Linux 依赖状态一起打包。
/// 前端可以把它显示在「即将运行的命令」卡片里，给用户最终确认。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPreview {
    pub platform: &'static str,
    pub command: InstallCommand,
    /// Linux 专属：`true` 表示系统使用 apt，UI 给出「需先装 libxi6 / at-spi2-core」提示。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linux_apt_available: Option<bool>,
    /// Linux 专属：缺失的包。空 = 已就绪。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linux_missing_packages: Option<Vec<String>>,
}

pub fn build_install_preview() -> Result<InstallPreview, String> {
    let command = build_install_command()?;
    let mut preview = InstallPreview {
        platform: platform_label(),
        command,
        linux_apt_available: None,
        linux_missing_packages: None,
    };
    if platform_label() == "linux" {
        let (apt, missing) = linux_check_apt_deps();
        preview.linux_apt_available = Some(apt);
        preview.linux_missing_packages = Some(missing.into_iter().map(String::from).collect());
    }
    Ok(preview)
}

/// 执行安装。`app` 用于发 progress 事件；返回 `CuaInstallResult`。
/// 设计：单线程同步阻塞命令跑在调用方（由 `tauri::async_runtime::spawn_blocking`
/// 调度），stdout / stderr 实时 line-by-line 推送 + 累积到 `log`。
pub fn install(app: &AppHandle) -> CuaInstallResult {
    // 起始事件
    let _ = app.emit(
        INSTALL_PROGRESS_EVENT,
        InstallerProgressEvent {
            stage: InstallerStage::Starting,
            message: "Preparing CUA driver installer…".to_string(),
            log_tail: None,
            percent: Some(0),
        },
    );

    let cmd = match build_install_command() {
        Ok(c) => c,
        Err(e) => {
            return finalize_failure(
                app,
                "Failed to build installer command",
                &e,
                String::new(),
            );
        }
    };

    let _ = app.emit(
        INSTALL_PROGRESS_EVENT,
        InstallerProgressEvent {
            stage: InstallerStage::Downloading,
            message: format!("Downloading installer from cua.ai ({})", cmd.description),
            log_tail: None,
            percent: Some(5),
        },
    );

    let mut command = Command::new(&cmd.program);
    command
        .args(&cmd.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    // 同步阻塞，由 caller 包在 spawn_blocking 里。
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            return finalize_failure(
                app,
                "Failed to spawn installer",
                &e.to_string(),
                String::new(),
            );
        }
    };

    let mut log = String::new();
    let mut stage_emitted_installing = false;
    let last_emit = std::time::Instant::now();
    let start = std::time::Instant::now();

    // 同时读 stdout + stderr：用 thread 拼 stdout，sterr 走主循环。
    // MVP：line-alternating，跨流顺序由 OS 决定；用户能跟进度即可。
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_for_thread = app.clone();
    let log_arc = Arc::new(std::sync::Mutex::new(String::new()));
    let log_for_thread = Arc::clone(&log_arc);

    if let Some(stdout) = stdout {
        let app_t = app_for_thread.clone();
        let log_t = Arc::clone(&log_for_thread);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut s) = log_t.lock() {
                    push_line(&mut s, &line);
                }
                let _ = app_t.emit(
                    INSTALL_PROGRESS_EVENT,
                    InstallerProgressEvent {
                        stage: InstallerStage::Installing,
                        message: line.clone(),
                        log_tail: Some(line),
                        percent: Some(percent_for(start.elapsed())),
                    },
                );
            }
        });
    }

    if let Some(stderr) = stderr {
        let app_t = app_for_thread.clone();
        let log_t = Arc::clone(&log_for_thread);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut s) = log_t.lock() {
                    push_line(&mut s, &format!("[stderr] {line}"));
                }
                let _ = app_t.emit(
                    INSTALL_PROGRESS_EVENT,
                    InstallerProgressEvent {
                        stage: InstallerStage::Installing,
                        message: format!("(stderr) {line}"),
                        log_tail: Some(format!("[stderr] {line}")),
                        percent: Some(percent_for(start.elapsed())),
                    },
                );
            }
        });
    }

    // 等待子进程 + 整体 timeout。
    let timeout = Duration::from_secs(INSTALL_TIMEOUT_SECS);
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    break Err(format!(
                        "install timeout after {} minutes",
                        INSTALL_TIMEOUT_SECS / 60
                    ));
                }
                if !stage_emitted_installing && last_emit.elapsed() > Duration::from_secs(1) {
                    let _ = app.emit(
                        INSTALL_PROGRESS_EVENT,
                        InstallerProgressEvent {
                            stage: InstallerStage::Installing,
                            message: "Installer is running…".to_string(),
                            log_tail: None,
                            percent: Some(20),
                        },
                    );
                    stage_emitted_installing = true;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => break Err(format!("try_wait failed: {e}")),
        }
    };

    // 等流读完（最好再多给 500 ms 让 reader 线程退出）。
    std::thread::sleep(Duration::from_millis(500));
    if let Ok(s) = log_arc.lock() {
        log = s.clone();
    }

    let exit_status = match exit_status {
        Ok(s) => s,
        Err(e) => return finalize_failure(app, "Installer did not finish", &e, log),
    };

    if !exit_status.success() {
        return finalize_failure(
            app,
            "Installer exited with non-zero status",
            &format!("exit code: {:?}", exit_status.code()),
            log,
        );
    }

    // 安装成功 → 重新探测版本。
    let _ = app.emit(
        INSTALL_PROGRESS_EVENT,
        InstallerProgressEvent {
            stage: InstallerStage::StartingDaemon,
            message: "Installer finished. Detecting installed driver…".to_string(),
            log_tail: None,
            percent: Some(85),
        },
    );

    let detection = detect();
    let installed_version = detection.version.clone();

    let daemon_started = start_daemon(app).is_ok();

    let _ = app.emit(
        INSTALL_PROGRESS_EVENT,
        InstallerProgressEvent {
            stage: InstallerStage::Completed,
            message: if daemon_started {
                "CUA driver installed and daemon started.".to_string()
            } else {
                "CUA driver installed. Daemon will be started on first use.".to_string()
            },
            log_tail: Some(truncate_log(&log, 4 * 1024)),
            percent: Some(100),
        },
    );

    CuaInstallResult {
        success: true,
        log: truncate_log(&log, 64 * 1024),
        installed_version,
        daemon_started,
        error: None,
    }
}

fn percent_for(elapsed: std::time::Duration) -> u32 {
    // 简单线性插值 0..90%（剩下 10% 给 daemon start）。30 分钟硬上限，
    // 但大部分安装 < 1 分钟；这里给前 5 分钟跑到 90% 足够。
    let secs = elapsed.as_secs();
    if secs < 5 {
        5 + (secs as u32 * 3) // 5..20%
    } else if secs < 30 {
        20 + ((secs - 5) as u32) // 20..45%
    } else if secs < 90 {
        45 + ((secs - 30) as u32 / 2) // 45..75%
    } else {
        75 + ((secs - 90).min(900) as u32 / 30).min(15) // 75..90%
    }
}

fn push_line(buf: &mut String, line: &str) {
    if buf.len() + line.len() + 1 > 64 * 1024 {
        // 环形裁剪：丢前一半，避免无限增长。
        let drop = buf.len() / 2;
        if let Some(idx) = buf[drop..].find('\n') {
            buf.drain(..drop + idx + 1);
        } else {
            buf.clear();
        }
    }
    buf.push_str(line);
    buf.push('\n');
}

fn finalize_failure(
    app: &AppHandle,
    title: &str,
    detail: &str,
    log: String,
) -> CuaInstallResult {
    let error = format!("{title}: {detail}");
    let _ = app.emit(
        INSTALL_PROGRESS_EVENT,
        InstallerProgressEvent {
            stage: InstallerStage::Failed,
            message: error.clone(),
            log_tail: Some(truncate_log(&log, 4 * 1024)),
            percent: Some(0),
        },
    );
    CuaInstallResult {
        success: false,
        log: truncate_log(&log, 64 * 1024),
        installed_version: None,
        daemon_started: false,
        error: Some(error),
    }
}

/// 启动 daemon。macOS: `open -n -g -a CuaDriver --args serve`；
/// Linux: `cua-driver serve &`（一次性 spawn）。Windows: 暂 no-op（依赖
/// 安装器的 `autostart kick`）。
pub fn start_daemon(app: &AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("/usr/bin/open")
            .args(["-n", "-g", "-a", "CuaDriver", "--args", "serve"])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .map_err(|e| format!("open failed: {e}"))?;
        if !status.success() {
            return Err(format!(
                "open exited with status {:?}; is CuaDriver.app installed at /Applications?",
                status.code()
            ));
        }
        let _ = app.emit(
            INSTALL_PROGRESS_EVENT,
            InstallerProgressEvent {
                stage: InstallerStage::StartingDaemon,
                message: "Started CuaDriver.app (background).".to_string(),
                log_tail: None,
                percent: Some(95),
            },
        );
        return Ok(true);
    }
    #[cfg(target_os = "linux")]
    {
        let Some(bin) = find_cua_driver() else {
            return Err("cua-driver not found in PATH".to_string());
        };
        // 一次性 spawn detach。
        let _ = Command::new(&bin)
            .arg("serve")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| format!("cua-driver serve spawn failed: {e}"))?;
        return Ok(true);
    }
    #[cfg(target_os = "windows")]
    {
        // Windows 安装器最后一步 `cua-driver autostart kick` 会把 daemon
        // 注册为开机自启；这里仅探测是否已在运行，不主动启动服务。
        let running = is_daemon_running();
        if !running {
            return Err(
                "Windows: daemon is managed by 'cua-driver autostart kick'. \
                 Run it manually if the driver is not running."
                    .to_string(),
            );
        }
        return Ok(running);
    }
    #[allow(unreachable_code)]
    {
        Err("daemon start not implemented for this platform".to_string())
    }
}

/// 调用 `cua-driver check-update` 与（可选）`cua-driver update --apply`。
/// `apply` 为 false 时只检查不更新。
pub fn update(apply: bool) -> CuaUpdateResult {
    let Some(bin) = find_cua_driver() else {
        return CuaUpdateResult {
            update_available: false,
            log: String::new(),
            new_version: None,
            error: Some("cua-driver not installed".to_string()),
        };
    };

    // Step 1: check-update
    let check_out = run_with_timeout(
        {
            let mut c = Command::new(&bin);
            c.arg("check-update");
            c
        },
        Duration::from_secs(15),
    );
    let check_output = match &check_out {
        Ok(o) => format!(
            "$ cua-driver check-update\n{}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        ),
        Err(e) => format!("$ cua-driver check-update\n<failed: {e}>"),
    };
    let update_available = match &check_out {
        Ok(o) => o.status.success() && parse_update_available(&o.stdout),
        Err(_) => false,
    };

    if !apply || !update_available {
        return CuaUpdateResult {
            update_available,
            log: check_output,
            new_version: None,
            error: None,
        };
    }

    // Step 2: update --apply
    let apply_out = run_with_timeout(
        {
            let mut c = Command::new(&bin);
            c.args(["update", "--apply"]);
            c
        },
        Duration::from_secs(INSTALL_TIMEOUT_SECS),
    );
    let apply_output = match &apply_out {
        Ok(o) => format!(
            "\n$ cua-driver update --apply\n{}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        ),
        Err(e) => format!("\n$ cua-driver update --apply\n<failed: {e}>"),
    };
    let combined = format!("{check_output}{apply_output}");
    let new_version = if apply_out
        .as_ref()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        detect().version
    } else {
        None
    };
    let error = match &apply_out {
        Err(e) => Some(e.clone()),
        Ok(o) if !o.status.success() => Some(format!("exit code: {:?}", o.status.code())),
        _ => None,
    };
    CuaUpdateResult {
        update_available,
        log: combined,
        new_version,
        error,
    }
}

fn parse_update_available(stdout: &[u8]) -> bool {
    let s = String::from_utf8_lossy(stdout).to_lowercase();
    // 官方脚本常用 "update available" / "new version" 字符串。
    s.contains("update available")
        || s.contains("new version")
        || s.contains("a new version is available")
        || s.contains("outdated")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_handles_common_formats() {
        assert_eq!(parse_version("cua-driver 0.3.1"), Some("0.3.1".into()));
        assert_eq!(parse_version("v0.3.1 (commit abc)"), Some("0.3.1".into()));
        assert_eq!(parse_version("0.10.2"), Some("0.10.2".into()));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("nothing here"), None);
    }

    #[test]
    fn platform_label_matches_target() {
        let label = platform_label();
        if cfg!(target_os = "macos") {
            assert_eq!(label, "macos");
        } else if cfg!(target_os = "windows") {
            assert_eq!(label, "windows");
        } else {
            assert_eq!(label, "linux");
        }
    }

    #[test]
    fn build_install_command_always_succeeds_on_supported_platform() {
        let cmd = build_install_command();
        if cfg!(any(target_os = "macos", target_os = "linux", target_os = "windows")) {
            let cmd = cmd.expect("supported platform");
            assert!(!cmd.program.is_empty());
            assert!(!cmd.args.is_empty());
        } else {
            assert!(cmd.is_err());
        }
    }

    #[test]
    fn truncate_log_keeps_tail() {
        let s = "a".repeat(2000);
        let t = truncate_log(&s, 100);
        assert!(t.len() <= 200);
        assert!(t.contains("a"));
    }

    #[test]
    fn parse_update_available_keywords() {
        assert!(parse_update_available(b"update available: 0.4.0"));
        assert!(parse_update_available(b"new version: 0.4.0"));
        assert!(parse_update_available(b"a new version is available"));
        assert!(parse_update_available(b"outdated"));
        assert!(!parse_update_available(b"you are up to date"));
    }

    #[test]
    fn push_line_keeps_recent_lines() {
        let mut buf = String::new();
        for i in 0..5000 {
            push_line(&mut buf, &format!("line {i} with some content"));
        }
        // 容量上限 64KB；远小于 5000 * 30 = 150KB。buf 内部已环形裁剪。
        assert!(buf.len() <= 64 * 1024 + 100, "buf {} > 64KB", buf.len());
        assert!(buf.contains("line 4999"));
    }
}
