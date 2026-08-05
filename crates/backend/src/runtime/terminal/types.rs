use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionRecord {
    pub id: String,
    pub project_path_key: String,
    pub cwd: String,
    pub shell: String,
    pub title: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh: Option<TerminalSshMetadata>,
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    pub created_at: u128,
    pub updated_at: u128,
    pub finished_at: Option<u128>,
    pub exit_code: Option<i32>,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSshMetadata {
    pub host_id: String,
    pub host_name: String,
    pub username: String,
    pub host: String,
    pub port: u16,
    pub auth_type: String,
    pub status: String,
    pub reconnect_attempt: u8,
    pub reconnect_max_attempts: u8,
    pub sftp_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSshPrompt {
    pub id: String,
    pub kind: String,
    pub host_id: String,
    pub host_name: String,
    pub host: String,
    pub port: u16,
    pub message: String,
    pub fingerprint_sha256: String,
    pub key_type: String,
    pub answer_echo: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalListResponse {
    pub sessions: Vec<TerminalSessionRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshotResponse {
    pub session: TerminalSessionRecord,
    pub output: String,
    pub output_bytes: Vec<u8>,
    pub truncated: bool,
    pub output_start_offset: u64,
    pub output_end_offset: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSshCreateResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<TerminalSessionRecord>,
    pub output: String,
    pub output_bytes: Vec<u8>,
    pub truncated: bool,
    pub output_start_offset: u64,
    pub output_end_offset: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_prompt: Option<TerminalSshPrompt>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSshLatencyResponse {
    pub session_id: String,
    pub latency_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshLocalForwardRecord {
    pub id: String,
    pub session_id: String,
    pub project_path_key: String,
    pub local_host: String,
    pub local_port: u16,
    pub address: String,
    pub remote_host: String,
    pub remote_port: u16,
    pub status: String,
    pub created_at: u128,
    pub updated_at: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshLocalForwardListResponse {
    pub forwards: Vec<SshLocalForwardRecord>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshLocalForwardActionResponse {
    pub forward: SshLocalForwardRecord,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshLocalForwardEventPayload {
    pub kind: String,
    pub forward: SshLocalForwardRecord,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTerminalTabRecord {
    pub id: String,
    pub session_id: String,
    pub project_path_key: String,
    pub kind: String,
    pub created_at: u128,
    pub updated_at: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTerminalTabsSnapshot {
    pub project_path_key: String,
    pub tabs: Vec<SshTerminalTabRecord>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSshExecResponse {
    pub session_id: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_signal: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    pub duration_ms: u128,
}

#[derive(Debug, Clone)]
pub struct TerminalSshSessionInfo {
    pub project_path_key: String,
    pub cwd: String,
    pub running: bool,
    pub sftp_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShellOption {
    pub id: String,
    pub label: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShellOptionsResponse {
    pub options: Vec<TerminalShellOption>,
    pub default_shell: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEventPayload {
    pub kind: String,
    pub session_id: String,
    pub project_path_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<TerminalSessionRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_start_offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_end_offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_tabs: Option<SshTerminalTabsSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_local_forward: Option<SshLocalForwardEventPayload>,
}

#[derive(Debug, Clone)]
pub struct TerminalEvent {
    pub payload: TerminalEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStreamEventPayload {
    pub kind: String,
    pub session_id: String,
    pub project_path_key: String,
    pub start_offset: u64,
    pub end_offset: u64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct TerminalStreamEvent {
    pub payload: TerminalStreamEventPayload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStreamSnapshotResponse {
    pub session: TerminalSessionRecord,
    pub bytes: Vec<u8>,
    pub truncated: bool,
    pub output_start_offset: u64,
    pub output_end_offset: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReadTailResponse {
    pub sessions: Vec<TerminalSessionRecord>,
    pub selected_session: Option<TerminalSessionRecord>,
    pub output: String,
    pub truncated: bool,
}
