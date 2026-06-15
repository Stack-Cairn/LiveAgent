use chrono::{Local, LocalResult, NaiveDate, TimeZone};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    commands::{history_db, subagent_history},
    services::{
        gateway::{build_history_sync_delete, build_history_sync_upsert, GatewayController},
        memory::{MemoryHistorySearchMatch, MemorySearchArgs},
    },
};
use uuid::Uuid;

const HISTORY_SHARE_TOKEN_LEN: usize = 9;
const HISTORY_SHARE_TOKEN_INSERT_ATTEMPTS: usize = 8;
const HISTORY_SHARE_TOKEN_ALPHABET: &[u8] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CHAT_HISTORY_FTS_REFRESH_BATCH_SIZE: usize = 8;
const DEFAULT_HISTORY_SEARCH_LIMIT: usize = 6;
const MAX_HISTORY_SEARCH_LIMIT: usize = 12;
const MAX_HISTORY_LIST_LIMIT: i64 = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySummary {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryActiveSegmentRecord {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub context_meta_json: String,
    pub active_segment_index: i64,
    pub total_segment_count: i64,
    pub total_message_count: i64,
    pub active_segment: ChatHistorySegmentRecord,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_pinned: bool,
    pub pinned_at: Option<i64>,
    pub is_shared: bool,
}

#[derive(Debug, Clone)]
pub struct ChatHistoryTruncateResult {
    pub summary: ChatHistorySummary,
    pub record: ChatHistoryRecord,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySearchArgs {
    pub query: String,
    pub limit: Option<usize>,
    pub history_since: Option<i64>,
    pub history_until: Option<i64>,
    pub history_date_local: Option<String>,
    pub history_time_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySearchResponse {
    pub matches: Vec<MemoryHistorySearchMatch>,
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

fn now_ms() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    duration.as_millis() as i64
}

fn open_db() -> Result<Connection, String> {
    history_db::open_connection()
}

fn refresh_chat_history_fts(conn: &Connection, filter: &HistorySearchFilter) -> Result<(), String> {
    let stale_segments =
        load_stale_chat_history_fts_segments(conn, filter, CHAT_HISTORY_FTS_REFRESH_BATCH_SIZE)?;
    for record in stale_segments {
        index_chat_history_segment_fts(conn, &record.conversation, &record.segment)?;
    }
    Ok(())
}

fn load_stale_chat_history_fts_segments(
    conn: &Connection,
    filter: &HistorySearchFilter,
    limit: usize,
) -> Result<Vec<ChatHistoryFtsSegmentRecord>, String> {
    let limit = limit.max(1);
    let time_column = match filter.time_mode {
        HistorySearchTimeMode::Conversation => "h.updated_at",
        HistorySearchTimeMode::Message | HistorySearchTimeMode::Updated => "s.updated_at",
    };
    let sql = format!(
        "
        SELECT
            h.id AS conversation_id,
            h.title AS title,
            h.cwd AS cwd,
            h.updated_at AS conversation_updated_at,
            s.segment_index AS segment_index,
            s.segment_id AS segment_id,
            s.summary_json AS summary_json,
            s.messages_json AS messages_json,
            s.message_count AS message_count,
            s.start_message_id AS start_message_id,
            s.end_message_id AS end_message_id,
            s.created_at AS created_at,
            s.updated_at AS segment_updated_at
        FROM chatHistorySegment s
        JOIN chatHistory h ON h.id = s.conversation_id
        LEFT JOIN chatHistoryFtsSegmentIndex f
          ON f.conversation_id = s.conversation_id
         AND f.segment_index = s.segment_index
        WHERE (f.conversation_id IS NULL
           OR f.segment_updated_at != s.updated_at
           OR f.conversation_updated_at != h.updated_at)
          AND (?1 IS NULL OR CAST({time_column} AS INTEGER) >= ?1)
          AND (?2 IS NULL OR CAST({time_column} AS INTEGER) < ?2)
        ORDER BY h.updated_at DESC, s.segment_index ASC
        LIMIT ?3
        "
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备历史 FTS 回填查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![filter.since, filter.until, limit as i64], |row| {
            Ok(ChatHistoryFtsSegmentRecord {
                conversation: ChatHistoryFtsConversationInfo {
                    id: row.get("conversation_id")?,
                    title: row.get("title")?,
                    cwd: row.get("cwd")?,
                    updated_at: row.get("conversation_updated_at")?,
                },
                segment: ChatHistorySegmentInput {
                    segment_index: row.get("segment_index")?,
                    segment_id: row.get("segment_id")?,
                    summary_json: row.get("summary_json")?,
                    messages_json: row.get("messages_json")?,
                    message_count: row.get("message_count")?,
                    start_message_id: row.get("start_message_id")?,
                    end_message_id: row.get("end_message_id")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("segment_updated_at")?,
                },
            })
        })
        .map_err(|e| format!("查询历史 FTS 回填数据失败：{e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("读取历史 FTS 回填行失败：{e}"))?);
    }
    Ok(out)
}

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatHistorySummary> {
    Ok(ChatHistorySummary {
        id: row.get("id")?,
        title: row.get("title")?,
        provider_id: row.get("provider_id")?,
        model: row.get("model")?,
        session_id: row.get("session_id")?,
        cwd: row.get("cwd")?,
        message_count: row.get("total_message_count")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        is_pinned: row.get::<_, i64>("is_pinned")? != 0,
        pinned_at: row.get("pinned_at")?,
        is_shared: row.get::<_, i64>("is_shared")? != 0,
    })
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatHistoryRecord> {
    Ok(ChatHistoryRecord {
        id: row.get("id")?,
        title: row.get("title")?,
        provider_id: row.get("provider_id")?,
        model: row.get("model")?,
        session_id: row.get("session_id")?,
        cwd: row.get("cwd")?,
        context_meta_json: row.get("context_meta_json")?,
        active_segment_index: row.get("active_segment_index")?,
        total_segment_count: row.get("total_segment_count")?,
        total_message_count: row.get("total_message_count")?,
        segments: Vec::new(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        is_pinned: row.get::<_, i64>("is_pinned")? != 0,
        pinned_at: row.get("pinned_at")?,
        is_shared: row.get::<_, i64>("is_shared")? != 0,
        redact_tool_content: row.get::<_, i64>("redact_tool_content")? != 0,
    })
}

fn row_to_segment(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatHistorySegmentRecord> {
    Ok(ChatHistorySegmentRecord {
        segment_index: row.get("segment_index")?,
        segment_id: row.get("segment_id")?,
        summary_json: row.get("summary_json")?,
        messages_json: row.get("messages_json")?,
        message_count: row.get("message_count")?,
        start_message_id: row.get("start_message_id")?,
        end_message_id: row.get("end_message_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn get_summary_by_id(conn: &Connection, id: &str) -> Result<ChatHistorySummary, String> {
    conn.query_row(
        "
        SELECT
            h.id AS id,
            h.title AS title,
            h.provider_id AS provider_id,
            h.model AS model,
            h.session_id AS session_id,
            h.cwd AS cwd,
            h.total_message_count AS total_message_count,
            h.created_at AS created_at,
            h.updated_at AS updated_at,
            h.is_pinned AS is_pinned,
            h.pinned_at AS pinned_at,
            CASE
                WHEN share.enabled = 1 AND share.token IS NOT NULL THEN 1
                ELSE 0
            END AS is_shared,
            CASE
                WHEN share.enabled = 1 AND share.token IS NOT NULL AND share.redact_tool_content = 1 THEN 1
                ELSE 0
            END AS redact_tool_content
        FROM chatHistory h
        LEFT JOIN chatHistoryShare share ON share.conversation_id = h.id
        WHERE h.id = ?1
        ",
        params![id],
        row_to_summary,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => "未找到对应的历史对话".to_string(),
        _ => format!("读取历史对话摘要失败：{e}"),
    })
}

fn get_record_by_id(conn: &Connection, id: &str) -> Result<ChatHistoryRecord, String> {
    conn.query_row(
        "
        SELECT
            h.id AS id,
            h.title AS title,
            h.provider_id AS provider_id,
            h.model AS model,
            h.session_id AS session_id,
            h.cwd AS cwd,
            h.context_meta_json AS context_meta_json,
            h.active_segment_index AS active_segment_index,
            h.total_segment_count AS total_segment_count,
            h.total_message_count AS total_message_count,
            h.created_at AS created_at,
            h.updated_at AS updated_at,
            h.is_pinned AS is_pinned,
            h.pinned_at AS pinned_at,
            CASE
                WHEN share.enabled = 1 AND share.token IS NOT NULL THEN 1
                ELSE 0
            END AS is_shared,
            CASE
                WHEN share.enabled = 1 AND share.token IS NOT NULL AND share.redact_tool_content = 1 THEN 1
                ELSE 0
            END AS redact_tool_content
        FROM chatHistory h
        LEFT JOIN chatHistoryShare share ON share.conversation_id = h.id
        WHERE h.id = ?1
        ",
        params![id],
        row_to_record,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => "未找到对应的历史对话".to_string(),
        _ => format!("读取历史对话失败：{e}"),
    })
}

fn update_context_meta_json_counts(
    raw: &str,
    active_segment_index: i64,
    total_segment_count: i64,
    total_message_count: i64,
) -> Result<String, String> {
    let trimmed = raw.trim();
    let mut payload = if trimmed.is_empty() {
        Map::new()
    } else {
        serde_json::from_str::<Value>(trimmed)
            .map_err(|e| format!("解析历史上下文元数据失败：{e}"))?
            .as_object()
            .cloned()
            .ok_or_else(|| "历史上下文元数据不是对象".to_string())?
    };

    payload.insert("schemaVersion".to_string(), Value::from(3));
    payload.insert(
        "activeSegmentIndex".to_string(),
        Value::from(active_segment_index),
    );
    payload.insert(
        "totalSegmentCount".to_string(),
        Value::from(total_segment_count),
    );
    payload.insert(
        "totalMessageCount".to_string(),
        Value::from(total_message_count),
    );

    serde_json::to_string(&Value::Object(payload))
        .map_err(|e| format!("序列化历史上下文元数据失败：{e}"))
}

fn read_message_timestamp_with_fallback(value: &Value, fallback: i64) -> i64 {
    value
        .as_object()
        .and_then(|object| object.get("timestamp"))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|number| number as i64))
        })
        .unwrap_or(fallback)
}

fn read_message_timestamp(value: &Value) -> i64 {
    read_message_timestamp_with_fallback(value, now_ms())
}

fn read_trimmed_string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn compute_message_stable_id(message: &Value, segment_index: i64, message_index: usize) -> String {
    if let Some(object) = message.as_object() {
        if let Some(id) = read_trimmed_string_field(object, "id") {
            return id;
        }
        if matches!(
            read_trimmed_string_field(object, "role").as_deref(),
            Some("assistant")
        ) {
            if let Some(response_id) = read_trimmed_string_field(object, "responseId") {
                return response_id;
            }
        }
    }

    format!(
        "segment-{segment_index}-message-{message_index}-{}",
        read_message_timestamp(message)
    )
}

fn normalize_history_search_text(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn push_text_piece(out: &mut Vec<String>, label: Option<&str>, text: &str) {
    let normalized = normalize_history_search_text(text);
    if normalized.is_empty() {
        return;
    }
    if let Some(label) = label.filter(|value| !value.trim().is_empty()) {
        out.push(format!("{label}: {normalized}"));
    } else {
        out.push(normalized);
    }
}

fn stringify_short_json(value: &Value) -> Option<String> {
    let text = serde_json::to_string(value).ok()?;
    let normalized = normalize_history_search_text(&text);
    if normalized.is_empty() {
        None
    } else if normalized.len() > 512 {
        let truncated = normalized.chars().take(512).collect::<String>();
        Some(format!("{truncated}..."))
    } else {
        Some(normalized)
    }
}

fn extract_tool_call_summary(record: &Map<String, Value>) -> Option<String> {
    let name = ["name", "toolName", "tool_name"]
        .iter()
        .find_map(|key| read_trimmed_string_field(record, key));
    let args = ["arguments", "args", "input", "parameters"]
        .iter()
        .find_map(|key| record.get(*key).and_then(stringify_short_json));

    match (name, args) {
        (Some(name), Some(args)) => Some(format!("tool call {name} {args}")),
        (Some(name), None) => Some(format!("tool call {name}")),
        (None, Some(args)) => Some(format!("tool call {args}")),
        (None, None) => None,
    }
}

fn extract_content_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return normalize_history_search_text(text);
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };

    let mut pieces = Vec::new();
    for item in items {
        let Some(record) = item.as_object() else {
            continue;
        };
        match read_trimmed_string_field(record, "type").as_deref() {
            Some("text") => {
                if let Some(text) = record.get("text").and_then(Value::as_str) {
                    push_text_piece(&mut pieces, None, text);
                }
            }
            Some("toolCall") | Some("tool_use") => {
                if let Some(summary) = extract_tool_call_summary(record) {
                    push_text_piece(&mut pieces, None, &summary);
                }
            }
            Some("thinking") => {
                // Do not index hidden reasoning or encrypted thinking payloads.
            }
            _ => {}
        }
    }
    pieces.join("\n")
}

fn extract_searchable_history_messages(
    segment: &ChatHistorySegmentInput,
) -> Vec<SearchableHistoryMessage> {
    let Ok(parsed) = serde_json::from_str::<Value>(&segment.messages_json) else {
        return Vec::new();
    };
    let Some(items) = parsed.as_array() else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(object) = item.as_object() else {
            continue;
        };
        let role = read_trimmed_string_field(object, "role");
        let mut pieces = Vec::new();
        if let Some(tool_name) = read_trimmed_string_field(object, "toolName") {
            push_text_piece(&mut pieces, Some("tool"), &tool_name);
        }
        let content_text = extract_content_text(object.get("content"));
        push_text_piece(&mut pieces, role.as_deref(), &content_text);
        let text = pieces.join("\n");
        if text.trim().is_empty() {
            continue;
        }

        out.push(SearchableHistoryMessage {
            message_index: i64::try_from(index).unwrap_or(i64::MAX),
            message_id: read_trimmed_string_field(object, "id").or_else(|| {
                Some(compute_message_stable_id(
                    item,
                    segment.segment_index,
                    index,
                ))
            }),
            role,
            text,
            updated_at: read_message_timestamp_with_fallback(item, segment.updated_at),
        });
    }
    out
}

fn load_chat_history_fts_conversation_info(
    conn: &Connection,
    conversation_id: &str,
) -> Result<ChatHistoryFtsConversationInfo, String> {
    conn.query_row(
        "
        SELECT id, title, cwd, updated_at
        FROM chatHistory
        WHERE id = ?1
        ",
        params![conversation_id],
        |row| {
            Ok(ChatHistoryFtsConversationInfo {
                id: row.get("id")?,
                title: row.get("title")?,
                cwd: row.get("cwd")?,
                updated_at: row.get("updated_at")?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => "未找到对应的历史对话".to_string(),
        _ => format!("读取历史 FTS 对话信息失败：{e}"),
    })
}

fn delete_chat_history_segment_fts(
    conn: &Connection,
    conversation_id: &str,
    segment_index: i64,
) -> Result<(), String> {
    conn.execute(
        "
        DELETE FROM chatHistoryFtsSegmentIndex
        WHERE conversation_id = ?1 AND segment_index = ?2
        ",
        params![conversation_id, segment_index],
    )
    .map_err(|e| format!("删除历史 FTS 元数据失败：{e}"))?;
    conn.execute(
        "
        DELETE FROM chatHistoryMessageFts
        WHERE conversation_id = ?1 AND segment_index = ?2
        ",
        params![conversation_id, segment_index],
    )
    .map_err(|e| format!("删除历史消息 FTS 行失败：{e}"))?;
    conn.execute(
        "
        DELETE FROM chatHistorySegmentFts
        WHERE conversation_id = ?1 AND segment_index = ?2
        ",
        params![conversation_id, segment_index],
    )
    .map_err(|e| format!("删除历史分段 FTS 行失败：{e}"))?;
    Ok(())
}

fn delete_chat_history_fts_from_segment(
    conn: &Connection,
    conversation_id: &str,
    from_segment_index: i64,
) -> Result<(), String> {
    conn.execute(
        "
        DELETE FROM chatHistoryFtsSegmentIndex
        WHERE conversation_id = ?1 AND segment_index >= ?2
        ",
        params![conversation_id, from_segment_index],
    )
    .map_err(|e| format!("清理截断历史 FTS 元数据失败：{e}"))?;
    conn.execute(
        "
        DELETE FROM chatHistoryMessageFts
        WHERE conversation_id = ?1 AND segment_index >= ?2
        ",
        params![conversation_id, from_segment_index],
    )
    .map_err(|e| format!("清理截断历史消息 FTS 行失败：{e}"))?;
    conn.execute(
        "
        DELETE FROM chatHistorySegmentFts
        WHERE conversation_id = ?1 AND segment_index >= ?2
        ",
        params![conversation_id, from_segment_index],
    )
    .map_err(|e| format!("清理截断历史分段 FTS 行失败：{e}"))?;
    Ok(())
}

fn delete_chat_history_conversation_fts(
    conn: &Connection,
    conversation_id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM chatHistoryFtsSegmentIndex WHERE conversation_id = ?1",
        params![conversation_id],
    )
    .map_err(|e| format!("删除历史对话 FTS 元数据失败：{e}"))?;
    conn.execute(
        "DELETE FROM chatHistoryMessageFts WHERE conversation_id = ?1",
        params![conversation_id],
    )
    .map_err(|e| format!("删除历史对话消息 FTS 行失败：{e}"))?;
    conn.execute(
        "DELETE FROM chatHistorySegmentFts WHERE conversation_id = ?1",
        params![conversation_id],
    )
    .map_err(|e| format!("删除历史对话分段 FTS 行失败：{e}"))?;
    Ok(())
}

fn is_chat_history_segment_fts_current(
    conn: &Connection,
    conversation: &ChatHistoryFtsConversationInfo,
    segment: &ChatHistorySegmentInput,
) -> Result<bool, String> {
    let current = conn
        .query_row(
            "
            SELECT 1
            FROM chatHistoryFtsSegmentIndex
            WHERE conversation_id = ?1
              AND segment_index = ?2
              AND segment_updated_at = ?3
              AND conversation_updated_at = ?4
            LIMIT 1
            ",
            params![
                conversation.id,
                segment.segment_index,
                segment.updated_at,
                conversation.updated_at
            ],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("检查历史 FTS 当前状态失败：{e}"))?;
    Ok(current.is_some())
}

fn index_chat_history_segment_fts(
    conn: &Connection,
    conversation: &ChatHistoryFtsConversationInfo,
    segment: &ChatHistorySegmentInput,
) -> Result<(), String> {
    delete_chat_history_segment_fts(conn, &conversation.id, segment.segment_index)?;

    let messages = extract_searchable_history_messages(segment);
    let segment_body = messages
        .iter()
        .map(|message| {
            let role = message.role.as_deref().unwrap_or("message");
            format!("{role}: {}", message.text)
        })
        .collect::<Vec<_>>()
        .join("\n");

    conn.execute(
        "
        INSERT INTO chatHistorySegmentFts (
            conversation_id,
            segment_index,
            segment_id,
            title,
            cwd,
            body,
            segment_updated_at,
            conversation_updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ",
        params![
            conversation.id,
            segment.segment_index,
            segment.segment_id.trim(),
            conversation.title.trim(),
            conversation.cwd.as_deref(),
            segment_body,
            segment.updated_at,
            conversation.updated_at
        ],
    )
    .map_err(|e| format!("写入历史分段 FTS 失败：{e}"))?;

    for message in messages {
        conn.execute(
            "
        INSERT INTO chatHistoryMessageFts (
                conversation_id,
                segment_index,
                segment_id,
                message_index,
                message_id,
                role,
                title,
                cwd,
                body,
                message_updated_at,
                segment_updated_at,
                conversation_updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ",
            params![
                conversation.id,
                segment.segment_index,
                segment.segment_id.trim(),
                message.message_index,
                message.message_id.as_deref(),
                message.role.as_deref(),
                conversation.title.trim(),
                conversation.cwd.as_deref(),
                message.text,
                message.updated_at,
                segment.updated_at,
                conversation.updated_at
            ],
        )
        .map_err(|e| format!("写入历史消息 FTS 失败：{e}"))?;
    }

    conn.execute(
        "
        INSERT INTO chatHistoryFtsSegmentIndex (
            conversation_id,
            segment_index,
            segment_updated_at,
            conversation_updated_at
        ) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(conversation_id, segment_index) DO UPDATE SET
            segment_updated_at = excluded.segment_updated_at,
            conversation_updated_at = excluded.conversation_updated_at
        ",
        params![
            conversation.id,
            segment.segment_index,
            segment.updated_at,
            conversation.updated_at,
        ],
    )
    .map_err(|e| format!("写入历史 FTS 元数据失败：{e}"))?;

    Ok(())
}

fn reindex_chat_history_conversation_fts(
    conn: &Connection,
    conversation_id: &str,
) -> Result<(), String> {
    let conversation = load_chat_history_fts_conversation_info(conn, conversation_id)?;
    let segments = load_segments(conn, conversation_id)?;
    for segment in segments {
        let input = record_to_segment_input(&segment);
        index_chat_history_segment_fts(conn, &conversation, &input)?;
    }
    Ok(())
}

fn record_to_segment_input(record: &ChatHistorySegmentRecord) -> ChatHistorySegmentInput {
    ChatHistorySegmentInput {
        segment_index: record.segment_index,
        segment_id: record.segment_id.clone(),
        summary_json: record.summary_json.clone(),
        messages_json: record.messages_json.clone(),
        message_count: record.message_count,
        start_message_id: record.start_message_id.clone(),
        end_message_id: record.end_message_id.clone(),
        created_at: record.created_at,
        updated_at: record.updated_at,
    }
}

fn truncate_segment_input(
    record: &ChatHistorySegmentRecord,
    message_index: i64,
) -> Result<ChatHistorySegmentInput, String> {
    let parsed = serde_json::from_str::<Value>(&record.messages_json)
        .map_err(|e| format!("解析历史分段消息失败：{e}"))?;
    let items = parsed
        .as_array()
        .ok_or_else(|| "历史分段消息不是数组".to_string())?;
    let cutoff = usize::try_from(message_index.max(0))
        .unwrap_or(0)
        .min(items.len());
    let truncated_items = items.iter().take(cutoff).cloned().collect::<Vec<_>>();
    let messages_json = serde_json::to_string(&truncated_items)
        .map_err(|e| format!("序列化截断后的历史分段失败：{e}"))?;
    let message_count = i64::try_from(truncated_items.len()).unwrap_or(i64::MAX);
    let start_message_id = truncated_items
        .first()
        .map(|item| compute_message_stable_id(item, record.segment_index, 0));
    let end_message_id = truncated_items.last().map(|item| {
        compute_message_stable_id(item, record.segment_index, truncated_items.len() - 1)
    });
    let updated_at = truncated_items
        .last()
        .map(read_message_timestamp)
        .unwrap_or(record.created_at);

    Ok(ChatHistorySegmentInput {
        segment_index: record.segment_index,
        segment_id: record.segment_id.clone(),
        summary_json: record.summary_json.clone(),
        messages_json,
        message_count,
        start_message_id,
        end_message_id,
        created_at: record.created_at,
        updated_at,
    })
}

fn validate_segment_input(segment: &ChatHistorySegmentInput) -> Result<(), String> {
    if segment.segment_index < 0 {
        return Err("segmentIndex 不能小于 0".to_string());
    }
    if segment.segment_id.trim().is_empty() {
        return Err("segmentId 不能为空".to_string());
    }
    if segment.messages_json.trim().is_empty() {
        return Err("messagesJson 不能为空".to_string());
    }
    if segment.message_count < 0 {
        return Err("messageCount 不能小于 0".to_string());
    }
    Ok(())
}

fn validate_upsert_input(input: &ChatHistoryUpsertInput) -> Result<(), String> {
    validate_conversation_input(&ChatHistoryConversationInput {
        id: input.id.clone(),
        title: input.title.clone(),
        provider_id: input.provider_id.clone(),
        model: input.model.clone(),
        session_id: input.session_id.clone(),
        cwd: input.cwd.clone(),
        context_meta_json: input.context_meta_json.clone(),
        active_segment_index: input.active_segment_index,
        total_segment_count: input.total_segment_count,
        total_message_count: input.total_message_count,
        created_at: input.created_at,
        updated_at: input.updated_at,
    })?;
    if input.segments.is_empty() {
        return Err("segments 不能为空".to_string());
    }
    if input.total_segment_count != input.segments.len() as i64 {
        return Err("totalSegmentCount 必须与 segments.length 一致".to_string());
    }

    for (index, segment) in input.segments.iter().enumerate() {
        validate_segment_input(segment)?;
        if segment.segment_index != index as i64 {
            return Err(format!(
                "segments 必须按 segmentIndex 从 0 连续递增，发现位置 {} 的 segmentIndex={}",
                index, segment.segment_index
            ));
        }
    }

    Ok(())
}

fn validate_conversation_input(input: &ChatHistoryConversationInput) -> Result<(), String> {
    if input.id.trim().is_empty() {
        return Err("历史对话 id 不能为空".to_string());
    }
    if input.title.trim().is_empty() {
        return Err("历史对话标题不能为空".to_string());
    }
    if input.provider_id.trim().is_empty() {
        return Err("providerId 不能为空".to_string());
    }
    if input.model.trim().is_empty() {
        return Err("model 不能为空".to_string());
    }
    if input.context_meta_json.trim().is_empty() {
        return Err("contextMetaJson 不能为空".to_string());
    }
    if input.active_segment_index < 0 {
        return Err("activeSegmentIndex 不能小于 0".to_string());
    }
    if input.total_segment_count <= 0 {
        return Err("totalSegmentCount 必须大于 0".to_string());
    }
    if input.total_message_count < 0 {
        return Err("totalMessageCount 不能小于 0".to_string());
    }
    if input.active_segment_index != input.total_segment_count - 1 {
        return Err("activeSegmentIndex 必须等于 totalSegmentCount - 1".to_string());
    }

    Ok(())
}

fn validate_segment_mutation_input(input: &ChatHistorySegmentMutationInput) -> Result<(), String> {
    validate_conversation_input(&input.conversation)?;
    validate_segment_input(&input.segment)?;
    if input.segment.segment_index != input.conversation.active_segment_index {
        return Err("segmentIndex 必须等于 activeSegmentIndex".to_string());
    }
    Ok(())
}

fn validate_append_segment_preconditions(
    conn: &Connection,
    input: &ChatHistorySegmentMutationInput,
) -> Result<(), String> {
    let conversation_id = input.conversation.id.trim();
    let existing_header = conn
        .query_row(
            "
            SELECT active_segment_index, total_segment_count
            FROM chatHistory
            WHERE id = ?1
            ",
            params![conversation_id],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()
        .map_err(|e| format!("读取 append segment 前置状态失败：{e}"))?;

    let (active_segment_index, total_segment_count) = match existing_header {
        Some((Some(active_segment_index), Some(total_segment_count))) => {
            (active_segment_index, total_segment_count)
        }
        Some(_) => {
            return Err("append segment 需要完整的分段主表数据".to_string());
        }
        None => {
            return Err("append segment 需要已存在的历史对话".to_string());
        }
    };

    if active_segment_index != total_segment_count - 1 {
        return Err("append segment 前置校验失败：现有 activeSegmentIndex 非最后一段".to_string());
    }
    if input.segment.segment_index != total_segment_count {
        return Err(format!(
            "append segment 只能追加到末尾：期望 segmentIndex={}，实际为 {}",
            total_segment_count, input.segment.segment_index
        ));
    }
    if input.conversation.active_segment_index != total_segment_count {
        return Err(format!(
            "append segment 前置校验失败：activeSegmentIndex 应为 {}，实际为 {}",
            total_segment_count, input.conversation.active_segment_index
        ));
    }
    if input.conversation.total_segment_count != total_segment_count + 1 {
        return Err(format!(
            "append segment 前置校验失败：totalSegmentCount 应为 {}，实际为 {}",
            total_segment_count + 1,
            input.conversation.total_segment_count
        ));
    }

    let existing_segment = conn
        .query_row(
            "
            SELECT 1
            FROM chatHistorySegment
            WHERE conversation_id = ?1 AND segment_index = ?2
            ",
            params![conversation_id, input.segment.segment_index],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("检查 append segment 目标分段失败：{e}"))?;
    if existing_segment.is_some() {
        return Err(format!(
            "append segment 不允许覆盖已有分段：segmentIndex={}",
            input.segment.segment_index
        ));
    }

    Ok(())
}

fn load_segments(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Vec<ChatHistorySegmentRecord>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT
                segment_index,
                segment_id,
                summary_json,
                messages_json,
                message_count,
                start_message_id,
                end_message_id,
                created_at,
                updated_at
            FROM chatHistorySegment
            WHERE conversation_id = ?1
            ORDER BY segment_index ASC
            ",
        )
        .map_err(|e| format!("准备历史分段查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![conversation_id], row_to_segment)
        .map_err(|e| format!("查询历史分段失败：{e}"))?;

    let mut segments = Vec::new();
    for row in rows {
        segments.push(row.map_err(|e| format!("读取历史分段失败：{e}"))?);
    }
    Ok(segments)
}

fn load_tail_segments(
    conn: &Connection,
    conversation_id: &str,
    max_messages: i64,
) -> Result<Vec<ChatHistorySegmentRecord>, String> {
    if max_messages <= 0 {
        return load_segments(conn, conversation_id);
    }

    let mut stmt = conn
        .prepare(
            "
            SELECT
                segment_index,
                segment_id,
                summary_json,
                messages_json,
                message_count,
                start_message_id,
                end_message_id,
                created_at,
                updated_at
            FROM chatHistorySegment
            WHERE conversation_id = ?1
            ORDER BY segment_index DESC
            ",
        )
        .map_err(|e| format!("准备尾部历史分段查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![conversation_id], row_to_segment)
        .map_err(|e| format!("查询尾部历史分段失败：{e}"))?;

    let mut segments = Vec::new();
    let mut loaded_messages = 0_i64;
    for row in rows {
        let segment = row.map_err(|e| format!("读取尾部历史分段失败：{e}"))?;
        loaded_messages = loaded_messages.saturating_add(segment.message_count.max(0));
        segments.push(segment);
        if loaded_messages >= max_messages {
            break;
        }
    }
    segments.reverse();
    Ok(segments)
}

fn load_segment_by_index(
    conn: &Connection,
    conversation_id: &str,
    segment_index: i64,
) -> Result<ChatHistorySegmentRecord, String> {
    conn.query_row(
        "
        SELECT
            segment_index,
            segment_id,
            summary_json,
            messages_json,
            message_count,
            start_message_id,
            end_message_id,
            created_at,
            updated_at
        FROM chatHistorySegment
        WHERE conversation_id = ?1 AND segment_index = ?2
        ",
        params![conversation_id, segment_index],
        row_to_segment,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            format!(
                "未找到历史分段：conversationId={} segmentIndex={segment_index}",
                conversation_id
            )
        }
        _ => format!("读取活跃历史分段失败：{e}"),
    })
}

fn upsert_chat_history_header(
    conn: &Connection,
    input: &ChatHistoryConversationInput,
) -> Result<(), String> {
    let created_at = input.created_at.unwrap_or_else(now_ms);
    let updated_at = if input.updated_at > 0 {
        input.updated_at
    } else {
        now_ms()
    };
    let session_id = input
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let cwd = input
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    conn.execute(
        "
        INSERT INTO chatHistory (
            id,
            title,
            provider_id,
            model,
            session_id,
            cwd,
            context_meta_json,
            active_segment_index,
            total_segment_count,
            total_message_count,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            provider_id = excluded.provider_id,
            model = excluded.model,
            session_id = excluded.session_id,
            cwd = excluded.cwd,
            context_meta_json = excluded.context_meta_json,
            active_segment_index = excluded.active_segment_index,
            total_segment_count = excluded.total_segment_count,
            total_message_count = excluded.total_message_count,
            updated_at = excluded.updated_at
        ",
        params![
            input.id.trim(),
            input.title.trim(),
            input.provider_id.trim(),
            input.model.trim(),
            session_id,
            cwd,
            input.context_meta_json.trim(),
            input.active_segment_index,
            input.total_segment_count,
            input.total_message_count,
            created_at,
            updated_at
        ],
    )
    .map_err(|e| format!("写入聊天历史主表失败：{e}"))?;

    Ok(())
}

fn set_chat_history_pinned_sync(
    conn: &Connection,
    id: &str,
    is_pinned: bool,
) -> Result<ChatHistorySummary, String> {
    let chat_id = id.trim();
    if chat_id.is_empty() {
        return Err("历史对话 id 不能为空".to_string());
    }

    let pinned_at = is_pinned.then(now_ms);
    let affected = conn
        .execute(
            "
            UPDATE chatHistory
            SET is_pinned = ?1, pinned_at = ?2
            WHERE id = ?3
            ",
            params![if is_pinned { 1 } else { 0 }, pinned_at, chat_id],
        )
        .map_err(|e| format!("更新历史对话置顶状态失败：{e}"))?;

    if affected == 0 {
        return Err("未找到对应的历史对话".to_string());
    }

    get_summary_by_id(conn, chat_id)
}

fn generate_history_share_token() -> String {
    let alphabet_len = HISTORY_SHARE_TOKEN_ALPHABET.len() as u128;
    let mut value = u128::from_be_bytes(*Uuid::new_v4().as_bytes());
    let mut token = String::with_capacity(HISTORY_SHARE_TOKEN_LEN);

    for _ in 0..HISTORY_SHARE_TOKEN_LEN {
        let index = (value % alphabet_len) as usize;
        token.push(HISTORY_SHARE_TOKEN_ALPHABET[index] as char);
        value /= alphabet_len;
    }

    token
}

fn is_unique_constraint_error(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(err, _)
            if err.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

fn empty_chat_history_share_status(conversation_id: &str) -> ChatHistoryShareStatus {
    ChatHistoryShareStatus {
        conversation_id: conversation_id.to_string(),
        enabled: false,
        token: None,
        created_at: None,
        updated_at: None,
        redact_tool_content: false,
    }
}

fn row_to_share_status(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatHistoryShareStatus> {
    let enabled = row.get::<_, i64>("enabled")? != 0;
    let token = row
        .get::<_, Option<String>>("token")?
        .filter(|value| !value.trim().is_empty());
    let is_enabled = enabled && token.is_some();
    Ok(ChatHistoryShareStatus {
        conversation_id: row.get("conversation_id")?,
        enabled: is_enabled,
        token: if is_enabled { token } else { None },
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        redact_tool_content: row.get::<_, i64>("redact_tool_content")? != 0,
    })
}

fn ensure_chat_history_exists(conn: &Connection, id: &str) -> Result<String, String> {
    let chat_id = id.trim();
    if chat_id.is_empty() {
        return Err("历史对话 id 不能为空".to_string());
    }

    conn.query_row(
        "SELECT id FROM chatHistory WHERE id = ?1",
        params![chat_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("检查历史对话是否存在失败：{e}"))?
    .ok_or_else(|| "未找到对应的历史对话".to_string())
}

fn get_chat_history_share_status_sync(
    conn: &Connection,
    id: &str,
) -> Result<ChatHistoryShareStatus, String> {
    let chat_id = ensure_chat_history_exists(conn, id)?;
    let status = conn
        .query_row(
            "
            SELECT conversation_id, token, enabled, redact_tool_content, created_at, updated_at
            FROM chatHistoryShare
            WHERE conversation_id = ?1
            ",
            params![chat_id],
            row_to_share_status,
        )
        .optional()
        .map_err(|e| format!("读取历史对话分享状态失败：{e}"))?;

    Ok(status.unwrap_or_else(|| empty_chat_history_share_status(&chat_id)))
}

fn set_chat_history_share_enabled_sync(
    conn: &Connection,
    id: &str,
    enabled: bool,
    redact_tool_content: Option<bool>,
) -> Result<ChatHistoryShareStatus, String> {
    let chat_id = ensure_chat_history_exists(conn, id)?;
    let now = now_ms();

    if enabled {
        let current = conn
            .query_row(
                "
                SELECT conversation_id, token, enabled, redact_tool_content, created_at, updated_at
                FROM chatHistoryShare
                WHERE conversation_id = ?1
                ",
                params![chat_id],
                row_to_share_status,
            )
            .optional()
            .map_err(|e| format!("读取历史对话分享状态失败：{e}"))?;
        let desired_redact_tool_content = redact_tool_content
            .or_else(|| current.as_ref().map(|status| status.redact_tool_content))
            .unwrap_or(false);
        if let Some(status) = current.as_ref() {
            if status.enabled && status.token.is_some() {
                if redact_tool_content
                    .map(|value| value == status.redact_tool_content)
                    .unwrap_or(true)
                {
                    return Ok(status.clone());
                }
                conn.execute(
                    "
                    UPDATE chatHistoryShare
                    SET redact_tool_content = ?1, updated_at = ?2
                    WHERE conversation_id = ?3
                    ",
                    params![
                        if desired_redact_tool_content { 1 } else { 0 },
                        now,
                        chat_id
                    ],
                )
                .map_err(|e| format!("更新历史对话分享脱敏设置失败：{e}"))?;
                return get_chat_history_share_status_sync(conn, &chat_id);
            }
        }

        let mut wrote_share_token = false;
        for _ in 0..HISTORY_SHARE_TOKEN_INSERT_ATTEMPTS {
            let token = generate_history_share_token();
            match conn.execute(
                "
                INSERT INTO chatHistoryShare (
                    conversation_id,
                    token,
                    enabled,
                    redact_tool_content,
                    created_at,
                    updated_at
                ) VALUES (?1, ?2, 1, ?3, ?4, ?4)
                ON CONFLICT(conversation_id) DO UPDATE SET
                    token = excluded.token,
                    enabled = 1,
                    redact_tool_content = excluded.redact_tool_content,
                    updated_at = excluded.updated_at
                ",
                params![
                    chat_id,
                    token,
                    if desired_redact_tool_content { 1 } else { 0 },
                    now
                ],
            ) {
                Ok(_) => {
                    wrote_share_token = true;
                    break;
                }
                Err(error) if is_unique_constraint_error(&error) => continue,
                Err(error) => return Err(format!("开启历史对话分享失败：{error}")),
            }
        }

        if !wrote_share_token {
            return Err("开启历史对话分享失败：生成唯一分享路径失败".to_string());
        }
    } else {
        conn.execute(
            "
            UPDATE chatHistoryShare
            SET token = NULL, enabled = 0, updated_at = ?1
            WHERE conversation_id = ?2
            ",
            params![now, chat_id],
        )
        .map_err(|e| format!("关闭历史对话分享失败：{e}"))?;
        if let Some(redact_tool_content) = redact_tool_content {
            conn.execute(
                "
                UPDATE chatHistoryShare
                SET redact_tool_content = ?1, updated_at = ?2
                WHERE conversation_id = ?3
                ",
                params![if redact_tool_content { 1 } else { 0 }, now, chat_id],
            )
            .map_err(|e| format!("更新历史对话分享脱敏设置失败：{e}"))?;
        }
    }

    get_chat_history_share_status_sync(conn, &chat_id)
}

fn resolve_chat_history_share_sync(
    conn: &Connection,
    token: &str,
) -> Result<ChatHistoryRecord, String> {
    let share_token = token.trim();
    if share_token.is_empty() {
        return Err("分享 token 不能为空".to_string());
    }

    let conversation_id = conn
        .query_row(
            "
            SELECT conversation_id
            FROM chatHistoryShare
            WHERE token = ?1 AND enabled = 1
            ",
            params![share_token],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取历史对话分享链接失败：{e}"))?
        .ok_or_else(|| "分享链接不存在或已关闭".to_string())?;

    let mut record = get_record_by_id(conn, &conversation_id)?;
    record.segments = load_segments(conn, &record.id)?;

    Ok(record)
}

fn rename_chat_history_sync(
    conn: &Connection,
    id: &str,
    title: &str,
) -> Result<ChatHistorySummary, String> {
    let chat_id = id.trim();
    let next_title = title.trim();
    if chat_id.is_empty() {
        return Err("历史对话 id 不能为空".to_string());
    }
    if next_title.is_empty() {
        return Err("历史对话标题不能为空".to_string());
    }

    let affected = conn
        .execute(
            "
            UPDATE chatHistory
            SET title = ?1, updated_at = ?2
            WHERE id = ?3
            ",
            params![next_title, now_ms(), chat_id],
        )
        .map_err(|e| format!("更新历史对话标题失败：{e}"))?;

    if affected == 0 {
        return Err("未找到对应的历史对话".to_string());
    }

    reindex_chat_history_conversation_fts(conn, chat_id)?;
    get_summary_by_id(conn, chat_id)
}

fn upsert_single_segment(
    conn: &Connection,
    conversation_id: &str,
    segment: &ChatHistorySegmentInput,
) -> Result<(), String> {
    conn.execute(
        "
        INSERT INTO chatHistorySegment (
            conversation_id,
            segment_index,
            segment_id,
            summary_json,
            messages_json,
            message_count,
            start_message_id,
            end_message_id,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(conversation_id, segment_index) DO UPDATE SET
            segment_id = excluded.segment_id,
            summary_json = excluded.summary_json,
            messages_json = excluded.messages_json,
            message_count = excluded.message_count,
            start_message_id = excluded.start_message_id,
            end_message_id = excluded.end_message_id,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        ",
        params![
            conversation_id,
            segment.segment_index,
            segment.segment_id.trim(),
            segment.summary_json.as_deref().map(str::trim),
            segment.messages_json.trim(),
            segment.message_count,
            segment.start_message_id.as_deref().map(str::trim),
            segment.end_message_id.as_deref().map(str::trim),
            segment.created_at,
            segment.updated_at
        ],
    )
    .map_err(|e| format!("写入历史分段失败：{e}"))?;
    let conversation = load_chat_history_fts_conversation_info(conn, conversation_id)?;
    index_chat_history_segment_fts(conn, &conversation, segment)?;

    Ok(())
}

fn insert_single_segment(
    conn: &Connection,
    conversation_id: &str,
    segment: &ChatHistorySegmentInput,
) -> Result<(), String> {
    conn.execute(
        "
        INSERT INTO chatHistorySegment (
            conversation_id,
            segment_index,
            segment_id,
            summary_json,
            messages_json,
            message_count,
            start_message_id,
            end_message_id,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ",
        params![
            conversation_id,
            segment.segment_index,
            segment.segment_id.trim(),
            segment.summary_json.as_deref().map(str::trim),
            segment.messages_json.trim(),
            segment.message_count,
            segment.start_message_id.as_deref().map(str::trim),
            segment.end_message_id.as_deref().map(str::trim),
            segment.created_at,
            segment.updated_at
        ],
    )
    .map_err(|e| format!("追加历史分段失败：{e}"))?;
    let conversation = load_chat_history_fts_conversation_info(conn, conversation_id)?;
    index_chat_history_segment_fts(conn, &conversation, segment)?;

    Ok(())
}

fn sync_segments(
    conn: &Connection,
    conversation_id: &str,
    segments: &[ChatHistorySegmentInput],
    total_segment_count: i64,
) -> Result<(), String> {
    let existing_segments = load_segments(conn, conversation_id)?;
    let existing_by_index: HashMap<i64, ChatHistorySegmentRecord> = existing_segments
        .into_iter()
        .map(|segment| (segment.segment_index, segment))
        .collect();
    let conversation = load_chat_history_fts_conversation_info(conn, conversation_id)?;

    for segment in segments {
        let existing_matches = existing_by_index
            .get(&segment.segment_index)
            .map(|record| segment_record_matches_input(record, segment))
            .unwrap_or(false);
        if existing_matches && is_chat_history_segment_fts_current(conn, &conversation, segment)? {
            continue;
        }

        if !existing_matches {
            conn.execute(
                "
                INSERT INTO chatHistorySegment (
                    conversation_id,
                    segment_index,
                    segment_id,
                    summary_json,
                    messages_json,
                    message_count,
                    start_message_id,
                    end_message_id,
                    created_at,
                    updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(conversation_id, segment_index) DO UPDATE SET
                    segment_id = excluded.segment_id,
                    summary_json = excluded.summary_json,
                    messages_json = excluded.messages_json,
                    message_count = excluded.message_count,
                    start_message_id = excluded.start_message_id,
                    end_message_id = excluded.end_message_id,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at
                ",
                params![
                    conversation_id,
                    segment.segment_index,
                    segment.segment_id.trim(),
                    segment.summary_json.as_deref().map(str::trim),
                    segment.messages_json.trim(),
                    segment.message_count,
                    segment.start_message_id.as_deref().map(str::trim),
                    segment.end_message_id.as_deref().map(str::trim),
                    segment.created_at,
                    segment.updated_at
                ],
            )
            .map_err(|e| format!("写入历史分段失败：{e}"))?;
        }
        index_chat_history_segment_fts(conn, &conversation, segment)?;
    }

    conn.execute(
        "
        DELETE FROM chatHistorySegment
        WHERE conversation_id = ?1
          AND segment_index >= ?2
        ",
        params![conversation_id, total_segment_count],
    )
    .map_err(|e| format!("清理过期历史分段失败：{e}"))?;
    delete_chat_history_fts_from_segment(conn, conversation_id, total_segment_count)?;

    Ok(())
}

fn segment_record_matches_input(
    record: &ChatHistorySegmentRecord,
    input: &ChatHistorySegmentInput,
) -> bool {
    record.segment_id == input.segment_id.trim()
        && record.summary_json.as_deref().map(str::trim)
            == input.summary_json.as_deref().map(str::trim)
        && record.messages_json == input.messages_json.trim()
        && record.message_count == input.message_count
        && record.start_message_id.as_deref().map(str::trim)
            == input.start_message_id.as_deref().map(str::trim)
        && record.end_message_id.as_deref().map(str::trim)
            == input.end_message_id.as_deref().map(str::trim)
        && record.created_at == input.created_at
        && record.updated_at == input.updated_at
}

fn verify_chat_history_consistency(conn: &Connection, conversation_id: &str) -> Result<(), String> {
    let mismatch = conn
        .query_row(
            "
            SELECT 1
            FROM chatHistory h
            LEFT JOIN chatHistorySegment s ON s.conversation_id = h.id
            WHERE h.id = ?1
            GROUP BY h.id
            HAVING COUNT(s.segment_index) != h.total_segment_count
               OR COALESCE(SUM(s.message_count), 0) != h.total_message_count
               OR h.active_segment_index >= h.total_segment_count
            ",
            params![conversation_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("执行聊天历史一致性校验失败：{e}"))?;

    if mismatch.is_some() {
        return Err("聊天历史一致性校验失败：segment/message 统计不匹配".to_string());
    }

    Ok(())
}

fn resolve_history_list_page(page: i64) -> Result<i64, String> {
    if page <= 0 {
        Err("历史列表 page 必须大于 0".to_string())
    } else {
        Ok(page)
    }
}

fn resolve_history_list_page_size(page_size: i64) -> Result<i64, String> {
    if page_size <= 0 {
        Err("历史列表 pageSize 必须大于 0".to_string())
    } else {
        Ok(page_size.min(MAX_HISTORY_LIST_LIMIT))
    }
}

#[cfg(test)]
pub(crate) fn list_chat_history_sync(
    conn: &Connection,
    page: i64,
    page_size: i64,
) -> Result<ChatHistoryListResponse, String> {
    list_chat_history_sync_with_filter(conn, page, page_size, ChatHistoryListFilter::default())
}

pub(crate) fn list_chat_history_sync_with_filter(
    conn: &Connection,
    page: i64,
    page_size: i64,
    filter: ChatHistoryListFilter,
) -> Result<ChatHistoryListResponse, String> {
    let page = resolve_history_list_page(page)?;
    let limit = resolve_history_list_page_size(page_size)?;
    let offset = (page - 1).saturating_mul(limit);
    let cwd_filter = if filter.cwd_empty {
        None
    } else {
        filter
            .cwd
            .map(|cwd| cwd.trim().to_string())
            .filter(|cwd| !cwd.is_empty())
    };
    let where_clause = if filter.cwd_empty {
        "WHERE TRIM(COALESCE(h.cwd, '')) = ''"
    } else if cwd_filter.is_some() {
        "WHERE TRIM(COALESCE(h.cwd, '')) = ?1"
    } else {
        ""
    };
    let total_query = format!("SELECT COUNT(*) FROM chatHistory h {where_clause}");
    let total = if let Some(cwd) = cwd_filter.as_deref() {
        conn.query_row(&total_query, params![cwd], |row| row.get::<_, i64>(0))
    } else {
        conn.query_row(&total_query, [], |row| row.get::<_, i64>(0))
    }
    .map_err(|e| format!("统计历史列表失败：{e}"))?;

    let mut stmt = conn
        .prepare(&format!(
            "\
            SELECT
                h.id AS id,
                h.title AS title,
                h.provider_id AS provider_id,
                h.model AS model,
                h.session_id AS session_id,
                h.cwd AS cwd,
                h.total_message_count AS total_message_count,
                h.created_at AS created_at,
                h.updated_at AS updated_at,
                h.is_pinned AS is_pinned,
                h.pinned_at AS pinned_at,
                CASE
                    WHEN share.enabled = 1 AND share.token IS NOT NULL THEN 1
                    ELSE 0
                END AS is_shared
            FROM chatHistory h
            LEFT JOIN chatHistoryShare share ON share.conversation_id = h.id
            {where_clause}
            ORDER BY h.is_pinned DESC, h.pinned_at DESC, h.updated_at DESC, h.id ASC
            LIMIT {limit_param} OFFSET {offset_param}
            ",
            limit_param = if cwd_filter.is_some() { "?2" } else { "?1" },
            offset_param = if cwd_filter.is_some() { "?3" } else { "?2" },
        ))
        .map_err(|e| format!("准备历史列表查询失败：{e}"))?;

    let mut out = Vec::new();
    if let Some(cwd) = cwd_filter.as_deref() {
        let rows = stmt
            .query_map(params![cwd, limit, offset], row_to_summary)
            .map_err(|e| format!("查询历史列表失败：{e}"))?;
        for row in rows {
            out.push(row.map_err(|e| format!("读取历史列表行失败：{e}"))?);
        }
    } else {
        let rows = stmt
            .query_map(params![limit, offset], row_to_summary)
            .map_err(|e| format!("查询历史列表失败：{e}"))?;
        for row in rows {
            out.push(row.map_err(|e| format!("读取历史列表行失败：{e}"))?);
        }
    }
    Ok(ChatHistoryListResponse {
        items: out,
        total_count: total,
    })
}

pub(crate) fn list_chat_history_workdirs_sync(
    conn: &Connection,
) -> Result<ChatHistoryWorkdirsResponse, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT TRIM(cwd) AS path, COUNT(*) AS conversation_count, MAX(updated_at) AS updated_at
            FROM chatHistory
            WHERE TRIM(COALESCE(cwd, '')) != ''
            GROUP BY TRIM(cwd)
            ORDER BY MAX(updated_at) DESC, TRIM(cwd) ASC
            ",
        )
        .map_err(|e| format!("准备历史工作目录查询失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ChatHistoryWorkdirSummary {
                path: row.get("path")?,
                conversation_count: row.get("conversation_count")?,
                updated_at: row.get("updated_at")?,
            })
        })
        .map_err(|e| format!("查询历史工作目录失败：{e}"))?;

    let mut out = Vec::new();
    for row in rows {
        let item = row.map_err(|e| format!("读取历史工作目录行失败：{e}"))?;
        if item.path.trim().is_empty() {
            continue;
        }
        out.push(item);
    }
    Ok(ChatHistoryWorkdirsResponse { workdirs: out })
}

pub(crate) fn list_shared_chat_history_sync(
    conn: &Connection,
    page: i64,
    page_size: i64,
) -> Result<ChatHistoryListResponse, String> {
    let page = resolve_history_list_page(page)?;
    let limit = resolve_history_list_page_size(page_size)?;
    let offset = (page - 1).saturating_mul(limit);
    let total = conn
        .query_row(
            "
            SELECT COUNT(*)
            FROM chatHistory h
            INNER JOIN chatHistoryShare share ON share.conversation_id = h.id
            WHERE share.enabled = 1 AND share.token IS NOT NULL
            ",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("count shared history list failed: {e}"))?;

    let mut stmt = conn
        .prepare(
            "
            SELECT
                h.id AS id,
                h.title AS title,
                h.provider_id AS provider_id,
                h.model AS model,
                h.session_id AS session_id,
                h.cwd AS cwd,
                h.total_message_count AS total_message_count,
                h.created_at AS created_at,
                h.updated_at AS updated_at,
                h.is_pinned AS is_pinned,
                h.pinned_at AS pinned_at,
                1 AS is_shared
            FROM chatHistory h
            INNER JOIN chatHistoryShare share ON share.conversation_id = h.id
            WHERE share.enabled = 1 AND share.token IS NOT NULL
            ORDER BY h.is_pinned DESC, h.pinned_at DESC, h.updated_at DESC, h.id ASC
            LIMIT ?1 OFFSET ?2
            ",
        )
        .map_err(|e| format!("prepare shared history list query failed: {e}"))?;

    let rows = stmt
        .query_map(params![limit, offset], row_to_summary)
        .map_err(|e| format!("query shared history list failed: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("read shared history list row failed: {e}"))?);
    }

    Ok(ChatHistoryListResponse {
        items: out,
        total_count: total,
    })
}

pub(crate) fn list_shared_chat_history_page_sync(
    page: i64,
    page_size: i64,
) -> Result<ChatHistoryListResponse, String> {
    let conn = open_db()?;
    list_shared_chat_history_sync(&conn, page, page_size)
}

fn history_fts_phrase(input: &str) -> String {
    let escaped = input.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

fn history_fts_score(bm25: f64) -> f64 {
    if bm25 <= 0.0 {
        -bm25
    } else {
        1.0 / (1.0 + bm25)
    }
}

fn escape_history_like(input: &str) -> String {
    let mut out = String::new();
    for ch in input.chars() {
        match ch {
            '%' | '_' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    format!("%{out}%")
}

fn history_plain_snippet(text: &str) -> String {
    let normalized = normalize_history_search_text(text);
    if normalized.chars().count() <= 160 {
        normalized
    } else {
        format!("{}...", normalized.chars().take(160).collect::<String>())
    }
}

fn parse_history_time_mode(input: Option<&str>) -> Result<HistorySearchTimeMode, String> {
    match input.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(HistorySearchTimeMode::Message),
        Some("message") => Ok(HistorySearchTimeMode::Message),
        Some("updated") | Some("segment") => Ok(HistorySearchTimeMode::Updated),
        Some("conversation") => Ok(HistorySearchTimeMode::Conversation),
        Some(other) => Err(format!(
            "historyTimeMode 只能是 message、updated 或 conversation，当前是 {other}"
        )),
    }
}

#[cfg(test)]
fn default_history_search_filter() -> HistorySearchFilter {
    HistorySearchFilter {
        since: None,
        until: None,
        time_mode: HistorySearchTimeMode::Message,
    }
}

fn local_datetime_to_ms(value: chrono::NaiveDateTime, latest: bool) -> Result<i64, String> {
    match Local.from_local_datetime(&value) {
        LocalResult::Single(datetime) => Ok(datetime.timestamp_millis()),
        LocalResult::Ambiguous(first, second) => {
            let timestamp = if latest {
                first.timestamp_millis().max(second.timestamp_millis())
            } else {
                first.timestamp_millis().min(second.timestamp_millis())
            };
            Ok(timestamp)
        }
        LocalResult::None => Err("本地日期边界无效，无法转换为时间戳".to_string()),
    }
}

fn local_date_bounds_ms(date: &str) -> Result<(i64, i64), String> {
    let date = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d")
        .map_err(|_| "historyDateLocal 必须是 YYYY-MM-DD".to_string())?;
    let start = date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| "historyDateLocal 起始时间无效".to_string())?;
    let next_date = date
        .succ_opt()
        .ok_or_else(|| "historyDateLocal 结束日期无效".to_string())?;
    let end = next_date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| "historyDateLocal 结束时间无效".to_string())?;
    Ok((
        local_datetime_to_ms(start, false)?,
        local_datetime_to_ms(end, true)?,
    ))
}

fn resolve_history_search_filter(
    history_since: Option<i64>,
    history_until: Option<i64>,
    history_date_local: Option<&str>,
    history_time_mode: Option<&str>,
) -> Result<HistorySearchFilter, String> {
    let mut since = history_since;
    let mut until = history_until;
    if let Some(date) = history_date_local
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let (date_since, date_until) = local_date_bounds_ms(date)?;
        since = Some(since.map_or(date_since, |value| value.max(date_since)));
        until = Some(until.map_or(date_until, |value| value.min(date_until)));
    }
    if let (Some(since), Some(until)) = (since, until) {
        if since >= until {
            return Err("历史搜索时间范围无效：historySince 必须早于 historyUntil".to_string());
        }
    }
    Ok(HistorySearchFilter {
        since,
        until,
        time_mode: parse_history_time_mode(history_time_mode)?,
    })
}

fn history_message_time_column(filter: &HistorySearchFilter) -> &'static str {
    match filter.time_mode {
        HistorySearchTimeMode::Message => "message_updated_at",
        HistorySearchTimeMode::Updated => "segment_updated_at",
        HistorySearchTimeMode::Conversation => "conversation_updated_at",
    }
}

fn history_segment_time_column(filter: &HistorySearchFilter) -> &'static str {
    match filter.time_mode {
        HistorySearchTimeMode::Conversation => "conversation_updated_at",
        HistorySearchTimeMode::Message | HistorySearchTimeMode::Updated => "segment_updated_at",
    }
}

fn expand_history_search_terms(query: &str) -> Vec<String> {
    let trimmed = query.trim();
    let mut terms = Vec::new();
    if !trimmed.is_empty() {
        terms.push(trimmed.to_string());
    }

    let lower = trimmed.to_lowercase();
    if lower.contains("我是谁")
        || lower.contains("我的名字")
        || lower.contains("我叫什么")
        || lower.contains("who am i")
        || lower.contains("my name")
    {
        terms.extend([
            "我叫".to_string(),
            "叫我".to_string(),
            "称呼我".to_string(),
            "我的名字是".to_string(),
            "my name is".to_string(),
            "call me".to_string(),
        ]);
    }
    if lower.contains("偏好") || lower.contains("习惯") || lower.contains("preference") {
        terms.extend(["偏好".to_string(), "习惯".to_string(), "prefer".to_string()]);
    }

    let mut deduped = Vec::new();
    for term in terms {
        let term = term.trim();
        if term.is_empty() || deduped.iter().any(|existing| existing == term) {
            continue;
        }
        deduped.push(term.to_string());
    }
    deduped
}

fn should_scan_history_plain_text(term: &str, current_matches: usize, limit: usize) -> bool {
    current_matches < limit || term.chars().count() < 3
}

fn history_match_key(match_item: &MemoryHistorySearchMatch) -> String {
    format!(
        "{}:{}:{}:{}",
        match_item.source,
        match_item.conversation_id,
        match_item.segment_index,
        match_item.message_index.unwrap_or(-1)
    )
}

fn push_history_search_match(
    out: &mut HashMap<String, MemoryHistorySearchMatch>,
    match_item: MemoryHistorySearchMatch,
) {
    let key = history_match_key(&match_item);
    match out.get(&key) {
        Some(existing) if existing.score >= match_item.score => {}
        _ => {
            out.insert(key, match_item);
        }
    }
}

fn search_chat_history_message_plain(
    conn: &Connection,
    term: &str,
    limit: usize,
    filter: &HistorySearchFilter,
    out: &mut HashMap<String, MemoryHistorySearchMatch>,
) -> Result<(), String> {
    let pattern = escape_history_like(term);
    let time_column = history_message_time_column(filter);
    let sql = format!(
        "
        SELECT
            conversation_id,
            title,
            cwd,
            segment_index,
            segment_id,
            message_index,
            message_id,
            role,
            body,
            CAST(message_updated_at AS INTEGER)
        FROM chatHistoryMessageFts
        WHERE (body LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\')
          AND (?2 IS NULL OR CAST({time_column} AS INTEGER) >= ?2)
          AND (?3 IS NULL OR CAST({time_column} AS INTEGER) < ?3)
        LIMIT ?4
        "
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备历史消息纯文本回退查询失败：{e}"))?;
    let rows = stmt
        .query_map(
            params![pattern, filter.since, filter.until, limit as i64],
            |row| {
                Ok(MemoryHistorySearchMatch {
                    source: "message".to_string(),
                    conversation_id: row.get("conversation_id")?,
                    title: row.get("title")?,
                    cwd: row.get("cwd")?,
                    segment_index: row.get("segment_index")?,
                    segment_id: row.get("segment_id")?,
                    message_index: row.get("message_index")?,
                    message_id: row.get("message_id")?,
                    role: row.get("role")?,
                    snippet: history_plain_snippet(&row.get::<_, String>(8)?),
                    score: 0.000_000_1,
                    raw_score: Some(0.000_000_1),
                    updated_at: row.get(9)?,
                })
            },
        )
        .map_err(|e| format!("执行历史消息纯文本回退查询失败：{e}"))?;
    for row in rows {
        push_history_search_match(
            out,
            row.map_err(|e| format!("读取历史消息纯文本回退结果失败：{e}"))?,
        );
    }
    Ok(())
}

fn search_chat_history_segment_plain(
    conn: &Connection,
    term: &str,
    limit: usize,
    filter: &HistorySearchFilter,
    out: &mut HashMap<String, MemoryHistorySearchMatch>,
) -> Result<(), String> {
    let pattern = escape_history_like(term);
    let time_column = history_segment_time_column(filter);
    let sql = format!(
        "
        SELECT
            conversation_id,
            title,
            cwd,
            segment_index,
            segment_id,
            body,
            CAST(segment_updated_at AS INTEGER)
        FROM chatHistorySegmentFts
        WHERE (body LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\')
          AND (?2 IS NULL OR CAST({time_column} AS INTEGER) >= ?2)
          AND (?3 IS NULL OR CAST({time_column} AS INTEGER) < ?3)
        LIMIT ?4
        "
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备历史分段纯文本回退查询失败：{e}"))?;
    let rows = stmt
        .query_map(
            params![pattern, filter.since, filter.until, limit as i64],
            |row| {
                Ok(MemoryHistorySearchMatch {
                    source: "segment".to_string(),
                    conversation_id: row.get("conversation_id")?,
                    title: row.get("title")?,
                    cwd: row.get("cwd")?,
                    segment_index: row.get("segment_index")?,
                    segment_id: row.get("segment_id")?,
                    message_index: None,
                    message_id: None,
                    role: None,
                    snippet: history_plain_snippet(&row.get::<_, String>(5)?),
                    score: 0.000_000_08,
                    raw_score: Some(0.000_000_08),
                    updated_at: row.get(6)?,
                })
            },
        )
        .map_err(|e| format!("执行历史分段纯文本回退查询失败：{e}"))?;
    for row in rows {
        push_history_search_match(
            out,
            row.map_err(|e| format!("读取历史分段纯文本回退结果失败：{e}"))?,
        );
    }
    Ok(())
}

fn is_history_time_overview_query(query: &str) -> bool {
    let trimmed = query.trim().to_lowercase();
    if trimmed.is_empty() {
        return false;
    }
    let has_date = Regex::new(r"\b\d{4}-\d{2}-\d{2}\b")
        .expect("valid date regex")
        .is_match(&trimmed);
    has_date
        || [
            "今天",
            "昨天",
            "前天",
            "当天",
            "那天",
            "最近",
            "做了什么",
            "干了什么",
            "活动",
            "回顾",
            "时间线",
            "工作",
            "进展",
            "timeline",
            "activity",
            "review",
            "what did",
        ]
        .iter()
        .any(|needle| trimmed.contains(needle))
}

fn search_chat_history_time_window(
    conn: &Connection,
    limit: usize,
    filter: &HistorySearchFilter,
) -> Result<Vec<MemoryHistorySearchMatch>, String> {
    if filter.since.is_none() && filter.until.is_none() {
        return Ok(Vec::new());
    }
    let time_column = history_segment_time_column(filter);
    let sql = format!(
        "
        SELECT
            conversation_id,
            title,
            cwd,
            segment_index,
            segment_id,
            body,
            CAST(segment_updated_at AS INTEGER)
        FROM chatHistorySegmentFts
        WHERE (?1 IS NULL OR CAST({time_column} AS INTEGER) >= ?1)
          AND (?2 IS NULL OR CAST({time_column} AS INTEGER) < ?2)
        ORDER BY CAST({time_column} AS INTEGER) DESC, conversation_id ASC, segment_index ASC
        LIMIT ?3
        "
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备历史时间窗口查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![filter.since, filter.until, limit as i64], |row| {
            Ok(MemoryHistorySearchMatch {
                source: "segment".to_string(),
                conversation_id: row.get("conversation_id")?,
                title: row.get("title")?,
                cwd: row.get("cwd")?,
                segment_index: row.get("segment_index")?,
                segment_id: row.get("segment_id")?,
                message_index: None,
                message_id: None,
                role: None,
                snippet: history_plain_snippet(&row.get::<_, String>(5)?),
                score: 0.000_000_05,
                raw_score: Some(0.000_000_05),
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| format!("执行历史时间窗口查询失败：{e}"))?;
    let mut matches = Vec::new();
    for row in rows {
        matches.push(row.map_err(|e| format!("读取历史时间窗口结果失败：{e}"))?);
    }
    Ok(matches)
}

fn search_chat_history_message_fts(
    conn: &Connection,
    query: &str,
    limit: usize,
    filter: &HistorySearchFilter,
    out: &mut HashMap<String, MemoryHistorySearchMatch>,
) -> Result<(), String> {
    let time_column = history_message_time_column(filter);
    let sql = format!(
        "
        SELECT
            conversation_id,
            title,
            cwd,
            segment_index,
            segment_id,
            message_index,
            message_id,
            role,
            snippet(chatHistoryMessageFts, 8, '[', ']', '...', 20),
            bm25(chatHistoryMessageFts),
            CAST(message_updated_at AS INTEGER)
        FROM chatHistoryMessageFts
        WHERE chatHistoryMessageFts MATCH ?1
          AND (?2 IS NULL OR CAST({time_column} AS INTEGER) >= ?2)
          AND (?3 IS NULL OR CAST({time_column} AS INTEGER) < ?3)
        LIMIT ?4
        "
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备历史消息 FTS 查询失败：{e}"))?;
    let rows = stmt
        .query_map(
            params![query, filter.since, filter.until, limit as i64],
            |row| {
                let bm25 = row.get::<_, f64>(9)?;
                let score = history_fts_score(bm25);
                Ok(MemoryHistorySearchMatch {
                    source: "message".to_string(),
                    conversation_id: row.get("conversation_id")?,
                    title: row.get("title")?,
                    cwd: row.get("cwd")?,
                    segment_index: row.get("segment_index")?,
                    segment_id: row.get("segment_id")?,
                    message_index: row.get("message_index")?,
                    message_id: row.get("message_id")?,
                    role: row.get("role")?,
                    snippet: row.get(8)?,
                    score,
                    raw_score: Some(score),
                    updated_at: row.get(10)?,
                })
            },
        )
        .map_err(|e| format!("执行历史消息 FTS 查询失败：{e}"))?;

    for row in rows {
        push_history_search_match(
            out,
            row.map_err(|e| format!("读取历史消息 FTS 结果失败：{e}"))?,
        );
    }
    Ok(())
}

fn search_chat_history_segment_fts(
    conn: &Connection,
    query: &str,
    limit: usize,
    filter: &HistorySearchFilter,
    out: &mut HashMap<String, MemoryHistorySearchMatch>,
) -> Result<(), String> {
    let time_column = history_segment_time_column(filter);
    let sql = format!(
        "
        SELECT
            conversation_id,
            title,
            cwd,
            segment_index,
            segment_id,
            snippet(chatHistorySegmentFts, 5, '[', ']', '...', 24),
            bm25(chatHistorySegmentFts),
            CAST(segment_updated_at AS INTEGER)
        FROM chatHistorySegmentFts
        WHERE chatHistorySegmentFts MATCH ?1
          AND (?2 IS NULL OR CAST({time_column} AS INTEGER) >= ?2)
          AND (?3 IS NULL OR CAST({time_column} AS INTEGER) < ?3)
        LIMIT ?4
        "
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备历史分段 FTS 查询失败：{e}"))?;
    let rows = stmt
        .query_map(
            params![query, filter.since, filter.until, limit as i64],
            |row| {
                let bm25 = row.get::<_, f64>(6)?;
                let score = history_fts_score(bm25);
                Ok(MemoryHistorySearchMatch {
                    source: "segment".to_string(),
                    conversation_id: row.get("conversation_id")?,
                    title: row.get("title")?,
                    cwd: row.get("cwd")?,
                    segment_index: row.get("segment_index")?,
                    segment_id: row.get("segment_id")?,
                    message_index: None,
                    message_id: None,
                    role: None,
                    snippet: row.get(5)?,
                    score,
                    raw_score: Some(score),
                    updated_at: row.get(7)?,
                })
            },
        )
        .map_err(|e| format!("执行历史分段 FTS 查询失败：{e}"))?;

    for row in rows {
        push_history_search_match(
            out,
            row.map_err(|e| format!("读取历史分段 FTS 结果失败：{e}"))?,
        );
    }
    Ok(())
}

fn search_chat_history_fts(
    conn: &Connection,
    query: &str,
    limit: usize,
    filter: &HistorySearchFilter,
) -> Result<Vec<MemoryHistorySearchMatch>, String> {
    let terms = expand_history_search_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    let per_table_limit = limit
        .saturating_mul(2)
        .clamp(1, MAX_HISTORY_SEARCH_LIMIT * 2);
    let mut by_key = HashMap::new();
    for term in terms {
        let fts_query = history_fts_phrase(&term);
        search_chat_history_message_fts(conn, &fts_query, per_table_limit, filter, &mut by_key)?;
        search_chat_history_segment_fts(conn, &fts_query, per_table_limit, filter, &mut by_key)?;
        if should_scan_history_plain_text(&term, by_key.len(), limit) {
            search_chat_history_message_plain(conn, &term, per_table_limit, filter, &mut by_key)?;
            search_chat_history_segment_plain(conn, &term, per_table_limit, filter, &mut by_key)?;
        }
    }

    let mut matches = by_key.into_values().collect::<Vec<_>>();
    matches.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.conversation_id.cmp(&b.conversation_id))
    });
    matches.truncate(limit);
    Ok(matches)
}

fn search_chat_history_fts_with_refresh(
    conn: &Connection,
    query: &str,
    limit: usize,
    filter: &HistorySearchFilter,
) -> Result<Vec<MemoryHistorySearchMatch>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    refresh_chat_history_fts(conn, filter)?;
    let matches = search_chat_history_fts(conn, query, limit, filter)?;
    if matches.is_empty() && is_history_time_overview_query(query) {
        return search_chat_history_time_window(conn, limit, filter);
    }
    Ok(matches)
}

fn search_chat_history_sync(
    args: ChatHistorySearchArgs,
) -> Result<ChatHistorySearchResponse, String> {
    let query = args.query.trim();
    if query.is_empty() {
        return Ok(ChatHistorySearchResponse {
            matches: Vec::new(),
        });
    }
    let limit = args
        .limit
        .unwrap_or(DEFAULT_HISTORY_SEARCH_LIMIT)
        .clamp(1, MAX_HISTORY_SEARCH_LIMIT);
    let filter = resolve_history_search_filter(
        args.history_since,
        args.history_until,
        args.history_date_local.as_deref(),
        args.history_time_mode.as_deref(),
    )?;
    let conn = open_db()?;
    Ok(ChatHistorySearchResponse {
        matches: search_chat_history_fts_with_refresh(&conn, query, limit, &filter)?,
    })
}

fn should_include_history_for_memory_search(args: &MemorySearchArgs) -> bool {
    args.include_history.unwrap_or(false)
}

pub(crate) fn search_chat_history_for_memory_sync(
    args: &MemorySearchArgs,
) -> Result<Vec<MemoryHistorySearchMatch>, String> {
    if !should_include_history_for_memory_search(args) {
        return Ok(Vec::new());
    }
    let limit = args
        .limit
        .unwrap_or(DEFAULT_HISTORY_SEARCH_LIMIT)
        .clamp(1, MAX_HISTORY_SEARCH_LIMIT);
    let filter = resolve_history_search_filter(
        args.history_since,
        args.history_until,
        args.history_date_local.as_deref(),
        args.history_time_mode.as_deref(),
    )?;
    let conn = open_db()?;
    search_chat_history_fts_with_refresh(&conn, &args.query, limit, &filter)
}

#[tauri::command]
pub async fn chat_history_list(
    page: i64,
    page_size: i64,
    cwd: Option<String>,
    cwd_empty: Option<bool>,
) -> Result<ChatHistoryListResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        list_chat_history_sync_with_filter(
            &conn,
            page,
            page_size,
            ChatHistoryListFilter {
                cwd,
                cwd_empty: cwd_empty.unwrap_or(false),
            },
        )
    })
    .await
    .map_err(|e| format!("chat_history_list join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_workdirs() -> Result<ChatHistoryWorkdirsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        list_chat_history_workdirs_sync(&conn)
    })
    .await
    .map_err(|e| format!("chat_history_workdirs join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_shared_list(
    page: i64,
    page_size: i64,
) -> Result<ChatHistoryListResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_shared_chat_history_page_sync(page, page_size)
    })
    .await
    .map_err(|e| format!("chat_history_shared_list join failed: {e}"))?
}

#[tauri::command]
pub async fn chat_history_search(
    args: ChatHistorySearchArgs,
) -> Result<ChatHistorySearchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || search_chat_history_sync(args))
        .await
        .map_err(|e| format!("chat_history_search join 失败：{e}"))?
}

pub(crate) async fn chat_history_get_summary_inner(
    id: String,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        get_summary_by_id(&conn, &id)
    })
    .await
    .map_err(|e| format!("chat_history_get_summary join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_get(id: String) -> Result<ChatHistoryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chat_id = id.trim().to_string();
        if chat_id.is_empty() {
            return Err("历史对话 id 不能为空".to_string());
        }

        let conn = open_db()?;
        let mut record = get_record_by_id(&conn, &chat_id)?;
        record.segments = load_segments(&conn, &record.id)?;
        if record.segments.is_empty() {
            return Err("历史对话缺少分段数据".to_string());
        }

        Ok(record)
    })
    .await
    .map_err(|e| format!("chat_history_get join 失败：{e}"))?
}

pub(crate) async fn chat_history_get_tail(
    id: String,
    max_messages: i64,
) -> Result<ChatHistoryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chat_id = id.trim().to_string();
        if chat_id.is_empty() {
            return Err("历史对话 id 不能为空".to_string());
        }

        let conn = open_db()?;
        let mut record = get_record_by_id(&conn, &chat_id)?;
        record.segments = load_tail_segments(&conn, &record.id, max_messages)?;
        if record.segments.is_empty() {
            return Err("历史对话缺少分段数据".to_string());
        }

        Ok(record)
    })
    .await
    .map_err(|e| format!("chat_history_get_tail join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_get_active_segment(
    id: String,
) -> Result<ChatHistoryActiveSegmentRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chat_id = id.trim().to_string();
        if chat_id.is_empty() {
            return Err("历史对话 id 不能为空".to_string());
        }

        let conn = open_db()?;
        let record = get_record_by_id(&conn, &chat_id)?;
        let context_meta_json = record.context_meta_json.clone();
        let active_segment_index = record.active_segment_index;
        let total_segment_count = record.total_segment_count;
        let active_segment = load_segment_by_index(&conn, &record.id, active_segment_index)?;
        let total_message_count = record.total_message_count;

        Ok(ChatHistoryActiveSegmentRecord {
            id: record.id,
            title: record.title,
            provider_id: record.provider_id,
            model: record.model,
            session_id: record.session_id,
            cwd: record.cwd,
            context_meta_json,
            active_segment_index,
            total_segment_count,
            total_message_count,
            active_segment,
            created_at: record.created_at,
            updated_at: record.updated_at,
            is_pinned: record.is_pinned,
            pinned_at: record.pinned_at,
            is_shared: record.is_shared,
        })
    })
    .await
    .map_err(|e| format!("chat_history_get_active_segment join 失败：{e}"))?
}

pub(crate) async fn chat_history_truncate_inner(
    id: String,
    segment_index: i64,
    message_index: i64,
    load_segments_after_truncate: bool,
) -> Result<ChatHistoryTruncateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chat_id = id.trim().to_string();
        if chat_id.is_empty() {
            return Err("历史对话 id 不能为空".to_string());
        }
        if segment_index < 0 {
            return Err("segment_index 必须 >= 0".to_string());
        }
        if message_index < 0 {
            return Err("message_index 必须 >= 0".to_string());
        }

        let mut conn = open_db()?;
        let mut record = get_record_by_id(&conn, &chat_id)?;
        let segments = load_segments(&conn, &chat_id)?;
        if segments.is_empty() {
            return Err("历史对话缺少分段数据".to_string());
        }
        let target_index =
            usize::try_from(segment_index).map_err(|_| "segment_index 超出范围".to_string())?;
        if target_index >= segments.len() {
            return Err("未找到对应的历史分段".to_string());
        }

        let mut next_segments = segments
            .iter()
            .take(target_index)
            .map(record_to_segment_input)
            .collect::<Vec<_>>();
        next_segments.push(truncate_segment_input(
            segments
                .get(target_index)
                .ok_or_else(|| "未找到对应的历史分段".to_string())?,
            message_index,
        )?);
        let keep_subagent_parent_tool_call_ids =
            retained_subagent_parent_tool_call_ids(&next_segments)?;

        let total_segment_count = i64::try_from(next_segments.len()).unwrap_or(i64::MAX);
        let total_message_count = next_segments
            .iter()
            .map(|segment| segment.message_count)
            .sum();
        let active_segment_index = total_segment_count.saturating_sub(1);
        let updated_at = next_segments
            .last()
            .map(|segment| segment.updated_at)
            .unwrap_or(record.created_at);
        let context_meta_json = update_context_meta_json_counts(
            &record.context_meta_json,
            active_segment_index,
            total_segment_count,
            total_message_count,
        )?;

        let conversation = ChatHistoryConversationInput {
            id: record.id.clone(),
            title: record.title.clone(),
            provider_id: record.provider_id.clone(),
            model: record.model.clone(),
            session_id: record.session_id.clone(),
            cwd: record.cwd.clone(),
            context_meta_json,
            active_segment_index,
            total_segment_count,
            total_message_count,
            created_at: Some(record.created_at),
            updated_at,
        };

        let tx = conn
            .transaction()
            .map_err(|e| format!("开启 truncate 历史事务失败：{e}"))?;
        upsert_chat_history_header(&tx, &conversation)?;
        sync_segments(&tx, chat_id.trim(), &next_segments, total_segment_count)?;
        let mut subagent_prune_result =
            subagent_history::prune_subagent_runs_for_parent_tool_calls(
                &tx,
                chat_id.trim(),
                &keep_subagent_parent_tool_call_ids,
            )?;
        verify_chat_history_consistency(&tx, chat_id.trim())?;
        tx.commit()
            .map_err(|e| format!("提交 truncate 历史事务失败：{e}"))?;
        subagent_history::cleanup_pruned_worktrees(&mut subagent_prune_result);
        if !subagent_prune_result.worktree_cleanup_errors.is_empty() {
            eprintln!(
                "Failed to cleanup some pruned subagent worktrees: {}",
                subagent_prune_result.worktree_cleanup_errors.join("; ")
            );
        }

        let summary = get_summary_by_id(&conn, chat_id.trim())?;
        if load_segments_after_truncate {
            record = get_record_by_id(&conn, chat_id.trim())?;
            record.segments = load_segments(&conn, chat_id.trim())?;
        }

        Ok(ChatHistoryTruncateResult { summary, record })
    })
    .await
    .map_err(|e| format!("chat_history_truncate join 失败：{e}"))?
}

fn retained_subagent_parent_tool_call_ids(
    segments: &[ChatHistorySegmentInput],
) -> Result<Vec<String>, String> {
    let mut keep = Vec::new();
    for segment in segments {
        let messages: Value = serde_json::from_str(&segment.messages_json)
            .map_err(|e| format!("解析历史消息用于子 agent 回滚失败：{e}"))?;
        let Some(messages) = messages.as_array() else {
            continue;
        };
        for message in messages {
            let Some(message) = message.as_object() else {
                continue;
            };
            if message.get("role").and_then(Value::as_str) != Some("toolResult") {
                continue;
            }
            if message.get("toolName").and_then(Value::as_str) != Some("Agent") {
                continue;
            }
            let Some(tool_call_id) = message
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            if !keep.iter().any(|existing| existing == tool_call_id) {
                keep.push(tool_call_id.to_string());
            }
        }
    }
    Ok(keep)
}

pub(crate) async fn chat_history_upsert_inner(
    input: ChatHistoryUpsertInput,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_upsert_input(&input)?;
        let conversation = ChatHistoryConversationInput {
            id: input.id.clone(),
            title: input.title.clone(),
            provider_id: input.provider_id.clone(),
            model: input.model.clone(),
            session_id: input.session_id.clone(),
            cwd: input.cwd.clone(),
            context_meta_json: input.context_meta_json.clone(),
            active_segment_index: input.active_segment_index,
            total_segment_count: input.total_segment_count,
            total_message_count: input.total_message_count,
            created_at: input.created_at,
            updated_at: input.updated_at,
        };

        let mut conn = open_db()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启聊天历史事务失败：{e}"))?;
        upsert_chat_history_header(&tx, &conversation)?;

        sync_segments(
            &tx,
            input.id.trim(),
            &input.segments,
            input.total_segment_count,
        )?;
        verify_chat_history_consistency(&tx, input.id.trim())?;

        tx.commit()
            .map_err(|e| format!("提交聊天历史事务失败：{e}"))?;

        get_summary_by_id(&conn, input.id.trim())
    })
    .await
    .map_err(|e| format!("chat_history_upsert join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_upsert(
    input: ChatHistoryUpsertInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_upsert_inner(input).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_upsert_active_segment_inner(
    input: ChatHistorySegmentMutationInput,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_segment_mutation_input(&input)?;
        let mut conn = open_db()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启 active segment 事务失败：{e}"))?;

        upsert_chat_history_header(&tx, &input.conversation)?;
        upsert_single_segment(&tx, input.conversation.id.trim(), &input.segment)?;
        verify_chat_history_consistency(&tx, input.conversation.id.trim())?;

        tx.commit()
            .map_err(|e| format!("提交 active segment 事务失败：{e}"))?;

        get_summary_by_id(&conn, input.conversation.id.trim())
    })
    .await
    .map_err(|e| format!("chat_history_upsert_active_segment join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_upsert_active_segment(
    input: ChatHistorySegmentMutationInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_upsert_active_segment_inner(input).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_append_segment_inner(
    input: ChatHistorySegmentMutationInput,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_segment_mutation_input(&input)?;
        let mut conn = open_db()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启 append segment 事务失败：{e}"))?;

        validate_append_segment_preconditions(&tx, &input)?;
        upsert_chat_history_header(&tx, &input.conversation)?;
        insert_single_segment(&tx, input.conversation.id.trim(), &input.segment)?;
        verify_chat_history_consistency(&tx, input.conversation.id.trim())?;

        tx.commit()
            .map_err(|e| format!("提交 append segment 事务失败：{e}"))?;

        get_summary_by_id(&conn, input.conversation.id.trim())
    })
    .await
    .map_err(|e| format!("chat_history_append_segment join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_append_segment(
    input: ChatHistorySegmentMutationInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_append_segment_inner(input).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_rename_inner(
    id: String,
    title: String,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        rename_chat_history_sync(&conn, &id, &title)
    })
    .await
    .map_err(|e| format!("chat_history_rename join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_rename(
    id: String,
    title: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_rename_inner(id, title).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_set_pinned_inner(
    id: String,
    is_pinned: bool,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        set_chat_history_pinned_sync(&conn, &id, is_pinned)
    })
    .await
    .map_err(|e| format!("chat_history_set_pinned join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_set_pinned(
    id: String,
    is_pinned: bool,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_set_pinned_inner(id, is_pinned).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_share_get_inner(
    id: String,
) -> Result<ChatHistoryShareStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        get_chat_history_share_status_sync(&conn, &id)
    })
    .await
    .map_err(|e| format!("chat_history_share_get join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_share_get(id: String) -> Result<ChatHistoryShareStatus, String> {
    chat_history_share_get_inner(id).await
}

pub(crate) async fn chat_history_share_set_inner(
    id: String,
    enabled: bool,
    redact_tool_content: Option<bool>,
) -> Result<ChatHistoryShareStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        set_chat_history_share_enabled_sync(&conn, &id, enabled, redact_tool_content)
    })
    .await
    .map_err(|e| format!("chat_history_share_set join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_share_set(
    id: String,
    enabled: bool,
    redact_tool_content: Option<bool>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistoryShareStatus, String> {
    let status = chat_history_share_set_inner(id, enabled, redact_tool_content).await?;
    match chat_history_get_summary_inner(status.conversation_id.clone()).await {
        Ok(summary) => {
            gateway_controller
                .publish_history_sync(build_history_sync_upsert(&summary))
                .await;
        }
        Err(error) => eprintln!("publish history share sync event failed: {error}"),
    }
    Ok(status)
}

pub(crate) async fn chat_history_share_resolve_inner(
    token: String,
) -> Result<ChatHistoryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        resolve_chat_history_share_sync(&conn, &token)
    })
    .await
    .map_err(|e| format!("chat_history_share_resolve join 失败：{e}"))?
}

fn delete_chat_history_sync(
    conn: &mut Connection,
    id: &str,
) -> Result<subagent_history::SubagentRunPruneResult, String> {
    let chat_id = id.trim().to_string();
    if chat_id.is_empty() {
        return Err("历史对话 id 不能为空".to_string());
    }

    let existing = conn
        .query_row(
            "SELECT id FROM chatHistory WHERE id = ?1",
            params![chat_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("检查历史对话是否存在失败：{e}"))?;

    if existing.is_none() {
        return Err("未找到对应的历史对话".to_string());
    }

    let tx = conn
        .transaction()
        .map_err(|e| format!("开启删除历史事务失败：{e}"))?;
    let subagent_prune_result =
        subagent_history::delete_subagent_history_for_parent_conversation(&tx, chat_id.as_str())?;
    delete_chat_history_conversation_fts(&tx, chat_id.as_str())?;
    tx.execute(
        "DELETE FROM chatHistorySegment WHERE conversation_id = ?1",
        params![chat_id.as_str()],
    )
    .map_err(|e| format!("删除历史分段失败：{e}"))?;
    tx.execute(
        "DELETE FROM chatHistory WHERE id = ?1",
        params![chat_id.as_str()],
    )
    .map_err(|e| format!("删除历史对话失败：{e}"))?;
    tx.commit()
        .map_err(|e| format!("提交删除历史事务失败：{e}"))?;
    Ok(subagent_prune_result)
}

pub(crate) async fn chat_history_delete_inner(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chat_id = id.trim().to_string();
        let mut conn = open_db()?;
        let mut subagent_prune_result = delete_chat_history_sync(&mut conn, &chat_id)?;
        subagent_history::cleanup_pruned_worktrees(&mut subagent_prune_result);
        if !subagent_prune_result.worktree_cleanup_errors.is_empty() {
            eprintln!(
                "Failed to cleanup some deleted conversation subagent worktrees: {}",
                subagent_prune_result.worktree_cleanup_errors.join("; ")
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("chat_history_delete join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_delete(
    id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    let conversation_id = id.trim().to_string();
    chat_history_delete_inner(id).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_delete(conversation_id))
        .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_db() -> Result<Connection, String> {
        let conn =
            Connection::open_in_memory().map_err(|e| format!("打开测试聊天历史数据库失败：{e}"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| format!("设置测试 SQLite busy_timeout 失败：{e}"))?;
        history_db::initialize_connection(&conn)?;
        Ok(conn)
    }

    fn sample_conversation() -> ChatHistoryConversationInput {
        ChatHistoryConversationInput {
            id: "conv-1".to_string(),
            title: "Test Conversation".to_string(),
            provider_id: "codex".to_string(),
            model: "gpt-5".to_string(),
            session_id: Some("session-1".to_string()),
            cwd: Some("/tmp".to_string()),
            context_meta_json: "{}".to_string(),
            active_segment_index: 0,
            total_segment_count: 1,
            total_message_count: 3,
            created_at: Some(1_700_000_000_000),
            updated_at: 1_700_000_000_100,
        }
    }

    fn table_column_names(conn: &Connection, table_name: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table_name})"))
            .expect("prepare table info query");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table info");
        let mut columns = rows
            .map(|row| row.expect("read table column name"))
            .collect::<Vec<_>>();
        columns.sort();
        columns
    }

    fn insert_subagent_run_for_test(
        conn: &Connection,
        run_id: &str,
        parent_tool_call_id: &str,
        agent_index: i64,
    ) {
        conn.execute(
            "
            INSERT INTO subagentRun (
                id,
                parent_conversation_id,
                parent_tool_call_id,
                parent_tool_name,
                agent_index,
                agent_total,
                logical_agent_id,
                description,
                mode,
                status,
                provider_id,
                model,
                context_meta_json,
                active_segment_index,
                total_segment_count,
                total_message_count,
                started_at,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
            ",
            params![
                run_id,
                "conv-1",
                parent_tool_call_id,
                "Agent",
                agent_index,
                2,
                format!("agent-{agent_index}"),
                format!("Agent {agent_index}"),
                "worktree",
                "completed",
                "codex",
                "gpt-5",
                "{}",
                0,
                1,
                1,
                1_700_000_000_100_i64,
                1_700_000_000_100_i64,
                1_700_000_000_200_i64,
            ],
        )
        .expect("insert subagent run");
    }

    #[test]
    fn get_summary_by_id_reads_total_message_count() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();

        upsert_chat_history_header(&conn, &conversation).expect("upsert header");

        let summary = get_summary_by_id(&conn, &conversation.id).expect("load summary");

        assert_eq!(summary.id, conversation.id);
        assert_eq!(summary.message_count, conversation.total_message_count);
        assert_eq!(summary.title, conversation.title);
    }

    #[test]
    fn initialize_db_migrates_legacy_pin_columns() {
        let conn =
            Connection::open_in_memory().expect("open legacy in-memory chat history database");
        conn.execute_batch(
            "
            CREATE TABLE chatHistory (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                session_id TEXT,
                cwd TEXT,
                context_meta_json TEXT,
                active_segment_index INTEGER,
                total_segment_count INTEGER,
                total_message_count INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            ",
        )
        .expect("create legacy chatHistory table");

        history_db::initialize_connection(&conn).expect("migrate legacy schema");

        let is_pinned_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('chatHistory') WHERE name = 'is_pinned'",
                [],
                |row| row.get(0),
            )
            .expect("query is_pinned column");
        let pinned_at_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('chatHistory') WHERE name = 'pinned_at'",
                [],
                |row| row.get(0),
            )
            .expect("query pinned_at column");

        assert_eq!(is_pinned_exists, 1);
        assert_eq!(pinned_at_exists, 1);
        let share_table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'chatHistoryShare'",
                [],
                |row| row.get(0),
            )
            .expect("query share table");
        assert_eq!(share_table_exists, 1);
    }

    #[test]
    fn initialize_db_migrates_legacy_history_columns_for_list_query() {
        let conn =
            Connection::open_in_memory().expect("open legacy in-memory chat history database");
        conn.execute_batch(
            "
            CREATE TABLE chatHistory (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            INSERT INTO chatHistory (
                id,
                title,
                provider_id,
                model,
                created_at,
                updated_at
            ) VALUES (
                'legacy-conv',
                'Legacy Conversation',
                'codex',
                'gpt-5',
                1700000000000,
                1700000000100
            );
            ",
        )
        .expect("create legacy chatHistory table");

        history_db::initialize_connection(&conn).expect("migrate legacy schema");

        let summaries = list_chat_history_sync(&conn, 1, 20).expect("list migrated legacy history");
        assert_eq!(summaries.total_count, 1);
        let summaries = summaries.items;
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "legacy-conv");
        assert_eq!(summaries[0].session_id, None);
        assert_eq!(summaries[0].cwd, None);
        assert_eq!(summaries[0].message_count, 0);
        assert!(!summaries[0].is_pinned);

        let record = get_record_by_id(&conn, "legacy-conv").expect("load migrated record");
        assert_eq!(record.context_meta_json, "{}");
        assert_eq!(record.active_segment_index, 0);
        assert_eq!(record.total_segment_count, 1);
        assert_eq!(record.total_message_count, 0);
    }

    #[test]
    fn initialize_db_tolerates_case_variant_existing_columns() {
        let conn =
            Connection::open_in_memory().expect("open legacy in-memory chat history database");
        conn.execute_batch(
            "
            CREATE TABLE chatHistory (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                Context_Meta_Json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            INSERT INTO chatHistory (
                id,
                title,
                provider_id,
                model,
                created_at,
                updated_at
            ) VALUES (
                'legacy-conv',
                'Legacy Conversation',
                'codex',
                'gpt-5',
                1700000000000,
                1700000000100
            );
            ",
        )
        .expect("create legacy chatHistory table with case-variant context meta column");

        history_db::initialize_connection(&conn)
            .expect("migrate legacy schema with case-variant column");

        let context_meta_json: String = conn
            .query_row(
                "SELECT context_meta_json FROM chatHistory WHERE id = 'legacy-conv'",
                [],
                |row| row.get(0),
            )
            .expect("query migrated context meta");
        assert_eq!(context_meta_json, "{}");
    }

    #[test]
    fn migrated_legacy_table_columns_match_fresh_schema() {
        let fresh = open_test_db().expect("open fresh test db");
        let legacy =
            Connection::open_in_memory().expect("open legacy in-memory chat history database");
        legacy
            .execute_batch(
                "
                CREATE TABLE chatHistory (
                    id TEXT PRIMARY KEY
                );

                CREATE TABLE chatHistorySegment (
                    conversation_id TEXT NOT NULL,
                    segment_index INTEGER NOT NULL,
                    PRIMARY KEY (conversation_id, segment_index)
                );

                CREATE TABLE chatHistoryShare (
                    conversation_id TEXT PRIMARY KEY
                );

                CREATE TABLE chatHistoryFtsSegmentIndex (
                    conversation_id TEXT NOT NULL,
                    segment_index INTEGER NOT NULL,
                    PRIMARY KEY (conversation_id, segment_index)
                );

                INSERT INTO chatHistory (id) VALUES ('legacy-conv');
                INSERT INTO chatHistorySegment (
                    conversation_id,
                    segment_index
                ) VALUES (
                    'legacy-conv',
                    0
                );
                INSERT INTO chatHistoryShare (conversation_id) VALUES ('legacy-conv');
                ",
            )
            .expect("create minimal legacy history schema");

        history_db::initialize_connection(&legacy).expect("migrate minimal legacy schema");

        for table_name in [
            "chatHistory",
            "chatHistorySegment",
            "chatHistoryShare",
            "chatHistoryFtsSegmentIndex",
        ] {
            assert_eq!(
                table_column_names(&legacy, table_name),
                table_column_names(&fresh, table_name),
                "migrated {table_name} columns should match fresh schema"
            );
        }

        let summaries =
            list_chat_history_sync(&legacy, 1, 20).expect("list minimal migrated history");
        assert_eq!(summaries.total_count, 1);
        let summaries = summaries.items;
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].title, "Untitled");
        assert_eq!(summaries[0].message_count, 0);

        let segments = load_segments(&legacy, "legacy-conv").expect("load minimal segment");
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].segment_id, "segment-0");
        assert_eq!(segments[0].messages_json, "[]");
        assert_eq!(segments[0].message_count, 0);
    }

    #[test]
    fn pinned_history_sorts_first_and_unpin_restores_updated_order() {
        let conn = open_test_db().expect("open test db");
        let mut older = sample_conversation();
        older.id = "older".to_string();
        older.updated_at = 1_700_000_000_100;
        let mut newer = sample_conversation();
        newer.id = "newer".to_string();
        newer.updated_at = 1_700_000_000_200;

        upsert_chat_history_header(&conn, &older).expect("upsert older header");
        upsert_chat_history_header(&conn, &newer).expect("upsert newer header");
        let pinned =
            set_chat_history_pinned_sync(&conn, "older", true).expect("pin older conversation");
        assert!(pinned.is_pinned);
        assert!(pinned.pinned_at.is_some());

        let pinned_order = list_chat_history_sync(&conn, 1, 20)
            .expect("list pinned history")
            .items;
        assert_eq!(
            pinned_order
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["older", "newer"]
        );

        let unpinned =
            set_chat_history_pinned_sync(&conn, "older", false).expect("unpin older conversation");
        assert!(!unpinned.is_pinned);
        assert_eq!(unpinned.pinned_at, None);

        let restored_order = list_chat_history_sync(&conn, 1, 20)
            .expect("list unpinned history")
            .items;
        assert_eq!(
            restored_order
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["newer", "older"]
        );
    }

    #[test]
    fn list_history_returns_limited_page_and_total() {
        let conn = open_test_db().expect("open test db");
        for index in 0..5 {
            let mut conversation = sample_conversation();
            conversation.id = format!("conv-{index}");
            conversation.updated_at = 1_700_000_000_000 + index;
            upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        }

        let page = list_chat_history_sync(&conn, 2, 2).expect("list history page");

        assert_eq!(page.total_count, 5);
        assert_eq!(
            page.items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["conv-2", "conv-1"]
        );
    }

    #[test]
    fn list_history_filters_by_cwd_and_empty_cwd() {
        let conn = open_test_db().expect("open test db");
        let mut project_a = sample_conversation();
        project_a.id = "project-a".to_string();
        project_a.cwd = Some("/tmp/project-a".to_string());
        project_a.updated_at = 1_700_000_000_300;
        let mut project_b = sample_conversation();
        project_b.id = "project-b".to_string();
        project_b.cwd = Some("/tmp/project-b".to_string());
        project_b.updated_at = 1_700_000_000_200;
        let mut empty_cwd = sample_conversation();
        empty_cwd.id = "chat-mode".to_string();
        empty_cwd.cwd = None;
        empty_cwd.updated_at = 1_700_000_000_100;

        upsert_chat_history_header(&conn, &project_a).expect("upsert project a");
        upsert_chat_history_header(&conn, &project_b).expect("upsert project b");
        upsert_chat_history_header(&conn, &empty_cwd).expect("upsert empty cwd");

        let project_page = list_chat_history_sync_with_filter(
            &conn,
            1,
            20,
            ChatHistoryListFilter {
                cwd: Some("/tmp/project-a".to_string()),
                cwd_empty: false,
            },
        )
        .expect("list project cwd history");
        assert_eq!(project_page.total_count, 1);
        assert_eq!(project_page.items[0].id, "project-a");

        let empty_page = list_chat_history_sync_with_filter(
            &conn,
            1,
            20,
            ChatHistoryListFilter {
                cwd: None,
                cwd_empty: true,
            },
        )
        .expect("list empty cwd history");
        assert_eq!(empty_page.total_count, 1);
        assert_eq!(empty_page.items[0].id, "chat-mode");
    }

    #[test]
    fn list_history_workdirs_returns_distinct_non_empty_cwd_counts() {
        let conn = open_test_db().expect("open test db");
        for (id, cwd, updated_at) in [
            ("project-a-older", "/tmp/project-a", 1_700_000_000_100),
            ("project-a-newer", "/tmp/project-a", 1_700_000_000_300),
            ("project-b", "/tmp/project-b", 1_700_000_000_200),
        ] {
            let mut conversation = sample_conversation();
            conversation.id = id.to_string();
            conversation.cwd = Some(cwd.to_string());
            conversation.updated_at = updated_at;
            upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        }
        let mut empty_cwd = sample_conversation();
        empty_cwd.id = "chat-mode".to_string();
        empty_cwd.cwd = None;
        upsert_chat_history_header(&conn, &empty_cwd).expect("upsert empty cwd");

        let response = list_chat_history_workdirs_sync(&conn).expect("list workdirs");

        assert_eq!(response.workdirs.len(), 2);
        assert_eq!(response.workdirs[0].path, "/tmp/project-a");
        assert_eq!(response.workdirs[0].conversation_count, 2);
        assert_eq!(response.workdirs[0].updated_at, 1_700_000_000_300);
        assert_eq!(response.workdirs[1].path, "/tmp/project-b");
        assert_eq!(response.workdirs[1].conversation_count, 1);
    }

    #[test]
    fn list_shared_history_returns_enabled_shares_only() {
        let conn = open_test_db().expect("open test db");
        for index in 0..4 {
            let mut conversation = sample_conversation();
            conversation.id = format!("conv-{index}");
            conversation.updated_at = 1_700_000_000_000 + index;
            upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        }

        set_chat_history_share_enabled_sync(&conn, "conv-0", true, None).expect("share conv-0");
        set_chat_history_share_enabled_sync(&conn, "conv-2", true, None).expect("share conv-2");
        set_chat_history_share_enabled_sync(&conn, "conv-3", true, None).expect("share conv-3");
        set_chat_history_share_enabled_sync(&conn, "conv-3", false, None)
            .expect("disable conv-3 share");

        let page = list_shared_chat_history_sync(&conn, 1, 1).expect("list shared history");

        assert_eq!(page.total_count, 2);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "conv-2");
        assert!(page.items[0].is_shared);
    }

    #[test]
    fn upsert_header_preserves_existing_pin_state() {
        let conn = open_test_db().expect("open test db");
        let mut conversation = sample_conversation();

        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        let pinned = set_chat_history_pinned_sync(&conn, "conv-1", true).expect("pin conversation");
        let pinned_at = pinned.pinned_at.expect("pinned_at set");

        conversation.title = "Updated Conversation".to_string();
        conversation.updated_at += 1_000;
        upsert_chat_history_header(&conn, &conversation).expect("upsert updated header");
        let summary = get_summary_by_id(&conn, "conv-1").expect("load updated summary");

        assert!(summary.is_pinned);
        assert_eq!(summary.pinned_at, Some(pinned_at));
        assert_eq!(summary.title, "Updated Conversation");
    }

    #[test]
    fn rename_preserves_existing_pin_state() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();

        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        let pinned = set_chat_history_pinned_sync(&conn, "conv-1", true).expect("pin conversation");
        let pinned_at = pinned.pinned_at.expect("pinned_at set");

        let renamed =
            rename_chat_history_sync(&conn, "conv-1", "Renamed Conversation").expect("rename");

        assert!(renamed.is_pinned);
        assert_eq!(renamed.pinned_at, Some(pinned_at));
        assert_eq!(renamed.title, "Renamed Conversation");
    }

    #[test]
    fn share_status_is_disabled_by_default() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");

        let status = get_chat_history_share_status_sync(&conn, "conv-1").expect("get share status");
        let summary = get_summary_by_id(&conn, "conv-1").expect("get summary");

        assert_eq!(status.conversation_id, "conv-1");
        assert!(!status.enabled);
        assert_eq!(status.token, None);
        assert!(!status.redact_tool_content);
        assert!(!summary.is_shared);
    }

    #[test]
    fn share_enable_disable_and_reenable_rotates_token() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");

        let enabled =
            set_chat_history_share_enabled_sync(&conn, "conv-1", true, None).expect("enable share");
        let first_token = enabled.token.clone().expect("share token");
        assert!(enabled.enabled);
        assert_eq!(first_token.len(), 9);
        assert!(first_token.chars().all(|ch| ch.is_ascii_alphanumeric()));

        let enabled_again = set_chat_history_share_enabled_sync(&conn, "conv-1", true, None)
            .expect("enable share again");
        assert_eq!(enabled_again.token.as_deref(), Some(first_token.as_str()));
        assert!(
            get_summary_by_id(&conn, "conv-1")
                .expect("get enabled summary")
                .is_shared
        );

        let disabled = set_chat_history_share_enabled_sync(&conn, "conv-1", false, None)
            .expect("disable share");
        assert!(!disabled.enabled);
        assert_eq!(disabled.token, None);
        assert!(
            !get_summary_by_id(&conn, "conv-1")
                .expect("get disabled summary")
                .is_shared
        );
        assert!(resolve_chat_history_share_sync(&conn, &first_token).is_err());

        let reenabled = set_chat_history_share_enabled_sync(&conn, "conv-1", true, None)
            .expect("reenable share");
        let second_token = reenabled.token.expect("share token");
        assert!(reenabled.enabled);
        assert_ne!(first_token, second_token);
        assert!(resolve_chat_history_share_sync(&conn, &first_token).is_err());
    }

    #[test]
    fn share_redact_tool_content_can_be_updated_independently() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");

        let enabled = set_chat_history_share_enabled_sync(&conn, "conv-1", true, Some(true))
            .expect("enable share with redaction");
        let token = enabled.token.clone().expect("share token");
        assert!(enabled.enabled);
        assert!(enabled.redact_tool_content);

        let enabled_again = set_chat_history_share_enabled_sync(&conn, "conv-1", true, None)
            .expect("enable share without changing redaction");
        assert_eq!(enabled_again.token.as_deref(), Some(token.as_str()));
        assert!(enabled_again.redact_tool_content);

        let updated = set_chat_history_share_enabled_sync(&conn, "conv-1", true, Some(false))
            .expect("disable share redaction");
        assert_eq!(updated.token.as_deref(), Some(token.as_str()));
        assert!(!updated.redact_tool_content);

        let disabled = set_chat_history_share_enabled_sync(&conn, "conv-1", false, Some(true))
            .expect("disable share and preserve redaction preference");
        assert!(!disabled.enabled);
        assert_eq!(disabled.token, None);
        assert!(disabled.redact_tool_content);
    }

    #[test]
    fn share_rows_are_removed_with_conversation() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        set_chat_history_share_enabled_sync(&conn, "conv-1", true, None).expect("enable share");

        conn.execute("DELETE FROM chatHistory WHERE id = ?1", params!["conv-1"])
            .expect("delete parent conversation");

        let share_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chatHistoryShare", [], |row| {
                row.get(0)
            })
            .expect("count share rows");
        assert_eq!(share_count, 0);
    }

    #[test]
    fn delete_conversation_removes_subagent_history() {
        let mut conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: None,
                messages_json: r#"[
                  {"id":"m-user","role":"user","content":"start","timestamp":1700000000001},
                  {"id":"m-agent","role":"toolResult","toolName":"Agent","toolCallId":"call-delete","content":"done","timestamp":1700000000002}
                ]"#
                .to_string(),
                message_count: 2,
                start_message_id: Some("m-user".to_string()),
                end_message_id: Some("m-agent".to_string()),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_002,
            },
        )
        .expect("upsert segment");
        insert_subagent_run_for_test(&conn, "run-delete", "call-delete", 0);
        conn.execute(
            "
            INSERT INTO subagentRunSegment (
                run_id,
                segment_index,
                segment_id,
                messages_json,
                message_count,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ",
            params![
                "run-delete",
                0,
                "subagent-segment-0",
                "[]",
                0,
                1_700_000_000_100_i64,
                1_700_000_000_200_i64,
            ],
        )
        .expect("insert subagent segment");
        conn.execute(
            "
            INSERT INTO subagentRunEvent (
                run_id,
                event_type,
                is_error,
                created_at
            ) VALUES (?1, ?2, ?3, ?4)
            ",
            params!["run-delete", "turn_start", 0, 1_700_000_000_200_i64],
        )
        .expect("insert subagent event");
        conn.execute(
            "
            INSERT INTO subagentMessageBusEntry (
                parent_conversation_id,
                seq,
                sender_agent_id,
                recipient_agent_id,
                channel,
                body_markdown,
                source_run_id,
                source_tool_call_id,
                created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ",
            params![
                "conv-1",
                1_i64,
                "agent-0",
                "parent",
                "direct",
                "message with run",
                "run-delete",
                "call-send-delete",
                1_700_000_000_300_i64,
            ],
        )
        .expect("insert run-scoped message");
        conn.execute(
            "
            INSERT INTO subagentMessageBusEntry (
                parent_conversation_id,
                seq,
                sender_agent_id,
                recipient_agent_id,
                channel,
                body_markdown,
                created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ",
            params![
                "conv-1",
                2_i64,
                "agent-0",
                "parent",
                "direct",
                "message without run",
                1_700_000_000_400_i64,
            ],
        )
        .expect("insert parent-scoped message");
        conn.execute(
            "
            INSERT INTO subagentIdentity (
                parent_conversation_id,
                logical_agent_id,
                display_name,
                role,
                identity_prompt,
                default_mode,
                default_task_intent,
                default_apply_policy,
                created_parent_tool_call_id,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ",
            params![
                "conv-1",
                "agent-0",
                "Deleted Agent",
                "Reviewer",
                "Stable identity",
                "readonly",
                "review",
                "none",
                "call-delete",
                1_700_000_000_000_i64,
                1_700_000_000_100_i64,
            ],
        )
        .expect("insert subagent identity");

        let result = delete_chat_history_sync(&mut conn, "conv-1").expect("delete conversation");

        assert_eq!(result.deleted_run_count, 1);
        for table_name in [
            "chatHistory",
            "chatHistorySegment",
            "subagentRun",
            "subagentRunSegment",
            "subagentRunEvent",
            "subagentMessageBusEntry",
            "subagentIdentity",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table_name}"), [], |row| {
                    row.get(0)
                })
                .unwrap_or_else(|error| panic!("count {table_name}: {error}"));
            assert_eq!(count, 0, "{table_name} should be empty after delete");
        }
    }

    #[test]
    fn resolve_share_returns_full_conversation_segments() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: None,
                messages_json:
                    r#"[{"role":"user","content":"hello"},{"role":"assistant","content":"world"}]"#
                        .to_string(),
                message_count: 2,
                start_message_id: Some("m-1".to_string()),
                end_message_id: Some("m-2".to_string()),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_100,
            },
        )
        .expect("upsert segment");
        let status =
            set_chat_history_share_enabled_sync(&conn, "conv-1", true, None).expect("enable share");
        let token = status.token.expect("share token");

        let record = resolve_chat_history_share_sync(&conn, &token).expect("resolve share");

        assert_eq!(record.id, "conv-1");
        assert_eq!(record.segments.len(), 1);
        assert_eq!(record.segments[0].message_count, 2);
        assert!(record.segments[0].messages_json.contains("hello"));
    }

    #[test]
    fn chat_history_fts_indexes_message_and_segment_text() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: None,
                messages_json: r#"[
                  {"id":"m-user","role":"user","content":"以后请用陕西腔跟我说话。","timestamp":1700000000001},
                  {"id":"m-assistant","role":"assistant","content":[{"type":"text","text":"我会记住陕西腔偏好。"},{"type":"thinking","thinking":"hidden"}],"timestamp":1700000000002}
                ]"#
                .to_string(),
                message_count: 2,
                start_message_id: Some("m-user".to_string()),
                end_message_id: Some("m-assistant".to_string()),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_002,
            },
        )
        .expect("upsert segment");

        let matches = search_chat_history_fts(&conn, "陕西腔", 8, &default_history_search_filter())
            .expect("search history fts");

        assert!(
            matches.iter().any(|item| item.source == "message"
                && item.role.as_deref() == Some("user")
                && item.snippet.contains("陕西腔")),
            "message-level FTS should match user text: {:?}",
            matches
        );
        assert!(
            matches
                .iter()
                .any(|item| item.source == "segment" && item.snippet.contains("陕西腔")),
            "segment-level FTS should match aggregated segment text: {:?}",
            matches
        );
        assert!(
            !matches.iter().any(|item| item.snippet.contains("hidden")),
            "thinking text must not be indexed: {:?}",
            matches
        );
    }

    #[test]
    fn chat_history_fts_filters_matches_by_time_range() {
        let conn = open_test_db().expect("open test db");
        let mut conversation = sample_conversation();
        conversation.total_segment_count = 2;
        conversation.total_message_count = 2;
        conversation.updated_at = 1_700_000_100_000;
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: None,
                messages_json: r#"[{"id":"m-early","role":"user","content":"rangemarker early","timestamp":1700000000001}]"#
                    .to_string(),
                message_count: 1,
                start_message_id: Some("m-early".to_string()),
                end_message_id: Some("m-early".to_string()),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_001,
            },
        )
        .expect("upsert early segment");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 1,
                segment_id: "segment-1".to_string(),
                summary_json: None,
                messages_json: r#"[{"id":"m-late","role":"user","content":"rangemarker late","timestamp":1700000100001}]"#
                    .to_string(),
                message_count: 1,
                start_message_id: Some("m-late".to_string()),
                end_message_id: Some("m-late".to_string()),
                created_at: 1_700_000_100_000,
                updated_at: 1_700_000_100_001,
            },
        )
        .expect("upsert late segment");

        let filter = HistorySearchFilter {
            since: Some(1_700_000_050_000),
            until: Some(1_700_000_200_000),
            time_mode: HistorySearchTimeMode::Message,
        };
        let matches =
            search_chat_history_fts(&conn, "rangemarker", 8, &filter).expect("search with time");

        assert!(
            matches.iter().any(|item| item.snippet.contains("late")),
            "time-filtered search should keep late match: {:?}",
            matches
        );
        assert!(
            !matches.iter().any(|item| item.snippet.contains("early")),
            "time-filtered search should remove early match: {:?}",
            matches
        );
    }

    #[test]
    fn chat_history_time_overview_query_falls_back_to_time_window() {
        let conn = open_test_db().expect("open test db");
        let mut conversation = sample_conversation();
        conversation.total_segment_count = 2;
        conversation.total_message_count = 2;
        conversation.updated_at = 1_700_000_100_000;
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: None,
                messages_json: r#"[{"id":"m-early","role":"user","content":"early travel planning marker","timestamp":1700000000001}]"#
                    .to_string(),
                message_count: 1,
                start_message_id: Some("m-early".to_string()),
                end_message_id: Some("m-early".to_string()),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_001,
            },
        )
        .expect("upsert early segment");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 1,
                segment_id: "segment-1".to_string(),
                summary_json: None,
                messages_json: r#"[{"id":"m-late","role":"user","content":"late travel planning marker","timestamp":1700000100001}]"#
                    .to_string(),
                message_count: 1,
                start_message_id: Some("m-late".to_string()),
                end_message_id: Some("m-late".to_string()),
                created_at: 1_700_000_100_000,
                updated_at: 1_700_000_100_001,
            },
        )
        .expect("upsert late segment");

        let filter = HistorySearchFilter {
            since: Some(1_700_000_050_000),
            until: Some(1_700_000_200_000),
            time_mode: HistorySearchTimeMode::Updated,
        };
        let matches = search_chat_history_fts_with_refresh(&conn, "2026-05-13", 8, &filter)
            .expect("date overview query should use time window fallback");

        assert!(
            matches.iter().any(|item| item.snippet.contains("late")),
            "time-window fallback should include in-range segment: {:?}",
            matches
        );
        assert!(
            !matches.iter().any(|item| item.snippet.contains("early")),
            "time-window fallback should exclude out-of-range segment: {:?}",
            matches
        );
    }

    #[test]
    fn history_search_filter_accepts_local_date_and_time_mode() {
        let filter = resolve_history_search_filter(None, None, Some("2026-05-14"), Some("updated"))
            .expect("resolve local date filter");

        assert_eq!(filter.time_mode, HistorySearchTimeMode::Updated);
        assert!(filter.since.is_some());
        assert!(filter.until.is_some());
        assert!(filter.since.unwrap() < filter.until.unwrap());
    }

    #[test]
    fn memory_history_search_respects_explicit_include_history_with_type_filter() {
        let mut args = MemorySearchArgs {
            query: "2026-05-12".to_string(),
            scope: None,
            workdir: None,
            memory_type: Some("daily".to_string()),
            limit: None,
            include_history: None,
            history_since: None,
            history_until: None,
            history_date_local: Some("2026-05-12".to_string()),
            history_time_mode: Some("message".to_string()),
        };

        assert!(
            !should_include_history_for_memory_search(&args),
            "type-filtered memory search defaults history off"
        );
        args.memory_type = None;
        assert!(
            !should_include_history_for_memory_search(&args),
            "unfiltered memory search also defaults history off"
        );
        args.include_history = Some(true);
        assert!(
            should_include_history_for_memory_search(&args),
            "explicit includeHistory=true must still search chat history"
        );
    }

    #[test]
    fn chat_history_fts_backfills_existing_segments() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        conn.execute(
            "
            INSERT INTO chatHistorySegment (
                conversation_id,
                segment_index,
                segment_id,
                summary_json,
                messages_json,
                message_count,
                start_message_id,
                end_message_id,
                created_at,
                updated_at
            ) VALUES (?1, 0, 'segment-0', NULL, ?2, 1, 'm-user', 'm-user', ?3, ?4)
            ",
            params![
                "conv-1",
                r#"[{"id":"m-user","role":"user","content":"请以后称呼我为林舟。","timestamp":1700000000001}]"#,
                1_700_000_000_000_i64,
                1_700_000_000_001_i64,
            ],
        )
        .expect("insert legacy segment without fts");

        let before = search_chat_history_fts(&conn, "林舟", 8, &default_history_search_filter())
            .expect("search before backfill");
        assert!(before.is_empty());

        refresh_chat_history_fts(&conn, &default_history_search_filter()).expect("refresh fts");
        let after = search_chat_history_fts(&conn, "林舟", 8, &default_history_search_filter())
            .expect("search after backfill");

        assert!(
            after.iter().any(|item| item.snippet.contains("林舟")),
            "backfilled FTS should find existing history: {:?}",
            after
        );
    }

    #[test]
    fn initialize_db_does_not_backfill_chat_history_fts() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        conn.execute(
            "
            INSERT INTO chatHistorySegment (
                conversation_id,
                segment_index,
                segment_id,
                summary_json,
                messages_json,
                message_count,
                start_message_id,
                end_message_id,
                created_at,
                updated_at
            ) VALUES (?1, 0, 'segment-0', NULL, ?2, 1, 'm-user', 'm-user', ?3, ?4)
            ",
            params![
                "conv-1",
                r#"[{"id":"m-user","role":"user","content":"热路径不能做全库回填。","timestamp":1700000000001}]"#,
                1_700_000_000_000_i64,
                1_700_000_000_001_i64,
            ],
        )
        .expect("insert legacy segment without fts");

        history_db::initialize_connection(&conn).expect("re-run schema initialization");
        let after_init =
            search_chat_history_fts(&conn, "热路径", 8, &default_history_search_filter())
                .expect("search after schema init");

        assert!(
            after_init.is_empty(),
            "schema initialization should not rebuild history FTS: {:?}",
            after_init
        );
    }

    #[test]
    fn chat_history_search_refreshes_fts_before_query() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        conn.execute(
            "
            INSERT INTO chatHistorySegment (
                conversation_id,
                segment_index,
                segment_id,
                summary_json,
                messages_json,
                message_count,
                start_message_id,
                end_message_id,
                created_at,
                updated_at
            ) VALUES (?1, 0, 'segment-0', NULL, ?2, 1, 'm-user', 'm-user', ?3, ?4)
            ",
            params![
                "conv-1",
                r#"[{"id":"m-user","role":"user","content":"搜索入口负责回填历史正文索引。","timestamp":1700000000001}]"#,
                1_700_000_000_000_i64,
                1_700_000_000_001_i64,
            ],
        )
        .expect("insert legacy segment without fts");

        let matches = search_chat_history_fts_with_refresh(
            &conn,
            "历史正文索引",
            8,
            &default_history_search_filter(),
        )
        .expect("search with refresh");

        assert!(
            matches
                .iter()
                .any(|item| item.snippet.contains("历史正文索引")),
            "search should refresh FTS before querying: {:?}",
            matches
        );
    }

    #[test]
    fn chat_history_fts_refresh_is_bounded_on_large_legacy_backfills() {
        let conn = open_test_db().expect("open test db");
        let mut conversation = sample_conversation();
        conversation.total_segment_count = (CHAT_HISTORY_FTS_REFRESH_BATCH_SIZE + 1) as i64;
        conversation.total_message_count = (CHAT_HISTORY_FTS_REFRESH_BATCH_SIZE + 1) as i64;
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");

        for index in 0..=CHAT_HISTORY_FTS_REFRESH_BATCH_SIZE {
            let marker = format!("bounded-refresh-{index}");
            conn.execute(
                "
                INSERT INTO chatHistorySegment (
                    conversation_id,
                    segment_index,
                    segment_id,
                    summary_json,
                    messages_json,
                    message_count,
                    start_message_id,
                    end_message_id,
                    created_at,
                    updated_at
                ) VALUES (?1, ?2, ?3, NULL, ?4, 1, ?5, ?5, ?6, ?6)
                ",
                params![
                    "conv-1",
                    index as i64,
                    format!("segment-{index}"),
                    format!(
                        r#"[{{"id":"m-{index}","role":"user","content":"{marker}","timestamp":1700000000001}}]"#
                    ),
                    format!("m-{index}"),
                    1_700_000_000_000_i64 + index as i64,
                ],
            )
            .expect("insert legacy segment without fts");
        }

        refresh_chat_history_fts(&conn, &default_history_search_filter()).expect("refresh fts");
        let indexed_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chatHistoryFtsSegmentIndex",
                [],
                |row| row.get(0),
            )
            .expect("count indexed segments");

        assert_eq!(indexed_count, CHAT_HISTORY_FTS_REFRESH_BATCH_SIZE as i64);
    }

    #[test]
    fn chat_history_fts_search_deduplicates_duplicate_segment_rows() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: None,
                messages_json: r#"[{"id":"m-user","role":"user","content":"重复索引自愈测试","timestamp":1700000000001}]"#
                    .to_string(),
                message_count: 1,
                start_message_id: Some("m-user".to_string()),
                end_message_id: Some("m-user".to_string()),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_001,
            },
        )
        .expect("upsert segment");

        conn.execute(
            "
            INSERT INTO chatHistorySegmentFts (
                conversation_id,
                segment_index,
                segment_id,
                title,
                cwd,
                body,
                segment_updated_at,
                conversation_updated_at
            )
            SELECT
                conversation_id,
                segment_index,
                segment_id,
                title,
                cwd,
                body,
                segment_updated_at,
                conversation_updated_at
            FROM chatHistorySegmentFts
            WHERE conversation_id = 'conv-1' AND segment_index = 0
            ",
            [],
        )
        .expect("duplicate segment fts row");

        let matches = search_chat_history_fts(
            &conn,
            "重复索引自愈测试",
            8,
            &default_history_search_filter(),
        )
        .expect("search duplicate fts rows");
        let segment_matches = matches
            .iter()
            .filter(|item| item.source == "segment" && item.segment_index == 0)
            .count();

        assert_eq!(segment_matches, 1, "duplicate FTS rows must not leak to UI");
    }

    #[test]
    fn resolve_share_allows_empty_persisted_history() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        let status =
            set_chat_history_share_enabled_sync(&conn, "conv-1", true, None).expect("enable share");
        let token = status.token.expect("share token");

        let record = resolve_chat_history_share_sync(&conn, &token).expect("resolve share");

        assert_eq!(record.id, "conv-1");
        assert!(record.segments.is_empty());
    }

    #[test]
    fn truncate_segment_input_recomputes_message_window() {
        let segment = ChatHistorySegmentRecord {
            segment_index: 2,
            segment_id: "segment-2".to_string(),
            summary_json: None,
            messages_json: r#"[
              {"role":"user","content":"hello","timestamp":1700000000001},
              {"role":"assistant","content":"world","responseId":"resp-2","timestamp":1700000000002}
            ]"#
            .to_string(),
            message_count: 2,
            start_message_id: Some("old-start".to_string()),
            end_message_id: Some("old-end".to_string()),
            created_at: 1700000000000,
            updated_at: 1700000000002,
        };

        let truncated = truncate_segment_input(&segment, 1).expect("truncate segment");

        assert_eq!(truncated.message_count, 1);
        assert_eq!(
            truncated.start_message_id.as_deref(),
            Some("segment-2-message-0-1700000000001")
        );
        assert_eq!(
            truncated.end_message_id.as_deref(),
            Some("segment-2-message-0-1700000000001")
        );
        assert_eq!(truncated.updated_at, 1700000000001);
    }

    #[test]
    fn subagent_prune_uses_initialized_history_schema() {
        let conn = open_test_db().expect("open test db");
        let before: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subagentRun'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("query schema before prune");
        assert_eq!(before.as_deref(), Some("subagentRun"));

        let result =
            subagent_history::prune_subagent_runs_for_parent_tool_calls(&conn, "conv-1", &[])
                .expect("prune uses initialized subagent schema");

        assert_eq!(result.deleted_run_count, 0);
        let after: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subagentRun'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("query schema after prune");
        assert_eq!(after.as_deref(), Some("subagentRun"));
    }

    #[test]
    fn parent_truncate_transaction_prunes_removed_subagent_runs() {
        let mut conn = open_test_db().expect("open test db");
        let mut conversation = sample_conversation();
        let original_segment = ChatHistorySegmentInput {
            segment_index: 0,
            segment_id: "segment-0".to_string(),
            summary_json: None,
            messages_json: r#"[
              {"id":"m-user","role":"user","content":"start","timestamp":1700000000001},
              {"id":"m-keep","role":"toolResult","toolName":"Agent","toolCallId":"call-keep","content":"keep","timestamp":1700000000002},
              {"id":"m-stale","role":"toolResult","toolName":"Agent","toolCallId":"call-stale","content":"stale","timestamp":1700000000003}
            ]"#
            .to_string(),
            message_count: 3,
            start_message_id: Some("m-user".to_string()),
            end_message_id: Some("m-stale".to_string()),
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_003,
        };
        conversation.total_message_count = 3;
        conversation.updated_at = original_segment.updated_at;
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        let pinned = set_chat_history_pinned_sync(&conn, "conv-1", true).expect("pin parent");
        let pinned_at = pinned.pinned_at.expect("pinned_at set");
        sync_segments(&conn, &conversation.id, &[original_segment], 1).expect("sync segment");

        subagent_history::prune_subagent_runs_for_parent_tool_calls(&conn, "conv-1", &[])
            .expect("initialize subagent schema");
        insert_subagent_run_for_test(&conn, "run-keep", "call-keep", 0);
        insert_subagent_run_for_test(&conn, "run-stale", "call-stale", 1);
        conn.execute(
            "
            INSERT INTO subagentRunSegment (
                run_id,
                segment_index,
                segment_id,
                messages_json,
                message_count,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ",
            params![
                "run-stale",
                0,
                "segment-stale",
                "[]",
                0,
                1_700_000_000_100_i64,
                1_700_000_000_200_i64,
            ],
        )
        .expect("insert stale segment");
        conn.execute(
            "
            INSERT INTO subagentRunEvent (
                run_id,
                event_type,
                is_error,
                created_at
            ) VALUES (?1, ?2, ?3, ?4)
            ",
            params!["run-stale", "turn_start", 0, 1_700_000_000_200_i64],
        )
        .expect("insert stale event");

        let records = load_segments(&conn, "conv-1").expect("load parent segments");
        let truncated_segment = truncate_segment_input(&records[0], 2).expect("truncate segment");
        let next_segments = vec![truncated_segment];
        let keep_parent_tool_call_ids =
            retained_subagent_parent_tool_call_ids(&next_segments).expect("collect keep ids");
        assert_eq!(keep_parent_tool_call_ids, vec!["call-keep".to_string()]);

        let mut truncated_conversation = conversation.clone();
        truncated_conversation.total_message_count = 2;
        truncated_conversation.context_meta_json = update_context_meta_json_counts(
            &conversation.context_meta_json,
            0,
            1,
            truncated_conversation.total_message_count,
        )
        .expect("update meta");
        truncated_conversation.updated_at = next_segments[0].updated_at;

        let tx = conn.transaction().expect("open truncate transaction");
        upsert_chat_history_header(&tx, &truncated_conversation).expect("upsert truncated header");
        sync_segments(&tx, "conv-1", &next_segments, 1).expect("sync truncated segment");
        let prune_result = subagent_history::prune_subagent_runs_for_parent_tool_calls(
            &tx,
            "conv-1",
            &keep_parent_tool_call_ids,
        )
        .expect("prune subagent runs");
        verify_chat_history_consistency(&tx, "conv-1").expect("verify parent history");
        tx.commit().expect("commit truncate transaction");

        assert_eq!(prune_result.deleted_run_count, 1);
        let kept_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentRun WHERE id = ?1",
                params!["run-keep"],
                |row| row.get(0),
            )
            .expect("count kept run");
        let stale_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentRun WHERE id = ?1",
                params!["run-stale"],
                |row| row.get(0),
            )
            .expect("count stale run");
        let stale_segment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentRunSegment WHERE run_id = ?1",
                params!["run-stale"],
                |row| row.get(0),
            )
            .expect("count stale segments");
        let stale_event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentRunEvent WHERE run_id = ?1",
                params!["run-stale"],
                |row| row.get(0),
            )
            .expect("count stale events");
        let truncated_record = get_record_by_id(&conn, "conv-1").expect("load truncated parent");

        assert_eq!(kept_count, 1);
        assert_eq!(stale_count, 0);
        assert_eq!(stale_segment_count, 0);
        assert_eq!(stale_event_count, 0);
        assert_eq!(truncated_record.total_message_count, 2);
        assert!(truncated_record.is_pinned);
        assert_eq!(truncated_record.pinned_at, Some(pinned_at));
    }
}
