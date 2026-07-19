use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tempfile::NamedTempFile;
use wait_timeout::ChildExt;

use crate::runtime::process::{configure_child_process_group, kill_child_process_tree_best_effort};

const GIT_DIFF_MAX_BYTES: usize = 512 * 1024;
const GIT_UNTRACKED_FILE_MAX_BYTES: u64 = 128 * 1024;
const GIT_COMMAND_TIMEOUT_SECS: u64 = 60;
const GIT_TRANSIENT_RETRY_ATTEMPTS: usize = 3;
const GIT_TRANSIENT_RETRY_DELAY_MS: u64 = 160;
const GIT_LOG_DEFAULT_LIMIT: usize = 50;
const GIT_LOG_MAX_LIMIT: usize = 1000;
const GIT_MISSING_REMOTE_MESSAGE: &str = "当前仓库还没有设置远端仓库。";
const GIT_MISSING_ORIGIN_REMOTE_MESSAGE: &str = "当前分支没有 upstream，且找不到 origin remote。";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitDirtyCounts {
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub conflicted: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub kind: String,
    pub staged: bool,
    pub conflicted: bool,
    pub untracked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryState {
    pub repo_root: String,
    pub workdir: String,
    pub head: String,
    pub upstream: String,
    pub remote_name: String,
    pub remote_url: String,
    pub ahead: i32,
    pub behind: i32,
    #[serde(default)]
    pub stash_count: i32,
    pub dirty_counts: GitDirtyCounts,
    pub entries: Vec<GitStatusEntry>,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub full_name: String,
    pub kind: String,
    pub current: bool,
    pub upstream: String,
    pub ahead: i32,
    pub behind: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchesResponse {
    pub state: GitRepositoryState,
    pub branches: Vec<GitBranch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResponse {
    pub base_ref: String,
    pub head_ref: String,
    pub mode: String,
    pub files: Vec<String>,
    pub patch: String,
    pub stat: String,
    pub truncated: bool,
    pub binary_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummary {
    pub sha: String,
    pub short_sha: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub files: Vec<GitCommitFile>,
    pub file_count: usize,
    pub local_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogResponse {
    pub state: GitRepositoryState,
    pub commits: Vec<GitCommitSummary>,
    pub history_base_ref: String,
    pub history_remote_ref: String,
    pub history_ahead: i32,
    pub history_behind: i32,
    pub merge_base: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetails {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub files: Vec<GitCommitFile>,
    pub file_count: usize,
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
    pub stat: String,
    pub remote_name: String,
    pub remote_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetailsResponse {
    pub state: GitRepositoryState,
    pub commit: GitCommitDetails,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationResponse {
    pub ok: bool,
    pub state: GitRepositoryState,
    pub stdout: String,
    pub stderr: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GitGatewayArgs {
    branch: Option<String>,
    kind: Option<String>,
    path: Option<String>,
    old_path: Option<String>,
    remote_url: Option<String>,
    message: Option<String>,
    mode: Option<String>,
    commit: Option<String>,
    start_point: Option<String>,
    limit: Option<usize>,
    skip: Option<usize>,
    user_name: Option<String>,
    user_email: Option<String>,
    force: Option<bool>,
    new_branch: Option<String>,
}

struct GitOutput {
    stdout: String,
    stderr: String,
}

fn trim_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn read_temp_file(file: &mut NamedTempFile, label: &str) -> Result<Vec<u8>, String> {
    let handle = file.as_file_mut();
    handle
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("读取 git {label} 失败：{error}"))?;
    let mut bytes = Vec::new();
    handle
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取 git {label} 失败：{error}"))?;
    Ok(bytes)
}

fn git_output(workdir: &str, args: &[&str]) -> Result<Output, String> {
    let mut stdout_file =
        NamedTempFile::new().map_err(|error| format!("创建 git stdout 缓存失败：{error}"))?;
    let mut stderr_file =
        NamedTempFile::new().map_err(|error| format!("创建 git stderr 缓存失败：{error}"))?;
    let stdout_target = stdout_file
        .reopen()
        .map_err(|error| format!("打开 git stdout 缓存失败：{error}"))?;
    let stderr_target = stderr_file
        .reopen()
        .map_err(|error| format!("打开 git stderr 缓存失败：{error}"))?;
    let mut command = Command::new("git");
    configure_child_process_group(&mut command);
    let mut child = command
        .args(args)
        .current_dir(workdir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Pin the message locale: callers (transient-lock retry, the
        // not-fully-merged delete escalation in the UI) match English text.
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_target))
        .stderr(Stdio::from(stderr_target))
        .spawn()
        .map_err(|error| format!("git 执行失败：{error}"))?;
    let timeout = Duration::from_secs(GIT_COMMAND_TIMEOUT_SECS);
    let Some(status) = child
        .wait_timeout(timeout)
        .map_err(|error| format!("等待 git 命令失败：{error}"))?
    else {
        kill_child_process_tree_best_effort(&mut child);
        return Err(format!(
            "git 命令超时（{GIT_COMMAND_TIMEOUT_SECS} 秒）：git {}",
            args.join(" ")
        ));
    };
    Ok(Output {
        status,
        stdout: read_temp_file(&mut stdout_file, "stdout")?,
        stderr: read_temp_file(&mut stderr_file, "stderr")?,
    })
}

fn git_success(workdir: &str, args: &[&str]) -> Result<GitOutput, String> {
    let mut last_error = String::new();
    for attempt in 0..GIT_TRANSIENT_RETRY_ATTEMPTS {
        let output = git_output(workdir, args)?;
        let stdout = trim_output(&output.stdout);
        let stderr = trim_output(&output.stderr);
        if output.status.success() {
            return Ok(GitOutput { stdout, stderr });
        }
        let message = if stderr.is_empty() { stdout } else { stderr };
        if attempt + 1 < GIT_TRANSIENT_RETRY_ATTEMPTS && is_transient_git_lock_error(&message) {
            last_error = message;
            std::thread::sleep(Duration::from_millis(GIT_TRANSIENT_RETRY_DELAY_MS));
            continue;
        }
        return Err(message);
    }
    Err(last_error)
}

fn is_transient_git_lock_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("another git process")
        || lower.contains("index.lock")
        || lower.contains("cannot lock ref")
        || lower.contains("could not lock")
        || (lower.contains("unable to create") && lower.contains(".lock"))
        || lower.contains("failed to lock")
}

fn discover_repo(workdir: &str) -> Result<Option<String>, String> {
    let trimmed = workdir.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let output = git_output(
        trimmed,
        &[
            "rev-parse",
            "--show-toplevel",
            "--git-dir",
            "--is-inside-work-tree",
        ],
    )?;
    if !output.status.success() {
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();
    let root = lines.next().unwrap_or("").trim().to_string();
    let _git_dir = lines.next().unwrap_or("").trim();
    let inside = lines.next().unwrap_or("").trim();
    if root.is_empty() || inside != "true" {
        return Ok(None);
    }
    Ok(Some(root))
}

fn not_repo_state(workdir: &str) -> GitRepositoryState {
    GitRepositoryState {
        repo_root: String::new(),
        workdir: workdir.trim().to_string(),
        head: String::new(),
        upstream: String::new(),
        remote_name: String::new(),
        remote_url: String::new(),
        ahead: 0,
        behind: 0,
        stash_count: 0,
        dirty_counts: GitDirtyCounts::default(),
        entries: Vec::new(),
        status: "not_repo".to_string(),
        error: None,
    }
}

fn parse_branch_ab(value: &str) -> (i32, i32) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in value.split_whitespace() {
        if let Some(raw) = part.strip_prefix('+') {
            ahead = raw.parse::<i32>().unwrap_or(0);
        } else if let Some(raw) = part.strip_prefix('-') {
            behind = raw.parse::<i32>().unwrap_or(0);
        }
    }
    (ahead, behind)
}

fn status_entry(
    path: String,
    old_path: Option<String>,
    index: char,
    worktree: char,
    kind: &str,
) -> GitStatusEntry {
    let conflicted = kind == "conflict" || index == 'U' || worktree == 'U';
    let untracked = kind == "untracked";
    let staged = !untracked && !conflicted && index != '.';
    GitStatusEntry {
        path,
        old_path,
        index_status: index.to_string(),
        worktree_status: worktree.to_string(),
        kind: kind.to_string(),
        staged,
        conflicted,
        untracked,
    }
}

fn parse_status_porcelain_v2(raw: &[u8]) -> (String, String, i32, i32, i32, Vec<GitStatusEntry>) {
    let mut head = String::new();
    let mut upstream = String::new();
    let mut ahead = 0;
    let mut behind = 0;
    let mut stash_count = 0;
    let mut entries = Vec::new();
    let records: Vec<String> = raw
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).to_string())
        .collect();
    let mut index = 0;
    while index < records.len() {
        let record = records[index].trim_end_matches('\n');
        if let Some(value) = record.strip_prefix("# branch.head ") {
            head = value.trim().to_string();
        } else if let Some(value) = record.strip_prefix("# branch.upstream ") {
            upstream = value.trim().to_string();
        } else if let Some(value) = record.strip_prefix("# branch.ab ") {
            (ahead, behind) = parse_branch_ab(value);
        } else if let Some(value) = record.strip_prefix("# stash ") {
            stash_count = value.trim().parse::<i32>().unwrap_or(0);
        } else if let Some(rest) = record.strip_prefix("1 ") {
            let fields: Vec<&str> = rest.splitn(8, ' ').collect();
            if fields.len() >= 8 {
                let xy = fields[0];
                let mut chars = xy.chars();
                let ix = chars.next().unwrap_or('.');
                let wt = chars.next().unwrap_or('.');
                entries.push(status_entry(
                    fields[7].to_string(),
                    None,
                    ix,
                    wt,
                    "modified",
                ));
            }
        } else if let Some(rest) = record.strip_prefix("2 ") {
            let fields: Vec<&str> = rest.splitn(9, ' ').collect();
            if fields.len() >= 9 {
                let xy = fields[0];
                let mut chars = xy.chars();
                let ix = chars.next().unwrap_or('.');
                let wt = chars.next().unwrap_or('.');
                let old_path = records.get(index + 1).cloned();
                if old_path.is_some() {
                    index += 1;
                }
                entries.push(status_entry(
                    fields[8].to_string(),
                    old_path,
                    ix,
                    wt,
                    "renamed",
                ));
            }
        } else if let Some(rest) = record.strip_prefix("u ") {
            let fields: Vec<&str> = rest.splitn(10, ' ').collect();
            if fields.len() >= 10 {
                let xy = fields[0];
                let mut chars = xy.chars();
                let ix = chars.next().unwrap_or('U');
                let wt = chars.next().unwrap_or('U');
                entries.push(status_entry(
                    fields[9].to_string(),
                    None,
                    ix,
                    wt,
                    "conflict",
                ));
            }
        } else if let Some(path) = record.strip_prefix("? ") {
            entries.push(status_entry(path.to_string(), None, '?', '?', "untracked"));
        }
        index += 1;
    }
    (head, upstream, ahead, behind, stash_count, entries)
}

fn dirty_counts(entries: &[GitStatusEntry]) -> GitDirtyCounts {
    let mut counts = GitDirtyCounts::default();
    for entry in entries {
        if entry.conflicted {
            counts.conflicted += 1;
        } else if entry.untracked {
            counts.untracked += 1;
        } else {
            if entry.index_status != "." {
                counts.staged += 1;
            }
            if entry.worktree_status != "." {
                counts.unstaged += 1;
            }
        }
    }
    counts
}

pub(crate) fn git_status_sync(workdir: String) -> Result<GitRepositoryState, String> {
    let workdir = workdir.trim().to_string();
    let Some(repo_root) = discover_repo(&workdir)? else {
        return Ok(not_repo_state(&workdir));
    };
    let output = git_output(
        &repo_root,
        &["status", "--porcelain=v2", "--branch", "--show-stash", "-z"],
    )?;
    if !output.status.success() {
        return Ok(GitRepositoryState {
            repo_root,
            workdir,
            head: String::new(),
            upstream: String::new(),
            remote_name: String::new(),
            remote_url: String::new(),
            ahead: 0,
            behind: 0,
            stash_count: 0,
            dirty_counts: GitDirtyCounts::default(),
            entries: Vec::new(),
            status: "error".to_string(),
            error: Some(trim_output(&output.stderr)),
        });
    }
    let (head, upstream, ahead, behind, stash_count, entries) =
        parse_status_porcelain_v2(&output.stdout);
    let (remote_name, remote_url) = resolve_state_remote(&repo_root, &upstream);
    Ok(GitRepositoryState {
        repo_root,
        workdir,
        head,
        upstream,
        remote_name,
        remote_url,
        ahead,
        behind,
        stash_count,
        dirty_counts: dirty_counts(&entries),
        entries,
        status: "ready".to_string(),
        error: None,
    })
}

fn branch_name_from_remote(remote_short: &str) -> String {
    remote_short
        .split_once('/')
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| remote_short.to_string())
}

fn remote_ref_to_local_branch(remote: &str) -> String {
    let short = remote
        .trim()
        .strip_prefix("refs/remotes/")
        .unwrap_or_else(|| remote.trim());
    branch_name_from_remote(short)
}

pub(crate) fn git_branches_sync(workdir: String) -> Result<GitBranchesResponse, String> {
    let state = git_status_sync(workdir)?;
    if state.status != "ready" {
        return Ok(GitBranchesResponse {
            state,
            branches: Vec::new(),
        });
    }
    let output = git_success(
        &state.repo_root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(upstream:short)%00%(HEAD)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut branches = Vec::new();
    for line in output.stdout.lines() {
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 4 {
            continue;
        }
        let full_name = parts[0].trim();
        let short = parts[1].trim();
        if full_name.is_empty() || short.is_empty() || short.ends_with("/HEAD") {
            continue;
        }
        let kind = if full_name.starts_with("refs/remotes/") {
            "remote"
        } else {
            "local"
        };
        let name = if kind == "remote" {
            branch_name_from_remote(short)
        } else {
            short.to_string()
        };
        let current = parts[3].trim() == "*" || (kind == "local" && short == state.head);
        branches.push(GitBranch {
            name,
            full_name: short.to_string(),
            kind: kind.to_string(),
            current,
            upstream: parts[2].trim().to_string(),
            ahead: if current { state.ahead } else { 0 },
            behind: if current { state.behind } else { 0 },
        });
    }
    if !state.head.trim().is_empty()
        && state.head != "(detached)"
        && !branches
            .iter()
            .any(|branch| branch.kind == "local" && branch.full_name == state.head)
    {
        branches.push(GitBranch {
            name: state.head.clone(),
            full_name: state.head.clone(),
            kind: "local".to_string(),
            current: true,
            upstream: state.upstream.clone(),
            ahead: state.ahead,
            behind: state.behind,
        });
    }
    branches.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.full_name.cmp(&right.full_name))
    });
    Ok(GitBranchesResponse { state, branches })
}

fn ensure_ready_state(workdir: &str) -> Result<GitRepositoryState, String> {
    let state = git_status_sync(workdir.to_string())?;
    if state.status == "ready" {
        Ok(state)
    } else {
        Err(state
            .error
            .unwrap_or_else(|| "当前项目不是 Git 仓库。".to_string()))
    }
}

#[cfg(any(windows, test))]
fn looks_like_windows_drive_path(path: &str) -> bool {
    path.as_bytes().get(1).is_some_and(|byte| *byte == b':')
        && path
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphabetic())
}

fn validate_repo_relative_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err("Git 文件路径不能为空。".to_string());
    }
    #[cfg(windows)]
    {
        if looks_like_windows_drive_path(&trimmed) || trimmed.starts_with("//") {
            return Err("Git 文件路径不能是绝对路径。".to_string());
        }
    }
    let path = Path::new(&trimmed);
    if path.is_absolute() {
        return Err("Git 文件路径不能是绝对路径。".to_string());
    }
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err("Git 文件路径不能包含 .. 或根路径。".to_string());
        }
    }
    Ok(trimmed)
}

