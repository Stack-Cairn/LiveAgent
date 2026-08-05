//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 backend，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use backend::commands::git::*;
use backend::runtime::process::{
    configure_child_process_group, kill_child_process_tree_best_effort,
    terminate_process_tree_by_pid,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Instant;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tempfile::NamedTempFile;
use tempfile::TempDir;
use wait_timeout::ChildExt;

#[tauri::command(rename_all = "snake_case")]
pub async fn git_status(workdir: String) -> Result<GitRepositoryState, String> {
    backend::commands::git::git_status(workdir).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_discover_repositories(workdir: String) -> Result<GitRepositoryDiscovery, String> {
    backend::commands::git::git_discover_repositories(workdir).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_branches(workdir: String) -> Result<GitBranchesResponse, String> {
    backend::commands::git::git_branches(workdir).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_switch_branch(
    workdir: String,
    branch: String,
    kind: Option<String>,
) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_switch_branch(workdir, branch, kind).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_create_branch(
    workdir: String,
    branch: String,
    start_point: Option<String>,
) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_create_branch(workdir, branch, start_point).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_init(
    workdir: String,
    branch: Option<String>,
    user_name: Option<String>,
    user_email: Option<String>,
) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_init(workdir, branch, user_name, user_email).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_clone_repository(
    parent: String,
    name: String,
    remote_url: String,
    branch: Option<String>,
) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_clone_repository(parent, name, remote_url, branch).await
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_clone_repository_start(
    registry: tauri::State<'_, Arc<GitCloneTaskRegistry>>,
    parent: String,
    name: String,
    remote_url: String,
    branch: Option<String>,
) -> Result<GitCloneTask, String> {
    backend::commands::git::git_clone_repository_start(
        registry.inner(),
        parent,
        name,
        remote_url,
        branch,
    )
}

#[tauri::command]
pub fn git_clone_repository_tasks(
    registry: tauri::State<'_, Arc<GitCloneTaskRegistry>>,
) -> Result<Vec<GitCloneTask>, String> {
    backend::commands::git::git_clone_repository_tasks(registry.inner())
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_clone_repository_cancel(
    registry: tauri::State<'_, Arc<GitCloneTaskRegistry>>,
    task_id: String,
) -> Result<GitCloneTask, String> {
    backend::commands::git::git_clone_repository_cancel(registry.inner(), task_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn git_clone_repository_dismiss(
    registry: tauri::State<'_, Arc<GitCloneTaskRegistry>>,
    task_id: String,
) -> Result<Vec<GitCloneTask>, String> {
    backend::commands::git::git_clone_repository_dismiss(registry.inner(), task_id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_list_remote_branches(
    remote_url: String,
) -> Result<GitRemoteBranchesResponse, String> {
    backend::commands::git::git_list_remote_branches(remote_url).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_diff(
    workdir: String,
    mode: Option<String>,
    path: Option<String>,
) -> Result<GitDiffResponse, String> {
    backend::commands::git::git_diff(workdir, mode, path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_log(
    workdir: String,
    limit: Option<usize>,
    skip: Option<usize>,
) -> Result<GitLogResponse, String> {
    backend::commands::git::git_log(workdir, limit, skip).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_commit_details(
    workdir: String,
    commit: String,
) -> Result<GitCommitDetailsResponse, String> {
    backend::commands::git::git_commit_details(workdir, commit).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_compare_commit_with_remote(
    workdir: String,
    commit: String,
) -> Result<GitDiffResponse, String> {
    backend::commands::git::git_compare_commit_with_remote(workdir, commit).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_commit_diff(
    workdir: String,
    commit: String,
    path: Option<String>,
) -> Result<GitDiffResponse, String> {
    backend::commands::git::git_commit_diff(workdir, commit, path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_stage(workdir: String, path: String) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_stage(workdir, path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_stage_all(workdir: String) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_stage_all(workdir).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_unstage(workdir: String, path: String) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_unstage(workdir, path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_unstage_all(workdir: String) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_unstage_all(workdir).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_discard(
    workdir: String,
    path: String,
    old_path: Option<String>,
) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_discard(workdir, path, old_path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_discard_all(workdir: String) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_discard_all(workdir).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_add_to_gitignore(
    workdir: String,
    path: String,
) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_add_to_gitignore(workdir, path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_open_system_file_location(
    workdir: String,
    path: String,
) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_open_system_file_location(workdir, path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_commit(workdir: String, message: String) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_commit(workdir, message).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_fetch(workdir: String) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_fetch(workdir).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_pull(workdir: String) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_pull(workdir).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_set_remote(
    workdir: String,
    remote_url: String,
) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_set_remote(workdir, remote_url).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_push(workdir: String) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_push(workdir).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_delete_branch(
    workdir: String,
    branch: String,
    force: Option<bool>,
) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_delete_branch(workdir, branch, force).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_rename_branch(
    workdir: String,
    branch: String,
    new_branch: String,
) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_rename_branch(workdir, branch, new_branch).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_stash_push(
    workdir: String,
    message: Option<String>,
) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_stash_push(workdir, message).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_stash_pop(workdir: String) -> Result<GitOperationResponse, String> {
    backend::commands::git::git_stash_pop(workdir).await
}
