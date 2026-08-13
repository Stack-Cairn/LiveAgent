use russh::client;
use russh::ChannelMsg;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;

use super::*;

pub(crate) async fn run_ssh_session_io(
    registry: Arc<TerminalSessionRegistry>,
    session_id: String,
    runtime: Arc<SshSessionRuntime>,
    connection_id: usize,
    channel: russh::Channel<client::Msg>,
    mut input_rx: tokio::sync::mpsc::Receiver<SshSessionInput>,
    mut shutdown_rx: tokio::sync::mpsc::Receiver<()>,
) {
    let (mut read_half, write_half) = channel.split();
    let (writer_end_tx, mut writer_end_rx) = tokio::sync::mpsc::channel::<SshSessionIoEndReason>(1);
    let writer_runtime = Arc::clone(&runtime);
    crate::compat::async_runtime::spawn(async move {
        let mut writer = write_half.make_writer();
        let reason = loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    let handle = writer_runtime.handle.lock().await;
                    if let Some(handle) = handle.as_ref() {
                        let _ = handle.disconnect(russh::Disconnect::ByApplication, "User disconnected", "en").await;
                    }
                    break SshSessionIoEndReason::Shutdown;
                }
                input = input_rx.recv() => {
                    match input {
                        Some(SshSessionInput::Data(data)) => {
                            if writer.write_all(&data).await.is_err() {
                                break SshSessionIoEndReason::WriteFailed;
                            }
                        }
                        Some(SshSessionInput::Resize(cols, rows)) => {
                            let _ = write_half.window_change(cols, rows, 0, 0).await;
                        }
                        None => {
                            break SshSessionIoEndReason::InputClosed;
                        },
                    }
                }
            }
        };
        let _ = writer_end_tx.send(reason).await;
    });
    let mut remote_exit_reason: Option<SshSessionIoEndReason> = None;
    let end_reason = loop {
        tokio::select! {
            reason = writer_end_rx.recv() => {
                break reason.unwrap_or(SshSessionIoEndReason::InputClosed);
            }
            message = read_half.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        registry.append_output(&session_id, data.as_ref().to_vec());
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        remote_exit_reason = Some(SshSessionIoEndReason::RemoteExitStatus(exit_status));
                    }
                    Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                        remote_exit_reason = Some(SshSessionIoEndReason::RemoteExitSignal(format!("{signal_name:?}")));
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                        break remote_exit_reason.unwrap_or(SshSessionIoEndReason::RemoteClosed);
                    }
                    None => {
                        break remote_exit_reason.unwrap_or(SshSessionIoEndReason::ConnectionLost);
                    }
                    _ => {}
                }
            }
        }
    };

    finish_ssh_session_io(registry, session_id, runtime, connection_id, end_reason).await;
}

pub(crate) async fn finish_ssh_session_io(
    registry: Arc<TerminalSessionRegistry>,
    session_id: String,
    runtime: Arc<SshSessionRuntime>,
    connection_id: usize,
    end_reason: SshSessionIoEndReason,
) {
    if runtime.is_closing() {
        return;
    }
    match end_reason {
        SshSessionIoEndReason::Shutdown | SshSessionIoEndReason::InputClosed => {}
        SshSessionIoEndReason::RemoteExitStatus(status) => {
            registry
                .mark_ssh_shell_ended(
                    session_id,
                    runtime,
                    connection_id,
                    format!("\r\n[SSH] Remote shell exited with status {status}.\r\n"),
                )
                .await;
        }
        SshSessionIoEndReason::RemoteExitSignal(signal) => {
            registry
                .mark_ssh_shell_ended(
                    session_id,
                    runtime,
                    connection_id,
                    format!("\r\n[SSH] Remote shell exited after signal {signal}.\r\n"),
                )
                .await;
        }
        SshSessionIoEndReason::RemoteClosed => {
            registry
                .mark_ssh_shell_ended(
                    session_id,
                    runtime,
                    connection_id,
                    "\r\n[SSH] Remote shell closed.\r\n".to_string(),
                )
                .await;
        }
        SshSessionIoEndReason::ConnectionLost => {
            if ssh_connection_alive(&runtime, connection_id).await {
                registry
                    .mark_ssh_shell_ended(
                        session_id,
                        runtime,
                        connection_id,
                        "\r\n[SSH] Remote shell closed.\r\n".to_string(),
                    )
                    .await;
            } else {
                spawn_ssh_reconnect_runner(registry, session_id, runtime, connection_id);
            }
        }
        SshSessionIoEndReason::WriteFailed => {
            spawn_ssh_reconnect_runner(registry, session_id, runtime, connection_id);
        }
    }
}

pub(crate) async fn ssh_connection_alive(
    runtime: &Arc<SshSessionRuntime>,
    connection_id: usize,
) -> bool {
    if runtime.current_connection_id() != connection_id || runtime.is_closing() {
        return false;
    }
    let ping = timeout(Duration::from_secs(2), async {
        let handle = runtime.handle.lock().await;
        let Some(handle) = handle.as_ref() else {
            return Err(russh::Error::Disconnect);
        };
        handle.send_ping().await
    })
    .await;
    matches!(ping, Ok(Ok(())))
}

pub(crate) fn spawn_ssh_reconnect_runner(
    registry: Arc<TerminalSessionRegistry>,
    session_id: String,
    runtime: Arc<SshSessionRuntime>,
    connection_id: usize,
) {
    // russh drives each session on the current Tokio runtime, so reconnects must
    // live on Tauri's long-running runtime rather than a short-lived thread runtime.
    crate::compat::async_runtime::spawn(async move {
        registry
            .handle_ssh_unexpected_disconnect(session_id, runtime, connection_id)
            .await;
    });
}