fn nearest_existing_location_for_system_file_manager(target: &Path, repo_root: &Path) -> PathBuf {
    if target.exists() {
        return target.to_path_buf();
    }
    let mut current = target
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| repo_root.to_path_buf());
    while !current.exists() {
        if !current.pop() {
            return repo_root.to_path_buf();
        }
    }
    current
}

fn spawn_system_file_manager(program: &str, args: &[String]) -> Result<(), String> {
    let mut command = Command::new(program);
    configure_child_process_group(&mut command);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("打开系统资源管理器失败：{error}"))?;
    Ok(())
}

fn open_system_file_location(target: &Path, repo_root: &Path) -> Result<(), String> {
    let location = nearest_existing_location_for_system_file_manager(target, repo_root);
    #[cfg(target_os = "windows")]
    {
        if target.exists() {
            spawn_system_file_manager("explorer.exe", &[format!("/select,{}", target.display())])
        } else {
            spawn_system_file_manager("explorer.exe", &[location.display().to_string()])
        }
    }
    #[cfg(target_os = "macos")]
    {
        if target.exists() {
            spawn_system_file_manager("open", &["-R".to_string(), target.display().to_string()])
        } else {
            spawn_system_file_manager("open", &[location.display().to_string()])
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let directory = if location.is_dir() {
            location
        } else {
            location
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| repo_root.to_path_buf())
        };
        spawn_system_file_manager("xdg-open", &[directory.display().to_string()])
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = target;
        let _ = repo_root;
        Err("当前系统不支持打开系统资源管理器。".to_string())
    }
}

fn validate_branch_name(repo_root: &str, branch: &str) -> Result<String, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("分支名不能为空。".to_string());
    }
    if branch.chars().any(char::is_whitespace) {
        return Err("分支名不能包含空白字符。".to_string());
    }
    git_success(repo_root, &["check-ref-format", "--branch", branch])?;
    Ok(branch.to_string())
}

fn validate_git_init_workdir(workdir: &str) -> Result<String, String> {
    let workdir = workdir.trim();
    if workdir.is_empty() {
        return Err("初始化目录不能为空。".to_string());
    }
    let metadata = fs::metadata(workdir).map_err(|error| format!("初始化目录不可访问：{error}"))?;
    if !metadata.is_dir() {
        return Err("初始化目录必须是文件夹。".to_string());
    }
    Ok(workdir.to_string())
}

fn validate_git_config_value(label: &str, value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().any(|ch| matches!(ch, '\0' | '\n' | '\r')) {
        return Err(format!("{label} 不能包含换行或空字符。"));
    }
    Ok(Some(value.to_string()))
}

fn validate_git_remote_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("远端仓库地址不能为空。".to_string());
    }
    if value.chars().any(|ch| matches!(ch, '\0' | '\n' | '\r')) {
        return Err("远端仓库地址不能包含换行或空字符。".to_string());
    }
    Ok(value.to_string())
}

fn git_remote_names(repo_root: &str) -> Result<Vec<String>, String> {
    let output = git_success(repo_root, &["remote"])?;
    Ok(output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|remote| !remote.is_empty())
        .map(ToString::to_string)
        .collect())
}

fn git_origin_remote_exists(repo_root: &str) -> bool {
    git_success(repo_root, &["remote", "get-url", "origin"]).is_ok()
}

fn git_remote_url(repo_root: &str, remote: &str) -> Option<String> {
    git_success(repo_root, &["remote", "get-url", remote])
        .ok()
        .map(|output| output.stdout.trim().to_string())
        .filter(|url| !url.is_empty())
}

fn resolve_state_remote(repo_root: &str, upstream: &str) -> (String, String) {
    let upstream_remote = upstream
        .split_once('/')
        .map(|(remote, _)| remote.trim())
        .filter(|remote| !remote.is_empty());
    if let Some(remote) = upstream_remote {
        if let Some(url) = git_remote_url(repo_root, remote) {
            return (remote.to_string(), url);
        }
    }
    if let Some(url) = git_remote_url(repo_root, "origin") {
        return ("origin".to_string(), url);
    }
    if let Ok(remotes) = git_remote_names(repo_root) {
        for remote in remotes {
            if let Some(url) = git_remote_url(repo_root, &remote) {
                return (remote, url);
            }
        }
    }
    (String::new(), String::new())
}

fn append_output(target: &mut String, value: &str) {
    if value.trim().is_empty() {
        return;
    }
    if !target.is_empty() {
        target.push('\n');
    }
    target.push_str(value);
}

fn empty_git_output() -> GitOutput {
    GitOutput {
        stdout: String::new(),
        stderr: String::new(),
    }
}

fn merge_git_outputs(outputs: impl IntoIterator<Item = GitOutput>) -> GitOutput {
    let mut stdout_parts = Vec::new();
    let mut stderr_parts = Vec::new();
    for output in outputs {
        if !output.stdout.trim().is_empty() {
            stdout_parts.push(output.stdout);
        }
        if !output.stderr.trim().is_empty() {
            stderr_parts.push(output.stderr);
        }
    }
    GitOutput {
        stdout: stdout_parts.join("\n"),
        stderr: stderr_parts.join("\n"),
    }
}

fn build_untracked_file_patch(repo_root: &str, path: &str) -> Result<Option<String>, String> {
    let clean_path = validate_repo_relative_path(path)?;
    let repo_root_path =
        fs::canonicalize(repo_root).map_err(|error| format!("Git 仓库路径不可访问：{error}"))?;
    let absolute_path = fs::canonicalize(Path::new(repo_root).join(&clean_path))
        .map_err(|error| format!("无法读取未跟踪文件 {clean_path}：{error}"))?;
    if !absolute_path.starts_with(&repo_root_path) {
        return Err("Git 文件路径必须位于当前仓库内。".to_string());
    }
    let metadata = fs::metadata(&absolute_path)
        .map_err(|error| format!("无法读取未跟踪文件 {clean_path}：{error}"))?;
    if !metadata.is_file() || metadata.len() > GIT_UNTRACKED_FILE_MAX_BYTES {
        return Ok(None);
    }
    let bytes = fs::read(&absolute_path)
        .map_err(|error| format!("无法读取未跟踪文件 {clean_path}：{error}"))?;
    if bytes.contains(&0) {
        return Ok(None);
    }
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(_) => return Ok(None),
    };
    let added_line_count = if content.is_empty() {
        0
    } else {
        content.lines().count().max(1)
    };
    let mut patch = format!(
        "diff --git a/{clean_path} b/{clean_path}\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/{clean_path}\n@@ -0,0 +1,{added_line_count} @@\n"
    );
    if content.is_empty() {
        return Ok(Some(patch));
    }
    for line in content.split_inclusive('\n') {
        let line = line.trim_end_matches('\n');
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    if !content.ends_with('\n') {
        patch.push_str("\\ No newline at end of file\n");
    }
    Ok(Some(patch))
}

fn append_untracked_file_patches(
    repo_root: &str,
    entries: &[GitStatusEntry],
    path_filter: Option<&str>,
    patch: &mut String,
    binary_files: &mut Vec<String>,
) -> Result<(), String> {
    for entry in entries.iter().filter(|entry| entry.untracked) {
        if path_filter.is_some_and(|path| path != entry.path) {
            continue;
        }
        match build_untracked_file_patch(repo_root, &entry.path)? {
            Some(untracked_patch) => {
                if !patch.trim().is_empty() {
                    patch.push('\n');
                }
                patch.push_str(&untracked_patch);
            }
            None => binary_files.push(entry.path.clone()),
        }
    }
    Ok(())
}

fn append_initial_worktree_file_patches(
    repo_root: &str,
    entries: &[GitStatusEntry],
    path_filter: Option<&str>,
    patch: &mut String,
    binary_files: &mut Vec<String>,
) -> Result<(), String> {
    for entry in entries {
        if path_filter.is_some_and(|path| path != entry.path) {
            continue;
        }
        let clean_path = validate_repo_relative_path(&entry.path)?;
        if !Path::new(repo_root).join(&clean_path).exists() {
            continue;
        }
        match build_untracked_file_patch(repo_root, &clean_path)? {
            Some(initial_patch) => {
                if !patch.trim().is_empty() {
                    patch.push('\n');
                }
                patch.push_str(&initial_patch);
            }
            None => binary_files.push(clean_path),
        }
    }
    Ok(())
}

fn operation_response(
    workdir: &str,
    result: Result<GitOutput, String>,
    success_message: &str,
) -> Result<GitOperationResponse, String> {
    let state = git_status_sync(workdir.to_string())?;
    match result {
        Ok(output) => Ok(GitOperationResponse {
            ok: true,
            state,
            stdout: output.stdout,
            stderr: output.stderr,
            message: success_message.to_string(),
        }),
        Err(error) => Ok(GitOperationResponse {
            ok: false,
            state,
            stdout: String::new(),
            stderr: error.clone(),
            message: error,
        }),
    }
}

pub(crate) fn git_switch_branch_sync(
    workdir: String,
    branch: String,
    kind: Option<String>,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let branch = validate_branch_name(&state.repo_root, &branch)?;
    let is_remote = kind.as_deref() == Some("remote") || branch.starts_with("origin/");
    let local_branch = if is_remote {
        let candidate = remote_ref_to_local_branch(&branch);
        if ref_exists(&state.repo_root, &format!("refs/heads/{candidate}")) {
            Some(candidate)
        } else {
            None
        }
    } else {
        None
    };
    let args = if let Some(local_branch) = local_branch.as_deref() {
        vec!["switch", local_branch]
    } else if is_remote {
        vec!["switch", "--track", branch.as_str()]
    } else {
        vec!["switch", branch.as_str()]
    };
    operation_response(
        &workdir,
        git_success(&state.repo_root, &args),
        "分支已切换。",
    )
}

pub(crate) fn git_create_branch_sync(
    workdir: String,
    branch: String,
    start_point: Option<String>,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let branch = validate_branch_name(&state.repo_root, &branch)?;
    let validated_start_point = start_point
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| validate_start_point(&state.repo_root, value))
        .transpose()?;
    let mut args = vec!["switch", "-c", branch.as_str()];
    if let Some(start_point) = validated_start_point.as_deref() {
        args.push(start_point);
    }
    operation_response(
        &workdir,
        git_success(&state.repo_root, &args),
        "分支已创建并检出。",
    )
}

pub(crate) fn git_init_sync(
    workdir: String,
    branch: String,
    user_name: Option<String>,
    user_email: Option<String>,
) -> Result<GitOperationResponse, String> {
    let workdir = validate_git_init_workdir(&workdir)?;
    let existing_state = git_status_sync(workdir.clone())?;
    if existing_state.status == "ready" {
        return Err("当前目录已位于 Git 仓库内。".to_string());
    }

    let branch = {
        let branch = branch.trim();
        if branch.is_empty() {
            "main".to_string()
        } else {
            branch.to_string()
        }
    };
    if branch.chars().any(char::is_whitespace) {
        return Err("分支名不能包含空白字符。".to_string());
    }
    git_success(&workdir, &["check-ref-format", "--branch", branch.as_str()])?;

    let user_name = validate_git_config_value("Git user.name", user_name)?;
    let user_email = validate_git_config_value("Git user.email", user_email)?;
    let init_output = match git_success(&workdir, &["init", "-b", branch.as_str()]) {
        Ok(output) => output,
        Err(error) => {
            return operation_response(&workdir, Err(error), "Git 仓库已初始化。");
        }
    };

    let mut stdout = init_output.stdout;
    let mut stderr = init_output.stderr;
    if let Some(user_name) = user_name {
        match git_success(&workdir, &["config", "user.name", user_name.as_str()]) {
            Ok(output) => {
                append_output(&mut stdout, &output.stdout);
                append_output(&mut stderr, &output.stderr);
            }
            Err(error) => {
                let state = git_status_sync(workdir.clone())?;
                return Ok(GitOperationResponse {
                    ok: false,
                    state,
                    stdout,
                    stderr: error.clone(),
                    message: error,
                });
            }
        }
    }
    if let Some(user_email) = user_email {
        match git_success(&workdir, &["config", "user.email", user_email.as_str()]) {
            Ok(output) => {
                append_output(&mut stdout, &output.stdout);
                append_output(&mut stderr, &output.stderr);
            }
            Err(error) => {
                let state = git_status_sync(workdir.clone())?;
                return Ok(GitOperationResponse {
                    ok: false,
                    state,
                    stdout,
                    stderr: error.clone(),
                    message: error,
                });
            }
        }
    }

    Ok(GitOperationResponse {
        ok: true,
        state: git_status_sync(workdir)?,
        stdout,
        stderr,
        message: "Git 仓库已初始化。".to_string(),
    })
}

