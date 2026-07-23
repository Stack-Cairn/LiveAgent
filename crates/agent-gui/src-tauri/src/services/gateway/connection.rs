use std::future::Future;
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use futures_util::SinkExt as _;
use serde_json::Value;
use tauri::Emitter;
use tokio::sync::{mpsc, watch};
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt as _;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::commands::settings::RemoteSettingsPayload;
use crate::runtime::terminal::TerminalEventPayload;
use crate::services::gateway_bridge;

use super::gateway_proto::v2;
use super::*;

/// 后台任务句柄的 RAII 中止器。
struct AbortTaskOnDrop(tauri::async_runtime::JoinHandle<()>);

impl Drop for AbortTaskOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl GatewayController {
    pub(crate) async fn run(
        self: Arc<Self>,
        mut config_rx: watch::Receiver<RemoteSettingsPayload>,
    ) {
        let mut reconnect_delay = GATEWAY_RECONNECT_MIN;
        loop {
            let config = config_rx.borrow().clone();
            if !config.enabled || !is_remote_configured(&config) {
                reconnect_delay = GATEWAY_RECONNECT_MIN;
                self.set_outbound_sender(None);
                self.set_outbound_control_sender(None);
                self.set_terminal_stream_sender(None);
                self.publish_disconnected_status(&config, None);
                if config_rx.changed().await.is_err() {
                    break;
                }
                continue;
            }

            let current_config = config.clone();
            let attempt_started = Instant::now();
            let connect_result = self
                .connect_and_serve(current_config.clone(), &mut config_rx)
                .await;
            let latest_config = config_rx.borrow().clone();
            let reconfigured = latest_config != current_config;

            self.set_outbound_sender(None);
            self.set_outbound_control_sender(None);
            self.set_terminal_stream_sender(None);
            if reconfigured {
                reconnect_delay = GATEWAY_RECONNECT_MIN;
                self.publish_disconnected_status(&latest_config, None);
                continue;
            }

            self.publish_disconnected_status(
                &current_config,
                connect_result.as_ref().err().cloned(),
            );

            if config_rx.has_changed().unwrap_or(false) {
                continue;
            }

            if !current_config.auto_reconnect {
                reconnect_delay = GATEWAY_RECONNECT_MIN;
                if config_rx.changed().await.is_err() {
                    break;
                }
                continue;
            }

            let (delay, next_delay) =
                gateway_reconnect_backoff(reconnect_delay, attempt_started.elapsed());
            reconnect_delay = next_delay;

            tokio::select! {
                changed = config_rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                }
                _ = tokio::time::sleep(delay) => {}
            }
        }
    }

    /// v2 主链路：hello 握手完成鉴权与会话登记后双向收发
    /// 信封（双通道合并、状态迁移、对账、分发），外加传输层存活看门狗。任何失败（网关不可达、
    /// 握手失败、鉴权被拒、链路中断）一律上抛错误消息，由外层 run 循环统一退避重连。
    pub(crate) async fn connect_and_serve(
        self: &Arc<Self>,
        config: RemoteSettingsPayload,
        config_rx: &mut watch::Receiver<RemoteSettingsPayload>,
    ) -> Result<(), String> {
        let ws_url = build_ws_url(
            &config.gateway_url,
            config.gateway_port,
            GATEWAY_WS_AGENT_PATH,
        )?;
        let hello = build_client_hello(
            &config.token,
            effective_agent_id(&config)?,
            crate::app_version().to_string(),
        );

        let connect_result = await_abortable_on_reconfigure(&config, config_rx, async move {
            Ok(connect_agent_ws(&ws_url, hello).await)
        })
        .await?;
        let (mut ws, server_hello) = match connect_result {
            None => return Ok(()),
            Some(established) => established?,
        };

        let (outbound_tx, outbound_rx) = mpsc::channel::<proto::AgentEnvelope>(4096);
        self.set_outbound_sender(Some(outbound_tx));
        // 控制小通道：Pong 不排在数据信封之后（下方公平合并进出站流）。
        let (outbound_control_tx, outbound_control_rx) =
            mpsc::channel::<proto::AgentEnvelope>(GATEWAY_OUTBOUND_CONTROL_QUEUE_DEPTH);
        self.set_outbound_control_sender(Some(outbound_control_tx));
        let (terminal_stop_tx, terminal_stop_rx) = watch::channel(false);
        let terminal_task = self.spawn_terminal_stream_ws(config.clone(), terminal_stop_rx);

        let serve_result = async {
            let connected_at = now_unix_seconds();
            self.publish_status(|status| {
                status.online = true;
                status.enabled = true;
                status.configured = true;
                status.gateway_url = config.gateway_url.clone();
                status.agent_id = config.agent_id.clone();
                status.session_id = Some(server_hello.session_id.clone());
                status.connected_since = Some(connected_at);
                status.last_heartbeat = Some(connected_at);
                status.last_error = None;
                status.protocol = Some("v2".to_string());
            });

            let _reconcile_task = AbortTaskOnDrop(self.spawn_post_connect_reconciliation());

            let mut outbound = ReceiverStream::new(outbound_control_rx)
                .merge(ReceiverStream::new(outbound_rx));

            // 存活看门狗（取代 h2 keepalive）：任何入站帧刷新计时；静默超 3×心跳周期发 WS Ping
            // 探活，宽限期内仍无入站则判链路已死走重连。服务端 Ping 的 Pong 由 tungstenite 自动回。
            let heartbeat_period = if server_hello.heartbeat_period_seconds > 0 {
                Duration::from_secs(u64::from(server_hello.heartbeat_period_seconds))
            } else {
                GATEWAY_WS_DEFAULT_HEARTBEAT_PERIOD
            };
            let idle_timeout = heartbeat_period * 3;
            let mut last_inbound = Instant::now();
            let mut probe_deadline: Option<Instant> = None;

            let receive_result = loop {
                let watchdog_deadline = probe_deadline.unwrap_or(last_inbound + idle_timeout);
                tokio::select! {
                    changed = config_rx.changed() => {
                        if changed.is_err() {
                            break Ok(());
                        }
                        let next = config_rx.borrow().clone();
                        if next != config {
                            break Ok(());
                        }
                    }
                    envelope = outbound.next() => {
                        match envelope {
                            None => break Err("gateway outbound channels closed".to_string()),
                            Some(envelope) => {
                                let frame = v2::AgentClientFrame {
                                    payload: Some(v2::agent_client_frame::Payload::Envelope(envelope)),
                                };
                                if let Err(error) = ws.send(encode_ws_frame(&frame)).await {
                                    break Err(format!("gateway ws send failed: {error}"));
                                }
                            }
                        }
                    }
                    message = ws.next() => {
                        match message {
                            None => break Err("gateway ws stream closed".to_string()),
                            Some(Err(error)) => break Err(format!("gateway ws receive failed: {error}")),
                            Some(Ok(message)) => {
                                last_inbound = Instant::now();
                                probe_deadline = None;
                                match message {
                                    WsMessage::Binary(data) => {
                                        let frame: v2::AgentServerFrame = match decode_ws_frame(&data) {
                                            Ok(frame) => frame,
                                            Err(error) => break Err(error),
                                        };
                                        // 重复 hello 或空帧：忽略（服务端同样宽容）。
                                        if let Some(v2::agent_server_frame::Payload::Envelope(envelope)) = frame.payload {
                                            self.touch_heartbeat();
                                            if let Err(error) = self.handle_gateway_envelope(envelope).await {
                                                break Err(error);
                                            }
                                        }
                                    }
                                    WsMessage::Close(frame) => {
                                        break Err(match frame {
                                            Some(frame) => format!(
                                                "gateway ws closed (code {}): {}",
                                                u16::from(frame.code),
                                                frame.reason
                                            ),
                                            None => "gateway ws closed".to_string(),
                                        });
                                    }
                                    // v2 链路不允许文本帧，视为协议错误。
                                    WsMessage::Text(_) => {
                                        break Err("gateway ws sent unexpected text frame".to_string());
                                    }
                                    // Ping/Pong 由 tungstenite 处理，此处仅刷新看门狗。
                                    _ => {}
                                }
                            }
                        }
                    }
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(watchdog_deadline)) => {
                        if probe_deadline.is_some() {
                            break Err(format!(
                                "gateway ws link stale: no inbound frames for {}s",
                                idle_timeout.saturating_add(GATEWAY_WS_PROBE_GRACE).as_secs()
                            ));
                        }
                        if let Err(error) = ws.send(WsMessage::Ping(Vec::new().into())).await {
                            break Err(format!("gateway ws liveness ping failed: {error}"));
                        }
                        probe_deadline = Some(Instant::now() + GATEWAY_WS_PROBE_GRACE);
                    }
                }
            };
            receive_result
        }
        .await;

        let _ = terminal_stop_tx.send(true);
        terminal_task.abort();
        self.set_terminal_stream_sender(None);
        serve_result
    }

    pub(crate) fn spawn_post_connect_reconciliation(
        self: &Arc<Self>,
    ) -> tauri::async_runtime::JoinHandle<()> {
        let controller = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            // Runtime readiness is control-plane state: restore it immediately
            // on the fresh stream before low-priority snapshots begin replaying.
            if let Some((worker_id, state, visible, active_run_count)) =
                controller.runtime_status_republish_snapshot()
            {
                if let Err(error) = controller
                    .send_chat_runtime_status_envelope(worker_id, state, visible, active_run_count)
                    .await
                {
                    eprintln!(
                        "republish gateway chat runtime status after connect failed: {error}"
                    );
                }
            }

            // Give Ping/chat control traffic a short uncontended window. The
            // snapshots below are reconciliation data and must never delay the
            // first command received after wake or reconnect.
            tokio::time::sleep(GATEWAY_POST_CONNECT_REPLAY_DELAY).await;

            if let Err(error) = controller.publish_current_settings_sync().await {
                eprintln!("publish gateway settings sync failed: {error}");
            }
            tokio::task::yield_now().await;
            if let Err(error) = controller.publish_current_terminal_sessions().await {
                eprintln!("publish gateway terminal sessions failed: {error}");
            }
            tokio::task::yield_now().await;
            if let Err(error) = controller.publish_desired_tunnels().await {
                eprintln!("publish gateway tunnel desired state failed: {error}");
            }
            tokio::task::yield_now().await;
            if let Err(error) = controller.publish_current_managed_processes().await {
                eprintln!("publish gateway managed processes failed: {error}");
            }
            tokio::task::yield_now().await;
            if let Err(error) = controller.republish_chat_run_states().await {
                eprintln!("republish gateway chat run states failed: {error}");
            }
            controller.spawn_tunnel_probes(None, false);
        })
    }

    pub(crate) async fn send_agent_envelope(
        &self,
        envelope: proto::AgentEnvelope,
    ) -> Result<(), String> {
        let sender = self.current_outbound_sender()?;
        send_agent_envelope_to(sender, envelope).await
    }

    pub(crate) fn current_outbound_sender(
        &self,
    ) -> Result<mpsc::Sender<proto::AgentEnvelope>, String> {
        self.outbound_tx
            .lock()
            .map_err(|_| "gateway outbound sender lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "gateway outbound stream is offline".to_string())
    }

    pub(crate) fn current_outbound_control_sender(
        &self,
    ) -> Result<mpsc::Sender<proto::AgentEnvelope>, String> {
        self.outbound_control_tx
            .lock()
            .map_err(|_| "gateway outbound control sender lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "gateway outbound control lane is offline".to_string())
    }

    pub(crate) fn current_terminal_stream_sender(
        &self,
    ) -> Result<mpsc::Sender<proto::TerminalStreamFrame>, String> {
        self.terminal_stream_tx
            .lock()
            .map_err(|_| "gateway terminal stream sender lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "gateway terminal stream is offline".to_string())
    }

    pub(crate) fn spawn_uploaded_image_preview_response(
        &self,
        request_id: String,
        request: proto::UploadedImagePreviewRequest,
    ) -> Result<(), String> {
        let sender = self.current_outbound_sender()?;
        tauri::async_runtime::spawn(async move {
            let envelope = match gateway_bridge::handle_uploaded_image_preview(request).await {
                Ok(response) => proto::AgentEnvelope {
                    request_id,
                    timestamp: now_unix_seconds(),
                    payload: Some(proto::agent_envelope::Payload::UploadedImagePreviewResp(
                        response,
                    )),
                },
                Err(error) => build_error_response_envelope(request_id, 500, error),
            };
            if let Err(error) = send_agent_envelope_to(sender, envelope).await {
                eprintln!("send gateway uploaded image preview response failed: {error}");
            }
        });
        Ok(())
    }

    pub(crate) async fn send_error_response(
        &self,
        request_id: String,
        code: i32,
        message: String,
    ) -> Result<(), String> {
        self.send_agent_envelope(build_error_response_envelope(request_id, code, message))
            .await
    }

    pub(crate) fn set_outbound_sender(&self, sender: Option<mpsc::Sender<proto::AgentEnvelope>>) {
        if let Ok(mut slot) = self.outbound_tx.lock() {
            *slot = sender;
        }
    }

    pub(crate) fn set_outbound_control_sender(
        &self,
        sender: Option<mpsc::Sender<proto::AgentEnvelope>>,
    ) {
        if let Ok(mut slot) = self.outbound_control_tx.lock() {
            *slot = sender;
        }
    }

    pub(crate) fn set_terminal_stream_sender(
        &self,
        sender: Option<mpsc::Sender<proto::TerminalStreamFrame>>,
    ) {
        if let Ok(mut slot) = self.terminal_stream_tx.lock() {
            *slot = sender;
        }
    }

    pub(crate) fn clear_terminal_stream_sender_if_current(
        &self,
        sender: &mpsc::Sender<proto::TerminalStreamFrame>,
    ) {
        if let Ok(mut slot) = self.terminal_stream_tx.lock() {
            if slot
                .as_ref()
                .map(|current| current.same_channel(sender))
                .unwrap_or(false)
            {
                *slot = None;
            }
        }
    }

    pub(crate) fn touch_heartbeat(&self) {
        self.publish_status(|status| {
            status.last_heartbeat = Some(now_unix_seconds());
        });
    }

    /// Publishes a disconnected gateway status and mirrors the offline state
    /// onto the tunnel event channel: without the mirror, the tunnel panel's
    /// `agentOnline` badge would keep the last gateway snapshot's stale
    /// "online" until the next snapshot — which never arrives while offline.
    pub(crate) fn publish_disconnected_status(
        &self,
        config: &RemoteSettingsPayload,
        last_error: Option<String>,
    ) {
        self.publish_status(|status| set_disconnected_status(status, config, last_error));
        self.emit_local_tunnel_state();
    }

    pub(crate) fn publish_status(&self, mutate: impl FnOnce(&mut GatewayStatusSnapshot)) {
        let next = if let Ok(mut status) = self.status.lock() {
            mutate(&mut status);
            status.clone()
        } else {
            return;
        };
        let _ = self.app_handle.emit("gateway:status", next);
    }

    pub(crate) async fn publish_current_settings_sync(&self) -> Result<(), String> {
        let snapshot = self.current_settings_snapshot().await?;
        self.publish_settings_sync(snapshot).await
    }

    pub(crate) async fn publish_current_terminal_sessions(&self) -> Result<(), String> {
        let sessions = self.terminal_registry.list(None).sessions;
        for session in sessions {
            self.send_agent_envelope(build_terminal_event_envelope(TerminalEventPayload {
                kind: "created".to_string(),
                session_id: session.id.clone(),
                project_path_key: session.project_path_key.clone(),
                session: Some(session),
                data: None,
                output_start_offset: None,
                output_end_offset: None,
                ssh_tabs: None,
            }))
            .await?;
            tokio::task::yield_now().await;
        }
        Ok(())
    }

    pub async fn refresh_settings_sync_from_db(&self) -> Result<Value, String> {
        let snapshot = self.current_settings_snapshot().await?;
        self.app_handle
            .emit(GATEWAY_SETTINGS_SYNC_EVENT, snapshot.clone())
            .map_err(|e| format!("emit gateway settings sync failed: {e}"))?;
        self.publish_settings_sync(snapshot.clone()).await?;
        Ok(snapshot)
    }
}

pub(crate) async fn await_abortable_on_reconfigure<T>(
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

pub(crate) async fn send_agent_envelope_to(
    sender: mpsc::Sender<proto::AgentEnvelope>,
    envelope: proto::AgentEnvelope,
) -> Result<(), String> {
    sender
        .send(envelope)
        .await
        .map_err(|_| "gateway outbound stream closed".to_string())
}

pub(crate) fn build_error_response_envelope(
    request_id: String,
    code: i32,
    message: String,
) -> proto::AgentEnvelope {
    proto::AgentEnvelope {
        request_id,
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::Error(
            proto::ErrorResponse { code, message },
        )),
    }
}

pub(crate) fn ensure_rustls_crypto_provider() {
    static INSTALL_DEFAULT_PROVIDER: Once = Once::new();
    INSTALL_DEFAULT_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

pub(crate) fn is_remote_configured(config: &RemoteSettingsPayload) -> bool {
    !config.gateway_url.trim().is_empty() && !config.token.trim().is_empty()
}

pub(crate) fn effective_agent_id(config: &RemoteSettingsPayload) -> Result<String, String> {
    let agent_id = config.agent_id.trim();
    if agent_id.is_empty() {
        return Err("Agent ID 尚未初始化".to_string());
    }
    Ok(agent_id.to_string())
}

pub(crate) fn set_disconnected_status(
    status: &mut GatewayStatusSnapshot,
    config: &RemoteSettingsPayload,
    last_error: Option<String>,
) {
    status.online = false;
    status.enabled = config.enabled;
    status.configured = is_remote_configured(config);
    status.gateway_url = config.gateway_url.clone();
    status.agent_id = config.agent_id.trim().to_string();
    status.session_id = None;
    status.connected_since = None;
    status.last_heartbeat = None;
    status.last_error = last_error;
    status.protocol = None;
}
