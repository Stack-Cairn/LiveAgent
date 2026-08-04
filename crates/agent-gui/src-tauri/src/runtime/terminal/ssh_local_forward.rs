use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex, Weak};

use tokio::io::{copy_bidirectional, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinSet;
use tokio::time::timeout;

use crate::runtime::project_path::project_path_keys_equal;

use super::*;

const SSH_LOCAL_FORWARD_HOST: &str = "127.0.0.1";
const SSH_LOCAL_FORWARD_MAX_HOST_BYTES: usize = 255;
const SSH_LOCAL_FORWARD_STOP_TIMEOUT: Duration = Duration::from_secs(1);

pub(crate) struct SshLocalForwardRegistry {
    state: Mutex<SshLocalForwardState>,
    global_connections: Arc<Semaphore>,
}

#[derive(Default)]
struct SshLocalForwardState {
    revision: u64,
    entries: HashMap<String, Arc<SshLocalForwardEntry>>,
}

struct SshLocalForwardEntry {
    record: SshLocalForwardRecord,
    cancel_tx: watch::Sender<bool>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Default for SshLocalForwardRegistry {
    fn default() -> Self {
        Self {
            state: Mutex::new(SshLocalForwardState::default()),
            global_connections: Arc::new(Semaphore::new(SSH_LOCAL_FORWARD_MAX_GLOBAL_CONNECTIONS)),
        }
    }
}

impl SshLocalForwardRegistry {
    pub(crate) fn cancel_all(&self) {
        let entries = self
            .state
            .lock()
            .map(|mut state| state.entries.drain().map(|(_, entry)| entry).collect())
            .unwrap_or_else(|_| Vec::new());
        for entry in entries {
            cancel_forward_task(&entry, true);
        }
    }
}

impl TerminalSessionRegistry {
    pub fn ssh_local_forward_list(
        &self,
        session_id: Option<String>,
        project_path_key: Option<String>,
    ) -> Result<SshLocalForwardListResponse, String> {
        let session_id = session_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let project_path_key = project_path_key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let state = self
            .ssh_local_forwards
            .state
            .lock()
            .map_err(|_| "SSH local forward registry poisoned".to_string())?;
        let mut forwards = state
            .entries
            .values()
            .map(|entry| entry.record.clone())
            .filter(|record| {
                session_id
                    .as_ref()
                    .is_none_or(|wanted| record.session_id == *wanted)
                    && project_path_key.as_ref().is_none_or(|wanted| {
                        project_path_keys_equal(&record.project_path_key, wanted)
                    })
            })
            .collect::<Vec<_>>();
        forwards.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        Ok(SshLocalForwardListResponse {
            forwards,
            revision: state.revision,
        })
    }

    pub async fn ssh_local_forward_start(
        self: &Arc<Self>,
        session_id: String,
        project_path_key: Option<String>,
        remote_host: String,
        remote_port: u32,
        local_port: Option<u32>,
    ) -> Result<SshLocalForwardActionResponse, String> {
        let session_id = session_id.trim().to_string();
        if session_id.is_empty() {
            return Err("terminal_id is required".to_string());
        }
        let remote_host = normalize_ssh_local_forward_host(&remote_host)?;
        let remote_port = normalize_ssh_local_forward_remote_port(remote_port)?;
        let local_port = normalize_ssh_local_forward_local_port(local_port)?;
        let requested_project_key = project_path_key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        // Cheap preflight before binding a socket. The authoritative check
        // happens under the sessions + forwards locks below.
        let (_, runtime) =
            self.ssh_local_forward_session(&session_id, requested_project_key.as_deref(), true)?;
        if runtime.current_handle().await.is_none() {
            return Err("SSH connection is not connected".to_string());
        }

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, local_port))
            .await
            .map_err(|error| {
                format!(
                    "SSH local forward could not bind {SSH_LOCAL_FORWARD_HOST}:{local_port}: {error}"
                )
            })?;
        let local_port = listener
            .local_addr()
            .map_err(|error| format!("SSH local forward local address failed: {error}"))?
            .port();

        // Publish the registry entry and capture the runtime under the same
        // critical section that close() uses for cleanup. Spawning happens
        // after the locks are released, then we re-check cancellation so a
        // concurrent close cannot leave an orphan listener.
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let forward_id = uuid::Uuid::new_v4().to_string();
        let (record, entry, revision, runtime) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "terminal session registry poisoned".to_string())?;
            let current = sessions
                .get(&session_id)
                .ok_or_else(|| format!("terminal session not found: {session_id}"))?;
            let (project_path_key, runtime) =
                ssh_local_forward_session_entry(current, requested_project_key.as_deref(), true)?;
            if runtime.is_closing() {
                return Err("SSH session is closing".to_string());
            }

            let mut state = self
                .ssh_local_forwards
                .state
                .lock()
                .map_err(|_| "SSH local forward registry poisoned".to_string())?;
            let session_count = state
                .entries
                .values()
                .filter(|candidate| candidate.record.session_id == session_id)
                .count();
            if session_count >= SSH_LOCAL_FORWARD_MAX_PER_SESSION {
                return Err(format!(
                    "SSH local forward limit reached for this session ({SSH_LOCAL_FORWARD_MAX_PER_SESSION})"
                ));
            }

            let now = now_ms();
            let record = SshLocalForwardRecord {
                id: forward_id.clone(),
                session_id: session_id.clone(),
                project_path_key,
                local_host: SSH_LOCAL_FORWARD_HOST.to_string(),
                local_port,
                address: format!("{SSH_LOCAL_FORWARD_HOST}:{local_port}"),
                remote_host: remote_host.clone(),
                remote_port,
                status: "active".to_string(),
                created_at: now,
                updated_at: now,
                error: None,
            };
            let entry = Arc::new(SshLocalForwardEntry {
                record: record.clone(),
                cancel_tx,
                task: Mutex::new(None),
            });
            state.entries.insert(record.id.clone(), Arc::clone(&entry));
            state.revision = state.revision.saturating_add(1);
            (record, entry, state.revision, runtime)
        };

        let weak_registry = Arc::downgrade(self);
        let global_connections = Arc::clone(&self.ssh_local_forwards.global_connections);
        let forward_connections = Arc::new(Semaphore::new(SSH_LOCAL_FORWARD_MAX_CONNECTIONS));
        let task = tokio::spawn(run_ssh_local_forward_listener(
            weak_registry,
            forward_id.clone(),
            listener,
            runtime,
            remote_host,
            remote_port,
            cancel_rx,
            forward_connections,
            global_connections,
        ));
        if let Ok(mut slot) = entry.task.lock() {
            *slot = Some(task);
        }

        // close()/stop() may have cancelled this entry while the listener was
        // being spawned. Re-check under the registry lock before advertising
        // the forward so a concurrent cleanup cannot be followed by a stale
        // "started" event for an already-removed entry.
        {
            let registered = self
                .ssh_local_forwards
                .state
                .lock()
                .map(|state| state.entries.contains_key(&forward_id))
                .unwrap_or(false);
            if *entry.cancel_tx.borrow() || !registered {
                if let Ok(mut slot) = entry.task.lock() {
                    if let Some(task) = slot.take() {
                        task.abort();
                    }
                }
                let _ = self
                    .ssh_local_forwards
                    .state
                    .lock()
                    .ok()
                    .and_then(|mut state| state.entries.remove(&forward_id));
                return Err("SSH session is closing".to_string());
            }
        }

        self.emit_ssh_local_forward("started", record.clone(), revision);
        Ok(SshLocalForwardActionResponse {
            forward: record,
            revision,
        })
    }

    pub async fn ssh_local_forward_stop(
        &self,
        forward_id: String,
        session_id: Option<String>,
    ) -> Result<SshLocalForwardActionResponse, String> {
        let forward_id = forward_id.trim().to_string();
        if forward_id.is_empty() {
            return Err("forward_id is required".to_string());
        }
        let session_id = session_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let (entry, record, revision) = {
            let mut state = self
                .ssh_local_forwards
                .state
                .lock()
                .map_err(|_| "SSH local forward registry poisoned".to_string())?;
            let entry = state
                .entries
                .get(&forward_id)
                .cloned()
                .ok_or_else(|| format!("SSH local forward not found: {forward_id}"))?;
            if session_id
                .as_ref()
                .is_some_and(|wanted| entry.record.session_id != *wanted)
            {
                return Err(
                    "SSH local forward does not belong to the requested session".to_string()
                );
            }
            state.entries.remove(&forward_id);
            state.revision = state.revision.saturating_add(1);
            let mut record = entry.record.clone();
            record.status = "stopped".to_string();
            record.updated_at = now_ms();
            (entry, record, state.revision)
        };

        let _ = entry.cancel_tx.send(true);
        let task = entry.task.lock().ok().and_then(|mut slot| slot.take());
        if let Some(mut task) = task {
            // Wait for a cooperative exit first so the TcpListener is dropped
            // before the stop RPC returns; only then abort and await the abort.
            if timeout(SSH_LOCAL_FORWARD_STOP_TIMEOUT, &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = timeout(SSH_LOCAL_FORWARD_STOP_TIMEOUT, task).await;
            }
        }
        self.emit_ssh_local_forward("stopped", record.clone(), revision);
        Ok(SshLocalForwardActionResponse {
            forward: record,
            revision,
        })
    }

    pub(crate) fn stop_ssh_local_forwards_for_session(&self, session_id: &str, emit: bool) {
        let stopped = {
            let Ok(mut state) = self.ssh_local_forwards.state.lock() else {
                return;
            };
            let ids = state
                .entries
                .iter()
                .filter(|(_, entry)| entry.record.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            let mut stopped = Vec::with_capacity(ids.len());
            for id in ids {
                let Some(entry) = state.entries.remove(&id) else {
                    continue;
                };
                state.revision = state.revision.saturating_add(1);
                let mut record = entry.record.clone();
                record.status = "stopped".to_string();
                record.updated_at = now_ms();
                stopped.push((entry, record, state.revision));
            }
            stopped
        };
        for (entry, record, revision) in stopped {
            cancel_forward_task(&entry, true);
            if emit {
                self.emit_ssh_local_forward("stopped", record, revision);
            }
        }
    }

    pub fn shutdown_cleanup(&self) {
        self.ssh_local_forwards.cancel_all();
    }

    #[cfg(test)]
    pub(crate) fn insert_test_ssh_local_forward(
        &self,
        record: SshLocalForwardRecord,
    ) -> watch::Receiver<bool> {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let entry = Arc::new(SshLocalForwardEntry {
            record: record.clone(),
            cancel_tx,
            task: Mutex::new(None),
        });
        self.ssh_local_forwards
            .state
            .lock()
            .expect("SSH local forward registry poisoned")
            .entries
            .insert(record.id, entry);
        cancel_rx
    }

    fn ssh_local_forward_session(
        &self,
        session_id: &str,
        project_path_key: Option<&str>,
        require_connected: bool,
    ) -> Result<(String, Arc<SshSessionRuntime>), String> {
        let entry = self.entry(session_id)?;
        ssh_local_forward_session_entry(&entry, project_path_key, require_connected)
    }

    fn emit_ssh_local_forward(&self, kind: &str, record: SshLocalForwardRecord, revision: u64) {
        let payload = SshLocalForwardEventPayload {
            kind: kind.to_string(),
            forward: record,
            revision,
        };
        // The desktop webview listens on the dedicated channel; gateway
        // subscribers get a terminal event so the WebUI shares the stream
        // without a second event pipeline.
        if let Ok(events) = self.events.lock() {
            if let Some(events) = events.as_ref() {
                events.emit(SSH_LOCAL_FORWARD_EVENT_NAME, payload.clone());
            }
        }
        let subscribers = self
            .subscribers
            .lock()
            .map(|subscribers| subscribers.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        if subscribers.is_empty() {
            return;
        }
        let event = TerminalEvent {
            payload: TerminalEventPayload {
                kind: "ssh_local_forward".to_string(),
                session_id: payload.forward.session_id.clone(),
                project_path_key: payload.forward.project_path_key.clone(),
                session: None,
                data: None,
                output_start_offset: None,
                output_end_offset: None,
                ssh_tabs: None,
                ssh_local_forward: Some(payload),
            },
        };
        for subscriber in subscribers {
            let _ = subscriber.send(event.clone());
        }
    }

    fn fail_ssh_local_forward(&self, forward_id: &str, error: String) {
        let failed = {
            let Ok(mut state) = self.ssh_local_forwards.state.lock() else {
                return;
            };
            let Some(entry) = state.entries.remove(forward_id) else {
                return;
            };
            state.revision = state.revision.saturating_add(1);
            let mut record = entry.record.clone();
            record.status = "failed".to_string();
            record.updated_at = now_ms();
            record.error = Some(error);
            (record, state.revision)
        };
        self.emit_ssh_local_forward("failed", failed.0, failed.1);
    }
}

pub(crate) fn normalize_ssh_local_forward_host(host: &str) -> Result<String, String> {
    let host = host.trim();
    let host = if host.is_empty() { "127.0.0.1" } else { host };
    if host.len() > SSH_LOCAL_FORWARD_MAX_HOST_BYTES {
        return Err(format!(
            "SSH local forward remote host must be at most {SSH_LOCAL_FORWARD_MAX_HOST_BYTES} bytes"
        ));
    }
    if host.chars().any(char::is_control) {
        return Err("SSH local forward remote host contains control characters".to_string());
    }
    Ok(host.to_string())
}

pub(crate) fn normalize_ssh_local_forward_remote_port(port: u32) -> Result<u16, String> {
    u16::try_from(port)
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| "SSH local forward remote port must be between 1 and 65535".to_string())
}

