use std::sync::Arc;

use crate::runtime::sftp::SftpSessionRegistry;
use crate::runtime::shell_runner::ShellRunRegistry;
use crate::runtime::terminal::{
    normalize_ssh_local_forward_local_port, ssh_local_forward_local_port_available,
    terminal_shell_options as runtime_terminal_shell_options, SshLocalForwardActionResponse,
    SshLocalForwardListResponse, SshTerminalTabsSnapshot, TerminalListResponse,
    TerminalReadTailResponse, TerminalSessionRecord, TerminalSessionRegistry,
    TerminalShellOptionsResponse, TerminalSnapshotResponse, TerminalSshCreateResponse,
    TerminalSshExecResponse, TerminalSshLatencyResponse, TerminalStreamSnapshotResponse,
};

pub fn terminal_shell_options() -> TerminalShellOptionsResponse {
    runtime_terminal_shell_options()
}

pub fn terminal_list(
    registry: &Arc<TerminalSessionRegistry>,
    project_path_key: Option<String>,
) -> TerminalListResponse {
    registry.list(project_path_key)
}

pub fn terminal_create(
    registry: &Arc<TerminalSessionRegistry>,
    cwd: String,
    project_path_key: Option<String>,
    shell: Option<String>,
    title: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<TerminalSnapshotResponse, String> {
    registry.create(cwd, project_path_key, shell, title, cols, rows)
}

pub async fn terminal_create_ssh(
    registry: &Arc<TerminalSessionRegistry>,
    cwd: String,
    project_path_key: Option<String>,
    ssh_host_id: String,
    title: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    sftp_enabled: Option<bool>,
) -> Result<TerminalSshCreateResponse, String> {
    registry
        .clone()
        .create_ssh(
            cwd,
            project_path_key,
            ssh_host_id,
            title,
            cols,
            rows,
            sftp_enabled.unwrap_or(false),
        )
        .await
}

pub async fn terminal_answer_ssh_prompt(
    registry: &Arc<TerminalSessionRegistry>,
    prompt_id: String,
    prompt_answer: Option<String>,
    trust_host_key: Option<bool>,
) -> Result<TerminalSshCreateResponse, String> {
    registry
        .clone()
        .answer_ssh_prompt(prompt_id, prompt_answer, trust_host_key.unwrap_or(false))
        .await
}

pub fn terminal_cancel_ssh_prompt(
    registry: &Arc<TerminalSessionRegistry>,
    prompt_id: String,
) -> Result<(), String> {
    registry.cancel_ssh_prompt(prompt_id)
}

pub async fn terminal_ssh_reconnect(
    registry: &Arc<TerminalSessionRegistry>,
    session_id: String,
) -> Result<TerminalSessionRecord, String> {
    registry.clone().ssh_reconnect(session_id).await
}

pub async fn terminal_ssh_latency(
    registry: &Arc<TerminalSessionRegistry>,
    session_id: String,
) -> Result<TerminalSshLatencyResponse, String> {
    registry.ssh_latency(session_id).await
}

pub async fn terminal_ssh_exec(
    registry: &Arc<TerminalSessionRegistry>,
    run_registry: &Arc<ShellRunRegistry>,
    session_id: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    max_bytes: Option<usize>,
    run_id: Option<String>,
) -> Result<TerminalSshExecResponse, String> {
    let normalized_run_id = run_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let cancel_token = normalized_run_id
        .as_deref()
        .map(|id| run_registry.register(id));
    let registered_token = cancel_token.clone();
    let result = registry
        .clone()
        .ssh_exec(
            session_id,
            command,
            cwd,
            timeout_ms,
            max_bytes,
            cancel_token,
        )
        .await;
    if let (Some(run_id), Some(token)) = (normalized_run_id.as_deref(), registered_token.as_ref()) {
        run_registry.unregister(run_id, token);
    }
    result
}

pub async fn terminal_ssh_local_forward_start(
    registry: &Arc<TerminalSessionRegistry>,
    session_id: String,
    project_path_key: Option<String>,
    remote_host: String,
    remote_port: u32,
    local_port: Option<u32>,
) -> Result<SshLocalForwardActionResponse, String> {
    registry
        .clone()
        .ssh_local_forward_start(
            session_id,
            project_path_key,
            remote_host,
            remote_port,
            local_port,
        )
        .await
}

pub fn terminal_ssh_local_forward_list(
    registry: &Arc<TerminalSessionRegistry>,
    session_id: Option<String>,
    project_path_key: Option<String>,
) -> Result<SshLocalForwardListResponse, String> {
    registry.ssh_local_forward_list(session_id, project_path_key)
}

pub async fn terminal_ssh_local_forward_stop(
    registry: &Arc<TerminalSessionRegistry>,
    forward_id: String,
    session_id: Option<String>,
) -> Result<SshLocalForwardActionResponse, String> {
    registry
        .ssh_local_forward_stop(forward_id, session_id)
        .await
}

pub async fn terminal_ssh_local_forward_check_port(local_port: u32) -> Result<bool, String> {
    let port = normalize_ssh_local_forward_local_port(Some(local_port))?;
    if port == 0 {
        // Auto-assign never conflicts; the OS picks a free port at bind time.
        return Ok(true);
    }
    Ok(ssh_local_forward_local_port_available(port).await)
}

pub fn ssh_terminal_tabs_list(
    registry: &Arc<TerminalSessionRegistry>,
    project_path_key: String,
) -> Result<SshTerminalTabsSnapshot, String> {
    registry.ssh_terminal_tabs_list(project_path_key)
}

pub fn ssh_terminal_tab_open(
    registry: &Arc<TerminalSessionRegistry>,
    session_id: String,
    kind: String,
) -> Result<SshTerminalTabsSnapshot, String> {
    registry.ssh_terminal_tab_open(session_id, kind)
}

pub fn ssh_terminal_tab_close(
    registry: &Arc<TerminalSessionRegistry>,
    tab_id: String,
) -> Result<SshTerminalTabsSnapshot, String> {
    registry.ssh_terminal_tab_close(tab_id)
}

pub fn terminal_stream_attach(
    registry: &Arc<TerminalSessionRegistry>,
    session_id: String,
    max_bytes: Option<usize>,
) -> Result<TerminalStreamSnapshotResponse, String> {
    registry.stream_attach(session_id, max_bytes)
}

pub fn terminal_stream_input(
    registry: &Arc<TerminalSessionRegistry>,
    session_id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    registry.input_bytes(session_id, bytes)
}

pub fn terminal_stream_resize(
    registry: &Arc<TerminalSessionRegistry>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    registry.stream_resize(session_id, cols, rows)
}

pub fn terminal_rename(
    registry: &Arc<TerminalSessionRegistry>,
    session_id: String,
    title: String,
) -> Result<TerminalSessionRecord, String> {
    registry.rename(session_id, title)
}

pub fn terminal_close(
    registry: &Arc<TerminalSessionRegistry>,
    sftp_registry: &Arc<SftpSessionRegistry>,
    session_id: String,
) -> Result<TerminalSessionRecord, String> {
    let response = registry.close(session_id)?;
    sftp_registry.close_session(&response.id);
    Ok(response)
}

pub fn terminal_close_project(
    registry: &Arc<TerminalSessionRegistry>,
    sftp_registry: &Arc<SftpSessionRegistry>,
    project_path_key: String,
) -> Result<TerminalListResponse, String> {
    let response = registry.close_project(project_path_key)?;
    for session in &response.sessions {
        sftp_registry.close_session(&session.id);
    }
    Ok(response)
}

pub fn terminal_read_tail(
    registry: &Arc<TerminalSessionRegistry>,
    project_path_key: String,
    session_id: Option<String>,
    max_bytes: Option<usize>,
) -> Result<TerminalReadTailResponse, String> {
    registry.read_tail(project_path_key, session_id, max_bytes)
}
