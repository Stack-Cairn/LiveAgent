use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use russh::client;
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::ssh_key::HashAlg;
use russh::keys::{PrivateKeyWithHashAlg, PublicKey, PublicKeyBase64};
use russh::ChannelMsg;
use russh::MethodKind;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::commands::settings::{
    check_runtime_ssh_known_host, load_runtime_ssh_host, trust_runtime_ssh_known_host,
    RuntimeSshHostConfig, RuntimeSshKnownHostKey, RuntimeSshKnownHostStatus,
};
use crate::runtime::platform::expand_tilde_path;
#[cfg(windows)]
use crate::runtime::process::configure_child_process_group;
use crate::runtime::project_path::{
    project_path_key as normalize_project_path_key, project_path_keys_equal,
};

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;
const MAX_RING_CHUNKS: usize = 4096;
const MAX_TAIL_BYTES: usize = 256 * 1024;
const SSH_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
const SSH_RECONNECT_MAX_ATTEMPTS: u8 = 3;
const SSH_RECONNECT_DELAYS: [Duration; 3] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
];
const SSH_RECONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);
const SSH_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const SSH_KEEPALIVE_MAX_MISSES: usize = 3;
const SSH_STATUS_CONNECTED: &str = "connected";
const SSH_STATUS_RECONNECTING: &str = "reconnecting";
const SSH_STATUS_DISCONNECTED: &str = "disconnected";
pub const TERMINAL_EVENT_NAME: &str = "terminal:event";
pub const TERMINAL_STREAM_EVENT_NAME: &str = "terminal:stream";
const SSH_EXEC_DEFAULT_MAX_BYTES: usize = 64 * 1024;
const SSH_EXEC_MAX_BYTES: usize = 256 * 1024;
const SSH_EXEC_DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_EXEC_MAX_TIMEOUT: Duration = Duration::from_secs(300);

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
    pub host_id: String,
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

#[derive(Debug, Clone, Copy)]
struct TerminalSize {
    cols: u16,
    rows: u16,
}

struct TerminalSessionEntry {
    backend: TerminalSessionBackend,
    record: Mutex<TerminalSessionRecord>,
    output: Mutex<TerminalOutputBuffer>,
}

enum TerminalSessionBackend {
    Local {
        master: Mutex<Box<dyn MasterPty + Send>>,
        input_tx: mpsc::SyncSender<Vec<u8>>,
        child: Mutex<Box<dyn Child + Send + Sync>>,
    },
    Ssh {
        runtime: Arc<SshSessionRuntime>,
    },
}

struct SshSessionRuntime {
    handle: tokio::sync::Mutex<Option<client::Handle<LiveAgentSshClient>>>,
    input_tx: Mutex<Option<tokio::sync::mpsc::Sender<SshSessionInput>>>,
    shutdown_tx: Mutex<Option<tokio::sync::mpsc::Sender<()>>>,
    connection_id: AtomicUsize,
    closing: AtomicBool,
    reconnect_runner_active: AtomicBool,
}

impl SshSessionRuntime {
    fn new() -> Self {
        Self {
            handle: tokio::sync::Mutex::new(None),
            input_tx: Mutex::new(None),
            shutdown_tx: Mutex::new(None),
            connection_id: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
            reconnect_runner_active: AtomicBool::new(false),
        }
    }

    async fn install_connection(
        &self,
        handle: client::Handle<LiveAgentSshClient>,
        input_tx: tokio::sync::mpsc::Sender<SshSessionInput>,
        shutdown_tx: tokio::sync::mpsc::Sender<()>,
    ) -> usize {
        let connection_id = self.connection_id.fetch_add(1, Ordering::SeqCst) + 1;
        *self.handle.lock().await = Some(handle);
        if let Ok(mut slot) = self.input_tx.lock() {
            *slot = Some(input_tx);
        }
        if let Ok(mut slot) = self.shutdown_tx.lock() {
            *slot = Some(shutdown_tx);
        }
        connection_id
    }

    async fn clear_connection_if_current(&self, connection_id: usize) {
        if self.connection_id.load(Ordering::SeqCst) != connection_id {
            return;
        }
        *self.handle.lock().await = None;
        if let Ok(mut slot) = self.input_tx.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = self.shutdown_tx.lock() {
            *slot = None;
        }
    }

    fn input_sender(&self) -> Option<tokio::sync::mpsc::Sender<SshSessionInput>> {
        self.input_tx.lock().ok().and_then(|slot| slot.clone())
    }

    fn shutdown_sender(&self) -> Option<tokio::sync::mpsc::Sender<()>> {
        self.shutdown_tx.lock().ok().and_then(|slot| slot.clone())
    }

    fn close(&self) -> Option<tokio::sync::mpsc::Sender<()>> {
        self.closing.store(true, Ordering::SeqCst);
        self.shutdown_sender()
    }

    fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }

    fn current_connection_id(&self) -> usize {
        self.connection_id.load(Ordering::SeqCst)
    }

    fn begin_reconnect_runner(&self) -> bool {
        !self.reconnect_runner_active.swap(true, Ordering::SeqCst)
    }

    fn finish_reconnect_runner(&self) {
        self.reconnect_runner_active.store(false, Ordering::SeqCst);
    }
}

enum SshSessionInput {
    Data(Vec<u8>),
    Resize(u32, u32),
}

enum SshSessionIoEndReason {
    Shutdown,
    InputClosed,
    WriteFailed,
    RemoteClosed,
    RemoteExitStatus(u32),
    RemoteExitSignal(String),
    ConnectionLost,
}

#[derive(Debug, Clone)]
struct PendingSshConnectRequest {
    cwd: String,
    project_path_key: String,
    ssh_host_id: String,
    title: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    sftp_enabled: bool,
}

enum PendingSshPrompt {
    HostKey {
        request: PendingSshConnectRequest,
        host_key: RuntimeSshKnownHostKey,
    },
    KeyboardInteractive {
        request: PendingSshConnectRequest,
        host_config: RuntimeSshHostConfig,
        title: String,
        size: TerminalSize,
        handle: client::Handle<LiveAgentSshClient>,
    },
}

#[derive(Debug, Clone)]
struct KeyboardInteractivePromptData {
    name: String,
    instructions: String,
    prompt: String,
    echo: bool,
}

enum SshAuthOutcome {
    Authenticated,
    KeyboardInteractivePrompt(KeyboardInteractivePromptData),
}

#[derive(Debug, PartialEq, Eq)]
enum PasswordKbiPromptAction {
    RespondEmpty,
    SendPassword,
    PromptUser,
}

#[derive(Debug, Clone)]
struct CapturedHostKey {
    key: RuntimeSshKnownHostKey,
    status: RuntimeSshKnownHostStatus,
}

#[derive(Debug, Clone)]
struct TerminalOutputChunk {
    start_offset: u64,
    data: Vec<u8>,
}

#[derive(Debug, Default)]
struct TerminalOutputBuffer {
    chunks: VecDeque<TerminalOutputChunk>,
    next_offset: u64,
}

impl TerminalOutputBuffer {
    fn append(&mut self, data: Vec<u8>) -> (u64, u64) {
        let start_offset = self.next_offset;
        self.next_offset = self.next_offset.saturating_add(data.len() as u64);
        self.chunks
            .push_back(TerminalOutputChunk { start_offset, data });
        while self.chunks.len() > MAX_RING_CHUNKS {
            self.chunks.pop_front();
        }
        (start_offset, self.next_offset)
    }
}

impl TerminalEchoDispatchState {
    fn dispatch(&mut self, payload: TerminalStreamEventPayload) -> TerminalOutputDispatch {
        let mut dispatch = TerminalOutputDispatch::default();
        for (index, byte) in payload.bytes.iter().copied().enumerate() {
            let offset = payload.start_offset.saturating_add(index as u64);
            if let Some(origin) = self.consume_echo_byte(byte) {
                match origin {
                    TerminalInputOrigin::Local => {
                        self.push_local_or_defer_remote(&mut dispatch, &payload, byte, offset);
                        if terminal_line_end(byte) {
                            self.flush_remote(&mut dispatch);
                        }
                    }
                    TerminalInputOrigin::Remote => {
                        self.push_remote_or_defer_local(&mut dispatch, &payload, byte, offset);
                        if terminal_line_end(byte) {
                            self.flush_local(&mut dispatch);
                        }
                    }
                }
            } else {
                self.push_visible_to_both(&mut dispatch, &payload, byte, offset);
            }
        }
        dispatch
    }

    fn consume_echo_byte(&mut self, byte: u8) -> Option<TerminalInputOrigin> {
        let front = self.pending.front().copied()?;
        if front.byte == byte || (byte == b'\n' && front.byte == b'\r') {
            self.pending.pop_front();
            return Some(front.origin);
        }
        if terminal_line_end(byte) {
            if let Some(index) = self
                .pending
                .iter()
                .position(|pending| terminal_line_end(pending.byte))
            {
                let origin = self
                    .pending
                    .get(index)
                    .map(|pending| pending.origin)
                    .unwrap_or(front.origin);
                for _ in 0..=index {
                    self.pending.pop_front();
                }
                return Some(origin);
            }
        }
        None
    }

    fn push_local_or_defer_remote(
        &mut self,
        dispatch: &mut TerminalOutputDispatch,
        template: &TerminalStreamEventPayload,
        byte: u8,
        offset: u64,
    ) {
        self.push_local(dispatch, template, byte, offset);
        push_payload_byte(&mut self.deferred_remote, template, byte, offset);
    }

    fn push_remote_or_defer_local(
        &mut self,
        dispatch: &mut TerminalOutputDispatch,
        template: &TerminalStreamEventPayload,
        byte: u8,
        offset: u64,
    ) {
        self.push_remote(dispatch, template, byte, offset);
        push_payload_byte(&mut self.deferred_local, template, byte, offset);
    }

    fn push_visible_to_both(
        &mut self,
        dispatch: &mut TerminalOutputDispatch,
        template: &TerminalStreamEventPayload,
        byte: u8,
        offset: u64,
    ) {
        self.push_local(dispatch, template, byte, offset);
        self.push_remote(dispatch, template, byte, offset);
    }

    fn push_local(
        &mut self,
        dispatch: &mut TerminalOutputDispatch,
        template: &TerminalStreamEventPayload,
        byte: u8,
        offset: u64,
    ) {
        if self.deferred_local.is_empty() {
            push_payload_byte(&mut dispatch.local, template, byte, offset);
        } else {
            push_payload_byte(&mut self.deferred_local, template, byte, offset);
        }
    }

    fn push_remote(
        &mut self,
        dispatch: &mut TerminalOutputDispatch,
        template: &TerminalStreamEventPayload,
        byte: u8,
        offset: u64,
    ) {
        if self.deferred_remote.is_empty() {
            push_payload_byte(&mut dispatch.remote, template, byte, offset);
        } else {
            push_payload_byte(&mut self.deferred_remote, template, byte, offset);
        }
    }

    fn flush_local(&mut self, dispatch: &mut TerminalOutputDispatch) {
        dispatch.local.append(&mut self.deferred_local);
    }

    fn flush_remote(&mut self, dispatch: &mut TerminalOutputDispatch) {
        dispatch.remote.append(&mut self.deferred_remote);
    }

    fn is_empty(&self) -> bool {
        self.pending.is_empty() && self.deferred_local.is_empty() && self.deferred_remote.is_empty()
    }
}

fn push_payload_byte(
    payloads: &mut Vec<TerminalStreamEventPayload>,
    template: &TerminalStreamEventPayload,
    byte: u8,
    offset: u64,
) {
    let end_offset = offset.saturating_add(1);
    if let Some(last) = payloads.last_mut() {
        if last.end_offset == offset
            && last.session_id == template.session_id
            && last.project_path_key == template.project_path_key
        {
            last.bytes.push(byte);
            last.end_offset = end_offset;
            return;
        }
    }
    payloads.push(TerminalStreamEventPayload {
        kind: template.kind.clone(),
        session_id: template.session_id.clone(),
        project_path_key: template.project_path_key.clone(),
        start_offset: offset,
        end_offset,
        bytes: vec![byte],
    });
}

fn terminal_input_echo_candidates(
    data: &[u8],
    origin: TerminalInputOrigin,
) -> Vec<PendingEchoByte> {
    let mut bytes = Vec::new();
    let mut escape = TerminalEscapeParseState::None;
    for byte in data.iter().copied() {
        match escape {
            TerminalEscapeParseState::None => {
                if byte == 0x1b {
                    escape = TerminalEscapeParseState::Esc;
                } else if terminal_input_echo_candidate(byte) {
                    bytes.push(PendingEchoByte { byte, origin });
                }
            }
            TerminalEscapeParseState::Esc => {
                escape = if byte == b'[' {
                    TerminalEscapeParseState::Csi
                } else {
                    TerminalEscapeParseState::None
                };
            }
            TerminalEscapeParseState::Csi => {
                if (0x40..=0x7e).contains(&byte) {
                    escape = TerminalEscapeParseState::None;
                }
            }
        }
    }
    bytes
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalEscapeParseState {
    None,
    Esc,
    Csi,
}

fn terminal_input_echo_candidate(byte: u8) -> bool {
    byte == b'\r' || byte == b'\n' || byte == b'\t' || (byte >= 0x20 && byte != 0x7f)
}

fn terminal_line_end(byte: u8) -> bool {
    byte == b'\r' || byte == b'\n'
}

#[derive(Debug, Clone)]
struct TerminalOutputTail {
    output: Vec<u8>,
    truncated: bool,
    output_start_offset: u64,
    output_end_offset: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalInputOrigin {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy)]
struct PendingEchoByte {
    byte: u8,
    origin: TerminalInputOrigin,
}

#[derive(Debug, Default)]
struct TerminalEchoDispatchState {
    pending: VecDeque<PendingEchoByte>,
    deferred_local: Vec<TerminalStreamEventPayload>,
    deferred_remote: Vec<TerminalStreamEventPayload>,
}

#[derive(Debug, Default)]
struct TerminalOutputDispatch {
    local: Vec<TerminalStreamEventPayload>,
    remote: Vec<TerminalStreamEventPayload>,
}

#[derive(Debug, Default)]
struct SshTerminalTabsState {
    tabs: Vec<SshTerminalTabRecord>,
    revision: u64,
}

#[derive(Default)]
pub struct TerminalSessionRegistry {
    sessions: Mutex<HashMap<String, Arc<TerminalSessionEntry>>>,
    pending_ssh_prompts: Mutex<HashMap<String, PendingSshPrompt>>,
    ssh_terminal_tabs_tx: Mutex<()>,
    ssh_terminal_tabs: Mutex<HashMap<String, SshTerminalTabsState>>,
    app_handle: Mutex<Option<AppHandle>>,
    subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<TerminalEvent>>>>,
    stream_subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<TerminalStreamEvent>>>>,
    echo_dispatch: Mutex<HashMap<String, TerminalEchoDispatchState>>,
    next_subscriber_id: AtomicUsize,
}

impl Drop for TerminalSessionRegistry {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for entry in sessions.values() {
                terminate_terminal_entry(entry);
            }
            sessions.clear();
        }
    }
}

impl TerminalSessionRegistry {
    pub fn attach_app_handle(&self, app_handle: AppHandle) {
        if let Ok(mut slot) = self.app_handle.lock() {
            *slot = Some(app_handle);
        }
    }

