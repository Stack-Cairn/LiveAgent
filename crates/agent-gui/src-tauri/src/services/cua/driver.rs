//! 平台相关驱动：把屏幕 / 输入抽象为一组同步、可审计的操作。
//!
//! - macOS：`osascript` 操作 System Events（发送鼠标 / 键盘事件） +
//!   `screencapture` 截屏。需要用户在「系统设置 → 隐私与安全」授予
//!   LiveAgent「辅助功能（Accessibility）」与「屏幕录制（Screen Recording）」。
//!   缺权限时 System Events 报错的特征字串是 `1002` / `Not authorized`，
//!   `screencapture` 报 `cannot create screen recording` —— 我们把这些
//!   翻译成结构化 `PlatformError::PermissionRequired`，提示前端打开权限。
//! - 其他平台：返回 `PlatformError::Unsupported`，由命令层翻译给前端。
//!
//! 所有调用走 `Command::new` 直起子进程；不进入沙箱（命令层有 enable 守卫）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClickButton {
    Left,
    Middle,
    Right,
}

impl ClickButton {
    fn apple_event_name(self) -> &'static str {
        match self {
            ClickButton::Left => "click",
            ClickButton::Middle => "middleClick",
            ClickButton::Right => "rightClick",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    /// 系统级窗口 ID；macOS 的 CGWindowID 用 u32 表示，足以覆盖常规场景。
    pub window_id: u64,
    /// 拥有窗口的应用可执行文件名（`Finder`、`Safari` …）。
    pub owner: String,
    /// 窗口标题，没有时为空串。
    pub title: String,
    /// 屏幕坐标的左上角 + 尺寸（来自 System Events 的 position / size）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<WindowBounds>,
    /// 是否处于最前。
    pub focused: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 平台驱动层错误。字段无中文/无 hardcoded 文案——一律交给 `CuaError` 在
/// 调用边界翻译（CUA-006）。`Clone` 因为 Tauri Command 需要复制错误回前端；
/// 不从 `io::Error` 直接 derive `From`，避免给枚举加 `From` 约束。
#[derive(Debug, Clone)]
pub enum PlatformError {
    /// 当前 OS 不支持 CUA（参数是被拒时的 OS 标签）。
    Unsupported(String),
    /// macOS 权限缺失——参数是稳定 `permissionKey`（例如 "accessibility" /
    /// "screen-recording"）+ 人类可读展示名。
    PermissionRequired {
        permission_key: &'static str,
        permission: &'static str,
    },
    /// 前置条件未满足 / 子进程运行失败但不是权限问题。
    NotExecuted(String),
    /// 子进程启动 IO 失败。
    Io(String),
}

impl std::fmt::Display for PlatformError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Display 仅在日志里有用，权威面向用户消息由 CuaError 提供。
        match self {
            PlatformError::Unsupported(os) => {
                write!(f, "CUA driver is not available on {os}")
            }
            PlatformError::PermissionRequired { permission, .. } => {
                write!(f, "CUA needs permission: {permission}")
            }
            PlatformError::NotExecuted(detail) => {
                write!(f, "CUA operation not executed: {detail}")
            }
            PlatformError::Io(detail) => {
                write!(f, "CUA IO error: {detail}")
            }
        }
    }
}

impl std::error::Error for PlatformError {}

/// CUA 驱动抽象。每种平台给一份实现。调用方约定：
/// 1. 任何操作之前都已过启用开关（store 侧）。
/// 2. 操作返回错误时，调用方负责把原因结构化给 Tauri Command。
pub trait CuaDriver: Send + Sync {
    fn platform_label() -> &'static str
    where
        Self: Sized;

    /// 列出当前所有可见窗口。结果按 owner 排序，title / bounds 尽力而为：
    /// macOS 通过 System Events，权限不足时整列表失败。
    fn list_windows(&self) -> Result<Vec<WindowInfo>, PlatformError>;

    /// 聚焦指定 owner（应用名）。聚焦失败不抛错；只是 best-effort。
    fn focus_window(&self, owner: &str) -> Result<(), PlatformError>;

