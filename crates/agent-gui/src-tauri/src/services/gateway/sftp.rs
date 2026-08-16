use uuid::Uuid;

use crate::runtime::sftp::{
    SftpActionResponse, SftpEntry, SftpEventPayload, SftpListResponse, SftpReadTextResponse,
    SftpStatResponse, SftpTransferResponse, SftpTransferState,
};

use super::*;

impl GatewayController {
    pub(crate) async fn handle_sftp_request(
        &self,
        request: proto::SftpRequest,
    ) -> Result<proto::SftpResponse, String> {
        if !self.config_tx.borrow().enable_web_ssh_terminal {
            return Err("web SSH SFTP is disabled in desktop Remote settings".to_string());
        }
        let action = request.action.trim().to_ascii_lowercase();
        match action.as_str() {
            "list" => {
                let side = if request.direction.trim().is_empty() {
                    "remote".to_string()
                } else {
                    request.direction
                };
                let path = sftp_side_path(&side, &request.local_path, &request.remote_path);
                let response = self
                    .sftp_registry
                    .list(
                        request.session_id,
                        Some(request.project_path_key),
                        request.workdir,
                        side,
                        Some(path),
                    )
                    .await?;
                Ok(sftp_list_response_to_proto(action, response))
            }
            "stat" | "probe" => {
                let side = if request.direction.trim().is_empty() {
                    "remote".to_string()
                } else {
                    request.direction
                };
                let path = sftp_side_path(&side, &request.local_path, &request.remote_path);
                let response = self
                    .sftp_registry
                    .stat(
                        request.session_id,
                        Some(request.project_path_key),
                        request.workdir,
                        side,
                        Some(path),
                    )
                    .await?;
                Ok(sftp_stat_response_to_proto(action, response))
            }
            "mkdir" => {
                let side = if request.direction.trim().is_empty() {
                    "remote".to_string()
                } else {
                    request.direction
                };
                let path = sftp_side_path(&side, &request.local_path, &request.remote_path);
                let response = self
                    .sftp_registry
                    .mkdir(
                        request.session_id,
                        Some(request.project_path_key),
                        request.workdir,
                        side,
                        path,
                    )
                    .await?;
                Ok(sftp_action_response_to_proto(action, response))
            }
            "rename" => {
                let side = if request.direction.trim().is_empty() {
                    "remote".to_string()
                } else {
                    request.direction
                };
                let response = self
                    .sftp_registry
                    .rename(
                        request.session_id,
                        Some(request.project_path_key),
                        request.workdir,
                        side,
                        request.from_path,
                        request.to_path,
                    )
                    .await?;
                Ok(sftp_action_response_to_proto(action, response))
            }
            "delete" => {
                let side = if request.direction.trim().is_empty() {
                    "remote".to_string()
                } else {
                    request.direction
                };
                let path = sftp_side_path(&side, &request.local_path, &request.remote_path);
                let response = self
                    .sftp_registry
                    .delete(
                        request.session_id,
                        Some(request.project_path_key),
                        request.workdir,
                        side,
                        path,
                        request.recursive,
                    )
                    .await?;
                Ok(sftp_action_response_to_proto(action, response))
            }
            "transfer" => {
                let response = self
                    .sftp_registry
                    .transfer(
                        request.session_id,
                        Some(request.project_path_key),
                        request.workdir,
                        request.direction,
                        request.from_path,
                        request.target_path,
                        request.recursive,
                        request.overwrite,
                    )
                    .await?;
                Ok(sftp_transfer_response_to_proto(action, response))
            }
            "read_text" => {
                let response = self
                    .sftp_registry
                    .read_text(
                        request.session_id,
                        Some(request.project_path_key),
                        request.remote_path,
                        (request.offset > 0).then_some(request.offset),
                        usize::try_from(request.max_bytes)
                            .ok()
                            .filter(|max_bytes| *max_bytes > 0),
                        Some(request.strict_utf8),
                    )
                    .await?;
                Ok(sftp_read_text_response_to_proto(action, response))
            }
            "write_text" => {
                let response = self
                    .sftp_registry
                    .write_text(
                        request.session_id,
                        Some(request.project_path_key),
                        request.remote_path,
                        request.content,
                        request.overwrite,
                        request.create_parent_dirs,
                        // proto3 scalars have no presence: 0 means "skip the
                        // check" (a genuine epoch-0 mtime skips it too).
                        (request.expected_mtime > 0).then_some(request.expected_mtime),
                        (request.expected_size_bytes > 0).then_some(request.expected_size_bytes),
                    )
                    .await?;
                // response.action is "write_text" or "conflict"; the conflict
                // marker must reach the browser, so don't echo the request
                // action here.
                let response_action = response.action.clone();
                Ok(sftp_action_response_to_proto(response_action, response))
            }
            "cancel" => {
                self.sftp_registry
                    .cancel_transfer(request.session_id, request.from_path)?;
                Ok(proto::SftpResponse {
                    action,
                    path: String::new(),
                    entries: Vec::new(),
                    entry: None,
                    exists: false,
                    transfer: None,
                    ..Default::default()
                })
            }
            _ => Err(format!("unsupported sftp action: {action}")),
        }
    }
}

