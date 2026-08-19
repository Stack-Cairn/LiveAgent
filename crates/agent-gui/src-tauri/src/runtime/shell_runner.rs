use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};

use crate::runtime::platform::{
    expand_tilde_path, maybe_augment_macos_path, shell_basename, strip_windows_verbatim_prefix,
};
use crate::runtime::process::{configure_child_process_group, terminate_child_process_tree};
use crate::runtime::sandbox::{self, SandboxOptions, SandboxSpec};

const MAX_STDOUT_BYTES: usize = 400 * 1024; // 400KB
const MAX_STDERR_BYTES: usize = 400 * 1024; // 400KB
pub(crate) const DEFAULT_SHELL_TIMEOUT_MS: u64 = 120_000;
pub(crate) const MIN_SHELL_TIMEOUT_MS: u64 = 1_000;
pub(crate) const MAX_SHELL_TIMEOUT_MS: u64 = 10 * 60_000;
const TERMINATION_GRACE_MS: u64 = 300;
const STREAM_EOF_GRACE_MS: u64 = 300;

/// Cancellation flag shared between the (possibly blocking) run body and the
/// async cancel watchers. Blocking code polls `is_cancelled`; async code
/// awaits `cancelled()`, which is event-driven via `Notify` — no polling.
#[derive(Default)]
pub(crate) struct ShellCancelFlag {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

impl ShellCancelFlag {
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once `cancel` has been called.
    pub(crate) async fn cancelled(&self) {
        while !self.is_cancelled() {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            // Register interest before the re-check so a `cancel` landing
            // between the check and the await cannot be missed.
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

pub(crate) type ShellCancelToken = Arc<ShellCancelFlag>;

#[derive(Default)]
pub(crate) struct ShellRunRegistry {
    runs: Mutex<HashMap<String, ShellCancelToken>>,
}

impl ShellRunRegistry {
    pub(crate) fn register(&self, run_id: &str) -> ShellCancelToken {
        let token = Arc::new(ShellCancelFlag::default());
        let previous = self
            .runs
            .lock()
            .expect("shell run registry poisoned")
            .insert(run_id.to_string(), Arc::clone(&token));
        if let Some(previous) = previous {
            previous.cancel();
        }
        token
    }

    pub(crate) fn cancel(&self, run_id: &str) -> bool {
        let Some(token) = self
            .runs
            .lock()
            .expect("shell run registry poisoned")
            .get(run_id)
            .cloned()
        else {
            return false;
        };
        token.cancel();
        true
    }

    pub(crate) fn unregister(&self, run_id: &str, token: &ShellCancelToken) {
        let mut runs = self.runs.lock().expect("shell run registry poisoned");
        let owns_registration = runs
            .get(run_id)
            .is_some_and(|registered| Arc::ptr_eq(registered, token));
        if owns_registration {
            runs.remove(run_id);
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ShellRunResponse {
    pub exit_code: i32,
    pub shell: String,
    pub platform: String,
    pub profile: String,
    pub shell_family: String,
    /// 沙箱机制("seatbelt"/"bubblewrap"),未启用沙箱时为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    pub cancelled: bool,
    pub stdio_open_after_exit: bool,
    pub effective_timeout_ms: u64,
    pub duration_ms: u128,
}

#[derive(Debug)]
enum ShellError {
    InvalidWorkdir(String),
    InvalidRelPath(String),
    OutOfBounds(String),
    Io(io::Error),
    Other(String),
}

impl std::fmt::Display for ShellError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ShellError::InvalidWorkdir(s) => {
                write!(f, "workdir must be an existing absolute directory: {s}")
            }
            ShellError::InvalidRelPath(s) => {
                write!(
                    f,
                    "cwd must be relative and must not contain .., drive letters, or a root path: {s}"
                )
            }
            ShellError::OutOfBounds(s) => {
                write!(f, "Target path is outside the workspace root: {s}")
            }
            ShellError::Io(e) => write!(f, "I/O error: {e}"),
            ShellError::Other(s) => write!(f, "{s}"),
        }
    }
}

impl From<io::Error> for ShellError {
    fn from(value: io::Error) -> Self {
        ShellError::Io(value)
    }
}

fn canonicalize_workdir(workdir: &str) -> Result<PathBuf, ShellError> {
    let raw = workdir.trim();
    if raw.is_empty() {
        return Err(ShellError::InvalidWorkdir(workdir.to_string()));
    }

    let p = expand_tilde_path(raw);
    if !p.is_absolute() {
        return Err(ShellError::InvalidWorkdir(workdir.to_string()));
    }

    let md = fs::metadata(&p).map_err(|_| ShellError::InvalidWorkdir(workdir.to_string()))?;
    if !md.is_dir() {
        return Err(ShellError::InvalidWorkdir(workdir.to_string()));
    }

    // Strip the Windows `\\?\` verbatim prefix: this path becomes the child
    // process cwd and the model-visible workdir string.
    Ok(strip_windows_verbatim_prefix(fs::canonicalize(&p)?))
}

/// Canonical workspace root for runtime entry points that need to construct a
/// sandbox spec. Keep the internal error type private while sharing the exact
/// validation/canonicalization semantics with the one-shot runner.
pub(crate) fn canonical_workdir(workdir: &str) -> Result<PathBuf, String> {
    canonicalize_workdir(workdir).map_err(|error| error.to_string())
}

fn normalize_rel_path_input(input: &str) -> String {
    input.trim().replace('\\', "/")
}

fn sanitize_rel_path_core(input: &str) -> Result<Option<PathBuf>, ShellError> {
    let normalized = normalize_rel_path_input(input);
    if normalized.is_empty() {
        return Err(ShellError::InvalidRelPath(input.to_string()));
    }

    let p = Path::new(&normalized);
    let mut out = PathBuf::new();

    for c in p.components() {
        match c {
            Component::Prefix(_) | Component::RootDir => {
                return Err(ShellError::InvalidRelPath(input.to_string()));
            }
            Component::ParentDir => return Err(ShellError::InvalidRelPath(input.to_string())),
            Component::CurDir => {
                // ignore
            }
            Component::Normal(seg) => {
                if seg.to_string_lossy().contains(':') {
                    return Err(ShellError::InvalidRelPath(input.to_string()));
                }
                out.push(seg);
            }
        }
    }

    if out.as_os_str().is_empty() {
        return Ok(None);
    }

    Ok(Some(out))
}

fn ensure_within_workdir_existing(workdir: &Path, target: &Path) -> Result<PathBuf, ShellError> {
    // Both sides are verbatim-stripped so the prefix check compares like
    // shapes on Windows (workdir came from canonicalize_workdir).
    let canon = strip_windows_verbatim_prefix(fs::canonicalize(target)?);
    if !canon.starts_with(workdir) {
        return Err(ShellError::OutOfBounds(canon.display().to_string()));
    }
    Ok(canon)
}

fn is_absolute_cwd_input(value: &str) -> bool {
    if value.starts_with('/') || value.starts_with('\\') {
        return true;
    }
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn resolve_absolute_cwd(value: &str) -> Result<PathBuf, ShellError> {
    let invalid =
        || ShellError::Other(format!("cwd does not exist or is not a directory: {value}"));
    let canon = strip_windows_verbatim_prefix(fs::canonicalize(value).map_err(|_| invalid())?);
    let md = fs::metadata(&canon).map_err(|_| invalid())?;
    if !md.is_dir() {
        return Err(invalid());
    }
    Ok(canon)
}

pub(crate) fn resolve_shell_cwd(workdir: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    let wd = canonicalize_workdir(workdir).map_err(|error| error.to_string())?;
    match cwd {
        None => Ok(wd),
        Some(value) if is_absolute_cwd_input(value.trim()) => {
            resolve_absolute_cwd(value.trim()).map_err(|error| error.to_string())
        }
        Some(value) => match sanitize_rel_path_core(value).map_err(|error| error.to_string())? {
            None => Ok(wd),
            Some(rel) => {
                let target = ensure_within_workdir_existing(&wd, &wd.join(rel))
                    .map_err(|error| error.to_string())?;
                let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
                if !metadata.is_dir() {
                    return Err(
                        ShellError::Other("cwd must be a directory".to_string()).to_string()
                    );
                }
                Ok(target)
            }
        },
    }
}

#[derive(Default)]
struct StreamReadState {
    buf: Vec<u8>,
    truncated: bool,
    done: bool,
}

struct StreamReadHandle {
    state: Arc<(Mutex<StreamReadState>, Condvar)>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl StreamReadHandle {
    fn finish(mut self, eof_grace: Duration) -> (Vec<u8>, bool, bool) {
        let (lock, cvar) = &*self.state;
        let mut state = lock.lock().expect("stream reader state poisoned");

        if !state.done {
            let (next_state, _) = cvar
                .wait_timeout_while(state, eof_grace, |state| !state.done)
                .expect("stream reader state poisoned");
            state = next_state;
        }

        let stdio_open_after_exit = !state.done;
        let buf = state.buf.clone();
        let truncated = state.truncated || stdio_open_after_exit;
        drop(state);

        if !stdio_open_after_exit {
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }

        (buf, truncated, stdio_open_after_exit)
    }
}

fn read_stream_with_limit<R: Read + Send + 'static>(
    mut reader: R,
    limit: usize,
) -> StreamReadHandle {
    let state = Arc::new((Mutex::new(StreamReadState::default()), Condvar::new()));
    let worker_state = Arc::clone(&state);

    let join = std::thread::spawn(move || {
        let mut tmp = [0u8; 8192];
        loop {
            match reader.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    let (lock, _) = &*worker_state;
                    let mut state = lock.lock().expect("stream reader state poisoned");
                    if state.buf.len() < limit {
                        let take = std::cmp::min(limit - state.buf.len(), n);
                        state.buf.extend_from_slice(&tmp[..take]);
                        if take < n {
                            state.truncated = true;
                        }
                    } else {
                        state.truncated = true;
                    }
                    // Keep draining even after truncation to avoid deadlocks on full pipes.
                }
                Err(_) => break,
            }
        }

        let (lock, cvar) = &*worker_state;
        let mut state = lock.lock().expect("stream reader state poisoned");
        state.done = true;
        cvar.notify_all();
    });

    StreamReadHandle {
        state,
        join: Some(join),
    }
}

fn normalize_timeout_ms(timeout_ms: Option<u64>, max_timeout_ms: Option<u64>) -> u64 {
    let max_timeout_ms = max_timeout_ms
        .unwrap_or(MAX_SHELL_TIMEOUT_MS)
        .clamp(MIN_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS);
    timeout_ms
        .unwrap_or(DEFAULT_SHELL_TIMEOUT_MS)
        .clamp(MIN_SHELL_TIMEOUT_MS, max_timeout_ms)
}

fn is_cancelled(cancel_token: Option<&ShellCancelToken>) -> bool {
    cancel_token
        .map(|token| token.is_cancelled())
        .unwrap_or(false)
}

#[cfg(windows)]
fn windows_powershell_command(cmd: &str) -> String {
    [
        "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "$OutputEncoding = [Console]::OutputEncoding",
        cmd,
    ]
    .join("; ")
}

#[cfg(windows)]
fn windows_cmd_command(cmd: &str) -> String {
    format!("chcp 65001>nul & {cmd}")
}

#[cfg(windows)]
fn normalize_windows_dir_for_compare(p: &Path) -> String {
    strip_windows_verbatim_prefix(p.to_path_buf())
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn windows_dirs_equal(left: &Path, right: &Path) -> bool {
    if normalize_windows_dir_for_compare(left) == normalize_windows_dir_for_compare(right) {
        return true;
    }
    let Ok(left) = fs::canonicalize(left) else {
        return false;
    };
    let Ok(right) = fs::canonicalize(right) else {
        return false;
    };
    normalize_windows_dir_for_compare(&left) == normalize_windows_dir_for_compare(&right)
}

#[cfg(windows)]
fn is_windows_system_bash_alias_dir(dir: &Path) -> bool {
    let Some(root) = std::env::var_os("SystemRoot") else {
        return false;
    };
    ["System32", "Sysnative"]
        .iter()
        .any(|name| windows_dirs_equal(dir, &Path::new(&root).join(name)))
}

#[cfg(windows)]
fn is_windows_apps_alias_dir(dir: &Path) -> bool {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return false;
    };
    windows_dirs_equal(
        dir,
        &Path::new(&local).join("Microsoft").join("WindowsApps"),
    )
}

/// Store 应用注册的 App-Execution-Alias 是 0 字节的 reparse point，`is_file()`
/// 对它返回 true；真正的 Git Bash 可执行文件不可能是 0 字节。
#[cfg(windows)]
fn is_app_execution_alias(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|md| md.len() == 0)
}

#[cfg(windows)]
fn is_git_bash_candidate(path: &Path) -> bool {
    if !path.is_file() || is_app_execution_alias(path) {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    !is_windows_system_bash_alias_dir(parent) && !is_windows_apps_alias_dir(parent)
}

#[cfg(windows)]
fn find_git_bash_on_path(path_var: &std::ffi::OsStr) -> Option<PathBuf> {
    for dir in std::env::split_paths(path_var) {
        let candidate = dir.join("bash.exe");
        if is_git_bash_candidate(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Git Bash 解析（对标 Claude Code）：env 覆盖 → PATH → Git for Windows 默认安装路径。
#[cfg(windows)]
fn find_git_bash() -> Option<PathBuf> {
    for var in ["LIVEAGENT_GIT_BASH_PATH", "CLAUDE_CODE_GIT_BASH_PATH"] {
        if let Ok(raw) = std::env::var(var) {
            let trimmed = raw.trim().trim_matches('"');
            if !trimmed.is_empty() {
                let path = expand_tilde_path(trimmed);
                if is_git_bash_candidate(&path) {
                    return Some(path);
                }
            }
        }
    }

    let path_var = std::env::var_os("PATH").unwrap_or_default();
    if let Some(found) = find_git_bash_on_path(&path_var) {
        return Some(found);
    }

    let roots = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|var| std::env::var_os(var).map(PathBuf::from))
        .chain([
            PathBuf::from(r"C:\Program Files"),
            PathBuf::from(r"C:\Program Files (x86)"),
        ]);
    for root in roots {
        // bin\bash.exe 是带 MSYS 环境注入的启动器，优先于 usr\bin 的裸 bash。
        for rel in [r"Git\bin\bash.exe", r"Git\usr\bin\bash.exe"] {
            let candidate = root.join(rel);
            if is_git_bash_candidate(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ShellExecutionProfile {
    pub platform: &'static str,
    pub profile: &'static str,
    pub shell_family: &'static str,
    pub display_shell: &'static str,
}

struct ShellCandidate {
    profile: ShellExecutionProfile,
    program: PathBuf,
    args: Vec<String>,
    augment_macos_path: bool,
}

pub(crate) struct SpawnedPlatformShell {
    pub child: std::process::Child,
    pub profile: ShellExecutionProfile,
    /// 生效的沙箱机制;None 表示未启用沙箱。
    pub sandbox: Option<&'static str>,
}

/// 平台 shell 候选链。`sandboxed` 只影响 Windows 顺序(见下),其余平台忽略。
#[cfg_attr(not(windows), allow(unused_variables))]
fn platform_shell_candidates(cmd: &str, sandboxed: bool) -> Vec<ShellCandidate> {
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        if let Some(bash) = find_git_bash() {
            candidates.push(ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "windows",
                    profile: "windows-git-bash",
                    shell_family: "posix",
                    display_shell: "bash",
                },
                program: bash,
                // 非登录 -c：-lc 会执行 /etc/profile 并 cd $HOME，破坏 cwd 语义。
                args: vec!["-c".to_string(), cmd.to_string()],
                augment_macos_path: false,
            });
        }
        let powershell_command = windows_powershell_command(cmd);
        candidates.push(ShellCandidate {
            profile: ShellExecutionProfile {
                platform: "windows",
                profile: "windows-pwsh",
                shell_family: "powershell",
                display_shell: "pwsh",
            },
            program: PathBuf::from("pwsh"),
            args: vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
                powershell_command.clone(),
            ],
            augment_macos_path: false,
        });
        candidates.push(ShellCandidate {
            profile: ShellExecutionProfile {
                platform: "windows",
                profile: "windows-powershell",
                shell_family: "powershell",
                display_shell: "powershell",
            },
            program: PathBuf::from("powershell.exe"),
            args: vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-Command".to_string(),
                powershell_command,
            ],
            augment_macos_path: false,
        });
        candidates.push(ShellCandidate {
            profile: ShellExecutionProfile {
                platform: "windows",
                profile: "windows-cmd",
                shell_family: "cmd",
                display_shell: "cmd",
            },
            program: PathBuf::from("cmd.exe"),
            args: vec![
                "/D".to_string(),
                "/S".to_string(),
                "/C".to_string(),
                windows_cmd_command(cmd),
            ],
            augment_macos_path: false,
        });
        // 沙箱下把 cmd.exe 提到队首:它是候选里**唯一的纯原生 PE**,不依赖 msys 运行时
        // (Git Bash)、不依赖托管运行时(pwsh=CoreCLR、powershell.exe=.NET Framework),
        // 因而是受限令牌/AppContainer 下唯一确定能起来的 shell。此前的顺序会让前三个候选
        // 依次启动即死,每个白付一次 ≤2s 探测(首条命令最坏 ~6s),且任何探测漏判都会把
        // 一个必死 shell 交给模型。非沙箱路径顺序不变(Git Bash 优先,POSIX 语义更好)。
        if sandboxed {
            if let Some(cmd_index) = candidates
                .iter()
                .position(|candidate| candidate.profile.profile == "windows-cmd")
            {
                let cmd_candidate = candidates.remove(cmd_index);
                candidates.insert(0, cmd_candidate);
            }
        }
        return candidates;
    }

    #[cfg(target_os = "macos")]
    {
        vec![
            ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "macos",
                    profile: "posix-zsh",
                    shell_family: "posix",
                    display_shell: "zsh",
                },
                program: PathBuf::from("zsh"),
                args: vec!["-lc".to_string(), cmd.to_string()],
                augment_macos_path: true,
            },
            ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "macos",
                    profile: "posix-bash",
                    shell_family: "posix",
                    display_shell: "bash",
                },
                program: PathBuf::from("bash"),
                args: vec!["-lc".to_string(), cmd.to_string()],
                augment_macos_path: true,
            },
            ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "macos",
                    profile: "posix-sh",
                    shell_family: "posix",
                    display_shell: "sh",
                },
                program: PathBuf::from("sh"),
                args: vec!["-c".to_string(), cmd.to_string()],
                augment_macos_path: true,
            },
        ]
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        vec![
            ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "linux",
                    profile: "posix-bash",
                    shell_family: "posix",
                    display_shell: "bash",
                },
                program: PathBuf::from("bash"),
                args: vec!["-lc".to_string(), cmd.to_string()],
                augment_macos_path: false,
            },
            ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "linux",
                    profile: "posix-zsh",
                    shell_family: "posix",
                    display_shell: "zsh",
                },
                program: PathBuf::from("zsh"),
                args: vec!["-lc".to_string(), cmd.to_string()],
                augment_macos_path: false,
            },
            ShellCandidate {
                profile: ShellExecutionProfile {
                    platform: "linux",
                    profile: "posix-sh",
                    shell_family: "posix",
                    display_shell: "sh",
                },
                program: PathBuf::from("sh"),
                args: vec!["-c".to_string(), cmd.to_string()],
                augment_macos_path: false,
            },
        ]
    }
}