pub(crate) fn normalize_ssh_local_forward_local_port(port: Option<u32>) -> Result<u16, String> {
    u16::try_from(port.unwrap_or(0))
        .map_err(|_| "SSH local forward local port must be between 0 and 65535".to_string())
}

/// Test-binds the loopback port the user asked for. Advisory only: the
/// authoritative bind happens in `ssh_local_forward_start`, this exists so the
/// UI can show a localized "port in use" error before submitting.
pub(crate) async fn ssh_local_forward_local_port_available(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await.is_ok()
}

fn ssh_local_forward_session_entry(
    entry: &Arc<TerminalSessionEntry>,
    project_path_key: Option<&str>,
    require_connected: bool,
) -> Result<(String, Arc<SshSessionRuntime>), String> {
    let record = entry
        .record
        .lock()
        .map_err(|_| "terminal session lock poisoned".to_string())?
        .clone();
    let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
        return Err("terminal session is not an SSH connection".to_string());
    };
    if project_path_key
        .is_some_and(|wanted| !project_path_keys_equal(&record.project_path_key, wanted))
    {
        return Err("SSH session does not belong to the requested project".to_string());
    }
    if runtime.is_closing() {
        return Err("SSH session is closing".to_string());
    }
    if require_connected
        && (!record.running
            || record
                .ssh
                .as_ref()
                .is_none_or(|ssh| ssh.status != SSH_STATUS_CONNECTED))
    {
        return Err("SSH connection is not connected".to_string());
    }
    Ok((record.project_path_key, Arc::clone(runtime)))
}

