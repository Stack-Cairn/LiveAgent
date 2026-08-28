use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::Emitter;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::services::chat_run_ledger::ChatRunLedgerEntry;

use super::*;

impl GatewayController {
    pub(crate) async fn handle_chat_command(
        self: &Arc<Self>,
        request_id: String,
        command: proto::ChatCommandRequest,
    ) -> Result<(), String> {
        match command.r#type.trim() {
            "chat.submit" => {
                let Some(request) = command.request else {
                    return self
                        .send_gateway_chat_control_event_with_details(
                            request_id,
                            String::new(),
                            "failed",
                            "invalid_chat_command".to_string(),
                            "chat.submit requires request payload".to_string(),
                        )
                        .await;
                };
                let event_payload =
                    Self::build_gateway_chat_request_event(request_id, request, false, None);
                self.enqueue_gateway_chat_request(event_payload).await
            }
            "chat.edit_resend" => {
                let Some(request) = command.request else {
                    return self
                        .send_gateway_chat_control_event_with_details(
                            request_id,
                            String::new(),
                            "failed",
                            "invalid_chat_command".to_string(),
                            "chat.edit_resend requires request payload".to_string(),
                        )
                        .await;
                };
                let conversation_id = request.conversation_id.trim().to_string();
                let Some(base_message_ref) = command.base_message_ref else {
                    return self
                        .send_gateway_chat_control_event_with_details(
                            request_id,
                            conversation_id,
                            "failed",
                            "invalid_chat_command".to_string(),
                            "chat.edit_resend requires base_message_ref".to_string(),
                        )
                        .await;
                };
                if !is_complete_user_chat_message_ref(&base_message_ref) {
                    return self
                        .send_gateway_chat_control_event_with_details(
                            request_id,
                            conversation_id,
                            "failed",
                            "invalid_chat_command".to_string(),
                            "chat.edit_resend requires a complete stable base_message_ref"
                                .to_string(),
                        )
                        .await;
                }
                if conversation_id.is_empty() {
                    return self
                        .send_gateway_chat_control_event_with_details(
                            request_id,
                            String::new(),
                            "failed",
                            "invalid_chat_command".to_string(),
                            "chat.edit_resend requires conversation_id".to_string(),
                        )
                        .await;
                }
                let event_payload = Self::build_gateway_chat_request_event(
                    request_id,
                    request,
                    true,
                    Some(base_message_ref),
                );
                self.enqueue_gateway_chat_request(event_payload).await
            }
            "chat.cancel" => {
                let conversation_id = command
                    .cancel
                    .map(|cancel| cancel.conversation_id)
                    .or_else(|| command.request.map(|request| request.conversation_id))
                    .unwrap_or_default();
                self.cancel_remote_chat_request(&request_id, &conversation_id)?;
                self.send_gateway_chat_control_event(
                    request_id.clone(),
                    conversation_id.clone(),
                    "cancelled",
                )
                .await?;
                self.app_handle
                    .emit(
                        "gateway:chat-cancel",
                        GatewayChatCancelEvent {
                            request_id,
                            conversation_id,
                        },
                    )
                    .map_err(|e| format!("emit gateway chat cancel failed: {e}"))
            }
            other => {
                self.send_gateway_chat_control_event_with_details(
                    request_id,
                    command
                        .request
                        .map(|request| request.conversation_id)
                        .unwrap_or_default(),
                    "failed",
                    "unsupported_chat_command".to_string(),
                    format!("unsupported chat command: {other}"),
                )
                .await
            }
        }
    }

    pub(crate) async fn enqueue_gateway_chat_request(
        &self,
        event_payload: GatewayChatRequestEvent,
    ) -> Result<(), String> {
        let enqueue_outcome = self.enqueue_remote_chat_request(event_payload)?;
        if let Err(error) = self
            .send_gateway_chat_control_event(
                enqueue_outcome.request_id.clone(),
                enqueue_outcome.conversation_id.clone(),
                enqueue_outcome.control_type,
            )
            .await
        {
            if enqueue_outcome.inserted {
                self.remove_remote_chat_request(&enqueue_outcome.request_id)?;
            }
            return Err(error);
        }
        if enqueue_outcome.should_wake_runtime {
            self.app_handle
                .emit(
                    "gateway:chat-request-ready",
                    json!({ "requestId": enqueue_outcome.request_id }),
                )
                .map_err(|e| format!("emit gateway chat request ready failed: {e}"))?;
        }
        Ok(())
    }

    pub(crate) fn build_gateway_chat_request_event(
        request_id: String,
        request: proto::ChatRequest,
        rebased: bool,
        base_message_ref: Option<proto::ChatMessageRef>,
    ) -> GatewayChatRequestEvent {
        let proto::ChatRequest {
            conversation_id,
            client_request_id,
            message,
            selected_model,
            runtime_controls,
            execution_mode,
            workdir,
            command_safety_mode,
            uploaded_files,
            referenced_conversations,
            queue_policy,
        } = request;
        let selected_model = selected_model.map(|selected_model| GatewaySelectedModelEvent {
            custom_provider_id: selected_model.custom_provider_id,
            model: selected_model.model,
            provider_type: selected_model.provider_type,
        });
        let runtime_controls =
            runtime_controls.map(|runtime_controls| GatewayChatRuntimeControlsEvent {
                thinking_enabled: runtime_controls.thinking_enabled,
                native_web_search_enabled: runtime_controls.native_web_search_enabled,
                reasoning: runtime_controls.reasoning,
                plan_mode_enabled: runtime_controls.plan_mode_enabled,
            });
        let base_message_ref =
            base_message_ref.map(|base_message_ref| GatewayChatMessageRefEvent {
                segment_index: base_message_ref.segment_index,
                message_index: base_message_ref.message_index,
                segment_id: base_message_ref.segment_id,
                message_id: base_message_ref.message_id,
                role: base_message_ref.role,
                content_hash: base_message_ref.content_hash,
            });
        let current_conversation_id = conversation_id.trim();
        let mut seen_conversation_references = std::collections::HashSet::new();
        let referenced_conversations = referenced_conversations
            .into_iter()
            .filter_map(|reference| {
                let id = reference.id.trim().to_string();
                let title = reference
                    .title
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                if id.is_empty()
                    || title.is_empty()
                    || id == current_conversation_id
                    || id.chars().count() > 256
                    || id.chars().any(char::is_control)
                    || !seen_conversation_references.insert(id.clone())
                {
                    return None;
                }
                Some(GatewayConversationReferenceEvent {
                    id,
                    title: title.chars().take(240).collect(),
                    cwd: reference.cwd.trim().to_string(),
                    updated_at: reference.updated_at,
                })
            })
            .take(3)
            .collect();
        GatewayChatRequestEvent {
            request_id,
            conversation_id,
            client_request_id,
            message,
            rebased,
            base_message_ref,
            selected_model,
            runtime_controls,
            execution_mode,
            workdir,
            command_safety_mode,
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
            referenced_conversations,
            queue_policy,
        }
    }

    pub(crate) async fn send_gateway_chat_control_event(
        &self,
        request_id: String,
        conversation_id: String,
        event_type: &str,
    ) -> Result<(), String> {
        self.send_gateway_chat_control_event_with_details(
            request_id,
            conversation_id,
            event_type,
            String::new(),
            String::new(),
        )
        .await
    }

    pub(crate) async fn send_gateway_chat_control_event_with_details(
        &self,
        request_id: String,
        conversation_id: String,
        event_type: &str,
        error_code: String,
        message: String,
    ) -> Result<(), String> {
        self.send_agent_envelope(build_gateway_chat_control_event_envelope(
            request_id,
            conversation_id,
            event_type,
            error_code,
            message,
        ))
        .await
    }

    pub(crate) async fn handle_chat_queue_request(
        self: &Arc<Self>,
        request_id: String,
        request: proto::ChatQueueRequest,
    ) -> Result<(), String> {
        let event_payload = GatewayChatQueueRequestEvent {
            request_id: request_id.clone(),
            action: request.action,
            conversation_id: request.conversation_id,
            item_id: request.item_id,
            direction: request.direction,
            revision: request.revision,
            draft_json: request.draft_json,
            uploaded_files_json: request.uploaded_files_json,
            request_json: request.request_json,
        };

        let (tx, rx) = oneshot::channel();
        self.pending_chat_queue_requests
            .lock()
            .map_err(|_| "gateway chat queue request lock poisoned".to_string())?
            .insert(request_id.clone(), tx);

        if let Err(error) = self
            .app_handle
            .emit("gateway:chat-queue-request", event_payload)
        {
            let _ = self
                .pending_chat_queue_requests
                .lock()
                .map(|mut pending| pending.remove(&request_id));
            return self
                .send_chat_queue_response(
                    request_id,
                    proto::ChatQueueResponse {
                        accepted: false,
                        message: format!("emit gateway chat queue request failed: {error}"),
                        error_code: "emit_failed".to_string(),
                        ..Default::default()
                    },
                )
                .await;
        }

        let response = match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => proto::ChatQueueResponse {
                accepted: false,
                message: "chat queue response dropped".to_string(),
                error_code: "response_dropped".to_string(),
                ..Default::default()
            },
            Err(_) => {
                let _ = self
                    .pending_chat_queue_requests
                    .lock()
                    .map(|mut pending| pending.remove(&request_id));
                proto::ChatQueueResponse {
                    accepted: false,
                    message: "chat queue request timed out".to_string(),
                    error_code: "timeout".to_string(),
                    ..Default::default()
                }
            }
        };

        self.send_chat_queue_response(request_id, response).await
    }

    pub(crate) async fn send_chat_queue_response(
        &self,
        request_id: String,
        response: proto::ChatQueueResponse,
    ) -> Result<(), String> {
        self.send_agent_envelope(proto::AgentEnvelope {
            request_id,
            timestamp: now_unix_seconds(),
            payload: Some(proto::agent_envelope::Payload::ChatQueueResp(response)),
        })
        .await
    }

    pub fn respond_chat_queue_request(
        &self,
        input: GatewayChatQueueResponseInput,
    ) -> Result<(), String> {
        let request_id = input.request_id.trim().to_string();
        if request_id.is_empty() {
            return Err("chat queue request_id is required".to_string());
        }
        let sender = self
            .pending_chat_queue_requests
            .lock()
            .map_err(|_| "gateway chat queue request lock poisoned".to_string())?
            .remove(&request_id);
        if let Some(sender) = sender {
            let _ = sender.send(proto::ChatQueueResponse {
                accepted: input.accepted,
                message: input.message,
                snapshot_json: input.snapshot_json,
                item_json: input.item_json,
                error_code: input.error_code,
                revision: input.revision,
            });
        }
        Ok(())
    }

    pub async fn publish_chat_queue_event(
        &self,
        input: GatewayChatQueueEventInput,
    ) -> Result<(), String> {
        self.send_agent_envelope(proto::AgentEnvelope {
            request_id: format!("chat-queue-event-{}", Uuid::new_v4()),
            timestamp: now_unix_seconds(),
            payload: Some(proto::agent_envelope::Payload::ChatQueueEvent(
                proto::ChatQueueEvent {
                    conversation_id: input.conversation_id,
                    snapshot_json: input.snapshot_json,
                    revision: input.revision,
                },
            )),
        })
        .await
    }
}

