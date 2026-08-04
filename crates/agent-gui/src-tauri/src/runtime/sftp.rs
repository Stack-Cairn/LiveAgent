use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use uuid::Uuid;

use agent_core::events::EventBus;

use crate::runtime::platform::expand_tilde_path;
use crate::runtime::project_path::{
    project_path_key as normalize_project_path_key, project_path_keys_equal,
};
use crate::runtime::terminal::{
    TerminalSessionRegistry, TerminalSftpConnection, TerminalSshSessionInfo,
};

const TRANSFER_BUFFER_BYTES: usize = 64 * 1024;
const SFTP_READ_TEXT_DEFAULT_BYTES: usize = 200 * 1024;
const SFTP_READ_TEXT_MAX_BYTES: usize = 1024 * 1024;
pub const SFTP_EVENT_NAME: &str = "sftp:event";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size_bytes: u64,
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListResponse {
    pub path: String,
    pub entries: Vec<SftpEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpStatResponse {
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<SftpEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferState {
    pub id: String,
    pub session_id: String,
    pub direction: String,
    pub status: String,
    pub source_path: String,
    pub target_path: String,
    pub current_path: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: u32,
    pub files_total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferResponse {
    pub transfer: SftpTransferState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpReadTextResponse {
    pub path: String,
    pub content: String,
    pub offset: u64,
    pub bytes_read: usize,
    pub size_bytes: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEventPayload {
    pub kind: String,
    pub transfer: SftpTransferState,
}

#[derive(Debug, Clone)]
pub struct SftpEvent {
    pub payload: SftpEventPayload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpActionResponse {
    pub action: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<SftpEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer: Option<SftpTransferState>,
}

struct SftpCachedConnection {
    // Terminal SSH connection id the SFTP channel was opened on; a reconnect
    // bumps the id and makes this cached channel dead.
    connection_id: usize,
    connection: Arc<tokio::sync::Mutex<TerminalSftpConnection>>,
}

pub struct SftpSessionRegistry {
    terminal_registry: Arc<TerminalSessionRegistry>,
    sessions: Mutex<HashMap<String, SftpCachedConnection>>,
    transfers: Mutex<HashMap<String, Arc<SftpTransferTask>>>,
    transfer_states: Mutex<HashMap<String, SftpTransferState>>,
    events: Mutex<Option<Arc<EventBus>>>,
    subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<SftpEvent>>>>,
    next_subscriber_id: AtomicUsize,
}

struct SftpTransferTask {
    cancelled: AtomicBool,
}

#[derive(Clone)]
struct LocalDirPlan {
    rel: String,
}

#[derive(Clone)]
struct LocalFilePlan {
    abs: PathBuf,
    rel: String,
    size: u64,
}

#[derive(Clone)]
struct RemoteDirPlan {
    rel: String,
}

#[derive(Clone)]
struct RemoteFilePlan {
    path: String,
    rel: String,
    size: u64,
}

impl SftpSessionRegistry {
    pub fn new(terminal_registry: Arc<TerminalSessionRegistry>) -> Self {
        Self {
            terminal_registry,
            sessions: Mutex::new(HashMap::new()),
            transfers: Mutex::new(HashMap::new()),
            transfer_states: Mutex::new(HashMap::new()),
            events: Mutex::new(None),
            subscribers: Arc::new(Mutex::new(HashMap::new())),
            next_subscriber_id: AtomicUsize::new(0),
        }
    }

    pub fn set_event_bus(&self, events: Arc<EventBus>) {
        if let Ok(mut slot) = self.events.lock() {
            *slot = Some(events);
        }
    }

    pub fn subscribe(&self) -> (mpsc::Receiver<SftpEvent>, SftpSubscriberGuard) {
        let (tx, rx) = mpsc::channel();
        let id = self.next_subscriber_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.insert(id, tx);
        }
        (
            rx,
            SftpSubscriberGuard {
                id,
                subscribers: Arc::clone(&self.subscribers),
            },
        )
    }

    pub fn close_session(&self, session_id: &str) {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return;
        }
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
        if let Ok(mut transfers) = self.transfers.lock() {
            let prefix = format!("{session_id}:");
            for task in transfers
                .iter()
                .filter_map(|(id, task)| id.starts_with(&prefix).then_some(Arc::clone(task)))
            {
                task.cancelled.store(true, Ordering::SeqCst);
            }
            transfers.retain(|id, _| !id.starts_with(&prefix));
        }
        if let Ok(mut transfer_states) = self.transfer_states.lock() {
            let prefix = format!("{session_id}:");
            transfer_states.retain(|id, _| !id.starts_with(&prefix));
        }
    }

    pub async fn list(
        &self,
        session_id: String,
        project_path_key: Option<String>,
        workdir: String,
        side: String,
        path: Option<String>,
    ) -> Result<SftpListResponse, String> {
        match normalize_side(&side)?.as_str() {
            "local" => {
                let workdir =
                    self.workdir_for_session(&session_id, project_path_key.as_deref(), &workdir)?;
                self.list_local(workdir, path)
            }
            "remote" => {
                self.ensure_session_allowed(&session_id, project_path_key.as_deref())?;
                self.list_remote(session_id, path).await
            }
            _ => Err("side must be local or remote".to_string()),
        }
    }

    pub async fn stat(
        &self,
        session_id: String,
        project_path_key: Option<String>,
        workdir: String,
        side: String,
        path: Option<String>,
    ) -> Result<SftpStatResponse, String> {
        match normalize_side(&side)?.as_str() {
            "local" => {
                let workdir =
                    self.workdir_for_session(&session_id, project_path_key.as_deref(), &workdir)?;
                self.stat_local(workdir, path)
            }
            "remote" => {
                self.ensure_session_allowed(&session_id, project_path_key.as_deref())?;
                self.stat_remote(session_id, path).await
            }
            _ => Err("side must be local or remote".to_string()),
        }
    }

    pub async fn read_text(
        &self,
        session_id: String,
        project_path_key: Option<String>,
        path: String,
        offset: Option<u64>,
        max_bytes: Option<usize>,
    ) -> Result<SftpReadTextResponse, String> {
        self.ensure_session_allowed(&session_id, project_path_key.as_deref())?;
        let remote_path = normalize_remote_path(&path);
        self.read_text_remote(session_id, remote_path, offset.unwrap_or(0), max_bytes)
            .await
    }

    pub async fn write_text(
        &self,
        session_id: String,
        project_path_key: Option<String>,
        path: String,
        content: String,
        overwrite: bool,
        create_parent_dirs: bool,
    ) -> Result<SftpActionResponse, String> {
        self.ensure_session_allowed(&session_id, project_path_key.as_deref())?;
        let remote_path = normalize_remote_path(&path);
        let connection = self.connection_for_session(&session_id).await?;
        let guard = connection.lock().await;
        if !overwrite
            && guard
                .session
                .try_exists(remote_path.clone())
                .await
                .unwrap_or(false)
        {
            return Err(format!("target already exists: {remote_path}"));
        }
        if create_parent_dirs {
            if let Some(parent) = remote_parent_path(&remote_path) {
                ensure_remote_dir_all(&guard.session, &parent).await?;
            }
        }
        let mut file = guard
            .session
            .create(remote_path.clone())
            .await
            .map_err(|error| format!("failed to create remote file: {error}"))?;
        file.write_all(content.as_bytes())
            .await
            .map_err(|error| format!("failed to write remote file: {error}"))?;
        file.shutdown()
            .await
            .map_err(|error| format!("failed to close remote file: {error}"))?;
        let entry = remote_entry_from_metadata(&guard.session, &remote_path).await?;
        Ok(SftpActionResponse {
            action: "write_text".to_string(),
            path: remote_path,
            entry: Some(entry),
            transfer: None,
        })
    }

    pub async fn mkdir(
        &self,
        session_id: String,
        project_path_key: Option<String>,
        workdir: String,
        side: String,
        path: String,
    ) -> Result<SftpActionResponse, String> {
        match normalize_side(&side)?.as_str() {
            "local" => {
                let workdir =
                    self.workdir_for_session(&session_id, project_path_key.as_deref(), &workdir)?;
                let target = resolve_local_target(&workdir, &path)?;
                fs::create_dir_all(&target)
                    .map_err(|error| format!("failed to create folder: {error}"))?;
                let entry = local_entry_from_abs(&workdir, &target)?;
                Ok(SftpActionResponse {
                    action: "mkdir".to_string(),
                    path: entry.path.clone(),
                    entry: Some(entry),
                    transfer: None,
                })
            }
            "remote" => {
                self.ensure_session_allowed(&session_id, project_path_key.as_deref())?;
                let remote_path = normalize_remote_path(&path);
                let connection = self.connection_for_session(&session_id).await?;
                let guard = connection.lock().await;
                guard
                    .session
                    .create_dir(remote_path.clone())
                    .await
                    .map_err(|error| format!("remote mkdir failed: {error}"))?;
                let entry = remote_entry_from_metadata(&guard.session, &remote_path).await?;
                Ok(SftpActionResponse {
                    action: "mkdir".to_string(),
                    path: remote_path,
                    entry: Some(entry),
                    transfer: None,
                })
            }
            _ => Err("side must be local or remote".to_string()),
        }
    }

    pub async fn rename(
        &self,
        session_id: String,
        project_path_key: Option<String>,
        workdir: String,
        side: String,
        from_path: String,
        to_path: String,
    ) -> Result<SftpActionResponse, String> {
        match normalize_side(&side)?.as_str() {
            "local" => {
                let workdir =
                    self.workdir_for_session(&session_id, project_path_key.as_deref(), &workdir)?;
                let from = resolve_existing_local_entry(&workdir, &from_path)?;
                let to = resolve_local_target(&workdir, &to_path)?;
                if let Some(parent) = to.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|error| format!("failed to create parent folder: {error}"))?;
                    ensure_path_inside(&workdir, parent)?;
                }
                fs::rename(&from, &to).map_err(|error| format!("local rename failed: {error}"))?;
                let entry = local_entry_from_abs(&workdir, &to)?;
                Ok(SftpActionResponse {
                    action: "rename".to_string(),
                    path: entry.path.clone(),
                    entry: Some(entry),
                    transfer: None,
                })
            }
            "remote" => {
                self.ensure_session_allowed(&session_id, project_path_key.as_deref())?;
                let from = normalize_remote_path(&from_path);
                let to = normalize_remote_path(&to_path);
                let connection = self.connection_for_session(&session_id).await?;
                let guard = connection.lock().await;
                guard
                    .session
                    .rename(from, to.clone())
                    .await
                    .map_err(|error| format!("remote rename failed: {error}"))?;
                let entry = remote_entry_from_metadata(&guard.session, &to).await?;
                Ok(SftpActionResponse {
                    action: "rename".to_string(),
                    path: to,
                    entry: Some(entry),
                    transfer: None,
                })
            }
            _ => Err("side must be local or remote".to_string()),
        }
    }

    pub async fn delete(
        &self,
        session_id: String,
        project_path_key: Option<String>,
        workdir: String,
        side: String,
        path: String,
        recursive: bool,
    ) -> Result<SftpActionResponse, String> {
        match normalize_side(&side)?.as_str() {
            "local" => {
                let workdir =
                    self.workdir_for_session(&session_id, project_path_key.as_deref(), &workdir)?;
                let target = resolve_existing_local_entry(&workdir, &path)?;
                let md = fs::symlink_metadata(&target)
                    .map_err(|error| format!("local stat failed: {error}"))?;
                if md.file_type().is_symlink() {
                    fs::remove_file(&target)
                        .map_err(|error| format!("local delete failed: {error}"))?;
                } else if md.is_dir() {
                    if !recursive {
                        return Err("recursive is required to delete a directory".to_string());
                    }
                    fs::remove_dir_all(&target)
                        .map_err(|error| format!("local recursive delete failed: {error}"))?;
                } else {
                    fs::remove_file(&target)
                        .map_err(|error| format!("local delete failed: {error}"))?;
                }
                Ok(SftpActionResponse {
                    action: "delete".to_string(),
                    path: normalize_local_path(&path),
                    entry: None,
                    transfer: None,
                })
            }
            "remote" => {
                self.ensure_session_allowed(&session_id, project_path_key.as_deref())?;
                let remote_path = normalize_remote_path(&path);
                let connection = self.connection_for_session(&session_id).await?;
                let guard = connection.lock().await;
                delete_remote_path(&guard.session, &remote_path, recursive).await?;
                Ok(SftpActionResponse {
                    action: "delete".to_string(),
                    path: remote_path,
                    entry: None,
                    transfer: None,
                })
            }
            _ => Err("side must be local or remote".to_string()),
        }
    }

    pub async fn transfer(
        self: &Arc<Self>,
        session_id: String,
        project_path_key: Option<String>,
        workdir: String,
        direction: String,
        source_path: String,
        target_path: String,
        recursive: bool,
        overwrite: bool,
    ) -> Result<SftpTransferResponse, String> {
        let workdir =
            self.workdir_for_session(&session_id, project_path_key.as_deref(), &workdir)?;
        let direction = normalize_transfer_direction(&direction)?;
        let transfer_id = Uuid::new_v4().to_string();
        let task_key = format!("{}:{}", session_id.trim(), transfer_id);
        let task = Arc::new(SftpTransferTask {
            cancelled: AtomicBool::new(false),
        });
        self.transfers
            .lock()
            .map_err(|_| "SFTP transfer registry poisoned".to_string())?
            .insert(task_key.clone(), Arc::clone(&task));

        let initial = SftpTransferState {
            id: transfer_id.clone(),
            session_id: session_id.clone(),
            direction: direction.clone(),
            status: "queued".to_string(),
            source_path: normalize_transfer_source_path(&direction, &source_path),
            target_path: normalize_transfer_target_path(&direction, &target_path),
            current_path: normalize_transfer_source_path(&direction, &source_path),
            bytes_done: 0,
            bytes_total: 0,
            files_done: 0,
            files_total: 0,
            error: None,
        };
        self.broadcast("queued", initial.clone());

        let failed_template = initial.clone();
        let registry = Arc::clone(self);
        tokio::spawn(async move {
            let result = if direction == "upload" {
                registry
                    .upload(
                        &session_id,
                        &transfer_id,
                        workdir.as_path(),
                        &source_path,
                        &target_path,
                        recursive,
                        overwrite,
                        &task,
                    )
                    .await
            } else {
                registry
                    .download(
                        &session_id,
                        &transfer_id,
                        workdir.as_path(),
                        &source_path,
                        &target_path,
                        recursive,
                        overwrite,
                        &task,
                    )
                    .await
            };
            if let Ok(mut transfers) = registry.transfers.lock() {
                transfers.remove(&task_key);
            }
            match result {
                Ok(transfer) => registry.broadcast(&transfer.status.clone(), transfer),
                Err(error) => {
                    let mut failed = failed_template;
                    failed.status = if error.to_ascii_lowercase().contains("cancel") {
                        "cancelled".to_string()
                    } else {
                        "failed".to_string()
                    };
                    failed.error = Some(error);
                    registry.broadcast(&failed.status.clone(), failed);
                }
            }
        });

        Ok(SftpTransferResponse { transfer: initial })
    }

    pub fn cancel_transfer(&self, session_id: String, transfer_id: String) -> Result<(), String> {
        let key = format!("{}:{}", session_id.trim(), transfer_id.trim());
        let task = self
            .transfers
            .lock()
            .map_err(|_| "SFTP transfer registry poisoned".to_string())?
            .get(&key)
            .cloned()
            .ok_or_else(|| "SFTP transfer not found".to_string())?;
        task.cancelled.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn transfer_status(
        &self,
        session_id: String,
        transfer_id: String,
    ) -> Result<SftpTransferResponse, String> {
        let key = format!("{}:{}", session_id.trim(), transfer_id.trim());
        let transfer = self
            .transfer_states
            .lock()
            .map_err(|_| "SFTP transfer state registry poisoned".to_string())?
            .get(&key)
            .cloned()
            .ok_or_else(|| "SFTP transfer not found".to_string())?;
        Ok(SftpTransferResponse { transfer })
    }

    fn ensure_session_allowed(
        &self,
        session_id: &str,
        project_path_key: Option<&str>,
    ) -> Result<TerminalSshSessionInfo, String> {
        let info = self.terminal_registry.ssh_session_info(session_id)?;
        if let Some(project_path_key) = project_path_key {
            let wanted = normalize_project_path_key(project_path_key);
            if !wanted.is_empty() && !project_path_keys_equal(&info.project_path_key, &wanted) {
                return Err("SSH session does not belong to this project".to_string());
            }
        }
        if !info.sftp_enabled {
            return Err("SFTP is not enabled for this SSH session".to_string());
        }
        if !info.running {
            return Err("SSH session is not connected".to_string());
        }
        Ok(info)
    }

    fn workdir_for_session(
        &self,
        session_id: &str,
        project_path_key: Option<&str>,
        requested_workdir: &str,
    ) -> Result<PathBuf, String> {
        let info = self.ensure_session_allowed(session_id, project_path_key)?;
        let session_workdir = canonicalize_workdir(&info.cwd)?;
        let requested = canonicalize_workdir(requested_workdir)?;
        if requested != session_workdir {
            return Err("SFTP local root must match the SSH session project".to_string());
        }
        Ok(session_workdir)
    }

    fn broadcast(&self, kind: &str, transfer: SftpTransferState) {
        let payload = SftpEventPayload {
            kind: kind.to_string(),
            transfer,
        };
        if let Ok(mut transfer_states) = self.transfer_states.lock() {
            let key = format!(
                "{}:{}",
                payload.transfer.session_id.trim(),
                payload.transfer.id.trim()
            );
            transfer_states.insert(key, payload.transfer.clone());
        }

        if let Ok(events) = self.events.lock() {
            if let Some(events) = events.as_ref() {
                events.emit(SFTP_EVENT_NAME, &payload);
            }
        }

        let subscribers = self
            .subscribers
            .lock()
            .map(|subscribers| subscribers.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let event = SftpEvent { payload };
        for subscriber in subscribers {
            let _ = subscriber.send(event.clone());
        }
    }

    async fn connection_for_session(
        &self,
        session_id: &str,
    ) -> Result<Arc<tokio::sync::Mutex<TerminalSftpConnection>>, String> {
        let session_id = session_id.trim().to_string();
        if session_id.is_empty() {
            return Err("session_id is required".to_string());
        }
        // SFTP rides on the terminal session's authenticated connection; a
        // cached channel from a previous connection (pre-reconnect) is dead.
        let current_connection_id = self.terminal_registry.ssh_connection_id(&session_id)?;
        if let Some(existing) = self
            .sessions
            .lock()
            .map_err(|_| "SFTP session registry poisoned".to_string())?
            .get(&session_id)
            .filter(|cached| cached.connection_id == current_connection_id)
            .map(|cached| Arc::clone(&cached.connection))
        {
            return Ok(existing);
        }

        let info = self.terminal_registry.ssh_session_info(&session_id)?;
        if !info.sftp_enabled {
            return Err("SFTP is not enabled for this SSH session".to_string());
        }
        if !info.running {
            return Err("SSH session is not connected".to_string());
        }
        let (connection, connection_id) = self
            .terminal_registry
            .open_ssh_sftp_session(&session_id)
            .await?;
        let connection = Arc::new(tokio::sync::Mutex::new(connection));
        self.sessions
            .lock()
            .map_err(|_| "SFTP session registry poisoned".to_string())?
            .insert(
                session_id,
                SftpCachedConnection {
                    connection_id,
                    connection: Arc::clone(&connection),
                },
            );
        Ok(connection)
    }

    fn invalidate_session_connection(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id.trim());
        }
    }

    fn list_local(
        &self,
        workdir: PathBuf,
        path: Option<String>,
    ) -> Result<SftpListResponse, String> {
        let rel = path.unwrap_or_default();
        let target = resolve_existing_local_target(&workdir, &rel)?;
        let md = fs::metadata(&target).map_err(|error| format!("local stat failed: {error}"))?;
        if !md.is_dir() {
            return Err("local path is not a directory".to_string());
        }
        let mut entries = fs::read_dir(&target)
            .map_err(|error| format!("local list failed: {error}"))?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| local_entry_from_abs(&workdir, &entry.path()).ok())
            .filter(|entry| entry.name != "." && entry.name != "..")
            .collect::<Vec<_>>();
        sort_entries(&mut entries);
        Ok(SftpListResponse {
            path: rel_to_workdir_str(&workdir, &target),
            entries,
        })
    }

    fn stat_local(
        &self,
        workdir: PathBuf,
        path: Option<String>,
    ) -> Result<SftpStatResponse, String> {
        let rel = path.unwrap_or_default();
        let local_rel = sanitize_local_rel_path(&rel)?;
        let target = workdir.join(local_rel);
        match fs::symlink_metadata(&target) {
            Ok(_) => ensure_entry_path_inside(&workdir, &target)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                ensure_path_inside(&workdir, &target)?;
                return Ok(SftpStatResponse {
                    exists: false,
                    entry: None,
                });
            }
            Err(error) => return Err(format!("local stat failed: {error}")),
        }
        Ok(SftpStatResponse {
            exists: true,
            entry: Some(local_entry_from_abs(&workdir, &target)?),
        })
    }

    async fn list_remote(
        &self,
        session_id: String,
        path: Option<String>,
    ) -> Result<SftpListResponse, String> {
        let remote_path = normalize_remote_path(path.as_deref().unwrap_or(""));
        match self
            .list_remote_once(&session_id, remote_path.clone())
            .await
        {
            Ok(response) => Ok(response),
            Err(error) if is_session_closed_error(&error) => {
                self.invalidate_session_connection(&session_id);
                self.list_remote_once(&session_id, remote_path).await
            }
            Err(error) => Err(error),
        }
    }

    async fn list_remote_once(
        &self,
        session_id: &str,
        remote_path: String,
    ) -> Result<SftpListResponse, String> {
        let connection = self.connection_for_session(&session_id).await?;
        let guard = connection.lock().await;
        let list_path = guard
            .session
            .canonicalize(remote_path.clone())
            .await
            .map(|path| normalize_remote_path(&path))
            .unwrap_or_else(|_| remote_path.clone());
        let mut entries = Vec::new();
        for entry in guard
            .session
            .read_dir(list_path.clone())
            .await
            .map_err(|error| format!("remote list failed: {error}"))?
        {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let path = join_remote_path(&list_path, &name);
            let metadata = entry.metadata();
            entries.push(SftpEntry {
                path,
                name,
                kind: remote_kind(&metadata),
                size_bytes: metadata.size.unwrap_or(0),
                mtime: u64::from(metadata.mtime.unwrap_or(0)) * 1000,
            });
        }
        sort_entries(&mut entries);
        Ok(SftpListResponse {
            path: list_path,
            entries,
        })
    }

    async fn stat_remote(
        &self,
        session_id: String,
        path: Option<String>,
    ) -> Result<SftpStatResponse, String> {
        let remote_path = normalize_remote_path(path.as_deref().unwrap_or(""));
        match self
            .stat_remote_once(&session_id, remote_path.clone())
            .await
        {
            Ok(response) => Ok(response),
            Err(error) if is_session_closed_error(&error) => {
                self.invalidate_session_connection(&session_id);
                self.stat_remote_once(&session_id, remote_path).await
            }
            Err(error) => Err(error),
        }
    }

    async fn stat_remote_once(
        &self,
        session_id: &str,
        remote_path: String,
    ) -> Result<SftpStatResponse, String> {
        let connection = self.connection_for_session(&session_id).await?;
        let guard = connection.lock().await;
        match remote_entry_from_metadata(&guard.session, &remote_path).await {
            Ok(entry) => Ok(SftpStatResponse {
                exists: true,
                entry: Some(entry),
            }),
            Err(error) if is_not_found_error(&error) => Ok(SftpStatResponse {
                exists: false,
                entry: None,
            }),
            Err(error) => Err(error),
        }
    }

    async fn read_text_remote(
        &self,
        session_id: String,
        remote_path: String,
        offset: u64,
        max_bytes: Option<usize>,
    ) -> Result<SftpReadTextResponse, String> {
        match self
            .read_text_remote_once(&session_id, remote_path.clone(), offset, max_bytes)
            .await
        {
            Ok(response) => Ok(response),
            Err(error) if is_session_closed_error(&error) => {
                self.invalidate_session_connection(&session_id);
                self.read_text_remote_once(&session_id, remote_path, offset, max_bytes)
                    .await
            }
            Err(error) => Err(error),
        }
    }

    async fn read_text_remote_once(
        &self,
        session_id: &str,
        remote_path: String,
        offset: u64,
        max_bytes: Option<usize>,
    ) -> Result<SftpReadTextResponse, String> {
        let limit = normalize_read_text_max_bytes(max_bytes);
        let connection = self.connection_for_session(session_id).await?;
        let guard = connection.lock().await;
        let metadata = guard
            .session
            .metadata(remote_path.clone())
            .await
            .map_err(|error| format!("remote stat failed: {error}"))?;
        if metadata.is_dir() {
            return Err("remote path is a directory".to_string());
        }
        let size_bytes = metadata.size.unwrap_or(0);
        let mut file = guard
            .session
            .open(remote_path.clone())
            .await
            .map_err(|error| format!("failed to open remote file: {error}"))?;
        if offset > 0 {
            file.seek(io::SeekFrom::Start(offset))
                .await
                .map_err(|error| format!("failed to seek remote file: {error}"))?;
        }
        let mut buffer = Vec::with_capacity(limit.saturating_add(1));
        let mut chunk = vec![0u8; TRANSFER_BUFFER_BYTES.min(limit.saturating_add(1).max(1))];
        while buffer.len() <= limit {
            let want = (limit + 1 - buffer.len()).min(chunk.len());
            let bytes_read = file
                .read(&mut chunk[..want])
                .await
                .map_err(|error| format!("failed to read remote file: {error}"))?;
            if bytes_read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..bytes_read]);
        }
        let actual_read = buffer.len();
        buffer.truncate(actual_read.min(limit));
        let truncated = actual_read > limit
            || (offset as u128).saturating_add(buffer.len() as u128) < u128::from(size_bytes);
        Ok(SftpReadTextResponse {
            path: remote_path,
            content: String::from_utf8_lossy(&buffer).to_string(),
            offset,
            bytes_read: buffer.len(),
            size_bytes,
            truncated,
        })
    }

    async fn upload(
        &self,
        session_id: &str,
        transfer_id: &str,
        workdir: &Path,
        source_path: &str,
        target_path: &str,
        recursive: bool,
        overwrite: bool,
        task: &SftpTransferTask,
    ) -> Result<SftpTransferState, String> {
        let source = resolve_existing_local_entry(&workdir, source_path)?;
        let source_md =
            fs::symlink_metadata(&source).map_err(|error| format!("local stat failed: {error}"))?;
        if source_md.file_type().is_symlink() {
            return Err("SFTP upload does not support local symlinks".to_string());
        }
        if source_md.is_dir() && !recursive {
            return Err("recursive is required to upload a directory".to_string());
        }
        let root_name = source
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "upload".to_string());
        let dirs = if source_md.is_dir() {
            collect_local_dirs(&workdir, &source)?
        } else {
            Vec::new()
        };
        let files = collect_local_files(&workdir, &source)?;
        let bytes_total = files.iter().map(|file| file.size).sum::<u64>();
        let files_total = files.len().min(u32::MAX as usize) as u32;
        let remote_base = join_remote_path(&normalize_remote_path(target_path), &root_name);
        let connection = self.connection_for_session(session_id).await?;
        let guard = connection.lock().await;
        if source_md.is_dir() {
            create_remote_dirs_for_local_root(&guard.session, &remote_base).await?;
            for dir in &dirs {
                check_cancelled(task)?;
                ensure_remote_dir_all(&guard.session, &join_remote_path(&remote_base, &dir.rel))
                    .await?;
            }
        }

        let mut state = SftpTransferState {
            id: transfer_id.to_string(),
            session_id: session_id.to_string(),
            direction: "upload".to_string(),
            status: "running".to_string(),
            source_path: normalize_local_path(source_path),
            target_path: remote_base.clone(),
            current_path: String::new(),
            bytes_done: 0,
            bytes_total,
            files_done: 0,
            files_total,
            error: None,
        };
        self.broadcast("running", state.clone());

        for file in files {
            check_cancelled(task)?;
            let remote_file_path = if source_md.is_dir() {
                join_remote_path(&remote_base, &file.rel)
            } else {
                remote_base.clone()
            };
            state.current_path = remote_file_path.clone();
            if !overwrite
                && guard
                    .session
                    .try_exists(remote_file_path.clone())
                    .await
                    .unwrap_or(false)
            {
                return Err(format!("target already exists: {remote_file_path}"));
            }
            if let Some(parent) = remote_parent_path(&remote_file_path) {
                ensure_remote_dir_all(&guard.session, &parent).await?;
            }
            upload_file(
                &guard.session,
                &file.abs,
                &remote_file_path,
                &mut state,
                task,
                self,
            )
            .await?;
            state.files_done = state.files_done.saturating_add(1);
            self.broadcast("progress", state.clone());
        }
        state.status = if task.cancelled.load(Ordering::SeqCst) {
            "cancelled".to_string()
        } else {
            "completed".to_string()
        };
        Ok(state)
    }

    async fn download(
        &self,
        session_id: &str,
        transfer_id: &str,
        workdir: &Path,
        source_path: &str,
        target_path: &str,
        recursive: bool,
        overwrite: bool,
        task: &SftpTransferTask,
    ) -> Result<SftpTransferState, String> {
        let local_target = resolve_local_target(&workdir, target_path)?;
        let remote_source = normalize_remote_path(source_path);
        let connection = self.connection_for_session(session_id).await?;
        let guard = connection.lock().await;
        let source_meta = guard
            .session
            .metadata(remote_source.clone())
            .await
            .map_err(|error| format!("remote stat failed: {error}"))?;
        if source_meta.is_dir() && !recursive {
            return Err("recursive is required to download a directory".to_string());
        }
        let dirs = if source_meta.is_dir() {
            collect_remote_dirs(&guard.session, &remote_source).await?
        } else {
            Vec::new()
        };
        let files = collect_remote_files(&guard.session, &remote_source).await?;
        let bytes_total = files.iter().map(|file| file.size).sum::<u64>();
        let files_total = files.len().min(u32::MAX as usize) as u32;
        let source_name = remote_basename(&remote_source).unwrap_or_else(|| "download".to_string());
        let target_base = local_target.join(source_name);
        ensure_path_inside(&workdir, &target_base)?;
        if source_meta.is_dir() {
            fs::create_dir_all(&target_base)
                .map_err(|error| format!("failed to create local folder: {error}"))?;
            ensure_path_inside(&workdir, &target_base)?;
            for dir in &dirs {
                check_cancelled(task)?;
                let local_dir_path = target_base.join(Path::new(&dir.rel));
                ensure_path_inside(&workdir, &local_dir_path)?;
                fs::create_dir_all(&local_dir_path)
                    .map_err(|error| format!("failed to create local folder: {error}"))?;
            }
        }

        let mut state = SftpTransferState {
            id: transfer_id.to_string(),
            session_id: session_id.to_string(),
            direction: "download".to_string(),
            status: "running".to_string(),
            source_path: remote_source.clone(),
            target_path: rel_to_workdir_str(&workdir, &target_base),
            current_path: String::new(),
            bytes_done: 0,
            bytes_total,
            files_done: 0,
            files_total,
            error: None,
        };
        self.broadcast("running", state.clone());

        for file in files {
            check_cancelled(task)?;
            let local_file_path = if source_meta.is_dir() {
                target_base.join(Path::new(&file.rel))
            } else {
                target_base.clone()
            };
            ensure_path_inside(&workdir, &local_file_path)?;
            state.current_path = rel_to_workdir_str(&workdir, &local_file_path);
            if fs::symlink_metadata(&local_file_path)
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(false)
            {
                return Err(format!("target is a local symlink: {}", state.current_path));
            }
            if local_file_path.exists() && !overwrite {
                return Err(format!("target already exists: {}", state.current_path));
            }
            if let Some(parent) = local_file_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("failed to create local folder: {error}"))?;
                ensure_path_inside(&workdir, parent)?;
            }
            download_file(
                &guard.session,
                &file.path,
                &local_file_path,
                &mut state,
                task,
                self,
            )
            .await?;
            state.files_done = state.files_done.saturating_add(1);
            self.broadcast("progress", state.clone());
        }
        state.status = if task.cancelled.load(Ordering::SeqCst) {
            "cancelled".to_string()
        } else {
            "completed".to_string()
        };
        Ok(state)
    }
}