#[cfg(test)]
fn default_platform_shell_profile() -> ShellExecutionProfile {
    platform_shell_candidates("", false)
        .into_iter()
        .next()
        .map(|candidate| candidate.profile)
        .unwrap_or(ShellExecutionProfile {
            platform: "linux",
            profile: "posix-sh",
            shell_family: "posix",
            display_shell: "sh",
        })
}

/// 沙箱下 shell 候选可用性的进程级缓存。key = (候选程序路径, 沙箱机制):同一 shell 在
/// 受限令牌与 AppContainer 两种机制下兼容性可能不同,须分别记录;探测结果与工作区无关
/// (loader 死亡源于令牌/内核对象语义,非路径),故 key 不含 write_root。
#[cfg(windows)]
static SANDBOX_SHELL_PROBE_CACHE: std::sync::OnceLock<
    Mutex<HashMap<(PathBuf, &'static str), bool>>,
> = std::sync::OnceLock::new();

/// 子进程 loader 早期死亡(未进 main)的 NTSTATUS 退出码:0xC0000142(DLL 初始化失败,
/// msys/cygwin 系 shell 在沙箱下的典型死法)、0xC0000135(DLL 缺失)、0xC0000022(拒绝
/// 访问)。命中 ⇒ 该候选在此沙箱机制下连 loader 都过不去。
#[cfg_attr(not(windows), allow(dead_code))]
fn is_loader_failure_exit(code: i32) -> bool {
    matches!(code as u32, 0xC000_0142 | 0xC000_0135 | 0xC000_0022)
}

/// CLR 未处理托管异常(0xE0434352 = `COMPLUS_E_UNHANDLED`)。
///
/// **与 loader 失败是不同的失败层**:该码意味着 PE loader 已通过、CoreCLR/.NET
/// Framework 的原生部分已成功起来,随后在托管层抛异常且无人处理。托管 shell
/// (pwsh 是 CoreCLR、powershell.exe 5.1 是 .NET Framework)在受限令牌下的典型死法:
/// 托管初始化要经 CNG 取加密原语,而 `WRITE_RESTRICTED` 令牌下 `\Device\CNG` 的写类
/// 打开过不了第二遍判定(其 DACL 不含我们的限制性 SID)⇒ `BCrypt.dll` 初始化失败 ⇒
/// 托管异常 ⇒ 0xE0434352。Chromium 靠“降权前先 warmup CNG”规避,但那要求进程先以
/// 正常令牌启动再自我降权;我们是父进程造好受限令牌再 `CreateProcessAsUserW` 拉起
/// 全新 shell,子进程从第一条指令起就受限,**不存在 warmup 窗口** —— 故对沙箱而言这
/// 是结构性不兼容,只能换候选,不能修好。
#[cfg_attr(not(windows), allow(dead_code))]
fn is_managed_runtime_init_failure_exit(code: i32) -> bool {
    code as u32 == 0xE043_4352
}

/// 该候选 shell 是否在当前沙箱机制下“启动即死”(不区分死在 loader 还是托管初始化)。
///
/// 两类都必须纳入,否则候选回退链不推进:此前只认 loader NTSTATUS,pwsh 的
/// 0xE0434352 被判“可用”,于是一个必死的 shell 被交给模型,后续每条命令都以同一
/// 退出码失败;更糟的是该裁决会进 `SANDBOX_SHELL_PROBE_CACHE`(进程级),错误结论
/// 被固化到重启为止。
#[cfg_attr(not(windows), allow(dead_code))]
fn is_sandbox_incompatible_exit(code: i32) -> bool {
    is_loader_failure_exit(code) || is_managed_runtime_init_failure_exit(code)
}

/// 探测裁决:给定探测进程的退出码(None = 超时/被杀/无退出码),该候选是否可用。
/// 只有明确的“启动即死”退出码判不可用;其余(超时、普通非零退出)一律放行,由真实
/// spawn 自行失败并走既有错误链——探测只负责识别启动即死这一类硬不兼容。
///
/// 机制无关:受限令牌与 AppContainer 两个后端共用本裁决(缓存 key 已含机制,两边
/// 各自独立记录),故新增的托管初始化失败在 sandbox 与 sandboxOffline 下同样生效。
#[cfg_attr(not(windows), allow(dead_code))]
fn sandbox_probe_verdict(exit_code: Option<i32>) -> bool {
    !exit_code.is_some_and(is_sandbox_incompatible_exit)
}

/// Windows 沙箱下探测某 shell 候选能否活到能执行命令(结果进程级缓存)。
///
/// 经启动器 spawn 一条 `exit 0` 的最小命令,等待 ≤2s:退出码命中“启动即死”集合
/// (Git Bash 的 msys-2.0.dll 在受限令牌下 0xC0000142;pwsh/powershell 的 CNG 初始化
/// 失败 0xE0434352)⇒ 不可用,调用方落到下一候选。探测本身失败(wrap/spawn 出错)判
/// 可用:让真实 spawn 复现错误并走既有 fail-closed/错误报告路径,探测不吞错。
///
/// 注意候选里**只有 cmd.exe 是纯原生 PE**:Git Bash 依赖 msys 运行时,pwsh 是 CoreCLR,
/// powershell.exe 是 .NET Framework —— 三者在沙箱下都可能启动即死,不能假定“非 Git Bash
/// 的候选必然可用”。故沙箱下候选顺序已把 cmd.exe 提前(见 `platform_shell_candidates`)。
#[cfg(windows)]
fn sandbox_candidate_usable(
    spec: &SandboxSpec,
    candidate: &ShellCandidate,
    mechanism: &'static str,
) -> bool {
    use wait_timeout::ChildExt;

    let cache = SANDBOX_SHELL_PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = (candidate.program.clone(), mechanism);
    if let Ok(map) = cache.lock() {
        if let Some(&usable) = map.get(&key) {
            return usable;
        }
    }

    let probe_args: Vec<String> = match candidate.profile.profile {
        "windows-git-bash" => vec!["-c".to_string(), "exit 0".to_string()],
        "windows-pwsh" | "windows-powershell" => vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            "exit 0".to_string(),
        ],
        _ => vec!["/D".to_string(), "/C".to_string(), "exit 0".to_string()],
    };

    let usable = match sandbox::wrap_command(spec, &candidate.program, &probe_args) {
        Ok((program, args, _)) => {
            let exit_code = Command::new(&program)
                .args(&args)
                .current_dir(&spec.write_root)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok()
                .and_then(|mut child| match child.wait_timeout(Duration::from_secs(2)) {
                    Ok(Some(status)) => status.code(),
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        None
                    }
                });
            sandbox_probe_verdict(exit_code)
        }
        Err(_) => true,
    };
    if let Ok(mut map) = cache.lock() {
        map.insert(key, usable);
    }
    usable
}

