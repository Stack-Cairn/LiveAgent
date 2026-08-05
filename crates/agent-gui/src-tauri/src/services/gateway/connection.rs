use std::future::Future;
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use futures_util::{SinkExt as _, StreamExt as _};
use prost::Message as _;
use serde_json::Value;
use tauri::Emitter;
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::services::gateway_bridge;
use agent_core::commands::settings::RemoteSettingsPayload;
use agent_core::runtime::terminal::TerminalEventPayload;

use super::gateway_proto::v2;
use super::*;

// Small dedicated lane for latency-sensitive control replies (Pongs). It is
// merged into the same outbound envelope stream but never sits behind
// thousands of queued data envelopes, so wake probes stay answerable while a
// reply is streaming tokens through the saturated data queue.
const GATEWAY_URGENT_QUEUE_DEPTH: usize = 64;
const GATEWAY_URGENT_BYTE_BUDGET: usize = 256 * 1024;
const GATEWAY_INTERACTIVE_QUEUE_DEPTH: usize = 256;
// Must admit the largest legitimate interactive response: fs image/preview
// reads are 25 MiB raw (~33 MiB base64-encoded in JSON) and history payloads
// are unbounded in principle. Aligned with the gateway's 64 MiB read limit so
// any frame the gateway can accept the desktop can deliver.
const GATEWAY_INTERACTIVE_BYTE_BUDGET: usize = 64 * 1024 * 1024;
const GATEWAY_INGRESS_QUEUE_DEPTH: usize = GATEWAY_OUTBOUND_DATA_QUEUE_DEPTH;
const GATEWAY_INGRESS_BYTE_BUDGET: usize = 8 * 1024 * 1024;
const GATEWAY_URGENT_BURST_LIMIT: usize = GATEWAY_URGENT_QUEUE_DEPTH;
const GATEWAY_INTERACTIVE_BURST_LIMIT: usize = 8;
const GATEWAY_INGRESS_BURST_LIMIT: usize = 1;
const GATEWAY_WRITE_BASE_SECONDS: f64 = 5.0;
const GATEWAY_WRITE_BYTES_PER_SECOND: f64 = 8.0 * 1024.0;
const GATEWAY_WRITE_TIMEOUT_MIN: Duration = Duration::from_secs(10);
const GATEWAY_WRITE_TIMEOUT_MAX: Duration = Duration::from_secs(60);

/// 后台任务句柄的 RAII 中止器。
struct AbortTaskOnDrop(tauri::async_runtime::JoinHandle<()>);

impl Drop for AbortTaskOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(crate) struct QueuedAgentEnvelope {
    envelope: proto::AgentEnvelope,
    _byte_permit: OwnedSemaphorePermit,
}

struct OutboundLaneSender {
    name: &'static str,
    tx: mpsc::Sender<QueuedAgentEnvelope>,
    byte_budget: Arc<Semaphore>,
    byte_budget_limit: usize,
}

#[derive(Clone)]
pub(crate) struct GatewayOutboundSender {
    lane: Arc<OutboundLaneSender>,
    ingress_lane: Option<Arc<OutboundLaneSender>>,
}

impl GatewayOutboundSender {
    fn lane(
        name: &'static str,
        depth: usize,
        byte_budget_limit: usize,
    ) -> (Self, mpsc::Receiver<QueuedAgentEnvelope>) {
        let (tx, rx) = mpsc::channel(depth);
        let lane = Arc::new(OutboundLaneSender {
            name,
            tx,
            byte_budget: Arc::new(Semaphore::new(byte_budget_limit)),
            byte_budget_limit,
        });
        (
            Self {
                lane,
                ingress_lane: None,
            },
            rx,
        )
    }

    fn agent_lanes() -> (
        Self,
        Self,
        mpsc::Receiver<QueuedAgentEnvelope>,
        mpsc::Receiver<QueuedAgentEnvelope>,
        mpsc::Receiver<QueuedAgentEnvelope>,
    ) {
        let (urgent, urgent_rx) = Self::lane(
            "urgent",
            GATEWAY_URGENT_QUEUE_DEPTH,
            GATEWAY_URGENT_BYTE_BUDGET,
        );
        let (mut interactive, interactive_rx) = Self::lane(
            "interactive",
            GATEWAY_INTERACTIVE_QUEUE_DEPTH,
            GATEWAY_INTERACTIVE_BYTE_BUDGET,
        );
        let (ingress, ingress_rx) = Self::lane(
            "ingress",
            GATEWAY_INGRESS_QUEUE_DEPTH,
            GATEWAY_INGRESS_BYTE_BUDGET,
        );
        interactive.ingress_lane = Some(Arc::clone(&ingress.lane));
        (urgent, interactive, urgent_rx, interactive_rx, ingress_rx)
    }

