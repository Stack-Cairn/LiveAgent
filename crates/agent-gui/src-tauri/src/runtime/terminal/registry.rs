use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use tauri::AppHandle;

use crate::runtime::project_path::{
    project_path_key as normalize_project_path_key, project_path_keys_equal,
};

use super::*;

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
        // The project key must come from the caller; deriving it from `cwd` would let
        // any path mint its own "project" and defeat the containment check below.
        let project_key = project_path_key
            .map(|value| normalize_project_path_key(&value))
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "project_path_key is required".to_string())?;
        let cwd = canonicalize_workdir_within(&cwd, &project_key)?;

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

    pub fn input_bytes(&self, session_id: String, data: Vec<u8>) -> Result<(), String> {
        self.input_bytes_with_origin(session_id, data, TerminalInputOrigin::Local)
    }

    pub fn input_bytes_from_remote(&self, session_id: String, data: Vec<u8>) -> Result<(), String> {
        self.input_bytes_with_origin(session_id, data, TerminalInputOrigin::Remote)
    }

    pub(crate) fn input_bytes_with_origin(
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
        // Normalize once so cleanup of session-scoped resources (forwards, tabs)
        // cannot miss entries when callers pass padded IDs.
        let session_id = session_id.trim().to_string();
        let entry = self.entry(&session_id)?;
        terminate_terminal_entry(&entry);
        self.stop_ssh_local_forwards_for_session(&session_id, true);
        let (session, tab_snapshots) = {
            let _tabs_tx = self.lock_ssh_terminal_tabs_tx()?;
            self.mark_finished(&session_id);
            self.sessions
                .lock()
                .expect("terminal session registry poisoned")
                .remove(session_id.as_str());
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

    pub(crate) fn close_ids(&self, ids: Vec<String>) -> Result<TerminalListResponse, String> {
        let mut sessions = Vec::new();
        for id in ids {
            sessions.push(self.close(id)?);
        }
        Ok(TerminalListResponse { sessions })
    }

    pub(crate) fn next_terminal_title(&self, project_path_key: &str) -> String {
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

    pub(crate) fn next_ssh_title(&self, project_path_key: &str, host_name: &str) -> String {
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

    pub(crate) fn entry(&self, session_id: &str) -> Result<Arc<TerminalSessionEntry>, String> {
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

    pub(crate) fn record(&self, session_id: String) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        entry
            .record
            .lock()
            .map(|record| record.clone())
            .map_err(|_| "terminal session lock poisoned".to_string())
    }

    pub(crate) fn touch(&self, entry: &Arc<TerminalSessionEntry>) {
        if let Ok(mut record) = entry.record.lock() {
            record.updated_at = now_ms();
        }
    }

    pub(crate) fn append_output(&self, session_id: &str, data: impl Into<Vec<u8>>) {
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

    pub(crate) fn record_input_echo_candidates(
        &self,
        session_id: &str,
        echo_bytes: Vec<PendingEchoByte>,
    ) {
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

    pub(crate) fn mark_finished(&self, session_id: &str) {
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