pub struct SftpSubscriberGuard {
    id: usize,
    subscribers: Arc<Mutex<HashMap<usize, mpsc::Sender<SftpEvent>>>>,
}

impl Drop for SftpSubscriberGuard {
    fn drop(&mut self) {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.remove(&self.id);
        }
    }
}

fn normalize_side(side: &str) -> Result<String, String> {
    let side = side.trim().to_ascii_lowercase();
    match side.as_str() {
        "local" | "remote" => Ok(side),
        _ => Err("side must be local or remote".to_string()),
    }
}

fn normalize_transfer_direction(direction: &str) -> Result<String, String> {
    let direction = direction.trim().to_ascii_lowercase();
    match direction.as_str() {
        "upload" | "download" => Ok(direction),
        _ => Err("direction must be upload or download".to_string()),
    }
}

fn normalize_transfer_source_path(direction: &str, path: &str) -> String {
    if direction == "upload" {
        normalize_local_path(path)
    } else {
        normalize_remote_path(path)
    }
}

fn normalize_transfer_target_path(direction: &str, path: &str) -> String {
    if direction == "upload" {
        normalize_remote_path(path)
    } else {
        normalize_local_path(path)
    }
}

fn normalize_read_text_max_bytes(max_bytes: Option<usize>) -> usize {
    max_bytes
        .filter(|value| *value > 0)
        .unwrap_or(SFTP_READ_TEXT_DEFAULT_BYTES)
        .clamp(4 * 1024, SFTP_READ_TEXT_MAX_BYTES)
}

