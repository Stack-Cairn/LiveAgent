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
    p.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn is_windows_system32_dir(dir: &Path) -> bool {
    let Some(root) = std::env::var_os("SystemRoot") else {
        return false;
    };
    normalize_windows_dir_for_compare(dir)
        == normalize_windows_dir_for_compare(&Path::new(&root).join("System32"))
}

#[cfg(windows)]
fn is_windows_apps_alias_dir(dir: &Path) -> bool {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return false;
    };
    normalize_windows_dir_for_compare(dir)
        == normalize_windows_dir_for_compare(
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
fn find_git_bash_on_path(path_var: &std::ffi::OsStr) -> Option<PathBuf> {
    for dir in std::env::split_paths(path_var) {
        // System32 下的 bash.exe 是 WSL 启动器，不是 Git Bash。
        if is_windows_system32_dir(&dir) {
            continue;
        }
        // WindowsApps 下的 bash.exe 是 Store 版 WSL 的 App-Execution-Alias。
        if is_windows_apps_alias_dir(&dir) {
            continue;
        }
        let candidate = dir.join("bash.exe");
        if candidate.is_file() && !is_app_execution_alias(&candidate) {
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
                if path.is_file() {
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
            if candidate.is_file() {
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
}

fn platform_shell_candidates(cmd: &str) -> Vec<ShellCandidate> {
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
    platform_shell_candidates("")
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

pub(crate) fn spawn_platform_shell_command<F>(
    command: &str,
    cwd: &Path,
    envs: &[(String, String)],
    mut stdio_factory: F,
) -> Result<SpawnedPlatformShell, String>
where
    F: FnMut() -> io::Result<(Stdio, Stdio)>,
{
    let mut errors: Vec<String> = Vec::new();
    let system_proxy_envs = crate::services::system_proxy::shell_proxy_envs()?;

    for candidate in platform_shell_candidates(command) {
        let (stdout, stderr) =
            stdio_factory().map_err(|err| format!("Failed to prepare shell stdio: {err}"))?;
        let mut c = Command::new(&candidate.program);
        c.args(&candidate.args);
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
) -> Result<ShellRunResponse, String> {
    let wd = canonicalize_workdir(&workdir).map_err(|e| e.to_string())?;

    let cmd = command.trim();
    if cmd.is_empty() {
        return Err(ShellError::Other("command cannot be empty".to_string()).to_string());
    }

    let actual_cwd = match cwd {
        None => wd.clone(),
        Some(cwd_value) if is_absolute_cwd_input(cwd_value.trim()) => {
            resolve_absolute_cwd(cwd_value.trim()).map_err(|e| e.to_string())?
        }
        Some(cwd_rel) => match sanitize_rel_path_core(&cwd_rel).map_err(|e| e.to_string())? {
            None => wd.clone(),
            Some(rel) => {
                let target = wd.join(rel);
                let target =
                    ensure_within_workdir_existing(&wd, &target).map_err(|e| e.to_string())?;
                let md = fs::metadata(&target).map_err(|e| e.to_string())?;
                if !md.is_dir() {
                    return Err(
                        ShellError::Other("cwd must be a directory".to_string()).to_string()
                    );
                }
                target
            }
        },
    };

    let effective_timeout_ms = normalize_timeout_ms(timeout_ms, max_timeout_ms);
    let timeout = Duration::from_millis(effective_timeout_ms);
    let start = Instant::now();

    let spawned = spawn_platform_shell_command(cmd, &actual_cwd, envs, || {
        Ok((Stdio::piped(), Stdio::piped()))
    })?;
    let mut child = spawned.child;
    let shell_profile = spawned.profile;
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
        default_platform_shell_profile, normalize_timeout_ms, run_shell_script,
        sanitize_rel_path_core, ShellRunRegistry, DEFAULT_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS,
        MIN_SHELL_TIMEOUT_MS,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

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
        let profiles: Vec<&'static str> = super::platform_shell_candidates("echo hi")
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
    fn windows_path_scan_skips_windows_apps_alias_dir() {
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
    }

    #[cfg(windows)]
    #[test]
    fn find_git_bash_env_override_prefers_liveagent_var() {
        // 单个测试函数串行覆盖所有 env 场景，避免并行 env 竞态。
        let dir = tempfile::tempdir().expect("tempdir");
        let liveagent_bash = dir.path().join("liveagent-bash.exe");
        let claude_bash = dir.path().join("claude-bash.exe");
        fs::write(&liveagent_bash, b"").unwrap();
        fs::write(&claude_bash, b"").unwrap();

        std::env::set_var("LIVEAGENT_GIT_BASH_PATH", &liveagent_bash);
        std::env::set_var("CLAUDE_CODE_GIT_BASH_PATH", &claude_bash);
        assert_eq!(super::find_git_bash(), Some(liveagent_bash.clone()));

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