    pub fn subscribe(&self) -> (mpsc::Receiver<TerminalEvent>, TerminalSubscriberGuard) {
        let (tx, rx) = mpsc::channel();
        let id = self.next_subscriber_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.insert(id, tx);
        }
        (
            rx,
            TerminalSubscriberGuard {
                id,
                subscribers: Arc::clone(&self.subscribers),
            },
        )
    }

    pub fn subscribe_stream(
        &self,
    ) -> (
        mpsc::Receiver<TerminalStreamEvent>,
        TerminalStreamSubscriberGuard,
    ) {
        let (tx, rx) = mpsc::channel();
        let id = self.next_subscriber_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut subscribers) = self.stream_subscribers.lock() {
            subscribers.insert(id, tx);
        }
        (
            rx,
            TerminalStreamSubscriberGuard {
                id,
                subscribers: Arc::clone(&self.stream_subscribers),
            },
        )
    }

    pub fn list(&self, project_path_key: Option<String>) -> TerminalListResponse {
        let project_key = project_path_key
            .map(|value| normalize_project_path_key(&value))
            .filter(|value| !value.is_empty());
        let mut sessions = self
            .sessions
            .lock()
            .expect("terminal session registry poisoned")
            .values()
            .filter_map(|entry| entry.record.lock().ok().map(|record| record.clone()))
            .filter(|record| {
                project_key
                    .as_ref()
                    .is_none_or(|wanted| project_path_keys_equal(&record.project_path_key, wanted))
            })
            .collect::<Vec<_>>();
        sessions.sort_by(|a, b| {
            a.project_path_key
                .cmp(&b.project_path_key)
                .then(a.created_at.cmp(&b.created_at))
        });
        TerminalListResponse { sessions }
    }

    pub fn create(
        self: &Arc<Self>,
        cwd: String,
        project_path_key: Option<String>,
        shell: Option<String>,
        title: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<TerminalSnapshotResponse, String> {
        let cwd = canonicalize_workdir(&cwd)?;
        let project_key = project_path_key
            .map(|value| normalize_project_path_key(&value))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| normalize_project_path_key(&cwd.display().to_string()));
        if project_key.is_empty() {
            return Err("project_path_key is required".to_string());
        }

        let shell_spec = resolve_shell(shell)?;
        let size = TerminalSize {
            cols: cols.unwrap_or(DEFAULT_COLS).clamp(20, 400),
            rows: rows.unwrap_or(DEFAULT_ROWS).clamp(6, 200),
        };
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| format!("failed to open terminal pty: {err}"))?;

        let mut cmd = CommandBuilder::new(&shell_spec.command);
        for arg in &shell_spec.args {
            cmd.arg(arg);
        }
        cmd.cwd(&cwd);
        configure_terminal_shell_env(&mut cmd, &shell_spec.command);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|err| format!("failed to spawn terminal shell: {err}"))?;
        let pid = child.process_id();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| format!("failed to open terminal reader: {err}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|err| format!("failed to open terminal writer: {err}"))?;
        let (input_tx, input_rx) = mpsc::sync_channel::<Vec<u8>>(256);
        thread::spawn(move || {
            let mut writer = writer;
            while let Ok(data) = input_rx.recv() {
                if data.is_empty() {
                    continue;
                }
                if writer.write_all(&data).is_err() {
                    break;
                }
            }
        });

        let id = uuid::Uuid::new_v4().to_string();
        let title = title
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| self.next_terminal_title(&project_key));
        let now = now_ms();
        let record = TerminalSessionRecord {
            id: id.clone(),
            project_path_key: project_key,
            cwd: cwd.display().to_string(),
            shell: shell_spec.label,
            title,
            kind: "local".to_string(),
            ssh: None,
            pid,
            cols: size.cols,
            rows: size.rows,
            created_at: now,
            updated_at: now,
            finished_at: None,
            exit_code: None,
            running: true,
        };

        let entry = Arc::new(TerminalSessionEntry {
            backend: TerminalSessionBackend::Local {
                master: Mutex::new(pair.master),
                input_tx,
                child: Mutex::new(child),
            },
            record: Mutex::new(record),
            output: Mutex::new(TerminalOutputBuffer::default()),
        });
        self.sessions
            .lock()
            .expect("terminal session registry poisoned")
            .insert(id.clone(), Arc::clone(&entry));
        self.broadcast("created", &entry, None, None, None);

        let registry = Arc::clone(self);
        let reader_session_id = id.clone();
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        registry.append_output(&reader_session_id, buffer[..n].to_vec());
                    }
                    Err(_) => break,
                }
            }
            registry.mark_finished(&reader_session_id);
        });

        self.snapshot(id, Some(MAX_TAIL_BYTES))
    }

    pub async fn create_ssh(
        self: &Arc<Self>,
        cwd: String,
        project_path_key: Option<String>,
        ssh_host_id: String,
        title: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
        sftp_enabled: bool,
    ) -> Result<TerminalSshCreateResponse, String> {
        let cwd = canonicalize_workdir(&cwd)?;
        let project_key = project_path_key
            .map(|value| normalize_project_path_key(&value))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| normalize_project_path_key(&cwd.display().to_string()));
        if project_key.is_empty() {
            return Err("project_path_key is required".to_string());
        }
        let request = PendingSshConnectRequest {
            cwd: cwd.display().to_string(),
            project_path_key: project_key,
            ssh_host_id,
            title,
            cols,
            rows,
            sftp_enabled,
        };
        self.create_ssh_from_request(request).await
    }

    pub async fn answer_ssh_prompt(
        self: &Arc<Self>,
        prompt_id: String,
        answer: Option<String>,
        trust_host_key: bool,
    ) -> Result<TerminalSshCreateResponse, String> {
        let prompt_id = prompt_id.trim().to_string();
        if prompt_id.is_empty() {
            return Err("prompt_id is required".to_string());
        }
        let pending = self
            .pending_ssh_prompts
            .lock()
            .map_err(|_| "ssh prompt registry poisoned".to_string())?
            .remove(&prompt_id)
            .ok_or_else(|| format!("ssh prompt not found: {prompt_id}"))?;
        match pending {
            PendingSshPrompt::HostKey { request, host_key } => {
                if !trust_host_key {
                    return Err("SSH host key trust was cancelled".to_string());
                }
                trust_runtime_ssh_known_host(&host_key)?;
                self.create_ssh_from_request(request).await
            }
            PendingSshPrompt::KeyboardInteractive {
                request,
                host_config,
                title,
                size,
                mut handle,
            } => {
                let response = handle
                    .authenticate_keyboard_interactive_respond(vec![answer.unwrap_or_default()])
                    .await
                    .map_err(|error| {
                        format!("SSH keyboard-interactive response failed: {error}")
                    })?;
                self.continue_ssh_keyboard_interactive(
                    request,
                    host_config,
                    title,
                    size,
                    handle,
                    response,
                    None,
                )
                .await
            }
        }
    }

    pub fn cancel_ssh_prompt(&self, prompt_id: String) -> Result<(), String> {
        let prompt_id = prompt_id.trim().to_string();
        if prompt_id.is_empty() {
            return Err("prompt_id is required".to_string());
        }
        let pending = self
            .pending_ssh_prompts
            .lock()
            .map_err(|_| "ssh prompt registry poisoned".to_string())?
            .remove(&prompt_id);
        if let Some(PendingSshPrompt::KeyboardInteractive { handle, .. }) = pending {
            tokio::spawn(async move {
                let _ = handle
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "Authentication cancelled",
                        "en",
                    )
                    .await;
            });
        }
        Ok(())
    }

    async fn create_ssh_from_request(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
    ) -> Result<TerminalSshCreateResponse, String> {
        let host_config = load_runtime_ssh_host(&request.ssh_host_id)?
            .ok_or_else(|| format!("SSH host not found: {}", request.ssh_host_id.trim()))?;
        if host_config.host.trim().is_empty() {
            return Err("SSH host is required".to_string());
        }
        if host_config.username.trim().is_empty() {
            return Err("SSH username is required".to_string());
        }

        let size = TerminalSize {
            cols: request.cols.unwrap_or(DEFAULT_COLS).clamp(20, 400),
            rows: request.rows.unwrap_or(DEFAULT_ROWS).clamp(6, 200),
        };
        let title = request
            .title
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| self.next_ssh_title(&request.project_path_key, &host_config.name));

        let auth = resolve_ssh_auth_material(&host_config)?;
        let captured_host_key = Arc::new(tokio::sync::Mutex::new(None::<CapturedHostKey>));
        let mut handle =
            match connect_ssh_handle(&host_config, Arc::clone(&captured_host_key)).await {
                Ok(handle) => handle,
                Err(error) => {
                    if let Some(captured) = captured_host_key.lock().await.clone() {
                        return self.ssh_host_key_response(request, &host_config, captured);
                    }
                    return Err(error);
                }
            };

        match authenticate_ssh_handle(&mut handle, &host_config, auth).await? {
            SshAuthOutcome::Authenticated => {
                self.finish_create_ssh_session(request, host_config, title, size, handle)
                    .await
            }
            SshAuthOutcome::KeyboardInteractivePrompt(prompt_data) => self
                .ssh_keyboard_interactive_response(
                    request,
                    host_config,
                    title,
                    size,
                    handle,
                    prompt_data,
                ),
        }
    }

    async fn finish_create_ssh_session(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
        host_config: RuntimeSshHostConfig,
        title: String,
        size: TerminalSize,
        handle: client::Handle<LiveAgentSshClient>,
    ) -> Result<TerminalSshCreateResponse, String> {
        let channel = open_ssh_shell_channel(&handle, size).await?;

        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let ssh = TerminalSshMetadata {
            host_id: host_config.id.clone(),
            host_name: host_config.name.clone(),
            username: host_config.username.clone(),
            host: host_config.host.clone(),
            port: host_config.port,
            auth_type: host_config.auth_type.clone(),
            status: SSH_STATUS_CONNECTED.to_string(),
            reconnect_attempt: 0,
            reconnect_max_attempts: SSH_RECONNECT_MAX_ATTEMPTS,
            sftp_enabled: request.sftp_enabled,
        };
        let record = TerminalSessionRecord {
            id: id.clone(),
            project_path_key: request.project_path_key.clone(),
            cwd: request.cwd.clone(),
            shell: "ssh".to_string(),
            title,
            kind: "ssh".to_string(),
            ssh: Some(ssh),
            pid: None,
            cols: size.cols,
            rows: size.rows,
            created_at: now,
            updated_at: now,
            finished_at: None,
            exit_code: None,
            running: true,
        };

        let runtime = Arc::new(SshSessionRuntime::new());
        let (input_tx, input_rx) = tokio::sync::mpsc::channel::<SshSessionInput>(256);
        let (shutdown_tx, shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
        let connection_id = runtime
            .install_connection(handle, input_tx, shutdown_tx)
            .await;
        let entry = Arc::new(TerminalSessionEntry {
            backend: TerminalSessionBackend::Ssh {
                runtime: Arc::clone(&runtime),
            },
            record: Mutex::new(record),
            output: Mutex::new(TerminalOutputBuffer::default()),
        });
        self.sessions
            .lock()
            .expect("terminal session registry poisoned")
            .insert(id.clone(), Arc::clone(&entry));
        self.broadcast("created", &entry, None, None, None);

        let registry = Arc::clone(self);
        tauri::async_runtime::spawn(run_ssh_session_io(
            registry,
            id.clone(),
            Arc::clone(&runtime),
            connection_id,
            channel,
            input_rx,
            shutdown_rx,
        ));

        self.snapshot(id, Some(MAX_TAIL_BYTES))
            .map(terminal_ssh_create_response_from_snapshot)
    }

    async fn reconnect_ssh_session(
        self: &Arc<Self>,
        entry: Arc<TerminalSessionEntry>,
        attempt: u8,
    ) -> Result<(), String> {
        let record = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        let ssh = record
            .ssh
            .clone()
            .ok_or_else(|| "SSH session metadata is missing".to_string())?;
        let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
            return Err("terminal session is not an SSH connection".to_string());
        };
        if runtime.is_closing() {
            return Err("SSH session is closing".to_string());
        }
        let host_config = load_runtime_ssh_host(&ssh.host_id)?
            .ok_or_else(|| format!("SSH host not found: {}", ssh.host_id.trim()))?;

        let auth = resolve_ssh_auth_material(&host_config)?;
        let captured_host_key = Arc::new(tokio::sync::Mutex::new(None::<CapturedHostKey>));
        let mut handle =
            match connect_ssh_handle(&host_config, Arc::clone(&captured_host_key)).await {
                Ok(handle) => handle,
                Err(error) => {
                    if captured_host_key.lock().await.is_some() {
                        return Err(
                            "SSH host key requires confirmation before reconnecting".to_string()
                        );
                    }
                    return Err(error);
                }
            };

        match authenticate_ssh_handle(&mut handle, &host_config, auth).await? {
            SshAuthOutcome::Authenticated => {}
            SshAuthOutcome::KeyboardInteractivePrompt(_) => {
                let _ = handle
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "Keyboard-interactive reconnect requires user input",
                        "en",
                    )
                    .await;
                return Err(
                    "SSH reconnect requires keyboard-interactive input from the user".to_string(),
                );
            }
        }

        let size = TerminalSize {
            cols: record.cols,
            rows: record.rows,
        };
        let channel = open_ssh_shell_channel(&handle, size).await?;
        let (input_tx, input_rx) = tokio::sync::mpsc::channel::<SshSessionInput>(256);
        let (shutdown_tx, shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
        let connection_id = runtime
            .install_connection(handle, input_tx, shutdown_tx)
            .await;
        {
            let mut record = entry
                .record
                .lock()
                .map_err(|_| "terminal session lock poisoned".to_string())?;
            record.running = true;
            record.finished_at = None;
            record.exit_code = None;
            record.updated_at = now_ms();
            if let Some(ssh) = record.ssh.as_mut() {
                ssh.status = SSH_STATUS_CONNECTED.to_string();
                ssh.reconnect_attempt = 0;
                ssh.reconnect_max_attempts = SSH_RECONNECT_MAX_ATTEMPTS;
            }
        }
        self.append_output(
            &record.id,
            format!("\r\n[SSH] Reconnected after attempt {attempt}.\r\n"),
        );
        self.broadcast("reconnected", &entry, None, None, None);

        let registry = Arc::clone(self);
        tauri::async_runtime::spawn(run_ssh_session_io(
            registry,
            record.id,
            Arc::clone(runtime),
            connection_id,
            channel,
            input_rx,
            shutdown_rx,
        ));
        Ok(())
    }

    async fn handle_ssh_unexpected_disconnect(
        self: Arc<Self>,
        session_id: String,
        runtime: Arc<SshSessionRuntime>,
        connection_id: usize,
    ) {
        if !runtime.begin_reconnect_runner() {
            return;
        }
        if runtime.current_connection_id() != connection_id {
            runtime.finish_reconnect_runner();
            return;
        }
        runtime.clear_connection_if_current(connection_id).await;
        if runtime.is_closing() {
            runtime.finish_reconnect_runner();
            return;
        }
        let Ok(entry) = self.entry(&session_id) else {
            runtime.finish_reconnect_runner();
            return;
        };
        for attempt in 1..=SSH_RECONNECT_MAX_ATTEMPTS {
            if runtime.is_closing() {
                runtime.finish_reconnect_runner();
                return;
            }
            self.mark_ssh_reconnecting(&entry, attempt);
            self.append_output(
                &session_id,
                format!(
                    "\r\n[SSH] Connection lost. Reconnecting ({attempt}/{SSH_RECONNECT_MAX_ATTEMPTS})...\r\n"
                ),
            );
            let delay = SSH_RECONNECT_DELAYS
                .get(usize::from(attempt.saturating_sub(1)))
                .copied()
                .unwrap_or_else(|| Duration::from_secs(10));
            tokio::time::sleep(delay).await;
            if runtime.is_closing() {
                runtime.finish_reconnect_runner();
                return;
            }
            let reconnect_result = match timeout(
                SSH_RECONNECT_ATTEMPT_TIMEOUT,
                self.reconnect_ssh_session(Arc::clone(&entry), attempt),
            )
            .await
            {
                Ok(result) => result,
                Err(_) => Err(format!(
                    "SSH reconnect timed out after {} seconds",
                    SSH_RECONNECT_ATTEMPT_TIMEOUT.as_secs()
                )),
            };
            match reconnect_result {
                Ok(()) => {
                    runtime.finish_reconnect_runner();
                    return;
                }
                Err(error) => {
                    self.append_output(
                        &session_id,
                        format!(
                            "[SSH] Reconnect attempt {attempt}/{SSH_RECONNECT_MAX_ATTEMPTS} failed: {error}\r\n"
                        ),
                    );
                }
            }
        }
        self.mark_ssh_disconnected(&entry);
        self.append_output(
            &session_id,
            format!("[SSH] Reconnect failed after {SSH_RECONNECT_MAX_ATTEMPTS} attempts.\r\n"),
        );
        runtime.finish_reconnect_runner();
    }

    async fn continue_ssh_keyboard_interactive(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
        host_config: RuntimeSshHostConfig,
        title: String,
        size: TerminalSize,
        mut handle: client::Handle<LiveAgentSshClient>,
        response: client::KeyboardInteractiveAuthResponse,
        auto_password: Option<String>,
    ) -> Result<TerminalSshCreateResponse, String> {
        match continue_keyboard_interactive_auth(&mut handle, response, auto_password).await? {
            SshAuthOutcome::Authenticated => {
                self.finish_create_ssh_session(request, host_config, title, size, handle)
                    .await
            }
            SshAuthOutcome::KeyboardInteractivePrompt(prompt_data) => self
                .ssh_keyboard_interactive_response(
                    request,
                    host_config,
                    title,
                    size,
                    handle,
                    prompt_data,
                ),
        }
    }

    fn ssh_keyboard_interactive_response(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
        host_config: RuntimeSshHostConfig,
        title: String,
        size: TerminalSize,
        handle: client::Handle<LiveAgentSshClient>,
        prompt_data: KeyboardInteractivePromptData,
    ) -> Result<TerminalSshCreateResponse, String> {
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let message = ssh_keyboard_interactive_message(&prompt_data);
        let prompt = TerminalSshPrompt {
            id: prompt_id.clone(),
            kind: "keyboardInteractive".to_string(),
            host_id: host_config.id.clone(),
            host_name: host_config.name.clone(),
            host: host_config.host.clone(),
            port: host_config.port,
            message,
            fingerprint_sha256: String::new(),
            key_type: String::new(),
            answer_echo: prompt_data.echo,
        };
        self.pending_ssh_prompts
            .lock()
            .map_err(|_| "ssh prompt registry poisoned".to_string())?
            .insert(
                prompt_id.clone(),
                PendingSshPrompt::KeyboardInteractive {
                    request,
                    host_config,
                    title,
                    size,
                    handle,
                },
            );
        self.schedule_ssh_prompt_timeout(prompt_id);
        Ok(TerminalSshCreateResponse {
            session: None,
            output: String::new(),
            output_bytes: Vec::new(),
            truncated: false,
            output_start_offset: 0,
            output_end_offset: 0,
            ssh_prompt: Some(prompt),
        })
    }

    fn ssh_host_key_response(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
        host_config: &RuntimeSshHostConfig,
        captured: CapturedHostKey,
    ) -> Result<TerminalSshCreateResponse, String> {
        match captured.status {
            RuntimeSshKnownHostStatus::Known => {
                Err("SSH host key check failed unexpectedly".to_string())
            }
            RuntimeSshKnownHostStatus::Changed { stored_fingerprint } => Err(format!(
                "SSH host key changed for {}:{}. Stored fingerprint: {}. Received fingerprint: {}.",
                host_config.host,
                host_config.port,
                stored_fingerprint,
                captured.key.fingerprint_sha256
            )),
            RuntimeSshKnownHostStatus::Unknown => {
                let prompt_id = uuid::Uuid::new_v4().to_string();
                let prompt = TerminalSshPrompt {
                    id: prompt_id.clone(),
                    kind: "hostKey".to_string(),
                    host_id: host_config.id.clone(),
                    host_name: host_config.name.clone(),
                    host: host_config.host.clone(),
                    port: host_config.port,
                    message: format!(
                        "Trust SSH host key for {}:{}?",
                        host_config.host, host_config.port
                    ),
                    fingerprint_sha256: captured.key.fingerprint_sha256.clone(),
                    key_type: captured.key.key_type.clone(),
                    answer_echo: false,
                };
                self.pending_ssh_prompts
                    .lock()
                    .map_err(|_| "ssh prompt registry poisoned".to_string())?
                    .insert(
                        prompt_id.clone(),
                        PendingSshPrompt::HostKey {
                            request,
                            host_key: captured.key,
                        },
                    );
                self.schedule_ssh_prompt_timeout(prompt_id);
                Ok(TerminalSshCreateResponse {
                    session: None,
                    output: String::new(),
                    output_bytes: Vec::new(),
                    truncated: false,
                    output_start_offset: 0,
                    output_end_offset: 0,
                    ssh_prompt: Some(prompt),
                })
            }
        }
    }

    fn schedule_ssh_prompt_timeout(self: &Arc<Self>, prompt_id: String) {
        let registry = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(SSH_PROMPT_TIMEOUT).await;
            let pending = registry
                .pending_ssh_prompts
                .lock()
                .ok()
                .and_then(|mut prompts| prompts.remove(&prompt_id));
            if let Some(PendingSshPrompt::KeyboardInteractive { handle, .. }) = pending {
                let _ = handle
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "Authentication prompt timed out",
                        "en",
                    )
                    .await;
            }
        });
    }

    pub fn snapshot(
        &self,
        session_id: String,
        max_bytes: Option<usize>,
    ) -> Result<TerminalSnapshotResponse, String> {
        let entry = self.entry(&session_id)?;
        let session = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        let tail = read_output_tail(&entry, max_bytes.unwrap_or(MAX_TAIL_BYTES));
        Ok(TerminalSnapshotResponse {
            session,
            output: String::from_utf8_lossy(&tail.output).into_owned(),
            output_bytes: tail.output,
            truncated: tail.truncated,
            output_start_offset: tail.output_start_offset,
            output_end_offset: tail.output_end_offset,
        })
    }

    pub fn stream_attach(
        &self,
        session_id: String,
        max_bytes: Option<usize>,
    ) -> Result<TerminalStreamSnapshotResponse, String> {
        let entry = self.entry(&session_id)?;
        let session = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        let tail = read_output_tail(&entry, max_bytes.unwrap_or(MAX_TAIL_BYTES));
        Ok(TerminalStreamSnapshotResponse {
            session,
            bytes: tail.output,
            truncated: tail.truncated,
            output_start_offset: tail.output_start_offset,
            output_end_offset: tail.output_end_offset,
        })
    }

    pub fn session_record(&self, session_id: String) -> Result<TerminalSessionRecord, String> {
        self.record(session_id)
    }

    pub fn ssh_session_info(&self, session_id: &str) -> Result<TerminalSshSessionInfo, String> {
        let record = self.record(session_id.to_string())?;
        if record.kind.trim() != "ssh" {
            return Err("terminal session is not an SSH connection".to_string());
        }
        let ssh = record
            .ssh
            .ok_or_else(|| "SSH session metadata is missing".to_string())?;
        Ok(TerminalSshSessionInfo {
            project_path_key: record.project_path_key,
            cwd: record.cwd,
            running: record.running,
            host_id: ssh.host_id,
            sftp_enabled: ssh.sftp_enabled,
        })
    }

    pub fn ssh_terminal_tabs_list(
        &self,
        project_path_key: String,
    ) -> Result<SshTerminalTabsSnapshot, String> {
        let project_key = required_project_key(project_path_key)?;
        let (snapshot, should_broadcast) = {
            let _tabs_tx = self.lock_ssh_terminal_tabs_tx()?;
            if let Some(snapshot) = self.prune_invalid_ssh_terminal_tabs_for_project(&project_key) {
                (snapshot, true)
            } else {
                (self.ssh_terminal_tabs_snapshot(&project_key), false)
            }
        };
        if should_broadcast {
            self.broadcast_ssh_tabs_snapshot(snapshot.clone());
        }
        Ok(snapshot)
    }

    pub fn ssh_terminal_tab_open(
        &self,
        session_id: String,
        kind: String,
    ) -> Result<SshTerminalTabsSnapshot, String> {
        let kind = normalize_ssh_terminal_tab_kind(&kind)?;
        let (snapshot, should_broadcast) = {
            let _tabs_tx = self.lock_ssh_terminal_tabs_tx()?;
            let session = self.valid_ssh_terminal_tab_session(&session_id, &kind)?;
            let tab_id = ssh_terminal_tab_id(&session.id, &kind);
            let now = now_ms();
            let mut tabs_by_project = self
                .ssh_terminal_tabs
                .lock()
                .map_err(|_| "ssh terminal tabs registry poisoned".to_string())?;
            let state = tabs_by_project
                .entry(session.project_path_key.clone())
                .or_default();
            if state.tabs.iter().any(|tab| tab.id == tab_id) {
                return Ok(ssh_terminal_tabs_snapshot_from_state(
                    &session.project_path_key,
                    state,
                ));
            } else {
                state.tabs.push(SshTerminalTabRecord {
                    id: tab_id.clone(),
                    session_id: session.id.clone(),
                    project_path_key: session.project_path_key.clone(),
                    kind,
                    created_at: now,
                    updated_at: now,
                });
            }
            state.revision = state.revision.saturating_add(1);
            (
                ssh_terminal_tabs_snapshot_from_state(&session.project_path_key, state),
                true,
            )
        };
        if should_broadcast {
            self.broadcast_ssh_tabs_snapshot(snapshot.clone());
        }
        Ok(snapshot)
    }

    pub fn ssh_terminal_tab_close(
        &self,
        tab_id: String,
    ) -> Result<SshTerminalTabsSnapshot, String> {
        let tab_id = tab_id.trim();
        if tab_id.is_empty() {
            return Err("tab_id is required".to_string());
        }
        let snapshot = {
            let _tabs_tx = self.lock_ssh_terminal_tabs_tx()?;
            let mut tabs_by_project = self
                .ssh_terminal_tabs
                .lock()
                .map_err(|_| "ssh terminal tabs registry poisoned".to_string())?;
            let Some(project_key) = tabs_by_project.iter().find_map(|(project_key, state)| {
                state
                    .tabs
                    .iter()
                    .any(|tab| tab.id == tab_id)
                    .then(|| project_key.clone())
            }) else {
                return Err(format!("ssh terminal tab not found: {tab_id}"));
            };
            let state = tabs_by_project
                .get_mut(&project_key)
                .ok_or_else(|| format!("ssh terminal tab not found: {tab_id}"))?;
            let Some(index) = state.tabs.iter().position(|tab| tab.id == tab_id) else {
                return Err(format!("ssh terminal tab not found: {tab_id}"));
            };
            state.tabs.remove(index);
            state.revision = state.revision.saturating_add(1);
            ssh_terminal_tabs_snapshot_from_state(&project_key, state)
        };
        self.broadcast_ssh_tabs_snapshot(snapshot.clone());
        Ok(snapshot)
    }

    pub async fn ssh_latency(
        self: &Arc<Self>,
        session_id: String,
    ) -> Result<TerminalSshLatencyResponse, String> {
        let entry = self.entry(&session_id)?;
        let record = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        if record.kind.trim() != "ssh" {
            return Err("terminal session is not an SSH connection".to_string());
        }
        if !record.running {
            return Err("SSH connection is not running".to_string());
        }
        let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
            return Err("terminal session is not an SSH connection".to_string());
        };
        let start = Instant::now();
        let ping = timeout(Duration::from_secs(3), async {
            let handle = runtime.handle.lock().await;
            let Some(handle) = handle.as_ref() else {
                return Err(russh::Error::Disconnect);
            };
            handle.send_ping().await
        })
        .await;
        match ping {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(format!("SSH latency check failed: {error}")),
            Err(_) => return Err("SSH latency check timed out".to_string()),
        }
        let elapsed = start.elapsed().as_millis().clamp(1, u128::from(u32::MAX)) as u32;
        Ok(TerminalSshLatencyResponse {
            session_id: record.id,
            latency_ms: elapsed,
        })
    }

    pub async fn ssh_exec(
        self: &Arc<Self>,
        session_id: String,
        command: String,
        cwd: Option<String>,
        timeout_ms: Option<u64>,
        max_bytes: Option<usize>,
    ) -> Result<TerminalSshExecResponse, String> {
        let command = command.trim().to_string();
        if command.is_empty() {
            return Err("command is required".to_string());
        }
        let entry = self.entry(&session_id)?;
        let record = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        if record.kind.trim() != "ssh" {
            return Err("terminal session is not an SSH connection".to_string());
        }
        if !record.running {
            return Err("SSH connection is not running".to_string());
        }
        let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
            return Err("terminal session is not an SSH connection".to_string());
        };

        let cwd = cwd
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let wrapped_command = wrap_ssh_exec_command(&command, cwd.as_deref());
        let timeout_duration = normalize_ssh_exec_timeout(timeout_ms);
        let capture_limit = normalize_ssh_exec_max_bytes(max_bytes);
        let start = Instant::now();
        let result = timeout(
            timeout_duration,
            run_ssh_exec_channel(runtime, wrapped_command, capture_limit),
        )
        .await;
        let duration_ms = start.elapsed().as_millis();

        match result {
            Ok(Ok(mut response)) => {
                response.session_id = record.id;
                response.command = command;
                response.cwd = cwd;
                response.duration_ms = duration_ms;
                Ok(response)
            }
            Ok(Err(error)) => {
                spawn_ssh_reconnect_runner(
                    Arc::clone(self),
                    record.id,
                    Arc::clone(runtime),
                    runtime.current_connection_id(),
                );
                Err(format!("SSH exec failed: {error}"))
            }
            Err(_) => Ok(TerminalSshExecResponse {
                session_id: record.id,
                command,
                cwd,
                exit_code: None,
                exit_signal: None,
                stdout: String::new(),
                stderr: String::new(),
                stdout_truncated: false,
                stderr_truncated: false,
                timed_out: true,
                duration_ms,
            }),
        }
    }

    pub fn input_bytes(&self, session_id: String, data: Vec<u8>) -> Result<(), String> {
        self.input_bytes_with_origin(session_id, data, TerminalInputOrigin::Local)
    }

    pub fn input_bytes_from_remote(&self, session_id: String, data: Vec<u8>) -> Result<(), String> {
        self.input_bytes_with_origin(session_id, data, TerminalInputOrigin::Remote)
    }

    fn input_bytes_with_origin(
        &self,
        session_id: String,
        data: Vec<u8>,
        origin: TerminalInputOrigin,
    ) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        let entry = self.entry(&session_id)?;
        let running = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .running;
        if !running {
            return Err("terminal session is not running".to_string());
        }
        let echo_bytes = terminal_input_echo_candidates(&data, origin);
        match &entry.backend {
            TerminalSessionBackend::Local { input_tx, .. } => {
                input_tx
                    .try_send(data)
                    .map_err(|err| format!("failed to enqueue terminal input: {err}"))?;
            }
            TerminalSessionBackend::Ssh { runtime } => {
                runtime
                    .input_sender()
                    .ok_or_else(|| "SSH connection is not connected".to_string())?
                    .try_send(SshSessionInput::Data(data))
                    .map_err(|err| format!("failed to enqueue ssh terminal input: {err}"))?;
            }
        }
        self.record_input_echo_candidates(&session_id, echo_bytes);
        self.touch(&entry);
        Ok(())
    }

    pub fn stream_resize(&self, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
        self.resize(session_id, cols, rows).map(|_| ())
    }

    pub fn resize(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        let cols = cols.clamp(20, 400);
        let rows = rows.clamp(6, 200);
        match &entry.backend {
            TerminalSessionBackend::Local { master, .. } => {
                master
                    .lock()
                    .map_err(|_| "terminal master lock poisoned".to_string())?
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|err| format!("failed to resize terminal: {err}"))?;
            }
            TerminalSessionBackend::Ssh { runtime } => {
                if let Some(input_tx) = runtime.input_sender() {
                    input_tx
                        .try_send(SshSessionInput::Resize(u32::from(cols), u32::from(rows)))
                        .map_err(|err| format!("failed to resize ssh terminal: {err}"))?;
                }
            }
        }
        {
            let mut record = entry
                .record
                .lock()
                .map_err(|_| "terminal session lock poisoned".to_string())?;
            record.cols = cols;
            record.rows = rows;
            record.updated_at = now_ms();
        }
        self.broadcast("resized", &entry, None, None, None);
        self.record(session_id)
    }

    pub fn rename(
        &self,
        session_id: String,
        title: String,
    ) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        let next_title = title.trim();
        if next_title.is_empty() {
            return Err("terminal title cannot be empty".to_string());
        }
        {
            let mut record = entry
                .record
                .lock()
                .map_err(|_| "terminal session lock poisoned".to_string())?;
            record.title = next_title.to_string();
            record.updated_at = now_ms();
        }
        self.broadcast("renamed", &entry, None, None, None);
        self.record(session_id)
    }

    pub fn close(&self, session_id: String) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        terminate_terminal_entry(&entry);
        let (session, tab_snapshots) = {
            let _tabs_tx = self.lock_ssh_terminal_tabs_tx()?;
            self.mark_finished(&session_id);
            self.sessions
                .lock()
                .expect("terminal session registry poisoned")
                .remove(session_id.trim());
            let session = entry
                .record
                .lock()
                .map_err(|_| "terminal session lock poisoned".to_string())?
                .clone();
            let tab_snapshots = self.prune_ssh_terminal_tabs_for_session_locked(&session.id);
            (session, tab_snapshots)
        };
        self.broadcast("closed", &entry, None, None, None);
        for snapshot in tab_snapshots {
            self.broadcast_ssh_tabs_snapshot(snapshot);
        }
        Ok(session)
    }

    pub fn close_all(&self) -> Result<TerminalListResponse, String> {
        let ids = self
            .sessions
            .lock()
            .expect("terminal session registry poisoned")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        self.close_ids(ids)
    }

    pub fn close_project(&self, project_path_key: String) -> Result<TerminalListResponse, String> {
        let project_key = normalize_project_path_key(&project_path_key);
        if project_key.is_empty() {
            return Err("project_path_key is required".to_string());
        }
        let ids = self
            .sessions
            .lock()
            .expect("terminal session registry poisoned")
            .iter()
            .filter_map(|(id, entry)| {
                entry
                    .record
                    .lock()
                    .ok()
                    .filter(|record| {
                        project_path_keys_equal(&record.project_path_key, &project_key)
                    })
                    .map(|_| id.clone())
            })
            .collect::<Vec<_>>();
        self.close_ids(ids)
    }

    pub fn running_session_count(&self) -> usize {
        self.sessions
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .values()
                    .filter_map(|entry| entry.record.lock().ok())
                    .filter(|record| record.running)
                    .count()
            })
            .unwrap_or(0)
    }

    pub fn read_tail(
        &self,
        project_path_key: String,
        session_id: Option<String>,
        max_bytes: Option<usize>,
    ) -> Result<TerminalReadTailResponse, String> {
        let project_key = normalize_project_path_key(&project_path_key);
        if project_key.is_empty() {
            return Err("project_path_key is required".to_string());
        }
        let sessions = self.list(Some(project_key.clone())).sessions;
        if sessions.is_empty() {
            return Ok(TerminalReadTailResponse {
                sessions: Vec::new(),
                selected_session: None,
                output: String::new(),
                truncated: false,
            });
        }
        let requested_session_id = session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if requested_session_id.is_none() && sessions.len() > 1 {
            return Ok(TerminalReadTailResponse {
                sessions,
                selected_session: None,
                output: String::new(),
                truncated: false,
            });
        }
        let selected_id = requested_session_id.unwrap_or_else(|| sessions[0].id.clone());
        let snapshot = self.snapshot(selected_id, max_bytes)?;
        if !project_path_keys_equal(&snapshot.session.project_path_key, &project_key) {
            return Err("terminal session is outside the current project".to_string());
        }
        Ok(TerminalReadTailResponse {
            sessions,
            selected_session: Some(snapshot.session),
            output: snapshot.output,
            truncated: snapshot.truncated,
        })
    }

    fn lock_ssh_terminal_tabs_tx(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.ssh_terminal_tabs_tx
            .lock()
            .map_err(|_| "ssh terminal tabs transaction lock poisoned".to_string())
    }

    fn valid_ssh_terminal_tab_session(
        &self,
        session_id: &str,
        kind: &str,
    ) -> Result<TerminalSessionRecord, String> {
        let session = self.record(session_id.trim().to_string())?;
        if session.kind.trim() != "ssh" {
            return Err("terminal session is not an SSH connection".to_string());
        }
        let ssh = session
            .ssh
            .as_ref()
            .ok_or_else(|| "SSH session metadata is missing".to_string())?;
        if ssh.status == SSH_STATUS_DISCONNECTED {
            return Err("SSH connection is disconnected".to_string());
        }
        if kind == "sftp" && !ssh.sftp_enabled {
            return Err("SFTP is not enabled for this SSH session".to_string());
        }
        Ok(session)
    }

    fn ssh_terminal_tabs_snapshot(&self, project_path_key: &str) -> SshTerminalTabsSnapshot {
        self.ssh_terminal_tabs
            .lock()
            .ok()
            .and_then(|tabs_by_project| {
                tabs_by_project
                    .get(project_path_key)
                    .map(|state| ssh_terminal_tabs_snapshot_from_state(project_path_key, state))
            })
            .unwrap_or_else(|| SshTerminalTabsSnapshot {
                project_path_key: project_path_key.to_string(),
                tabs: Vec::new(),
                revision: 0,
            })
    }

    fn prune_invalid_ssh_terminal_tabs_for_project(
        &self,
        project_path_key: &str,
    ) -> Option<SshTerminalTabsSnapshot> {
        let valid_sessions = self
            .sessions
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .values()
                    .filter_map(|entry| entry.record.lock().ok().map(|record| record.clone()))
                    .filter(|record| {
                        project_path_keys_equal(&record.project_path_key, project_path_key)
                            && record.kind.trim() == "ssh"
                            && record
                                .ssh
                                .as_ref()
                                .map(|ssh| ssh.status != SSH_STATUS_DISCONNECTED)
                                .unwrap_or(false)
                    })
                    .map(|record| {
                        (
                            record.id,
                            record.ssh.map(|ssh| ssh.sftp_enabled).unwrap_or(false),
                        )
                    })
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();

        let mut tabs_by_project = self.ssh_terminal_tabs.lock().ok()?;
        let state = tabs_by_project.get_mut(project_path_key)?;
        let before_len = state.tabs.len();
        state.tabs.retain(|tab| {
            valid_sessions
                .get(&tab.session_id)
                .map(|sftp_enabled| tab.kind != "sftp" || *sftp_enabled)
                .unwrap_or(false)
        });
        if state.tabs.len() == before_len {
            return None;
        }
        state.revision = state.revision.saturating_add(1);
        Some(ssh_terminal_tabs_snapshot_from_state(
            project_path_key,
            state,
        ))
    }

    fn prune_ssh_terminal_tabs_for_session_locked(
        &self,
        session_id: &str,
    ) -> Vec<SshTerminalTabsSnapshot> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Vec::new();
        }
        let mut tabs_by_project = match self.ssh_terminal_tabs.lock() {
            Ok(tabs_by_project) => tabs_by_project,
            Err(_) => return Vec::new(),
        };
        let mut snapshots = Vec::new();
        for (project_key, state) in tabs_by_project.iter_mut() {
            let before_len = state.tabs.len();
            state.tabs.retain(|tab| tab.session_id != session_id);
            if state.tabs.len() == before_len {
                continue;
            }
            state.revision = state.revision.saturating_add(1);
            snapshots.push(ssh_terminal_tabs_snapshot_from_state(project_key, state));
        }
        snapshots
    }

    fn close_ids(&self, ids: Vec<String>) -> Result<TerminalListResponse, String> {
        let mut sessions = Vec::new();
        for id in ids {
            sessions.push(self.close(id)?);
        }
        Ok(TerminalListResponse { sessions })
    }

    fn next_terminal_title(&self, project_path_key: &str) -> String {
        let count = self
            .sessions
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .values()
                    .filter_map(|entry| entry.record.lock().ok())
                    .filter(|record| {
                        project_path_keys_equal(&record.project_path_key, project_path_key)
                    })
                    .count()
            })
            .unwrap_or(0);
        format!("Terminal {}", count + 1)
    }

    fn next_ssh_title(&self, project_path_key: &str, host_name: &str) -> String {
        let base = host_name.trim();
        let base = if base.is_empty() { "SSH" } else { base };
        let count = self
            .sessions
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .values()
                    .filter_map(|entry| entry.record.lock().ok())
                    .filter(|record| {
                        project_path_keys_equal(&record.project_path_key, project_path_key)
                            && record.kind == "ssh"
                            && record.title.starts_with(base)
                    })
                    .count()
            })
            .unwrap_or(0);
        if count == 0 {
            base.to_string()
        } else {
            format!("{base} {}", count + 1)
        }
    }

    fn entry(&self, session_id: &str) -> Result<Arc<TerminalSessionEntry>, String> {
        let id = session_id.trim();
        if id.is_empty() {
            return Err("terminal_id is required".to_string());
        }
        self.sessions
            .lock()
            .expect("terminal session registry poisoned")
            .get(id)
            .cloned()
            .ok_or_else(|| format!("terminal session not found: {id}"))
    }

    fn record(&self, session_id: String) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        entry
            .record
            .lock()
            .map(|record| record.clone())
            .map_err(|_| "terminal session lock poisoned".to_string())
    }

    fn touch(&self, entry: &Arc<TerminalSessionEntry>) {
        if let Ok(mut record) = entry.record.lock() {
            record.updated_at = now_ms();
        }
    }

    fn append_output(&self, session_id: &str, data: impl Into<Vec<u8>>) {
        let Ok(entry) = self.entry(session_id) else {
            return;
        };
        let data = data.into();
        if data.is_empty() {
            return;
        }
        let (output_start_offset, output_end_offset) = {
            let mut output = match entry.output.lock() {
                Ok(output) => output,
                Err(_) => return,
            };
            output.append(data.clone())
        };
        self.touch(&entry);
        self.broadcast_output(&entry, data, output_start_offset, output_end_offset);
    }

    fn record_input_echo_candidates(&self, session_id: &str, echo_bytes: Vec<PendingEchoByte>) {
        if echo_bytes.is_empty() {
            return;
        }
        let Ok(mut states) = self.echo_dispatch.lock() else {
            return;
        };
        let state = states.entry(session_id.to_string()).or_default();
        state.pending.extend(echo_bytes);
        while state.pending.len() > MAX_TAIL_BYTES {
            state.pending.pop_front();
        }
    }

    fn mark_finished(&self, session_id: &str) {
        let Ok(entry) = self.entry(session_id) else {
            return;
        };
        let mut exit_code = None;
        if let TerminalSessionBackend::Local { child, .. } = &entry.backend {
            if let Ok(mut child) = child.lock() {
                if let Ok(status) = child.try_wait() {
                    exit_code = status.map(|status| status.exit_code() as i32);
                }
            }
        }
        {
            let mut record = match entry.record.lock() {
                Ok(record) => record,
                Err(_) => return,
            };
            if record.running {
                record.running = false;
                record.finished_at = Some(now_ms());
                record.exit_code = exit_code;
                record.updated_at = now_ms();
            }
        }
        self.broadcast("exit", &entry, None, None, None);
    }

    fn mark_ssh_reconnecting(&self, entry: &Arc<TerminalSessionEntry>, attempt: u8) {
        {
            let mut record = match entry.record.lock() {
                Ok(record) => record,
                Err(_) => return,
            };
            record.running = false;
            record.finished_at = None;
            record.exit_code = None;
            record.updated_at = now_ms();
            if let Some(ssh) = record.ssh.as_mut() {
                ssh.status = SSH_STATUS_RECONNECTING.to_string();
                ssh.reconnect_attempt = attempt;
                ssh.reconnect_max_attempts = SSH_RECONNECT_MAX_ATTEMPTS;
            }
        }
        self.broadcast("reconnecting", entry, None, None, None);
    }

    fn mark_ssh_disconnected(&self, entry: &Arc<TerminalSessionEntry>) {
        let tab_snapshots = {
            let Ok(_tabs_tx) = self.lock_ssh_terminal_tabs_tx() else {
                return;
            };
            let session_id = {
                let mut record = match entry.record.lock() {
                    Ok(record) => record,
                    Err(_) => return,
                };
                let session_id = record.id.clone();
                record.running = false;
                record.finished_at = Some(now_ms());
                record.exit_code = None;
                record.updated_at = now_ms();
                if let Some(ssh) = record.ssh.as_mut() {
                    ssh.status = SSH_STATUS_DISCONNECTED.to_string();
                    ssh.reconnect_attempt = SSH_RECONNECT_MAX_ATTEMPTS;
                    ssh.reconnect_max_attempts = SSH_RECONNECT_MAX_ATTEMPTS;
                }
                session_id
            };
            self.prune_ssh_terminal_tabs_for_session_locked(&session_id)
        };
        self.broadcast("exit", entry, None, None, None);
        for snapshot in tab_snapshots {
            self.broadcast_ssh_tabs_snapshot(snapshot);
        }
    }

    async fn mark_ssh_shell_ended(
        self: Arc<Self>,
        session_id: String,
        runtime: Arc<SshSessionRuntime>,
        connection_id: usize,
        message: String,
    ) {
        if runtime.current_connection_id() != connection_id || runtime.is_closing() {
            return;
        }
        runtime.clear_connection_if_current(connection_id).await;
        if message.trim().len() > 0 {
            self.append_output(&session_id, message);
        }
        if let Ok(entry) = self.entry(&session_id) {
            self.mark_ssh_disconnected(&entry);
        }
    }

    fn broadcast(
        &self,
        kind: &str,
        entry: &Arc<TerminalSessionEntry>,
        data: Option<Vec<u8>>,
        output_start_offset: Option<u64>,
        output_end_offset: Option<u64>,
    ) {
        let Ok(record) = entry.record.lock().map(|record| record.clone()) else {
            return;
        };
        let payload = TerminalEventPayload {
            kind: kind.to_string(),
            session_id: record.id.clone(),
            project_path_key: record.project_path_key.clone(),
            session: Some(record),
            data,
            output_start_offset,
            output_end_offset,
            ssh_tabs: None,
        };

        if let Ok(app_handle) = self.app_handle.lock() {
            if let Some(app_handle) = app_handle.as_ref() {
                let _ = app_handle.emit(TERMINAL_EVENT_NAME, &payload);
            }
        }

        let subscribers = self
            .subscribers
            .lock()
            .map(|subscribers| subscribers.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let event = TerminalEvent { payload };
        for subscriber in subscribers {
            let _ = subscriber.send(event.clone());
        }
    }

    fn broadcast_output(
        &self,
        entry: &Arc<TerminalSessionEntry>,
        bytes: Vec<u8>,
        start_offset: u64,
        end_offset: u64,
    ) {
        let Ok(record) = entry.record.lock().map(|record| record.clone()) else {
            return;
        };
        let payload = TerminalStreamEventPayload {
            kind: "output".to_string(),
            session_id: record.id,
            project_path_key: record.project_path_key,
            start_offset,
            end_offset,
            bytes,
        };

        let dispatch = self.dispatch_terminal_stream_payload(payload);
        self.broadcast_terminal_stream_subscribers(&dispatch.remote);
        self.emit_terminal_stream_local(&dispatch.local);
    }

    fn dispatch_terminal_stream_payload(
        &self,
        payload: TerminalStreamEventPayload,
    ) -> TerminalOutputDispatch {
        let Ok(mut states) = self.echo_dispatch.lock() else {
            return TerminalOutputDispatch {
                local: vec![payload.clone()],
                remote: vec![payload],
            };
        };
        let session_id = payload.session_id.clone();
        let dispatch = {
            let Some(state) = states.get_mut(&session_id) else {
                return TerminalOutputDispatch {
                    local: vec![payload.clone()],
                    remote: vec![payload],
                };
            };
            state.dispatch(payload)
        };
        if states
            .get(&session_id)
            .is_some_and(TerminalEchoDispatchState::is_empty)
        {
            states.remove(&session_id);
        }
        dispatch
    }

    fn emit_terminal_stream_local(&self, payloads: &[TerminalStreamEventPayload]) {
        if payloads.is_empty() {
            return;
        }
        if let Ok(app_handle) = self.app_handle.lock() {
            if let Some(app_handle) = app_handle.as_ref() {
                for payload in payloads {
                    let _ = app_handle.emit(TERMINAL_STREAM_EVENT_NAME, payload);
                }
            }
        }
    }

    fn broadcast_terminal_stream_subscribers(&self, payloads: &[TerminalStreamEventPayload]) {
        if payloads.is_empty() {
            return;
        }
        let subscribers = self
            .stream_subscribers
            .lock()
            .map(|subscribers| subscribers.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for payload in payloads {
            let event = TerminalStreamEvent {
                payload: payload.clone(),
            };
            for subscriber in &subscribers {
                let _ = subscriber.send(event.clone());
            }
        }
    }

    fn broadcast_ssh_tabs_snapshot(&self, snapshot: SshTerminalTabsSnapshot) {
        let payload = TerminalEventPayload {
            kind: "ssh_tabs_updated".to_string(),
            session_id: String::new(),
            project_path_key: snapshot.project_path_key.clone(),
            session: None,
            data: None,
            output_start_offset: None,
            output_end_offset: None,
            ssh_tabs: Some(snapshot),
        };

        if let Ok(app_handle) = self.app_handle.lock() {
            if let Some(app_handle) = app_handle.as_ref() {
                let _ = app_handle.emit(TERMINAL_EVENT_NAME, &payload);
            }
        }

        let subscribers = self
            .subscribers
            .lock()
            .map(|subscribers| subscribers.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let event = TerminalEvent { payload };
        for subscriber in subscribers {
            let _ = subscriber.send(event.clone());
        }
    }
}

pub(crate) struct TerminalSftpConnection {
    pub(crate) _handle: client::Handle<LiveAgentSshClient>,
    pub(crate) session: russh_sftp::client::SftpSession,
}

pub(crate) struct LiveAgentSshClient {
    host: String,
    port: u16,
    captured_host_key: Arc<tokio::sync::Mutex<Option<CapturedHostKey>>>,
}

impl client::Handler for LiveAgentSshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let key_base64 =
            base64::engine::general_purpose::STANDARD.encode(server_public_key.public_key_bytes());
        let key = RuntimeSshKnownHostKey {
            host: self.host.clone(),
            port: self.port,
            key_type: server_public_key.algorithm().as_str().to_string(),
            key_base64,
            fingerprint_sha256: server_public_key.fingerprint(HashAlg::Sha256).to_string(),
        };
        match check_runtime_ssh_known_host(&key) {
            Ok(RuntimeSshKnownHostStatus::Known) => Ok(true),
            Ok(status) => {
                *self.captured_host_key.lock().await = Some(CapturedHostKey { key, status });
                Ok(false)
            }
            Err(error) => {
                *self.captured_host_key.lock().await = Some(CapturedHostKey {
                    key,
                    status: RuntimeSshKnownHostStatus::Changed {
                        stored_fingerprint: error,
                    },
                });
                Ok(false)
            }
        }
    }
}