fn canonicalize_workdir(workdir: &str) -> Result<PathBuf, String> {
    let raw = workdir.trim();
    if raw.is_empty() {
        return Err("workdir is required".to_string());
    }
    let p = expand_tilde_path(raw);
    if !p.is_absolute() {
        return Err("workdir must be an absolute directory".to_string());
    }
    let md = fs::metadata(&p).map_err(|_| "workdir must be an existing directory".to_string())?;
    if !md.is_dir() {
        return Err("workdir must be an existing directory".to_string());
    }
    fs::canonicalize(&p).map_err(|error| format!("failed to canonicalize workdir: {error}"))
}

fn normalize_local_path(path: &str) -> String {
    path.trim().replace('\\', "/").trim_matches('/').to_string()
}

fn sanitize_local_rel_path(path: &str) -> Result<PathBuf, String> {
    let raw = path.trim().replace('\\', "/");
    if raw.starts_with('/') {
        return Err("local path must stay inside the project".to_string());
    }
    let normalized = normalize_local_path(&raw);
    if normalized.is_empty() {
        return Ok(PathBuf::new());
    }
    let mut out = PathBuf::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                return Err("local path must stay inside the project".to_string());
            }
            Component::CurDir => {}
            Component::Normal(segment) => out.push(segment),
        }
    }
    Ok(out)
}