fn cancel_forward_task(entry: &Arc<SshLocalForwardEntry>, abort: bool) {
    let _ = entry.cancel_tx.send(true);
    if abort {
        if let Ok(mut slot) = entry.task.lock() {
            if let Some(task) = slot.take() {
                task.abort();
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_ssh_local_forward_listener(
    registry: Weak<TerminalSessionRegistry>,
    forward_id: String,
    listener: TcpListener,
    runtime: Arc<SshSessionRuntime>,
    remote_host: String,
    remote_port: u16,
    mut cancel_rx: watch::Receiver<bool>,
    forward_connections: Arc<Semaphore>,
    global_connections: Arc<Semaphore>,
) {
    let mut connections = JoinSet::new();
    let listener_error = loop {
        tokio::select! {
            changed = cancel_rx.changed() => {
                if changed.is_err() || *cancel_rx.borrow() {
                    break None;
                }
            }
            accepted = listener.accept() => {
                let (stream, peer_addr) = match accepted {
                    Ok(value) => value,
                    Err(error) => break Some(format!("SSH local forward listener failed: {error}")),
                };
                let Ok(forward_permit) = Arc::clone(&forward_connections).try_acquire_owned() else {
                    drop(stream);
                    continue;
                };
                let Ok(global_permit) = Arc::clone(&global_connections).try_acquire_owned() else {
                    drop(stream);
                    drop(forward_permit);
                    continue;
                };
                let runtime = Arc::clone(&runtime);
                let remote_host = remote_host.clone();
                let connection_cancel_rx = cancel_rx.clone();
                connections.spawn(async move {
                    let _forward_permit = forward_permit;
                    let _global_permit = global_permit;
                    run_ssh_local_forward_connection(
                        stream,
                        peer_addr,
                        runtime,
                        remote_host,
                        remote_port,
                        connection_cancel_rx,
                    )
                    .await;
                });
            }
            completed = connections.join_next(), if !connections.is_empty() => {
                let _ = completed;
            }
        }
    };

    connections.abort_all();
    while connections.join_next().await.is_some() {}

    if let Some(error) = listener_error {
        if let Some(registry) = registry.upgrade() {
            registry.fail_ssh_local_forward(&forward_id, error);
        }
    }
}

async fn run_ssh_local_forward_connection(
    mut local_stream: TcpStream,
    peer_addr: std::net::SocketAddr,
    runtime: Arc<SshSessionRuntime>,
    remote_host: String,
    remote_port: u16,
    mut cancel_rx: watch::Receiver<bool>,
) {
    let _ = local_stream.set_nodelay(true);
    if *cancel_rx.borrow() || runtime.is_closing() {
        return;
    }

    // Clone the Arc handle so channel open does not hold the mutex for the full
    // dial timeout. Concurrent reconnect/latency/exec can still access the slot.
    let Some(handle) = runtime.current_handle().await else {
        return;
    };
    let channel = match timeout(
        SSH_LOCAL_FORWARD_CHANNEL_OPEN_TIMEOUT,
        handle.channel_open_direct_tcpip(
            remote_host,
            u32::from(remote_port),
            peer_addr.ip().to_string(),
            u32::from(peer_addr.port()),
        ),
    )
    .await
    {
        Ok(Ok(channel)) => channel,
        Ok(Err(_)) | Err(_) => return,
    };

    let mut ssh_stream = channel.into_stream();
    pump_ssh_local_forward_streams(&mut local_stream, &mut ssh_stream, &mut cancel_rx).await;
}

async fn pump_ssh_local_forward_streams<L, R>(
    local_stream: &mut L,
    remote_stream: &mut R,
    cancel_rx: &mut watch::Receiver<bool>,
) where
    L: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    R: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    tokio::select! {
        _ = copy_bidirectional(&mut *local_stream, &mut *remote_stream) => {}
        _ = cancel_rx.changed() => {}
    }
    let _ = local_stream.shutdown().await;
    let _ = remote_stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn ssh_local_forward_validates_host_and_ports() {
        assert_eq!(
            normalize_ssh_local_forward_host("  db.internal  ").unwrap(),
            "db.internal"
        );
        assert_eq!(normalize_ssh_local_forward_host("  ").unwrap(), "127.0.0.1");
        assert!(normalize_ssh_local_forward_host("db\ninternal").is_err());
        assert_eq!(normalize_ssh_local_forward_remote_port(1).unwrap(), 1);
        assert_eq!(
            normalize_ssh_local_forward_remote_port(65535).unwrap(),
            65535
        );
        assert!(normalize_ssh_local_forward_remote_port(0).is_err());
        assert!(normalize_ssh_local_forward_remote_port(65536).is_err());
        assert_eq!(normalize_ssh_local_forward_local_port(None).unwrap(), 0);
        assert_eq!(normalize_ssh_local_forward_local_port(Some(0)).unwrap(), 0);
        assert!(normalize_ssh_local_forward_local_port(Some(65536)).is_err());
    }

    #[test]
    fn ssh_local_forward_check_port_reports_occupied() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        runtime.block_on(async {
            // Hold a listener on an OS-assigned port; the check must see it.
            let holder = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .await
                .expect("bind holder");
            let port = holder.local_addr().expect("holder addr").port();
            assert!(!ssh_local_forward_local_port_available(port).await);
        });
    }

    #[test]
    fn ssh_local_forward_check_port_allows_auto() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        runtime.block_on(async {
            // Port 0 is the auto-assign sentinel: binding it always succeeds,
            // so the advisory check reports it as available.
            assert!(ssh_local_forward_local_port_available(0).await);
        });
    }

    #[test]
    fn ssh_local_forward_duplex_pump_copies_both_directions() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        runtime.block_on(async {
            let (mut local_client, mut local_forward) = tokio::io::duplex(64);
            let (mut remote_forward, mut remote_server) = tokio::io::duplex(64);
            let (_cancel_tx, mut cancel_rx) = watch::channel(false);
            let pump = tokio::spawn(async move {
                pump_ssh_local_forward_streams(
                    &mut local_forward,
                    &mut remote_forward,
                    &mut cancel_rx,
                )
                .await;
            });

            local_client.write_all(b"request").await.unwrap();
            let mut request = [0; 7];
            remote_server.read_exact(&mut request).await.unwrap();
            assert_eq!(&request, b"request");

            remote_server.write_all(b"reply").await.unwrap();
            let mut reply = [0; 5];
            local_client.read_exact(&mut reply).await.unwrap();
            assert_eq!(&reply, b"reply");

            drop(local_client);
            drop(remote_server);
            pump.await.unwrap();
        });
    }
}