fn ref_exists(repo_root: &str, reference: &str) -> bool {
    git_output(repo_root, &["rev-parse", "--verify", "--quiet", reference])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn resolve_review_base(state: &GitRepositoryState) -> String {
    if !state.upstream.trim().is_empty() {
        return state.upstream.clone();
    }
    for candidate in [
        "origin/main",
        "origin/master",
        "origin/develop",
        "main",
        "master",
        "develop",
    ] {
        if ref_exists(&state.repo_root, candidate) {
            return candidate.to_string();
        }
    }
    String::new()
}

fn resolve_cloud_tracking_ref(state: &GitRepositoryState) -> String {
    if !state.upstream.trim().is_empty() {
        return state.upstream.clone();
    }
    if !state.head.trim().is_empty() && state.head != "(detached)" {
        let same_name_remote = format!("origin/{}", state.head);
        if ref_exists(&state.repo_root, &same_name_remote) {
            return same_name_remote;
        }
    }
    for candidate in ["origin/main", "origin/master", "origin/develop"] {
        if ref_exists(&state.repo_root, candidate) {
            return candidate.to_string();
        }
    }
    String::new()
}

fn split_stat_and_patch(output: &str) -> (String, String) {
    let marker = "\ndiff --git ";
    if let Some(index) = output.find(marker) {
        let stat = output[..index].trim().to_string();
        let patch = output[index + 1..].to_string();
        (stat, patch)
    } else if output.starts_with("diff --git ") {
        (String::new(), output.to_string())
    } else {
        (output.trim().to_string(), String::new())
    }
}

fn truncate_patch(value: String) -> (String, bool) {
    if value.len() <= GIT_DIFF_MAX_BYTES {
        return (value, false);
    }
    let mut end = GIT_DIFF_MAX_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

fn commit_file_kind(status: &str) -> String {
    match status.chars().next().unwrap_or('M') {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "type_changed",
        _ => "modified",
    }
    .to_string()
}

fn parse_name_status_line(line: &str) -> Option<GitCommitFile> {
    let trimmed = line.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = trimmed.split('\t');
    let raw_status = parts.next()?.trim();
    if raw_status.is_empty() {
        return None;
    }
    let status = raw_status
        .chars()
        .next()
        .unwrap_or('M')
        .to_ascii_uppercase()
        .to_string();
    if status == "R" || status == "C" {
        let old_path = parts.next()?.trim().to_string();
        let path = parts.next()?.trim().to_string();
        if path.is_empty() {
            return None;
        }
        return Some(GitCommitFile {
            path,
            old_path: if old_path.is_empty() {
                None
            } else {
                Some(old_path)
            },
            status,
            kind: commit_file_kind(raw_status),
        });
    }
    let path = parts.next()?.trim().to_string();
    if path.is_empty() {
        return None;
    }
    Some(GitCommitFile {
        path,
        old_path: None,
        status,
        kind: commit_file_kind(raw_status),
    })
}

fn parse_name_status_records(raw: &str) -> Vec<GitCommitFile> {
    let mut files = Vec::new();
    let mut parts = raw.split('\0').filter(|part| !part.is_empty());
    while let Some(raw_status) = parts.next() {
        let raw_status = raw_status.trim();
        if raw_status.is_empty() {
            continue;
        }
        let status = raw_status
            .chars()
            .next()
            .unwrap_or('M')
            .to_ascii_uppercase()
            .to_string();
        if status == "R" || status == "C" {
            let Some(old_path) = parts.next() else {
                break;
            };
            let Some(path) = parts.next() else {
                break;
            };
            if path.is_empty() {
                continue;
            }
            files.push(GitCommitFile {
                path: path.to_string(),
                old_path: if old_path.is_empty() {
                    None
                } else {
                    Some(old_path.to_string())
                },
                status,
                kind: commit_file_kind(raw_status),
            });
            continue;
        }
        let Some(path) = parts.next() else {
            break;
        };
        if path.is_empty() {
            continue;
        }
        files.push(GitCommitFile {
            path: path.to_string(),
            old_path: None,
            status,
            kind: commit_file_kind(raw_status),
        });
    }
    files
}

fn clean_git_ref_label(raw: &str) -> Option<String> {
    let mut value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let mut is_head = false;
    let mut is_tag = false;
    if let Some((head, target)) = value.split_once(" -> ") {
        is_head = head.trim() == "HEAD";
        value = target.trim();
    }
    if let Some(stripped) = value.strip_prefix("tag: ") {
        is_tag = true;
        value = stripped.trim();
    }
    if value.is_empty() || value == "HEAD" || value.ends_with("/HEAD") {
        return None;
    }
    if is_head {
        Some(format!("HEAD -> {value}"))
    } else if is_tag && !value.starts_with("refs/tags/") {
        Some(format!("refs/tags/{value}"))
    } else {
        Some(value.to_string())
    }
}

fn parse_git_refs(raw: &str) -> Vec<String> {
    let mut refs = Vec::new();
    for part in raw.split(',') {
        let Some(label) = clean_git_ref_label(part) else {
            continue;
        };
        if !refs.contains(&label) {
            refs.push(label);
        }
    }
    refs
}

fn parse_git_log(raw: &str) -> Vec<GitCommitSummary> {
    raw.split('\x1e')
        .filter_map(|record| {
            let record = record.trim_start_matches('\n').trim_end_matches('\0');
            if record
                .trim_matches(|ch: char| ch == '\0' || ch.is_whitespace())
                .is_empty()
            {
                return None;
            }
            let (header, file_data) = record.split_once('\n').unwrap_or((record, ""));
            let fields: Vec<&str> = header.split('\x1f').collect();
            if fields.len() < 8 {
                return None;
            }
            let sha = fields[0].trim().to_string();
            if sha.is_empty() {
                return None;
            }
            let files: Vec<GitCommitFile> = if file_data.contains('\0') {
                parse_name_status_records(file_data)
            } else {
                file_data
                    .lines()
                    .filter_map(parse_name_status_line)
                    .collect()
            };
            Some(GitCommitSummary {
                sha,
                short_sha: fields[1].trim().to_string(),
                parents: fields[2]
                    .split_whitespace()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect(),
                refs: parse_git_refs(fields[3]),
                author_name: fields[4].trim().to_string(),
                author_email: fields[5].trim().to_string(),
                author_date: fields[6].trim().to_string(),
                subject: fields[7].trim().to_string(),
                file_count: files.len(),
                files,
                local_only: false,
            })
        })
        .collect()
}

fn commit_files_between(
    repo_root: &str,
    base_ref: &str,
    head_ref: &str,
) -> Result<Vec<GitCommitFile>, String> {
    let output = git_success(
        repo_root,
        &[
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            base_ref,
            head_ref,
        ],
    )?;
    Ok(parse_name_status_records(&output.stdout))
}

fn local_only_commit_shas(repo_root: &str, cloud_ref: &str) -> HashSet<String> {
    let cloud_ref = cloud_ref.trim();
    if cloud_ref.is_empty() {
        return HashSet::new();
    }
    let rev_range = format!("HEAD...{cloud_ref}");
    git_success(repo_root, &["rev-list", "--left-only", &rev_range])
        .map(|output| {
            output
                .stdout
                .lines()
                .map(str::trim)
                .filter(|sha| !sha.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn normalized_ref_name(reference: &str) -> String {
    let mut value = reference.trim();
    for prefix in ["refs/heads/", "refs/remotes/", "refs/tags/"] {
        if let Some(stripped) = value.strip_prefix(prefix) {
            value = stripped;
            break;
        }
    }
    value.to_string()
}

fn comparable_branch_name(reference: &str) -> String {
    let normalized = normalized_ref_name(reference);
    if let Some(stripped) = normalized.strip_prefix("origin/") {
        return stripped.to_string();
    }
    normalized
}

fn refs_share_branch_name(a: &str, b: &str) -> bool {
    let a = comparable_branch_name(a);
    let b = comparable_branch_name(b);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b
}

fn is_default_history_branch(reference: &str) -> bool {
    matches!(
        comparable_branch_name(reference).as_str(),
        "main" | "master" | "develop"
    )
}

fn resolve_history_base_ref(state: &GitRepositoryState, history_remote_ref: &str) -> String {
    let current_head = state.head.trim();
    let current_local_ref = if current_head.is_empty() || current_head == "(detached)" {
        String::new()
    } else {
        current_head.to_string()
    };
    if is_default_history_branch(&current_local_ref) {
        return String::new();
    }
    for candidate in [
        "origin/main",
        "origin/master",
        "origin/develop",
        "main",
        "master",
        "develop",
    ] {
        if refs_share_branch_name(candidate, history_remote_ref)
            || refs_share_branch_name(candidate, &current_local_ref)
        {
            continue;
        }
        if ref_exists(&state.repo_root, candidate) {
            return candidate.to_string();
        }
    }
    String::new()
}

fn push_unique_ref(refs: &mut Vec<String>, reference: String) {
    let reference = reference.trim();
    if reference.is_empty() || refs.iter().any(|existing| existing == reference) {
        return;
    }
    refs.push(reference.to_string());
}

fn resolve_history_log_refs(
    state: &GitRepositoryState,
    history_remote_ref: &str,
    history_base_ref: &str,
) -> Vec<String> {
    let mut refs = Vec::new();
    push_unique_ref(&mut refs, "HEAD".to_string());

    let current_ref = if state.head.trim().is_empty() || state.head == "(detached)" {
        String::new()
    } else {
        format!("refs/heads/{}", state.head)
    };
    push_unique_ref(&mut refs, current_ref);
    push_unique_ref(&mut refs, history_remote_ref.to_string());
    push_unique_ref(&mut refs, history_base_ref.to_string());

    refs
}

fn resolve_history_merge_base(repo_root: &str, history_base_ref: &str) -> String {
    if history_base_ref.trim().is_empty() {
        return String::new();
    }
    git_success(repo_root, &["merge-base", "HEAD", history_base_ref])
        .map(|output| {
            output
                .stdout
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string()
        })
        .unwrap_or_default()
}

fn history_ahead_behind(repo_root: &str, history_base_ref: &str) -> (i32, i32) {
    if history_base_ref.trim().is_empty() {
        return (0, 0);
    }
    let rev_range = format!("HEAD...{history_base_ref}");
    git_success(
        repo_root,
        &["rev-list", "--left-right", "--count", &rev_range],
    )
    .map(|output| {
        let mut counts = output.stdout.split_whitespace();
        let ahead = counts.next().and_then(|raw| raw.parse().ok()).unwrap_or(0);
        let behind = counts.next().and_then(|raw| raw.parse().ok()).unwrap_or(0);
        (ahead, behind)
    })
    .unwrap_or_default()
}

fn parse_shortstat_count(segment: &str) -> usize {
    segment
        .split_whitespace()
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0)
}

fn parse_shortstat(raw: &str) -> (usize, usize, usize) {
    let mut files_changed = 0;
    let mut insertions = 0;
    let mut deletions = 0;
    for segment in raw.split(',').map(str::trim) {
        if segment.contains("file") && segment.contains("changed") {
            files_changed = parse_shortstat_count(segment);
        } else if segment.contains("insertion") {
            insertions = parse_shortstat_count(segment);
        } else if segment.contains("deletion") {
            deletions = parse_shortstat_count(segment);
        }
    }
    (files_changed, insertions, deletions)
}

fn validate_commit_sha(repo_root: &str, value: &str) -> Result<String, String> {
    let sha = value.trim();
    if sha.len() < 7 || sha.len() > 64 || !sha.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("Git commit 必须是有效的提交 SHA。".to_string());
    }
    let rev = format!("{sha}^{{commit}}");
    Ok(git_success(repo_root, &["rev-parse", "--verify", &rev])?
        .stdout
        .lines()
        .next()
        .unwrap_or(sha)
        .trim()
        .to_string())
}

fn validate_start_point(repo_root: &str, value: &str) -> Result<String, String> {
    let start_point = value.trim();
    if start_point.is_empty() {
        return Err("分支起点不能为空。".to_string());
    }
    if start_point.len() >= 7
        && start_point.len() <= 64
        && start_point.chars().all(|ch| ch.is_ascii_hexdigit())
    {
        return validate_commit_sha(repo_root, start_point);
    }
    if start_point.starts_with('-') || start_point.chars().any(char::is_whitespace) {
        return Err("分支起点不能以 - 开头或包含空白字符。".to_string());
    }
    let rev = format!("{start_point}^{{commit}}");
    git_success(
        repo_root,
        &["rev-parse", "--verify", "--end-of-options", &rev],
    )?;
    // 返回原始 ref（而非解析后的 SHA），保留 switch -c 对远程 ref 的自动 tracking。
    Ok(start_point.to_string())
}

pub(crate) fn git_log_sync(
    workdir: String,
    limit: Option<usize>,
    skip: Option<usize>,
) -> Result<GitLogResponse, String> {
    let state = git_status_sync(workdir)?;
    if state.status != "ready" {
        return Ok(GitLogResponse {
            state,
            commits: Vec::new(),
            history_base_ref: String::new(),
            history_remote_ref: String::new(),
            history_ahead: 0,
            history_behind: 0,
            merge_base: String::new(),
        });
    }
    if !ref_exists(&state.repo_root, "HEAD") {
        return Ok(GitLogResponse {
            state,
            commits: Vec::new(),
            history_base_ref: String::new(),
            history_remote_ref: String::new(),
            history_ahead: 0,
            history_behind: 0,
            merge_base: String::new(),
        });
    }
    let limit = limit
        .unwrap_or(GIT_LOG_DEFAULT_LIMIT)
        .clamp(1, GIT_LOG_MAX_LIMIT);
    let skip = skip.unwrap_or(0);
    let mut args = vec![
        "log".to_string(),
        "--date=iso-strict".to_string(),
        "--decorate=full".to_string(),
        "--topo-order".to_string(),
        "--parents".to_string(),
        "--name-status".to_string(),
        "-z".to_string(),
        "--find-renames".to_string(),
        "--max-count".to_string(),
        limit.to_string(),
    ];
    if skip > 0 {
        args.push(format!("--skip={skip}"));
    }
    let cloud_ref = resolve_cloud_tracking_ref(&state);
    let review_ref = if cloud_ref.trim().is_empty() {
        resolve_review_base(&state)
    } else {
        cloud_ref.clone()
    };
    let history_base_ref = resolve_history_base_ref(&state, &review_ref);
    args.push("--pretty=format:%x1e%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%aI%x1f%s".to_string());
    args.extend(resolve_history_log_refs(
        &state,
        &review_ref,
        &history_base_ref,
    ));
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git_success(&state.repo_root, &arg_refs)?;
    let mut commits = parse_git_log(&output.stdout);
    // git log/show omit name-status entries for merge commits; VSCode expands
    // those commits by diffing them against the first parent.
    for commit in &mut commits {
        if commit.parents.len() > 1 && commit.files.is_empty() {
            if let Some(first_parent) = commit.parents.first() {
                let files = commit_files_between(&state.repo_root, first_parent, &commit.sha);
                if let Ok(files) = files {
                    commit.file_count = files.len();
                    commit.files = files;
                }
            }
        }
    }
    let local_only_shas = local_only_commit_shas(&state.repo_root, &cloud_ref);
    if cloud_ref.trim().is_empty() {
        for commit in &mut commits {
            commit.local_only = true;
        }
    } else {
        for commit in &mut commits {
            commit.local_only = local_only_shas.contains(&commit.sha);
        }
    }
    let merge_base = resolve_history_merge_base(&state.repo_root, &review_ref);
    let (history_ahead, history_behind) = history_ahead_behind(&state.repo_root, &review_ref);
    Ok(GitLogResponse {
        state,
        commits,
        history_base_ref,
        history_remote_ref: review_ref,
        history_ahead,
        history_behind,
        merge_base,
    })
}

pub(crate) fn git_commit_details_sync(
    workdir: String,
    commit: String,
) -> Result<GitCommitDetailsResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let commit = validate_commit_sha(&state.repo_root, &commit)?;
    let metadata_output = git_success(
        &state.repo_root,
        &[
            "show",
            "-s",
            "--date=iso-strict",
            "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b",
            &commit,
        ],
    )?;
    let fields: Vec<&str> = metadata_output.stdout.splitn(7, '\x1f').collect();
    if fields.len() < 7 {
        return Err("无法解析 Git commit 详情。".to_string());
    }
    let parent_output = git_success(&state.repo_root, &["show", "-s", "--format=%P", &commit])?;
    let first_parent = parent_output
        .stdout
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
    let files_output = git_success(
        &state.repo_root,
        &[
            "show",
            "--format=",
            "--name-status",
            "-z",
            "--find-renames",
            &commit,
        ],
    )?;
    let mut files = parse_name_status_records(&files_output.stdout);
    if files.is_empty() && !first_parent.is_empty() {
        let parent_files = commit_files_between(&state.repo_root, &first_parent, &commit);
        if let Ok(parent_files) = parent_files {
            files = parent_files;
        }
    }
    let stat_output = git_success(
        &state.repo_root,
        &["show", "--format=", "--stat", "--find-renames", &commit],
    )?;
    let shortstat_output = git_success(
        &state.repo_root,
        &[
            "show",
            "--format=",
            "--shortstat",
            "--find-renames",
            &commit,
        ],
    )?;
    let (files_changed, insertions, deletions) = parse_shortstat(&shortstat_output.stdout);
    let details = GitCommitDetails {
        sha: fields[0].trim().to_string(),
        short_sha: fields[1].trim().to_string(),
        author_name: fields[2].trim().to_string(),
        author_email: fields[3].trim().to_string(),
        author_date: fields[4].trim().to_string(),
        subject: fields[5].trim().to_string(),
        body: fields[6].trim().to_string(),
        file_count: files.len(),
        files,
        files_changed,
        insertions,
        deletions,
        stat: stat_output.stdout.trim().to_string(),
        remote_name: state.remote_name.clone(),
        remote_url: state.remote_url.clone(),
    };
    Ok(GitCommitDetailsResponse {
        state,
        commit: details,
    })
}

pub(crate) fn git_compare_commit_with_remote_sync(
    workdir: String,
    commit: String,
) -> Result<GitDiffResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let commit = validate_commit_sha(&state.repo_root, &commit)?;
    let remote_ref = resolve_cloud_tracking_ref(&state);
    if remote_ref.trim().is_empty() {
        return Err(
            "找不到可用于比较的远端分支。请先设置 upstream 或 fetch 远端分支。".to_string(),
        );
    }
    let range = format!("{remote_ref}...{commit}");
    let output = git_success(
        &state.repo_root,
        &["diff", "--patch", "--stat", "--find-renames", &range],
    )?;
    let files = git_success(
        &state.repo_root,
        &["diff", "--name-only", "--find-renames", &range],
    )
    .map(|output| {
        output
            .stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToString::to_string)
            .collect()
    })
    .unwrap_or_default();
    let (stat, patch) = split_stat_and_patch(&output.stdout);
    let (patch, truncated) = truncate_patch(patch);
    Ok(GitDiffResponse {
        base_ref: remote_ref,
        head_ref: commit,
        mode: "remote_compare".to_string(),
        files,
        patch,
        stat,
        truncated,
        binary_files: Vec::new(),
    })
}

pub(crate) fn git_commit_diff_sync(
    workdir: String,
    commit: String,
    path: Option<String>,
) -> Result<GitDiffResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let commit = validate_commit_sha(&state.repo_root, &commit)?;
    let clean_path = path
        .as_deref()
        .map(validate_repo_relative_path)
        .transpose()?;
    let parent_output = git_success(&state.repo_root, &["show", "-s", "--format=%P", &commit])?;
    let first_parent = parent_output
        .stdout
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
    let mut args: Vec<String> = if first_parent.is_empty() {
        vec![
            "show".to_string(),
            "--format=".to_string(),
            "--patch".to_string(),
            "--stat".to_string(),
            "--find-renames".to_string(),
            commit.clone(),
        ]
    } else {
        vec![
            "diff".to_string(),
            "--patch".to_string(),
            "--stat".to_string(),
            "--find-renames".to_string(),
            first_parent.clone(),
            commit.clone(),
        ]
    };
    if let Some(path) = clean_path.as_deref() {
        args.push("--".to_string());
        args.push(path.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git_success(&state.repo_root, &arg_refs)?;
    let (stat, patch) = split_stat_and_patch(&output.stdout);
    let (patch, truncated) = truncate_patch(patch);
    Ok(GitDiffResponse {
        base_ref: if first_parent.is_empty() {
            "ROOT".to_string()
        } else {
            first_parent
        },
        head_ref: commit,
        mode: "commit".to_string(),
        files: clean_path.into_iter().collect(),
        patch,
        stat,
        truncated,
        binary_files: Vec::new(),
    })
}

pub(crate) fn git_diff_sync(
    workdir: String,
    mode: Option<String>,
    path: Option<String>,
) -> Result<GitDiffResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let mode = mode.unwrap_or_else(|| "branch".to_string());
    let clean_path = path
        .as_deref()
        .map(validate_repo_relative_path)
        .transpose()?;
    let files = state
        .entries
        .iter()
        .map(|entry| entry.path.clone())
        .collect();
    if mode == "working_tree" && !ref_exists(&state.repo_root, "HEAD") {
        let mut patch = String::new();
        let mut binary_files = Vec::new();
        append_initial_worktree_file_patches(
            &state.repo_root,
            &state.entries,
            clean_path.as_deref(),
            &mut patch,
            &mut binary_files,
        )?;
        let (patch, truncated) = truncate_patch(patch);
        return Ok(GitDiffResponse {
            base_ref: "ROOT".to_string(),
            head_ref: "WORKTREE".to_string(),
            mode,
            files,
            patch,
            stat: String::new(),
            truncated,
            binary_files,
        });
    }
    let mut base_ref = String::new();
    let mut head_ref = "HEAD".to_string();
    let mut args: Vec<String> = vec![
        "diff".to_string(),
        "--patch".to_string(),
        "--stat".to_string(),
    ];
    if mode == "working_tree" {
        args.push("HEAD".to_string());
    } else {
        base_ref = resolve_review_base(&state);
        if base_ref.is_empty() {
            return Err(
                "找不到可用于审查的基线分支。请先设置 upstream 或 fetch 主分支。".to_string(),
            );
        }
        args.push(format!("{base_ref}...HEAD"));
    }
    if let Some(path) = clean_path.as_deref() {
        args.push("--".to_string());
        args.push(path.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git_success(&state.repo_root, &arg_refs)?;
    let (stat, mut patch) = split_stat_and_patch(&output.stdout);
    let mut binary_files = Vec::new();
    if mode == "working_tree" {
        append_untracked_file_patches(
            &state.repo_root,
            &state.entries,
            clean_path.as_deref(),
            &mut patch,
            &mut binary_files,
        )?;
    }
    let (patch, truncated) = truncate_patch(patch);
    if mode == "working_tree" {
        base_ref = "HEAD".to_string();
        head_ref = "WORKTREE".to_string();
    }
    Ok(GitDiffResponse {
        base_ref,
        head_ref,
        mode,
        files,
        patch,
        stat,
        truncated,
        binary_files,
    })
}

pub(crate) fn git_stage_sync(
    workdir: String,
    path: String,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let path = validate_repo_relative_path(&path)?;
    operation_response(
        &workdir,
        git_success(&state.repo_root, &["add", "--", path.as_str()]),
        "文件已暂存。",
    )
}

pub(crate) fn git_stage_all_sync(workdir: String) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    operation_response(
        &workdir,
        git_success(&state.repo_root, &["add", "-A", "--"]),
        "所有改动已暂存。",
    )
}

pub(crate) fn git_unstage_sync(
    workdir: String,
    path: String,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let path = validate_repo_relative_path(&path)?;
    let staged_without_head = !ref_exists(&state.repo_root, "HEAD")
        && state
            .entries
            .iter()
            .any(|entry| entry.path == path && !entry.untracked && entry.index_status != ".");
    if staged_without_head {
        return operation_response(
            &workdir,
            git_success(&state.repo_root, &["rm", "--cached", "--", path.as_str()]),
            "文件已取消暂存。",
        );
    }
    operation_response(
        &workdir,
        git_success(
            &state.repo_root,
            &["restore", "--staged", "--", path.as_str()],
        ),
        "文件已取消暂存。",
    )
}

pub(crate) fn git_unstage_all_sync(workdir: String) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    if !ref_exists(&state.repo_root, "HEAD") {
        let result = if state.dirty_counts.staged > 0 {
            git_success(&state.repo_root, &["rm", "--cached", "-r", "--", "."])
        } else {
            Ok(empty_git_output())
        };
        return operation_response(&workdir, result, "所有改动已取消暂存。");
    }
    operation_response(
        &workdir,
        git_success(&state.repo_root, &["restore", "--staged", "--", "."]),
        "所有改动已取消暂存。",
    )
}

pub(crate) fn git_discard_sync(
    workdir: String,
    path: String,
    old_path: Option<String>,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let path = validate_repo_relative_path(&path)?;
    let old_path = old_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(validate_repo_relative_path)
        .transpose()?;
    let is_untracked = state
        .entries
        .iter()
        .any(|entry| entry.path == path && entry.untracked);
    let staged_without_head = !ref_exists(&state.repo_root, "HEAD")
        && state
            .entries
            .iter()
            .any(|entry| entry.path == path && !entry.untracked && entry.index_status != ".");
    let result = if is_untracked {
        git_success(&state.repo_root, &["clean", "-fd", "--", path.as_str()])
    } else if staged_without_head {
        git_success(&state.repo_root, &["rm", "-f", "--", path.as_str()])
    } else {
        let mut args = vec!["restore", "--staged", "--worktree", "--", path.as_str()];
        if let Some(old_path) = old_path.as_deref() {
            if old_path != path {
                args.push(old_path);
            }
        }
        git_success(&state.repo_root, &args)
    };
    operation_response(&workdir, result, "改动已放弃。")
}

pub(crate) fn git_discard_all_sync(workdir: String) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let result = if !ref_exists(&state.repo_root, "HEAD") {
        let remove_result = if state.dirty_counts.staged > 0 {
            git_success(&state.repo_root, &["rm", "-f", "-r", "--", "."])
        } else {
            Ok(empty_git_output())
        };
        remove_result.and_then(|remove_output| {
            git_success(&state.repo_root, &["clean", "-fd", "--", "."])
                .map(|clean_output| merge_git_outputs([remove_output, clean_output]))
        })
    } else {
        git_success(
            &state.repo_root,
            &["restore", "--staged", "--worktree", "--", "."],
        )
        .and_then(|restore_output| {
            git_success(&state.repo_root, &["clean", "-fd", "--", "."])
                .map(|clean_output| merge_git_outputs([restore_output, clean_output]))
        })
    };
    operation_response(&workdir, result, "所有改动已放弃。")
}