fn resolve_local_target(workdir: &Path, path: &str) -> Result<PathBuf, String> {
    let rel = sanitize_local_rel_path(path)?;
    let target = workdir.join(rel);
    ensure_path_inside(workdir, &target)?;
    Ok(target)
}

fn resolve_existing_local_target(workdir: &Path, path: &str) -> Result<PathBuf, String> {
    let target = resolve_local_target(workdir, path)?;
    if !target.exists() {
        return Err("local path does not exist".to_string());
    }
    let canonical =
        fs::canonicalize(&target).map_err(|error| format!("local stat failed: {error}"))?;
    ensure_path_inside(workdir, &canonical)?;
    Ok(canonical)
}

fn resolve_existing_local_entry(workdir: &Path, path: &str) -> Result<PathBuf, String> {
    let rel = sanitize_local_rel_path(path)?;
    let target = workdir.join(rel);
    fs::symlink_metadata(&target).map_err(|_| "local path does not exist".to_string())?;
    ensure_entry_path_inside(workdir, &target)?;
    Ok(target)
}

fn ensure_entry_path_inside(workdir: &Path, target: &Path) -> Result<(), String> {
    if target == workdir {
        return Ok(());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "target path is outside the project".to_string())?;
    ensure_path_inside(workdir, parent)
}

