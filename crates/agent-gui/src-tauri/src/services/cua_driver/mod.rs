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
use wait_timeout::ChildExt;

/// 单次外部命令的等待上限。`manifest` / `permissions status` 都在 1 秒
/// 内返回；留足余量给冷启动的守护进程握手。
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// 安装脚本的等待上限。要下载解压，比探测慢得多，但也不该无限等——网络
/// 挂住时裸 `wait()` 会让 UI 的「安装中」永远停在那里，除了重启应用没有
/// 别的出路。
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

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
    /// 本平台是否存在需要用户处理的系统授权门槛。只有 macOS 有 TCC，
    /// Windows / Linux 恒 false —— 前端据此**立即**决定要不要渲染授权
    /// 那一节，不必等 `permissions_status` 那趟子进程回来。
    pub permissions_required: bool,
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

/// 本平台是否存在需要用户处理的系统授权门槛。只有 macOS 有 TCC。
///
/// 单独成函数而不是内联 `cfg!`，是为了让测试能在不 spawn 任何子进程的前提下
/// 断言这一位——`probe()` 会真的去跑 `cua-driver manifest`，让它进单测就等于
/// 让测试结果取决于跑测试那台机器装没装驱动。
const fn platform_requires_permissions() -> bool {
    cfg!(target_os = "macos")
}

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

/// 构造一个不会弹控制台窗口的子进程命令。
///
/// Windows 上从 GUI 进程 spawn 控制台程序会真的开一个黑框窗口——探测、
/// 权限查询、安装脚本全是后台行为，用户每进一次 CUA 设置页就被闪一下。
/// `CREATE_NO_WINDOW` 只影响是否分配控制台，stdout / stderr 仍照常通过
/// 管道拿到。非 Windows 平台没有这个概念，helper 退化成 `Command::new`。
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn run_capture(program: &Path, args: &[&str]) -> Result<String, String> {
    let mut child = hidden_command(program)
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
        return CuaDriverProbe {
            permissions_required: platform_requires_permissions(),
            ..Default::default()
        };
    };

    let mut probe = CuaDriverProbe {
        installed: true,
        path: Some(path.to_string_lossy().into_owned()),
        permissions_required: platform_requires_permissions(),
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
    }
}

/// 当前前台（持有键盘焦点的）应用的 pid。
///
/// 存在的理由：cua-driver 的 `press_key` / `hotkey` / `type_text` 在
/// desktop 作用域下不要求 pid / window_id / 坐标，输入投递给**前台应用**。
/// 这类调用按 pid 与按坐标的两道闸都管不到——只有知道前台是谁，才能判断
/// 这次按键会不会落在宿主自己身上（按掉审批弹窗、`cmd+q` 关掉应用）。
///
/// 取不到时返回 `Err`，前端按 **fail-closed** 处理（拒绝并让模型改用带
/// pid / window_id 的显式目标）。这里不能学窗口矩形那样「取不到就放行」：
/// 键盘输入不存在「误伤矩形下方真实目标」的二义性，而放行的代价是模型
/// 可以对宿主敲任意按键。
pub fn frontmost_pid() -> Result<u32, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;
        let workspace = NSWorkspace::sharedWorkspace();
        let front = workspace
            .frontmostApplication()
            .ok_or_else(|| "no frontmost application".to_string())?;
        let pid = front.processIdentifier();
        u32::try_from(pid).map_err(|_| format!("invalid frontmost pid: {pid}"))
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId,
        };
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return Err("no foreground window".to_string());
        }
        let mut pid: u32 = 0;
        let thread = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if thread == 0 || pid == 0 {
            return Err("failed to resolve foreground window process".to_string());
        }
        Ok(pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux 没有跨 X11 / Wayland 的统一前台查询。返回 Err 让前端
        // fail-closed：无明确目标的桌面键盘调用被拒，带 pid / window_id
        // 的显式目标不受影响，能力不算丢失。
        Err("frontmost application detection is not supported on this platform".to_string())
    }
}

