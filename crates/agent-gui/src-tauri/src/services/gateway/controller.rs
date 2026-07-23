use std::collections::HashMap;
use std::sync::{Arc, Mutex, Once};
use std::thread;

use serde_json::{json, Value};
use tauri::Emitter;
use tokio::sync::watch;

use crate::commands::git::GitCloneTaskRegistry;
use crate::commands::settings::{
    load_remote_settings, normalize_remote_settings_payload, open_db, RemoteSettingsPayload,
};
use crate::runtime::managed_process::ManagedProcessRegistry;
use crate::runtime::sftp::SftpSessionRegistry;
use crate::runtime::terminal::TerminalSessionRegistry;
use crate::services::automation::AutomationStore;
use crate::services::chat_run_ledger::{ChatRunLedger, ChatRunLedgerState};
use crate::services::memory::MemoryStore;
use crate::services::tunnel::{TunnelProxy, TunnelStore};
use crate::services::workspace_watch::WorkspaceWatchService;

use super::*;

impl GatewayController {
    pub fn new(
        app_handle: tauri::AppHandle,
        automation_store: Arc<AutomationStore>,
        memory_store: Arc<MemoryStore>,
        terminal_registry: Arc<TerminalSessionRegistry>,
        sftp_registry: Arc<SftpSessionRegistry>,
        managed_process_registry: Arc<ManagedProcessRegistry>,
        git_clone_task_registry: Arc<GitCloneTaskRegistry>,
    ) -> Self {
        let initial_config = RemoteSettingsPayload::default();
        let (config_tx, _) = watch::channel(initial_config);
        let tunnel_store = TunnelStore::new(app_handle.clone());
        let workspace_watch = Arc::new(WorkspaceWatchService::new(app_handle.clone()));
        Self {
            app_handle,
            automation_store,
            memory_store,
            terminal_registry,
            sftp_registry,
            managed_process_registry,
            git_clone_task_registry,
            config_tx,
            runner_task: Mutex::new(None),
            status: Mutex::new(GatewayStatusSnapshot {
                online: false,
                enabled: false,
                configured: false,
                gateway_url: String::new(),
                agent_id: String::new(),
                session_id: None,
                connected_since: None,
                last_heartbeat: None,
                last_error: None,
                protocol: None,
            }),
            outbound_tx: Mutex::new(None),
            outbound_control_tx: Mutex::new(None),
            terminal_stream_tx: Mutex::new(None),
            settings_snapshot: Mutex::new(None),
            remote_chat_inbox: Mutex::new(HashMap::new()),
            chat_run_ledger: Mutex::new(ChatRunLedger::new()),
            runtime_status_republish: Mutex::new(None),
            last_connection_nudge: Mutex::new(None),
            tunnel_store,
            tunnel_proxy: TunnelProxy::new(),
            workspace_watch,
            pending_chat_queue_requests: Mutex::new(HashMap::new()),
            terminal_forwarder_once: Once::new(),
            terminal_stream_forwarder_once: Once::new(),
            sftp_forwarder_once: Once::new(),
            remote_chat_inbox_sweeper_once: Once::new(),
            runtime_status_republisher_once: Once::new(),
            tunnel_store_once: Once::new(),
        }
    }

    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        self.workspace_watch.attach_gateway(Arc::downgrade(self));
        self.start_terminal_forwarder();
        self.start_terminal_stream_forwarder();
        self.start_sftp_forwarder();
        self.start_remote_chat_inbox_sweeper();
        self.start_runtime_status_republisher();
        self.start_tunnel_store();
        self.ensure_runner()
    }

    pub(crate) fn start_terminal_forwarder(self: &Arc<Self>) {
        let controller = Arc::clone(self);
        self.terminal_forwarder_once.call_once(move || {
            let (receiver, guard) = controller.terminal_registry.subscribe();
            thread::spawn(move || {
                let _guard = guard;
                while let Ok(event) = receiver.recv() {
                    let envelope = build_terminal_event_envelope(event.payload);
                    let Ok(sender) = controller.current_outbound_sender() else {
                        continue;
                    };
                    if let Err(error) = sender.blocking_send(envelope) {
                        eprintln!("send gateway terminal event failed: {error}");
                    }
                }
            });
        });
    }

    pub(crate) fn start_terminal_stream_forwarder(self: &Arc<Self>) {
        let controller = Arc::clone(self);
        self.terminal_stream_forwarder_once.call_once(move || {
            let (receiver, guard) = controller.terminal_registry.subscribe_stream();
            thread::spawn(move || {
                let _guard = guard;
                while let Ok(event) = receiver.recv() {
                    let frame = build_terminal_stream_output_frame(event.payload);
                    let Ok(sender) = controller.current_terminal_stream_sender() else {
                        continue;
                    };
                    if let Err(error) = sender.blocking_send(frame) {
                        eprintln!("send gateway terminal stream frame failed: {error}");
                    }
                }
            });
        });
    }

    pub(crate) fn start_sftp_forwarder(self: &Arc<Self>) {
        let controller = Arc::clone(self);
        self.sftp_forwarder_once.call_once(move || {
            let (receiver, guard) = controller.sftp_registry.subscribe();
            thread::spawn(move || {
                let _guard = guard;
                while let Ok(event) = receiver.recv() {
                    let envelope = build_sftp_event_envelope(event.payload);
                    let Ok(sender) = controller.current_outbound_sender() else {
                        continue;
                    };
                    if let Err(error) = sender.blocking_send(envelope) {
                        eprintln!("send gateway SFTP event failed: {error}");
                    }
                }
            });
        });
    }

    pub(crate) fn start_remote_chat_inbox_sweeper(self: &Arc<Self>) {
        let controller = Arc::clone(self);
        self.remote_chat_inbox_sweeper_once.call_once(move || {
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(GATEWAY_CHAT_LEASE_SWEEP_INTERVAL).await;
                    if let Err(error) = controller.expire_remote_chat_leases().await {
                        eprintln!("expire gateway remote chat leases failed: {error}");
                    }
                    if let Err(error) = controller.flush_unsent_chat_run_terminals().await {
                        eprintln!("flush gateway chat run terminals failed: {error}");
                    }
                }
            });
        });
    }

    // Echoes the webview's last runtime status so the gateway's 15s
    // chat-runtime TTL stays satisfied while the desktop window is hidden or
    // occluded and the webview's own 2s heartbeat interval is throttled.
    pub(crate) fn start_runtime_status_republisher(self: &Arc<Self>) {
        let controller = Arc::clone(self);
        self.runtime_status_republisher_once.call_once(move || {
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(GATEWAY_RUNTIME_STATUS_REPUBLISH_INTERVAL).await;
                    let Some((worker_id, state, visible, active_run_count)) =
                        controller.runtime_status_republish_snapshot()
                    else {
                        continue;
                    };
                    if let Err(error) = controller
                        .send_chat_runtime_status_envelope(
                            worker_id,
                            state,
                            visible,
                            active_run_count,
                        )
                        .await
                    {
                        eprintln!("republish gateway chat runtime status failed: {error}");
                    }
                }
            });
        });
    }

    pub(crate) fn spawn_runner(
        self: &Arc<Self>,
        runner_task: &mut Option<tauri::async_runtime::JoinHandle<()>>,
    ) {
        let receiver = self.config_tx.subscribe();
        let controller = Arc::clone(self);
        *runner_task = Some(tauri::async_runtime::spawn(async move {
            controller.run(receiver).await;
        }));
    }

    pub(crate) fn ensure_runner(self: &Arc<Self>) -> Result<(), String> {
        let mut runner_task = self
            .runner_task
            .lock()
            .map_err(|_| "gateway runner task lock poisoned".to_string())?;
        let should_spawn = runner_task
            .as_ref()
            .map(|task| task.inner().is_finished())
            .unwrap_or(true);
        if !should_spawn {
            return Ok(());
        }

        self.spawn_runner(&mut runner_task);
        Ok(())
    }

    pub(crate) fn restart_runner(self: &Arc<Self>) -> Result<(), String> {
        self.set_outbound_sender(None);
        self.set_outbound_control_sender(None);
        self.set_terminal_stream_sender(None);
        let mut runner_task = self
            .runner_task
            .lock()
            .map_err(|_| "gateway runner task lock poisoned".to_string())?;
        if let Some(task) = runner_task.take() {
            task.abort();
        }
        self.spawn_runner(&mut runner_task);
        Ok(())
    }

    pub fn wake_chat_runtime(&self, reason: &str) -> Result<(), String> {
        self.app_handle
            .emit(
                GATEWAY_CHAT_RUNTIME_WAKE_EVENT,
                json!({ "reason": reason.trim() }),
            )
            .map_err(|error| format!("emit gateway chat runtime wake failed: {error}"))
    }

    pub fn nudge_connection(
        self: &Arc<Self>,
        reason: &str,
        force_reconnect: bool,
    ) -> Result<bool, String> {
        let config = self.config_tx.borrow().clone();
        if !config.enabled || !is_remote_configured(&config) {
            return Ok(false);
        }

        if let Err(error) = self.wake_chat_runtime(reason) {
            eprintln!("wake gateway chat runtime during connection nudge failed: {error}");
        }

        let status = self.status();
        if !force_reconnect
            && !gateway_connection_needs_restart(&status, &config, now_unix_seconds())
        {
            return Ok(false);
        }

        let now = Instant::now();
        {
            let mut last_nudge = self
                .last_connection_nudge
                .lock()
                .map_err(|_| "gateway connection nudge lock poisoned".to_string())?;
            if last_nudge
                .map(|previous| {
                    now.saturating_duration_since(previous) < GATEWAY_CONNECTION_NUDGE_COOLDOWN
                })
                .unwrap_or(false)
            {
                return Ok(false);
            }
            *last_nudge = Some(now);
        }

        self.restart_runner()?;
        Ok(true)
    }

    pub async fn reload_from_db(self: &Arc<Self>) -> Result<(), String> {
        let config = tauri::async_runtime::spawn_blocking(move || {
            let conn = open_db()?;
            load_remote_settings(&conn)
        })
        .await
        .map_err(|e| format!("reload remote settings join failed: {e}"))??;
        self.apply_config(config)
    }

    pub fn apply_config(self: &Arc<Self>, config: RemoteSettingsPayload) -> Result<(), String> {
        let normalized = normalize_remote_settings_payload(config);
        let previous = self.config_tx.borrow().clone();
        let config_changed = previous != normalized;
        let should_run_remote = normalized.enabled && is_remote_configured(&normalized);
        self.config_tx.send_replace(normalized.clone());
        self.publish_status(|status| {
            status.enabled = normalized.enabled;
            status.configured = is_remote_configured(&normalized);
            status.gateway_url = normalized.gateway_url.clone();
            status.agent_id = normalized.agent_id.clone();
            if !normalized.enabled {
                set_disconnected_status(status, &normalized, None);
            } else if config_changed {
                set_disconnected_status(status, &normalized, None);
            }
        });
        if should_run_remote {
            self.restart_runner()?;
        } else {
            self.ensure_runner()?;
        }
        Ok(())
    }

    pub fn disconnect_runtime(self: &Arc<Self>) -> Result<(), String> {
        let mut config = self.config_tx.borrow().clone();
        config.enabled = false;
        self.apply_config(config)
    }

    pub fn status(&self) -> GatewayStatusSnapshot {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or(GatewayStatusSnapshot {
                online: false,
                enabled: false,
                configured: false,
                gateway_url: String::new(),
                agent_id: String::new(),
                session_id: None,
                connected_since: None,
                last_heartbeat: None,
                last_error: Some("gateway status lock poisoned".to_string()),
                protocol: None,
            })
    }

    pub async fn send_chat_event(
        &self,
        request_id: String,
        event: Value,
        worker_id: Option<String>,
    ) -> Result<(), String> {
        // Terminal events must bypass the lease-freshness check: an expired but
        // still-owned lease may no longer be "current", yet dropping the run's
        // done/error signal here would leave the WebUI streaming forever.
        let is_terminal = chat_event_is_terminal(&event);
        if !self.renew_remote_chat_request_lease(&request_id, worker_id.as_deref(), !is_terminal)? {
            return Ok(());
        }
        let conversation_id = chat_event_conversation_id(&event);
        if is_terminal {
            let state = if chat_event_type(&event) == Some("done") {
                ChatRunLedgerState::Completed
            } else {
                ChatRunLedgerState::Failed
            };
            // Carry the error text into the ledger so a retransmitted terminal
            // control event still surfaces it after the original send failed.
            let message = event
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            // Record the terminal before attempting the send so a failed send
            // is retransmitted by the ledger flush loop.
            self.ledger_mark_run_terminal(&request_id, &conversation_id, state, "", message)?;
        } else {
            self.ledger_touch_run(&request_id, &conversation_id)?;
        }
        let envelope = build_chat_event_envelope(request_id.clone(), event)?;
        let result = self.send_agent_envelope(envelope).await;
        if is_terminal && result.is_ok() {
            self.ledger_mark_run_terminal_sent(&request_id)?;
        }
        result
    }

    pub async fn publish_history_sync(&self, event: GatewayHistorySyncEvent) {
        if let Err(error) = self.app_handle.emit(CHAT_HISTORY_SYNC_EVENT, event.clone()) {
            eprintln!("emit chat history sync failed: {error}");
        }

        if !self.status().online {
            return;
        }

        let envelope = match build_history_sync_envelope(event) {
            Ok(envelope) => envelope,
            Err(error) => {
                eprintln!("build gateway history sync envelope failed: {error}");
                return;
            }
        };

        if let Err(error) = self.send_agent_envelope(envelope).await {
            eprintln!("send gateway history sync event failed: {error}");
        }
    }

    pub async fn publish_chat_runtime_snapshot(
        &self,
        snapshot: GatewayChatRuntimeSnapshot,
    ) -> Result<(), String> {
        let run_id = snapshot.run_id.trim().to_string();
        let conversation_id = snapshot.conversation_id.trim().to_string();
        let terminal_state = match snapshot.state.trim() {
            "completed" => Some(ChatRunLedgerState::Completed),
            "failed" => Some(ChatRunLedgerState::Failed),
            "cancelled" => Some(ChatRunLedgerState::Cancelled),
            _ => None,
        };
        if !run_id.is_empty() {
            match terminal_state {
                Some(state) => {
                    self.ledger_mark_run_terminal(&run_id, &conversation_id, state, "", "")?;
                }
                None if snapshot.state.trim() == "running" => {
                    self.ledger_touch_run(&run_id, &conversation_id)?;
                }
                None => {}
            }
        }
        let envelope = build_chat_runtime_snapshot_envelope(snapshot)?;
        let result = self.send_agent_envelope(envelope).await;
        if terminal_state.is_some() && !run_id.is_empty() && result.is_ok() {
            self.ledger_mark_run_terminal_sent(&run_id)?;
        }
        result
    }

    pub async fn publish_settings_sync(&self, payload: Value) -> Result<(), String> {
        let snapshot = self.store_settings_snapshot(payload)?;

        if !self.status().online {
            return Ok(());
        }

        let envelope = build_settings_sync_envelope(snapshot)?;
        self.send_agent_envelope(envelope).await
    }
}