    fn encoded_bytes(envelope: &proto::AgentEnvelope) -> usize {
        v2::AgentClientFrame {
            payload: Some(v2::agent_client_frame::Payload::Envelope(envelope.clone())),
        }
        .encoded_len()
        .max(1)
    }

    async fn send(&self, envelope: proto::AgentEnvelope) -> Result<(), String> {
        Self::send_to_lane(&self.lane, envelope).await
    }

    pub(crate) async fn send_ingress(&self, envelope: proto::AgentEnvelope) -> Result<(), String> {
        let lane = self
            .ingress_lane
            .as_ref()
            .ok_or_else(|| "gateway ingress lane is unavailable for this sender".to_string())?;
        Self::send_to_lane(lane, envelope).await
    }

    async fn send_to_lane(
        lane: &Arc<OutboundLaneSender>,
        envelope: proto::AgentEnvelope,
    ) -> Result<(), String> {
        let bytes = Self::encoded_bytes(&envelope);
        if bytes > lane.byte_budget_limit {
            return Err(format!(
                "gateway {} frame is {bytes} bytes, exceeding lane budget {}",
                lane.name, lane.byte_budget_limit
            ));
        }
        let permits = u32::try_from(bytes)
            .map_err(|_| "gateway outbound frame byte count overflow".to_string())?;
        let permit = Arc::clone(&lane.byte_budget)
            .acquire_many_owned(permits)
            .await
            .map_err(|_| "gateway outbound byte budget closed".to_string())?;
        lane.tx
            .send(QueuedAgentEnvelope {
                envelope,
                _byte_permit: permit,
            })
            .await
            .map_err(|_| "gateway outbound stream closed".to_string())
    }

    pub(crate) fn try_send(
        &self,
        envelope: proto::AgentEnvelope,
    ) -> Result<(), proto::AgentEnvelope> {
        let bytes = Self::encoded_bytes(&envelope);
        let Ok(permits) = u32::try_from(bytes) else {
            return Err(envelope);
        };
        if bytes > self.lane.byte_budget_limit {
            return Err(envelope);
        }
        let Ok(permit) = Arc::clone(&self.lane.byte_budget).try_acquire_many_owned(permits) else {
            return Err(envelope);
        };
        self.lane
            .tx
            .try_send(QueuedAgentEnvelope {
                envelope,
                _byte_permit: permit,
            })
            .map_err(|error| error.into_inner().envelope)
    }

