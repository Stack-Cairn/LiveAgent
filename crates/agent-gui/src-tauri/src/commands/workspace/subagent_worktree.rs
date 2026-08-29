use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::runtime::process::configure_child_process_group;

fn git_command(cwd: &Path) -> Command {
    let mut command = Command::new("git");
    command.current_dir(cwd);
    // worktree 的全部操作（add / remove / status / diff / apply）都是纯本地的，既
    // 不需要网络也不需要凭据。但 git 默认会在需要认证时弹终端提示或调起 Credential
    // Manager 的 GUI，而这些调用跑在 spawn_blocking 里：没有 tty、无人应答，那次
    // 调用就永久挂住 —— 前端 Promise 永不 settle，用户按 Stop 也救不回来（invoke
    // 不接 AbortSignal）。全部显式禁掉，让这类情况立刻失败而不是悬停。
    // GIT_OPTIONAL_LOCKS=0 同理：拿不到 index.lock 时直接跳过而不是等锁。
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "echo")
        .env("SSH_ASKPASS", "echo")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_OPTIONAL_LOCKS", "0");
    configure_child_process_group(&mut command);
    command
}

const DEFAULT_MAX_DIFF_CHARS: usize = 20_000;
const MAX_DIFF_CHARS: usize = 80_000;
const CREATE_WORKTREE_MAX_ATTEMPTS: usize = 8;

/// worktree 目录名的两段预算。sanitize_path_component 通用上限是 80 字符，对
/// worktree 太长：目录名之外还要展开整个仓库的文件，Windows 未开长路径时
/// `MAX_PATH` 只有 260。这里单独收紧，唯一性靠毫秒时间戳 + 随机后缀 + 8 次重试。
const MAX_WORKTREE_LABEL_LEN: usize = 40;
/// `unique_worktree_suffix()` 的长度上界：毫秒时间戳（现 13 位，留到 14）+ 分隔符
/// + 8 位随机 hex。
const WORKTREE_SUFFIX_MAX_LEN: usize = 23;
/// worktree 根目录自身的字符上限，给仓库内相对路径留出余量。超限时 git 只会报
/// 模糊的 "Filename too long"，所以前置拦下并给出可操作提示。
#[cfg(windows)]
const MAX_WORKTREE_ROOT_LEN: usize = 180;

/// 单次 git 调用的硬上限。取值要容得下大仓库的 `worktree add`（检出整个工作树）
/// 与全量 diff，同时短到用户不会以为应用死了。
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeCreateResponse {
    repo_root: String,
    worktree_root: String,
    workdir: String,
    branch_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeStatusResponse {
    changed: bool,
    status: String,
    diff_stat: String,
    diff: String,
    diff_truncated: bool,
    untracked_files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeApplyResponse {
    applied: bool,
    changed: bool,
    status: String,
    patch_bytes: usize,
    skipped_reason: Option<String>,
    apply_method: Option<String>,
    fallback_reason: Option<String>,
    copied_files: Vec<String>,
    deleted_files: Vec<String>,
    conflict_files: Vec<String>,
}

#[derive(Debug)]
struct FileCopyFallbackResult {
    copied_files: Vec<String>,
    deleted_files: Vec<String>,
    conflict_files: Vec<String>,
    already_applied_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeCreateInput {
    pub workdir: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeStatusInput {
    pub worktree_root: String,
    pub max_diff_chars: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeApplyInput {
    pub parent_workdir: String,
    pub worktree_root: String,
    /// 会话检查点上下文:apply 修改父工作区前对受影响路径捕获父侧前像。
    /// 缺省(None)不捕获。worktree 子代理自身的临时工作区不参与检查点,
    /// 只有合并回父工作区这一步才是可回退的真实变更。
    pub checkpoint: Option<super::checkpoint::CheckpointCtx>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeCleanupInput {
    pub worktree_root: String,
    pub branch_name: Option<String>,
    pub dry_run: Option<bool>,
    pub force: Option<bool>,
    pub delete_branch: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeCleanupTarget {
    pub run_id: Option<String>,
    pub worktree_root: String,
    pub branch_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeCleanupItem {
    pub run_id: Option<String>,
    pub worktree_root: String,
    pub branch_name: Option<String>,
    pub removed: bool,
    pub branch_deleted: bool,
    pub skipped_reason: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorktreeCleanupBatchResponse {
    pub cleaned_count: usize,
    pub branch_deleted_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub items: Vec<SubagentWorktreeCleanupItem>,
}

/// 带硬超时的 `Command::output()` 替代。
///
/// 禁掉交互（见 `git_command`）已经消掉了绝大多数悬停，但 git 仍可能因为文件锁、
/// 网络文件系统或防病毒扫描长时间不返回。调用方在 `spawn_blocking` 里，既不可取消
/// 也没有上层超时，所以这里是唯一能兜住的地方：超时即杀进程组并返回可读错误。
///
/// 管道必须在等待期间持续读空：git 的 diff 输出可能远超管道缓冲，只 `try_wait()`
/// 不读会让子进程写阻塞、双方僵死 —— 那正是我们要消除的情况。
fn output_with_timeout(mut command: Command, label: &str) -> Result<Output, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to run git: {err}"))?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(pipe, &mut buffer);
        }
        buffer
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(pipe, &mut buffer);
        }
        buffer
    });

    let deadline = Instant::now() + GIT_COMMAND_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "git {label} timed out after {}s and was terminated",
                        GIT_COMMAND_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(GIT_COMMAND_POLL_INTERVAL);
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to wait for git: {err}"));
            }
        }
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = git_command(cwd);
    command.args(args);
    let output = output_with_timeout(command, &args.join(" "))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(if message.is_empty() {
        format!("git exited with status {}", output.status)
    } else {
        message
    })
}

fn run_git_raw(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = git_command(cwd);
    command.args(args);
    let output = output_with_timeout(command, &args.join(" "))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(if message.is_empty() {
        format!("git exited with status {}", output.status)
    } else {
        message
    })
}

/// `output_with_timeout` 的 stdin 版本：`git apply` 靠标准输入收补丁。
///
/// stdin 也必须在后台线程里写：补丁可能远超管道缓冲，而 git 只有在读完输入后才会
/// 产出输出——主线程同步 `write_all` 会与子进程的写阻塞互锁。写完即关闭 stdin，
/// 否则 git 等 EOF 永远不退出。
fn output_with_timeout_stdin(
    mut command: Command,
    label: &str,
    input: &str,
) -> Result<Output, String> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to run git: {err}"))?;

    let mut stdin_pipe = child.stdin.take();
    let payload = input.to_string();
    let stdin_writer = std::thread::spawn(move || {
        if let Some(mut pipe) = stdin_pipe.take() {
            let _ = pipe.write_all(payload.as_bytes());
            // drop 关闭管道 => git 收到 EOF。
        }
    });

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(pipe, &mut buffer);
        }
        buffer
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(pipe, &mut buffer);
        }
        buffer
    });

    let deadline = Instant::now() + GIT_COMMAND_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "git {label} timed out after {}s and was terminated",
                        GIT_COMMAND_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(GIT_COMMAND_POLL_INTERVAL);
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to wait for git: {err}"));
            }
        }
    };

    let _ = stdin_writer.join();
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn run_git_with_input(cwd: &Path, args: &[&str], input: &str) -> Result<String, String> {
    let mut command = git_command(cwd);
    command.args(args);
    let output = output_with_timeout_stdin(command, &args.join(" "), input)?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(if message.is_empty() {
        format!("git exited with status {}", output.status)
    } else {
        message
    })
}

