use std::sync::Arc;

use tauri::State;

use crate::runtime::sftp::{
    SftpActionResponse, SftpListResponse, SftpReadTextResponse, SftpSessionRegistry,
    SftpStatResponse, SftpTransferResponse,
};

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_list(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    path: Option<String>,
) -> Result<SftpListResponse, String> {
    registry
        .list(session_id, project_path_key, workdir, side, path)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_stat(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    path: Option<String>,
) -> Result<SftpStatResponse, String> {
    registry
        .stat(session_id, project_path_key, workdir, side, path)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_read_text(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    path: String,
    offset: Option<u64>,
    max_bytes: Option<usize>,
) -> Result<SftpReadTextResponse, String> {
    registry
        .read_text(session_id, project_path_key, path, offset, max_bytes)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_write_text(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    path: String,
    content: String,
    overwrite: Option<bool>,
    create_parent_dirs: Option<bool>,
) -> Result<SftpActionResponse, String> {
    registry
        .write_text(
            session_id,
            project_path_key,
            path,
            content,
            overwrite.unwrap_or(true),
            create_parent_dirs.unwrap_or(true),
        )
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_mkdir(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    path: String,
) -> Result<SftpActionResponse, String> {
    registry
        .mkdir(session_id, project_path_key, workdir, side, path)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_rename(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    from_path: String,
    to_path: String,
) -> Result<SftpActionResponse, String> {
    registry
        .rename(
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
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    side: String,
    path: String,
    recursive: Option<bool>,
) -> Result<SftpActionResponse, String> {
    registry
        .delete(
            session_id,
            project_path_key,
            workdir,
            side,
            path,
            recursive.unwrap_or(false),
        )
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sftp_transfer(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    workdir: String,
    direction: String,
    source_path: String,
    target_path: String,
    recursive: Option<bool>,
    overwrite: Option<bool>,
) -> Result<SftpTransferResponse, String> {
    registry
        .inner()
        .clone()
        .transfer(
            session_id,
            project_path_key,
            workdir,
            direction,
            source_path,
            target_path,
            recursive.unwrap_or(false),
            overwrite.unwrap_or(false),
        )
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn sftp_cancel_transfer(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    transfer_id: String,
) -> Result<(), String> {
    registry.cancel_transfer(session_id, transfer_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn sftp_transfer_status(
    registry: State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
    transfer_id: String,
) -> Result<SftpTransferResponse, String> {
    registry.transfer_status(session_id, transfer_id)
}