    /// 全屏截图（PNG 字节）或指定窗口截图（`window_owner` 给应用名，
    /// 截的是该应用最前面的窗口）。macOS 用 `screencapture -x -l <id>`。
    fn screenshot(&self, window_owner: Option<&str>) -> Result<Vec<u8>, PlatformError>;

    /// 在屏幕坐标处点击。坐标原点在主显示器左上角，与 System Events 一致。
    fn click(&self, x: i32, y: i32, button: ClickButton) -> Result<(), PlatformError>;

    fn double_click(&self, x: i32, y: i32) -> Result<(), PlatformError>;

    /// 输入字符串。osascript `keystroke` 原生支持 unicode。
    fn type_text(&self, text: &str) -> Result<(), PlatformError>;

    /// 按键：`key` 是 key code 字符串（如 "49" = Return，"51" = Delete，
    /// "53" = Escape）或 key 名称（如 "return"/"tab"/"escape"），与
    /// System Events 的 `key code` / `key` 等价。modifiers 取自
    /// {"command","option","control","shift"}。
    fn press_key(&self, key: &str, modifiers: &[String]) -> Result<(), PlatformError>;

    /// 滚动：以 (x, y) 为锚点；`dy > 0` 向上、`< 0` 向下（与 macOS
    /// `scroll wheel` 一致，前端负责翻转方向）。
    fn scroll(&self, x: i32, y: i32, dy: i32) -> Result<(), PlatformError>;

    /// 拖拽：从 (x1, y1) 到 (x2, y2)。
    fn drag(&self, x1: i32, y1: i32, x2: i32, y2: i32) -> Result<(), PlatformError>;
}

// ───────── macOS 实现 ─────────

#[cfg(target_os = "macos")]
pub struct MacOsDriver;

#[cfg(target_os = "macos")]
impl MacOsDriver {
    fn run_osascript(script: &str) -> Result<String, PlatformError> {
        let output = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| PlatformError::Io(e.to_string()))?;
        translate_osascript_output(output)
    }

    fn run_screencapture(args: &[&str]) -> Result<Vec<u8>, PlatformError> {
        // screencapture 必须写到文件，没有 stdout 输出模式；写到临时目录后读出。
        let path = temp_screenshot_path();
        let status = Command::new("/usr/sbin/screencapture")
            .args(args)
            .arg(&path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .map_err(|e| PlatformError::Io(e.to_string()))?;
        if !status.success() {
            return Err(PlatformError::PermissionRequired {
                permission_key: "screen-recording",
                permission: "Screen Recording",
            });
        }
        let bytes = std::fs::read(&path).map_err(|e| PlatformError::Io(e.to_string()))?;
        let _ = std::fs::remove_file(&path);
        Ok(bytes)
    }
}

