// Unified data model and persistence core shared by every provider importer
// (codex, claude_code, claude_official). Each provider only supplies:
//   - how to locate & parse its source into `ImportConversation` (`scan_*`)
//   - three scalars via `ImportProviderConfig` (provider_id, id prefix, model)
// Writing the conversation to the database is identical across providers, so it
// lives here exactly once.
//
// This is a real submodule of `chat_history`; `use super::*` gives us the
// parent's DB helpers (`get_summary_by_id`, `open_db`, `now_ms`, …) and types
// (`ChatHistorySummary`, `ChatHistoryUpsertInput`, …) without `include!`'s flat
// namespace.

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

/// The resolved payload of one source conversation. Fields map 1:1 to the
/// `ChatHistoryUpsertInput` we persist, except for the helpers (`messages`,
/// `already_imported`) that the DB write does not round-trip.
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

/// The only per-provider variation in the persistence path: which `provider_id`
/// and which `id` prefix the live-agent conversation gets, plus the
/// `selectedModelJson` written to the header. The model string itself comes
/// from the parser and is carried on each [`ImportConversation`].
pub(crate) struct ImportProviderConfig {
    provider_id: &'static str,
    id_prefix: &'static str,
    /// `selectedModelJson` written to the header. `None` leaves it null (claude
    /// official has no model selector of its own).
    selected_model_json: Option<String>,
}

impl ImportProviderConfig {
    /// Codex: live-agent conversations imported with the `codex` provider.
    pub(crate) fn codex(model: &str) -> Self {
        Self {
            provider_id: "codex",
            id_prefix: "codex",
            selected_model_json: Some(make_selected_model_json("codex", model)),
        }
    }
    /// Claude Code (`~/.claude/projects`) backed by a builtin provider.
    pub(crate) fn claude_code(model: &str) -> Self {
        Self {
            provider_id: "claude_code",
            id_prefix: "claude-code",
            selected_model_json: Some(make_selected_model_json("builtin-claude_code", model)),
        }
    }
    /// Claude official data export: no model selector, lives under its own provider.
    pub(crate) fn claude_official() -> Self {
        Self {
            provider_id: "claude_official",
            id_prefix: "claude-official",
            selected_model_json: None,
        }
    }
    /// Build the live-agent conversation id `<id_prefix>:<session_id>`.
    pub(crate) fn id_prefix_with(&self, session_id: &str) -> String {
        format!("{}:{session_id}", self.id_prefix)
    }
}

fn make_selected_model_json(provider_id: &str, model: &str) -> String {
    serde_json::json!({ "customProviderId": provider_id, "model": model }).to_string()
}

/// `import_*_conversation`, unified. Returns the persisted summary plus whether
/// the row was actually inserted (`false` when it was already present, so the
/// caller can skip the history-sync broadcast).
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
    let start_message_id = conversation.messages.first().and_then(|message| message.get("id")).and_then(Value::as_str).map(str::to_string);
    let end_message_id = conversation.messages.last().and_then(|message| message.get("id")).and_then(Value::as_str).map(str::to_string);
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
        }).to_string(),
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
    let tx = conn.transaction().map_err(|error| format!("开启 {} 导入事务失败：{error}", config.provider_id))?;
    upsert_chat_history_header(&tx, &conversation_input)?;
    sync_segments(&tx, input.id.trim(), &input.segments, input.total_segment_count)?;
    verify_chat_history_consistency(&tx, input.id.trim())?;
    tx.commit().map_err(|error| format!("提交 {} 导入事务失败：{error}", config.provider_id))?;
    Ok((get_summary_by_id(conn, input.id.trim())?, true))
}

/// Shared tail of every `import_*` tauri command: filter to selected ids, write
/// each via the unified path, then broadcast history-sync for rows that were
/// actually inserted. `scanned_count` is every conversation the parser produced
/// (selected or not); `skipped_lines` is parser-rejected source rows. Both pass
/// straight through to the result; the DB write only touches selected ids.
pub(crate) async fn run_import(
    config: ImportProviderConfig,
    conversations: Vec<ImportConversation>,
    skipped_lines: usize,
    selected: HashSet<String>,
    gateway_controller: &Arc<GatewayController>,
) -> Result<ImportResult, String> {
    let scanned_count = conversations.len();
    let provider_label = config.provider_id.to_string();
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
    .map_err(|error| format!("{} 导入失败：{error}", provider_label))??;
    let mut imported_count = 0;
    for (summary, did_insert) in &summaries {
        if *did_insert {
            gateway_controller.publish_history_sync(build_history_sync_upsert(summary)).await;
            imported_count += 1;
        }
    }
    Ok(ImportResult {
        scanned_count,
        imported_count,
        skipped_lines,
    })
}

// ---- small JSON helpers shared by the raw formatters ------------------------

/// Trimmed non-empty string, or `None`.
pub(crate) fn import_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// RFC-3339 timestamp → epoch millis.
pub(crate) fn import_timestamp(value: Option<&str>) -> Option<i64> {
    value.and_then(|value| {
        chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|date| date.timestamp_millis())
    })
}

/// Extract `{type:"text"}` blocks from either a string or an array of content
/// blocks, dropping empty text. Shared by every provider's text extraction.
pub(crate) fn import_text_blocks(value: Option<&Value>) -> Vec<Value> {
    let Some(value) = value else { return Vec::new() };
    let values = value.as_array().cloned().unwrap_or_else(|| vec![value.clone()]);
    values
        .into_iter()
        .filter_map(|value| match value {
            Value::String(text) if !text.is_empty() => {
                Some(serde_json::json!({ "type": "text", "text": text }))
            }
            Value::Object(object) if object.get("type").and_then(Value::as_str) == Some("text") => {
                object
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .map(|text| serde_json::json!({ "type": "text", "text": text }))
            }
            _ => None,
        })
        .collect()
}

/// Build an assistant `message` JSON object with the Anthropic Messages shape.
/// Shared by the Claude Code and Claude-official parsers (both feed Anthropic
/// transcripts); Codex builds its own `openai-responses` variant locally.
pub(crate) fn claude_code_assistant(
    id: String,
    content: Vec<Value>,
    model: &str,
    timestamp: i64,
    stop_reason: &str,
) -> Value {
    serde_json::json!({
        "role": "assistant",
        "id": id,
        "content": content,
        "api": "anthropic-messages",
        "provider": "claude_code",
        "model": model,
        "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0 },
        "stopReason": stop_reason,
        "timestamp": timestamp
    })
}

#[cfg(test)]
mod import_tests {
    use super::*;

    #[test]
    fn selected_model_json_pairs_custom_provider_with_model() {
        let json = make_selected_model_json("codex", "gpt-5");
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["customProviderId"], "codex");
        assert_eq!(value["model"], "gpt-5");
    }
}