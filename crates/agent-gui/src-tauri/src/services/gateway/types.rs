use serde::{Deserialize, Serialize};

use super::*;

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
    /// 协议链路；当前连接固定为 "v2"（WebSocket+Protobuf），未连接时为 None。
    pub protocol: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySelectedModelEvent {
    pub custom_provider_id: String,
    pub model: String,
    pub provider_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatRuntimeControlsEvent {
    pub thinking_enabled: bool,
    pub native_web_search_enabled: bool,
    pub reasoning: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayUploadedFileEvent {
    pub relative_path: String,
    pub absolute_path: String,
    pub file_name: String,
    pub kind: String,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatMessageRefEvent {
    pub segment_index: i32,
    pub message_index: i32,
    pub segment_id: String,
    pub message_id: String,
    pub role: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatRequestEvent {
    pub request_id: String,
    pub conversation_id: String,
    pub client_request_id: String,
    pub message: String,
    pub rebased: bool,
    pub base_message_ref: Option<GatewayChatMessageRefEvent>,
    pub selected_model: Option<GatewaySelectedModelEvent>,
    pub runtime_controls: Option<GatewayChatRuntimeControlsEvent>,
    pub execution_mode: String,
    pub workdir: String,
    pub selected_system_tools: Vec<String>,
    pub uploaded_files: Vec<GatewayUploadedFileEvent>,
    pub queue_policy: String,
}

pub(crate) fn is_complete_user_chat_message_ref(ref_value: &proto::ChatMessageRef) -> bool {
    ref_value.segment_index >= 0
        && ref_value.message_index >= 0
        && !ref_value.segment_id.trim().is_empty()
        && !ref_value.message_id.trim().is_empty()
        && ref_value.role.trim() == "user"
        && !ref_value.content_hash.trim().is_empty()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewayChatCancelEvent {
    pub(crate) request_id: String,
    pub(crate) conversation_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatQueueRequestEvent {
    pub request_id: String,
    pub action: String,
    pub conversation_id: String,
    pub item_id: String,
    pub direction: String,
    pub revision: u64,
    pub draft_json: String,
    pub uploaded_files_json: String,
    pub request_json: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatQueueResponseInput {
    pub request_id: String,
    #[serde(default)]
    pub accepted: bool,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub snapshot_json: String,
    #[serde(default)]
    pub item_json: String,
    #[serde(default)]
    pub error_code: String,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatQueueEventInput {
    pub conversation_id: String,
    pub snapshot_json: String,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatRuntimeSnapshot {
    pub conversation_id: String,
    pub run_id: String,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub worker_id: Option<String>,
    pub state: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub entries_json: String,
    #[serde(default)]
    pub tool_status: Option<String>,
    #[serde(default)]
    pub tool_status_is_compaction: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatClaimedRequest {
    pub request_id: String,
    pub client_request_id: String,
    pub conversation_id: String,
    pub state: String,
    pub attempt: u32,
    pub lease_ms: u64,
    pub request: GatewayChatRequestEvent,
}

pub const CHAT_HISTORY_SYNC_EVENT: &str = "chat-history:changed";
pub const GATEWAY_SETTINGS_SYNC_EVENT: &str = "gateway:settings-sync";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHistorySyncConversation {
    pub id: String,
    pub title: String,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub selected_model_json: Option<String>,
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