fn run_git_with_input_output(cwd: &Path, args: &[&str], input: &str) -> Result<String, String> {
    let mut command = git_command(cwd);
    command.args(args);
    let output = output_with_timeout_stdin(command, &args.join(" "), input)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let combined = match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{stdout}\n{stderr}"),
    };

    if output.status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        Err(format!("git exited with status {}", output.status))
    } else {
        Err(combined)
    }
}

fn run_git_owned_bytes(cwd: &Path, args: Vec<String>) -> Result<Vec<u8>, String> {
    let label = args.join(" ");
    let mut command = git_command(cwd);
    command.args(args);
    let output = output_with_timeout(command, &label)?;

    if output.status.success() {
        return Ok(output.stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(if message.is_empty() {
        format!("git exited with status {}", output.status)
    } else {
        message
    })
}

fn run_git_owned(cwd: &Path, args: Vec<String>) -> Result<String, String> {
    let label = args.join(" ");
    let mut command = git_command(cwd);
    command.args(args);
    let output = output_with_timeout(command, &label)?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(if message.is_empty() {
        format!("git exited with status {}", output.status)
    } else {
        message
    })
}

fn canonicalize_git_path(cwd: &Path, raw: &str, label: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    let absolute = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    canonicalize_stripped(&absolute).map_err(|_| {
        format!(
            "{label} must resolve to an existing path: {}",
            display_path(&absolute)
        )
    })
}

fn canonicalize_existing_dir(input: &str, label: &str) -> Result<PathBuf, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(format!("{label} is required"));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("{label} must be an absolute path: {raw}"));
    }
    let canonical = canonicalize_stripped(&path)
        .map_err(|_| format!("{label} must be an existing directory: {raw}"))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|_| format!("{label} must be an existing directory: {raw}"))?;
    if !metadata.is_dir() {
        return Err(format!("{label} must be a directory: {raw}"));
    }
    Ok(canonical)
}

fn sanitize_path_component(input: &str, fallback: &str) -> String {
    let mut out = String::new();
    for ch in input.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    let compact = out
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let trimmed = compact
        .trim_matches(|ch| ch == '-' || ch == '.')
        .to_string();
    let candidate = if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(80).collect()
    };
    avoid_windows_reserved_path_component(candidate)
}