pub(crate) fn sftp_side_path(side: &str, local_path: &str, remote_path: &str) -> String {
    if side.trim().eq_ignore_ascii_case("local") {
        local_path.trim().to_string()
    } else {
        remote_path.trim().to_string()
    }
}

pub(crate) fn sftp_entry_to_proto(entry: SftpEntry) -> proto::SftpEntry {
    proto::SftpEntry {
        path: entry.path,
        name: entry.name,
        kind: entry.kind,
        size_bytes: entry.size_bytes,
        mtime: entry.mtime,
    }
}

pub(crate) fn sftp_transfer_to_proto(transfer: SftpTransferState) -> proto::SftpTransfer {
    proto::SftpTransfer {
        id: transfer.id,
        session_id: transfer.session_id,
        direction: transfer.direction,
        status: transfer.status,
        source_path: transfer.source_path,
        target_path: transfer.target_path,
        current_path: transfer.current_path,
        bytes_done: transfer.bytes_done,
        bytes_total: transfer.bytes_total,
        files_done: transfer.files_done,
        files_total: transfer.files_total,
        error: transfer.error.unwrap_or_default(),
    }
}

pub(crate) fn sftp_list_response_to_proto(
    action: String,
    response: SftpListResponse,
) -> proto::SftpResponse {
    proto::SftpResponse {
        action,
        path: response.path,
        entries: response
            .entries
            .into_iter()
            .map(sftp_entry_to_proto)
            .collect(),
        entry: None,
        exists: false,
        transfer: None,
        ..Default::default()
    }
}

pub(crate) fn sftp_stat_response_to_proto(
    action: String,
    response: SftpStatResponse,
) -> proto::SftpResponse {
    proto::SftpResponse {
        action,
        path: response
            .entry
            .as_ref()
            .map(|entry| entry.path.clone())
            .unwrap_or_default(),
        entries: Vec::new(),
        entry: response.entry.map(sftp_entry_to_proto),
        exists: response.exists,
        transfer: None,
        ..Default::default()
    }
}

pub(crate) fn sftp_action_response_to_proto(
    action: String,
    response: SftpActionResponse,
) -> proto::SftpResponse {
    proto::SftpResponse {
        action,
        path: response.path,
        entries: Vec::new(),
        entry: response.entry.map(sftp_entry_to_proto),
        exists: false,
        transfer: response.transfer.map(sftp_transfer_to_proto),
        ..Default::default()
    }
}

pub(crate) fn sftp_transfer_response_to_proto(
    action: String,
    response: SftpTransferResponse,
) -> proto::SftpResponse {
    proto::SftpResponse {
        action,
        path: response.transfer.target_path.clone(),
        entries: Vec::new(),
        entry: None,
        exists: false,
        transfer: Some(sftp_transfer_to_proto(response.transfer)),
        ..Default::default()
    }
}

pub(crate) fn sftp_read_text_response_to_proto(
    action: String,
    response: SftpReadTextResponse,
) -> proto::SftpResponse {
    proto::SftpResponse {
        action,
        path: response.path,
        entry: response.entry.map(sftp_entry_to_proto),
        content: response.content,
        offset: response.offset,
        bytes_read: response.bytes_read as u64,
        size_bytes: response.size_bytes,
        truncated: response.truncated,
        ..Default::default()
    }
}

pub(crate) fn build_sftp_event_envelope(payload: SftpEventPayload) -> proto::AgentEnvelope {
    proto::AgentEnvelope {
        request_id: format!("sftp-event-{}", Uuid::new_v4()),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::SftpEvent(
            proto::SftpEvent {
                kind: payload.kind,
                transfer: Some(sftp_transfer_to_proto(payload.transfer)),
            },
        )),
    }
}
