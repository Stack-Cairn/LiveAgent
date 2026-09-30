use russh::client;
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Sig};
use std::future::Future;
use std::time::Duration;

use crate::runtime::shell_runner::ShellCancelToken;

use super::*;

pub(crate) async fn open_ssh_shell_channel(
    handle: &client::Handle<LiveAgentSshClient>,
    size: TerminalSize,
) -> Result<russh::Channel<client::Msg>, String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH channel open failed: {error}"))?;
    channel
        .request_pty(
            false,
            "xterm-256color",
            u32::from(size.cols),
            u32::from(size.rows),
            0,
            0,
            &[],
        )
        .await
        .map_err(|error| format!("SSH PTY request failed: {error}"))?;
    channel
        .request_shell(false)
        .await
        .map_err(|error| format!("SSH shell request failed: {error}"))?;
    Ok(channel)
}

impl TerminalSessionRegistry {
    /// Opens an SFTP subsystem channel on the SSH session's existing
    /// authenticated connection. No re-authentication happens, so this works
    /// for every auth type including keyboard-interactive. The returned
    /// connection id identifies the underlying connection: after a reconnect
    /// the id changes and cached SFTP sessions must be reopened.
    pub(crate) async fn open_ssh_sftp_session(
        &self,
        session_id: &str,
    ) -> Result<(TerminalSftpConnection, usize), String> {
        let entry = self.entry(session_id)?;
        let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
            return Err("terminal session is not an SSH connection".to_string());
        };
        let connection_id = runtime.current_connection_id();
        // Clone the handle so the server round-trip does not hold the slot
        // mutex; liveness pings and reconnects must not queue behind it.
        let Some(handle) = runtime.current_handle().await else {
            return Err("SSH connection is not connected".to_string());
        };
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|error| format!("SFTP channel open failed: {error}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("SFTP subsystem request failed: {error}"))?;
        let session = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| format!("SFTP session failed: {error}"))?;
        Ok((TerminalSftpConnection { session }, connection_id))
    }

    pub(crate) fn ssh_connection_id(&self, session_id: &str) -> Result<usize, String> {
        let entry = self.entry(session_id)?;
        let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
            return Err("terminal session is not an SSH connection".to_string());
        };
        Ok(runtime.current_connection_id())
    }
}

/// Opens an exec channel on the session's existing connection and starts
/// `command`. The write half is returned so the caller can close the channel
/// when it abandons the command (timeout/cancel): a split `Channel` does not
/// close on drop, and every abandoned channel keeps occupying one of the
/// server's per-connection session slots (OpenSSH `MaxSessions`, default 10)
/// until the remote command exits.
pub(crate) async fn open_ssh_exec_channel(
    handle: &client::Handle<LiveAgentSshClient>,
    command: String,
) -> Result<(ChannelReadHalf, ChannelWriteHalf<client::Msg>), String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH exec channel open failed: {error}"))?;
    let (read_half, write_half) = channel.split();
    if let Err(error) = write_half.exec(true, command.into_bytes()).await {
        close_ssh_exec_channel(write_half, false);
        return Err(format!("SSH exec request failed: {error}"));
    }
    Ok((read_half, write_half))
}

pub(crate) enum SshExecStep<T> {
    Done(T),
    TimedOut,
    Cancelled,
}

/// Runs one exec phase under the exec's overall deadline and cancel token.
pub(crate) async fn wait_ssh_exec_step<F: Future>(
    step: F,
    deadline: tokio::time::Instant,
    cancel_token: Option<&ShellCancelToken>,
) -> SshExecStep<F::Output> {
    let bounded = tokio::time::timeout_at(deadline, step);
    let Some(cancel_token) = cancel_token else {
        return bounded
            .await
            .map_or(SshExecStep::TimedOut, SshExecStep::Done);
    };
    tokio::select! {
        result = bounded => result.map_or(SshExecStep::TimedOut, SshExecStep::Done),
        _ = cancel_token.cancelled() => SshExecStep::Cancelled,
    }
}

/// Best-effort release of an exec channel the caller stopped waiting on.
/// `interrupt` additionally asks the server to TERM the remote command
/// (servers without `signal` request support simply ignore it).
pub(crate) fn close_ssh_exec_channel(write_half: ChannelWriteHalf<client::Msg>, interrupt: bool) {
    // russh drives the session on Tauri's long-lived runtime; the close must
    // not depend on the (possibly finishing) caller task.
    tauri::async_runtime::spawn(async move {
        if interrupt {
            let _ = write_half.signal(Sig::TERM).await;
        }
        let _ = write_half.close().await;
    });
}

pub(crate) async fn read_ssh_exec_output(
    mut read_half: ChannelReadHalf,
    max_bytes: usize,
) -> TerminalSshExecResponse {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let mut exit_code = None;
    let mut exit_signal = None;

    loop {
        match read_half.wait().await {
            Some(ChannelMsg::Data { data }) => {
                append_limited(&mut stdout, data.as_ref(), max_bytes, &mut stdout_truncated);
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                append_limited(&mut stderr, data.as_ref(), max_bytes, &mut stderr_truncated);
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                exit_code = Some(exit_status);
            }
            Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                exit_signal = Some(format!("{signal_name:?}"));
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }

    TerminalSshExecResponse {
        session_id: String::new(),
        command: String::new(),
        cwd: None,
        exit_code,
        exit_signal,
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        stdout_truncated,
        stderr_truncated,
        timed_out: false,
        duration_ms: 0,
    }
}

pub(crate) fn normalize_ssh_exec_timeout(timeout_ms: Option<u64>) -> Duration {
    let requested = timeout_ms
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(SSH_EXEC_DEFAULT_TIMEOUT);
    requested.clamp(Duration::from_secs(1), SSH_EXEC_MAX_TIMEOUT)
}

pub(crate) fn normalize_ssh_exec_max_bytes(max_bytes: Option<usize>) -> usize {
    max_bytes
        .filter(|value| *value > 0)
        .unwrap_or(SSH_EXEC_DEFAULT_MAX_BYTES)
        .clamp(4 * 1024, SSH_EXEC_MAX_BYTES)
}

pub(crate) fn append_limited(
    buffer: &mut Vec<u8>,
    data: &[u8],
    max_bytes: usize,
    truncated: &mut bool,
) {
    if buffer.len() >= max_bytes {
        if !data.is_empty() {
            *truncated = true;
        }
        return;
    }
    let remaining = max_bytes - buffer.len();
    if data.len() > remaining {
        buffer.extend_from_slice(&data[..remaining]);
        *truncated = true;
    } else {
        buffer.extend_from_slice(data);
    }
}

pub(crate) fn wrap_ssh_exec_command(command: &str, cwd: Option<&str>) -> String {
    match cwd.map(str::trim).filter(|value| !value.is_empty()) {
        Some(cwd) => format!("cd {} && {}", shell_single_quote(cwd), command),
        None => command.to_string(),
    }
}

pub(crate) fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
