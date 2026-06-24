use serde::Serialize;
use std::collections::HashMap;
#[cfg(windows)]
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};

#[cfg(windows)]
use crate::runtime::platform::resolve_program_path_with_current_dir;
use crate::runtime::platform::{expand_tilde_path, maybe_augment_macos_path, shell_basename};
use crate::runtime::process::{configure_child_process_group, terminate_child_process_tree};

const MAX_STDOUT_BYTES: usize = 400 * 1024; // 400KB
const MAX_STDERR_BYTES: usize = 400 * 1024; // 400KB
pub(crate) const DEFAULT_SHELL_TIMEOUT_MS: u64 = 120_000;
pub(crate) const MIN_SHELL_TIMEOUT_MS: u64 = 1_000;
pub(crate) const MAX_SHELL_TIMEOUT_MS: u64 = 10 * 60_000;
const TERMINATION_GRACE_MS: u64 = 300;
const STREAM_EOF_GRACE_MS: u64 = 300;

pub(crate) type ShellCancelToken = Arc<AtomicBool>;

#[derive(Default)]
pub(crate) struct ShellRunRegistry {
    runs: Mutex<HashMap<String, ShellCancelToken>>,
}

impl ShellRunRegistry {
    pub(crate) fn register(&self, run_id: &str) -> ShellCancelToken {
        let token = Arc::new(AtomicBool::new(false));
        self.runs
            .lock()
            .expect("shell run registry poisoned")
            .insert(run_id.to_string(), Arc::clone(&token));
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
        token.store(true, Ordering::SeqCst);
        true
    }

    pub(crate) fn unregister(&self, run_id: &str) {
        self.runs
            .lock()
            .expect("shell run registry poisoned")
            .remove(run_id);
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

    Ok(fs::canonicalize(&p)?)
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
    let canon = fs::canonicalize(target)?;
    if !canon.starts_with(workdir) {
        return Err(ShellError::OutOfBounds(canon.display().to_string()));
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
        .map(|token| token.load(Ordering::SeqCst))
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
fn push_existing_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !path.is_file() {
        return;
    }
    let normalized = path.to_string_lossy().to_ascii_lowercase();
    if paths
        .iter()
        .any(|existing| existing.to_string_lossy().to_ascii_lowercase() == normalized)
    {
        return;
    }
    paths.push(path);
}

#[cfg(windows)]
fn push_git_bash_install_root(paths: &mut Vec<PathBuf>, root: PathBuf) {
    let git_root = root.join("Git");
    push_existing_unique_path(paths, git_root.join("bin").join("bash.exe"));
    push_existing_unique_path(paths, git_root.join("usr").join("bin").join("bash.exe"));
}

#[cfg(windows)]
fn normalize_configured_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }
    Some(expand_tilde_path(trimmed))
}

#[cfg(windows)]
fn is_probable_git_bash_path(path: &Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    normalized.ends_with("\\git\\bin\\bash.exe")
        || normalized.ends_with("\\git\\usr\\bin\\bash.exe")
}

#[cfg(windows)]
#[allow(dead_code)]
fn find_windows_git_bash() -> Option<PathBuf> {
    let mut paths = Vec::new();

    for var in ["LIVEAGENT_GIT_BASH_PATH", "CLAUDE_CODE_GIT_BASH_PATH"] {
        if let Some(raw) = env::var_os(var) {
            let raw = raw.to_string_lossy();
            if let Some(path) = normalize_configured_path(&raw) {
                push_existing_unique_path(&mut paths, path);
            }
        }
    }

    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(root) = env::var_os(var) {
            push_git_bash_install_root(&mut paths, PathBuf::from(root));
        }
    }

    for root in [r"C:\Program Files", r"C:\Program Files (x86)"] {
        push_git_bash_install_root(&mut paths, PathBuf::from(root));
    }

    let path_bash = resolve_program_path_with_current_dir("bash", None);
    if is_probable_git_bash_path(&path_bash) {
        push_existing_unique_path(&mut paths, path_bash);
    }

    paths.into_iter().next()
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
        let powershell_command = windows_powershell_command(cmd);
        return vec![
            ShellCandidate {
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
            },
            ShellCandidate {
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
            },
            ShellCandidate {
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
            },
        ];
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
    mut stdio_factory: F,
) -> Result<SpawnedPlatformShell, String>
where
    F: FnMut() -> io::Result<(Stdio, Stdio)>,
{
    let mut errors: Vec<String> = Vec::new();

    for candidate in platform_shell_candidates(command) {
        let (stdout, stderr) =
            stdio_factory().map_err(|err| format!("Failed to prepare shell stdio: {err}"))?;
        let mut c = Command::new(&candidate.program);
        c.args(&candidate.args);
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
    _provider_id: Option<String>,
    cancel_token: Option<ShellCancelToken>,
) -> Result<ShellRunResponse, String> {
    let wd = canonicalize_workdir(&workdir).map_err(|e| e.to_string())?;

    let cmd = command.trim();
    if cmd.is_empty() {
        return Err(ShellError::Other("command cannot be empty".to_string()).to_string());
    }

    let actual_cwd = match cwd {
        None => wd.clone(),
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

    let spawned =
        spawn_platform_shell_command(cmd, &actual_cwd, || Ok((Stdio::piped(), Stdio::piped())))?;
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
            assert_eq!(profile.profile, "windows-pwsh");
            assert_eq!(profile.shell_family, "powershell");
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

    #[test]
    fn shell_registry_cancel_marks_registered_run() {
        let registry = ShellRunRegistry::default();
        let token = registry.register("run-1");
        assert!(!token.load(std::sync::atomic::Ordering::SeqCst));
        assert!(registry.cancel("run-1"));
        assert!(token.load(std::sync::atomic::Ordering::SeqCst));
        registry.unregister("run-1");
        assert!(!registry.cancel("run-1"));
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

        registry.unregister("cancel-test");
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
            "sleep 5 & echo ready".to_string(),
            None,
            Some(60_000),
            None,
            None,
            None,
        )
        .expect("shell run should return a response");

        let _ = fs::remove_dir_all(&temp_dir);

        assert_eq!(result.exit_code, 0);
        assert!(result.stdio_open_after_exit);
        assert!(result.stdout.contains("ready"));
        assert!(result.stderr.contains("stdout/stderr remained open"));
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "background stdio leak should not block until the background process exits"
        );
    }
}