enum ResolvedSshAuth {
    Password(String),
    PrivateKey {
        key: String,
        passphrase: Option<String>,
    },
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SshProxyKind {
    Socks5,
    Http,
}

#[derive(Debug, Clone)]
struct ResolvedSshProxy {
    kind: SshProxyKind,
    host: String,
    port: u16,
    username: String,
    password: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SshPathProfile {
    Windows,
    Posix,
}

fn ssh_proxy_configured(host: &RuntimeSshHostConfig) -> bool {
    !host.proxy.url.trim().is_empty()
        || host.proxy.port > 0
        || !host.proxy.username.trim().is_empty()
        || host.proxy.password_configured
}

async fn connect_ssh_handle(
    host_config: &RuntimeSshHostConfig,
    captured_host_key: Arc<tokio::sync::Mutex<Option<CapturedHostKey>>>,
) -> Result<client::Handle<LiveAgentSshClient>, String> {
    let ssh_client = LiveAgentSshClient {
        host: host_config.host.clone(),
        port: host_config.port,
        captured_host_key,
    };
    let config = Arc::new(ssh_client_config());
    let stream = open_ssh_transport(host_config).await?;
    client::connect_stream(config, stream, ssh_client)
        .await
        .map_err(|error| format!("SSH connection failed: {error}"))
}

fn ssh_client_config() -> client::Config {
    client::Config {
        keepalive_interval: Some(SSH_KEEPALIVE_INTERVAL),
        keepalive_max: SSH_KEEPALIVE_MAX_MISSES,
        nodelay: true,
        ..Default::default()
    }
}

async fn open_ssh_transport(host_config: &RuntimeSshHostConfig) -> Result<TcpStream, String> {
    if !ssh_proxy_configured(host_config) {
        let stream = TcpStream::connect((host_config.host.as_str(), host_config.port))
            .await
            .map_err(|error| {
                format!(
                    "SSH TCP connection to {}:{} failed: {error}",
                    host_config.host, host_config.port
                )
            })?;
        configure_ssh_transport_stream(&stream);
        return Ok(stream);
    }

    let proxy = resolve_ssh_proxy(host_config)?;
    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(|error| {
            format!(
                "SSH proxy connection to {}:{} failed: {error}",
                proxy.host, proxy.port
            )
        })?;
    match proxy.kind {
        SshProxyKind::Http => {
            http_connect_proxy(
                &mut stream,
                host_config.host.as_str(),
                host_config.port,
                &proxy,
            )
            .await?;
        }
        SshProxyKind::Socks5 => {
            socks5_connect_proxy(
                &mut stream,
                host_config.host.as_str(),
                host_config.port,
                &proxy,
            )
            .await?;
        }
    }
    configure_ssh_transport_stream(&stream);
    Ok(stream)
}

fn configure_ssh_transport_stream(stream: &TcpStream) {
    let _ = stream.set_nodelay(true);
}

fn resolve_ssh_proxy(host_config: &RuntimeSshHostConfig) -> Result<ResolvedSshProxy, String> {
    let raw_url = host_config.proxy.url.trim();
    if raw_url.is_empty() {
        return Err("SSH proxy host is required".to_string());
    }
    let (scheme, authority) = split_proxy_scheme(raw_url);
    let kind = resolve_proxy_kind(host_config.proxy.proxy_type.as_str(), scheme)?;
    let authority = authority
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(authority)
        .trim();
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (proxy_host, url_port) = split_host_port(authority);
    if proxy_host.trim().is_empty() {
        return Err("SSH proxy host is required".to_string());
    }
    let configured_port = u16::try_from(host_config.proxy.port)
        .ok()
        .filter(|port| *port >= 1);
    let default_port = match kind {
        SshProxyKind::Socks5 => 1080,
        SshProxyKind::Http => 8080,
    };
    Ok(ResolvedSshProxy {
        kind,
        host: proxy_host,
        port: configured_port.or(url_port).unwrap_or(default_port),
        username: host_config.proxy.username.trim().to_string(),
        password: host_config.proxy.password.trim().to_string(),
    })
}

fn split_proxy_scheme(input: &str) -> (Option<&str>, &str) {
    if let Some(index) = input.find("://") {
        let (scheme, rest) = input.split_at(index);
        return (Some(scheme), &rest[3..]);
    }
    (None, input)
}

fn resolve_proxy_kind(raw_type: &str, scheme: Option<&str>) -> Result<SshProxyKind, String> {
    let source = scheme.unwrap_or(raw_type).trim().to_ascii_lowercase();
    match source.as_str() {
        "http" => Ok(SshProxyKind::Http),
        "" | "socks5" | "socks" => Ok(SshProxyKind::Socks5),
        other => Err(format!("SSH proxy type is not supported: {other}")),
    }
}

fn split_host_port(authority: &str) -> (String, Option<u16>) {
    let authority = authority.trim();
    if let Some(rest) = authority.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let host = rest[..end].to_string();
            let port = rest[end + 1..].strip_prefix(':').and_then(parse_u16_port);
            return (host, port);
        }
    }
    if let Some((host, port)) = authority.rsplit_once(':') {
        if !host.contains(':') {
            return (host.to_string(), parse_u16_port(port));
        }
    }
    (authority.to_string(), None)
}