pub(crate) fn git_add_to_gitignore_sync(
    workdir: String,
    path: String,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let path = validate_repo_relative_path(&path)?;
    let pattern = format!("/{path}");
    let gitignore_path = Path::new(&state.repo_root).join(".gitignore");
    let mut content = match fs::read_to_string(&gitignore_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("读取 .gitignore 失败：{error}")),
    };
    let already_present = content.lines().any(|line| {
        let line = line.trim();
        line == path || line == pattern
    });
    let result = if already_present {
        Ok(GitOutput {
            stdout: String::new(),
            stderr: String::new(),
        })
    } else {
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&pattern);
        content.push('\n');
        fs::write(&gitignore_path, content)
            .map(|_| GitOutput {
                stdout: String::new(),
                stderr: String::new(),
            })
            .map_err(|error| format!("写入 .gitignore 失败：{error}"))
    };
    operation_response(
        &workdir,
        result,
        if already_present {
            "路径已存在于 .gitignore。"
        } else {
            "路径已添加到 .gitignore。"
        },
    )
}

pub(crate) fn git_open_system_file_location_sync(
    workdir: String,
    path: String,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let path = validate_repo_relative_path(&path)?;
    let repo_root_path = Path::new(&state.repo_root);
    let target = repo_root_path.join(path);
    open_system_file_location(&target, repo_root_path)?;
    Ok(GitOperationResponse {
        ok: true,
        state: git_status_sync(workdir)?,
        stdout: String::new(),
        stderr: String::new(),
        message: "已在系统资源管理器中打开。".to_string(),
    })
}

pub(crate) fn git_commit_sync(
    workdir: String,
    message: String,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Commit message 不能为空。".to_string());
    }
    if state.dirty_counts.staged == 0 {
        return Err("没有已暂存的改动可提交。".to_string());
    }
    git_success(&state.repo_root, &["config", "--get", "user.name"])
        .map_err(|_| "Git user.name 未配置。".to_string())?;
    git_success(&state.repo_root, &["config", "--get", "user.email"])
        .map_err(|_| "Git user.email 未配置。".to_string())?;
    operation_response(
        &workdir,
        git_success(&state.repo_root, &["commit", "-m", message.as_str()]),
        "提交已创建。",
    )
}

pub(crate) fn git_fetch_sync(workdir: String) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let result = match git_remote_names(&state.repo_root) {
        Ok(remotes) if remotes.is_empty() => Err(GIT_MISSING_REMOTE_MESSAGE.to_string()),
        Ok(_) => git_success(&state.repo_root, &["fetch", "--prune"]),
        Err(error) => Err(error),
    };
    operation_response(&workdir, result, "Fetch 完成。")
}

pub(crate) fn git_pull_sync(workdir: String) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let result = if state.upstream.trim().is_empty() {
        if state.head.trim().is_empty() || state.head == "(detached)" {
            Err("当前不在可拉取的本地分支上。".to_string())
        } else if !git_origin_remote_exists(&state.repo_root) {
            Err(GIT_MISSING_ORIGIN_REMOTE_MESSAGE.to_string())
        } else {
            git_success(
                &state.repo_root,
                &["pull", "--ff-only", "origin", state.head.as_str()],
            )
        }
    } else {
        git_success(&state.repo_root, &["pull", "--ff-only"])
    };
    operation_response(&workdir, result, "Pull 完成。")
}

pub(crate) fn git_set_remote_sync(
    workdir: String,
    remote_url: String,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let remote_url = validate_git_remote_url(&remote_url)?;
    let result = if git_origin_remote_exists(&state.repo_root) {
        git_success(
            &state.repo_root,
            &["remote", "set-url", "origin", remote_url.as_str()],
        )
    } else {
        git_success(
            &state.repo_root,
            &["remote", "add", "origin", remote_url.as_str()],
        )
    };
    operation_response(&workdir, result, "远端仓库已保存。")
}

pub(crate) fn git_push_sync(workdir: String) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let result = if state.upstream.trim().is_empty() {
        if state.head.trim().is_empty() || state.head == "(detached)" {
            Err("当前不在可推送的本地分支上。".to_string())
        } else if !git_origin_remote_exists(&state.repo_root) {
            Err(GIT_MISSING_ORIGIN_REMOTE_MESSAGE.to_string())
        } else {
            git_success(
                &state.repo_root,
                &["push", "-u", "origin", state.head.as_str()],
            )
        }
    } else {
        git_success(&state.repo_root, &["push"])
    };
    operation_response(&workdir, result, "Push 完成。")
}

pub(crate) fn git_delete_branch_sync(
    workdir: String,
    branch: String,
    force: Option<bool>,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let branch = validate_branch_name(&state.repo_root, &branch)?;
    if branch == state.head {
        return Err("不能删除当前检出的分支。".to_string());
    }
    let delete_flag = if force == Some(true) { "-D" } else { "-d" };
    operation_response(
        &workdir,
        git_success(&state.repo_root, &["branch", delete_flag, branch.as_str()]),
        "分支已删除。",
    )
}