fn ensure_path_inside(workdir: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        let canonical = fs::canonicalize(target)
            .map_err(|error| format!("failed to canonicalize target path: {error}"))?;
        if !canonical.starts_with(workdir) {
            return Err("target path is outside the project".to_string());
        }
        return Ok(());
    }
    let mut probe = target;
    while !probe.exists() {
        probe = probe
            .parent()
            .ok_or_else(|| "target path is outside the project".to_string())?;
    }
    let canonical = fs::canonicalize(probe)
        .map_err(|error| format!("failed to canonicalize target parent: {error}"))?;
    if !canonical.starts_with(workdir) {
        return Err("target path is outside the project".to_string());
    }
    Ok(())
}

fn rel_to_workdir_str(workdir: &Path, abs: &Path) -> String {
    abs.strip_prefix(workdir)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

fn local_entry_from_abs(workdir: &Path, abs: &Path) -> Result<SftpEntry, String> {
    ensure_entry_path_inside(workdir, abs)?;
    let md = fs::symlink_metadata(abs).map_err(|error| format!("local stat failed: {error}"))?;
    let name = abs
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| {
            workdir
                .file_name()
                .map(|v| v.to_string_lossy().to_string())
                .unwrap_or_default()
        });
    let kind = if md.file_type().is_symlink() {
        "symlink"
    } else if md.is_dir() {
        "directory"
    } else {
        "file"
    }
    .to_string();
    Ok(SftpEntry {
        path: rel_to_workdir_str(workdir, abs),
        name,
        kind,
        size_bytes: if md.is_file() { md.len() } else { 0 },
        mtime: system_time_ms(md.modified().ok()),
    })
}