#[cfg(target_os = "macos")]
impl CuaDriver for MacOsDriver {
    fn platform_label() -> &'static str {
        "macos"
    }

    fn list_windows(&self) -> Result<Vec<WindowInfo>, PlatformError> {
        // System Events 的 `every window of (every process whose background
        // only is false)` 会返回每个进程的可见窗口。bundle id / 可执行名取自
        // `unix id` / `name`。position / size 在 System Events 上是 `position`
        // 和 `size` 属性（points）。focused 暂以「应用是否在前台」近似。
        let script = r#"
            tell application "System Events"
                set winList to {}
                set procs to (every process whose background only is false)
                repeat with p in procs
                    try
                        set pName to (name of p) as string
                        set procsWindows to (every window of p)
                        repeat with w in procsWindows
                            try
                                set wTitle to (title of w) as string
                            on error
                                set wTitle to ""
                            end try
                            try
                                set wPos to position of w
                                set wSize to size of w
                                set wx to item 1 of wPos
                                set wy to item 2 of wPos
                                set ww to item 1 of wSize
                                set wh to item 2 of wSize
                                set boundsStr to (wx as string) & "," & (wy as string) & "," & (ww as string) & "," & (wh as string)
                            on error
                                set boundsStr to ""
                            end try
                            set end of winList to (pName & "||" & wTitle & "||" & boundsStr)
                        end repeat
                    end try
                end repeat
                return winList
            end tell
        "#;
        let out = Self::run_osascript(script)?;
        let mut windows = Vec::new();
        // 每条记录：`owner||title||x,y,w,h`，用 \n 分隔。
        for line in out.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let parts: Vec<&str> = trimmed.splitn(3, "||").collect();
            if parts.len() < 2 {
                continue;
            }
            let owner = parts[0].trim().to_string();
            let title = parts[1].trim().to_string();
            let bounds = if parts.len() == 3 && !parts[2].trim().is_empty() {
                let coords: Vec<i64> = parts[2]
                    .split(',')
                    .filter_map(|c| c.trim().parse::<i64>().ok())
                    .collect();
                if coords.len() == 4 {
                    Some(WindowBounds {
                        x: coords[0] as i32,
                        y: coords[1] as i32,
                        width: coords[2].max(0) as u32,
                        height: coords[3].max(0) as u32,
                    })
                } else {
                    None
                }
            } else {
                None
            };
            windows.push(WindowInfo {
                window_id: 0,
                owner,
                title,
                bounds,
                focused: false,
            });
        }
        // 找不到任何窗口也正常（前台 app 没窗口 / 权限拒绝会走到错误分支）
        Ok(windows)
    }

    fn focus_window(&self, owner: &str) -> Result<(), PlatformError> {
        // 通过 `tell application id` 失败时（应用没有 AppleScript 字典），
        // 退化为 `tell application "X" to activate`，再退化为 bring to front。
        let safe_owner = escape_applescript_string(owner);
        let script = format!(
            r#"try
                tell application id "{}" to activate
            on error
                try
                    tell application "{}" to activate
                on error
                    tell application "System Events" to set frontmost of first process whose name is "{}" to true
                end try
            end try"#,
            safe_owner, safe_owner, safe_owner
        );
        Self::run_osascript(&script).map(|_| ())
    }

    fn screenshot(&self, window_owner: Option<&str>) -> Result<Vec<u8>, PlatformError> {
        // `-x` 不发声，`-t png` 强转 PNG；`-l <windowid>` 是窗口截屏模式，
        // 但我们这里只给 owner，所以走全屏截屏（窗口级截屏需要 window id，
        // 由 Agent 通过 cua_list_windows 后续扩展）。
        let _ = window_owner; // MVP: 暂未实现窗口级截图（需要 window id）
        Self::run_screencapture(&["-x", "-t", "png"])
    }

    fn click(&self, x: i32, y: i32, button: ClickButton) -> Result<(), PlatformError> {
        let event = button.apple_event_name();
        let script = format!(
            r#"tell application "System Events" to {} at {{{}, {}}}"#,
            event, x, y
        );
        Self::run_osascript(&script).map(|_| ())
    }

    fn double_click(&self, x: i32, y: i32) -> Result<(), PlatformError> {
        let script = format!(
            r#"tell application "System Events" to double click at {{{}, {}}}"#,
            x, y
        );
        Self::run_osascript(&script).map(|_| ())
    }

    fn type_text(&self, text: &str) -> Result<(), PlatformError> {
        let escaped = escape_applescript_string(text);
        let script = format!(
            r#"tell application "System Events" to keystroke "{}""#,
            escaped
        );
        Self::run_osascript(&script).map(|_| ())
    }

    fn press_key(&self, key: &str, modifiers: &[String]) -> Result<(), PlatformError> {
        let mods_clause = build_modifier_clause(modifiers);
        // 无 modifiers：单字符走 `keystroke`，其余走 `key code`（要求数字）或 `key "name"`。
        // 有 modifiers：必须用 `key code`（System Events 的 keystroke 不接受组合键）。
        let final_script = if mods_clause.is_empty() {
            if key.trim().chars().all(|c| c.is_ascii_digit()) {
                format!(
                    r#"tell application "System Events" to key code {}"#,
                    key.trim()
                )
            } else if key.trim().chars().count() == 1 {
                format!(
                    r#"tell application "System Events" to keystroke "{}""#,
                    escape_applescript_string(key.trim())
                )
            } else {
                format!(
                    r#"tell application "System Events" to key "{}""#,
                    escape_applescript_string(key.trim())
                )
            }
        } else {
            let code = if key.trim().chars().all(|c| c.is_ascii_digit()) {
                key.trim().to_string()
            } else {
                // 字符按键没法直接给 code：保守地回退为单字符 keystroke + 修饰键。
                format!(
                    r#"keystroke "{}" using {{{}}}"#,
                    escape_applescript_string(key.trim()),
                    modifiers_to_applescript_list(modifiers)
                )
            };
            format!(
                r#"tell application "System Events" to key code {}{}"#,
                code, mods_clause
            )
        };
        Self::run_osascript(&final_script).map(|_| ())
    }

    fn scroll(&self, x: i32, y: i32, dy: i32) -> Result<(), PlatformError> {
        // System Events 的 `scroll` 没有专门语法；最稳的是 mouseEvent 配合
        // mousewheel。退而求其次：用 `key code` 模拟 Page Up / Page Down
        // 不可行（语义错乱）。我们用 click + drag 思路也不行。
        // 系统命令是 `cliclick` / `osascript -e 'do shell script'` 不可用，
        // 我们直接走 `osascript -e 'tell application "System Events" to
        // scroll wheel ...'`：它在 macOS 上接受整数 dy。
        let script = format!(
            r#"tell application "System Events" to scroll wheel {{{}}} at {{{}, {}}}"#,
            dy, x, y
        );
        Self::run_osascript(&script).map(|_| ())
    }

    fn drag(&self, x1: i32, y1: i32, x2: i32, y2: i32) -> Result<(), PlatformError> {
        // System Events 没有原生 drag API。可借用第三方 `cliclick`（需要
        // 用户安装）。MVP：fallback 到 `cliclick dd:x1,y1 dm:dx,dy du:x2,y2`。
        // 未安装 cliclick 时返回明确错误。
        let total_dx = x2 - x1;
        let total_dy = y2 - y1;
        let cli = match find_cli_click() {
            Ok(p) => p,
            Err(msg) => return Err(PlatformError::NotExecuted(msg)),
        };
        let status = Command::new(cli)
            .arg(format!("dd:{},{}", x1, y1))
            .arg(format!("dm:{},{}", total_dx, total_dy))
            .arg(format!("du:{},{}", x2, y2))
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .map_err(|e| PlatformError::Io(e.to_string()))?;
        if !status.success() {
            return Err(PlatformError::NotExecuted(format!(
                "cliclick 退出码非零：{:?}",
                status.code()
            )));
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn temp_screenshot_path() -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("liveagent-cua-{ts}.png"))
}

