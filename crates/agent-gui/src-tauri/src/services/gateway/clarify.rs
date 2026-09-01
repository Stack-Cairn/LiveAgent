//! 澄清轮次 unary 桥（Web 计划 2）+ 流式增量。
//!
//! Web 端经 gateway 转发 `ClarifyTurnRequest` 到桌面 agent。Rust 收到后把请求
//! 以 `gateway:clarify-turn-requested` 事件发到 TS 运行时执行 LLM 补全；流式
//! 增量经 `gateway_clarify_delta` 以同 request_id 的 `ClarifyTurnDelta` 回推，
//! 终稿经 `gateway_clarify_respond` 回 `ClarifyTurnResp`。delta 不得占用 unary
//! 等待的首条关联响应。

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::oneshot;

use super::GatewayChatRuntimeControlsEvent;
use super::GatewayController;
use super::proto::{
    agent_envelope, AgentEnvelope, ClarifyTurnDelta, ClarifyTurnRequest, ClarifyTurnResponse,
};
use super::util::now_unix_seconds;

pub(crate) const GATEWAY_CLARIFY_TURN_REQUESTED_EVENT: &str = "gateway:clarify-turn-requested";

/// Rust → TS 的澄清轮次事件载荷。runtime_controls 以 JSON 字符串传递，
/// TS 侧 parse 回 ChatRuntimeControls（复用 agent-ui 的 normalize 逻辑）。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayClarifyTurnRequestEvent {
    pub request_id: String,
    pub messages_json: String,
    pub provider_id: String,
    pub model: String,
    pub runtime_controls_json: String,
}

/// TS 侧经 invoke gateway_clarify_respond 回传的结果。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayClarifyRespondInput {
    pub request_id: String,
    pub final_text: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

/// TS 侧经 invoke gateway_clarify_delta 回传的流式增量。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayClarifyDeltaInput {
    pub request_id: String,
    pub text: String,
}

impl GatewayClarifyTurnRequestEvent {
    pub(crate) fn from_request(request_id: String, request: ClarifyTurnRequest) -> Self {
        let runtime_controls_json = request
            .runtime_controls
            .map(|runtime_controls| {
                serde_json::to_string(&GatewayChatRuntimeControlsEvent {
                    thinking_enabled: runtime_controls.thinking_enabled,
                    native_web_search_enabled: runtime_controls.native_web_search_enabled,
                    reasoning: runtime_controls.reasoning,
                    plan_mode_enabled: runtime_controls.plan_mode_enabled,
                })
                .unwrap_or_default()
            })
            .unwrap_or_default();
        Self {
            request_id,
            messages_json: request.messages_json,
            provider_id: request.provider_id,
            model: request.model,
            runtime_controls_json,
        }
    }
}

/// 三个失败出口（emit 失败/发送端悬垂/超时）共用的错误响应。
fn clarify_error_response(code: &str, message: String) -> ClarifyTurnResponse {
    ClarifyTurnResponse {
        final_text: String::new(),
        error_code: code.to_string(),
        error_message: message,
    }
}

impl From<GatewayClarifyRespondInput> for ClarifyTurnResponse {
    fn from(input: GatewayClarifyRespondInput) -> Self {
        ClarifyTurnResponse {
            final_text: input.final_text.unwrap_or_default(),
            error_code: input.error_code.unwrap_or_default(),
            error_message: input.error_message.unwrap_or_default(),
        }
    }
}

impl GatewayController {
    pub(crate) async fn handle_clarify_turn(
        self: &Arc<Self>,
        request_id: String,
        request: ClarifyTurnRequest,
    ) -> Result<(), String> {
        let event_payload = GatewayClarifyTurnRequestEvent::from_request(request_id.clone(), request);

        let (tx, rx) = oneshot::channel();
        self.pending_clarify_turns
            .lock()
            .map_err(|_| "gateway clarify turn lock poisoned".to_string())?
            .insert(request_id.clone(), tx);

        if let Err(error) = self
            .app_handle
            .emit(GATEWAY_CLARIFY_TURN_REQUESTED_EVENT, event_payload)
        {
            let _ = self
                .pending_clarify_turns
                .lock()
                .map(|mut pending| pending.remove(&request_id));
            return self
                .send_clarify_turn_response(
                    request_id,
                    clarify_error_response(
                        "emit_failed",
                        format!("emit gateway clarify turn failed: {error}"),
                    ),
                )
                .await;
        }

        let response = match tokio::time::timeout(Duration::from_secs(120), rx).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => clarify_error_response(
                "response_dropped",
                "clarify turn response dropped".to_string(),
            ),
            Err(_) => {
                let _ = self
                    .pending_clarify_turns
                    .lock()
                    .map(|mut pending| pending.remove(&request_id));
                clarify_error_response("timeout", "clarify turn timed out".to_string())
            }
        };

        self.send_clarify_turn_response(request_id, response).await
    }

    pub(crate) async fn send_clarify_turn_response(
        &self,
        request_id: String,
        response: ClarifyTurnResponse,
    ) -> Result<(), String> {
        self.send_agent_envelope(AgentEnvelope {
            request_id,
            timestamp: now_unix_seconds(),
            payload: Some(agent_envelope::Payload::ClarifyTurnResp(response)),
        })
        .await
    }

    pub(crate) async fn send_clarify_turn_delta(
        &self,
        request_id: String,
        text: String,
    ) -> Result<(), String> {
        let pending = self
            .pending_clarify_turns
            .lock()
            .map_err(|_| "gateway clarify turn lock poisoned".to_string())?
            .contains_key(&request_id);
        if !pending {
            return Ok(());
        }
        self.send_agent_envelope(AgentEnvelope {
            request_id,
            timestamp: now_unix_seconds(),
            payload: Some(agent_envelope::Payload::ClarifyTurnDelta(ClarifyTurnDelta {
                text,
            })),
        })
        .await
    }

    pub(crate) fn respond_clarify_turn(
        &self,
        input: GatewayClarifyRespondInput,
    ) -> Result<(), String> {
        let Some(tx) = self
            .pending_clarify_turns
            .lock()
            .map_err(|_| "gateway clarify turn lock poisoned".to_string())?
            .remove(&input.request_id)
        else {
            return Ok(()); // 已超时/已移除：静默丢弃迟到的响应。
        };
        tx.send(ClarifyTurnResponse::from(input))
            .map_err(|_| "gateway clarify turn response receiver dropped".to_string())
    }
}
