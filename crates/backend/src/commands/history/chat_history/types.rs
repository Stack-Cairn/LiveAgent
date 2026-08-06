// Deserialize 是为了事件消费者：history 变更事件把整个 summary 作为 payload 发出，
// 订阅方（Gateway 中继、将来的 WebSocket 后端）需要把它读回来。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySummary {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub selected_model_json: Option<String>,
    pub message_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_pinned: bool,
    pub pinned_at: Option<i64>,
    pub is_shared: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryListResponse {
    pub items: Vec<ChatHistorySummary>,
    pub total_count: i64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ChatHistoryListFilter {
    pub cwd: Option<String>,
    pub cwd_empty: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryWorkdirSummary {
    pub path: String,
    pub conversation_count: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryWorkdirsResponse {
    pub workdirs: Vec<ChatHistoryWorkdirSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySegmentRecord {
    pub segment_index: i64,
    pub segment_id: String,
    pub summary_json: Option<String>,
    pub messages_json: String,
    pub message_count: i64,
    pub start_message_id: Option<String>,
    pub end_message_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryRecord {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub selected_model_json: Option<String>,
    pub context_meta_json: String,
    pub active_segment_index: i64,
    pub total_segment_count: i64,
    pub total_message_count: i64,
    pub segments: Vec<ChatHistorySegmentRecord>,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_pinned: bool,
    pub pinned_at: Option<i64>,
    pub is_shared: bool,
    pub redact_tool_content: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryShareStatus {
    pub conversation_id: String,
    pub enabled: bool,
    pub token: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub redact_tool_content: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryMessageRef {
    pub segment_index: i64,
    pub message_index: i64,
    pub segment_id: String,
    pub message_id: String,
    pub role: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySegmentWindowRecord {
    pub segment_index: i64,
    pub segment_id: String,
    pub summary_json: Option<String>,
    pub messages_json: String,
    pub start_message_index: i64,
    pub message_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryWindowRecord {
    pub conversation: ChatHistorySummary,
    pub segments: Vec<ChatHistorySegmentWindowRecord>,
    pub active_segment: Option<ChatHistorySegmentRecord>,
    pub context_meta_json: String,
    pub active_segment_index: i64,
    pub total_segment_count: i64,
    pub total_message_count: i64,
    pub returned_message_count: i64,
    pub oldest_offset: i64,
    pub has_more_before: bool,
    pub revision: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySegmentInput {
    pub segment_index: i64,
    pub segment_id: String,
    pub summary_json: Option<String>,
    pub messages_json: String,
    pub message_count: i64,
    pub start_message_id: Option<String>,
    pub end_message_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryUpsertInput {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub selected_model_json: Option<String>,
    pub context_meta_json: String,
    pub active_segment_index: i64,
    pub total_segment_count: i64,
    pub total_message_count: i64,
    pub segments: Vec<ChatHistorySegmentInput>,
    pub created_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryConversationInput {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub selected_model_json: Option<String>,
    pub context_meta_json: String,
    pub active_segment_index: i64,
    pub total_segment_count: i64,
    pub total_message_count: i64,
    pub created_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySegmentMutationInput {
    pub conversation: ChatHistoryConversationInput,
    pub segment: ChatHistorySegmentInput,
}

#[derive(Debug, Clone)]
struct ChatHistoryFtsConversationInfo {
    id: String,
    title: String,
    cwd: Option<String>,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct ChatHistoryFtsSegmentRecord {
    conversation: ChatHistoryFtsConversationInfo,
    segment: ChatHistorySegmentInput,
}

#[derive(Debug, Clone)]
struct SearchableHistoryMessage {
    message_index: i64,
    message_id: Option<String>,
    role: Option<String>,
    text: String,
    updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistorySearchTimeMode {
    Message,
    Updated,
    Conversation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HistorySearchFilter {
    since: Option<i64>,
    until: Option<i64>,
    time_mode: HistorySearchTimeMode,
}