pub(crate) fn spawn_platform_shell_command<F>(
    command: &str,
    cwd: &Path,
    envs: &[(String, String)],
    sandbox_spec: Option<&SandboxSpec>,
    mut stdio_factory: F,
) -> Result<SpawnedPlatformShell, String>
where
    F: FnMut() -> io::Result<(Stdio, Stdio)>,
{
    let mut errors: Vec<String> = Vec::new();
    let system_proxy_envs = crate::services::system_proxy::shell_proxy_envs()?;

    for candidate in platform_shell_candidates(command, sandbox_spec.is_some()) {
        // 沙箱包裹在 shell candidate 选定后、spawn 前进行,fail-closed:包裹
        // 失败(平台不支持/依赖缺失)直接报错,绝不回退为无沙箱执行。
        // sandbox-exec/bwrap 按名字解析 shell 时同样遵循 PATH,语义不变。
        let (spawn_program, spawn_args, sandbox_mechanism) = match sandbox_spec {
            Some(spec) => {
                let (program, args, mechanism) =
                    sandbox::wrap_command(spec, &candidate.program, &candidate.args)?;
                (program, args, Some(mechanism))
            }
            None => (candidate.program.clone(), candidate.args.clone(), None),
        };
        // Windows 沙箱专属:候选回退链平时靠 spawn 失败推进,但沙箱下 spawn 的永远是
        // LiveAgent.exe 启动器(总能成功),启动即死型不兼容只体现为命令“执行了但立即死”:
        // Git Bash 的 msys 依赖在受限令牌下 0xC0000142,pwsh/powershell 的 CNG 初始化失败
        // 0xE0434352。用一次缓存的探测(`exit 0`)提前识别并落到下一候选,不给模型返回死 shell。
        #[cfg(windows)]
        if let (Some(spec), Some(mechanism)) = (sandbox_spec, sandbox_mechanism) {
            if !sandbox_candidate_usable(spec, &candidate, mechanism) {
                errors.push(format!(
                    "{} ({}) skipped: the shell dies at startup under the {mechanism} sandbox \
                     (STATUS_DLL_INIT_FAILED for MSYS-based shells, or CLR/CNG init failure \
                     0xE0434352 for managed shells such as pwsh)",
                    candidate.profile.profile, candidate.profile.display_shell
                ));
                continue;
            }
        }
        let (stdout, stderr) =
            stdio_factory().map_err(|err| format!("Failed to prepare shell stdio: {err}"))?;
        let mut c = Command::new(&spawn_program);
        c.args(&spawn_args);
        // 系统代理 env 先注入，调用方 envs（如 LIVEAGENT_HOOK_*）后写保持更高优先级。
        for (key, value) in &system_proxy_envs {
            c.env(key, value);
        }
        c.envs(
            envs.iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        );
        if candidate.augment_macos_path {
            maybe_augment_macos_path(&mut c);
        }
        configure_child_process_group(&mut c);
        let spawn_result = c
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .spawn();

        match spawn_result {
            Ok(child) => {
                return Ok(SpawnedPlatformShell {
                    child,
                    profile: candidate.profile,
                    sandbox: sandbox_mechanism,
                });
            }
            Err(err) => errors.push(format!(
                "{} ({}) failed: {err}",
                candidate.profile.profile, candidate.profile.display_shell
            )),
        }
    }

    let detail = if errors.is_empty() {
        "no shell candidates were available".to_string()
    } else {
        errors.join("; ")
    };
    Err(ShellError::Other(format!("Failed to start command: {detail}")).to_string())
}