    pub(crate) fn blocking_send(&self, envelope: proto::AgentEnvelope) -> Result<(), String> {
        tauri::async_runtime::block_on(self.send(envelope))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GatewayWriterLane {
    Urgent,
    Interactive,
    Ingress,
}

fn gateway_writer_round_plan(
    urgent_ready: usize,
    interactive_ready: usize,
    ingress_ready: usize,
) -> Vec<GatewayWriterLane> {
    let mut plan = Vec::with_capacity(
        GATEWAY_URGENT_BURST_LIMIT + GATEWAY_INTERACTIVE_BURST_LIMIT + GATEWAY_INGRESS_BURST_LIMIT,
    );
    plan.extend(std::iter::repeat_n(
        GatewayWriterLane::Urgent,
        urgent_ready.min(GATEWAY_URGENT_BURST_LIMIT),
    ));
    plan.extend(std::iter::repeat_n(
        GatewayWriterLane::Interactive,
        interactive_ready.min(GATEWAY_INTERACTIVE_BURST_LIMIT),
    ));
    plan.extend(std::iter::repeat_n(
        GatewayWriterLane::Ingress,
        ingress_ready.min(GATEWAY_INGRESS_BURST_LIMIT),
    ));
    plan
}

fn gateway_frame_write_timeout(encoded_bytes: usize) -> Duration {
    let estimated = Duration::from_secs_f64(
        GATEWAY_WRITE_BASE_SECONDS + encoded_bytes as f64 / GATEWAY_WRITE_BYTES_PER_SECOND,
    );
    estimated
        .max(GATEWAY_WRITE_TIMEOUT_MIN)
        .min(GATEWAY_WRITE_TIMEOUT_MAX)
}

fn queued_envelope_message(queued: QueuedAgentEnvelope) -> WsMessage {
    encode_ws_frame(&v2::AgentClientFrame {
        payload: Some(v2::agent_client_frame::Payload::Envelope(queued.envelope)),
    })
}

async fn write_gateway_ws_message<S>(sink: &mut S, message: WsMessage) -> Result<(), String>
where
    S: futures_util::Sink<WsMessage> + Unpin,
    S::Error: std::fmt::Display,
{
    let encoded_bytes = message.len();
    let write_timeout = gateway_frame_write_timeout(encoded_bytes);
    match tokio::time::timeout(write_timeout, sink.send(message)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(format!("gateway ws writer failed: {error}")),
        Err(_) => Err(format!(
            "gateway ws frame write timed out after {:.3}s for {encoded_bytes} bytes",
            write_timeout.as_secs_f64()
        )),
    }
}

async fn run_gateway_writer<S>(
    mut sink: S,
    mut system_rx: mpsc::Receiver<WsMessage>,
    mut urgent_rx: mpsc::Receiver<QueuedAgentEnvelope>,
    mut interactive_rx: mpsc::Receiver<QueuedAgentEnvelope>,
    mut ingress_rx: mpsc::Receiver<QueuedAgentEnvelope>,
) -> Result<(), String>
where
    S: futures_util::Sink<WsMessage> + Unpin,
    S::Error: std::fmt::Display,
{
    loop {
        let plan = gateway_writer_round_plan(
            system_rx.len().saturating_add(urgent_rx.len()),
            interactive_rx.len(),
            ingress_rx.len(),
        );
        if !plan.is_empty() {
            for lane in plan {
                let message = match lane {
                    GatewayWriterLane::Urgent => system_rx
                        .try_recv()
                        .ok()
                        .or_else(|| urgent_rx.try_recv().ok().map(queued_envelope_message)),
                    GatewayWriterLane::Interactive => {
                        interactive_rx.try_recv().ok().map(queued_envelope_message)
                    }
                    GatewayWriterLane::Ingress => {
                        ingress_rx.try_recv().ok().map(queued_envelope_message)
                    }
                };
                if let Some(message) = message {
                    write_gateway_ws_message(&mut sink, message).await?;
                }
            }
            continue;
        }

        let message = tokio::select! {
            biased;
            message = system_rx.recv() => message,
            queued = urgent_rx.recv() => queued.map(queued_envelope_message),
            queued = interactive_rx.recv() => queued.map(queued_envelope_message),
            queued = ingress_rx.recv() => queued.map(queued_envelope_message),
        }
        .ok_or_else(|| "gateway outbound epoch closed".to_string())?;
        write_gateway_ws_message(&mut sink, message).await?;
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
        let (ws, server_hello) = match connect_result {
            None => return Ok(()),
            Some(established) => established?,
        };

        let (
            outbound_control_tx,
            outbound_tx,
            outbound_control_rx,
            outbound_interactive_rx,
            outbound_ingress_rx,
        ) = GatewayOutboundSender::agent_lanes();
        self.set_outbound_sender(Some(outbound_tx));
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
            let heartbeat_period = if server_hello.heartbeat_period_seconds > 0 {
                Duration::from_secs(u64::from(server_hello.heartbeat_period_seconds))
            } else {
                GATEWAY_WS_DEFAULT_HEARTBEAT_PERIOD
            };
            let idle_timeout = heartbeat_period * 3;

            let (ws_sink, mut ws_stream) = ws.split();
            let (system_write_tx, system_write_rx) = mpsc::channel::<WsMessage>(64);
            let (failure_tx, mut failure_rx) = mpsc::unbounded_channel::<String>();
            let (dispatch_tx, mut dispatch_rx) =
                mpsc::channel::<proto::GatewayEnvelope>(GATEWAY_INBOUND_DISPATCH_QUEUE_DEPTH);
            let (last_inbound_tx, last_inbound_rx) = watch::channel(Instant::now());

            let writer_failure_tx = failure_tx.clone();
            let writer_task = tauri::async_runtime::spawn(async move {
                if let Err(error) = run_gateway_writer(
                    ws_sink,
                    system_write_rx,
                    outbound_control_rx,
                    outbound_interactive_rx,
                    outbound_ingress_rx,
                )
                .await
                {
                    let _ = writer_failure_tx.send(error);
                }
            });

            let dispatcher = Arc::clone(self);
            let dispatcher_failure_tx = failure_tx.clone();
            let dispatcher_task = tauri::async_runtime::spawn(async move {
                while let Some(envelope) = dispatch_rx.recv().await {
                    if let Err(error) = dispatcher.handle_gateway_envelope(envelope).await {
                        let _ = dispatcher_failure_tx
                            .send(format!("gateway envelope dispatcher failed: {error}"));
                        break;
                    }
                }
            });

            let watchdog_write_tx = system_write_tx.clone();
            let watchdog_failure_tx = failure_tx.clone();
            let watchdog_task = tauri::async_runtime::spawn(async move {
                run_gateway_watchdog(
                    last_inbound_rx,
                    watchdog_write_tx,
                    watchdog_failure_tx,
                    idle_timeout,
                )
                .await;
            });

            let receive_result = loop {
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
                    failure = failure_rx.recv() => {
                        match failure {
                            Some(error) => break Err(error),
                            None => break Err("gateway websocket supervisor lost task status".to_string()),
                        }
                    }
                    message = ws_stream.next() => {
                        match message {
                            None => break Err("gateway ws stream closed".to_string()),
                            Some(Err(error)) => break Err(format!("gateway ws receive failed: {error}")),
                            Some(Ok(message)) => {
                                last_inbound_tx.send_replace(Instant::now());
                                match message {
                                    WsMessage::Binary(data) => {
                                        let frame: v2::AgentServerFrame = match decode_ws_frame(&data) {
                                            Ok(frame) => frame,
                                            Err(error) => break Err(error),
                                        };
                                        // 重复 hello 或空帧：忽略（服务端同样宽容）。
                                        if let Some(v2::agent_server_frame::Payload::Envelope(envelope)) = frame.payload {
                                            self.touch_heartbeat();
                                            if dispatch_tx.try_send(envelope).is_err() {
                                                break Err("gateway inbound dispatcher queue saturated".to_string());
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
                                    WsMessage::Ping(payload) => {
                                        if system_write_tx.try_send(WsMessage::Pong(payload)).is_err() {
                                            break Err("gateway websocket control writer saturated".to_string());
                                        }
                                    }
                                    WsMessage::Pong(_) => {}
                                    WsMessage::Frame(_) => {}
                                }
                            }
                        }
                    }
                }
            };
            drop(dispatch_tx);
            drop(system_write_tx);
            writer_task.abort();
            dispatcher_task.abort();
            watchdog_task.abort();
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
            if let Err(error) = controller.publish_current_managed_processes().await {
                eprintln!("publish gateway managed processes failed: {error}");
            }
            tokio::task::yield_now().await;
            if let Err(error) = controller.republish_chat_run_states().await {
                eprintln!("republish gateway chat run states failed: {error}");
            }
            tokio::task::yield_now().await;
            if let Err(error) = controller.reconcile_chat_ingress().await {
                eprintln!("reconcile gateway chat ingress failed: {error}");
            }
        })
    }

    pub(crate) async fn send_agent_envelope(
        &self,
        envelope: proto::AgentEnvelope,
    ) -> Result<(), String> {
        let sender = self.current_outbound_sender()?;
        send_agent_envelope_to(sender, envelope).await
    }

    pub(crate) async fn send_agent_ingress_envelope(
        &self,
        envelope: proto::AgentEnvelope,
    ) -> Result<(), String> {
        self.current_outbound_sender()?.send_ingress(envelope).await
    }

    pub(crate) fn current_outbound_sender(&self) -> Result<GatewayOutboundSender, String> {
        self.outbound_tx
            .lock()
            .map_err(|_| "gateway outbound sender lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "gateway outbound stream is offline".to_string())
    }

    pub(crate) fn current_outbound_control_sender(&self) -> Result<GatewayOutboundSender, String> {
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

    pub(crate) fn set_outbound_sender(&self, sender: Option<GatewayOutboundSender>) {
        if let Ok(mut slot) = self.outbound_tx.lock() {
            *slot = sender;
        }
    }

    pub(crate) fn set_outbound_control_sender(&self, sender: Option<GatewayOutboundSender>) {
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

    pub(crate) fn publish_disconnected_status(
        &self,
        config: &RemoteSettingsPayload,
        last_error: Option<String>,
    ) {
        self.publish_status(|status| set_disconnected_status(status, config, last_error));
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
                ssh_local_forward: None,
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
    sender: GatewayOutboundSender,
    envelope: proto::AgentEnvelope,
) -> Result<(), String> {
    sender.send(envelope).await
}

async fn run_gateway_watchdog(
    mut last_inbound_rx: watch::Receiver<Instant>,
    system_write_tx: mpsc::Sender<WsMessage>,
    failure_tx: mpsc::UnboundedSender<String>,
    idle_timeout: Duration,
) {
    loop {
        let deadline = *last_inbound_rx.borrow() + idle_timeout;
        tokio::select! {
            changed = last_inbound_rx.changed() => {
                if changed.is_err() {
                    return;
                }
                continue;
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {}
        }
        if system_write_tx
            .send(WsMessage::Ping(Vec::new().into()))
            .await
            .is_err()
        {
            return;
        }
        tokio::select! {
            changed = last_inbound_rx.changed() => {
                if changed.is_err() {
                    return;
                }
            }
            _ = tokio::time::sleep(GATEWAY_WS_PROBE_GRACE) => {
                let _ = failure_tx.send(format!(
                    "gateway ws link stale: no inbound frames for {}s",
                    idle_timeout.saturating_add(GATEWAY_WS_PROBE_GRACE).as_secs()
                ));
                return;
            }
        }
    }
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

#[cfg(test)]
mod transport_supervisor_tests {
    use super::*;

    fn test_envelope(message: &str) -> proto::AgentEnvelope {
        build_error_response_envelope("request-1".to_string(), 500, message.to_string())
    }

    #[tokio::test]
    async fn outbound_lane_enforces_and_releases_byte_budget() {
        let envelope = test_envelope("bounded");
        let bytes = GatewayOutboundSender::encoded_bytes(&envelope);
        let (sender, mut receiver) = GatewayOutboundSender::lane("test", 2, bytes);

        assert!(sender.try_send(envelope.clone()).is_ok());
        assert!(sender.try_send(envelope.clone()).is_err());

        drop(receiver.recv().await.expect("queued envelope"));
        assert!(sender.try_send(envelope).is_ok());
    }

    #[test]
    fn outbound_lane_rejects_a_frame_larger_than_its_budget() {
        let envelope = test_envelope(&"x".repeat(1024));
        let (sender, _receiver) = GatewayOutboundSender::lane("test", 1, 64);
        assert!(sender.try_send(envelope).is_err());
    }

    #[test]
    fn writer_round_prevents_ingress_starvation() {
        let plan = gateway_writer_round_plan(64, 100, 100);

        assert_eq!(plan.len(), 64 + 8 + 1);
        assert!(plan[..64]
            .iter()
            .all(|lane| *lane == GatewayWriterLane::Urgent));
        assert!(plan[64..72]
            .iter()
            .all(|lane| *lane == GatewayWriterLane::Interactive));
        assert_eq!(plan.last(), Some(&GatewayWriterLane::Ingress));
    }

    #[test]
    fn writer_round_caps_interactive_burst() {
        let plan = gateway_writer_round_plan(0, 100, 0);

        assert_eq!(plan, vec![GatewayWriterLane::Interactive; 8]);
    }

    #[test]
    fn dynamic_timeout_is_clamped() {
        assert_eq!(gateway_frame_write_timeout(0), Duration::from_secs(10));
        assert_eq!(
            gateway_frame_write_timeout(80 * 1024),
            Duration::from_secs(15)
        );
        assert_eq!(
            gateway_frame_write_timeout(1024 * 1024),
            Duration::from_secs(60)
        );
    }

    #[tokio::test]
    async fn ingress_budget_isolated_from_interactive() {
        let envelope = test_envelope("isolated");
        let bytes = GatewayOutboundSender::encoded_bytes(&envelope);
        let (mut interactive, _interactive_rx) =
            GatewayOutboundSender::lane("interactive", 2, bytes);
        let (ingress, mut ingress_rx) = GatewayOutboundSender::lane("ingress", 1, bytes);
        interactive.ingress_lane = Some(Arc::clone(&ingress.lane));

        assert!(interactive.try_send(envelope.clone()).is_ok());
        assert!(interactive.try_send(envelope.clone()).is_err());
        assert!(interactive.send_ingress(envelope).await.is_ok());
        assert!(ingress_rx.recv().await.is_some());
    }

    #[tokio::test]
    async fn dropping_epoch_receivers_rejects_all_lanes() {
        let (urgent, interactive, urgent_rx, interactive_rx, ingress_rx) =
            GatewayOutboundSender::agent_lanes();
        drop(urgent_rx);
        drop(interactive_rx);
        drop(ingress_rx);

        assert!(urgent.send(test_envelope("urgent")).await.is_err());
        assert!(interactive
            .send(test_envelope("interactive"))
            .await
            .is_err());
        assert!(interactive
            .send_ingress(test_envelope("ingress"))
            .await
            .is_err());
    }
}
