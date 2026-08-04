//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use agent_core::commands::sftp::*;
use agent_core::runtime::sftp::{
    SftpActionResponse, SftpListResponse, SftpReadTextResponse, SftpSessionRegistry,
    SftpStatResponse, SftpTransferResponse,
};
use std::sync::Arc;

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_list(
    registry: tauri::State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    path: Option<String>,
) -> Result<SftpListResponse, String> {
    agent_core::commands::sftp::sftp_list(
        registry.inner(),
        session_id,
        project_path_key,
        workdir,
        side,
        path,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_stat(
    registry: tauri::State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    path: Option<String>,
) -> Result<SftpStatResponse, String> {
    agent_core::commands::sftp::sftp_stat(
        registry.inner(),
        session_id,
        project_path_key,
        workdir,
        side,
        path,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_read_text(
    registry: tauri::State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    path: String,
    offset: Option<u64>,
    max_bytes: Option<usize>,
) -> Result<SftpReadTextResponse, String> {
    agent_core::commands::sftp::sftp_read_text(
        registry.inner(),
        session_id,
        project_path_key,
        path,
        offset,
        max_bytes,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_write_text(
    registry: tauri::State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    path: String,
    content: String,
    overwrite: Option<bool>,
    create_parent_dirs: Option<bool>,
) -> Result<SftpActionResponse, String> {
    agent_core::commands::sftp::sftp_write_text(
        registry.inner(),
        session_id,
        project_path_key,
        path,
        content,
        overwrite,
        create_parent_dirs,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_mkdir(
    registry: tauri::State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    path: String,
) -> Result<SftpActionResponse, String> {
    agent_core::commands::sftp::sftp_mkdir(
        registry.inner(),
        session_id,
        project_path_key,
        workdir,
        side,
        path,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_rename(
    registry: tauri::State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    from_path: String,
    to_path: String,
) -> Result<SftpActionResponse, String> {
    agent_core::commands::sftp::sftp_rename(
        registry.inner(),
        session_id,
        project_path_key,
        workdir,
        side,
        from_path,
        to_path,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_delete(
    registry: tauri::State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    path: String,
    recursive: Option<bool>,
) -> Result<SftpActionResponse, String> {
    agent_core::commands::sftp::sftp_delete(
        registry.inner(),
        session_id,
        project_path_key,
        workdir,
        side,
        path,
        recursive,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_transfer(
    registry: tauri::State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    direction: String,
    source_path: String,
    target_path: String,
    recursive: Option<bool>,
    overwrite: Option<bool>,
) -> Result<SftpTransferResponse, String> {
    agent_core::commands::sftp::sftp_transfer(
        registry.inner(),
        session_id,
        project_path_key,
        workdir,
        direction,
        source_path,
        target_path,
        recursive,
        overwrite,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn sftp_cancel_transfer(
    registry: tauri::State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    transfer_id: String,
) -> Result<(), String> {
    agent_core::commands::sftp::sftp_cancel_transfer(registry.inner(), session_id, transfer_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn sftp_transfer_status(
    registry: tauri::State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    transfer_id: String,
) -> Result<SftpTransferResponse, String> {
    agent_core::commands::sftp::sftp_transfer_status(registry.inner(), session_id, transfer_id)
}