fn system_time_ms(value: Option<SystemTime>) -> u64 {
    value
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn sort_entries(entries: &mut [SftpEntry]) {
    entries.sort_by(|a, b| {
        let left_dir = a.kind == "directory";
        let right_dir = b.kind == "directory";
        right_dir
            .cmp(&left_dir)
            .then(
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase()),
            )
            .then(a.name.cmp(&b.name))
    });
}

fn remote_kind(metadata: &russh_sftp::client::fs::Metadata) -> String {
    if metadata.is_dir() {
        "directory".to_string()
    } else if metadata.is_symlink() {
        "symlink".to_string()
    } else {
        "file".to_string()
    }
}

async fn remote_entry_from_metadata(
    session: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<SftpEntry, String> {
    let path = normalize_remote_path(path);
    let metadata = session
        .metadata(path.clone())
        .await
        .map_err(|error| format!("remote stat failed: {error}"))?;
    Ok(SftpEntry {
        name: remote_basename(&path).unwrap_or_else(|| path.clone()),
        path,
        kind: remote_kind(&metadata),
        size_bytes: metadata.size.unwrap_or(0),
        mtime: u64::from(metadata.mtime.unwrap_or(0)) * 1000,
    })
}

fn normalize_remote_path(path: &str) -> String {
    let raw = path.trim().replace('\\', "/");
    if raw.is_empty() || raw == "." {
        return ".".to_string();
    }
    let absolute = raw.starts_with('/');
    let mut parts = Vec::new();
    for part in raw.split('/') {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            continue;
        }
        parts.push(part);
    }
    if absolute {
        if parts.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", parts.join("/"))
        }
    } else if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

fn join_remote_path(parent: &str, child: &str) -> String {
    let child = child.trim().trim_matches('/');
    if child.is_empty() {
        return normalize_remote_path(parent);
    }
    let parent = normalize_remote_path(parent);
    if parent == "/" {
        format!("/{child}")
    } else if parent == "." {
        child.to_string()
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), child)
    }
}

fn remote_parent_path(path: &str) -> Option<String> {
    let path = normalize_remote_path(path);
    if path == "." || path == "/" {
        return None;
    }
    match path.rsplit_once('/') {
        Some(("", _)) => Some("/".to_string()),
        Some((parent, _)) if !parent.is_empty() => Some(parent.to_string()),
        _ => Some(".".to_string()),
    }
}

fn remote_basename(path: &str) -> Option<String> {
    let path = normalize_remote_path(path);
    if path == "." || path == "/" {
        return None;
    }
    path.rsplit('/').next().map(|value| value.to_string())
}

fn collect_local_dirs(workdir: &Path, source: &Path) -> Result<Vec<LocalDirPlan>, String> {
    let md = fs::symlink_metadata(source).map_err(|error| format!("local stat failed: {error}"))?;
    if md.file_type().is_symlink() {
        return Err("SFTP upload does not support local symlinks".to_string());
    }
    if !md.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    collect_local_dirs_inner(workdir, source, source, &mut out)?;
    Ok(out)
}