/// 无 env 注入、无沙箱的最简入口。生产链路一律走 `run_shell_script_with_envs` 并显式
/// 传入沙箱参数(P1#2:Cron 曾因这里的 `None` 而恒以无沙箱方式执行),故此入口仅供测试。
#[cfg(test)]
pub(crate) fn run_shell_script(
    workdir: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    max_timeout_ms: Option<u64>,
    provider_id: Option<String>,
    cancel_token: Option<ShellCancelToken>,
) -> Result<ShellRunResponse, String> {
    run_shell_script_with_envs(
        workdir,
        command,
        cwd,
        timeout_ms,
        max_timeout_ms,
        provider_id,
        cancel_token,
        &[],
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_shell_script_with_envs(
    workdir: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    max_timeout_ms: Option<u64>,
    _provider_id: Option<String>,
    cancel_token: Option<ShellCancelToken>,
    envs: &[(String, String)],
    sandbox_options: Option<SandboxOptions>,
) -> Result<ShellRunResponse, String> {
    let cmd = command.trim();
    if cmd.is_empty() {
        return Err(ShellError::Other("command cannot be empty".to_string()).to_string());
    }

    let actual_cwd = resolve_shell_cwd(&workdir, cwd.as_deref())?;

    let effective_timeout_ms = normalize_timeout_ms(timeout_ms, max_timeout_ms);
    let timeout = Duration::from_millis(effective_timeout_ms);
    let start = Instant::now();

    // 沙箱写围栏锚定 workdir(工作区根)而非 cwd:cwd 可能是子目录,但工具语义
    // 允许写整个工作区。
    let sandbox_spec = match sandbox_options {
        Some(options) => {
            let wd = canonicalize_workdir(&workdir).map_err(|e| e.to_string())?;
            Some(SandboxSpec::from_options(wd, options))
        }
        None => None,
    };
    let spawned =
        spawn_platform_shell_command(cmd, &actual_cwd, envs, sandbox_spec.as_ref(), || {
            Ok((Stdio::piped(), Stdio::piped()))
        })?;
    let mut child = spawned.child;
    let shell_profile = spawned.profile;
    let sandbox_mechanism = spawned.sandbox;
    let shell_name = shell_basename(shell_profile.display_shell);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ShellError::Other("Failed to capture stdout".to_string()).to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ShellError::Other("Failed to capture stderr".to_string()).to_string())?;

    let out_handle = read_stream_with_limit(stdout, MAX_STDOUT_BYTES);
    let err_handle = read_stream_with_limit(stderr, MAX_STDERR_BYTES);

    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        if let Some(s) = child
            .try_wait()
            .map_err(|e| ShellError::Io(e).to_string())?
        {
            break s;
        }

        if is_cancelled(cancel_token.as_ref()) {
            cancelled = true;
            break terminate_child_process_tree(
                &mut child,
                Duration::from_millis(TERMINATION_GRACE_MS),
            )
            .map_err(|e| ShellError::Io(e).to_string())?;
        }

        if start.elapsed() >= timeout {
            timed_out = true;
            break terminate_child_process_tree(
                &mut child,
                Duration::from_millis(TERMINATION_GRACE_MS),
            )
            .map_err(|e| ShellError::Io(e).to_string())?;
        }

        std::thread::sleep(Duration::from_millis(50));
    };

    let duration_ms = start.elapsed().as_millis();

    let stream_eof_grace = Duration::from_millis(STREAM_EOF_GRACE_MS);
    let (stdout_bytes, stdout_truncated, stdout_open_after_exit) =
        out_handle.finish(stream_eof_grace);
    let (stderr_bytes, stderr_truncated, stderr_open_after_exit) =
        err_handle.finish(stream_eof_grace);
    let stdio_open_after_exit = stdout_open_after_exit || stderr_open_after_exit;

    let stdout_str = String::from_utf8_lossy(&stdout_bytes).to_string();
    let mut stderr_str = String::from_utf8_lossy(&stderr_bytes).to_string();

    if stdio_open_after_exit {
        if !stderr_str.is_empty() && !stderr_str.ends_with('\n') {
            stderr_str.push('\n');
        }
        if shell_profile.platform == "windows" {
            stderr_str.push_str(
                "LiveAgent warning: command exited, but stdout/stderr remained open after exit. \
This usually means a background process inherited the tool pipes. Use ManagedProcess for \
long-running Windows commands so LiveAgent can capture logs and stop the process tree.",
            );
        } else {
            stderr_str.push_str(
                "LiveAgent warning: command exited, but stdout/stderr remained open after exit. \
This usually means a background process inherited the tool pipes. Redirect long-running \
process output to a log file, for example: `nohup command > /tmp/liveagent-task.log 2>&1 < /dev/null &`.",
            );
        }
    }

    Ok(ShellRunResponse {
        exit_code: status.code().unwrap_or(-1),
        shell: shell_name,
        platform: shell_profile.platform.to_string(),
        profile: shell_profile.profile.to_string(),
        shell_family: shell_profile.shell_family.to_string(),
        sandbox: sandbox_mechanism.map(str::to_string),
        stdout: stdout_str,
        stderr: stderr_str,
        stdout_truncated,
        stderr_truncated,
        timed_out,
        cancelled,
        stdio_open_after_exit,
        effective_timeout_ms,
        duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        default_platform_shell_profile, is_loader_failure_exit,
        is_managed_runtime_init_failure_exit, is_sandbox_incompatible_exit, normalize_timeout_ms,
        run_shell_script, sandbox_probe_verdict, sanitize_rel_path_core, ShellRunRegistry,
        DEFAULT_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS, MIN_SHELL_TIMEOUT_MS,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    // 沙箱候选探测的裁决逻辑(纯函数,平台无关):只有“启动即死”判不可用;
    // 超时/普通失败一律放行交由真实 spawn 走既有错误链。
    #[test]
    fn sandbox_probe_verdict_rejects_startup_death_exit_codes() {
        // loader 死亡三码(as i32 后为负数,与 std ExitStatus::code() 的表示一致)。
        assert!(is_loader_failure_exit(0xC000_0142_u32 as i32)); // STATUS_DLL_INIT_FAILED
        assert!(is_loader_failure_exit(0xC000_0135_u32 as i32)); // STATUS_DLL_NOT_FOUND
        assert!(is_loader_failure_exit(0xC000_0022_u32 as i32)); // STATUS_ACCESS_DENIED
        assert!(!sandbox_probe_verdict(Some(0xC000_0142_u32 as i32)));
        // 正常退出、普通失败、其它 NTSTATUS、超时(None)都不构成“候选不可用”。
        assert!(sandbox_probe_verdict(Some(0)));
        assert!(sandbox_probe_verdict(Some(1)));
        assert!(sandbox_probe_verdict(Some(127)));
        assert!(sandbox_probe_verdict(Some(0xC000_0005_u32 as i32))); // ACCESS_VIOLATION:运行期崩溃,非启动即死
        assert!(sandbox_probe_verdict(None));
    }

    // CLR 未处理异常(pwsh 在受限令牌下 CNG 初始化失败的死法)必须让候选链推进。
    // 曾漏判 ⇒ 必死的 pwsh 被交给模型,且错误裁决进进程级缓存固化到重启。
    #[test]
    fn sandbox_probe_verdict_rejects_clr_unhandled_exception() {
        let clr = 0xE043_4352_u32 as i32;
        assert_eq!(clr, -532_462_766); // 与真机报告的退出码一致
        assert!(is_managed_runtime_init_failure_exit(clr));
        assert!(is_sandbox_incompatible_exit(clr));
        assert!(!sandbox_probe_verdict(Some(clr)));
        // 它不是 loader 失败:分层必须保持可区分(诊断文案据此选词)。
        assert!(!is_loader_failure_exit(clr));
        // loader 三码同样落在合并判定里。
        assert!(is_sandbox_incompatible_exit(0xC000_0142_u32 as i32));
        // 邻近的 CLR 相关码不应被误判(只认未处理异常这一个)。
        assert!(sandbox_probe_verdict(Some(0xE043_4353_u32 as i32)));
    }

    // 沙箱下 cmd.exe 必须排在队首:它是唯一纯原生 PE 候选,而 Git Bash(msys)、
    // pwsh(CoreCLR)、powershell.exe(.NET Framework)在沙箱下都可能启动即死。
    #[cfg(windows)]
    #[test]
    fn windows_sandboxed_chain_puts_cmd_first() {
        let sandboxed: Vec<&'static str> = super::platform_shell_candidates("echo hi", true)
            .iter()
            .map(|candidate| candidate.profile.profile)
            .collect();
        assert_eq!(sandboxed[0], "windows-cmd");
        // 回退尾巴保留(cmd 若因故不可用仍有候选),且不重复、不丢失。
        let unsandboxed: Vec<&'static str> = super::platform_shell_candidates("echo hi", false)
            .iter()
            .map(|candidate| candidate.profile.profile)
            .collect();
        assert_eq!(sandboxed.len(), unsandboxed.len());
        for profile in &unsandboxed {
            assert!(sandboxed.contains(profile), "missing candidate {profile}");
        }
    }

    #[test]
    fn sanitize_rel_path_accepts_windows_style_separators() {
        assert_eq!(
            sanitize_rel_path_core(r"src\tauri\commands").unwrap(),
            Some(PathBuf::from("src").join("tauri").join("commands"))
        );
    }

    #[test]
    fn sanitize_rel_path_rejects_parent_and_absolute_segments() {
        for value in ["../x", "a/../x", "/tmp", r"C:\tmp", "file.txt:stream"] {
            assert!(sanitize_rel_path_core(value).is_err(), "{value}");
        }
    }

    #[test]
    fn sanitize_rel_path_core_treats_dot_as_root() {
        assert_eq!(sanitize_rel_path_core(".").unwrap(), None);
        assert_eq!(sanitize_rel_path_core("./").unwrap(), None);
    }

    #[test]
    fn normalize_timeout_ms_clamps_to_supported_range() {
        assert_eq!(normalize_timeout_ms(None, None), DEFAULT_SHELL_TIMEOUT_MS);
        assert_eq!(normalize_timeout_ms(Some(1), None), MIN_SHELL_TIMEOUT_MS);
        assert_eq!(
            normalize_timeout_ms(Some(1_800_000), None),
            MAX_SHELL_TIMEOUT_MS,
        );
        assert_eq!(normalize_timeout_ms(Some(1_800_000), Some(30_000)), 30_000,);
    }

    #[test]
    fn default_platform_shell_profile_matches_current_os() {
        let profile = default_platform_shell_profile();
        if cfg!(windows) {
            assert_eq!(profile.platform, "windows");
            // 首候选取决于测试机是否装了 Git Bash。
            match profile.profile {
                "windows-git-bash" => assert_eq!(profile.shell_family, "posix"),
                "windows-pwsh" => assert_eq!(profile.shell_family, "powershell"),
                other => panic!("unexpected windows profile: {other}"),
            }
        } else if cfg!(target_os = "macos") {
            assert_eq!(profile.platform, "macos");
            assert_eq!(profile.profile, "posix-zsh");
            assert_eq!(profile.shell_family, "posix");
        } else {
            assert_eq!(profile.platform, "linux");
            assert_eq!(profile.profile, "posix-bash");
            assert_eq!(profile.shell_family, "posix");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_chain_orders_git_bash_before_powershell_fallbacks() {
        let profiles: Vec<&'static str> = super::platform_shell_candidates("echo hi", false)
            .iter()
            .map(|candidate| candidate.profile.profile)
            .collect();
        let tail = ["windows-pwsh", "windows-powershell", "windows-cmd"];
        match profiles.len() {
            4 => {
                assert_eq!(profiles[0], "windows-git-bash");
                assert_eq!(profiles[1..], tail);
            }
            3 => assert_eq!(profiles[..], tail),
            other => panic!("unexpected windows candidate count: {other}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_scan_skips_zero_byte_app_execution_alias() {
        // WindowsApps 的 WSL bash.exe 别名是 0 字节 reparse point；用 0 字节
        // 普通文件模拟“is_file() 为 true 但不是真 bash”的形态。
        let alias_dir = tempfile::tempdir().expect("alias dir");
        let real_dir = tempfile::tempdir().expect("real dir");
        fs::write(alias_dir.path().join("bash.exe"), b"").unwrap();
        fs::write(real_dir.path().join("bash.exe"), b"MZfake-git-bash").unwrap();

        // 别名目录在前：应跳过 0 字节候选，命中后面的真实文件。
        let path_var =
            std::env::join_paths([alias_dir.path(), real_dir.path()]).expect("join paths");
        assert_eq!(
            super::find_git_bash_on_path(&path_var),
            Some(real_dir.path().join("bash.exe"))
        );

        // 只有别名时不应误选，让候选链回退到 Program Files 探测 / PowerShell。
        let alias_only = std::env::join_paths([alias_dir.path()]).expect("join paths");
        assert_eq!(super::find_git_bash_on_path(&alias_only), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_known_wsl_alias_dirs_are_rejected() {
        // 即使 WindowsApps 目录下出现非 0 字节的 bash.exe，也不应从该目录选取。
        let local_appdata = std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA");
        let windows_apps = std::path::Path::new(&local_appdata)
            .join("Microsoft")
            .join("WindowsApps");
        assert!(super::is_windows_apps_alias_dir(&windows_apps));
        // 大小写与结尾斜杠不影响判定。
        let with_slash = format!("{}\\", windows_apps.display().to_string().to_uppercase());
        assert!(super::is_windows_apps_alias_dir(std::path::Path::new(
            &with_slash
        )));

        let system_root = std::env::var_os("SystemRoot").expect("SystemRoot");
        for name in ["System32", "Sysnative"] {
            let alias_dir = std::path::Path::new(&system_root).join(name);
            assert!(super::is_windows_system_bash_alias_dir(&alias_dir));
        }
    }

    #[cfg(windows)]
    #[test]
    fn find_git_bash_env_override_prefers_liveagent_var() {
        // 单个测试函数串行覆盖所有 env 场景，避免并行 env 竞态。
        let dir = tempfile::tempdir().expect("tempdir");
        let liveagent_bash = dir.path().join("liveagent-bash.exe");
        let claude_bash = dir.path().join("claude-bash.exe");
        let app_execution_alias = dir.path().join("wsl-bash.exe");
        fs::write(&liveagent_bash, b"MZliveagent-git-bash").unwrap();
        fs::write(&claude_bash, b"MZclaude-git-bash").unwrap();
        fs::write(&app_execution_alias, b"").unwrap();

        std::env::set_var("LIVEAGENT_GIT_BASH_PATH", &liveagent_bash);
        std::env::set_var("CLAUDE_CODE_GIT_BASH_PATH", &claude_bash);
        assert_eq!(super::find_git_bash(), Some(liveagent_bash.clone()));

        // LIVEAGENT 指向 App-Execution-Alias 时也必须回退 CLAUDE_CODE。
        std::env::set_var("LIVEAGENT_GIT_BASH_PATH", &app_execution_alias);
        assert_eq!(super::find_git_bash(), Some(claude_bash.clone()));

        // LIVEAGENT 指向不存在的文件时回退 CLAUDE_CODE。
        std::env::set_var(
            "LIVEAGENT_GIT_BASH_PATH",
            dir.path().join("missing-bash.exe"),
        );
        assert_eq!(super::find_git_bash(), Some(claude_bash.clone()));

        std::env::remove_var("LIVEAGENT_GIT_BASH_PATH");
        std::env::remove_var("CLAUDE_CODE_GIT_BASH_PATH");
    }

    #[test]
    fn shell_registry_cancel_marks_registered_run() {
        let registry = ShellRunRegistry::default();
        let token = registry.register("run-1");
        assert!(!token.is_cancelled());
        assert!(registry.cancel("run-1"));
        assert!(token.is_cancelled());
        registry.unregister("run-1", &token);
        assert!(!registry.cancel("run-1"));
    }

    #[test]
    fn duplicate_run_id_cancels_old_token_without_losing_new_registration() {
        let registry = ShellRunRegistry::default();
        let first = registry.register("same-run");
        let second = registry.register("same-run");

        assert!(first.is_cancelled());
        registry.unregister("same-run", &first);
        assert!(registry.cancel("same-run"));
        assert!(second.is_cancelled());

        registry.unregister("same-run", &second);
        assert!(!registry.cancel("same-run"));
    }

    #[cfg(unix)]
    #[test]
    fn run_shell_script_can_be_cancelled_before_timeout() {
        let registry = ShellRunRegistry::default();
        let token = registry.register("cancel-test");
        let temp_dir = std::env::temp_dir().join(format!(
            "liveagent-shell-cancel-test-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&temp_dir);

        let worker_token = Arc::clone(&token);
        let workdir = temp_dir.display().to_string();
        let started = Instant::now();
        let handle = std::thread::spawn(move || {
            run_shell_script(
                workdir,
                "sleep 10".to_string(),
                None,
                Some(60_000),
                None,
                None,
                Some(worker_token),
            )
        });

        std::thread::sleep(Duration::from_millis(150));
        assert!(registry.cancel("cancel-test"));
        let result = handle
            .join()
            .expect("shell cancel worker thread should not panic")
            .expect("shell run should return a cancelled response");

        registry.unregister("cancel-test", &token);
        let _ = fs::remove_dir_all(&temp_dir);

        assert!(result.cancelled);
        assert!(!result.timed_out);
        assert!(!result.stdio_open_after_exit);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cancelled shell should return promptly"
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_shell_script_returns_when_background_process_keeps_stdio_open() {
        let temp_dir = std::env::temp_dir().join(format!(
            "liveagent-shell-background-stdio-test-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&temp_dir);

        let started = Instant::now();
        let result = run_shell_script(
            temp_dir.display().to_string(),
            "sleep 15 & background_pid=$!; echo ready:$background_pid".to_string(),
            None,
            Some(60_000),
            None,
            None,
            None,
        )
        .expect("shell run should return a response");
        let elapsed = started.elapsed();
        let background_pid = result
            .stdout
            .lines()
            .find_map(|line| line.strip_prefix("ready:"))
            .expect("shell should report the background process id")
            .trim();
        let _ = std::process::Command::new("kill")
            .arg(background_pid)
            .status();

        let _ = fs::remove_dir_all(&temp_dir);

        assert_eq!(result.exit_code, 0);
        assert!(result.stdio_open_after_exit);
        assert!(result.stdout.contains("ready:"));
        assert!(result.stderr.contains("stdout/stderr remained open"));
        assert!(
            elapsed < Duration::from_secs(10),
            "background stdio leak should not block until the background process exits; elapsed: {elapsed:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_shell_script_accepts_absolute_cwd_outside_workdir() {
        let workdir = std::env::temp_dir().join(format!(
            "liveagent-shell-abs-cwd-workdir-{}",
            std::process::id()
        ));
        let external = std::env::temp_dir().join(format!(
            "liveagent-shell-abs-cwd-external-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&workdir);
        let _ = fs::create_dir_all(&external);
        let external_canonical = fs::canonicalize(&external).expect("canonical external dir");

        let result = run_shell_script(
            workdir.display().to_string(),
            "pwd".to_string(),
            Some(external.display().to_string()),
            Some(30_000),
            None,
            None,
            None,
        )
        .expect("absolute cwd should run");

        assert_eq!(result.exit_code, 0);
        assert!(
            result
                .stdout
                .contains(&external_canonical.display().to_string()),
            "unexpected stdout: {}",
            result.stdout
        );

        let _ = fs::remove_dir_all(&workdir);
        let _ = fs::remove_dir_all(&external);
    }

    #[test]
    fn run_shell_script_rejects_missing_absolute_cwd() {
        let workdir = std::env::temp_dir().join(format!(
            "liveagent-shell-abs-cwd-missing-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&workdir);
        let missing = std::env::temp_dir()
            .join(format!("liveagent-missing-cwd-{}", std::process::id()))
            .join("nope");

        let error = run_shell_script(
            workdir.display().to_string(),
            "echo hi".to_string(),
            Some(missing.display().to_string()),
            Some(30_000),
            None,
            None,
            None,
        )
        .expect_err("missing absolute cwd should fail");

        assert!(
            error.contains("cwd does not exist or is not a directory"),
            "unexpected error: {error}"
        );

        let _ = fs::remove_dir_all(&workdir);
    }
}
