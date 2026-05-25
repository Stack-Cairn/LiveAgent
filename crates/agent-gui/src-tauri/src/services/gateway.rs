use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::Url;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::sync::{mpsc, watch};
use tokio_stream::wrappers::ReceiverStream;
use tonic::metadata::MetadataValue;
use tonic::transport::{ClientTlsConfig, Endpoint};
use uuid::Uuid;

use crate::commands::chat_history::{self, ChatHistorySummary};
use crate::commands::settings::{
    load_gateway_settings_sync_snapshot, load_remote_settings, normalize_remote_settings_payload,
    open_db, redact_gateway_settings_sync_payload, RemoteSettingsPayload,
    PROVIDER_API_KEY_UPDATES_FIELD,
};
use crate::services::cron::CronManager;
use crate::services::gateway_bridge;
use crate::services::memory::MemoryStore;

pub mod proto {
    tonic::include_proto!("liveagent.gateway.v1");
}

const UI_ONLY_SETTINGS_SYNC_FIELDS: &[&str] = &[
    "skills",
    "chatRuntimeControls",
    "selectedModel",
    "theme",
    "locale",
];
const GATEWAY_GRPC_MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatusSnapshot {
    pub online: bool,
    pub enabled: bool,
    pub configured: bool,
    pub gateway_url: String,
    pub agent_id: String,
    pub session_id: Option<String>,
    pub connected_since: Option<i64>,
    pub last_heartbeat: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewaySelectedModelEvent {
    custom_provider_id: String,
    model: String,
    provider_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayChatRuntimeControlsEvent {
    thinking_enabled: bool,
    native_web_search_enabled: bool,
    reasoning: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayUploadedFileEvent {
    relative_path: String,
    absolute_path: String,
    file_name: String,
    kind: String,
    size_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayChatRequestEvent {
    request_id: String,
    conversation_id: String,
    client_request_id: String,
    message: String,
    force_hydrate: bool,
    selected_model: Option<GatewaySelectedModelEvent>,
    runtime_controls: Option<GatewayChatRuntimeControlsEvent>,
    execution_mode: String,
    workdir: String,
    selected_system_tools: Vec<String>,
    uploaded_files: Vec<GatewayUploadedFileEvent>,
    history_truncation_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayChatCancelEvent {
    request_id: String,
    conversation_id: String,
}

pub const CHAT_HISTORY_SYNC_EVENT: &str = "chat-history:changed";
pub const CHAT_HISTORY_TRUNCATED_EVENT: &str = "chat-history:truncated";
pub const GATEWAY_SETTINGS_SYNC_EVENT: &str = "gateway:settings-sync";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHistoryTruncatedEvent {
    pub conversation_id: String,
    pub segment_index: i64,
    pub message_index: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHistorySyncConversation {
    pub id: String,
    pub title: String,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
    pub is_pinned: bool,
    pub pinned_at: Option<i64>,
    pub is_shared: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHistorySyncEvent {
    pub kind: String,
    pub conversation_id: String,
    pub conversation: Option<GatewayHistorySyncConversation>,
}

pub struct GatewayController {
    app_handle: tauri::AppHandle,
    cron_manager: Arc<CronManager>,
    memory_store: Arc<MemoryStore>,
    config_tx: watch::Sender<RemoteSettingsPayload>,
    runner_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    status: Mutex<GatewayStatusSnapshot>,
    outbound_tx: Mutex<Option<mpsc::Sender<proto::AgentEnvelope>>>,
    settings_snapshot: Mutex<Option<Value>>,
    pending_history_truncations: Mutex<HashMap<String, String>>,
}

impl GatewayController {
    pub fn new(
        app_handle: tauri::AppHandle,
        cron_manager: Arc<CronManager>,
        memory_store: Arc<MemoryStore>,
    ) -> Self {
        let initial_config = RemoteSettingsPayload::default();
        let (config_tx, _) = watch::channel(initial_config);
        Self {
            app_handle,
            cron_manager,
            memory_store,
            config_tx,
            runner_task: Mutex::new(None),
            status: Mutex::new(GatewayStatusSnapshot {
                online: false,
                enabled: false,
                configured: false,
                gateway_url: String::new(),
                agent_id: fallback_agent_id(),
                session_id: None,
                connected_since: None,
                last_heartbeat: None,
                last_error: None,
            }),
            outbound_tx: Mutex::new(None),
            settings_snapshot: Mutex::new(None),
            pending_history_truncations: Mutex::new(HashMap::new()),
        }
    }

    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        self.ensure_runner()
    }

    fn spawn_runner(
        self: &Arc<Self>,
        runner_task: &mut Option<tauri::async_runtime::JoinHandle<()>>,
    ) {
        let receiver = self.config_tx.subscribe();
        let controller = Arc::clone(self);
        *runner_task = Some(tauri::async_runtime::spawn(async move {
            controller.run(receiver).await;
        }));
    }

    fn ensure_runner(self: &Arc<Self>) -> Result<(), String> {
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

    fn restart_runner(self: &Arc<Self>) -> Result<(), String> {
        self.set_outbound_sender(None);
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
            status.agent_id = effective_agent_id(&normalized);
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
                agent_id: fallback_agent_id(),
                session_id: None,
                connected_since: None,
                last_heartbeat: None,
                last_error: Some("gateway status lock poisoned".to_string()),
            })
    }

    pub async fn send_chat_event(&self, request_id: String, event: Value) -> Result<(), String> {
        let envelope = build_chat_event_envelope(request_id, event)?;
        self.send_agent_envelope(envelope).await
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

    pub async fn publish_settings_sync(&self, payload: Value) -> Result<(), String> {
        let snapshot = self.store_settings_snapshot(payload)?;

        if !self.status().online {
            return Ok(());
        }

        let envelope = build_settings_sync_envelope(snapshot)?;
        self.send_agent_envelope(envelope).await
    }

    async fn run(self: Arc<Self>, mut config_rx: watch::Receiver<RemoteSettingsPayload>) {
        loop {
            let config = config_rx.borrow().clone();
            if !config.enabled || !is_remote_configured(&config) {
                self.set_outbound_sender(None);
                self.publish_status(|status| {
                    set_disconnected_status(status, &config, None);
                });
                if config_rx.changed().await.is_err() {
                    break;
                }
                continue;
            }

            let current_config = config.clone();
            let connect_result = self
                .connect_and_serve(current_config.clone(), &mut config_rx)
                .await;
            let latest_config = config_rx.borrow().clone();
            let reconfigured = latest_config != current_config;

            self.set_outbound_sender(None);
            if reconfigured {
                self.publish_status(|status| {
                    set_disconnected_status(status, &latest_config, None);
                });
                continue;
            }

            self.publish_status(|status| match connect_result.as_ref() {
                Ok(()) => set_disconnected_status(status, &current_config, None),
                Err(error) => set_disconnected_status(status, &current_config, Some(error.clone())),
            });

            if config_rx.has_changed().unwrap_or(false) {
                continue;
            }

            if !current_config.auto_reconnect {
                if config_rx.changed().await.is_err() {
                    break;
                }
                continue;
            }

            tokio::select! {
                changed = config_rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                }
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            }
        }
    }

    async fn connect_and_serve(
        &self,
        config: RemoteSettingsPayload,
        config_rx: &mut watch::Receiver<RemoteSettingsPayload>,
    ) -> Result<(), String> {
        let grpc_url = build_grpc_url(&config)?;
        let endpoint = build_endpoint(&grpc_url)?;
        let channel = endpoint.connect_lazy();

        let mut client = proto::agent_gateway_client::AgentGatewayClient::new(channel)
            .max_decoding_message_size(GATEWAY_GRPC_MAX_MESSAGE_BYTES)
            .max_encoding_message_size(GATEWAY_GRPC_MAX_MESSAGE_BYTES);
        let mut auth_request = tonic::Request::new(proto::AuthRequest {
            token: config.token.clone(),
            agent_id: effective_agent_id(&config),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
        });
        insert_bearer_metadata(auth_request.metadata_mut(), &config.token)?;

        let auth_call = client.authenticate(auth_request);
        let auth_response = match await_abortable_on_reconfigure(&config, config_rx, async move {
            tokio::time::timeout(Duration::from_secs(10), auth_call)
                .await
                .map_err(|_| "gateway authenticate timed out".to_string())?
                .map_err(|e| format!("gateway authenticate failed: {e}"))
                .map(|response| response.into_inner())
        })
        .await?
        {
            Some(response) => response,
            None => return Ok(()),
        };
        if !auth_response.success {
            return Err(if auth_response.message.trim().is_empty() {
                "gateway authentication failed".to_string()
            } else {
                auth_response.message
            });
        }

        let (outbound_tx, outbound_rx) = mpsc::channel::<proto::AgentEnvelope>(256);
        self.set_outbound_sender(Some(outbound_tx));

        let mut connect_request = tonic::Request::new(ReceiverStream::new(outbound_rx));
        insert_bearer_metadata(connect_request.metadata_mut(), &config.token)?;

        let connect_call = client.agent_connect(connect_request);
        let response = match await_abortable_on_reconfigure(&config, config_rx, async move {
            tokio::time::timeout(Duration::from_secs(10), connect_call)
                .await
                .map_err(|_| "open gateway stream timed out".to_string())?
                .map_err(|e| format!("open gateway stream failed: {e}"))
        })
        .await?
        {
            Some(response) => response,
            None => return Ok(()),
        };
        let mut inbound = response.into_inner();

        let connected_at = now_unix_seconds();
        self.publish_status(|status| {
            status.online = true;
            status.enabled = true;
            status.configured = true;
            status.gateway_url = config.gateway_url.clone();
            status.agent_id = effective_agent_id(&config);
            status.session_id = Some(auth_response.session_id.clone());
            status.connected_since = Some(connected_at);
            status.last_heartbeat = Some(connected_at);
            status.last_error = None;
        });

        if let Err(error) = self.publish_current_settings_sync().await {
            eprintln!("publish gateway settings sync failed: {error}");
        }

        let timeout_seconds = i64::try_from(config.heartbeat_interval.max(5)).unwrap_or(30) * 3;

        loop {
            tokio::select! {
                changed = config_rx.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    let next = config_rx.borrow().clone();
                    if next != config {
                        return Ok(());
                    }
                }
                message = tokio::time::timeout(
                    Duration::from_secs(u64::try_from(timeout_seconds.max(5)).unwrap_or(15)),
                    inbound.message(),
                ) => {
                    match message {
                        Err(_) => return Err("gateway heartbeat timed out".to_string()),
                        Ok(Err(err)) => return Err(format!("gateway stream receive failed: {err}")),
                        Ok(Ok(None)) => return Err("gateway stream closed".to_string()),
                        Ok(Ok(Some(envelope))) => {
                            self.touch_heartbeat();
                            self.handle_gateway_envelope(envelope).await?;
                        }
                    }
                }
            }
        }
    }

    async fn handle_gateway_envelope(
        &self,
        envelope: proto::GatewayEnvelope,
    ) -> Result<(), String> {
        let request_id = envelope.request_id.clone();

        match envelope.payload {
            Some(proto::gateway_envelope::Payload::Ping(ping)) => {
                self.send_agent_envelope(proto::AgentEnvelope {
                    request_id,
                    timestamp: now_unix_seconds(),
                    payload: Some(proto::agent_envelope::Payload::Pong(proto::PongResponse {
                        timestamp: ping.timestamp,
                    })),
                })
                .await
            }
            Some(proto::gateway_envelope::Payload::ChatRequest(request)) => {
                let proto::ChatRequest {
                    conversation_id,
                    client_request_id,
                    message,
                    selected_model,
                    runtime_controls,
                    execution_mode,
                    workdir,
                    selected_system_tools,
                    uploaded_files,
                } = request;
                let history_truncation_key = if conversation_id.trim().is_empty() {
                    None
                } else {
                    self.pending_history_truncations
                        .lock()
                        .ok()
                        .and_then(|mut pending| pending.remove(conversation_id.trim()))
                };
                let force_hydrate = history_truncation_key.is_some();
                let selected_model =
                    selected_model.map(|selected_model| GatewaySelectedModelEvent {
                        custom_provider_id: selected_model.custom_provider_id,
                        model: selected_model.model,
                        provider_type: selected_model.provider_type,
                    });
                let runtime_controls =
                    runtime_controls.map(|runtime_controls| GatewayChatRuntimeControlsEvent {
                        thinking_enabled: runtime_controls.thinking_enabled,
                        native_web_search_enabled: runtime_controls.native_web_search_enabled,
                        reasoning: runtime_controls.reasoning,
                    });
                self.app_handle
                    .emit(
                        "gateway:chat-request",
                        GatewayChatRequestEvent {
                            request_id,
                            conversation_id,
                            client_request_id,
                            message,
                            force_hydrate,
                            selected_model,
                            runtime_controls,
                            execution_mode,
                            workdir,
                            selected_system_tools,
                            uploaded_files: uploaded_files
                                .into_iter()
                                .map(|file| GatewayUploadedFileEvent {
                                    relative_path: file.relative_path,
                                    absolute_path: file.absolute_path,
                                    file_name: file.file_name,
                                    kind: file.kind,
                                    size_bytes: file.size_bytes,
                                })
                                .collect(),
                            history_truncation_key,
                        },
                    )
                    .map_err(|e| format!("emit gateway chat request failed: {e}"))
            }
            Some(proto::gateway_envelope::Payload::CancelChat(request)) => self
                .app_handle
                .emit(
                    "gateway:chat-cancel",
                    GatewayChatCancelEvent {
                        request_id,
                        conversation_id: request.conversation_id,
                    },
                )
                .map_err(|e| format!("emit gateway chat cancel failed: {e}")),
            Some(proto::gateway_envelope::Payload::CronManage(request)) => {
                let should_refresh_settings =
                    matches!(request.action.trim(), "create" | "update" | "delete");
                match gateway_bridge::handle_cron_manage(Arc::clone(&self.cron_manager), request)
                    .await
                {
                    Ok(response) => {
                        let send_result = self
                            .send_agent_envelope(proto::AgentEnvelope {
                                request_id,
                                timestamp: now_unix_seconds(),
                                payload: Some(proto::agent_envelope::Payload::CronManageResp(
                                    response,
                                )),
                            })
                            .await;
                        if send_result.is_ok() && should_refresh_settings {
                            if let Err(error) = self.refresh_settings_sync_from_db().await {
                                eprintln!("refresh gateway settings sync after cron manage failed: {error}");
                            }
                        }
                        send_result
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::HistoryList(request)) => {
                match gateway_bridge::handle_history_list(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::HistoryListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::HistoryGet(request)) => {
                match gateway_bridge::handle_history_get(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::HistoryGetResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::HistoryRename(request)) => {
                match gateway_bridge::handle_history_rename(request).await {
                    Ok(response) => {
                        if let Some(conversation) = response.conversation.as_ref() {
                            self.publish_history_sync(build_history_sync_upsert_from_proto(
                                conversation,
                            ))
                            .await;
                        }
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::HistoryRenameResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::HistoryPin(request)) => {
                match gateway_bridge::handle_history_pin(request).await {
                    Ok(response) => {
                        if let Some(conversation) = response.conversation.as_ref() {
                            self.publish_history_sync(build_history_sync_upsert_from_proto(
                                conversation,
                            ))
                            .await;
                        }
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::HistoryPinResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::HistoryShareGet(request)) => {
                match gateway_bridge::handle_history_share_get(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::HistoryShareGetResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::HistoryShareSet(request)) => {
                match gateway_bridge::handle_history_share_set(request).await {
                    Ok(response) => {
                        if let Some(share) = response.share.as_ref() {
                            match chat_history::chat_history_get_summary_inner(
                                share.conversation_id.clone(),
                            )
                            .await
                            {
                                Ok(summary) => {
                                    self.publish_history_sync(build_history_sync_upsert(&summary))
                                        .await;
                                }
                                Err(error) => {
                                    eprintln!("publish history share sync event failed: {error}")
                                }
                            }
                        }
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::HistoryShareSetResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::HistoryShareResolve(request)) => {
                match gateway_bridge::handle_history_share_resolve(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::HistoryShareResolveResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::HistoryDelete(request)) => {
                let deleted_conversation_id = request.conversation_id.trim().to_string();
                match gateway_bridge::handle_history_delete(request).await {
                    Ok(response) => {
                        self.publish_history_sync(build_history_sync_delete(
                            deleted_conversation_id,
                        ))
                        .await;
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::HistoryDeleteResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::HistoryTruncate(request)) => {
                let truncate_conversation_id = request.conversation_id.trim().to_string();
                let truncate_segment_index = request.segment_index;
                let truncate_message_index = request.message_index;
                match gateway_bridge::handle_history_truncate(request).await {
                    Ok(response) => {
                        if !truncate_conversation_id.is_empty() {
                            if let Ok(mut pending) = self.pending_history_truncations.lock() {
                                pending.insert(
                                    truncate_conversation_id.clone(),
                                    format!("{truncate_segment_index}:{truncate_message_index}"),
                                );
                            }
                            let _ = self.app_handle.emit(
                                CHAT_HISTORY_TRUNCATED_EVENT,
                                GatewayHistoryTruncatedEvent {
                                    conversation_id: truncate_conversation_id,
                                    segment_index: i64::from(truncate_segment_index),
                                    message_index: i64::from(truncate_message_index),
                                },
                            );
                        }
                        if let Some(conversation) = response.conversation.as_ref() {
                            self.publish_history_sync(build_history_sync_upsert_from_proto(
                                conversation,
                            ))
                            .await;
                        }
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::HistoryTruncateResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::ProviderList(_request)) => {
                match gateway_bridge::handle_provider_list().await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::ProviderListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SettingsGet(_request)) => {
                match self.current_settings_snapshot().await {
                    Ok(snapshot) => {
                        let settings_json = match serialize_settings_sync_payload(&snapshot) {
                            Ok(settings_json) => settings_json,
                            Err(error) => {
                                return self.send_error_response(request_id, 500, error).await
                            }
                        };
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SettingsGetResp(
                                proto::SettingsGetResponse { settings_json },
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SettingsUpdate(request)) => {
                match parse_settings_sync_payload(&request.settings_json) {
                    Ok(snapshot) => {
                        let event_payload =
                            match build_local_settings_update_event_payload(snapshot.clone()) {
                                Ok(payload) => payload,
                                Err(error) => {
                                    return self.send_error_response(request_id, 400, error).await
                                }
                            };
                        let public_snapshot = match redact_gateway_settings_sync_payload(snapshot) {
                            Ok(payload) => payload,
                            Err(error) => {
                                return self.send_error_response(request_id, 400, error).await
                            }
                        };
                        if let Err(error) = self.store_settings_snapshot(public_snapshot) {
                            return self.send_error_response(request_id, 500, error).await;
                        }
                        match self
                            .app_handle
                            .emit(GATEWAY_SETTINGS_SYNC_EVENT, event_payload)
                        {
                            Ok(()) => {
                                self.send_agent_envelope(proto::AgentEnvelope {
                                    request_id,
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::SettingsUpdateResp(
                                            proto::SettingsUpdateResponse {
                                                accepted: true,
                                                message: "ok".to_string(),
                                            },
                                        ),
                                    ),
                                })
                                .await
                            }
                            Err(error) => {
                                self.send_error_response(
                                    request_id,
                                    500,
                                    format!("emit gateway settings sync failed: {error}"),
                                )
                                .await
                            }
                        }
                    }
                    Err(error) => self.send_error_response(request_id, 400, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsRoots(_request)) => {
                match gateway_bridge::handle_fs_roots().await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsRootsResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsListDirs(request)) => {
                match gateway_bridge::handle_fs_list_dirs(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsListDirsResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillFilesList(_request)) => {
                match gateway_bridge::handle_skill_files_list().await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillFilesListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FileMentionList(request)) => {
                match gateway_bridge::handle_file_mention_list(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FileMentionListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::UploadReadableFiles(request)) => {
                match gateway_bridge::handle_upload_readable_files(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::UploadReadableFilesResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::UploadedImagePreview(request)) => {
                match gateway_bridge::handle_uploaded_image_preview(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(
                                proto::agent_envelope::Payload::UploadedImagePreviewResp(response),
                            ),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::MemoryManage(request)) => {
                match gateway_bridge::handle_memory_manage(Arc::clone(&self.memory_store), request)
                    .await
                {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::MemoryManageResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillMetadataRead(request)) => {
                match gateway_bridge::handle_skill_metadata_read(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillMetadataReadResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillTextRead(request)) => {
                match gateway_bridge::handle_skill_text_read(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillTextReadResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillManage(request)) => {
                match gateway_bridge::handle_skill_manage(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillManageResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            None => Ok(()),
        }
    }

    async fn send_agent_envelope(&self, envelope: proto::AgentEnvelope) -> Result<(), String> {
        let sender = self
            .outbound_tx
            .lock()
            .map_err(|_| "gateway outbound sender lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "gateway outbound stream is offline".to_string())?;
        sender
            .send(envelope)
            .await
            .map_err(|_| "gateway outbound stream closed".to_string())
    }

    async fn send_error_response(
        &self,
        request_id: String,
        code: i32,
        message: String,
    ) -> Result<(), String> {
        self.send_agent_envelope(proto::AgentEnvelope {
            request_id,
            timestamp: now_unix_seconds(),
            payload: Some(proto::agent_envelope::Payload::Error(
                proto::ErrorResponse { code, message },
            )),
        })
        .await
    }

    fn set_outbound_sender(&self, sender: Option<mpsc::Sender<proto::AgentEnvelope>>) {
        if let Ok(mut slot) = self.outbound_tx.lock() {
            *slot = sender;
        }
    }

    fn touch_heartbeat(&self) {
        self.publish_status(|status| {
            status.last_heartbeat = Some(now_unix_seconds());
        });
    }

    fn publish_status(&self, mutate: impl FnOnce(&mut GatewayStatusSnapshot)) {
        let next = if let Ok(mut status) = self.status.lock() {
            mutate(&mut status);
            status.clone()
        } else {
            return;
        };
        let _ = self.app_handle.emit("gateway:status", next);
    }

    async fn publish_current_settings_sync(&self) -> Result<(), String> {
        let snapshot = self.current_settings_snapshot().await?;
        self.publish_settings_sync(snapshot).await
    }

    pub async fn refresh_settings_sync_from_db(&self) -> Result<Value, String> {
        let snapshot = self.current_settings_snapshot().await?;
        self.app_handle
            .emit(GATEWAY_SETTINGS_SYNC_EVENT, snapshot.clone())
            .map_err(|e| format!("emit gateway settings sync failed: {e}"))?;
        self.publish_settings_sync(snapshot.clone()).await?;
        Ok(snapshot)
    }

    async fn current_settings_snapshot(&self) -> Result<Value, String> {
        let cached_snapshot = self
            .settings_snapshot
            .lock()
            .map_err(|_| "gateway settings snapshot lock poisoned".to_string())?
            .clone();

        let db_snapshot = tauri::async_runtime::spawn_blocking(move || {
            let conn = open_db()?;
            load_gateway_settings_sync_snapshot(&conn)
        })
        .await
        .map_err(|e| format!("load gateway settings snapshot join failed: {e}"))??;

        let snapshot = merge_settings_sync_snapshot(db_snapshot, cached_snapshot.as_ref())?;
        self.store_settings_snapshot(snapshot)
    }

    fn store_settings_snapshot(&self, payload: Value) -> Result<Value, String> {
        let snapshot =
            redact_gateway_settings_sync_payload(normalize_settings_sync_payload(payload)?)?;
        let mut guard = self
            .settings_snapshot
            .lock()
            .map_err(|_| "gateway settings snapshot lock poisoned".to_string())?;
        *guard = Some(snapshot.clone());
        Ok(snapshot)
    }
}

async fn await_abortable_on_reconfigure<T>(
    config: &RemoteSettingsPayload,
    config_rx: &mut watch::Receiver<RemoteSettingsPayload>,
    fut: impl Future<Output = Result<T, String>>,
) -> Result<Option<T>, String> {
    tokio::pin!(fut);

    loop {
        tokio::select! {
            result = &mut fut => return result.map(Some),
            changed = config_rx.changed() => {
                if changed.is_err() {
                    return Ok(None);
                }
                let next = config_rx.borrow().clone();
                if next != *config {
                    return Ok(None);
                }
            }
        }
    }
}

fn merge_settings_sync_snapshot(snapshot: Value, cached: Option<&Value>) -> Result<Value, String> {
    let mut merged = match snapshot {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };

    if let Some(Value::Object(cached_map)) = cached {
        for field in UI_ONLY_SETTINGS_SYNC_FIELDS {
            if let Some(value) = cached_map.get(*field) {
                merged.insert((*field).to_string(), value.clone());
            }
        }
    }

    Ok(Value::Object(merged))
}

pub fn build_history_sync_upsert(summary: &ChatHistorySummary) -> GatewayHistorySyncEvent {
    GatewayHistorySyncEvent {
        kind: "upsert".to_string(),
        conversation_id: summary.id.clone(),
        conversation: Some(GatewayHistorySyncConversation {
            id: summary.id.clone(),
            title: summary.title.clone(),
            provider_id: Some(summary.provider_id.clone()),
            model: Some(summary.model.clone()),
            session_id: summary.session_id.clone(),
            cwd: summary.cwd.clone(),
            created_at: summary.created_at,
            updated_at: summary.updated_at,
            message_count: summary.message_count,
            is_pinned: summary.is_pinned,
            pinned_at: summary.pinned_at,
            is_shared: summary.is_shared,
        }),
    }
}

pub fn build_history_sync_delete(conversation_id: impl Into<String>) -> GatewayHistorySyncEvent {
    let conversation_id = conversation_id.into();
    GatewayHistorySyncEvent {
        kind: "delete".to_string(),
        conversation_id,
        conversation: None,
    }
}

pub fn build_history_sync_activity(
    conversation_id: impl Into<String>,
    running: bool,
) -> GatewayHistorySyncEvent {
    GatewayHistorySyncEvent {
        kind: if running {
            "running".to_string()
        } else {
            "idle".to_string()
        },
        conversation_id: conversation_id.into(),
        conversation: None,
    }
}

fn build_history_sync_upsert_from_proto(
    summary: &proto::ConversationSummary,
) -> GatewayHistorySyncEvent {
    GatewayHistorySyncEvent {
        kind: "upsert".to_string(),
        conversation_id: summary.id.clone(),
        conversation: Some(GatewayHistorySyncConversation {
            id: summary.id.clone(),
            title: summary.title.clone(),
            provider_id: (!summary.provider_id.trim().is_empty())
                .then(|| summary.provider_id.clone()),
            model: (!summary.model.trim().is_empty()).then(|| summary.model.clone()),
            session_id: (!summary.session_id.trim().is_empty()).then(|| summary.session_id.clone()),
            cwd: (!summary.cwd.trim().is_empty()).then(|| summary.cwd.clone()),
            created_at: summary.created_at,
            updated_at: summary.updated_at,
            message_count: i64::from(summary.message_count),
            is_pinned: summary.is_pinned,
            pinned_at: (summary.pinned_at > 0).then_some(summary.pinned_at),
            is_shared: summary.is_shared,
        }),
    }
}

fn build_settings_sync_envelope(payload: Value) -> Result<proto::AgentEnvelope, String> {
    Ok(proto::AgentEnvelope {
        request_id: format!("settings-sync-{}", Uuid::new_v4()),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::SettingsSync(
            proto::SettingsSyncEvent {
                settings_json: serialize_settings_sync_payload(&payload)?,
            },
        )),
    })
}

fn normalize_settings_sync_payload(payload: Value) -> Result<Value, String> {
    match payload {
        Value::Null => Ok(Value::Object(serde_json::Map::new())),
        Value::Object(_) => Ok(payload),
        _ => Err("gateway settings sync payload must be an object".to_string()),
    }
}

fn build_local_settings_update_event_payload(payload: Value) -> Result<Value, String> {
    let mut event = match payload {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };
    let provider_api_key_updates = event.remove(PROVIDER_API_KEY_UPDATES_FIELD);
    let mut public_event = match redact_gateway_settings_sync_payload(Value::Object(event))? {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };
    if let Some(updates) = provider_api_key_updates {
        public_event.insert(PROVIDER_API_KEY_UPDATES_FIELD.to_string(), updates);
    }
    Ok(Value::Object(public_event))
}

fn parse_settings_sync_payload(raw: &str) -> Result<Value, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    let payload = serde_json::from_str::<Value>(trimmed)
        .map_err(|e| format!("parse gateway settings sync payload failed: {e}"))?;
    normalize_settings_sync_payload(payload)
}

fn serialize_settings_sync_payload(payload: &Value) -> Result<String, String> {
    serde_json::to_string(payload)
        .map_err(|e| format!("serialize gateway settings sync payload failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        build_chat_event_envelope, build_endpoint, build_grpc_url,
        build_local_settings_update_event_payload, merge_settings_sync_snapshot,
        set_disconnected_status, GatewayStatusSnapshot,
    };
    use crate::commands::settings::RemoteSettingsPayload;
    use serde_json::{json, Value};

    #[test]
    fn merge_settings_sync_snapshot_keeps_cached_ui_only_fields() {
        let db_snapshot = json!({
            "system": { "executionMode": "agent-dev" },
            "cron": [{ "id": "cron-a" }],
            "theme": "light",
            "locale": "zh-CN",
            "skills": {},
            "chatRuntimeControls": {
                "thinkingEnabled": true,
                "nativeWebSearchEnabled": true,
                "reasoning": "high"
            },
            "selectedModel": null,
        });
        let cached_snapshot = json!({
            "theme": "dark",
            "locale": "en-US",
            "skills": { "enabled": true },
            "chatRuntimeControls": {
                "thinkingEnabled": false,
                "nativeWebSearchEnabled": false,
                "reasoning": "xhigh"
            },
            "selectedModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5.4"
            },
        });

        let merged = merge_settings_sync_snapshot(db_snapshot, Some(&cached_snapshot))
            .expect("merge settings sync snapshot");

        assert_eq!(merged["cron"], json!([{ "id": "cron-a" }]));
        assert_eq!(merged["theme"], json!("dark"));
        assert_eq!(merged["locale"], json!("en-US"));
        assert_eq!(merged["skills"], json!({ "enabled": true }));
        assert_eq!(
            merged["chatRuntimeControls"],
            json!({
                "thinkingEnabled": false,
                "nativeWebSearchEnabled": false,
                "reasoning": "xhigh"
            })
        );
        assert_eq!(
            merged["selectedModel"],
            json!({
                "customProviderId": "provider-a",
                "model": "gpt-5.4"
            })
        );
    }

    #[test]
    fn local_settings_update_event_keeps_private_api_key_updates_only_at_root() {
        let payload = json!({
            "customProviders": [
                {
                    "id": "provider-a",
                    "name": "A",
                    "apiKey": "leaked-key"
                }
            ],
            "providerApiKeyUpdates": {
                "provider-a": "new-key"
            }
        });

        let event_payload =
            build_local_settings_update_event_payload(payload).expect("build event payload");
        assert_eq!(event_payload["customProviders"][0]["apiKey"], Value::Null);
        assert_eq!(
            event_payload["customProviders"][0]["apiKeyConfigured"],
            true
        );
        assert_eq!(
            event_payload["providerApiKeyUpdates"]["provider-a"],
            "new-key"
        );
    }

    #[test]
    fn set_disconnected_status_resets_runtime_fields_for_new_config() {
        let config = RemoteSettingsPayload {
            enabled: true,
            gateway_url: "https://gateway.example.com".to_string(),
            grpc_port: 50051,
            grpc_endpoint: String::new(),
            token: "dev-token".to_string(),
            agent_id: "agent-new".to_string(),
            auto_reconnect: true,
            heartbeat_interval: 30,
        };
        let mut status = GatewayStatusSnapshot {
            online: true,
            enabled: true,
            configured: true,
            gateway_url: "https://old-gateway.example.com".to_string(),
            agent_id: "agent-old".to_string(),
            session_id: Some("session-123".to_string()),
            connected_since: Some(123),
            last_heartbeat: Some(456),
            last_error: Some("previous error".to_string()),
        };

        set_disconnected_status(
            &mut status,
            &config,
            Some("connect gateway failed".to_string()),
        );

        assert!(!status.online);
        assert!(status.enabled);
        assert!(status.configured);
        assert_eq!(status.gateway_url, "https://gateway.example.com");
        assert_eq!(status.agent_id, "agent-new");
        assert_eq!(status.session_id, None);
        assert_eq!(status.connected_since, None);
        assert_eq!(status.last_heartbeat, None);
        assert_eq!(status.last_error.as_deref(), Some("connect gateway failed"));
    }

    #[test]
    fn build_https_gateway_endpoint_initializes_tls_provider() {
        build_endpoint("https://agent.cnweb.org:443").expect("build https gateway endpoint");
    }

    #[test]
    fn build_grpc_url_prefers_explicit_endpoint() {
        let config = RemoteSettingsPayload {
            enabled: true,
            gateway_url: "https://gateway.example.com".to_string(),
            grpc_port: 50051,
            grpc_endpoint: "tcp.proxy.rlwy.net:12345".to_string(),
            token: "dev-token".to_string(),
            agent_id: "agent".to_string(),
            auto_reconnect: true,
            heartbeat_interval: 30,
        };

        let grpc_url = build_grpc_url(&config).expect("build explicit gRPC endpoint");

        assert_eq!(grpc_url, "http://tcp.proxy.rlwy.net:12345");
    }

    #[test]
    fn build_chat_event_envelope_preserves_tool_result_arguments() {
        let envelope = build_chat_event_envelope(
            "request-1".to_string(),
            json!({
                "type": "tool_result",
                "conversation_id": "conversation-1",
                "id": "bash-call",
                "name": "Bash",
                "arguments": {
                    "command": "printf live",
                    "cwd": "crates/agent-gateway",
                    "root": "workspace"
                },
                "content": [{ "type": "text", "text": "live" }],
                "isError": false,
                "round": 1
            }),
        )
        .expect("build chat event envelope");

        let chat_event = match envelope.payload.expect("payload") {
            super::proto::agent_envelope::Payload::ChatEvent(event) => event,
            _ => panic!("expected chat event payload"),
        };
        assert_eq!(chat_event.conversation_id, "conversation-1");
        assert_eq!(
            chat_event.r#type,
            super::proto::chat_event::ChatEventType::ToolResult as i32
        );

        let data: Value = serde_json::from_str(&chat_event.data).expect("chat event data");
        assert_eq!(data["arguments"]["command"], "printf live");
        assert_eq!(data["arguments"]["root"], "workspace");
    }

    #[test]
    fn build_chat_event_envelope_preserves_title_final_flag() {
        let envelope = build_chat_event_envelope(
            "request-1".to_string(),
            json!({
                "type": "token",
                "conversation_id": "conversation-1",
                "text": "",
                "title": "Final title",
                "titleFinal": true
            }),
        )
        .expect("build chat title event envelope");

        let chat_event = match envelope.payload.expect("payload") {
            super::proto::agent_envelope::Payload::ChatEvent(event) => event,
            _ => panic!("expected chat event payload"),
        };
        assert_eq!(chat_event.conversation_id, "conversation-1");
        assert_eq!(
            chat_event.r#type,
            super::proto::chat_event::ChatEventType::Token as i32
        );

        let data: Value = serde_json::from_str(&chat_event.data).expect("chat event data");
        assert_eq!(data["title"], "Final title");
        assert_eq!(data["titleFinal"], true);
    }

    #[test]
    fn build_chat_event_envelope_preserves_hosted_search_payload() {
        let envelope = build_chat_event_envelope(
            "request-1".to_string(),
            json!({
                "type": "hosted_search",
                "conversation_id": "conversation-1",
                "id": "search-1",
                "provider": "codex",
                "status": "completed",
                "queries": ["设计模式定义"],
                "sources": [
                    {
                        "url": "https://example.com/pattern",
                        "title": "设计模式",
                        "sourceType": "citation"
                    }
                ],
                "updatedAt": 1234,
                "round": 2
            }),
        )
        .expect("build hosted search event envelope");

        let chat_event = match envelope.payload.expect("payload") {
            super::proto::agent_envelope::Payload::ChatEvent(event) => event,
            _ => panic!("expected chat event payload"),
        };
        assert_eq!(chat_event.conversation_id, "conversation-1");
        assert_eq!(
            chat_event.r#type,
            super::proto::chat_event::ChatEventType::HostedSearch as i32
        );

        let data: Value = serde_json::from_str(&chat_event.data).expect("chat event data");
        assert_eq!(data["id"], "search-1");
        assert_eq!(data["provider"], "codex");
        assert_eq!(data["status"], "completed");
        assert_eq!(data["queries"][0], "设计模式定义");
        assert_eq!(data["sources"][0]["url"], "https://example.com/pattern");
        assert_eq!(data["updatedAt"], 1234);
        assert_eq!(data["round"], 2);
    }
}

fn build_chat_event_envelope(
    request_id: String,
    event: Value,
) -> Result<proto::AgentEnvelope, String> {
    let object = event
        .as_object()
        .ok_or_else(|| "gateway chat event payload must be an object".to_string())?;
    let event_type = string_field(object, "type")?;
    let conversation_id = optional_string_field(object, "conversation_id")
        .or_else(|| optional_string_field(object, "conversationId"))
        .unwrap_or_default();

    let (event_kind, data) = match event_type.as_str() {
        "token" => (
            proto::chat_event::ChatEventType::Token as i32,
            json!({
                "text": required_raw_string_field(object, "text")?,
                "title": optional_string_field(object, "title"),
                "titleFinal": object.get("titleFinal").and_then(Value::as_bool).unwrap_or(false),
                "round": optional_number_field(object, "round"),
                "provider": optional_string_field(object, "provider"),
                "model": optional_string_field(object, "model"),
                "api": optional_string_field(object, "api"),
                "stopReason": optional_string_field(object, "stopReason")
                    .or_else(|| optional_string_field(object, "stop_reason")),
                "usage": object.get("usage").cloned().unwrap_or(Value::Null),
                "checkpoint": object.get("checkpoint").cloned().unwrap_or(Value::Null),
            }),
        ),
        "thinking" => (
            proto::chat_event::ChatEventType::Thinking as i32,
            json!({
                "text": required_raw_string_field(object, "text")?,
                "round": optional_number_field(object, "round"),
            }),
        ),
        "tool_call" => (
            proto::chat_event::ChatEventType::ToolCall as i32,
            json!({
                "id": optional_string_field(object, "id"),
                "name": optional_string_field(object, "name"),
                "arguments": object.get("arguments").cloned().unwrap_or(Value::Null),
                "round": optional_number_field(object, "round"),
            }),
        ),
        "tool_result" => (
            proto::chat_event::ChatEventType::ToolResult as i32,
            json!({
                "id": optional_string_field(object, "id"),
                "name": optional_string_field(object, "name"),
                "arguments": object.get("arguments").cloned().unwrap_or(Value::Null),
                "content": object.get("content").cloned().unwrap_or(Value::Null),
                "details": object.get("details").cloned().unwrap_or(Value::Null),
                "isError": object.get("isError").and_then(Value::as_bool).unwrap_or(false),
                "round": optional_number_field(object, "round"),
            }),
        ),
        "hosted_search" => (
            proto::chat_event::ChatEventType::HostedSearch as i32,
            json!({
                "id": optional_string_field(object, "id"),
                "provider": optional_string_field(object, "provider"),
                "status": optional_string_field(object, "status"),
                "queries": object.get("queries").cloned().unwrap_or(Value::Null),
                "sources": object.get("sources").cloned().unwrap_or(Value::Null),
                "updatedAt": object.get("updatedAt").cloned().unwrap_or(Value::Null),
                "round": optional_number_field(object, "round"),
            }),
        ),
        "done" => (
            proto::chat_event::ChatEventType::Done as i32,
            json!({
                "round": optional_number_field(object, "round"),
            }),
        ),
        "error" => (
            proto::chat_event::ChatEventType::Error as i32,
            json!({
                "message": required_string_field(object, "message")?,
                "round": optional_number_field(object, "round"),
            }),
        ),
        "tool_status" => (
            proto::chat_event::ChatEventType::ToolStatus as i32,
            json!({
                "status": object.get("status").cloned().unwrap_or(Value::Null),
                "isCompaction": object.get("isCompaction").and_then(Value::as_bool).unwrap_or(false),
                "round": optional_number_field(object, "round"),
            }),
        ),
        other => return Err(format!("unsupported gateway chat event type: {other}")),
    };

    Ok(proto::AgentEnvelope {
        request_id,
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::ChatEvent(
            proto::ChatEvent {
                r#type: event_kind,
                conversation_id,
                data: serde_json::to_string(&data)
                    .map_err(|e| format!("serialize gateway chat event failed: {e}"))?,
            },
        )),
    })
}

fn build_history_sync_envelope(
    event: GatewayHistorySyncEvent,
) -> Result<proto::AgentEnvelope, String> {
    let conversation = event
        .conversation
        .map(|conversation| proto::ConversationSummary {
            id: conversation.id,
            title: conversation.title,
            created_at: conversation.created_at,
            updated_at: conversation.updated_at,
            message_count: i32::try_from(conversation.message_count).unwrap_or(i32::MAX),
            provider_id: conversation.provider_id.unwrap_or_default(),
            model: conversation.model.unwrap_or_default(),
            session_id: conversation.session_id.unwrap_or_default(),
            cwd: conversation.cwd.unwrap_or_default(),
            is_pinned: conversation.is_pinned,
            pinned_at: conversation.pinned_at.unwrap_or_default(),
            is_shared: conversation.is_shared,
        });

    Ok(proto::AgentEnvelope {
        request_id: format!("history-sync-{}", Uuid::new_v4()),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::HistorySync(
            proto::HistorySyncEvent {
                kind: event.kind,
                conversation,
                conversation_id: event.conversation_id,
            },
        )),
    })
}

fn build_grpc_url(config: &RemoteSettingsPayload) -> Result<String, String> {
    let grpc_endpoint = config.grpc_endpoint.trim();
    if !grpc_endpoint.is_empty() {
        let with_scheme =
            if grpc_endpoint.starts_with("http://") || grpc_endpoint.starts_with("https://") {
                grpc_endpoint.to_string()
            } else {
                format!("http://{grpc_endpoint}")
            };
        let mut url =
            Url::parse(&with_scheme).map_err(|e| format!("invalid gateway gRPC endpoint: {e}"))?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err("gateway gRPC endpoint must start with http:// or https://".to_string());
        }
        url.set_path("");
        url.set_query(None);
        url.set_fragment(None);
        return Ok(url.to_string().trim_end_matches('/').to_string());
    }

    let trimmed = config.gateway_url.trim();
    if trimmed.is_empty() {
        return Err("gateway URL is empty".to_string());
    }

    let mut url = Url::parse(trimmed).map_err(|e| format!("invalid gateway URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("gateway URL must start with http:// or https://".to_string());
    }
    url.set_port(Some(config.grpc_port))
        .map_err(|_| "failed to apply gRPC port to gateway URL".to_string())?;
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn build_endpoint(grpc_url: &str) -> Result<Endpoint, String> {
    let endpoint = Endpoint::from_shared(grpc_url.to_string())
        .map_err(|e| format!("invalid gateway endpoint: {e}"))?
        .connect_timeout(Duration::from_secs(10))
        .tcp_keepalive(Some(Duration::from_secs(30)));

    if grpc_url.starts_with("https://") {
        ensure_rustls_crypto_provider();
        let host = Url::parse(grpc_url)
            .ok()
            .and_then(|url| url.host_str().map(ToString::to_string))
            .ok_or_else(|| "failed to extract TLS host from gateway URL".to_string())?;
        endpoint
            .tls_config(
                ClientTlsConfig::new()
                    .with_enabled_roots()
                    .domain_name(host),
            )
            .map_err(|e| format!("configure gateway TLS failed: {e}"))
    } else {
        Ok(endpoint)
    }
}

fn ensure_rustls_crypto_provider() {
    static INSTALL_DEFAULT_PROVIDER: Once = Once::new();
    INSTALL_DEFAULT_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn insert_bearer_metadata(
    metadata: &mut tonic::metadata::MetadataMap,
    token: &str,
) -> Result<(), String> {
    let value = MetadataValue::try_from(format!("Bearer {}", token.trim()))
        .map_err(|e| format!("invalid gateway authorization metadata: {e}"))?;
    metadata.insert("authorization", value);
    Ok(())
}

fn is_remote_configured(config: &RemoteSettingsPayload) -> bool {
    !config.gateway_url.trim().is_empty() && !config.token.trim().is_empty()
}

fn effective_agent_id(config: &RemoteSettingsPayload) -> String {
    if !config.agent_id.trim().is_empty() {
        return config.agent_id.trim().to_string();
    }
    fallback_agent_id()
}

fn fallback_agent_id() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "liveagent-desktop".to_string())
}

fn set_disconnected_status(
    status: &mut GatewayStatusSnapshot,
    config: &RemoteSettingsPayload,
    last_error: Option<String>,
) {
    status.online = false;
    status.enabled = config.enabled;
    status.configured = is_remote_configured(config);
    status.gateway_url = config.gateway_url.clone();
    status.agent_id = effective_agent_id(config);
    status.session_id = None;
    status.connected_since = None;
    status.last_heartbeat = None;
    status.last_error = last_error;
}

fn now_unix_seconds() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
}

fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("gateway chat event {key} is required"))
}

fn required_string_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, String> {
    string_field(object, key)
}

fn required_raw_string_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| format!("gateway chat event {key} is required"))
}

fn optional_string_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn optional_number_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
    object.get(key).and_then(Value::as_i64)
}