fn parse_u16_port(value: &str) -> Option<u16> {
    value.trim().parse::<u16>().ok().filter(|port| *port >= 1)
}

async fn http_connect_proxy(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    proxy: &ResolvedSshProxy,
) -> Result<(), String> {
    let target = host_port_authority(target_host, target_port);
    let mut request =
        format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: Keep-Alive\r\n");
    if !proxy.username.is_empty() || !proxy.password.is_empty() {
        let token = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", proxy.username, proxy.password));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| format!("SSH HTTP proxy CONNECT request failed: {error}"))?;

    let mut response = Vec::with_capacity(512);
    let mut byte = [0u8; 1];
    while !response.ends_with(b"\r\n\r\n") {
        if response.len() >= 16 * 1024 {
            return Err("SSH HTTP proxy CONNECT response is too large".to_string());
        }
        let n = stream
            .read(&mut byte)
            .await
            .map_err(|error| format!("SSH HTTP proxy CONNECT response failed: {error}"))?;
        if n == 0 {
            return Err("SSH HTTP proxy closed before CONNECT completed".to_string());
        }
        response.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&response);
    let status_line = text.lines().next().unwrap_or_default();
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    if !(200..300).contains(&status_code) {
        return Err(format!(
            "SSH HTTP proxy CONNECT failed: {}",
            status_line.trim()
        ));
    }
    Ok(())
}

async fn socks5_connect_proxy(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    proxy: &ResolvedSshProxy,
) -> Result<(), String> {
    let wants_auth = !proxy.username.is_empty() || !proxy.password.is_empty();
    if wants_auth
        && (proxy.username.len() > u8::MAX as usize || proxy.password.len() > u8::MAX as usize)
    {
        return Err("SSH SOCKS5 proxy username/password is too long".to_string());
    }
    let greeting: &[u8] = if wants_auth {
        &[0x05, 0x02, 0x00, 0x02]
    } else {
        &[0x05, 0x01, 0x00]
    };
    stream
        .write_all(greeting)
        .await
        .map_err(|error| format!("SSH SOCKS5 proxy greeting failed: {error}"))?;
    let mut method = [0u8; 2];
    stream
        .read_exact(&mut method)
        .await
        .map_err(|error| format!("SSH SOCKS5 proxy method response failed: {error}"))?;
    if method[0] != 0x05 {
        return Err("SSH SOCKS5 proxy returned an invalid version".to_string());
    }
    match method[1] {
        0x00 => {}
        0x02 => {
            let mut auth = Vec::with_capacity(3 + proxy.username.len() + proxy.password.len());
            auth.push(0x01);
            auth.push(proxy.username.len() as u8);
            auth.extend_from_slice(proxy.username.as_bytes());
            auth.push(proxy.password.len() as u8);
            auth.extend_from_slice(proxy.password.as_bytes());
            stream
                .write_all(&auth)
                .await
                .map_err(|error| format!("SSH SOCKS5 proxy auth request failed: {error}"))?;
            let mut auth_response = [0u8; 2];
            stream
                .read_exact(&mut auth_response)
                .await
                .map_err(|error| format!("SSH SOCKS5 proxy auth response failed: {error}"))?;
            if auth_response != [0x01, 0x00] {
                return Err("SSH SOCKS5 proxy authentication failed".to_string());
            }
        }
        0xff => return Err("SSH SOCKS5 proxy has no acceptable auth method".to_string()),
        other => {
            return Err(format!(
                "SSH SOCKS5 proxy selected unsupported auth method: {other}"
            ))
        }
    }

    let mut request = Vec::new();
    request.extend_from_slice(&[0x05, 0x01, 0x00]);
    write_socks5_address(&mut request, target_host)?;
    request.extend_from_slice(&target_port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|error| format!("SSH SOCKS5 proxy CONNECT request failed: {error}"))?;

    let mut response = [0u8; 4];
    stream
        .read_exact(&mut response)
        .await
        .map_err(|error| format!("SSH SOCKS5 proxy CONNECT response failed: {error}"))?;
    if response[0] != 0x05 {
        return Err("SSH SOCKS5 proxy returned an invalid CONNECT version".to_string());
    }
    if response[1] != 0x00 {
        return Err(format!(
            "SSH SOCKS5 proxy CONNECT failed: {}",
            socks5_reply_label(response[1])
        ));
    }
    let address_len = match response[3] {
        0x01 => 4,
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .await
                .map_err(|error| format!("SSH SOCKS5 proxy response failed: {error}"))?;
            usize::from(len[0])
        }
        0x04 => 16,
        other => {
            return Err(format!(
                "SSH SOCKS5 proxy returned unsupported address type: {other}"
            ))
        }
    };
    let mut discard = vec![0u8; address_len + 2];
    stream
        .read_exact(&mut discard)
        .await
        .map_err(|error| format!("SSH SOCKS5 proxy response failed: {error}"))?;
    Ok(())
}