fn is_windows_reserved_path_component(input: &str) -> bool {
    let stem = input
        .split('.')
        .next()
        .unwrap_or(input)
        .trim_matches(|ch| ch == ' ' || ch == '.')
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

fn avoid_windows_reserved_path_component(candidate: String) -> String {
    if !is_windows_reserved_path_component(&candidate) {
        return candidate;
    }
    if let Some(dot_index) = candidate.find('.') {
        return format!(
            "{}-item{}",
            &candidate[..dot_index],
            &candidate[dot_index..]
        );
    }
    format!("{candidate}-item")
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn unique_worktree_suffix() -> String {
    // 只取 uuid 前 8 位 hex：完整 32 位会让目录名多占 24 个字符，而唯一性已由
    // 毫秒时间戳 + 4G 随机空间 + 调用方 8 次碰撞重试三重保证。
    let uuid = Uuid::new_v4().simple().to_string();
    format!("{}-{}", unix_millis(), &uuid[..8])
}

fn is_worktree_name_collision(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("reference already exists")
        || lower.contains("already exists")
        || lower.contains("already checked out")
        || lower.contains("is a missing but already registered worktree")
}

/// Windows 的 `fs::canonicalize` 返回 verbatim 形式（`\\?\C:\…`）。Git for Windows
/// 经 msys2 做路径转换，处理不了这个前缀——既不能作为 `worktree add` 的目标参数，
/// 也不能作为 git 子进程的 cwd。所以必须在拿到 canonical 路径后立刻剥掉，让下游
/// （git 参数、cwd、回传前端的 repoRoot/worktreeRoot/workdir）全是普通形式。
///
/// 同款剥前缀逻辑在 `services/skills/paths.rs::skill_root_display` 已有先例。
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let stripped: Option<String> = path.to_str().and_then(|raw| {
            raw.strip_prefix(r"\\?\UNC\")
                .map(|rest| format!(r"\\{rest}"))
                .or_else(|| raw.strip_prefix(r"\\?\").map(str::to_string))
        });
        if let Some(stripped) = stripped {
            return PathBuf::from(stripped);
        }
    }
    path
}

/// 全模块唯一的 canonicalize 入口。必须统一走这里：worktree 路径既要作为 git 参数，
/// 又要参与路径相等比较（cleanup 时用它排除自身），一旦有的剥了前缀有的没剥，
/// 比较就会永远不相等。
fn canonicalize_stripped(path: &Path) -> std::io::Result<PathBuf> {
    fs::canonicalize(path).map(strip_verbatim_prefix)
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn truncate_chars(input: String, max_chars: usize) -> (String, bool) {
    if input.chars().count() <= max_chars {
        return (input, false);
    }
    let truncated = input.chars().take(max_chars).collect::<String>();
    (format!("{truncated}\n... [truncated]"), true)
}

fn split_nul_paths(raw: &str) -> impl Iterator<Item = &str> {
    raw.split('\0').filter(|path| !path.is_empty())
}

fn validate_git_relative_path(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("empty git path".to_string());
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return Err(format!("git path must be relative: {raw}"));
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(format!("git path contains unsafe component: {raw}")),
        }
    }
    Ok(raw.to_string())
}

fn should_ignore_apply_path(path: &str) -> bool {
    let file_name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    matches!(file_name, ".DS_Store" | "Thumbs.db" | "Desktop.ini")
}

fn collect_apply_paths(worktree_root: &Path) -> Result<Vec<String>, String> {
    let mut paths = BTreeSet::new();
    let tracked_raw = run_git_raw(
        worktree_root,
        &["diff", "--no-renames", "--name-only", "-z", "HEAD", "--"],
    )?;
    let untracked_raw = run_git_raw(
        worktree_root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;

    for raw in split_nul_paths(&tracked_raw).chain(split_nul_paths(&untracked_raw)) {
        if should_ignore_apply_path(raw) {
            continue;
        }
        paths.insert(validate_git_relative_path(raw)?);
    }

    Ok(paths.into_iter().collect())
}

fn collect_worktree_paths(cwd: &Path) -> Result<Vec<PathBuf>, String> {
    let raw = run_git_raw(cwd, &["worktree", "list", "--porcelain"])?;
    let mut paths = Vec::new();
    for line in raw.lines() {
        let Some(path) = line.strip_prefix("worktree ") else {
            continue;
        };
        let path = PathBuf::from(path.trim());
        if path.is_absolute() {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn is_liveagent_subagent_worktree(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name == ".liveagent-subagents",
        _ => false,
    })
}

fn normalize_liveagent_subagent_branch(branch_name: Option<&str>) -> Option<String> {
    let branch = branch_name?.trim();
    if branch.starts_with("liveagent/subagent/") {
        Some(branch.to_string())
    } else {
        None
    }
}

fn collect_nul_git_paths(cwd: &Path, args: &[&str]) -> Result<Vec<String>, String> {
    let raw = run_git_raw(cwd, args)?;
    split_nul_paths(&raw)
        .map(validate_git_relative_path)
        .collect()
}

fn worktree_status_blocking(
    worktree_root: String,
    max_diff_chars: Option<usize>,
) -> Result<SubagentWorktreeStatusResponse, String> {
    let worktree_root = canonicalize_existing_dir(&worktree_root, "worktreeRoot")?;
    let max_diff_chars = max_diff_chars
        .unwrap_or(DEFAULT_MAX_DIFF_CHARS)
        .clamp(1_000, MAX_DIFF_CHARS);

    let status = run_git(
        &worktree_root,
        &[
            "-c",
            "core.quotePath=false",
            "status",
            "--short",
            "--untracked-files=all",
        ],
    )?;
    let diff_stat = run_git_raw(&worktree_root, &["diff", "HEAD", "--stat"])?;
    let diff_raw = run_git_raw(&worktree_root, &["diff", "HEAD", "--"])?;
    let (diff, diff_truncated) = truncate_chars(diff_raw, max_diff_chars);
    let untracked_files = collect_nul_git_paths(
        &worktree_root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    let changed = !status.trim().is_empty();

    Ok(SubagentWorktreeStatusResponse {
        changed,
        status,
        diff_stat,
        diff,
        diff_truncated,
        untracked_files,
    })
}

fn stage_apply_paths(worktree_root: &Path, paths: &[String]) -> Result<(), String> {
    run_git(worktree_root, &["reset", "-q", "HEAD", "--"])?;
    if paths.is_empty() {
        return Ok(());
    }

    let mut args = vec!["add".to_string(), "-A".to_string(), "--".to_string()];
    args.extend(paths.iter().cloned());
    run_git_owned(worktree_root, args)?;
    Ok(())
}

fn head_file_bytes(repo_root: &Path, rel_path: &str) -> Result<Option<Vec<u8>>, String> {
    let head_spec = format!("HEAD:{rel_path}");
    if run_git_owned(
        repo_root,
        vec!["cat-file".to_string(), "-e".to_string(), head_spec.clone()],
    )
    .is_err()
    {
        return Ok(None);
    }
    run_git_owned_bytes(repo_root, vec!["show".to_string(), head_spec]).map(Some)
}

enum FileCopyFallbackOp {
    Copy {
        rel_path: String,
        source: PathBuf,
        target: PathBuf,
    },
    Delete {
        rel_path: String,
        target: PathBuf,
    },
}

fn apply_file_copy_fallback(
    parent_repo_root: &Path,
    worktree_root: &Path,
    paths: &[String],
) -> Result<FileCopyFallbackResult, String> {
    let mut plan: Vec<FileCopyFallbackOp> = Vec::new();
    let mut conflicts = Vec::new();
    let mut already_applied_count = 0;

    for rel_path in paths {
        let rel_path = validate_git_relative_path(rel_path)?;
        let source = worktree_root.join(&rel_path);
        let target = parent_repo_root.join(&rel_path);

        if !source.exists() {
            let head_bytes = head_file_bytes(worktree_root, &rel_path)?;
            let Some(base_bytes) = head_bytes else {
                already_applied_count += 1;
                continue;
            };
            if !target.exists() {
                already_applied_count += 1;
                continue;
            }
            let target_meta = fs::symlink_metadata(&target)
                .map_err(|err| format!("failed to inspect fallback target {rel_path}: {err}"))?;
            if !target_meta.is_file() {
                conflicts.push(format!("{rel_path} (parent target is not a regular file)"));
                continue;
            }
            let target_bytes = fs::read(&target)
                .map_err(|err| format!("failed to read fallback target {rel_path}: {err}"))?;
            if target_bytes == base_bytes {
                plan.push(FileCopyFallbackOp::Delete { rel_path, target });
            } else {
                conflicts.push(format!("{rel_path} (parent file changed since HEAD)"));
            }
            continue;
        }

        let source_meta = fs::symlink_metadata(&source)
            .map_err(|err| format!("failed to inspect fallback source {rel_path}: {err}"))?;
        if !source_meta.is_file() {
            conflicts.push(format!("{rel_path} (non-file fallback is not supported)"));
            continue;
        }

        let source_bytes = fs::read(&source)
            .map_err(|err| format!("failed to read fallback source {rel_path}: {err}"))?;
        let head_bytes = head_file_bytes(worktree_root, &rel_path)?;

        if target.exists() {
            let target_meta = fs::symlink_metadata(&target)
                .map_err(|err| format!("failed to inspect fallback target {rel_path}: {err}"))?;
            if !target_meta.is_file() {
                conflicts.push(format!("{rel_path} (parent target is not a regular file)"));
                continue;
            }
            let target_bytes = fs::read(&target)
                .map_err(|err| format!("failed to read fallback target {rel_path}: {err}"))?;
            if target_bytes == source_bytes {
                already_applied_count += 1;
                continue;
            }
            match head_bytes {
                Some(base_bytes) if target_bytes == base_bytes => {
                    plan.push(FileCopyFallbackOp::Copy {
                        rel_path,
                        source,
                        target,
                    });
                }
                Some(_) => {
                    conflicts.push(format!("{rel_path} (parent file changed since HEAD)"));
                }
                None => {
                    conflicts.push(format!("{rel_path} (parent already has an untracked file)"));
                }
            }
        } else if head_bytes.is_some() {
            conflicts.push(format!(
                "{rel_path} (parent file is missing but exists in HEAD)"
            ));
        } else {
            plan.push(FileCopyFallbackOp::Copy {
                rel_path,
                source,
                target,
            });
        }
    }

    if !conflicts.is_empty() {
        return Err(conflicts.join("\n"));
    }

    let mut copied_files = Vec::new();
    let mut deleted_files = Vec::new();
    for operation in plan {
        match operation {
            FileCopyFallbackOp::Copy {
                rel_path,
                source,
                target,
            } => {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|err| {
                        format!("failed to create fallback target directory: {err}")
                    })?;
                }
                fs::copy(&source, &target)
                    .map_err(|err| format!("failed to copy fallback file {rel_path}: {err}"))?;
                copied_files.push(rel_path);
            }
            FileCopyFallbackOp::Delete { rel_path, target } => {
                fs::remove_file(&target)
                    .map_err(|err| format!("failed to delete fallback file {rel_path}: {err}"))?;
                deleted_files.push(rel_path);
            }
        }
    }

    Ok(FileCopyFallbackResult {
        copied_files,
        deleted_files,
        conflict_files: Vec::new(),
        already_applied_count,
    })
}

fn run_git_apply_with_options(cwd: &Path, patch: &str, options: &[&str]) -> Result<(), String> {
    let mut check_args = vec!["apply", "--check", "--whitespace=nowarn", "--binary"];
    check_args.extend(options.iter().copied());
    let mut apply_args = vec!["apply", "--whitespace=nowarn", "--binary"];
    apply_args.extend(options.iter().copied());
    run_git_with_input(cwd, &check_args, patch)
        .and_then(|_| run_git_with_input(cwd, &apply_args, patch))
        .map(|_| ())
}

fn run_git_apply_3way(cwd: &Path, patch: &str) -> Result<(), String> {
    let check_output = run_git_with_input_output(
        cwd,
        &[
            "apply",
            "--check",
            "--whitespace=nowarn",
            "--binary",
            "--3way",
        ],
        patch,
    )?;
    if check_output.to_ascii_lowercase().contains("with conflicts") {
        return Err(format!(
            "git apply --3way would leave conflicts:\n{check_output}"
        ));
    }
    run_git_with_input(
        cwd,
        &["apply", "--whitespace=nowarn", "--binary", "--3way"],
        patch,
    )
    .map(|_| ())
}

fn apply_worktree_changes_blocking(
    parent_workdir: String,
    worktree_root: String,
    checkpoint: Option<super::checkpoint::CheckpointCtx>,
) -> Result<SubagentWorktreeApplyResponse, String> {
    let parent_workdir = canonicalize_existing_dir(&parent_workdir, "parentWorkdir")?;
    let worktree_root = canonicalize_existing_dir(&worktree_root, "worktreeRoot")?;

    let parent_repo_root_raw = run_git(&parent_workdir, &["rev-parse", "--show-toplevel"])?;
    let parent_repo_root =
        canonicalize_existing_dir(&parent_repo_root_raw, "parent git repo root")?;

    let parent_common_raw = run_git(&parent_workdir, &["rev-parse", "--git-common-dir"])?;
    let worktree_common_raw = run_git(&worktree_root, &["rev-parse", "--git-common-dir"])?;
    let parent_common =
        canonicalize_git_path(&parent_workdir, &parent_common_raw, "parent git common dir")?;
    let worktree_common = canonicalize_git_path(
        &worktree_root,
        &worktree_common_raw,
        "worktree git common dir",
    )?;
    if parent_common != worktree_common {
        return Err(
            "worktreeRoot does not belong to the same git repository as parentWorkdir".to_string(),
        );
    }

    let status = run_git(&worktree_root, &["status", "--short"])?;
    if status.trim().is_empty() {
        return Ok(SubagentWorktreeApplyResponse {
            applied: false,
            changed: false,
            status,
            patch_bytes: 0,
            skipped_reason: Some("no_changes".to_string()),
            apply_method: None,
            fallback_reason: None,
            copied_files: Vec::new(),
            deleted_files: Vec::new(),
            conflict_files: Vec::new(),
        });
    }

    let apply_paths = collect_apply_paths(&worktree_root)?;
    if apply_paths.is_empty() {
        return Ok(SubagentWorktreeApplyResponse {
            applied: false,
            changed: true,
            status,
            patch_bytes: 0,
            skipped_reason: Some("no_applyable_changes".to_string()),
            apply_method: None,
            fallback_reason: None,
            copied_files: Vec::new(),
            deleted_files: Vec::new(),
            conflict_files: Vec::new(),
        });
    }

    stage_apply_paths(&worktree_root, &apply_paths)?;
    let patch = run_git_raw(
        &worktree_root,
        &["diff", "--cached", "--binary", "HEAD", "--"],
    )?;
    let patch_bytes = patch.len();
    if patch.trim().is_empty() {
        return Ok(SubagentWorktreeApplyResponse {
            applied: false,
            changed: true,
            status,
            patch_bytes,
            skipped_reason: Some("empty_patch".to_string()),
            apply_method: None,
            fallback_reason: None,
            copied_files: Vec::new(),
            deleted_files: Vec::new(),
            conflict_files: Vec::new(),
        });
    }

    // 在父仓库被任何 apply 路径(git apply / 3way / 文件拷贝兜底)修改之前,
    // 对受影响路径捕获父工作区前像。捕获记在父仓库根下,rewind 才能恢复
    // 真实工作区,而不是已被清理的 worktree 临时目录。
    //
    // 必须放在 empty_patch 提前返回之后:那条路径下父仓库一个字节都没动,
    // 提前捕获会给未来的回退留下一批 existed_before=false 的记录,回退时
    // 反而把父工作区里本来就存在的文件删掉。
    // 捕获缺口先攒着,不立刻记账:此刻还不知道 apply 会不会真的改动父工作
    // 区。already_applied / fallback_noop 下父仓库一个字节没动,那时把缺口
    // 写成 error 记录,会让一个什么都没发生的轮次在 UI 上标 ⚠"回退可能不
    // 完整"。所以只在确认 apply 生效的分支上落账。
    let capture_skips = super::checkpoint::capture_worktree_apply_pre_images(
        checkpoint.as_ref(),
        &parent_repo_root,
        &apply_paths,
    );
    let record_skips = || {
        super::checkpoint::record_worktree_capture_skips(
            checkpoint.as_ref(),
            &parent_repo_root,
            &capture_skips,
        );
    };

    let direct_apply_result = run_git_apply_with_options(&parent_repo_root, &patch, &[]);

    match direct_apply_result {
        Ok(_) => {
            record_skips();
            Ok(SubagentWorktreeApplyResponse {
                applied: true,
                changed: true,
                status,
                patch_bytes,
                skipped_reason: None,
                apply_method: Some("git_apply".to_string()),
                fallback_reason: None,
                copied_files: Vec::new(),
                deleted_files: Vec::new(),
                conflict_files: Vec::new(),
            })
        }
        Err(apply_error) => {
            let three_way_apply_result = run_git_apply_3way(&parent_repo_root, &patch);
            if three_way_apply_result.is_ok() {
                record_skips();
                return Ok(SubagentWorktreeApplyResponse {
                    applied: true,
                    changed: true,
                    status,
                    patch_bytes,
                    skipped_reason: None,
                    apply_method: Some("git_apply_3way".to_string()),
                    fallback_reason: Some(apply_error),
                    copied_files: Vec::new(),
                    deleted_files: Vec::new(),
                    conflict_files: Vec::new(),
                });
            }
            let three_way_error = three_way_apply_result
                .err()
                .unwrap_or_else(|| "unknown 3-way apply failure".to_string());
            let fallback = apply_file_copy_fallback(
                &parent_repo_root,
                &worktree_root,
                &apply_paths,
            )
            .inspect_err(|_| {
                // 兜底中途失败:已拷/已删的路径是真改过的,缺口必须落账,
                // 否则那一轮会显示成"完整"。
                record_skips();
            })
            .map_err(|fallback_error| {
                format!(
                    "git apply failed: {apply_error}; git apply --3way failed: {three_way_error}; file copy fallback failed:\n{fallback_error}"
                )
            })?;
            let copied_or_deleted =
                !fallback.copied_files.is_empty() || !fallback.deleted_files.is_empty();
            // 只有真改过父工作区才记捕获缺口;already_applied / fallback_noop
            // 什么都没动,记了就是误报。
            if copied_or_deleted {
                record_skips();
            }
            Ok(SubagentWorktreeApplyResponse {
                applied: copied_or_deleted,
                changed: true,
                status,
                patch_bytes,
                skipped_reason: if copied_or_deleted {
                    None
                } else if fallback.already_applied_count > 0 {
                    Some("already_applied".to_string())
                } else {
                    Some("fallback_noop".to_string())
                },
                apply_method: Some("file_copy_fallback".to_string()),
                fallback_reason: Some(format!(
                    "git apply failed: {apply_error}; git apply --3way failed: {three_way_error}"
                )),
                copied_files: fallback.copied_files,
                deleted_files: fallback.deleted_files,
                conflict_files: fallback.conflict_files,
            })
        }
    }
}

fn cleanup_worktree_target_blocking(
    target: SubagentWorktreeCleanupTarget,
    dry_run: bool,
    force: bool,
    delete_branch: bool,
) -> SubagentWorktreeCleanupItem {
    let worktree_root_text = target.worktree_root.trim().to_string();
    let branch_name = target
        .branch_name
        .as_deref()
        .map(str::trim)
        .and_then(|branch| {
            if branch.is_empty() {
                None
            } else {
                Some(branch.to_string())
            }
        });
    let run_id = target.run_id.as_deref().map(str::trim).and_then(|run_id| {
        if run_id.is_empty() {
            None
        } else {
            Some(run_id.to_string())
        }
    });

    let mut item = SubagentWorktreeCleanupItem {
        run_id,
        worktree_root: worktree_root_text.clone(),
        branch_name: branch_name.clone(),
        removed: false,
        branch_deleted: false,
        skipped_reason: None,
        error: None,
    };

    if worktree_root_text.is_empty() {
        item.error = Some("worktreeRoot is required".to_string());
        return item;
    }

    let raw_path = PathBuf::from(&worktree_root_text);
    if !raw_path.is_absolute() {
        item.error = Some(format!(
            "worktreeRoot must be an absolute path: {worktree_root_text}"
        ));
        return item;
    }
    if !raw_path.exists() {
        item.skipped_reason = Some("missing_worktree".to_string());
        return item;
    }

    let worktree_root = match canonicalize_stripped(&raw_path) {
        Ok(path) => path,
        Err(err) => {
            item.error = Some(format!("failed to canonicalize worktreeRoot: {err}"));
            return item;
        }
    };
    if !is_liveagent_subagent_worktree(&worktree_root) {
        item.error = Some(format!(
            "refusing to cleanup non-LiveAgent subagent worktree: {}",
            display_path(&worktree_root)
        ));
        return item;
    }
    if dry_run {
        item.skipped_reason = Some("dry_run".to_string());
        return item;
    }

    let repo_cwd = collect_worktree_paths(&worktree_root)
        .ok()
        .and_then(|paths| {
            paths.into_iter().find(|candidate| {
                // 与 worktree_root 同一套形式才能比较：worktree_root 已剥 verbatim
                // 前缀，这里若用裸 fs::canonicalize 就会因 `\\?\` 差异永远判不等，
                // 把自身也当成「别的 worktree」选进去当 cwd。
                canonicalize_stripped(candidate)
                    .map(|canonical| canonical != worktree_root)
                    .unwrap_or(false)
            })
        });

    let mut remove_args = vec!["worktree".to_string(), "remove".to_string()];
    if force {
        remove_args.push("--force".to_string());
    }
    remove_args.push(display_path(&worktree_root));

    match run_git_owned(&worktree_root, remove_args) {
        Ok(_) => {
            item.removed = true;
        }
        Err(git_error) => {
            if !force {
                item.error = Some(format!("git worktree remove failed: {git_error}"));
                return item;
            }
            if worktree_root.exists() {
                match fs::remove_dir_all(&worktree_root) {
                    Ok(_) => {
                        item.removed = true;
                        item.skipped_reason = Some("git_remove_failed_removed_dir".to_string());
                    }
                    Err(remove_err) => {
                        item.error = Some(format!(
                            "git worktree remove failed: {git_error}; remove_dir_all failed: {remove_err}"
                        ));
                        return item;
                    }
                }
            } else {
                item.removed = true;
            }
        }
    }

    if delete_branch {
        if let Some(branch) = normalize_liveagent_subagent_branch(branch_name.as_deref()) {
            if let Some(repo_cwd) = repo_cwd {
                match run_git_owned(
                    &repo_cwd,
                    vec!["branch".to_string(), "-D".to_string(), branch.clone()],
                ) {
                    Ok(_) => {
                        item.branch_deleted = true;
                    }
                    Err(err) => {
                        let lower = err.to_ascii_lowercase();
                        if lower.contains("not found") {
                            item.skipped_reason
                                .get_or_insert_with(|| "branch_delete_skipped".to_string());
                        } else if lower.contains("checked out") {
                            item.skipped_reason
                                .get_or_insert_with(|| "branch_delete_checked_out".to_string());
                        } else {
                            item.error = Some(format!(
                                "worktree removed, but branch delete failed for {branch}: {err}"
                            ));
                        }
                    }
                }
            } else {
                item.skipped_reason
                    .get_or_insert_with(|| "branch_delete_no_repo_worktree".to_string());
            }
        } else if branch_name.is_some() {
            item.skipped_reason
                .get_or_insert_with(|| "branch_delete_not_liveagent_branch".to_string());
        }
    }

    item
}

pub(crate) fn cleanup_worktree_targets_blocking(
    targets: Vec<SubagentWorktreeCleanupTarget>,
    dry_run: bool,
    force: bool,
    delete_branch: bool,
) -> SubagentWorktreeCleanupBatchResponse {
    let items = targets
        .into_iter()
        .map(|target| cleanup_worktree_target_blocking(target, dry_run, force, delete_branch))
        .collect::<Vec<_>>();
    let cleaned_count = items.iter().filter(|item| item.removed).count();
    let branch_deleted_count = items.iter().filter(|item| item.branch_deleted).count();
    let skipped_count = items
        .iter()
        .filter(|item| item.skipped_reason.is_some() && item.error.is_none())
        .count();
    let failed_count = items.iter().filter(|item| item.error.is_some()).count();
    SubagentWorktreeCleanupBatchResponse {
        cleaned_count,
        branch_deleted_count,
        skipped_count,
        failed_count,
        items,
    }
}

#[tauri::command]
pub async fn subagent_worktree_create(
    input: SubagentWorktreeCreateInput,
) -> Result<SubagentWorktreeCreateResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let SubagentWorktreeCreateInput { workdir, label } = input;
        let requested_workdir = canonicalize_existing_dir(&workdir, "workdir")?;
        let repo_root_raw = run_git(&requested_workdir, &["rev-parse", "--show-toplevel"])?;
        let repo_root = canonicalize_existing_dir(&repo_root_raw, "git repo root")?;
        let relative_workdir = requested_workdir
            .strip_prefix(&repo_root)
            .map_err(|_| "workdir must be inside the git repository root".to_string())?;

        let repo_name = repo_root
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| sanitize_path_component(name, "repo"))
            .unwrap_or_else(|| "repo".to_string());
        let label: String = sanitize_path_component(label.as_deref().unwrap_or("agent"), "agent")
            .chars()
            .take(MAX_WORKTREE_LABEL_LEN)
            .collect();
        let target_parent = repo_root
            .parent()
            .unwrap_or(repo_root.as_path())
            .join(".liveagent-subagents")
            .join(&repo_name);

        // 前置长度检查：只校验 worktree 根目录本身，仓库内的相对路径另有余量。
        // 放在 create_dir_all 之前，避免为一个注定失败的路径建出空目录。
        #[cfg(windows)]
        {
            let projected_len = display_path(&target_parent).chars().count()
                + 1
                + label.chars().count()
                + 1
                + WORKTREE_SUFFIX_MAX_LEN;
            if projected_len > MAX_WORKTREE_ROOT_LEN {
                return Err(format!(
                    "delegated worktree path would be too long ({projected_len} chars, limit {MAX_WORKTREE_ROOT_LEN}): {}. Move the repository closer to the drive root, or enable long paths with `git config --global core.longpaths true`.",
                    display_path(&target_parent)
                ));
            }
        }

        fs::create_dir_all(&target_parent)
            .map_err(|err| format!("failed to create worktree parent: {err}"))?;

        let mut last_error: Option<String> = None;
        let (target, branch_name) = {
            let mut created: Option<(PathBuf, String)> = None;
            for _ in 0..CREATE_WORKTREE_MAX_ATTEMPTS {
                let suffix = unique_worktree_suffix();
                let target = target_parent.join(format!("{label}-{suffix}"));
                let branch_name = format!("liveagent/subagent/{label}-{suffix}");
                match run_git_owned(
                    &repo_root,
                    vec![
                        "worktree".to_string(),
                        "add".to_string(),
                        "-b".to_string(),
                        branch_name.clone(),
                        display_path(&target),
                        "HEAD".to_string(),
                    ],
                ) {
                    Ok(_) => {
                        created = Some((target, branch_name));
                        break;
                    }
                    Err(err) if is_worktree_name_collision(&err) => {
                        last_error = Some(err);
                    }
                    Err(err) => return Err(err),
                }
            }
            created.ok_or_else(|| {
                format!(
                    "failed to create a unique delegated worktree after {CREATE_WORKTREE_MAX_ATTEMPTS} attempts: {}",
                    last_error.unwrap_or_else(|| "unknown git worktree error".to_string())
                )
            })?
        };

        let worktree_root = canonicalize_stripped(&target)
            .map_err(|err| format!("failed to canonicalize worktree: {err}"))?;
        let child_workdir = worktree_root.join(relative_workdir);
        let child_metadata = fs::metadata(&child_workdir).map_err(|_| {
            format!(
                "worktree workdir does not exist: {}",
                display_path(&child_workdir)
            )
        })?;
        if !child_metadata.is_dir() {
            return Err(format!(
                "worktree workdir is not a directory: {}",
                display_path(&child_workdir)
            ));
        }

        Ok(SubagentWorktreeCreateResponse {
            repo_root: display_path(&repo_root),
            worktree_root: display_path(&worktree_root),
            workdir: display_path(&child_workdir),
            branch_name,
        })
    })
    .await
    .map_err(|err| format!("subagent_worktree_create join failed: {err}"))?
}

