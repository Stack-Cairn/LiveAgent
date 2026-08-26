use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::runtime::process::{configure_child_process_group, kill_child_process_tree_best_effort};

/// 浏览器自动化专用 profile，与用户日常浏览器 profile 隔离（防登录态/凭据暴露）。
/// 见 docs/design/browser-automation.md。
pub(crate) fn automation_profile_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    Ok(home.join(".liveagent").join("browser-profile"))
}

/// 按平台探测已安装的 Chromium 系浏览器：Chrome → Edge → Chromium/Brave。
pub(crate) fn discover_browser_executable() -> Option<PathBuf> {
    browser_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
}

#[cfg(target_os = "macos")]
fn browser_candidates() -> Vec<PathBuf> {
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

#[cfg(target_os = "windows")]
fn browser_candidates() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Some(value) = std::env::var_os(var) {
            roots.push(PathBuf::from(value));
        }
    }
    let suffixes = [
        r"Google\Chrome\Application\chrome.exe",
        r"Microsoft\Edge\Application\msedge.exe",
        r"Chromium\Application\chrome.exe",
    ];
    let mut out = Vec::new();
    for suffix in suffixes {
        for root in &roots {
            out.push(root.join(suffix));
        }
    }
    out
}

#[cfg(all(unix, not(target_os = "macos")))]
fn browser_candidates() -> Vec<PathBuf> {
    let names = [
        "google-chrome",
        "google-chrome-stable",
        "microsoft-edge",
        "chromium",
        "chromium-browser",
        "brave-browser",
    ];
    let mut out = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for name in names {
                out.push(dir.join(name));
            }
        }
    }
    out
}

pub(crate) struct LaunchedBrowser {
    pub child: Child,
    pub executable: PathBuf,
    pub debug_port: u16,
}

impl LaunchedBrowser {
    /// 浏览器主进程 pid（供 BrowserManager 旁路记录，shutdown 兜底 kill 用）。
    pub(crate) fn child_pid(&self) -> u32 {
        self.child.id()
    }
}

impl Drop for LaunchedBrowser {
    fn drop(&mut self) {
        kill_child_process_tree_best_effort(&mut self.child);
    }
}

/// 以独立 profile + 随机调试端口启动浏览器，并从 profile 下的
/// `DevToolsActivePort` 文件解析实际端口（Chromium 启动成功后写出）。
pub(crate) fn launch_browser(executable: &PathBuf) -> Result<LaunchedBrowser, String> {
    let profile_dir = automation_profile_dir()?;
    fs::create_dir_all(&profile_dir).map_err(|e| format!("创建浏览器 profile 目录失败：{e}"))?;
    // 端口文件是上次会话的残留时会读到失效端口，启动前先清掉。
    let port_file = profile_dir.join("DevToolsActivePort");
    let _ = fs::remove_file(&port_file);

    let mut command = Command::new(executable);
    command
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-sync")
        .arg("--disable-features=TranslateUI")
        .arg("--new-window")
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_child_process_group(&mut command);

    let mut child = command
        .spawn()
        .map_err(|e| format!("启动浏览器失败（{}）：{e}", executable.display()))?;

    match wait_for_devtools_port(&port_file, &mut child, Duration::from_secs(15)) {
        Ok(debug_port) => Ok(LaunchedBrowser {
            child,
            executable: executable.clone(),
            debug_port,
        }),
        Err(error) => {
            kill_child_process_tree_best_effort(&mut child);
            Err(error)
        }
    }
}

fn wait_for_devtools_port(
    port_file: &PathBuf,
    child: &mut Child,
    timeout: Duration,
) -> Result<u16, String> {
    let started = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("探测浏览器进程状态失败：{e}"))?
        {
            return Err(format!(
                "浏览器进程提前退出（{status}）。若独立 profile 已被其他实例占用，请先关闭该实例。"
            ));
        }
        if let Ok(raw) = fs::read_to_string(port_file) {
            // 文件首行是端口，第二行是 browser target path。
            if let Some(first_line) = raw.lines().next() {
                if let Ok(port) = first_line.trim().parse::<u16>() {
                    if port > 0 {
                        return Ok(port);
                    }
                }
            }
        }
        if started.elapsed() >= timeout {
            return Err("等待浏览器 DevTools 端口超时（15s）".to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