pub(crate) fn build_gateway_chat_control_event_envelope(
    request_id: String,
    conversation_id: String,
    event_type: &str,
    error_code: String,
    message: String,
) -> proto::AgentEnvelope {
    let state = match event_type.trim() {
        "accepted" => "queued",
        "delivered" => "delivered",
        "claimed" => "claimed",
        "starting" => "starting",
        "started" => "running",
        "completed" => "completed",
        "failed" => "failed",
        "cancelled" => "cancelled",
        _ => "",
    }
    .to_string();
    proto::AgentEnvelope {
        request_id: request_id.clone(),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::ChatControl(
            proto::ChatControlEvent {
                request_id,
                conversation_id,
                r#type: event_type.trim().to_string(),
                state,
                error_code,
                message,
                ..Default::default()
            },
        )),
    }
}

pub(crate) fn build_gateway_runtime_status_envelope(
    worker_id: String,
    state: String,
    visible: bool,
    active_run_count: u32,
    active_runs: Vec<proto::ChatRunReport>,
    finished_runs: Vec<proto::ChatRunReport>,
) -> proto::AgentEnvelope {
    proto::AgentEnvelope {
        request_id: format!("runtime-status-{}", worker_id.trim()),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::RuntimeStatus(
            proto::RuntimeStatusEvent {
                worker_id,
                state,
                visible,
                active_run_count,
                timestamp: now_unix_seconds(),
                active_runs,
                finished_runs,
            },
        )),
    }
}

pub(crate) fn chat_run_report_from_entry(entry: &ChatRunLedgerEntry) -> proto::ChatRunReport {
    proto::ChatRunReport {
        run_id: entry.run_id.clone(),
        conversation_id: entry.conversation_id.clone(),
        state: entry.state.as_str().to_string(),
        error_code: entry.error_code.clone(),
        message: entry.message.clone(),
        updated_at: entry.updated_at_ms,
    }
}