fn collect_local_dirs_inner(
    workdir: &Path,
    root: &Path,
    current: &Path,
    out: &mut Vec<LocalDirPlan>,
) -> Result<(), String> {
    ensure_path_inside(workdir, current)?;
    for entry in fs::read_dir(current).map_err(|error| format!("local list failed: {error}"))? {
        let entry = entry.map_err(|error| format!("local list failed: {error}"))?;
        let path = entry.path();
        let md =
            fs::symlink_metadata(&path).map_err(|error| format!("local stat failed: {error}"))?;
        if md.file_type().is_symlink() {
            return Err(format!(
                "SFTP upload does not support local symlink: {}",
                rel_to_workdir_str(workdir, &path)
            ));
        }
        if md.is_dir() {
            out.push(LocalDirPlan {
                rel: path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/"),
            });
            collect_local_dirs_inner(workdir, root, &path, out)?;
        }
    }
    Ok(())
}

fn collect_local_files(workdir: &Path, source: &Path) -> Result<Vec<LocalFilePlan>, String> {
    let md = fs::symlink_metadata(source).map_err(|error| format!("local stat failed: {error}"))?;
    if md.file_type().is_symlink() {
        return Err("SFTP upload does not support local symlinks".to_string());
    }
    if md.is_file() {
        return Ok(vec![LocalFilePlan {
            abs: source.to_path_buf(),
            rel: source
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string()),
            size: md.len(),
        }]);
    }
    if !md.is_dir() {
        return Err("local source is neither file nor directory".to_string());
    }
    let mut out = Vec::new();
    collect_local_files_inner(workdir, source, source, &mut out)?;
    Ok(out)
}

fn collect_local_files_inner(
    workdir: &Path,
    root: &Path,
    current: &Path,
    out: &mut Vec<LocalFilePlan>,
) -> Result<(), String> {
    ensure_path_inside(workdir, current)?;
    for entry in fs::read_dir(current).map_err(|error| format!("local list failed: {error}"))? {
        let entry = entry.map_err(|error| format!("local list failed: {error}"))?;
        let path = entry.path();
        let md =
            fs::symlink_metadata(&path).map_err(|error| format!("local stat failed: {error}"))?;
        if md.file_type().is_symlink() {
            return Err(format!(
                "SFTP upload does not support local symlink: {}",
                rel_to_workdir_str(workdir, &path)
            ));
        }
        if md.is_dir() {
            collect_local_files_inner(workdir, root, &path, out)?;
        } else if md.is_file() {
            out.push(LocalFilePlan {
                rel: path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/"),
                abs: path,
                size: md.len(),
            });
        }
    }
    Ok(())
}

async fn collect_remote_dirs(
    session: &russh_sftp::client::SftpSession,
    source: &str,
) -> Result<Vec<RemoteDirPlan>, String> {
    let metadata = session
        .metadata(source.to_string())
        .await
        .map_err(|error| format!("remote stat failed: {error}"))?;
    if !metadata.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    collect_remote_dirs_inner(session, source, source, &mut out).await?;
    Ok(out)
}

async fn collect_remote_dirs_inner(
    session: &russh_sftp::client::SftpSession,
    root: &str,
    current: &str,
    out: &mut Vec<RemoteDirPlan>,
) -> Result<(), String> {
    let mut stack = vec![current.to_string()];
    while let Some(dir) = stack.pop() {
        for entry in session
            .read_dir(dir.clone())
            .await
            .map_err(|error| format!("remote list failed: {error}"))?
        {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let path = join_remote_path(&dir, &name);
            let metadata = entry.metadata();
            if metadata.is_dir() {
                out.push(RemoteDirPlan {
                    rel: remote_relative_path(root, &path),
                });
                stack.push(path);
            }
        }
    }
    Ok(())
}

async fn collect_remote_files(
    session: &russh_sftp::client::SftpSession,
    source: &str,
) -> Result<Vec<RemoteFilePlan>, String> {
    let metadata = session
        .metadata(source.to_string())
        .await
        .map_err(|error| format!("remote stat failed: {error}"))?;
    if !metadata.is_dir() {
        return Ok(vec![RemoteFilePlan {
            path: source.to_string(),
            rel: remote_basename(source).unwrap_or_else(|| "file".to_string()),
            size: metadata.size.unwrap_or(0),
        }]);
    }
    let mut out = Vec::new();
    collect_remote_files_inner(session, source, source, &mut out).await?;
    Ok(out)
}

async fn collect_remote_files_inner(
    session: &russh_sftp::client::SftpSession,
    root: &str,
    current: &str,
    out: &mut Vec<RemoteFilePlan>,
) -> Result<(), String> {
    let mut stack = vec![current.to_string()];
    while let Some(dir) = stack.pop() {
        for entry in session
            .read_dir(dir.clone())
            .await
            .map_err(|error| format!("remote list failed: {error}"))?
        {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let path = join_remote_path(&dir, &name);
            let metadata = entry.metadata();
            if metadata.is_dir() {
                stack.push(path);
            } else {
                out.push(RemoteFilePlan {
                    rel: remote_relative_path(root, &path),
                    path,
                    size: metadata.size.unwrap_or(0),
                });
            }
        }
    }
    Ok(())
}

fn remote_relative_path(root: &str, path: &str) -> String {
    let root = normalize_remote_path(root);
    let path = normalize_remote_path(path);
    if let Some(rest) = path.strip_prefix(root.trim_end_matches('/')) {
        rest.trim_start_matches('/').to_string()
    } else {
        remote_basename(&path).unwrap_or(path)
    }
}

