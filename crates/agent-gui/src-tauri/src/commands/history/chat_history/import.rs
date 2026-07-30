// Unified data model and persistence core shared by every provider importer
// (codex, claude_code, claude_official). Each provider supplies:
//   - how to locate & parse its source
//   - three scalars via `ImportProviderConfig` (provider_id, id prefix, model)
// Writing the conversation to the database is identical across providers, so it
// lives here exactly once.

use super::*;
use std::collections::HashSet;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportResult {
    pub scanned_count: usize,
    pub imported_count: usize,
    pub skipped_lines: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportPreview {
    pub sessions: Vec<ImportConversation>,
    pub scanned_count: usize,
    pub skipped_lines: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportConversation {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub model: String,
    pub cwd: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip)]
    pub messages: Vec<Value>,
    pub message_count: usize,
    pub already_imported: bool,
}

pub(crate) struct ImportProviderConfig {
    provider_id: &'static str,
    id_prefix: &'static str,
    selected_model_json: Option<String>,
}

impl ImportProviderConfig {
    pub(crate) fn codex(model: &str) -> Self {
        Self {
            provider_id: "codex",
            id_prefix: "codex",
            selected_model_json: Some(make_selected_model_json("codex", model)),
        }
    }
    pub(crate) fn claude_code(model: &str) -> Self {
        Self {
            provider_id: "claude_code",
            id_prefix: "claude-code",
            selected_model_json: Some(make_selected_model_json("builtin-claude_code", model)),
        }
    }
    pub(crate) fn claude_official() -> Self {
        Self {
            provider_id: "claude_official",
            id_prefix: "claude-official",
            selected_model_json: None,
        }
    }
    pub(crate) fn id_prefix_with(&self, session_id: &str) -> String {
        format!("{}:{session_id}", self.id_prefix)
    }
    pub(crate) fn api(&self) -> &'static str {
        match self.provider_id {
            "codex" => "openai-responses",
            _ => "anthropic-messages",
        }
    }
    pub(crate) fn message_provider(&self) -> &'static str {
        match self.provider_id {
            "codex" => "codex",
            _ => "claude_code",
        }
    }
}

fn make_selected_model_json(provider_id: &str, model: &str) -> String {
    serde_json::json!({ "customProviderId": provider_id, "model": model }).to_string()
}

pub(crate) fn import_conversation(
    config: &ImportProviderConfig,
    conn: &mut Connection,
    conversation: ImportConversation,
) -> Result<(ChatHistorySummary, bool), String> {
    if let Ok(summary) = get_summary_by_id(conn, &conversation.id) {
        return Ok((summary, false));
    }
    let messages_json = serde_json::to_string(&conversation.messages)
        .map_err(|error| format!("序列化 {} 会话消息失败：{error}", config.provider_id))?;
    let message_count = conversation.message_count as i64;
    let segment_id = format!("{}:segment:0", conversation.id);
    let start_message_id = conversation
        .messages
        .first()
        .and_then(|message| message.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let end_message_id = conversation
        .messages
        .last()
        .and_then(|message| message.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let input = ChatHistoryUpsertInput {
        id: conversation.id,
        title: conversation.title,
        provider_id: config.provider_id.to_string(),
        model: conversation.model,
        session_id: Some(conversation.session_id),
        cwd: conversation.cwd,
        selected_model_json: config.selected_model_json.clone(),
        context_meta_json: serde_json::json!({
            "schemaVersion": 3,
            "activeSegmentIndex": 0,
            "totalSegmentCount": 1,
            "totalMessageCount": message_count
        })
        .to_string(),
        active_segment_index: 0,
        total_segment_count: 1,
        total_message_count: message_count,
        segments: vec![ChatHistorySegmentInput {
            segment_index: 0,
            segment_id,
            summary_json: None,
            messages_json,
            message_count,
            start_message_id,
            end_message_id,
            created_at: conversation.created_at,
            updated_at: conversation.updated_at,
        }],
        created_at: Some(conversation.created_at),
        updated_at: conversation.updated_at,
    };
    validate_upsert_input(&input)?;
    let conversation_input = ChatHistoryConversationInput {
        id: input.id.clone(),
        title: input.title,
        provider_id: input.provider_id,
        model: input.model,
        session_id: input.session_id,
        cwd: input.cwd,
        selected_model_json: input.selected_model_json,
        context_meta_json: input.context_meta_json.clone(),
        active_segment_index: input.active_segment_index,
        total_segment_count: input.total_segment_count,
        total_message_count: input.total_message_count,
        created_at: input.created_at,
        updated_at: input.updated_at,
    };
    let tx = conn
        .transaction()
        .map_err(|error| format!("开启 {} 导入事务失败：{error}", config.provider_id))?;
    upsert_chat_history_header(&tx, &conversation_input)?;
    sync_segments(
        &tx,
        input.id.trim(),
        &input.segments,
        input.total_segment_count,
    )?;
    verify_chat_history_consistency(&tx, input.id.trim())?;
    tx.commit()
        .map_err(|error| format!("提交 {} 导入事务失败：{error}", config.provider_id))?;
    Ok((get_summary_by_id(conn, input.id.trim())?, true))
}

pub(crate) async fn run_import(
    config: ImportProviderConfig,
    conversations: Vec<ImportConversation>,
    skipped_lines: usize,
    selected: HashSet<String>,
    gateway_controller: &Arc<GatewayController>,
) -> Result<ImportResult, String> {
    let scanned_count = conversations.len();
    let provider_id = config.provider_id.to_string();
    let summaries = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        let summaries = conversations
            .into_iter()
            .filter(|conversation| selected.contains(&conversation.id))
            .map(|conversation| import_conversation(&config, &mut conn, conversation))
            .collect::<Result<Vec<_>, _>>()?;
        Ok::<_, String>(summaries)
    })
    .await
    .map_err(|error| format!("{provider_id} 导入失败：{error}"))??;
    let mut imported_count = 0;
    for (summary, did_insert) in &summaries {
        if *did_insert {
            gateway_controller
                .publish_history_sync(build_history_sync_upsert(summary))
                .await;
            imported_count += 1;
        }
    }
    Ok(ImportResult {
        scanned_count,
        imported_count,
        skipped_lines,
    })
}