fn write_socks5_address(out: &mut Vec<u8>, host: &str) -> Result<(), String> {
    let normalized_host = strip_ipv6_brackets(host.trim());
    if let Ok(ip) = normalized_host.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(ip) => {
                out.push(0x01);
                out.extend_from_slice(&ip.octets());
            }
            IpAddr::V6(ip) => {
                out.push(0x04);
                out.extend_from_slice(&ip.octets());
            }
        }
        return Ok(());
    }
    if normalized_host.is_empty() || normalized_host.len() > u8::MAX as usize {
        return Err("SSH SOCKS5 target host is empty or too long".to_string());
    }
    out.push(0x03);
    out.push(normalized_host.len() as u8);
    out.extend_from_slice(normalized_host.as_bytes());
    Ok(())
}

fn strip_ipv6_brackets(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
}

fn host_port_authority(host: &str, port: u16) -> String {
    let host = host.trim();
    if strip_ipv6_brackets(host).parse::<Ipv6Addr>().is_ok() && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn socks5_reply_label(code: u8) -> &'static str {
    match code {
        0x01 => "general failure",
        0x02 => "connection not allowed",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused",
        0x06 => "TTL expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown error",
    }
}

fn resolve_ssh_auth_material(host: &RuntimeSshHostConfig) -> Result<ResolvedSshAuth, String> {
    if host.auth_type == "agent" {
        Ok(ResolvedSshAuth::Agent)
    } else if host.auth_type == "privateKey" {
        let key = if !host.private_key.trim().is_empty() {
            host.private_key.trim().to_string()
        } else {
            let path = host.private_key_path.trim();
            if path.is_empty() {
                return Err("SSH private key is not configured".to_string());
            }
            let expanded = expand_ssh_private_key_path(path);
            fs::read_to_string(&expanded)
                .map_err(|error| {
                    format!(
                        "failed to read SSH private key {}: {error}",
                        expanded.display()
                    )
                })?
                .trim()
                .to_string()
        };
        if key.is_empty() {
            return Err("SSH private key is empty".to_string());
        }
        let passphrase = host.private_key_passphrase.trim().to_string();
        Ok(ResolvedSshAuth::PrivateKey {
            key,
            passphrase: (!passphrase.is_empty()).then_some(passphrase),
        })
    } else {
        let password = host.password.trim().to_string();
        if password.is_empty() {
            return Err("SSH password is not configured".to_string());
        }
        Ok(ResolvedSshAuth::Password(password))
    }
}

fn expand_ssh_private_key_path(path: &str) -> PathBuf {
    let home = dirs::home_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let profile = if cfg!(windows) {
        SshPathProfile::Windows
    } else {
        SshPathProfile::Posix
    };
    let expanded = expand_ssh_identity_path_for_profile(&home, path, profile);
    PathBuf::from(expanded)
}

fn expand_ssh_identity_path_for_profile(
    home_path: &str,
    path: &str,
    profile: SshPathProfile,
) -> String {
    expand_ssh_identity_path_for_profile_with_env(home_path, path, profile, |key| {
        std::env::var(key).ok()
    })
}

fn expand_ssh_identity_path_for_profile_with_env<F>(
    home_path: &str,
    path: &str,
    profile: SshPathProfile,
    env: F,
) -> String
where
    F: Fn(&str) -> Option<String>,
{
    let trimmed = strip_wrapping_quotes(path);
    if trimmed.is_empty() {
        return String::new();
    }
    match profile {
        SshPathProfile::Windows => expand_windows_ssh_identity_path(home_path, &trimmed, env),
        SshPathProfile::Posix => expand_posix_ssh_identity_path(home_path, &trimmed),
    }
}

fn strip_wrapping_quotes(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.as_bytes()[0] as char;
        let last = trimmed.as_bytes()[trimmed.len() - 1] as char;
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

fn expand_windows_ssh_identity_path<F>(home_path: &str, path: &str, env: F) -> String
where
    F: Fn(&str) -> Option<String>,
{
    if is_windows_absolute_path(path) {
        return path.to_string();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return join_windows_identity_path(home_path, rest);
    }
    if let Some(rest) = path
        .strip_prefix("$HOME/")
        .or_else(|| path.strip_prefix("$HOME\\"))
    {
        return join_windows_identity_path(home_path, rest);
    }
    if let Some(rest) = path
        .strip_prefix("${HOME}/")
        .or_else(|| path.strip_prefix("${HOME}\\"))
    {
        return join_windows_identity_path(home_path, rest);
    }
    if let Some(rest) = strip_prefix_ci(path, "%USERPROFILE%") {
        if rest.starts_with('\\') || rest.starts_with('/') {
            let user_profile = env("USERPROFILE").unwrap_or_else(|| home_path.to_string());
            return join_windows_identity_path(&user_profile, rest);
        }
    }
    if let Some(rest) = strip_prefix_ci(path, "%HOMEDRIVE%%HOMEPATH%") {
        if rest.starts_with('\\') || rest.starts_with('/') {
            let home_drive = env("HOMEDRIVE").unwrap_or_default();
            let home_path_env = env("HOMEPATH").unwrap_or_default();
            let home = if home_drive.is_empty() && home_path_env.is_empty() {
                home_path.to_string()
            } else {
                format!("{home_drive}{home_path_env}")
            };
            return join_windows_identity_path(&home, rest);
        }
    }
    if path.starts_with('\\') || path.starts_with('/') {
        return path.to_string();
    }
    join_windows_identity_path(home_path, path)
}

fn expand_posix_ssh_identity_path(home_path: &str, path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        return join_posix_identity_path(home_path, rest);
    }
    if let Some(rest) = path.strip_prefix("$HOME/") {
        return join_posix_identity_path(home_path, rest);
    }
    if let Some(rest) = path.strip_prefix("${HOME}/") {
        return join_posix_identity_path(home_path, rest);
    }
    if path.starts_with('/') {
        return trim_trailing_posix_slashes(path);
    }
    join_posix_identity_path(home_path, path)
}