pub(crate) fn git_rename_branch_sync(
    workdir: String,
    branch: String,
    new_branch: String,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let branch = validate_branch_name(&state.repo_root, &branch)?;
    let new_branch = validate_branch_name(&state.repo_root, &new_branch)?;
    operation_response(
        &workdir,
        git_success(
            &state.repo_root,
            &["branch", "-m", branch.as_str(), new_branch.as_str()],
        ),
        "分支已重命名。",
    )
}

pub(crate) fn git_stash_push_sync(
    workdir: String,
    message: Option<String>,
) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    let message = validate_git_config_value("Stash message", message)?;
    let mut args = vec!["stash", "push", "--include-untracked"];
    if let Some(message) = message.as_deref() {
        args.push("-m");
        args.push(message);
    }
    operation_response(
        &workdir,
        git_success(&state.repo_root, &args),
        "改动已暂存到 stash。",
    )
}

pub(crate) fn git_stash_pop_sync(workdir: String) -> Result<GitOperationResponse, String> {
    let state = ensure_ready_state(&workdir)?;
    operation_response(
        &workdir,
        git_success(&state.repo_root, &["stash", "pop"]),
        "已恢复最近的 stash。",
    )
}

fn parse_gateway_args(args_json: String) -> Result<GitGatewayArgs, String> {
    if args_json.trim().is_empty() {
        return Ok(GitGatewayArgs::default());
    }
    serde_json::from_str(&args_json).map_err(|error| format!("Git 参数 JSON 无效：{error}"))
}

