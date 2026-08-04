//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use agent_core::commands::terminal::*;
use agent_core::runtime::sftp::SftpSessionRegistry;
use agent_core::runtime::shell_runner::ShellRunRegistry;
use agent_core::runtime::terminal::{
    normalize_ssh_local_forward_local_port, ssh_local_forward_local_port_available,
    terminal_shell_options as runtime_terminal_shell_options, SshLocalForwardActionResponse,
    SshLocalForwardListResponse, SshTerminalTabsSnapshot, TerminalListResponse,
    TerminalReadTailResponse, TerminalSessionRecord, TerminalSessionRegistry,
    TerminalShellOptionsResponse, TerminalSnapshotResponse, TerminalSshCreateResponse,
    TerminalSshExecResponse, TerminalSshLatencyResponse, TerminalStreamSnapshotResponse,
};
use std::sync::Arc;

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_shell_options() -> TerminalShellOptionsResponse {
    agent_core::commands::terminal::terminal_shell_options()
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_list(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    project_path_key: Option<String>,
) -> TerminalListResponse {
    agent_core::commands::terminal::terminal_list(registry.inner(), project_path_key)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_create(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    cwd: String,
    project_path_key: Option<String>,
    shell: Option<String>,
    title: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<TerminalSnapshotResponse, String> {
    agent_core::commands::terminal::terminal_create(
        registry.inner(),
        cwd,
        project_path_key,
        shell,
        title,
        cols,
        rows,
    )
}

#[tauri::command(rename_all = "snake_case")]
pub async fn terminal_create_ssh(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    cwd: String,
    project_path_key: Option<String>,
    ssh_host_id: String,
    title: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    sftp_enabled: Option<bool>,
) -> Result<TerminalSshCreateResponse, String> {
    agent_core::commands::terminal::terminal_create_ssh(
        registry.inner(),
        cwd,
        project_path_key,
        ssh_host_id,
        title,
        cols,
        rows,
        sftp_enabled,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn terminal_answer_ssh_prompt(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    prompt_id: String,
    prompt_answer: Option<String>,
    trust_host_key: Option<bool>,
) -> Result<TerminalSshCreateResponse, String> {
    agent_core::commands::terminal::terminal_answer_ssh_prompt(
        registry.inner(),
        prompt_id,
        prompt_answer,
        trust_host_key,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_cancel_ssh_prompt(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    prompt_id: String,
) -> Result<(), String> {
    agent_core::commands::terminal::terminal_cancel_ssh_prompt(registry.inner(), prompt_id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn terminal_ssh_reconnect(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
) -> Result<TerminalSessionRecord, String> {
    agent_core::commands::terminal::terminal_ssh_reconnect(registry.inner(), session_id).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn terminal_ssh_latency(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
) -> Result<TerminalSshLatencyResponse, String> {
    agent_core::commands::terminal::terminal_ssh_latency(registry.inner(), session_id).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn terminal_ssh_exec(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    run_registry: tauri::State<'_, Arc<ShellRunRegistry>>,
    session_id: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    max_bytes: Option<usize>,
    run_id: Option<String>,
) -> Result<TerminalSshExecResponse, String> {
    agent_core::commands::terminal::terminal_ssh_exec(
        registry.inner(),
        run_registry.inner(),
        session_id,
        command,
        cwd,
        timeout_ms,
        max_bytes,
        run_id,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn terminal_ssh_local_forward_start(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    project_path_key: Option<String>,
    remote_host: String,
    remote_port: u32,
    local_port: Option<u32>,
) -> Result<SshLocalForwardActionResponse, String> {
    agent_core::commands::terminal::terminal_ssh_local_forward_start(
        registry.inner(),
        session_id,
        project_path_key,
        remote_host,
        remote_port,
        local_port,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_ssh_local_forward_list(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    session_id: Option<String>,
    project_path_key: Option<String>,
) -> Result<SshLocalForwardListResponse, String> {
    agent_core::commands::terminal::terminal_ssh_local_forward_list(
        registry.inner(),
        session_id,
        project_path_key,
    )
}

#[tauri::command(rename_all = "snake_case")]
pub async fn terminal_ssh_local_forward_stop(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    forward_id: String,
    session_id: Option<String>,
) -> Result<SshLocalForwardActionResponse, String> {
    agent_core::commands::terminal::terminal_ssh_local_forward_stop(
        registry.inner(),
        forward_id,
        session_id,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn terminal_ssh_local_forward_check_port(local_port: u32) -> Result<bool, String> {
    agent_core::commands::terminal::terminal_ssh_local_forward_check_port(local_port).await
}

#[tauri::command(rename_all = "snake_case")]
pub fn ssh_terminal_tabs_list(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    project_path_key: String,
) -> Result<SshTerminalTabsSnapshot, String> {
    agent_core::commands::terminal::ssh_terminal_tabs_list(registry.inner(), project_path_key)
}

#[tauri::command(rename_all = "snake_case")]
pub fn ssh_terminal_tab_open(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    kind: String,
) -> Result<SshTerminalTabsSnapshot, String> {
    agent_core::commands::terminal::ssh_terminal_tab_open(registry.inner(), session_id, kind)
}

#[tauri::command(rename_all = "snake_case")]
pub fn ssh_terminal_tab_close(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    tab_id: String,
) -> Result<SshTerminalTabsSnapshot, String> {
    agent_core::commands::terminal::ssh_terminal_tab_close(registry.inner(), tab_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_stream_attach(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    max_bytes: Option<usize>,
) -> Result<TerminalStreamSnapshotResponse, String> {
    agent_core::commands::terminal::terminal_stream_attach(registry.inner(), session_id, max_bytes)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_stream_input(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    agent_core::commands::terminal::terminal_stream_input(registry.inner(), session_id, bytes)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_stream_resize(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    agent_core::commands::terminal::terminal_stream_resize(registry.inner(), session_id, cols, rows)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_rename(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    session_id: String,
    title: String,
) -> Result<TerminalSessionRecord, String> {
    agent_core::commands::terminal::terminal_rename(registry.inner(), session_id, title)
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_close(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    sftp_registry: tauri::State<'_, Arc<SftpSessionRegistry>>,
    session_id: String,
) -> Result<TerminalSessionRecord, String> {
    agent_core::commands::terminal::terminal_close(
        registry.inner(),
        sftp_registry.inner(),
        session_id,
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_close_project(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    sftp_registry: tauri::State<'_, Arc<SftpSessionRegistry>>,
    project_path_key: String,
) -> Result<TerminalListResponse, String> {
    agent_core::commands::terminal::terminal_close_project(
        registry.inner(),
        sftp_registry.inner(),
        project_path_key,
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn terminal_read_tail(
    registry: tauri::State<'_, Arc<TerminalSessionRegistry>>,
    project_path_key: String,
    session_id: Option<String>,
    max_bytes: Option<usize>,
) -> Result<TerminalReadTailResponse, String> {
    agent_core::commands::terminal::terminal_read_tail(
        registry.inner(),
        project_path_key,
        session_id,
        max_bytes,
    )
}