fn is_windows_absolute_path(path: &str) -> bool {
    if path.starts_with(r"\\?\") || path.starts_with(r"//?/") {
        return true;
    }
    if path.len() >= 3
        && path.as_bytes()[1] == b':'
        && path.as_bytes()[0].is_ascii_alphabetic()
        && matches!(path.as_bytes()[2], b'\\' | b'/')
    {
        return true;
    }
    path.starts_with(r"\\") || path.starts_with("//")
}

fn strip_prefix_ci<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        .then(|| &value[prefix.len()..])
}

fn join_windows_identity_path(base: &str, child: &str) -> String {
    let separator = if base.contains('\\') { '\\' } else { '/' };
    let base = base.trim_end_matches(['\\', '/']);
    let child = child.trim_start_matches(['\\', '/']);
    if child.is_empty() {
        base.to_string()
    } else if base.is_empty() {
        child.to_string()
    } else {
        format!("{base}{separator}{child}")
    }
}

fn join_posix_identity_path(base: &str, child: &str) -> String {
    let base = base.trim_end_matches('/');
    let child = child.trim_start_matches('/');
    if child.is_empty() {
        base.to_string()
    } else if base.is_empty() {
        child.to_string()
    } else {
        format!("{base}/{child}")
    }
}

fn trim_trailing_posix_slashes(path: &str) -> String {
    let mut next = path.to_string();
    while next.len() > 1 && next.ends_with('/') {
        next.pop();
    }
    next
}

async fn authenticate_ssh_handle(
    handle: &mut client::Handle<LiveAgentSshClient>,
    host: &RuntimeSshHostConfig,
    auth: ResolvedSshAuth,
) -> Result<SshAuthOutcome, String> {
    match auth {
        ResolvedSshAuth::Password(password) => {
            let result = handle
                .authenticate_password(host.username.as_str(), password.clone())
                .await
                .map_err(|error| format!("SSH password authentication failed: {error}"))?;
            if result.success() {
                return Ok(SshAuthOutcome::Authenticated);
            }
            if auth_result_can_continue_with_kbi(&result) {
                let response = handle
                    .authenticate_keyboard_interactive_start(host.username.as_str(), None::<String>)
                    .await
                    .map_err(|error| {
                        format!("SSH keyboard-interactive authentication failed: {error}")
                    })?;
                return continue_keyboard_interactive_auth(handle, response, Some(password)).await;
            }
            Err("SSH authentication failed".to_string())
        }
        ResolvedSshAuth::PrivateKey { key, passphrase } => {
            let key_pair = russh::keys::decode_secret_key(&key, passphrase.as_deref())
                .map_err(|error| format!("Invalid SSH private key: {error}"))?;
            let key = PrivateKeyWithHashAlg::new(Arc::new(key_pair), Some(HashAlg::Sha256));
            let result = handle
                .authenticate_publickey(host.username.as_str(), key)
                .await
                .map_err(|error| format!("SSH private key authentication failed: {error}"))?;
            if result.success() {
                return Ok(SshAuthOutcome::Authenticated);
            }
            if auth_result_can_continue_with_kbi(&result) {
                let response = handle
                    .authenticate_keyboard_interactive_start(host.username.as_str(), None::<String>)
                    .await
                    .map_err(|error| {
                        format!("SSH keyboard-interactive authentication failed: {error}")
                    })?;
                return continue_keyboard_interactive_auth(handle, response, None).await;
            }
            Err("SSH authentication failed".to_string())
        }
        ResolvedSshAuth::Agent => authenticate_ssh_handle_with_agent(handle, host).await,
    }
}

async fn authenticate_ssh_handle_with_agent(
    handle: &mut client::Handle<LiveAgentSshClient>,
    host: &RuntimeSshHostConfig,
) -> Result<SshAuthOutcome, String> {
    let mut agent = connect_ssh_agent().await?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|error| format!("SSH agent identity lookup failed: {error}"))?;
    if identities.is_empty() {
        return Err("SSH agent has no identities".to_string());
    }

    let mut can_continue_with_kbi = false;
    let mut last_error = String::new();
    for identity in identities {
        let result =
            authenticate_ssh_agent_identity(handle, host.username.as_str(), &identity, &mut agent)
                .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        if result.success() {
            return Ok(SshAuthOutcome::Authenticated);
        }
        can_continue_with_kbi |= auth_result_can_continue_with_kbi(&result);
    }

    if can_continue_with_kbi {
        let response = handle
            .authenticate_keyboard_interactive_start(host.username.as_str(), None::<String>)
            .await
            .map_err(|error| format!("SSH keyboard-interactive authentication failed: {error}"))?;
        return continue_keyboard_interactive_auth(handle, response, None).await;
    }

    if last_error.is_empty() {
        Err("SSH agent authentication failed".to_string())
    } else {
        Err(format!("SSH agent authentication failed: {last_error}"))
    }
}

async fn authenticate_ssh_agent_identity(
    handle: &mut client::Handle<LiveAgentSshClient>,
    username: &str,
    identity: &AgentIdentity,
    agent: &mut AgentClient<Box<dyn AgentStream + Send + Unpin>>,
) -> Result<client::AuthResult, String> {
    match identity {
        AgentIdentity::PublicKey { key, .. } => handle
            .authenticate_publickey_with(username, key.clone(), Some(HashAlg::Sha256), agent)
            .await
            .map_err(|error| error.to_string()),
        AgentIdentity::Certificate { certificate, .. } => handle
            .authenticate_certificate_with(
                username,
                certificate.clone(),
                Some(HashAlg::Sha256),
                agent,
            )
            .await
            .map_err(|error| error.to_string()),
    }
}

async fn connect_ssh_agent() -> Result<AgentClient<Box<dyn AgentStream + Send + Unpin>>, String> {
    #[cfg(windows)]
    {
        let mut errors = Vec::new();
        match AgentClient::connect_pageant().await {
            Ok(agent) => return Ok(agent.dynamic()),
            Err(error) => errors.push(format!("Pageant: {error}")),
        }
        if let Ok(sock) = std::env::var("SSH_AUTH_SOCK") {
            let sock = sock.trim();
            if !sock.is_empty() {
                match AgentClient::connect_named_pipe(sock).await {
                    Ok(agent) => return Ok(agent.dynamic()),
                    Err(error) => errors.push(format!("SSH_AUTH_SOCK named pipe: {error}")),
                }
            }
        }
        match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            Ok(agent) => return Ok(agent.dynamic()),
            Err(error) => errors.push(format!("OpenSSH named pipe: {error}")),
        }
        Err(format!(
            "SSH agent is not available ({})",
            errors.join("; ")
        ))
    }

    #[cfg(unix)]
    {
        AgentClient::connect_env()
            .await
            .map(|agent| agent.dynamic())
            .map_err(|error| format!("SSH agent is not available: {error}"))
    }

    #[cfg(not(any(unix, windows)))]
    {
        Err("SSH agent is not supported on this platform".to_string())
    }
}

fn auth_result_can_continue_with_kbi(result: &client::AuthResult) -> bool {
    matches!(
        result,
        client::AuthResult::Failure {
            remaining_methods,
            ..
        } if remaining_methods.contains(&MethodKind::KeyboardInteractive)
    )
}

fn prompt_looks_like_password(prompt: &str) -> bool {
    let normalized = prompt.trim().to_ascii_lowercase();
    normalized.contains("password") || prompt.contains("密码")
}

fn classify_password_kbi_prompts(
    prompts: &[client::Prompt],
    password_prompt_consumed: bool,
) -> PasswordKbiPromptAction {
    if prompts.is_empty() {
        PasswordKbiPromptAction::RespondEmpty
    } else if !password_prompt_consumed
        && prompts.len() == 1
        && !prompts[0].echo
        && prompt_looks_like_password(&prompts[0].prompt)
    {
        PasswordKbiPromptAction::SendPassword
    } else {
        PasswordKbiPromptAction::PromptUser
    }
}

async fn continue_keyboard_interactive_auth(
    handle: &mut client::Handle<LiveAgentSshClient>,
    mut response: client::KeyboardInteractiveAuthResponse,
    auto_password: Option<String>,
) -> Result<SshAuthOutcome, String> {
    let mut password_prompt_consumed = false;
    for _ in 0..5 {
        match response {
            client::KeyboardInteractiveAuthResponse::Success => {
                return Ok(SshAuthOutcome::Authenticated);
            }
            client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err("SSH keyboard-interactive authentication failed".to_string());
            }
            client::KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => match classify_password_kbi_prompts(&prompts, password_prompt_consumed) {
                PasswordKbiPromptAction::RespondEmpty => {
                    response = handle
                        .authenticate_keyboard_interactive_respond(Vec::new())
                        .await
                        .map_err(|error| {
                            format!("SSH keyboard-interactive response failed: {error}")
                        })?;
                }
                PasswordKbiPromptAction::SendPassword if auto_password.is_some() => {
                    password_prompt_consumed = true;
                    response = handle
                        .authenticate_keyboard_interactive_respond(vec![auto_password
                            .clone()
                            .unwrap_or_default()])
                        .await
                        .map_err(|error| {
                            format!("SSH keyboard-interactive response failed: {error}")
                        })?;
                }
                PasswordKbiPromptAction::SendPassword | PasswordKbiPromptAction::PromptUser => {
                    if prompts.len() != 1 {
                        return Err(
                            "SSH keyboard-interactive requested multiple prompts, which is not supported in V1."
                                .to_string(),
                        );
                    }
                    let prompt = prompts
                        .into_iter()
                        .next()
                        .ok_or_else(|| "SSH keyboard-interactive prompt is empty".to_string())?;
                    return Ok(SshAuthOutcome::KeyboardInteractivePrompt(
                        KeyboardInteractivePromptData {
                            name,
                            instructions,
                            prompt: prompt.prompt,
                            echo: prompt.echo,
                        },
                    ));
                }
            },
        }
    }
    Err("SSH keyboard-interactive exceeded maximum prompt rounds".to_string())
}

fn ssh_keyboard_interactive_message(prompt_data: &KeyboardInteractivePromptData) -> String {
    let mut parts = Vec::new();
    if !prompt_data.name.trim().is_empty() {
        parts.push(prompt_data.name.trim().to_string());
    }
    if !prompt_data.instructions.trim().is_empty() {
        parts.push(prompt_data.instructions.trim().to_string());
    }
    if !prompt_data.prompt.trim().is_empty() {
        parts.push(prompt_data.prompt.trim().to_string());
    }
    if parts.is_empty() {
        "SSH keyboard-interactive authentication requires input.".to_string()
    } else {
        parts.join("\n")
    }
}