pub(crate) async fn scan_preview_command<F>(
    scan: F,
    error_label: &str,
) -> Result<ImportPreview, String>
where
    F: FnOnce() -> Result<(Vec<ImportConversation>, usize, usize), String> + Send + 'static,
{
    let (sessions, scanned_count, skipped_lines) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let (conversations, scanned_count, skipped_lines) = scan()?;
            let conn = open_db()?;
            let sessions = conversations
                .into_iter()
                .map(|mut conversation| {
                    conversation.already_imported =
                        get_summary_by_id(&conn, &conversation.id).is_ok();
                    conversation
                })
                .collect();
            Ok::<_, String>((sessions, scanned_count, skipped_lines))
        })
        .await
        .map_err(|error| format!("{error_label} 扫描失败：{error}"))??;
    Ok(ImportPreview {
        sessions,
        scanned_count,
        skipped_lines,
    })
}

pub(crate) async fn import_selected_command<F>(
    scan: F,
    config: ImportProviderConfig,
    ids: Vec<String>,
    gateway_controller: &Arc<GatewayController>,
) -> Result<ImportResult, String>
where
    F: FnOnce() -> Result<(Vec<ImportConversation>, usize, usize), String> + Send + 'static,
{
    let selected: HashSet<String> = ids.into_iter().filter(|id| !id.trim().is_empty()).collect();
    let (conversations, _scanned_count, skipped_lines) = tauri::async_runtime::spawn_blocking(scan)
        .await
        .map_err(|error| format!("{} 扫描失败：{error}", config.provider_id))??;
    run_import(
        config,
        conversations,
        skipped_lines,
        selected,
        gateway_controller,
    )
    .await
}

pub(crate) fn parse_jsonl_lines(text: &str) -> (Vec<(String, Value)>, usize) {
    let mut rows = Vec::new();
    let mut skipped_lines = 0;
    for line in text.lines() {
        match serde_json::from_str::<Value>(line) {
            Ok(row) if row.get("type").and_then(Value::as_str).is_some() => {
                rows.push((import_string(row.get("timestamp")).unwrap_or_default(), row));
            }
            _ => skipped_lines += 1,
        }
    }
    (rows, skipped_lines)
}

pub(crate) fn user_message(id: String, content: Vec<Value>, timestamp: i64) -> Value {
    serde_json::json!({ "role": "user", "id": id, "content": content, "timestamp": timestamp })
}

pub(crate) fn assistant_message(
    id: String,
    config: &ImportProviderConfig,
    model: &str,
    content: Vec<Value>,
    stop_reason: &str,
    timestamp: i64,
) -> Value {
    serde_json::json!({
        "role": "assistant",
        "id": id,
        "content": content,
        "api": config.api(),
        "provider": config.message_provider(),
        "model": model,
        "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0 },
        "stopReason": stop_reason,
        "timestamp": timestamp
    })
}

pub(crate) fn tool_result_message(
    id: String,
    tool_call_id: String,
    tool_name: String,
    content: Vec<Value>,
    is_error: bool,
    timestamp: i64,
) -> Value {
    serde_json::json!({
        "role": "toolResult",
        "id": id,
        "toolCallId": tool_call_id,
        "toolName": tool_name,
        "content": content,
        "isError": is_error,
        "timestamp": timestamp
    })
}

pub(crate) fn finalize_import_conversation(
    config: &ImportProviderConfig,
    session_id: String,
    model: String,
    cwd: Option<String>,
    created_at: i64,
    updated_at: i64,
    title: Option<String>,
    messages: Vec<Value>,
) -> Option<ImportConversation> {
    if messages.is_empty() {
        return None;
    }
    let first_user_text = messages.iter().find_map(|message| {
        if message.get("role")?.as_str()? != "user" {
            return None;
        }
        message.get("content")?.as_array().map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text")?.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
    });
    let title = title
        .filter(|title| !title.trim().is_empty())
        .or_else(|| first_user_text.map(|text| text.chars().take(80).collect()))
        .unwrap_or_else(|| format!("{} {}", config.message_provider(), session_id));
    let message_count = messages.len();
    Some(ImportConversation {
        id: config.id_prefix_with(&session_id),
        session_id,
        title,
        model,
        cwd,
        created_at,
        updated_at,
        messages,
        message_count,
        already_imported: false,
    })
}

pub(crate) fn import_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn import_timestamp(value: Option<&str>) -> Option<i64> {
    value.and_then(|value| {
        chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|date| date.timestamp_millis())
    })
}

pub(crate) fn import_text_blocks(value: Option<&Value>, allowed: &[&str]) -> Vec<Value> {
    let Some(value) = value else {
        return Vec::new();
    };
    let values = value
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![value.clone()]);
    values
        .into_iter()
        .filter_map(|value| match value {
            Value::String(text) if !text.is_empty() => {
                Some(serde_json::json!({ "type": "text", "text": text }))
            }
            Value::Object(object) => {
                let kind = object
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if allowed.contains(&kind) {
                    object
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                        .map(|text| serde_json::json!({ "type": "text", "text": text }))
                } else {
                    None
                }
            }
            _ => None,
        })
        .collect()
}
