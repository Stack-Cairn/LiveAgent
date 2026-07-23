use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
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
            selected_system_tools,
            uploaded_files,
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

pub(crate) fn chat_event_type(event: &Value) -> Option<&str> {
    event.get("type").and_then(Value::as_str).map(str::trim)
}

pub(crate) fn chat_event_is_terminal(event: &Value) -> bool {
    matches!(chat_event_type(event), Some("done") | Some("error"))
}

pub(crate) fn chat_event_conversation_id(event: &Value) -> String {
    event
        .as_object()
        .and_then(|object| {
            optional_string_field(object, "conversation_id")
                .or_else(|| optional_string_field(object, "conversationId"))
        })
        .unwrap_or_default()
}

pub(crate) fn build_chat_event_envelope(
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
        "tool_call" | "tool_call_delta" => (
            proto::chat_event::ChatEventType::ToolCall as i32,
            json!({
                "type": event_type,
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
        "user_message" => (
            proto::chat_event::ChatEventType::UserMessage as i32,
            json!({
                "message": required_raw_string_field(object, "message")?,
                "message_id": optional_string_field(object, "message_id")
                    .or_else(|| optional_string_field(object, "messageId")),
                "uploaded_files": object.get("uploaded_files")
                    .or_else(|| object.get("uploadedFiles"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "execution_mode": optional_string_field(object, "execution_mode")
                    .or_else(|| optional_string_field(object, "executionMode")),
                "workdir": optional_string_field(object, "workdir"),
                "selected_system_tools": object.get("selected_system_tools")
                    .or_else(|| object.get("selectedSystemTools"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "runtime_controls": object.get("runtime_controls")
                    .or_else(|| object.get("runtimeControls"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "selected_model": object.get("selected_model")
                    .or_else(|| object.get("selectedModel"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "message_ref": object.get("message_ref")
                    .or_else(|| object.get("messageRef"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "base_message_ref": object.get("base_message_ref")
                    .or_else(|| object.get("baseMessageRef"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "reason": optional_string_field(object, "reason"),
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
                // Optional stream-retry history (array of {attempt,
                // maxAttempts, errorMessage}); absent/null means "unchanged"
                // on the WebUI, an empty array clears its list.
                "retryAttempts": object.get("retryAttempts").cloned().unwrap_or(Value::Null),
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

pub(crate) fn build_chat_runtime_snapshot_envelope(
    snapshot: GatewayChatRuntimeSnapshot,
) -> Result<proto::AgentEnvelope, String> {
    let conversation_id = snapshot.conversation_id.trim().to_string();
    if conversation_id.is_empty() {
        return Err("chat runtime snapshot conversation_id is required".to_string());
    }

    let run_id = snapshot.run_id.trim().to_string();
    if run_id.is_empty() {
        return Err("chat runtime snapshot run_id is required".to_string());
    }

    let state = snapshot.state.trim().to_string();
    if state.is_empty() {
        return Err("chat runtime snapshot state is required".to_string());
    }

    let updated_at = if snapshot.updated_at > 0 {
        snapshot.updated_at
    } else {
        chrono::Utc::now().timestamp_millis()
    };

    Ok(proto::AgentEnvelope {
        request_id: format!("chat-runtime-snapshot-{}-{}", run_id, snapshot.revision),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::ChatRuntimeSnapshot(
            proto::ChatRuntimeSnapshot {
                conversation_id,
                run_id,
                client_request_id: snapshot.client_request_id.unwrap_or_default(),
                worker_id: snapshot.worker_id.unwrap_or_default(),
                state,
                cwd: snapshot.cwd.unwrap_or_default(),
                updated_at,
                revision: snapshot.revision,
                entries_json: snapshot.entries_json,
                tool_status: snapshot.tool_status.unwrap_or_default(),
                tool_status_is_compaction: snapshot.tool_status_is_compaction,
            },
        )),
    })
}