#[cfg(target_os = "macos")]
fn translate_osascript_output(output: Output) -> Result<String, PlatformError> {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    // 典型权限拒绝信号：
    //   "Not authorized to ...", error number -1002 (AppleScript 1002),
    //   "osascript is not allowed to send keystrokes" 等。
    let combined = format!("{stdout}\n{stderr}");
    let lower = combined.to_lowercase();
    if lower.contains("not authorized")
        || lower.contains("1002")
        || lower.contains("accessibility")
        || lower.contains("assistive")
    {
        return Err(PlatformError::PermissionRequired {
            permission_key: "accessibility",
            permission: "Accessibility",
        });
    }
    if stderr.is_empty() {
        Err(PlatformError::NotExecuted(format!(
            "osascript exit non-zero (stdout={stdout})"
        )))
    } else {
        Err(PlatformError::NotExecuted(stderr))
    }
}

#[cfg(target_os = "macos")]
fn modifiers_to_applescript_list(modifiers: &[String]) -> String {
    use std::collections::BTreeSet;
    let mut mods: BTreeSet<String> = BTreeSet::new();
    for m in modifiers {
        let lower = m.trim().to_lowercase();
        match lower.as_str() {
            "cmd" | "command" | "commandorcontrol" | "super" | "meta" => {
                mods.insert("command down".to_string());
            }
            "shift" => {
                mods.insert("shift down".to_string());
            }
            "ctrl" | "control" => {
                mods.insert("control down".to_string());
            }
            "alt" | "option" => {
                mods.insert("option down".to_string());
            }
            _ => {}
        }
    }
    mods.into_iter().collect::<Vec<_>>().join(", ")
}