pub(crate) fn git_gateway_action_sync(
    action: String,
    workdir: String,
    args_json: String,
) -> Result<Value, String> {
    let action = action.trim().to_ascii_lowercase();
    let args = parse_gateway_args(args_json)?;
    let value = match action.as_str() {
        "status" => serde_json::to_value(git_status_sync(workdir)?),
        "branches" => serde_json::to_value(git_branches_sync(workdir)?),
        "init" => serde_json::to_value(git_init_sync(
            workdir,
            args.branch.unwrap_or_else(|| "main".to_string()),
            args.user_name,
            args.user_email,
        )?),
        "switch_branch" => serde_json::to_value(git_switch_branch_sync(
            workdir,
            args.branch.unwrap_or_default(),
            args.kind,
        )?),
        "create_branch" => serde_json::to_value(git_create_branch_sync(
            workdir,
            args.branch.unwrap_or_default(),
            args.start_point,
        )?),
        "log" => serde_json::to_value(git_log_sync(workdir, args.limit, args.skip)?),
        "commit_details" => serde_json::to_value(git_commit_details_sync(
            workdir,
            args.commit.unwrap_or_default(),
        )?),
        "compare_commit_with_remote" => serde_json::to_value(git_compare_commit_with_remote_sync(
            workdir,
            args.commit.unwrap_or_default(),
        )?),
        "commit_diff" => serde_json::to_value(git_commit_diff_sync(
            workdir,
            args.commit.unwrap_or_default(),
            args.path,
        )?),
        "diff" => serde_json::to_value(git_diff_sync(workdir, args.mode, args.path)?),
        "stage" => serde_json::to_value(git_stage_sync(workdir, args.path.unwrap_or_default())?),
        "stage_all" => serde_json::to_value(git_stage_all_sync(workdir)?),
        "unstage" => {
            serde_json::to_value(git_unstage_sync(workdir, args.path.unwrap_or_default())?)
        }
        "unstage_all" => serde_json::to_value(git_unstage_all_sync(workdir)?),
        "discard" => serde_json::to_value(git_discard_sync(
            workdir,
            args.path.unwrap_or_default(),
            args.old_path,
        )?),
        "discard_all" => serde_json::to_value(git_discard_all_sync(workdir)?),
        "add_to_gitignore" => serde_json::to_value(git_add_to_gitignore_sync(
            workdir,
            args.path.unwrap_or_default(),
        )?),
        "open_system_file_location" => serde_json::to_value(git_open_system_file_location_sync(
            workdir,
            args.path.unwrap_or_default(),
        )?),
        "commit" => {
            serde_json::to_value(git_commit_sync(workdir, args.message.unwrap_or_default())?)
        }
        "fetch" => serde_json::to_value(git_fetch_sync(workdir)?),
        "pull" => serde_json::to_value(git_pull_sync(workdir)?),
        "set_remote" => serde_json::to_value(git_set_remote_sync(
            workdir,
            args.remote_url.unwrap_or_default(),
        )?),
        "push" => serde_json::to_value(git_push_sync(workdir)?),
        "delete_branch" => serde_json::to_value(git_delete_branch_sync(
            workdir,
            args.branch.unwrap_or_default(),
            args.force,
        )?),
        "rename_branch" => serde_json::to_value(git_rename_branch_sync(
            workdir,
            args.branch.unwrap_or_default(),
            args.new_branch.unwrap_or_default(),
        )?),
        "stash_push" => serde_json::to_value(git_stash_push_sync(workdir, args.message)?),
        "stash_pop" => serde_json::to_value(git_stash_pop_sync(workdir)?),
        "" => return Err("Git action 不能为空。".to_string()),
        other => return Err(format!("不支持的 Git action：{other}")),
    }
    .map_err(|error| format!("序列化 Git 响应失败：{error}"))?;
    Ok(value)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_status(workdir: String) -> Result<GitRepositoryState, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_sync(workdir))
        .await
        .map_err(|error| format!("git_status join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_branches(workdir: String) -> Result<GitBranchesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_branches_sync(workdir))
        .await
        .map_err(|error| format!("git_branches join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_switch_branch(
    workdir: String,
    branch: String,
    kind: Option<String>,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_switch_branch_sync(workdir, branch, kind))
        .await
        .map_err(|error| format!("git_switch_branch join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_create_branch(
    workdir: String,
    branch: String,
    start_point: Option<String>,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_create_branch_sync(workdir, branch, start_point)
    })
    .await
    .map_err(|error| format!("git_create_branch join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_init(
    workdir: String,
    branch: Option<String>,
    user_name: Option<String>,
    user_email: Option<String>,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_init_sync(
            workdir,
            branch.unwrap_or_else(|| "main".to_string()),
            user_name,
            user_email,
        )
    })
    .await
    .map_err(|error| format!("git_init join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_diff(
    workdir: String,
    mode: Option<String>,
    path: Option<String>,
) -> Result<GitDiffResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_sync(workdir, mode, path))
        .await
        .map_err(|error| format!("git_diff join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_log(
    workdir: String,
    limit: Option<usize>,
    skip: Option<usize>,
) -> Result<GitLogResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_log_sync(workdir, limit, skip))
        .await
        .map_err(|error| format!("git_log join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_commit_details(
    workdir: String,
    commit: String,
) -> Result<GitCommitDetailsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_details_sync(workdir, commit))
        .await
        .map_err(|error| format!("git_commit_details join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_compare_commit_with_remote(
    workdir: String,
    commit: String,
) -> Result<GitDiffResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_compare_commit_with_remote_sync(workdir, commit)
    })
    .await
    .map_err(|error| format!("git_compare_commit_with_remote join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_commit_diff(
    workdir: String,
    commit: String,
    path: Option<String>,
) -> Result<GitDiffResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_diff_sync(workdir, commit, path))
        .await
        .map_err(|error| format!("git_commit_diff join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_stage(workdir: String, path: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_stage_sync(workdir, path))
        .await
        .map_err(|error| format!("git_stage join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_stage_all(workdir: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_stage_all_sync(workdir))
        .await
        .map_err(|error| format!("git_stage_all join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_unstage(workdir: String, path: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_unstage_sync(workdir, path))
        .await
        .map_err(|error| format!("git_unstage join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_unstage_all(workdir: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_unstage_all_sync(workdir))
        .await
        .map_err(|error| format!("git_unstage_all join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_discard(
    workdir: String,
    path: String,
    old_path: Option<String>,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_discard_sync(workdir, path, old_path))
        .await
        .map_err(|error| format!("git_discard join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_discard_all(workdir: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_discard_all_sync(workdir))
        .await
        .map_err(|error| format!("git_discard_all join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_add_to_gitignore(
    workdir: String,
    path: String,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_add_to_gitignore_sync(workdir, path))
        .await
        .map_err(|error| format!("git_add_to_gitignore join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_open_system_file_location(
    workdir: String,
    path: String,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_open_system_file_location_sync(workdir, path))
        .await
        .map_err(|error| format!("git_open_system_file_location join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_commit(workdir: String, message: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_sync(workdir, message))
        .await
        .map_err(|error| format!("git_commit join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_fetch(workdir: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_fetch_sync(workdir))
        .await
        .map_err(|error| format!("git_fetch join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_pull(workdir: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_pull_sync(workdir))
        .await
        .map_err(|error| format!("git_pull join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_set_remote(
    workdir: String,
    remote_url: String,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_set_remote_sync(workdir, remote_url))
        .await
        .map_err(|error| format!("git_set_remote join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_push(workdir: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_push_sync(workdir))
        .await
        .map_err(|error| format!("git_push join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_delete_branch(
    workdir: String,
    branch: String,
    force: Option<bool>,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_delete_branch_sync(workdir, branch, force))
        .await
        .map_err(|error| format!("git_delete_branch join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_rename_branch(
    workdir: String,
    branch: String,
    new_branch: String,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_rename_branch_sync(workdir, branch, new_branch)
    })
    .await
    .map_err(|error| format!("git_rename_branch join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_stash_push(
    workdir: String,
    message: Option<String>,
) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_stash_push_sync(workdir, message))
        .await
        .map_err(|error| format!("git_stash_push join 失败：{error}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_stash_pop(workdir: String) -> Result<GitOperationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || git_stash_pop_sync(workdir))
        .await
        .map_err(|error| format!("git_stash_pop join 失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn parses_porcelain_v2_branch_and_counts() {
        let raw = b"# branch.head feature\0# branch.upstream origin/feature\0# branch.ab +2 -1\0\
# stash 3\01 .M N... 100644 100644 100644 a b src/main.rs\0? new.txt\0";
        let (head, upstream, ahead, behind, stash_count, entries) = parse_status_porcelain_v2(raw);
        assert_eq!(head, "feature");
        assert_eq!(upstream, "origin/feature");
        assert_eq!(ahead, 2);
        assert_eq!(behind, 1);
        assert_eq!(stash_count, 3);
        assert_eq!(entries.len(), 2);
        let counts = dirty_counts(&entries);
        assert_eq!(counts.unstaged, 1);
        assert_eq!(counts.untracked, 1);
    }

    #[test]
    fn rejects_unsafe_repo_relative_paths() {
        assert!(validate_repo_relative_path("src/main.rs").is_ok());
        assert_eq!(
            validate_repo_relative_path("src\\main.rs").as_deref(),
            Ok("src/main.rs")
        );
        assert!(validate_repo_relative_path("../secret").is_err());
        assert!(validate_repo_relative_path("/tmp/secret").is_err());
        assert!(looks_like_windows_drive_path(
            "C:/Users/liveagent/secret.txt"
        ));
        assert!(looks_like_windows_drive_path(
            "C:\\Users\\liveagent\\secret.txt"
        ));
        assert!(looks_like_windows_drive_path("C:relative\\secret.txt"));
        #[cfg(windows)]
        {
            assert!(validate_repo_relative_path("C:/Users/liveagent/secret.txt").is_err());
            assert!(validate_repo_relative_path("C:\\Users\\liveagent\\secret.txt").is_err());
            assert!(validate_repo_relative_path("C:relative\\secret.txt").is_err());
            assert!(validate_repo_relative_path("\\\\server\\share\\secret.txt").is_err());
        }
    }

    #[test]
    fn falls_back_to_upstream_as_review_base() {
        let state = GitRepositoryState {
            repo_root: ".".to_string(),
            workdir: ".".to_string(),
            head: "feature".to_string(),
            upstream: "origin/feature".to_string(),
            remote_name: "origin".to_string(),
            remote_url: String::new(),
            ahead: 0,
            behind: 0,
            stash_count: 0,
            dirty_counts: GitDirtyCounts::default(),
            entries: Vec::new(),
            status: "ready".to_string(),
            error: None,
        };
        assert_eq!(resolve_review_base(&state), "origin/feature");
    }

    #[test]
    fn gateway_args_accept_empty_json() {
        assert!(parse_gateway_args(String::new()).is_ok());
        assert!(parse_gateway_args(json!({"path":"src/main.rs"}).to_string()).is_ok());
        let init_args = parse_gateway_args(
            json!({"branch":"main","userName":"LiveAgent Test","userEmail":"test@example.com"})
                .to_string(),
        )
        .expect("parse init args");
        assert_eq!(init_args.user_name.as_deref(), Some("LiveAgent Test"));
        assert_eq!(init_args.user_email.as_deref(), Some("test@example.com"));
        let log_args =
            parse_gateway_args(json!({"limit":50,"skip":100}).to_string()).expect("parse log args");
        assert_eq!(log_args.limit, Some(50));
        assert_eq!(log_args.skip, Some(100));
    }

    #[test]
    fn parses_git_log_commits_refs_and_renames() {
        let raw = "\x1e0123456789abcdef\x1f0123456\x1ffedcba9\x1fHEAD -> refs/heads/feature, refs/remotes/origin/feature, tag: refs/tags/v1.2.3\x1fAlice\x1falice@example.com\x1f2026-05-29T10:11:12+08:00\x1frename file\nR100\0old\tname.txt\0new name.txt\0A\0src/tab\tfile.txt\0";
        let commits = parse_git_log(raw);
        assert_eq!(commits.len(), 1);
        let commit = &commits[0];
        assert_eq!(commit.short_sha, "0123456");
        assert_eq!(
            commit.refs,
            vec![
                "HEAD -> refs/heads/feature",
                "refs/remotes/origin/feature",
                "refs/tags/v1.2.3",
            ]
        );
        assert_eq!(commit.parents, vec!["fedcba9"]);
        assert_eq!(commit.files.len(), 2);
        assert_eq!(commit.files[0].status, "R");
        assert_eq!(commit.files[0].old_path.as_deref(), Some("old\tname.txt"));
        assert_eq!(commit.files[0].path, "new name.txt");
        assert_eq!(commit.files[1].status, "A");
        assert_eq!(commit.files[1].path, "src/tab\tfile.txt");
    }

    #[test]
    fn untracked_file_patch_preserves_crlf_lines() {
        let temp = tempfile::tempdir().expect("temp dir");
        let file_path = temp.path().join("crlf.txt");
        fs::write(&file_path, "first\r\nsecond\r\n").expect("write crlf file");
        let patch = build_untracked_file_patch(&temp.path().to_string_lossy(), "crlf.txt")
            .expect("build patch")
            .expect("text patch");
        assert!(
            patch.contains("+first\r\n+second\r\n"),
            "untracked patch should preserve CRLF line endings:\n{patch:?}"
        );
    }

    fn run_temp_git(repo_root: &Path, args: &[&str]) {
        let mut command = Command::new("git");
        configure_child_process_group(&mut command);
        let output = command
            .args(args)
            .current_dir(repo_root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git command should start");
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_temp_repo() -> Option<TempDir> {
        if Command::new("git").arg("--version").output().is_err() {
            return None;
        }
        let temp = tempfile::tempdir().expect("temp repo");
        run_temp_git(temp.path(), &["init"]);
        run_temp_git(temp.path(), &["config", "core.autocrlf", "false"]);
        run_temp_git(temp.path(), &["config", "user.name", "LiveAgent Test"]);
        run_temp_git(temp.path(), &["config", "user.email", "test@example.com"]);
        fs::write(temp.path().join("README.md"), "initial\n").expect("write readme");
        run_temp_git(temp.path(), &["add", "README.md"]);
        run_temp_git(temp.path(), &["commit", "-m", "initial"]);
        Some(temp)
    }

    #[test]
    fn git_init_creates_repo_with_branch_and_local_identity() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let temp = tempfile::tempdir().expect("temp repo");
        let workdir = temp.path().to_string_lossy().to_string();
        let initialized = git_init_sync(
            workdir.clone(),
            "trunk".to_string(),
            Some("LiveAgent Test".to_string()),
            Some("test@example.com".to_string()),
        )
        .expect("init repo");
        assert!(initialized.ok, "init failed: {}", initialized.message);
        assert_eq!(initialized.state.status, "ready");
        assert_eq!(initialized.state.head, "trunk");

        let user_name =
            git_success(&workdir, &["config", "--get", "user.name"]).expect("user.name");
        let user_email =
            git_success(&workdir, &["config", "--get", "user.email"]).expect("user.email");
        assert_eq!(user_name.stdout, "LiveAgent Test");
        assert_eq!(user_email.stdout, "test@example.com");

        let duplicate = git_init_sync(workdir, "main".to_string(), None, None)
            .expect_err("second init should fail");
        assert!(duplicate.contains("Git 仓库内"), "{duplicate}");
    }

    #[test]
    fn git_worktree_diff_handles_unborn_head_repo() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let temp = tempfile::tempdir().expect("temp repo");
        let workdir = temp.path().to_string_lossy().to_string();
        let initialized =
            git_init_sync(workdir.clone(), "main".to_string(), None, None).expect("init repo");
        assert!(initialized.ok, "init failed: {}", initialized.message);
        assert!(!ref_exists(&workdir, "HEAD"));

        fs::write(temp.path().join("draft.txt"), "draft\n").expect("write draft");
        let diff = git_diff_sync(
            workdir.clone(),
            Some("working_tree".to_string()),
            Some("draft.txt".to_string()),
        )
        .expect("working tree diff in unborn repo");
        assert_eq!(diff.base_ref, "ROOT");
        assert_eq!(diff.head_ref, "WORKTREE");
        assert!(
            diff.files.contains(&"draft.txt".to_string()),
            "diff files: {:?}",
            diff.files
        );
        assert!(
            diff.patch.contains("diff --git a/draft.txt b/draft.txt")
                && diff.patch.contains("+draft"),
            "working tree diff patch:\n{}",
            diff.patch
        );
    }

    #[test]
    fn git_branches_includes_unborn_current_branch() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let temp = tempfile::tempdir().expect("temp repo");
        let workdir = temp.path().to_string_lossy().to_string();
        let initialized =
            git_init_sync(workdir.clone(), "main".to_string(), None, None).expect("init repo");
        assert!(initialized.ok, "init failed: {}", initialized.message);
        assert!(!ref_exists(&workdir, "HEAD"));

        let response = git_branches_sync(workdir).expect("branch list");
        assert_eq!(response.state.status, "ready");
        assert_eq!(response.state.head, "main");
        assert_eq!(response.branches.len(), 1);
        let branch = &response.branches[0];
        assert_eq!(branch.name, "main");
        assert_eq!(branch.full_name, "main");
        assert_eq!(branch.kind, "local");
        assert!(branch.current);
    }

    #[test]
    fn git_unborn_repo_can_unstage_and_discard_changes() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let temp = tempfile::tempdir().expect("temp repo");
        let workdir = temp.path().to_string_lossy().to_string();
        let initialized =
            git_init_sync(workdir.clone(), "main".to_string(), None, None).expect("init repo");
        assert!(initialized.ok, "init failed: {}", initialized.message);
        assert!(!ref_exists(&workdir, "HEAD"));

        fs::write(temp.path().join("staged.txt"), "staged\n").expect("write staged file");
        let staged = git_stage_sync(workdir.clone(), "staged.txt".to_string()).expect("stage");
        assert!(staged.ok, "stage failed: {}", staged.message);
        assert_eq!(staged.state.dirty_counts.staged, 1);

        let unstaged =
            git_unstage_sync(workdir.clone(), "staged.txt".to_string()).expect("unstage");
        assert!(unstaged.ok, "unstage failed: {}", unstaged.message);
        assert_eq!(unstaged.state.dirty_counts.staged, 0);
        assert_eq!(unstaged.state.dirty_counts.untracked, 1);
        assert!(temp.path().join("staged.txt").exists());

        let restaged = git_stage_sync(workdir.clone(), "staged.txt".to_string()).expect("restage");
        assert!(restaged.ok, "restage failed: {}", restaged.message);
        let unstaged_all = git_unstage_all_sync(workdir.clone()).expect("unstage all");
        assert!(
            unstaged_all.ok,
            "unstage all failed: {}",
            unstaged_all.message
        );
        assert_eq!(unstaged_all.state.dirty_counts.staged, 0);
        assert_eq!(unstaged_all.state.dirty_counts.untracked, 1);
        assert!(temp.path().join("staged.txt").exists());

        let restaged_again =
            git_stage_sync(workdir.clone(), "staged.txt".to_string()).expect("stage again");
        assert!(
            restaged_again.ok,
            "stage again failed: {}",
            restaged_again.message
        );
        let discarded =
            git_discard_sync(workdir.clone(), "staged.txt".to_string(), None).expect("discard");
        assert!(discarded.ok, "discard failed: {}", discarded.message);
        assert!(!temp.path().join("staged.txt").exists());

        fs::write(temp.path().join("bulk-staged.txt"), "staged\n").expect("write bulk staged");
        fs::write(temp.path().join("bulk-untracked.txt"), "untracked\n")
            .expect("write bulk untracked");
        let bulk_staged =
            git_stage_sync(workdir.clone(), "bulk-staged.txt".to_string()).expect("stage bulk");
        assert!(bulk_staged.ok, "stage bulk failed: {}", bulk_staged.message);
        let discarded_all = git_discard_all_sync(workdir.clone()).expect("discard all");
        assert!(
            discarded_all.ok,
            "discard all failed: {}",
            discarded_all.message
        );
        assert!(discarded_all.state.entries.is_empty());
        assert!(!temp.path().join("bulk-staged.txt").exists());
        assert!(!temp.path().join("bulk-untracked.txt").exists());
    }

    #[test]
    fn git_cli_operations_work_in_temp_repo() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let workdir = repo.path().to_string_lossy().to_string();
        let initial = git_status_sync(workdir.clone()).expect("initial status");
        assert_eq!(initial.status, "ready");
        assert!(!initial.head.is_empty());

        let created =
            git_create_branch_sync(workdir.clone(), "feature/git-review".to_string(), None)
                .expect("create branch");
        assert!(created.ok, "create branch failed: {}", created.message);
        assert_eq!(created.state.head, "feature/git-review");

        let switched_back = git_switch_branch_sync(workdir.clone(), initial.head.clone(), None)
            .expect("switch back");
        assert!(
            switched_back.ok,
            "switch back failed: {}",
            switched_back.message
        );
        let switched_feature =
            git_switch_branch_sync(workdir.clone(), "feature/git-review".to_string(), None)
                .expect("switch feature");
        assert!(
            switched_feature.ok,
            "switch feature failed: {}",
            switched_feature.message
        );

        fs::write(repo.path().join("feature.txt"), "feature\n").expect("write feature");
        let staged = git_stage_sync(workdir.clone(), "feature.txt".to_string()).expect("stage");
        assert!(staged.ok, "stage failed: {}", staged.message);
        let committed =
            git_commit_sync(workdir.clone(), "add feature file".to_string()).expect("commit");
        assert!(committed.ok, "commit failed: {}", committed.message);

        let history = git_log_sync(workdir.clone(), Some(10), None).expect("git log");
        let feature_commit = history
            .commits
            .iter()
            .find(|commit| commit.subject == "add feature file")
            .expect("feature commit should be in log");
        assert!(
            feature_commit
                .files
                .iter()
                .any(|file| file.path == "feature.txt" && file.status == "A"),
            "feature commit files: {:?}",
            feature_commit.files
        );
        let commit_diff = git_commit_diff_sync(
            workdir.clone(),
            feature_commit.sha.clone(),
            Some("feature.txt".to_string()),
        )
        .expect("commit diff");
        assert!(
            commit_diff.patch.contains("feature.txt") && commit_diff.patch.contains("+feature"),
            "commit diff patch:\n{}",
            commit_diff.patch
        );

        let branch_diff =
            git_diff_sync(workdir.clone(), Some("branch".to_string()), None).expect("branch diff");
        assert_eq!(branch_diff.base_ref, initial.head);
        assert!(
            branch_diff.patch.contains("feature.txt"),
            "branch diff patch:\n{}",
            branch_diff.patch
        );

        fs::write(repo.path().join("work.txt"), "draft\n").expect("write worktree");
        let worktree_diff = git_diff_sync(workdir.clone(), Some("working_tree".to_string()), None)
            .expect("working tree diff");
        assert_eq!(worktree_diff.base_ref, "HEAD");
        assert!(
            worktree_diff.patch.contains("work.txt") && worktree_diff.patch.contains("+draft"),
            "working tree diff patch:\n{}",
            worktree_diff.patch
        );

        let staged_work =
            git_stage_sync(workdir.clone(), "work.txt".to_string()).expect("stage worktree file");
        assert!(
            staged_work.ok,
            "stage worktree failed: {}",
            staged_work.message
        );
        assert_eq!(staged_work.state.dirty_counts.staged, 1);

        let unstaged_work = git_unstage_sync(workdir.clone(), "work.txt".to_string())
            .expect("unstage worktree file");
        assert!(
            unstaged_work.ok,
            "unstage worktree failed: {}",
            unstaged_work.message
        );
        assert_eq!(unstaged_work.state.dirty_counts.untracked, 1);

        let discarded_untracked =
            git_discard_sync(workdir.clone(), "work.txt".to_string(), None).expect("discard work");
        assert!(
            discarded_untracked.ok,
            "discard untracked failed: {}",
            discarded_untracked.message
        );
        assert!(!repo.path().join("work.txt").exists());

        fs::write(repo.path().join("README.md"), "changed\n").expect("modify readme");
        let staged_readme =
            git_stage_sync(workdir.clone(), "README.md".to_string()).expect("stage readme");
        assert!(
            staged_readme.ok,
            "stage readme failed: {}",
            staged_readme.message
        );
        let discarded_readme = git_discard_sync(workdir.clone(), "README.md".to_string(), None)
            .expect("discard readme");
        assert!(
            discarded_readme.ok,
            "discard readme failed: {}",
            discarded_readme.message
        );
        assert_eq!(
            fs::read_to_string(repo.path().join("README.md")).expect("read readme"),
            "initial\n"
        );

        fs::write(repo.path().join("README.md"), "bulk changed\n").expect("bulk modify readme");
        fs::write(repo.path().join("bulk.txt"), "bulk\n").expect("write bulk");
        let staged_all = git_stage_all_sync(workdir.clone()).expect("stage all");
        assert!(staged_all.ok, "stage all failed: {}", staged_all.message);
        assert!(
            staged_all.state.dirty_counts.staged >= 2,
            "stage all counts: {:?}",
            staged_all.state.dirty_counts
        );
        let unstaged_all = git_unstage_all_sync(workdir.clone()).expect("unstage all");
        assert!(
            unstaged_all.ok,
            "unstage all failed: {}",
            unstaged_all.message
        );
        assert_eq!(unstaged_all.state.dirty_counts.staged, 0);
        assert!(unstaged_all.state.dirty_counts.unstaged >= 1);
        assert!(unstaged_all.state.dirty_counts.untracked >= 1);
        let discarded_all = git_discard_all_sync(workdir.clone()).expect("discard all");
        assert!(
            discarded_all.ok,
            "discard all failed: {}",
            discarded_all.message
        );
        assert!(discarded_all.state.entries.is_empty());
        assert!(!repo.path().join("bulk.txt").exists());
        assert_eq!(
            fs::read_to_string(repo.path().join("README.md"))
                .expect("read readme after discard all"),
            "initial\n"
        );

        fs::write(repo.path().join("ignore.log"), "ignored\n").expect("write ignored file");
        let ignored =
            git_add_to_gitignore_sync(workdir.clone(), "ignore.log".to_string()).expect("ignore");
        assert!(ignored.ok, "add gitignore failed: {}", ignored.message);
        let ignored_duplicate =
            git_add_to_gitignore_sync(workdir.clone(), "ignore.log".to_string())
                .expect("ignore duplicate");
        assert!(
            ignored_duplicate.ok,
            "duplicate gitignore failed: {}",
            ignored_duplicate.message
        );
        let ignored_tracked = git_add_to_gitignore_sync(workdir.clone(), "README.md".to_string())
            .expect("ignore tracked");
        assert!(
            ignored_tracked.ok,
            "tracked gitignore failed: {}",
            ignored_tracked.message
        );
        let gitignore = fs::read_to_string(repo.path().join(".gitignore")).expect("read gitignore");
        assert_eq!(
            gitignore
                .lines()
                .filter(|line| *line == "/ignore.log")
                .count(),
            1
        );
        assert!(gitignore.lines().any(|line| line == "/README.md"));
    }

    #[test]
    fn git_commit_details_parse_message_stats_and_remote() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let remote = tempfile::tempdir().expect("bare remote temp dir");
        run_temp_git(remote.path(), &["init", "--bare"]);
        let workdir = repo.path().to_string_lossy().to_string();
        let saved =
            git_set_remote_sync(workdir.clone(), remote.path().to_string_lossy().to_string())
                .expect("set origin remote");
        assert!(saved.ok, "set remote failed: {}", saved.message);

        fs::write(repo.path().join("details.txt"), "one\ntwo\n").expect("write details file");
        run_temp_git(repo.path(), &["add", "details.txt"]);
        run_temp_git(
            repo.path(),
            &["commit", "-m", "details subject", "-m", "details body"],
        );
        let sha = git_success(&workdir, &["rev-parse", "HEAD"])
            .expect("read head")
            .stdout;

        let details = git_commit_details_sync(workdir, sha).expect("commit details");
        assert_eq!(details.commit.subject, "details subject");
        assert_eq!(details.commit.body, "details body");
        assert_eq!(details.commit.remote_name, "origin");
        assert!(
            details
                .commit
                .files
                .iter()
                .any(|file| { file.path == "details.txt" && file.status == "A" }),
            "commit files: {:?}",
            details.commit.files
        );
        assert_eq!(details.commit.files_changed, 1);
        assert_eq!(details.commit.insertions, 2);
        assert_eq!(details.commit.deletions, 0);
        assert!(
            details.commit.stat.contains("details.txt"),
            "commit stat: {}",
            details.commit.stat
        );
    }

    #[test]
    fn git_history_and_details_expand_merge_commit_files() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let workdir = repo.path().to_string_lossy().to_string();
        let initial = git_status_sync(workdir.clone()).expect("initial status");

        run_temp_git(repo.path(), &["checkout", "-b", "feature-merge-files"]);
        fs::write(repo.path().join("feature.txt"), "feature\n").expect("write feature file");
        run_temp_git(repo.path(), &["add", "feature.txt"]);
        run_temp_git(repo.path(), &["commit", "-m", "feature branch file"]);

        run_temp_git(repo.path(), &["checkout", initial.head.as_str()]);
        fs::write(repo.path().join("main.txt"), "main\n").expect("write main file");
        run_temp_git(repo.path(), &["add", "main.txt"]);
        run_temp_git(repo.path(), &["commit", "-m", "main branch file"]);

        run_temp_git(
            repo.path(),
            &[
                "merge",
                "--no-ff",
                "-m",
                "merge feature files",
                "feature-merge-files",
            ],
        );
        let merge_sha = git_success(&workdir, &["rev-parse", "HEAD"])
            .expect("read merge head")
            .stdout;

        let history = git_log_sync(workdir.clone(), Some(10), None).expect("git log");
        let merge_commit = history
            .commits
            .iter()
            .find(|commit| commit.subject == "merge feature files")
            .expect("merge commit should be in log");
        assert_eq!(merge_commit.parents.len(), 2);
        assert_eq!(merge_commit.file_count, merge_commit.files.len());
        assert!(
            merge_commit
                .files
                .iter()
                .any(|file| file.path == "feature.txt" && file.status == "A"),
            "merge commit files: {:?}",
            merge_commit.files
        );
        assert!(
            !merge_commit
                .files
                .iter()
                .any(|file| file.path == "main.txt"),
            "merge commit should use first-parent files: {:?}",
            merge_commit.files
        );

        let details = git_commit_details_sync(workdir, merge_sha).expect("merge details");
        assert_eq!(details.commit.file_count, details.commit.files.len());
        assert!(
            details
                .commit
                .files
                .iter()
                .any(|file| file.path == "feature.txt" && file.status == "A"),
            "merge details files: {:?}",
            details.commit.files
        );
    }

    #[test]
    fn git_log_supports_skip_pagination() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let workdir = repo.path().to_string_lossy().to_string();

        for index in 1..=4 {
            let file_name = format!("page-{index}.txt");
            fs::write(repo.path().join(&file_name), format!("page {index}\n"))
                .expect("write page file");
            run_temp_git(repo.path(), &["add", &file_name]);
            run_temp_git(repo.path(), &["commit", "-m", &format!("page {index}")]);
        }

        let first_page = git_log_sync(workdir.clone(), Some(2), Some(0)).expect("first page");
        let second_page = git_log_sync(workdir, Some(2), Some(2)).expect("second page");
        let first_subjects = first_page
            .commits
            .iter()
            .map(|commit| commit.subject.as_str())
            .collect::<Vec<_>>();
        let second_subjects = second_page
            .commits
            .iter()
            .map(|commit| commit.subject.as_str())
            .collect::<Vec<_>>();

        assert_eq!(first_subjects, vec!["page 4", "page 3"]);
        assert_eq!(second_subjects, vec!["page 2", "page 1"]);
        let first_shas = first_page
            .commits
            .iter()
            .map(|commit| commit.sha.as_str())
            .collect::<HashSet<_>>();
        assert!(
            second_page
                .commits
                .iter()
                .all(|commit| !first_shas.contains(commit.sha.as_str())),
            "pages should not overlap"
        );
    }

    #[test]
    fn git_log_uses_local_branch_fallback_for_history_graph_when_upstream_missing() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let workdir = repo.path().to_string_lossy().to_string();
        let initial = git_status_sync(workdir.clone()).expect("initial status");
        let initial_sha = git_success(&workdir, &["rev-parse", initial.head.as_str()])
            .expect("read initial branch sha")
            .stdout
            .trim()
            .to_string();

        run_temp_git(repo.path(), &["checkout", "-b", "feature/history-graph"]);
        fs::write(repo.path().join("feature-history.txt"), "feature\n")
            .expect("write feature file");
        run_temp_git(repo.path(), &["add", "feature-history.txt"]);
        run_temp_git(repo.path(), &["commit", "-m", "feature history graph"]);

        run_temp_git(repo.path(), &["checkout", initial.head.as_str()]);
        fs::write(repo.path().join("main-history.txt"), "main\n").expect("write main file");
        run_temp_git(repo.path(), &["add", "main-history.txt"]);
        run_temp_git(repo.path(), &["commit", "-m", "main history graph"]);

        run_temp_git(repo.path(), &["checkout", "feature/history-graph"]);
        let history = git_log_sync(workdir, Some(10), None).expect("git log");
        assert!(
            history.state.upstream.trim().is_empty(),
            "test branch should not have upstream: {}",
            history.state.upstream
        );
        assert_eq!(history.history_base_ref, "");
        assert_eq!(history.history_remote_ref, initial.head);
        assert_eq!(history.history_ahead, 1);
        assert_eq!(history.history_behind, 1);
        assert_eq!(history.merge_base, initial_sha);
        let subjects = history
            .commits
            .iter()
            .map(|commit| commit.subject.as_str())
            .collect::<Vec<_>>();
        assert!(
            subjects.contains(&"feature history graph") && subjects.contains(&"main history graph"),
            "history subjects should include both sides of the fallback comparison: {subjects:?}"
        );
    }

    #[test]
    fn git_create_branch_can_start_from_commit() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let workdir = repo.path().to_string_lossy().to_string();
        let initial_sha = git_success(&workdir, &["rev-parse", "HEAD"])
            .expect("read initial head")
            .stdout;

        fs::write(repo.path().join("later.txt"), "later\n").expect("write later file");
        run_temp_git(repo.path(), &["add", "later.txt"]);
        run_temp_git(repo.path(), &["commit", "-m", "later"]);

        let created = git_create_branch_sync(
            workdir.clone(),
            "commit/initial".to_string(),
            Some(initial_sha.clone()),
        )
        .expect("create branch from commit");
        assert!(created.ok, "create branch failed: {}", created.message);
        assert_eq!(created.state.head, "commit/initial");
        let branch_head = git_success(&workdir, &["rev-parse", "HEAD"])
            .expect("read branch head")
            .stdout;
        assert_eq!(branch_head, initial_sha);
    }

    #[test]
    fn git_compare_commit_with_remote_uses_origin_fallback() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let remote = tempfile::tempdir().expect("bare remote temp dir");
        run_temp_git(remote.path(), &["init", "--bare"]);
        let workdir = repo.path().to_string_lossy().to_string();
        let saved =
            git_set_remote_sync(workdir.clone(), remote.path().to_string_lossy().to_string())
                .expect("set origin remote");
        assert!(saved.ok, "set remote failed: {}", saved.message);
        let pushed = git_push_sync(workdir.clone()).expect("initial push");
        assert!(pushed.ok, "initial push failed: {}", pushed.message);
        if let Err(error) = git_success(&workdir, &["branch", "--unset-upstream"]) {
            assert!(
                error.contains("no upstream"),
                "unexpected unset-upstream error: {error}"
            );
        }

        let state_without_upstream = git_status_sync(workdir.clone()).expect("status");
        assert!(
            state_without_upstream.upstream.is_empty(),
            "upstream should be empty for fallback test: {}",
            state_without_upstream.upstream
        );
        fs::write(repo.path().join("remote-compare.txt"), "compare\n").expect("write compare file");
        run_temp_git(repo.path(), &["add", "remote-compare.txt"]);
        run_temp_git(repo.path(), &["commit", "-m", "compare local"]);
        let sha = git_success(&workdir, &["rev-parse", "HEAD"])
            .expect("read compare head")
            .stdout;

        let diff = git_compare_commit_with_remote_sync(workdir, sha).expect("remote compare");
        assert!(
            diff.base_ref.starts_with("origin/"),
            "base ref should use origin fallback: {}",
            diff.base_ref
        );
        assert_eq!(diff.mode, "remote_compare");
        assert!(
            diff.patch.contains("remote-compare.txt") && diff.patch.contains("+compare"),
            "remote compare patch:\n{}",
            diff.patch
        );
    }

    #[test]
    fn git_switch_remote_branch_uses_existing_local_branch() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let remote = tempfile::tempdir().expect("bare remote temp dir");
        run_temp_git(remote.path(), &["init", "--bare"]);
        let remote_url = remote.path().to_string_lossy().to_string();
        let workdir = repo.path().to_string_lossy().to_string();
        let initial = git_status_sync(workdir.clone()).expect("initial status");

        let created =
            git_create_branch_sync(workdir.clone(), "test".to_string(), None).expect("create test");
        assert!(created.ok, "create test failed: {}", created.message);
        run_temp_git(
            repo.path(),
            &["remote", "add", "origin", remote_url.as_str()],
        );
        run_temp_git(repo.path(), &["push", "-u", "origin", "test"]);

        let switched_back =
            git_switch_branch_sync(workdir.clone(), initial.head, None).expect("switch back");
        assert!(
            switched_back.ok,
            "switch back failed: {}",
            switched_back.message
        );

        let switched_remote = git_switch_branch_sync(
            workdir,
            "origin/test".to_string(),
            Some("remote".to_string()),
        )
        .expect("switch remote");
        assert!(
            switched_remote.ok,
            "switch remote failed: {}",
            switched_remote.message
        );
        assert_eq!(switched_remote.state.head, "test");
    }

    #[test]
    fn git_discard_handles_added_nested_file_and_staged_rename() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let workdir = repo.path().to_string_lossy().to_string();
        fs::create_dir_all(repo.path().join("src")).expect("create src dir");
        fs::write(repo.path().join("src/generated.txt"), "generated\n")
            .expect("write generated file");

        let staged_added =
            git_stage_sync(workdir.clone(), "src/generated.txt".to_string()).expect("stage added");
        assert!(
            staged_added.ok,
            "stage added failed: {}",
            staged_added.message
        );
        let discarded_added =
            git_discard_sync(workdir.clone(), "src/generated.txt".to_string(), None)
                .expect("discard added");
        assert!(
            discarded_added.ok,
            "discard added failed: {}",
            discarded_added.message
        );
        assert!(!repo.path().join("src/generated.txt").exists());
        assert!(discarded_added.state.entries.is_empty());

        run_temp_git(repo.path(), &["mv", "README.md", "README-renamed.md"]);
        let renamed_status = git_status_sync(workdir.clone()).expect("renamed status");
        let renamed_entry = renamed_status
            .entries
            .iter()
            .find(|entry| entry.kind == "renamed")
            .expect("renamed entry");
        assert_eq!(renamed_entry.path, "README-renamed.md");
        assert_eq!(renamed_entry.old_path.as_deref(), Some("README.md"));

        let discarded_rename = git_discard_sync(
            workdir,
            renamed_entry.path.clone(),
            renamed_entry.old_path.clone(),
        )
        .expect("discard rename");
        assert!(
            discarded_rename.ok,
            "discard rename failed: {}",
            discarded_rename.message
        );
        assert!(repo.path().join("README.md").exists());
        assert!(!repo.path().join("README-renamed.md").exists());
        assert!(discarded_rename.state.entries.is_empty());
    }

    #[test]
    fn git_set_remote_guides_push_without_origin() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let remote = tempfile::tempdir().expect("bare remote temp dir");
        run_temp_git(remote.path(), &["init", "--bare"]);
        let workdir = repo.path().to_string_lossy().to_string();

        let missing_origin_push = git_push_sync(workdir.clone()).expect("push without origin");
        assert!(!missing_origin_push.ok);
        assert!(
            missing_origin_push.message.contains("找不到 origin remote"),
            "unexpected push message: {}",
            missing_origin_push.message
        );

        let saved =
            git_set_remote_sync(workdir.clone(), remote.path().to_string_lossy().to_string())
                .expect("set origin remote");
        assert!(saved.ok, "set remote failed: {}", saved.message);
        let pushed = git_push_sync(workdir).expect("push with configured origin");
        assert!(pushed.ok, "push failed: {}", pushed.message);
        assert!(
            pushed.state.upstream.starts_with("origin/"),
            "upstream should be configured after push: {}",
            pushed.state.upstream
        );
    }

    #[test]
    fn git_log_marks_unpushed_commits_local_only() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let remote = tempfile::tempdir().expect("bare remote temp dir");
        run_temp_git(remote.path(), &["init", "--bare"]);
        let workdir = repo.path().to_string_lossy().to_string();

        let saved =
            git_set_remote_sync(workdir.clone(), remote.path().to_string_lossy().to_string())
                .expect("set origin remote");
        assert!(saved.ok, "set remote failed: {}", saved.message);
        let pushed = git_push_sync(workdir.clone()).expect("initial push");
        assert!(pushed.ok, "initial push failed: {}", pushed.message);

        fs::write(repo.path().join("local.txt"), "local\n").expect("write local file");
        run_temp_git(repo.path(), &["add", "local.txt"]);
        run_temp_git(repo.path(), &["commit", "-m", "local only"]);

        let history = git_log_sync(workdir, Some(10), None).expect("git log");
        let local_commit = history
            .commits
            .iter()
            .find(|commit| commit.subject == "local only")
            .expect("local commit");
        assert!(
            local_commit.local_only,
            "unpushed commit should be local-only"
        );
        let pushed_commit = history
            .commits
            .iter()
            .find(|commit| commit.subject == "initial")
            .expect("pushed commit");
        assert!(
            !pushed_commit.local_only,
            "pushed commit should not be local-only"
        );
    }

    #[test]
    fn git_log_uses_origin_current_branch_when_upstream_missing() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let remote = tempfile::tempdir().expect("bare remote temp dir");
        run_temp_git(remote.path(), &["init", "--bare"]);
        let workdir = repo.path().to_string_lossy().to_string();

        let saved =
            git_set_remote_sync(workdir.clone(), remote.path().to_string_lossy().to_string())
                .expect("set origin remote");
        assert!(saved.ok, "set remote failed: {}", saved.message);
        let initial = git_status_sync(workdir.clone()).expect("initial status");
        run_temp_git(repo.path(), &["checkout", "-b", "feature/local-only"]);
        run_temp_git(repo.path(), &["config", "push.autoSetupRemote", "false"]);
        run_temp_git(repo.path(), &["push", "origin", "feature/local-only"]);
        run_temp_git(repo.path(), &["fetch", "origin", "feature/local-only"]);
        let state = git_status_sync(workdir.clone()).expect("git status");
        assert!(
            state.upstream.trim().is_empty(),
            "test branch should not have upstream: {}",
            state.upstream
        );

        fs::write(repo.path().join("feature.txt"), "feature\n").expect("write feature file");
        run_temp_git(repo.path(), &["add", "feature.txt"]);
        run_temp_git(repo.path(), &["commit", "-m", "feature local only"]);

        let remote_feature_sha = git_success(&workdir, &["rev-parse", "origin/feature/local-only"])
            .expect("read remote feature branch sha")
            .stdout
            .trim()
            .to_string();
        let history = git_log_sync(workdir, Some(10), None).expect("git log");
        assert_eq!(history.history_base_ref, initial.head);
        assert_eq!(history.history_remote_ref, "origin/feature/local-only");
        assert_eq!(history.history_ahead, 1);
        assert_eq!(history.history_behind, 0);
        assert_eq!(history.merge_base, remote_feature_sha);
        let local_commit = history
            .commits
            .iter()
            .find(|commit| commit.subject == "feature local only")
            .expect("local commit");
        assert!(
            local_commit.local_only,
            "unpushed feature commit should be local-only"
        );
        let pushed_commit = history
            .commits
            .iter()
            .find(|commit| commit.subject == "initial")
            .expect("pushed commit");
        assert!(
            !pushed_commit.local_only,
            "same-name origin branch should prevent pushed commit from being local-only"
        );
    }

    #[test]
    fn git_log_includes_remote_base_merge_outside_current_branch() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let workdir = repo.path().to_string_lossy().to_string();
        let initial = git_status_sync(workdir.clone()).expect("initial status");

        run_temp_git(repo.path(), &["checkout", "-b", "features"]);
        fs::write(repo.path().join("feature-1.txt"), "feature 1\n").expect("write feature 1");
        run_temp_git(repo.path(), &["add", "feature-1.txt"]);
        run_temp_git(repo.path(), &["commit", "-m", "feature one"]);

        run_temp_git(repo.path(), &["branch", "origin/features", "HEAD"]);
        run_temp_git(
            repo.path(),
            &["branch", "--set-upstream-to", "origin/features", "features"],
        );

        fs::write(repo.path().join("feature-2.txt"), "feature 2\n").expect("write feature 2");
        run_temp_git(repo.path(), &["add", "feature-2.txt"]);
        run_temp_git(repo.path(), &["commit", "-m", "feature two"]);

        run_temp_git(repo.path(), &["checkout", initial.head.as_str()]);
        run_temp_git(
            repo.path(),
            &[
                "merge",
                "--no-ff",
                "-m",
                "Merge pull request #52 from Stack-Cairn/features",
                "features",
            ],
        );
        let main_merge_sha = git_success(&workdir, &["rev-parse", "HEAD"])
            .expect("read main merge")
            .stdout
            .trim()
            .to_string();
        run_temp_git(repo.path(), &["branch", "origin/main", "HEAD"]);
        run_temp_git(repo.path(), &["checkout", "features"]);

        let history = git_log_sync(workdir, Some(10), None).expect("git log");
        assert_eq!(history.history_base_ref, "origin/main");
        assert_eq!(history.history_remote_ref, "origin/features");
        assert!(
            history.commits.iter().any(|commit| {
                commit.sha == main_merge_sha
                    && commit.subject == "Merge pull request #52 from Stack-Cairn/features"
            }),
            "history should include origin/main merge outside current branch: {:?}",
            history
                .commits
                .iter()
                .map(|commit| commit.subject.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn git_fetch_guides_without_remote() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let remote = tempfile::tempdir().expect("bare remote temp dir");
        run_temp_git(remote.path(), &["init", "--bare"]);
        let workdir = repo.path().to_string_lossy().to_string();

        let missing_remote_fetch = git_fetch_sync(workdir.clone()).expect("fetch without remote");
        assert!(!missing_remote_fetch.ok);
        assert!(
            missing_remote_fetch
                .message
                .contains(GIT_MISSING_REMOTE_MESSAGE),
            "unexpected fetch message: {}",
            missing_remote_fetch.message
        );

        let saved =
            git_set_remote_sync(workdir.clone(), remote.path().to_string_lossy().to_string())
                .expect("set origin remote");
        assert!(saved.ok, "set remote failed: {}", saved.message);
        let fetched = git_fetch_sync(workdir).expect("fetch with configured origin");
        assert!(fetched.ok, "fetch failed: {}", fetched.message);
    }

    #[test]
    fn git_set_remote_guides_pull_without_origin() {
        let Some(source) = init_temp_repo() else {
            return;
        };
        let remote = tempfile::tempdir().expect("bare remote temp dir");
        run_temp_git(remote.path(), &["init", "--bare"]);
        let remote_url = remote.path().to_string_lossy().to_string();
        run_temp_git(
            source.path(),
            &["remote", "add", "origin", remote_url.as_str()],
        );
        run_temp_git(source.path(), &["push", "-u", "origin", "HEAD"]);

        let clone_parent = tempfile::tempdir().expect("clone parent");
        run_temp_git(
            clone_parent.path(),
            &["clone", remote_url.as_str(), "local-copy"],
        );
        let clone_path = clone_parent.path().join("local-copy");
        run_temp_git(&clone_path, &["remote", "remove", "origin"]);
        if let Err(error) = git_success(
            &clone_path.to_string_lossy(),
            &["branch", "--unset-upstream"],
        ) {
            assert!(
                error.contains("no upstream"),
                "unexpected unset-upstream error: {error}"
            );
        }
        assert!(
            git_status_sync(clone_path.to_string_lossy().to_string())
                .expect("pull test status")
                .upstream
                .is_empty(),
            "clone should not keep upstream after origin removal"
        );

        fs::write(source.path().join("README.md"), "updated\n").expect("update readme");
        run_temp_git(source.path(), &["add", "README.md"]);
        run_temp_git(source.path(), &["commit", "-m", "update"]);
        run_temp_git(source.path(), &["push"]);

        let workdir = clone_path.to_string_lossy().to_string();
        let missing_origin_pull = git_pull_sync(workdir.clone()).expect("pull without origin");
        assert!(!missing_origin_pull.ok);
        assert!(
            missing_origin_pull.message.contains("找不到 origin remote"),
            "unexpected pull message: {}",
            missing_origin_pull.message
        );

        let saved = git_set_remote_sync(workdir.clone(), remote_url).expect("set origin remote");
        assert!(saved.ok, "set remote failed: {}", saved.message);
        let pulled = git_pull_sync(workdir).expect("pull with configured origin");
        assert!(pulled.ok, "pull failed: {}", pulled.message);
    }

    #[test]
    fn git_delete_branch_handles_merged_current_and_unmerged_branches() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let workdir = repo.path().to_string_lossy().to_string();
        let initial = git_status_sync(workdir.clone()).expect("initial status");

        run_temp_git(repo.path(), &["branch", "merged-branch"]);
        let deleted = git_delete_branch_sync(workdir.clone(), "merged-branch".to_string(), None)
            .expect("delete merged branch");
        assert!(deleted.ok, "delete merged failed: {}", deleted.message);
        let branches = git_branches_sync(workdir.clone()).expect("branch list");
        assert!(
            branches
                .branches
                .iter()
                .all(|branch| branch.name != "merged-branch"),
            "merged-branch should be gone: {:?}",
            branches
                .branches
                .iter()
                .map(|branch| branch.name.as_str())
                .collect::<Vec<_>>()
        );

        let refused = git_delete_branch_sync(workdir.clone(), initial.head.clone(), None)
            .expect_err("deleting current branch should fail");
        assert!(refused.contains("不能删除当前检出的分支"), "{refused}");

        run_temp_git(repo.path(), &["checkout", "-b", "unmerged-branch"]);
        fs::write(repo.path().join("unmerged.txt"), "unmerged\n").expect("write unmerged file");
        run_temp_git(repo.path(), &["add", "unmerged.txt"]);
        run_temp_git(repo.path(), &["commit", "-m", "unmerged commit"]);
        run_temp_git(repo.path(), &["checkout", initial.head.as_str()]);

        let soft_deleted =
            git_delete_branch_sync(workdir.clone(), "unmerged-branch".to_string(), Some(false))
                .expect("soft delete unmerged branch");
        assert!(!soft_deleted.ok, "-d should refuse unmerged branch");
        assert!(
            soft_deleted.message.contains("not fully merged"),
            "unexpected delete message: {}",
            soft_deleted.message
        );
        let force_deleted =
            git_delete_branch_sync(workdir, "unmerged-branch".to_string(), Some(true))
                .expect("force delete unmerged branch");
        assert!(
            force_deleted.ok,
            "force delete failed: {}",
            force_deleted.message
        );
    }

    #[test]
    fn git_rename_branch_renames_local_and_current_branch() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let workdir = repo.path().to_string_lossy().to_string();
        let initial = git_status_sync(workdir.clone()).expect("initial status");

        run_temp_git(repo.path(), &["branch", "rename-source"]);
        let renamed = git_rename_branch_sync(
            workdir.clone(),
            "rename-source".to_string(),
            "rename-target".to_string(),
        )
        .expect("rename local branch");
        assert!(renamed.ok, "rename failed: {}", renamed.message);
        let branches = git_branches_sync(workdir.clone()).expect("branch list");
        let names = branches
            .branches
            .iter()
            .map(|branch| branch.name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"rename-target"), "branches: {names:?}");
        assert!(!names.contains(&"rename-source"), "branches: {names:?}");

        let renamed_current =
            git_rename_branch_sync(workdir, initial.head.clone(), "renamed-current".to_string())
                .expect("rename current branch");
        assert!(
            renamed_current.ok,
            "rename current failed: {}",
            renamed_current.message
        );
        assert_eq!(renamed_current.state.head, "renamed-current");
    }

    #[test]
    fn git_stash_push_and_pop_roundtrip() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let workdir = repo.path().to_string_lossy().to_string();
        fs::write(repo.path().join("README.md"), "stash change\n").expect("modify readme");
        fs::write(repo.path().join("stash-untracked.txt"), "untracked\n")
            .expect("write untracked file");

        let pushed = git_stash_push_sync(workdir.clone(), None).expect("stash push");
        assert!(pushed.ok, "stash push failed: {}", pushed.message);
        assert!(
            pushed.state.entries.is_empty(),
            "worktree should be clean after stash push: {:?}",
            pushed.state.entries
        );
        let status = git_status_sync(workdir.clone()).expect("status after stash push");
        assert!(status.entries.is_empty());
        assert_eq!(status.stash_count, 1);

        let popped = git_stash_pop_sync(workdir.clone()).expect("stash pop");
        assert!(popped.ok, "stash pop failed: {}", popped.message);
        assert_eq!(popped.state.stash_count, 0);
        assert_eq!(
            fs::read_to_string(repo.path().join("README.md")).expect("read readme"),
            "stash change\n"
        );
        assert!(repo.path().join("stash-untracked.txt").exists());

        let empty_pop = git_stash_pop_sync(workdir).expect("pop empty stash");
        assert!(!empty_pop.ok, "popping empty stash should report failure");
    }

    #[test]
    fn git_create_branch_accepts_ref_start_points() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let workdir = repo.path().to_string_lossy().to_string();
        let initial = git_status_sync(workdir.clone()).expect("initial status");
        let initial_sha = git_success(&workdir, &["rev-parse", "HEAD"])
            .expect("read initial head")
            .stdout;

        fs::write(repo.path().join("later.txt"), "later\n").expect("write later file");
        run_temp_git(repo.path(), &["add", "later.txt"]);
        run_temp_git(repo.path(), &["commit", "-m", "later"]);
        let later_sha = git_success(&workdir, &["rev-parse", "HEAD"])
            .expect("read later head")
            .stdout;

        let from_branch = git_create_branch_sync(
            workdir.clone(),
            "from-branch-name".to_string(),
            Some(initial.head.clone()),
        )
        .expect("create branch from branch name");
        assert!(
            from_branch.ok,
            "create from branch name failed: {}",
            from_branch.message
        );
        assert_eq!(from_branch.state.head, "from-branch-name");
        let branch_head = git_success(&workdir, &["rev-parse", "HEAD"])
            .expect("read branch head")
            .stdout;
        assert_eq!(branch_head, later_sha);

        run_temp_git(
            repo.path(),
            &[
                "update-ref",
                "refs/remotes/origin/base",
                initial_sha.as_str(),
            ],
        );
        let from_remote = git_create_branch_sync(
            workdir.clone(),
            "from-remote-ref".to_string(),
            Some("origin/base".to_string()),
        )
        .expect("create branch from remote ref");
        assert!(
            from_remote.ok,
            "create from remote ref failed: {}",
            from_remote.message
        );
        assert_eq!(from_remote.state.head, "from-remote-ref");
        let remote_head = git_success(&workdir, &["rev-parse", "HEAD"])
            .expect("read remote-ref head")
            .stdout;
        assert_eq!(remote_head, initial_sha);

        let bogus = git_create_branch_sync(
            workdir.clone(),
            "from-bogus".to_string(),
            Some("no-such-ref".to_string()),
        );
        assert!(bogus.is_err(), "bogus start point should error");
        let dashed =
            git_create_branch_sync(workdir, "from-dashed".to_string(), Some("-d".to_string()));
        assert!(dashed.is_err(), "dashed start point should error");
    }

    #[test]
    fn git_gateway_action_dispatches_branch_and_stash_actions() {
        let Some(repo) = init_temp_repo() else {
            return;
        };
        let workdir = repo.path().to_string_lossy().to_string();
        let initial = git_status_sync(workdir.clone()).expect("initial status");

        run_temp_git(repo.path(), &["branch", "gateway-branch"]);
        let renamed = git_gateway_action_sync(
            "rename_branch".to_string(),
            workdir.clone(),
            json!({"branch":"gateway-branch","newBranch":"gateway-renamed"}).to_string(),
        )
        .expect("rename via gateway");
        assert_eq!(renamed["ok"], json!(true), "rename response: {renamed}");

        run_temp_git(repo.path(), &["checkout", "gateway-renamed"]);
        fs::write(repo.path().join("gateway.txt"), "gateway\n").expect("write gateway file");
        run_temp_git(repo.path(), &["add", "gateway.txt"]);
        run_temp_git(repo.path(), &["commit", "-m", "gateway commit"]);
        run_temp_git(repo.path(), &["checkout", initial.head.as_str()]);

        let soft_deleted = git_gateway_action_sync(
            "delete_branch".to_string(),
            workdir.clone(),
            json!({"branch":"gateway-renamed"}).to_string(),
        )
        .expect("soft delete via gateway");
        assert_eq!(
            soft_deleted["ok"],
            json!(false),
            "soft delete response: {soft_deleted}"
        );
        let force_deleted = git_gateway_action_sync(
            "delete_branch".to_string(),
            workdir.clone(),
            json!({"branch":"gateway-renamed","force":true}).to_string(),
        )
        .expect("force delete via gateway");
        assert_eq!(
            force_deleted["ok"],
            json!(true),
            "force delete response: {force_deleted}"
        );

        fs::write(repo.path().join("README.md"), "gateway stash\n").expect("modify readme");
        let stashed = git_gateway_action_sync(
            "stash_push".to_string(),
            workdir.clone(),
            json!({"message":"gateway stash"}).to_string(),
        )
        .expect("stash push via gateway");
        assert_eq!(stashed["ok"], json!(true), "stash response: {stashed}");
        assert_eq!(
            stashed["state"]["stashCount"],
            json!(1),
            "stash response: {stashed}"
        );

        let popped = git_gateway_action_sync("stash_pop".to_string(), workdir, String::new())
            .expect("stash pop via gateway");
        assert_eq!(popped["ok"], json!(true), "pop response: {popped}");
        assert_eq!(
            popped["state"]["stashCount"],
            json!(0),
            "pop response: {popped}"
        );
    }
}
