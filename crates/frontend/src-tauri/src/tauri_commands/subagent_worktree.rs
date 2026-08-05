//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 backend，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use backend::commands::subagent_worktree::*;
use backend::runtime::process::configure_child_process_group;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[tauri::command]
pub async fn subagent_worktree_create(
    input: SubagentWorktreeCreateInput,
) -> Result<SubagentWorktreeCreateResponse, String> {
    backend::commands::subagent_worktree::subagent_worktree_create(input).await
}

#[tauri::command]
pub async fn subagent_worktree_status(
    input: SubagentWorktreeStatusInput,
) -> Result<SubagentWorktreeStatusResponse, String> {
    backend::commands::subagent_worktree::subagent_worktree_status(input).await
}

#[tauri::command]
pub async fn subagent_worktree_apply(
    input: SubagentWorktreeApplyInput,
) -> Result<SubagentWorktreeApplyResponse, String> {
    backend::commands::subagent_worktree::subagent_worktree_apply(input).await
}

#[tauri::command]
pub async fn subagent_worktree_cleanup(
    input: SubagentWorktreeCleanupInput,
) -> Result<SubagentWorktreeCleanupItem, String> {
    backend::commands::subagent_worktree::subagent_worktree_cleanup(input).await
}