/// 宿主自己某个窗口在屏幕坐标系里的矩形，单位是逻辑点（与 macOS 的
/// Accessibility / cua-driver 的桌面坐标同一套）。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfWindowRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// LiveAgent 自己所有可见窗口的屏幕矩形。
///
/// 用途只有一个：拦下**以桌面为目标、按屏幕坐标**下发的点击 / 拖拽 /
/// 按键。按 pid 或 window_id 寻址的调用由前端的自指闸门直接拒绝，但坐标
/// 无法反查归属——模型从整屏截图上量出宿主窗口里某个按钮的位置，再以
/// `{"target":{"kind":"desktop"},"x":…,"y":…}` 发出来，就绕开了那道闸。
/// 把矩形交给前端比对，落在里面的坐标一律拒绝。
///
/// 不可见 / 最小化的窗口不返回：它们接不到点击，列进来只会误伤那片区域
/// 下面真正的目标窗口。
pub fn self_window_rects(app: &AppHandle) -> Vec<SelfWindowRect> {
    use tauri::Manager;

    app.webview_windows()
        .values()
        .filter_map(|window| {
            if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
                return None;
            }
            let scale = window.scale_factor().unwrap_or(1.0);
            let position = window.outer_position().ok()?.to_logical::<f64>(scale);
            let size = window.outer_size().ok()?.to_logical::<f64>(scale);
            Some(SelfWindowRect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            })
        })
        .collect()
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

    // 只问 `permissions status`。曾经额外并行 spawn 一次 `cua-driver status`
    // 去判断守护进程有没有起来，但那个结果前端从头到尾没有用过，而代价是每次
    // 进设置页多一个子进程，且判定方式是拿英文散文做子串匹配（上游改一次措辞
    // 就静默失真）。要用的时候再加，并且要用结构化输出。
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
                error: None,
            },
            Err(error) => CuaDriverPermissions {
                supported: true,
                error: Some(format!("failed to parse permissions payload: {error}")),
                ..Default::default()
            },
        },
        Err(error) => CuaDriverPermissions {
            supported: true,
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

/// Unix 侧交给 `/bin/bash -c` 的安装脚本原文。
///
/// 必须是 `curl | bash` 的管道形式，**不能**写成 `$(curl …)`：终端里的
/// `bash -c "$(curl …)"` 之所以成立，是因为外层交互 shell 先做命令替换、
/// 脚本全文成为 `-c` 的参数。而从 Rust 直接 spawn 时没有外层 shell——
/// 字面量 `$(curl …)` 成了 bash 自己的脚本，bash 对**替换结果**只做分词、
/// 当一条简单命令执行，不会重新按脚本解析。于是下载内容的第一个词
/// `#!/bin/bash` 被当作命令名去找，报 `No such file or directory` 退出 127。
///
/// `pipefail` 同样不能省：没有它，curl 拉取失败时 bash 收到空输入会以 0
/// 退出，安装失败被静默当成成功。
fn unix_install_script(script_url: &str) -> String {
    format!("set -o pipefail; curl -fsSL {script_url} | /bin/bash")
}

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
        let inner = unix_install_script(INSTALL_SCRIPT_URL_UNIX);
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
    let mut child = hidden_command(&preview.program)
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

    let status = match child
        .wait_timeout(INSTALL_TIMEOUT)
        .map_err(|error| format!("installer wait failed: {error}"))?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let message = format!(
                "installer timed out after {} minutes",
                INSTALL_TIMEOUT.as_secs() / 60
            );
            let _ = app.emit(
                INSTALL_PROGRESS_EVENT,
                InstallProgress {
                    stream: "failed".into(),
                    line: message.clone(),
                },
            );
            return Err(message);
        }
    };
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

    /// 真跑一遍 bash（curl 支持 file://，不出网、不依赖装没装驱动），钉住
    /// 两个语义：脚本全文被**按脚本解析**执行，以及 curl 失败必须传出去。
    ///
    /// 曾经的写法是把 `$(curl …)` 字面量交给 `bash -c`——bash 对替换结果只
    /// 分词、当一条简单命令执行，脚本第一个词 `#!/bin/bash` 被当作命令名，
    /// 安装必然以 127 失败。这个测试对那个写法会当场红掉。
    #[cfg(unix)]
    #[test]
    fn unix_install_script_parses_the_payload_as_a_script_and_propagates_curl_failure() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("cua-install-wrapper-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let script = dir.join("install.sh");
        std::fs::File::create(&script)
            .and_then(|mut f| f.write_all(b"#!/bin/bash\nexit 42\n"))
            .expect("write fake installer");

        let run = |url: &str| {
            hidden_command("/bin/bash")
                .args(["-c", &unix_install_script(url)])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("spawn bash")
        };

        // 带 shebang 的脚本应被完整解析执行（shebang 行是注释），退出码是
        // 脚本自己的 42，而不是「找不到命令 #!/bin/bash」的 127。
        let ok = run(&format!("file://{}", script.display()));
        assert_eq!(ok.code(), Some(42), "脚本应按脚本解析执行，而不是被当作一条命令");

        // curl 拉不到时整条管道必须以非零退出——没有 pipefail 的话 bash 收到
        // 空输入会以 0 退出，安装失败被静默当成成功。
        let missing = run(&format!("file://{}", dir.join("missing.sh").display()));
        assert_ne!(missing.code(), Some(0), "curl 失败不能被静默当成安装成功");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn permissions_required_tracks_the_platform_tcc_gate() {
        // 前端靠这一位决定要不要渲染授权那一节；不能等 permissions_status
        // 那趟慢查询回来才知道平台，否则卡片会「先没有、后长出来」。
        assert_eq!(platform_requires_permissions(), cfg!(target_os = "macos"));
        assert_eq!(
            CuaDriverProbe::default().permissions_required,
            false,
            "Default 用于「探测彻底失败」的兜底，不该声称有授权门槛"
        );
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