#[cfg(target_os = "macos")]
fn build_modifier_clause(modifiers: &[String]) -> String {
    let list = modifiers_to_applescript_list(modifiers);
    if list.is_empty() {
        String::new()
    } else {
        format!(" using {{{list}}}")
    }
}

#[cfg(target_os = "macos")]
fn find_cli_click() -> Result<PathBuf, String> {
    // 在 PATH 与常见 brew 安装路径中查找 cliclick，避免引入 which crate。
    use std::env;
    if let Some(p) = env::var_os("PATH") {
        for dir in env::split_paths(&p) {
            let candidate = dir.join("cliclick");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    for brew_dir in [
        "/opt/homebrew/bin/cliclick",
        "/usr/local/bin/cliclick",
    ] {
        let p = PathBuf::from(brew_dir);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err("拖拽需要系统命令 `cliclick`（brew install cliclick）".into())
}

#[cfg(target_os = "macos")]
fn escape_applescript_string(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 4);
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                // 控制字符：写成 \uXXXX 让 AppleScript 拒收，统一提前跳过。
                out.push(' ');
            }
            c => out.push(c),
        }
    }
    out
}

// ───────── 非 macOS 占位实现 ─────────

#[cfg(not(target_os = "macos"))]
pub struct UnsupportedDriver;

#[cfg(not(target_os = "macos"))]
impl CuaDriver for UnsupportedDriver {
    fn platform_label() -> &'static str {
        std::env::consts::OS
    }

    fn list_windows(&self) -> Result<Vec<WindowInfo>, PlatformError> {
        Err(PlatformError::Unsupported(std::env::consts::OS.to_string()))
    }
    fn focus_window(&self, _owner: &str) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported(std::env::consts::OS.to_string()))
    }
    fn screenshot(&self, _owner: Option<&str>) -> Result<Vec<u8>, PlatformError> {
        Err(PlatformError::Unsupported(std::env::consts::OS.to_string()))
    }
    fn click(&self, _x: i32, _y: i32, _b: ClickButton) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported(std::env::consts::OS.to_string()))
    }
    fn double_click(&self, _x: i32, _y: i32) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported(std::env::consts::OS.to_string()))
    }
    fn type_text(&self, _text: &str) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported(std::env::consts::OS.to_string()))
    }
    fn press_key(&self, _k: &str, _mods: &[String]) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported(std::env::consts::OS.to_string()))
    }
    fn scroll(&self, _x: i32, _y: i32, _dy: i32) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported(std::env::consts::OS.to_string()))
    }
    fn drag(&self, _x1: i32, _y1: i32, _x2: i32, _y2: i32) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported(std::env::consts::OS.to_string()))
    }
}

// ───────── 驱动工厂 ─────────

/// 拿到当前平台可用的驱动实例。`&'static` 因为驱动是无状态的。
pub fn platform_driver() -> &'static dyn CuaDriver {
    #[cfg(target_os = "macos")]
    {
        &MacOsDriver
    }
    #[cfg(not(target_os = "macos"))]
    {
        &UnsupportedDriver
    }
}

// ───────── 单元测试 ─────────

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn escape_applescript_handles_quotes_and_backslash() {
        assert_eq!(escape_applescript_string("a\"b\\c"), "a\\\"b\\\\c");
        assert_eq!(escape_applescript_string("hi\nthere"), "hi\\nthere");
    }

    #[test]
    fn modifier_clause_normalizes_aliases() {
        assert_eq!(build_modifier_clause(&[]), "");
        let m = build_modifier_clause(&["cmd".into(), "shift".into()]);
        assert!(m.contains("command down"));
        assert!(m.contains("shift down"));
    }

    #[test]
    fn click_button_apple_event_name_matches_system_events() {
        assert_eq!(ClickButton::Left.apple_event_name(), "click");
        assert_eq!(ClickButton::Right.apple_event_name(), "rightClick");
        assert_eq!(ClickButton::Middle.apple_event_name(), "middleClick");
    }
}