async fn open_ssh_shell_channel(
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

pub(crate) async fn open_sftp_connection_for_host(
    ssh_host_id: &str,
) -> Result<TerminalSftpConnection, String> {
    let host_config = load_runtime_ssh_host(ssh_host_id)?
        .ok_or_else(|| format!("SSH host not found: {}", ssh_host_id.trim()))?;
    if host_config.host.trim().is_empty() {
        return Err("SSH host is required".to_string());
    }
    if host_config.username.trim().is_empty() {
        return Err("SSH username is required".to_string());
    }

    let auth = resolve_ssh_auth_material(&host_config)?;
    let captured_host_key = Arc::new(tokio::sync::Mutex::new(None::<CapturedHostKey>));
    let mut handle = match connect_ssh_handle(&host_config, Arc::clone(&captured_host_key)).await {
        Ok(handle) => handle,
        Err(error) => {
            if captured_host_key.lock().await.is_some() {
                return Err("SSH host key requires confirmation before opening SFTP".to_string());
            }
            return Err(error);
        }
    };

    match authenticate_ssh_handle(&mut handle, &host_config, auth).await? {
        SshAuthOutcome::Authenticated => {}
        SshAuthOutcome::KeyboardInteractivePrompt(_) => {
            let _ = handle
                .disconnect(
                    russh::Disconnect::ByApplication,
                    "Keyboard-interactive SFTP authentication requires Bash prompt first",
                    "en",
                )
                .await;
            return Err(
                "SSH keyboard-interactive authentication requires opening Bash first".to_string(),
            );
        }
    }

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
    Ok(TerminalSftpConnection {
        _handle: handle,
        session,
    })
}

async fn run_ssh_exec_channel(
    runtime: &Arc<SshSessionRuntime>,
    command: String,
    max_bytes: usize,
) -> Result<TerminalSshExecResponse, String> {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let mut exit_code = None;
    let mut exit_signal = None;

    let channel = {
        let handle = runtime.handle.lock().await;
        let Some(handle) = handle.as_ref() else {
            return Err("SSH connection is not connected".to_string());
        };
        handle
            .channel_open_session()
            .await
            .map_err(|error| format!("SSH exec channel open failed: {error}"))?
    };
    channel
        .exec(true, command.into_bytes())
        .await
        .map_err(|error| format!("SSH exec request failed: {error}"))?;
    let (mut read_half, _write_half) = channel.split();

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

    Ok(TerminalSshExecResponse {
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
    })
}

fn normalize_ssh_exec_timeout(timeout_ms: Option<u64>) -> Duration {
    let requested = timeout_ms
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(SSH_EXEC_DEFAULT_TIMEOUT);
    requested.clamp(Duration::from_secs(1), SSH_EXEC_MAX_TIMEOUT)
}

fn normalize_ssh_exec_max_bytes(max_bytes: Option<usize>) -> usize {
    max_bytes
        .filter(|value| *value > 0)
        .unwrap_or(SSH_EXEC_DEFAULT_MAX_BYTES)
        .clamp(4 * 1024, SSH_EXEC_MAX_BYTES)
}

fn append_limited(buffer: &mut Vec<u8>, data: &[u8], max_bytes: usize, truncated: &mut bool) {
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

fn wrap_ssh_exec_command(command: &str, cwd: Option<&str>) -> String {
    match cwd.map(str::trim).filter(|value| !value.is_empty()) {
        Some(cwd) => format!("cd {} && {}", shell_single_quote(cwd), command),
        None => command.to_string(),
    }
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn run_ssh_session_io(
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
    tauri::async_runtime::spawn(async move {
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

async fn finish_ssh_session_io(
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

async fn ssh_connection_alive(runtime: &Arc<SshSessionRuntime>, connection_id: usize) -> bool {
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

fn spawn_ssh_reconnect_runner(
    registry: Arc<TerminalSessionRegistry>,
    session_id: String,
    runtime: Arc<SshSessionRuntime>,
    connection_id: usize,
) {
    // russh drives each session on the current Tokio runtime, so reconnects must
    // live on Tauri's long-running runtime rather than a short-lived thread runtime.
    tauri::async_runtime::spawn(async move {
        registry
            .handle_ssh_unexpected_disconnect(session_id, runtime, connection_id)
            .await;
    });
}

fn terminal_ssh_create_response_from_snapshot(
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

fn required_project_key(project_path_key: String) -> Result<String, String> {
    let project_key = normalize_project_path_key(&project_path_key);
    if project_key.is_empty() {
        return Err("project_path_key is required".to_string());
    }
    Ok(project_key)
}

fn normalize_ssh_terminal_tab_kind(kind: &str) -> Result<String, String> {
    match kind.trim().to_ascii_lowercase().as_str() {
        "bash" => Ok("bash".to_string()),
        "sftp" => Ok("sftp".to_string()),
        "" => Err("tab kind is required".to_string()),
        other => Err(format!("unsupported ssh terminal tab kind: {other}")),
    }
}

fn ssh_terminal_tab_id(session_id: &str, kind: &str) -> String {
    format!("{}:{}", kind.trim(), session_id.trim())
}

fn ssh_terminal_tabs_snapshot_from_state(
    project_path_key: &str,
    state: &SshTerminalTabsState,
) -> SshTerminalTabsSnapshot {
    SshTerminalTabsSnapshot {
        project_path_key: project_path_key.to_string(),
        tabs: state.tabs.clone(),
        revision: state.revision,
    }
}

pub struct TerminalSubscriberGuard {
    id: usize,
    subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<TerminalEvent>>>>,
}

impl Drop for TerminalSubscriberGuard {
    fn drop(&mut self) {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.remove(&self.id);
        }
    }
}

pub struct TerminalStreamSubscriberGuard {
    id: usize,
    subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<TerminalStreamEvent>>>>,
}

impl Drop for TerminalStreamSubscriberGuard {
    fn drop(&mut self) {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.remove(&self.id);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReadTailResponse {
    pub sessions: Vec<TerminalSessionRecord>,
    pub selected_session: Option<TerminalSessionRecord>,
    pub output: String,
    pub truncated: bool,
}

fn read_output_tail(entry: &TerminalSessionEntry, max_bytes: usize) -> TerminalOutputTail {
    let output = match entry.output.lock() {
        Ok(output) => output,
        Err(_) => {
            return TerminalOutputTail {
                output: Vec::new(),
                truncated: false,
                output_start_offset: 0,
                output_end_offset: 0,
            }
        }
    };
    read_output_chunks_tail(&output, max_bytes)
}

fn read_output_chunks_tail(output: &TerminalOutputBuffer, max_bytes: usize) -> TerminalOutputTail {
    let output_end_offset = output.next_offset;
    if max_bytes == 0 {
        return TerminalOutputTail {
            output: Vec::new(),
            truncated: output_end_offset > 0,
            output_start_offset: output_end_offset,
            output_end_offset,
        };
    }
    let mut remaining = max_bytes;
    let mut chunks = VecDeque::new();
    let mut truncated = false;
    for chunk in output.chunks.iter().rev() {
        if remaining == 0 {
            truncated = true;
            break;
        }
        let len = chunk.data.len();
        if len > remaining {
            let start = len.saturating_sub(remaining);
            chunks.push_front(TerminalOutputChunk {
                start_offset: chunk.start_offset.saturating_add(start as u64),
                data: chunk.data[start..].to_vec(),
            });
            truncated = true;
            break;
        }
        remaining = remaining.saturating_sub(len);
        chunks.push_front(chunk.clone());
    }
    let output_start_offset = chunks
        .front()
        .map(|chunk| chunk.start_offset)
        .unwrap_or(output_end_offset);
    let mut output_bytes = Vec::new();
    for chunk in chunks {
        output_bytes.extend_from_slice(&chunk.data);
    }
    TerminalOutputTail {
        output: output_bytes,
        truncated: truncated || output_start_offset > 0,
        output_start_offset,
        output_end_offset,
    }
}

fn terminate_terminal_entry(entry: &Arc<TerminalSessionEntry>) {
    match &entry.backend {
        TerminalSessionBackend::Local { child, .. } => {
            let pid = entry.record.lock().ok().and_then(|record| record.pid);
            terminate_process_tree_best_effort(pid);
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        }
        TerminalSessionBackend::Ssh { runtime } => {
            if let Some(shutdown_tx) = runtime.close() {
                let _ = shutdown_tx.try_send(());
            }
        }
    }
}

fn terminate_process_tree_best_effort(pid: Option<u32>) {
    let Some(pid) = pid else {
        return;
    };
    if pid == 0 {
        return;
    }

    #[cfg(windows)]
    {
        // `taskkill` is a console app; hide its window so app exit stays clean.
        let mut command = std::process::Command::new("taskkill");
        configure_child_process_group(&mut command);
        let _ = command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }

    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn canonicalize_workdir(workdir: &str) -> Result<PathBuf, String> {
    let raw = workdir.trim();
    if raw.is_empty() {
        return Err("workdir is required".to_string());
    }
    let path = expand_tilde_path(raw);
    if !path.is_absolute() {
        return Err(format!("workdir must be absolute: {workdir}"));
    }
    let metadata = fs::metadata(&path).map_err(|_| format!("workdir does not exist: {workdir}"))?;
    if !metadata.is_dir() {
        return Err(format!("workdir must be a directory: {workdir}"));
    }
    let canonical =
        fs::canonicalize(&path).map_err(|err| format!("failed to canonicalize workdir: {err}"))?;
    Ok(strip_windows_unc_prefix(canonical))
}

fn strip_windows_unc_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

fn is_program_on_path(program: &str) -> bool {
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        if dir.join(program).is_file() {
            return true;
        }
    }
    false
}

fn scrub_terminal_shell_env(cmd: &mut CommandBuilder) {
    for key in ["npm_config_prefix", "NPM_CONFIG_PREFIX"] {
        cmd.env_remove(key);
    }
}

fn configure_terminal_shell_env(cmd: &mut CommandBuilder, shell_command: &str) {
    scrub_terminal_shell_env(cmd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if is_zsh_shell(shell_command) {
        configure_zsh_colored_prompt(cmd);
    }
}

fn configure_zsh_colored_prompt(cmd: &mut CommandBuilder) {
    let colored_prompt = "%F{green}%n%f%F{yellow}@%f%F{blue}%m%f %F{magenta}%1~%f %F{cyan}%#%f ";
    let zdotdir = create_zsh_prompt_overlay(colored_prompt);
    if let Some(dir) = zdotdir {
        cmd.env("ZDOTDIR", dir.to_string_lossy().as_ref());
    }
}

fn create_zsh_prompt_overlay(prompt: &str) -> Option<PathBuf> {
    let base = dirs::cache_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let zdotdir = base.join("liveagent-zsh");
    if fs::create_dir_all(&zdotdir).is_err() {
        return None;
    }

    let home = dirs::home_dir().unwrap_or_default();
    let user_zshrc = home.join(".zshrc");
    let user_zshenv = home.join(".zshenv");

    let zshenv_content = format!(
        "export _LIVEAGENT_REAL_ZDOTDIR=\"$HOME\"\n\
         [[ -f \"{}\" ]] && source \"{}\"\n",
        user_zshenv.display(),
        user_zshenv.display(),
    );
    let zshrc_content = format!(
        "[[ -f \"{}\" ]] && source \"{}\"\n\
         PROMPT='{}'\n\
         unset ZDOTDIR\n",
        user_zshrc.display(),
        user_zshrc.display(),
        prompt,
    );

    if fs::write(zdotdir.join(".zshenv"), zshenv_content).is_err() {
        return None;
    }
    if fs::write(zdotdir.join(".zshrc"), zshrc_content).is_err() {
        return None;
    }
    Some(zdotdir)
}

struct ShellSpec {
    label: String,
    command: String,
    args: Vec<String>,
}

fn resolve_shell(shell: Option<String>) -> Result<ShellSpec, String> {
    let requested = shell
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".to_string());

    if cfg!(windows) {
        let powershell_args = vec![
            "-NoLogo".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
        ];
        match requested.as_str() {
            "pwsh" => Ok(ShellSpec {
                label: "PowerShell 7".to_string(),
                command: "pwsh.exe".to_string(),
                args: powershell_args,
            }),
            "powershell" | "default" => Ok(ShellSpec {
                label: "PowerShell".to_string(),
                command: "powershell.exe".to_string(),
                args: powershell_args,
            }),
            "cmd" => Ok(ShellSpec {
                label: "Cmd".to_string(),
                command: "cmd.exe".to_string(),
                args: Vec::new(),
            }),
            other => Err(format!("unsupported Windows terminal shell: {other}")),
        }
    } else {
        let command = std::env::var("SHELL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && Path::new(value).is_absolute())
            .or_else(resolve_unix_shell_fallback)
            .ok_or_else(|| "failed to resolve login shell".to_string())?;
        let label = Path::new(&command)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("shell")
            .to_string();
        Ok(ShellSpec {
            label,
            args: unix_shell_args(&command),
            command,
        })
    }
}

fn unix_shell_args(command: &str) -> Vec<String> {
    if is_zsh_shell(command) {
        return vec!["-o".to_string(), "NO_PROMPT_SP".to_string()];
    }
    Vec::new()
}

fn is_zsh_shell(command: &str) -> bool {
    Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("zsh"))
        .unwrap_or(false)
}

fn resolve_unix_shell_fallback() -> Option<String> {
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &["/bin/zsh", "/bin/bash", "/bin/sh"]
    } else {
        &["/bin/bash", "/bin/zsh", "/bin/sh"]
    };
    candidates
        .iter()
        .find(|candidate| Path::new(candidate).exists())
        .map(|value| (*value).to_string())
}

pub fn terminal_shell_options() -> TerminalShellOptionsResponse {
    if cfg!(windows) {
        let mut options = vec![
            TerminalShellOption {
                id: "powershell".to_string(),
                label: "PowerShell".to_string(),
                command: "powershell.exe".to_string(),
            },
            TerminalShellOption {
                id: "cmd".to_string(),
                label: "Cmd".to_string(),
                command: "cmd.exe".to_string(),
            },
        ];
        if is_program_on_path("pwsh.exe") {
            options.insert(
                0,
                TerminalShellOption {
                    id: "pwsh".to_string(),
                    label: "PowerShell 7".to_string(),
                    command: "pwsh.exe".to_string(),
                },
            );
        }
        TerminalShellOptionsResponse {
            default_shell: "powershell".to_string(),
            options,
        }
    } else {
        let shell = resolve_shell(None).unwrap_or_else(|_| ShellSpec {
            label: "sh".to_string(),
            command: "/bin/sh".to_string(),
            args: Vec::new(),
        });
        TerminalShellOptionsResponse {
            default_shell: "default".to_string(),
            options: vec![TerminalShellOption {
                id: "default".to_string(),
                label: shell.label,
                command: shell.command,
            }],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_options_include_default() {
        let options = terminal_shell_options();
        assert!(!options.default_shell.trim().is_empty());
        assert!(!options.options.is_empty());
    }

    #[test]
    fn ssh_client_config_enables_interactive_keepalive() {
        let config = ssh_client_config();

        assert_eq!(config.keepalive_interval, Some(SSH_KEEPALIVE_INTERVAL));
        assert_eq!(config.keepalive_max, SSH_KEEPALIVE_MAX_MISSES);
        assert!(config.nodelay);
    }

    #[test]
    fn output_tail_respects_byte_limit_inside_large_chunk() {
        let mut output = TerminalOutputBuffer::default();
        output.append(b"prefix".to_vec());
        output.append(b"abcdefghijklmnopqrstuvwxyz".to_vec());

        let tail = read_output_chunks_tail(&output, 8);

        assert_eq!(tail.output, b"stuvwxyz");
        assert_eq!(tail.output_start_offset, 24);
        assert_eq!(tail.output_end_offset, 32);
        assert!(tail.truncated);
    }

    #[test]
    fn output_tail_keeps_offsets_for_repeated_text() {
        let mut output = TerminalOutputBuffer::default();
        output.append(b"uploads\n".to_vec());
        output.append(b"uploads\n".to_vec());

        let tail = read_output_chunks_tail(&output, MAX_TAIL_BYTES);

        assert_eq!(tail.output, b"uploads\nuploads\n");
        assert_eq!(tail.output_start_offset, 0);
        assert_eq!(tail.output_end_offset, 16);
        assert!(!tail.truncated);
    }

    #[test]
    fn remote_input_echo_is_delayed_for_local_until_enter() {
        let mut state = TerminalEchoDispatchState::default();
        state
            .pending
            .extend(b"echo hi\r".iter().copied().map(|byte| PendingEchoByte {
                byte,
                origin: TerminalInputOrigin::Remote,
            }));

        let first = state.dispatch(test_stream_payload(0, b"echo"));
        assert_eq!(collect_payload_bytes(&first.remote), b"echo");
        assert!(first.local.is_empty());

        let second = state.dispatch(test_stream_payload(4, b" hi\r\n"));
        assert_eq!(collect_payload_bytes(&second.remote), b" hi\r\n");
        assert_eq!(collect_payload_bytes(&second.local), b"echo hi\r\n");
        assert!(state.is_empty());
    }

    #[test]
    fn local_input_echo_is_delayed_for_remote_until_enter() {
        let mut state = TerminalEchoDispatchState::default();
        state
            .pending
            .extend(b"pwd\r".iter().copied().map(|byte| PendingEchoByte {
                byte,
                origin: TerminalInputOrigin::Local,
            }));

        let first = state.dispatch(test_stream_payload(10, b"pw"));
        assert_eq!(collect_payload_bytes(&first.local), b"pw");
        assert!(first.remote.is_empty());

        let second = state.dispatch(test_stream_payload(12, b"d\r\n"));
        assert_eq!(collect_payload_bytes(&second.local), b"d\r\n");
        assert_eq!(collect_payload_bytes(&second.remote), b"pwd\r\n");
        assert!(state.is_empty());
    }

    #[test]
    fn no_echo_password_input_does_not_leak_to_other_side() {
        let mut state = TerminalEchoDispatchState::default();
        state
            .pending
            .extend(b"secret\r".iter().copied().map(|byte| PendingEchoByte {
                byte,
                origin: TerminalInputOrigin::Remote,
            }));

        let dispatch = state.dispatch(test_stream_payload(30, b"\r\n"));

        assert_eq!(collect_payload_bytes(&dispatch.local), b"\r\n");
        assert_eq!(collect_payload_bytes(&dispatch.remote), b"\r\n");
        assert!(state.is_empty());
    }

    #[test]
    fn non_echo_output_stays_visible_to_both_sides() {
        let mut state = TerminalEchoDispatchState::default();
        state.pending.push_back(PendingEchoByte {
            byte: b'a',
            origin: TerminalInputOrigin::Remote,
        });

        let dispatch = state.dispatch(test_stream_payload(50, b"build\n"));

        assert_eq!(collect_payload_bytes(&dispatch.local), b"build\n");
        assert_eq!(collect_payload_bytes(&dispatch.remote), b"build\n");
        assert!(!state.is_empty());
    }

    #[test]
    fn input_echo_candidates_skip_escape_sequences() {
        let candidates =
            terminal_input_echo_candidates(b"a\x1b[A\x1b[1;5Cb\r", TerminalInputOrigin::Remote);
        let bytes = candidates
            .iter()
            .map(|candidate| candidate.byte)
            .collect::<Vec<_>>();

        assert_eq!(bytes, b"ab\r");
    }

    #[test]
    fn failed_input_enqueue_does_not_record_pending_echo() {
        let registry = TerminalSessionRegistry::default();
        insert_test_ssh_session(
            &registry,
            "ssh-1",
            "/tmp/project",
            true,
            SSH_STATUS_CONNECTED,
        );

        let result = registry.input_bytes_from_remote("ssh-1".to_string(), b"secret\r".to_vec());

        assert!(result.is_err());
        let states = registry
            .echo_dispatch
            .lock()
            .expect("terminal echo dispatch lock");
        assert!(!states.contains_key("ssh-1"));
    }

    fn insert_test_ssh_session(
        registry: &TerminalSessionRegistry,
        id: &str,
        project_path_key: &str,
        sftp_enabled: bool,
        status: &str,
    ) {
        let now = now_ms();
        let record = TerminalSessionRecord {
            id: id.to_string(),
            project_path_key: normalize_project_path_key(project_path_key),
            cwd: project_path_key.to_string(),
            shell: "ssh".to_string(),
            title: id.to_string(),
            kind: "ssh".to_string(),
            ssh: Some(TerminalSshMetadata {
                host_id: format!("host-{id}"),
                host_name: format!("Host {id}"),
                username: "tester".to_string(),
                host: "127.0.0.1".to_string(),
                port: 22,
                auth_type: "password".to_string(),
                status: status.to_string(),
                reconnect_attempt: 0,
                reconnect_max_attempts: SSH_RECONNECT_MAX_ATTEMPTS,
                sftp_enabled,
            }),
            pid: None,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            created_at: now,
            updated_at: now,
            finished_at: None,
            exit_code: None,
            running: status == SSH_STATUS_CONNECTED,
        };
        let entry = Arc::new(TerminalSessionEntry {
            backend: TerminalSessionBackend::Ssh {
                runtime: Arc::new(SshSessionRuntime::new()),
            },
            record: Mutex::new(record),
            output: Mutex::new(TerminalOutputBuffer::default()),
        });
        registry
            .sessions
            .lock()
            .expect("terminal session registry poisoned")
            .insert(id.to_string(), entry);
    }

    fn test_stream_payload(start_offset: u64, bytes: &[u8]) -> TerminalStreamEventPayload {
        TerminalStreamEventPayload {
            kind: "output".to_string(),
            session_id: "terminal-1".to_string(),
            project_path_key: "/tmp/project".to_string(),
            start_offset,
            end_offset: start_offset + bytes.len() as u64,
            bytes: bytes.to_vec(),
        }
    }

    fn collect_payload_bytes(payloads: &[TerminalStreamEventPayload]) -> Vec<u8> {
        payloads
            .iter()
            .flat_map(|payload| payload.bytes.iter().copied())
            .collect()
    }

    #[test]
    fn ssh_terminal_tab_open_is_idempotent_without_shared_active() {
        let registry = TerminalSessionRegistry::default();
        insert_test_ssh_session(
            &registry,
            "ssh-1",
            "/tmp/project",
            true,
            SSH_STATUS_CONNECTED,
        );

        let first = registry
            .ssh_terminal_tab_open("ssh-1".to_string(), "bash".to_string())
            .expect("open bash tab");
        let second = registry
            .ssh_terminal_tab_open("ssh-1".to_string(), "bash".to_string())
            .expect("reopen bash tab");
        let sftp = registry
            .ssh_terminal_tab_open("ssh-1".to_string(), "sftp".to_string())
            .expect("open sftp tab");

        assert_eq!(first.tabs.len(), 1);
        assert_eq!(second.tabs.len(), 1);
        assert_eq!(sftp.tabs.len(), 2);
        assert_eq!(first.revision, second.revision);
    }

    #[test]
    fn ssh_terminal_tab_close_is_global_without_closing_session() {
        let registry = TerminalSessionRegistry::default();
        insert_test_ssh_session(
            &registry,
            "ssh-1",
            "/tmp/project",
            true,
            SSH_STATUS_CONNECTED,
        );
        insert_test_ssh_session(
            &registry,
            "ssh-2",
            "/tmp/project",
            true,
            SSH_STATUS_CONNECTED,
        );
        registry
            .ssh_terminal_tab_open("ssh-1".to_string(), "bash".to_string())
            .expect("open first tab");
        registry
            .ssh_terminal_tab_open("ssh-2".to_string(), "bash".to_string())
            .expect("open second tab");

        let snapshot = registry
            .ssh_terminal_tab_close("bash:ssh-1".to_string())
            .expect("close first tab");

        assert_eq!(snapshot.tabs.len(), 1);
        assert!(registry.session_record("ssh-1".to_string()).is_ok());
    }

    #[test]
    fn ssh_terminal_tab_open_rejects_disabled_sftp() {
        let registry = TerminalSessionRegistry::default();
        insert_test_ssh_session(
            &registry,
            "ssh-1",
            "/tmp/project",
            false,
            SSH_STATUS_CONNECTED,
        );

        let error = registry
            .ssh_terminal_tab_open("ssh-1".to_string(), "sftp".to_string())
            .expect_err("sftp tab should be rejected");

        assert!(error.contains("SFTP is not enabled"));
    }

    #[test]
    fn ssh_terminal_tabs_prune_when_session_closes() {
        let registry = TerminalSessionRegistry::default();
        insert_test_ssh_session(
            &registry,
            "ssh-1",
            "/tmp/project",
            true,
            SSH_STATUS_CONNECTED,
        );
        registry
            .ssh_terminal_tab_open("ssh-1".to_string(), "bash".to_string())
            .expect("open bash tab");
        registry
            .ssh_terminal_tab_open("ssh-1".to_string(), "sftp".to_string())
            .expect("open sftp tab");

        registry
            .close("ssh-1".to_string())
            .expect("close ssh session");
        let snapshot = registry
            .ssh_terminal_tabs_list("/tmp/project".to_string())
            .expect("list tabs");

        assert!(snapshot.tabs.is_empty());
    }

    #[test]
    fn ssh_terminal_tabs_prune_when_ssh_disconnects() {
        let registry = TerminalSessionRegistry::default();
        insert_test_ssh_session(
            &registry,
            "ssh-1",
            "/tmp/project",
            true,
            SSH_STATUS_CONNECTED,
        );
        registry
            .ssh_terminal_tab_open("ssh-1".to_string(), "bash".to_string())
            .expect("open bash tab");
        registry
            .ssh_terminal_tab_open("ssh-1".to_string(), "sftp".to_string())
            .expect("open sftp tab");
        let entry = registry
            .sessions
            .lock()
            .expect("terminal session registry poisoned")
            .get("ssh-1")
            .cloned()
            .expect("ssh session entry");

        registry.mark_ssh_disconnected(&entry);

        let snapshot = registry
            .ssh_terminal_tabs_list("/tmp/project".to_string())
            .expect("list tabs");
        assert!(snapshot.tabs.is_empty());
        let error = registry
            .ssh_terminal_tab_open("ssh-1".to_string(), "bash".to_string())
            .expect_err("disconnected ssh tab should be rejected");
        assert!(error.contains("disconnected"));
    }

    #[test]
    fn ssh_auth_result_detects_keyboard_interactive_continuation() {
        let mut methods = russh::MethodSet::empty();
        methods.push(MethodKind::KeyboardInteractive);
        assert!(auth_result_can_continue_with_kbi(
            &client::AuthResult::Failure {
                remaining_methods: methods,
                partial_success: false,
            }
        ));

        let mut password_only = russh::MethodSet::empty();
        password_only.push(MethodKind::Password);
        assert!(!auth_result_can_continue_with_kbi(
            &client::AuthResult::Failure {
                remaining_methods: password_only,
                partial_success: false,
            },
        ));
        assert!(!auth_result_can_continue_with_kbi(
            &client::AuthResult::Success
        ));
    }

    #[test]
    fn ssh_password_kbi_prompt_classification_uses_saved_password_once() {
        let prompts = vec![client::Prompt {
            prompt: "Password:".to_string(),
            echo: false,
        }];
        assert_eq!(
            classify_password_kbi_prompts(&prompts, false),
            PasswordKbiPromptAction::SendPassword
        );
        assert_eq!(
            classify_password_kbi_prompts(&prompts, true),
            PasswordKbiPromptAction::PromptUser
        );
        assert_eq!(
            classify_password_kbi_prompts(&[], false),
            PasswordKbiPromptAction::RespondEmpty
        );
        assert_eq!(
            classify_password_kbi_prompts(
                &[client::Prompt {
                    prompt: "OTP:".to_string(),
                    echo: false,
                }],
                false,
            ),
            PasswordKbiPromptAction::PromptUser
        );
    }

    #[test]
    fn ssh_keyboard_interactive_message_combines_server_fields() {
        let message = ssh_keyboard_interactive_message(&KeyboardInteractivePromptData {
            name: "Verification".to_string(),
            instructions: "Enter code".to_string(),
            prompt: "OTP:".to_string(),
            echo: false,
        });

        assert_eq!(message, "Verification\nEnter code\nOTP:");
    }

    #[test]
    fn ssh_identity_path_expands_windows_profile_without_posix_rewrites() {
        let env = |key: &str| match key {
            "USERPROFILE" => Some(r"C:\Users\Alice".to_string()),
            "HOMEDRIVE" => Some("C:".to_string()),
            "HOMEPATH" => Some(r"\Users\Alice".to_string()),
            _ => None,
        };

        assert_eq!(
            expand_ssh_identity_path_for_profile_with_env(
                r"C:\Users\Alice",
                r"~\.ssh\id_ed25519",
                SshPathProfile::Windows,
                env,
            ),
            r"C:\Users\Alice\.ssh\id_ed25519"
        );
        assert_eq!(
            expand_ssh_identity_path_for_profile_with_env(
                r"C:\Users\Alice",
                r"%USERPROFILE%\.ssh\id_rsa",
                SshPathProfile::Windows,
                env,
            ),
            r"C:\Users\Alice\.ssh\id_rsa"
        );
        assert_eq!(
            expand_ssh_identity_path_for_profile_with_env(
                r"C:\Users\Alice",
                r"%HOMEDRIVE%%HOMEPATH%\.ssh\id_rsa",
                SshPathProfile::Windows,
                env,
            ),
            r"C:\Users\Alice\.ssh\id_rsa"
        );
        assert_eq!(
            expand_ssh_identity_path_for_profile_with_env(
                r"C:\Users\Alice",
                r"C:Keys\id_rsa",
                SshPathProfile::Windows,
                env,
            ),
            r"C:\Users\Alice\C:Keys\id_rsa"
        );
        assert_eq!(
            expand_ssh_identity_path_for_profile_with_env(
                r"C:\Users\Alice",
                r"\\?\C:\Keys\id_rsa",
                SshPathProfile::Windows,
                env,
            ),
            r"\\?\C:\Keys\id_rsa"
        );
    }

    #[test]
    fn ssh_identity_path_preserves_posix_backslash_semantics() {
        assert_eq!(
            expand_ssh_identity_path_for_profile(
                "/Users/alice",
                "~/keys/id_ed25519",
                SshPathProfile::Posix
            ),
            "/Users/alice/keys/id_ed25519"
        );
        assert_eq!(
            expand_ssh_identity_path_for_profile(
                "/Users/alice",
                "$HOME/.ssh/id_rsa",
                SshPathProfile::Posix
            ),
            "/Users/alice/.ssh/id_rsa"
        );
        assert_eq!(
            expand_ssh_identity_path_for_profile(
                "/Users/alice",
                "${HOME}/.ssh/id_rsa",
                SshPathProfile::Posix
            ),
            "/Users/alice/.ssh/id_rsa"
        );
        assert_eq!(
            expand_ssh_identity_path_for_profile("/Users/alice", r"dir\key", SshPathProfile::Posix),
            r"/Users/alice/dir\key"
        );
    }

    #[test]
    fn ssh_proxy_parser_resolves_http_and_socks5_endpoints() {
        let mut host = RuntimeSshHostConfig {
            id: "prod".to_string(),
            name: "Production".to_string(),
            host: "prod.example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth_type: "agent".to_string(),
            password: String::new(),
            private_key: String::new(),
            private_key_path: String::new(),
            private_key_passphrase: String::new(),
            proxy: crate::commands::settings::RuntimeSshProxyConfig {
                proxy_type: "socks5".to_string(),
                url: "socks5://127.0.0.1:1081".to_string(),
                port: 0,
                username: "proxy-user".to_string(),
                password: "proxy-pass".to_string(),
                password_configured: true,
            },
        };

        let proxy = resolve_ssh_proxy(&host).expect("resolve socks proxy");
        assert_eq!(proxy.kind, SshProxyKind::Socks5);
        assert_eq!(proxy.host, "127.0.0.1");
        assert_eq!(proxy.port, 1081);
        assert_eq!(proxy.username, "proxy-user");
        assert_eq!(proxy.password, "proxy-pass");

        host.proxy.url = "http://proxy.local".to_string();
        host.proxy.port = 8080;
        let proxy = resolve_ssh_proxy(&host).expect("resolve http proxy");
        assert_eq!(proxy.kind, SshProxyKind::Http);
        assert_eq!(proxy.host, "proxy.local");
        assert_eq!(proxy.port, 8080);
    }

    #[test]
    fn socks5_address_writer_encodes_domain_and_ip_targets() {
        let mut domain = Vec::new();
        write_socks5_address(&mut domain, "prod.example.com").expect("domain target");
        assert_eq!(
            domain,
            [&[0x03, 16][..], b"prod.example.com".as_slice(),].concat()
        );

        let mut ipv4 = Vec::new();
        write_socks5_address(&mut ipv4, "127.0.0.1").expect("ipv4 target");
        assert_eq!(ipv4, vec![0x01, 127, 0, 0, 1]);

        assert_eq!(host_port_authority("::1", 22), "[::1]:22");
    }

    #[test]
    fn terminal_shell_env_scrubs_npm_prefix() {
        let mut command = CommandBuilder::new("/bin/sh");
        command.env("npm_config_prefix", "/tmp/npm-prefix");
        command.env("NPM_CONFIG_PREFIX", "/tmp/npm-prefix");
        command.env("TERM", "dumb");

        configure_terminal_shell_env(&mut command, "/bin/sh");

        assert!(command.get_env("npm_config_prefix").is_none());
        assert!(command.get_env("NPM_CONFIG_PREFIX").is_none());
        assert_eq!(
            command.get_env("TERM").and_then(|value| value.to_str()),
            Some("xterm-256color")
        );
        assert_eq!(
            command
                .get_env("COLORTERM")
                .and_then(|value| value.to_str()),
            Some("truecolor")
        );
        assert!(command.get_env("PROMPT_EOL_MARK").is_none());
    }

    #[test]
    fn zsh_terminal_shell_disables_prompt_sp() {
        assert_eq!(
            unix_shell_args("/bin/zsh"),
            vec!["-o".to_string(), "NO_PROMPT_SP".to_string()]
        );
        assert!(unix_shell_args("/bin/bash").is_empty());
    }

    #[test]
    fn registry_creates_lists_renames_and_closes_session() {
        let registry = Arc::new(TerminalSessionRegistry::default());
        let tempdir = tempfile::tempdir().expect("tempdir");
        let cwd = tempdir.path().display().to_string();

        let created = registry
            .create(
                cwd.clone(),
                Some(cwd.clone()),
                None,
                Some("Test Terminal".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create terminal session");
        assert!(created.session.running);
        assert_eq!(created.session.title, "Test Terminal");

        let listed = registry.list(Some(cwd.clone())).sessions;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.session.id);

        let resized = registry
            .resize(created.session.id.clone(), 100, 30)
            .expect("resize terminal session");
        assert_eq!(resized.cols, 100);
        assert_eq!(resized.rows, 30);

        let renamed = registry
            .rename(created.session.id.clone(), "Renamed Terminal".to_string())
            .expect("rename terminal session");
        assert_eq!(renamed.title, "Renamed Terminal");

        let closed = registry
            .close(created.session.id.clone())
            .expect("close terminal session");
        assert!(!closed.running);
        assert!(registry.list(Some(cwd)).sessions.is_empty());
    }

    #[test]
    fn registry_closes_project_sessions() {
        let registry = Arc::new(TerminalSessionRegistry::default());
        let project_a = tempfile::tempdir().expect("project a");
        let project_b = tempfile::tempdir().expect("project b");
        let cwd_a = project_a.path().display().to_string();
        let cwd_b = project_b.path().display().to_string();

        registry
            .create(
                cwd_a.clone(),
                Some(cwd_a.clone()),
                None,
                Some("A".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create project a terminal");
        registry
            .create(
                cwd_b.clone(),
                Some(cwd_b.clone()),
                None,
                Some("B".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create project b terminal");
        assert_eq!(registry.running_session_count(), 2);

        let closed = registry
            .close_project(cwd_a.clone())
            .expect("close project a terminals");
        assert_eq!(closed.sessions.len(), 1);
        assert!(registry.list(Some(cwd_a)).sessions.is_empty());
        assert_eq!(registry.list(Some(cwd_b)).sessions.len(), 1);

        registry.close_all().expect("close remaining terminals");
        assert_eq!(registry.running_session_count(), 0);
    }

    #[test]
    fn read_tail_requires_terminal_id_when_project_has_multiple_sessions() {
        let registry = Arc::new(TerminalSessionRegistry::default());
        let tempdir = tempfile::tempdir().expect("tempdir");
        let cwd = tempdir.path().display().to_string();

        let first = registry
            .create(
                cwd.clone(),
                Some(cwd.clone()),
                None,
                Some("First".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create first terminal session");
        registry
            .create(
                cwd.clone(),
                Some(cwd.clone()),
                None,
                Some("Second".to_string()),
                Some(80),
                Some(24),
            )
            .expect("create second terminal session");

        let ambiguous = registry
            .read_tail(cwd.clone(), None, Some(1024))
            .expect("read ambiguous terminal tail");
        assert_eq!(ambiguous.sessions.len(), 2);
        assert!(ambiguous.selected_session.is_none());
        assert!(ambiguous.output.is_empty());

        let selected = registry
            .read_tail(cwd, Some(first.session.id), Some(1024))
            .expect("read selected terminal tail");
        assert!(selected.selected_session.is_some());
        assert_eq!(selected.sessions.len(), 2);

        registry.close_all().expect("close terminal sessions");
    }
}
