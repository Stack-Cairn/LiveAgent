use crate::runtime::project_path::project_path_key as normalize_project_path_key;

use super::*;

pub(crate) fn terminal_ssh_create_response_from_snapshot(
    snapshot: TerminalSnapshotResponse,
) -> TerminalSshCreateResponse {
    TerminalSshCreateResponse {
        session: Some(snapshot.session),
        output: snapshot.output,
        output_bytes: snapshot.output_bytes,
        truncated: snapshot.truncated,
        output_start_offset: snapshot.output_start_offset,
        output_end_offset: snapshot.output_end_offset,
        ssh_prompt: None,
    }
}

pub(crate) fn required_project_key(project_path_key: String) -> Result<String, String> {
    let project_key = normalize_project_path_key(&project_path_key);
    if project_key.is_empty() {
        return Err("project_path_key is required".to_string());
    }
    Ok(project_key)
}

pub(crate) fn normalize_ssh_terminal_tab_kind(kind: &str) -> Result<String, String> {
    match kind.trim().to_ascii_lowercase().as_str() {
        "bash" => Ok("bash".to_string()),
        "sftp" => Ok("sftp".to_string()),
        "" => Err("tab kind is required".to_string()),
        other => Err(format!("unsupported ssh terminal tab kind: {other}")),
    }
}

pub(crate) fn ssh_terminal_tab_id(session_id: &str, kind: &str) -> String {
    format!("{}:{}", kind.trim(), session_id.trim())
}

pub(crate) fn ssh_terminal_tabs_snapshot_from_state(
    project_path_key: &str,
    state: &SshTerminalTabsState,
) -> SshTerminalTabsSnapshot {
    SshTerminalTabsSnapshot {
        project_path_key: project_path_key.to_string(),
        tabs: state.tabs.clone(),
        revision: state.revision,
    }
}
