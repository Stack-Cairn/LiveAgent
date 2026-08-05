//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 backend，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use backend::commands::fs::*;
use backend::runtime::platform::expand_tilde_path;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use lopdf::Document as PdfDocument;
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::Url;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Write;
use std::io::{self, Cursor, Read, Seek};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use std::time::UNIX_EPOCH;
use thiserror::Error;
use zip::write::SimpleFileOptions;
use zip::ZipArchive;

#[tauri::command]
pub async fn fs_read_image_source(
    workdir: String,
    source: String,
    source_type: Option<String>,
    mime_type: Option<String>,
) -> Result<ReadResponse, FsCommandError> {
    backend::commands::fs::fs_read_image_source(workdir, source, source_type, mime_type).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_read_workspace_image(
    workdir: String,
    path: String,
) -> Result<ReadResponse, FsCommandError> {
    backend::commands::fs::fs_read_workspace_image(workdir, path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_read_text(
    workdir: String,
    path: String,
    start_line: Option<usize>,
    limit: Option<usize>,
    page_start: Option<usize>,
    page_limit: Option<usize>,
    cell_start: Option<usize>,
    cell_limit: Option<usize>,
) -> Result<ReadResponse, FsCommandError> {
    backend::commands::fs::fs_read_text(
        workdir, path, start_line, limit, page_start, page_limit, cell_start, cell_limit,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_read_editable_text(
    workdir: String,
    path: String,
) -> Result<ReadEditableTextResponse, FsCommandError> {
    backend::commands::fs::fs_read_editable_text(workdir, path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_path_status(
    workdir: String,
    path: String,
) -> Result<PathStatusResponse, FsCommandError> {
    backend::commands::fs::fs_path_status(workdir, path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_write_text(
    workdir: String,
    path: String,
    content: String,
    mode: String,
    expected_mtime_ms: Option<u64>,
    expected_content_hash: Option<String>,
) -> Result<WriteTextResponse, FsCommandError> {
    backend::commands::fs::fs_write_text(
        workdir,
        path,
        content,
        mode,
        expected_mtime_ms,
        expected_content_hash,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_edit_text(
    workdir: String,
    path: String,
    old_string: String,
    new_string: String,
    expected_replacements: Option<usize>,
    replace_all: Option<bool>,
    expected_mtime_ms: Option<u64>,
    expected_content_hash: Option<String>,
) -> Result<EditTextResponse, FsCommandError> {
    backend::commands::fs::fs_edit_text(
        workdir,
        path,
        old_string,
        new_string,
        expected_replacements,
        replace_all,
        expected_mtime_ms,
        expected_content_hash,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_delete(workdir: String, path: String) -> Result<DeleteResponse, FsCommandError> {
    backend::commands::fs::fs_delete(workdir, path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_open_workspace_path(
    workdir: String,
    path: String,
    mode: Option<String>,
) -> Result<OpenWorkspacePathResponse, FsCommandError> {
    backend::commands::fs::fs_open_workspace_path(workdir, path, mode).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_create_dir(
    workdir: String,
    path: String,
) -> Result<CreateDirResponse, FsCommandError> {
    backend::commands::fs::fs_create_dir(workdir, path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_rename(
    workdir: String,
    from_path: String,
    to_path: String,
) -> Result<RenameResponse, FsCommandError> {
    backend::commands::fs::fs_rename(workdir, from_path, to_path).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_roots() -> Result<FsRootsResponse, String> {
    backend::commands::fs::fs_roots().await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_list_dirs(
    path: String,
    max_results: Option<usize>,
) -> Result<FsListDirsResponse, String> {
    backend::commands::fs::fs_list_dirs(path, max_results).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_list(
    workdir: String,
    path: Option<String>,
    depth: Option<usize>,
    offset: Option<usize>,
    max_results: Option<usize>,
    show_hidden: Option<bool>,
) -> Result<ListResponse, FsCommandError> {
    backend::commands::fs::fs_list(workdir, path, depth, offset, max_results, show_hidden).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_glob(
    workdir: String,
    path: Option<String>,
    pattern: String,
    offset: Option<usize>,
    max_results: Option<usize>,
    sort_by: Option<String>,
) -> Result<GlobResponse, FsCommandError> {
    backend::commands::fs::fs_glob(workdir, path, pattern, offset, max_results, sort_by).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_grep(
    workdir: String,
    path: Option<String>,
    pattern: String,
    file_pattern: Option<String>,
    ignore_case: Option<bool>,
    output_mode: Option<String>,
    head_limit: Option<usize>,
    offset: Option<usize>,
    context: Option<usize>,
    multiline: Option<bool>,
) -> Result<GrepResponse, FsCommandError> {
    backend::commands::fs::fs_grep(
        workdir,
        path,
        pattern,
        file_pattern,
        ignore_case,
        output_mode,
        head_limit,
        offset,
        context,
        multiline,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_mention_list(
    workdir: String,
    max_results: Option<usize>,
    query: Option<String>,
    show_hidden: Option<bool>,
) -> Result<MentionListResponse, String> {
    backend::commands::fs::fs_mention_list(workdir, max_results, query, show_hidden).await
}