async fn ensure_remote_dir_all(
    session: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(), String> {
    let path = normalize_remote_path(path);
    if path == "." || path == "/" {
        return Ok(());
    }
    let absolute = path.starts_with('/');
    let mut current = if absolute {
        "/".to_string()
    } else {
        ".".to_string()
    };
    for part in path
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
    {
        current = join_remote_path(&current, part);
        match session.create_dir(current.clone()).await {
            Ok(_) => {}
            Err(_) if session.try_exists(current.clone()).await.unwrap_or(false) => {}
            Err(error) => return Err(format!("remote mkdir failed: {error}")),
        }
    }
    Ok(())
}

async fn create_remote_dirs_for_local_root(
    session: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(), String> {
    ensure_remote_dir_all(session, path).await
}

async fn upload_file(
    session: &russh_sftp::client::SftpSession,
    local_path: &Path,
    remote_path: &str,
    state: &mut SftpTransferState,
    task: &SftpTransferTask,
    registry: &SftpSessionRegistry,
) -> Result<(), String> {
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|error| format!("failed to open local file: {error}"))?;
    let mut remote = session
        .create(remote_path.to_string())
        .await
        .map_err(|error| format!("failed to create remote file: {error}"))?;
    let mut buffer = vec![0u8; TRANSFER_BUFFER_BYTES];
    loop {
        check_cancelled(task)?;
        let read = local
            .read(&mut buffer)
            .await
            .map_err(|error| format!("failed to read local file: {error}"))?;
        if read == 0 {
            break;
        }
        remote
            .write_all(&buffer[..read])
            .await
            .map_err(|error| format!("failed to write remote file: {error}"))?;
        state.bytes_done = state.bytes_done.saturating_add(read as u64);
        registry.broadcast("progress", state.clone());
    }
    remote
        .shutdown()
        .await
        .map_err(|error| format!("failed to close remote file: {error}"))?;
    Ok(())
}

async fn download_file(
    session: &russh_sftp::client::SftpSession,
    remote_path: &str,
    local_path: &Path,
    state: &mut SftpTransferState,
    task: &SftpTransferTask,
    registry: &SftpSessionRegistry,
) -> Result<(), String> {
    let mut remote = session
        .open(remote_path.to_string())
        .await
        .map_err(|error| format!("failed to open remote file: {error}"))?;
    let mut local = tokio::fs::File::create(local_path)
        .await
        .map_err(|error| format!("failed to create local file: {error}"))?;
    let mut buffer = vec![0u8; TRANSFER_BUFFER_BYTES];
    loop {
        check_cancelled(task)?;
        let read = remote
            .read(&mut buffer)
            .await
            .map_err(|error| format!("failed to read remote file: {error}"))?;
        if read == 0 {
            break;
        }
        local
            .write_all(&buffer[..read])
            .await
            .map_err(|error| format!("failed to write local file: {error}"))?;
        state.bytes_done = state.bytes_done.saturating_add(read as u64);
        registry.broadcast("progress", state.clone());
    }
    local
        .shutdown()
        .await
        .map_err(|error| format!("failed to close local file: {error}"))?;
    Ok(())
}

async fn delete_remote_path(
    session: &russh_sftp::client::SftpSession,
    path: &str,
    recursive: bool,
) -> Result<(), String> {
    let metadata = session
        .metadata(path.to_string())
        .await
        .map_err(|error| format!("remote stat failed: {error}"))?;
    if metadata.is_dir() {
        if !recursive {
            return Err("recursive is required to delete a remote directory".to_string());
        }
        let mut dirs = vec![path.to_string()];
        let mut files = Vec::new();
        let mut idx = 0;
        while idx < dirs.len() {
            let dir = dirs[idx].clone();
            idx += 1;
            for entry in session
                .read_dir(dir.clone())
                .await
                .map_err(|error| format!("remote list failed: {error}"))?
            {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let child = join_remote_path(&dir, &name);
                if entry.metadata().is_dir() {
                    dirs.push(child);
                } else {
                    files.push(child);
                }
            }
        }
        for file in files {
            session
                .remove_file(file)
                .await
                .map_err(|error| format!("remote delete failed: {error}"))?;
        }
        for dir in dirs.into_iter().rev() {
            session
                .remove_dir(dir)
                .await
                .map_err(|error| format!("remote rmdir failed: {error}"))?;
        }
    } else {
        session
            .remove_file(path.to_string())
            .await
            .map_err(|error| format!("remote delete failed: {error}"))?;
    }
    Ok(())
}

fn check_cancelled(task: &SftpTransferTask) -> Result<(), String> {
    if task.cancelled.load(Ordering::SeqCst) {
        Err("SFTP transfer was cancelled".to_string())
    } else {
        Ok(())
    }
}

fn is_not_found_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("no such") || normalized.contains("not found")
}

fn is_session_closed_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("session closed")
        || normalized.contains("channel closed")
        || normalized.contains("connection closed")
        || normalized.contains("broken pipe")
        || normalized.contains("connection reset")
        || normalized.contains("eof")
}

impl From<io::Error> for SftpActionResponse {
    fn from(error: io::Error) -> Self {
        Self {
            action: "error".to_string(),
            path: String::new(),
            entry: None,
            transfer: Some(SftpTransferState {
                id: String::new(),
                session_id: String::new(),
                direction: String::new(),
                status: "failed".to_string(),
                source_path: String::new(),
                target_path: String::new(),
                current_path: String::new(),
                bytes_done: 0,
                bytes_total: 0,
                files_done: 0,
                files_total: 0,
                error: Some(error.to_string()),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_remote_path_keeps_posix_shape() {
        assert_eq!(normalize_remote_path(""), ".");
        assert_eq!(normalize_remote_path("."), ".");
        assert_eq!(normalize_remote_path("/"), "/");
        assert_eq!(normalize_remote_path("/var//log/"), "/var/log");
        assert_eq!(normalize_remote_path("home/agent/../tmp"), "home/agent/tmp");
    }

    #[test]
    fn join_remote_path_treats_target_as_directory() {
        assert_eq!(join_remote_path(".", "file.txt"), "file.txt");
        assert_eq!(join_remote_path("/", "file.txt"), "/file.txt");
        assert_eq!(join_remote_path("/tmp/.ssh", "config"), "/tmp/.ssh/config");
        assert_eq!(
            join_remote_path("folder.with.dots", "file.txt"),
            "folder.with.dots/file.txt"
        );
    }

    #[test]
    fn session_closed_errors_are_reconnectable() {
        assert!(is_session_closed_error(
            "remote list failed: session closed"
        ));
        assert!(is_session_closed_error(
            "remote stat failed: channel closed"
        ));
        assert!(is_session_closed_error("remote list failed: broken pipe"));
        assert!(is_session_closed_error(
            "remote list failed: connection reset by peer"
        ));
        assert!(!is_session_closed_error(
            "remote list failed: permission denied"
        ));
        assert!(!is_session_closed_error("remote list failed: no such file"));
    }

    #[test]
    fn sanitize_local_rel_path_rejects_escape_components() {
        assert!(sanitize_local_rel_path("src/main.rs").is_ok());
        assert!(sanitize_local_rel_path("../outside").is_err());
        assert!(sanitize_local_rel_path("/absolute").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn local_leaf_symlink_is_entry_not_followed_target() {
        use std::os::unix::fs::symlink;

        let workdir = tempfile::tempdir().expect("workdir");
        let outside = tempfile::tempdir().expect("outside");
        let workdir_path = fs::canonicalize(workdir.path()).expect("canonical workdir");
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, "secret").expect("write outside file");
        let link_path = workdir.path().join("linked-secret");
        let canonical_link_path = workdir_path.join("linked-secret");
        symlink(&outside_file, &link_path).expect("create symlink");

        let entry_path = resolve_existing_local_entry(&workdir_path, "linked-secret")
            .expect("resolve symlink entry");
        assert_eq!(entry_path, canonical_link_path);
        assert!(resolve_existing_local_target(&workdir_path, "linked-secret").is_err());

        let entry = local_entry_from_abs(&workdir_path, &canonical_link_path).expect("local entry");
        assert_eq!(entry.kind, "symlink");
        assert_eq!(entry.path, "linked-secret");
    }

    #[cfg(unix)]
    #[test]
    fn collect_local_files_rejects_nested_symlink() {
        use std::os::unix::fs::symlink;

        let workdir = tempfile::tempdir().expect("workdir");
        let outside = tempfile::tempdir().expect("outside");
        let workdir_path = fs::canonicalize(workdir.path()).expect("canonical workdir");
        let source_dir = workdir.path().join("src");
        fs::create_dir(&source_dir).expect("create source dir");
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, "secret").expect("write outside file");
        symlink(&outside_file, source_dir.join("linked-secret")).expect("create symlink");
        let canonical_source_dir = workdir_path.join("src");

        let error = match collect_local_files(&workdir_path, &canonical_source_dir) {
            Ok(_) => panic!("expected local symlink rejection"),
            Err(error) => error,
        };
        assert!(error.contains("local symlink"));
    }
}