#[tauri::command]
pub async fn subagent_worktree_status(
    input: SubagentWorktreeStatusInput,
) -> Result<SubagentWorktreeStatusResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        worktree_status_blocking(input.worktree_root, input.max_diff_chars)
    })
    .await
    .map_err(|err| format!("subagent_worktree_status join failed: {err}"))?
}

#[tauri::command]
pub async fn subagent_worktree_apply(
    input: SubagentWorktreeApplyInput,
) -> Result<SubagentWorktreeApplyResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        apply_worktree_changes_blocking(input.parent_workdir, input.worktree_root, input.checkpoint)
    })
    .await
    .map_err(|err| format!("subagent_worktree_apply join failed: {err}"))?
}

#[tauri::command]
pub async fn subagent_worktree_cleanup(
    input: SubagentWorktreeCleanupInput,
) -> Result<SubagentWorktreeCleanupItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        cleanup_worktree_target_blocking(
            SubagentWorktreeCleanupTarget {
                run_id: None,
                worktree_root: input.worktree_root,
                branch_name: input.branch_name,
            },
            input.dry_run.unwrap_or(false),
            input.force.unwrap_or(true),
            input.delete_branch.unwrap_or(true),
        )
    })
    .await
    .map_err(|err| format!("subagent_worktree_cleanup join failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "liveagent-subagent-worktree-{label}-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ))
    }

    fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
        run_git_owned(cwd, args.iter().map(|arg| (*arg).to_string()).collect())
    }

    fn init_repo(root: &Path) -> Result<(), String> {
        fs::create_dir_all(root).map_err(|err| format!("failed to create repo: {err}"))?;
        git(root, &["init"])?;
        git(root, &["config", "core.autocrlf", "false"])?;
        git(
            root,
            &["config", "user.email", "liveagent-test@example.com"],
        )?;
        git(root, &["config", "user.name", "LiveAgent Test"])?;
        fs::write(root.join("README.md"), "base\n")
            .map_err(|err| format!("failed to write README: {err}"))?;
        git(root, &["add", "README.md"])?;
        git(root, &["commit", "-m", "init"])?;
        Ok(())
    }

    #[test]
    fn sanitize_path_component_avoids_windows_reserved_names() {
        assert_eq!(sanitize_path_component("repo name", "repo"), "repo-name");
        assert_eq!(sanitize_path_component("CON", "repo"), "CON-item");
        assert_eq!(sanitize_path_component("aux.txt", "repo"), "aux-item.txt");
        assert_eq!(sanitize_path_component("LPT9", "repo"), "LPT9-item");
        assert_eq!(sanitize_path_component("COM0", "repo"), "COM0");
    }

    fn add_worktree(repo: &Path, worktree: &Path) -> Result<(), String> {
        let branch = format!("liveagent-test-{}", Uuid::new_v4().simple());
        add_worktree_with_branch(repo, worktree, &branch)
    }

    fn add_worktree_with_branch(repo: &Path, worktree: &Path, branch: &str) -> Result<(), String> {
        if let Some(parent) = worktree.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("failed to create worktree parent: {err}"))?;
        }
        run_git_owned(
            repo,
            vec![
                "worktree".to_string(),
                "add".to_string(),
                "-b".to_string(),
                branch.to_string(),
                display_path(worktree),
                "HEAD".to_string(),
            ],
        )?;
        Ok(())
    }

    #[test]
    fn subagent_worktree_apply_preserves_patch_trailing_newline() -> Result<(), String> {
        let root = temp_root("patch-new-file");
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        init_repo(&repo)?;
        add_worktree(&repo, &worktree)?;

        fs::create_dir_all(worktree.join("test"))
            .map_err(|err| format!("failed to create test dir: {err}"))?;
        fs::write(
            worktree.join("test/agent.md"),
            "# Agent CRUD Test\n\n- status: done\n",
        )
        .map_err(|err| format!("failed to write worktree file: {err}"))?;

        let result =
            apply_worktree_changes_blocking(display_path(&repo), display_path(&worktree), None)?;
        assert!(result.applied);
        assert_eq!(result.apply_method.as_deref(), Some("git_apply"));
        assert_eq!(
            fs::read_to_string(repo.join("test/agent.md"))
                .map_err(|err| format!("failed to read parent file: {err}"))?,
            "# Agent CRUD Test\n\n- status: done\n"
        );

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_apply_falls_back_when_file_is_already_present() -> Result<(), String> {
        let root = temp_root("fallback-already-present");
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        init_repo(&repo)?;
        add_worktree(&repo, &worktree)?;

        let content = "# Agent CRUD Test\n\n- status: done\n";
        fs::create_dir_all(worktree.join("test"))
            .map_err(|err| format!("failed to create worktree test dir: {err}"))?;
        fs::write(worktree.join("test/agent.md"), content)
            .map_err(|err| format!("failed to write worktree file: {err}"))?;
        fs::create_dir_all(repo.join("test"))
            .map_err(|err| format!("failed to create parent test dir: {err}"))?;
        fs::write(repo.join("test/agent.md"), content)
            .map_err(|err| format!("failed to write parent file: {err}"))?;

        let result =
            apply_worktree_changes_blocking(display_path(&repo), display_path(&worktree), None)?;
        assert!(!result.applied);
        assert_eq!(result.apply_method.as_deref(), Some("file_copy_fallback"));
        assert_eq!(result.skipped_reason.as_deref(), Some("already_applied"));
        assert!(result.copied_files.is_empty());
        assert!(result
            .fallback_reason
            .as_deref()
            .unwrap_or("")
            .contains("already exists"));

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_apply_applies_deleted_files() -> Result<(), String> {
        let root = temp_root("apply-delete");
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        init_repo(&repo)?;
        fs::write(repo.join("obsolete.md"), "delete me\n")
            .map_err(|err| format!("failed to write tracked file: {err}"))?;
        git(&repo, &["add", "obsolete.md"])?;
        git(&repo, &["commit", "-m", "add obsolete"])?;
        add_worktree(&repo, &worktree)?;

        fs::remove_file(worktree.join("obsolete.md"))
            .map_err(|err| format!("failed to delete worktree file: {err}"))?;

        let result =
            apply_worktree_changes_blocking(display_path(&repo), display_path(&worktree), None)?;
        assert!(result.applied);
        assert!(!repo.join("obsolete.md").exists());

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_apply_applies_renamed_files() -> Result<(), String> {
        let root = temp_root("apply-rename");
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        init_repo(&repo)?;
        fs::create_dir_all(repo.join("docs"))
            .map_err(|err| format!("failed to create docs dir: {err}"))?;
        fs::write(repo.join("docs/old.md"), "rename me\n")
            .map_err(|err| format!("failed to write old file: {err}"))?;
        git(&repo, &["add", "docs/old.md"])?;
        git(&repo, &["commit", "-m", "add old doc"])?;
        add_worktree(&repo, &worktree)?;

        fs::rename(worktree.join("docs/old.md"), worktree.join("docs/new.md"))
            .map_err(|err| format!("failed to rename worktree file: {err}"))?;

        let result =
            apply_worktree_changes_blocking(display_path(&repo), display_path(&worktree), None)?;
        assert!(result.applied);
        assert!(!repo.join("docs/old.md").exists());
        assert_eq!(
            fs::read_to_string(repo.join("docs/new.md"))
                .map_err(|err| format!("failed to read renamed file: {err}"))?,
            "rename me\n"
        );

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_apply_does_not_overwrite_parent_head_after_3way_conflict(
    ) -> Result<(), String> {
        let root = temp_root("apply-3way-conflict");
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        init_repo(&repo)?;
        fs::write(repo.join("file.txt"), "line1\nline2\nline3\n")
            .map_err(|err| format!("failed to write base file: {err}"))?;
        git(&repo, &["add", "file.txt"])?;
        git(&repo, &["commit", "-m", "add file"])?;
        add_worktree(&repo, &worktree)?;

        fs::write(worktree.join("file.txt"), "line1\nagent-line2\nline3\n")
            .map_err(|err| format!("failed to write worktree file: {err}"))?;
        fs::write(repo.join("file.txt"), "parent-line1\nline2\nline3\n")
            .map_err(|err| format!("failed to write parent file: {err}"))?;
        git(&repo, &["add", "file.txt"])?;
        git(&repo, &["commit", "-m", "parent update"])?;

        let error =
            apply_worktree_changes_blocking(display_path(&repo), display_path(&worktree), None)
                .expect_err("conflicting 3-way apply should fail");
        assert!(error.contains("git apply --3way failed"));
        assert_eq!(
            fs::read_to_string(repo.join("file.txt"))
                .map_err(|err| format!("failed to read parent file: {err}"))?,
            "parent-line1\nline2\nline3\n"
        );

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_cleanup_removes_liveagent_worktree_and_branch() -> Result<(), String> {
        let root = temp_root("cleanup-worktree");
        let repo = root.join("repo");
        let worktree = root
            .join(".liveagent-subagents")
            .join("repo")
            .join("agent-a");
        let branch = "liveagent/subagent/test-cleanup";
        init_repo(&repo)?;
        add_worktree_with_branch(&repo, &worktree, branch)?;

        let result = cleanup_worktree_target_blocking(
            SubagentWorktreeCleanupTarget {
                run_id: Some("run-cleanup".to_string()),
                worktree_root: display_path(&worktree),
                branch_name: Some(branch.to_string()),
            },
            false,
            true,
            true,
        );

        assert!(result.error.is_none(), "{:?}", result.error);
        assert!(result.removed);
        assert!(result.branch_deleted);
        assert!(!worktree.exists());
        let branch_list = git(&repo, &["branch", "--list", branch])?;
        assert!(branch_list.trim().is_empty());

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_cleanup_respects_force_false() -> Result<(), String> {
        let root = temp_root("cleanup-worktree-no-force");
        let repo = root.join("repo");
        let worktree = root
            .join(".liveagent-subagents")
            .join("repo")
            .join("agent-dirty");
        let branch = "liveagent/subagent/test-cleanup-no-force";
        init_repo(&repo)?;
        add_worktree_with_branch(&repo, &worktree, branch)?;
        fs::write(worktree.join("README.md"), "dirty\n")
            .map_err(|err| format!("failed to dirty worktree file: {err}"))?;

        let result = cleanup_worktree_target_blocking(
            SubagentWorktreeCleanupTarget {
                run_id: Some("run-cleanup-no-force".to_string()),
                worktree_root: display_path(&worktree),
                branch_name: Some(branch.to_string()),
            },
            false,
            false,
            true,
        );

        assert!(result.error.is_some(), "{result:?}");
        assert!(!result.removed);
        assert!(worktree.exists());

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn subagent_worktree_status_preserves_unicode_untracked_paths() -> Result<(), String> {
        let root = temp_root("unicode-status");
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        init_repo(&repo)?;
        add_worktree(&repo, &worktree)?;

        fs::create_dir_all(worktree.join("docs"))
            .map_err(|err| format!("failed to create docs dir: {err}"))?;
        fs::write(
            worktree.join("docs/可控核聚变的经济可行性分析.md"),
            "# 可控核聚变的经济可行性分析\n",
        )
        .map_err(|err| format!("failed to write unicode file: {err}"))?;

        let result = worktree_status_blocking(display_path(&worktree), Some(20_000))?;
        assert!(result.changed);
        assert!(result.status.contains("docs/可控核聚变的经济可行性分析.md"));
        assert_eq!(
            result.untracked_files,
            vec!["docs/可控核聚变的经济可行性分析.md".to_string()]
        );

        let _ = fs::remove_dir_all(root);
        Ok(())
    }
}
