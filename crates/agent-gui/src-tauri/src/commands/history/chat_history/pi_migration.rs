use serde_json::Value;
use sha2::Digest;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const PI_PAGE_SIZE: usize = 20;
const PI_MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const PI_MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const PI_MAX_FILES_PER_PAGE_SCAN: usize = 5000;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiMigrationMessage {
    id: Option<String>,
    role: String,
    content: Value,
    #[serde(rename = "toolCalls")]
    tool_calls: Vec<Value>,
    tool_call_id: Option<String>,
    tool_name: Option<String>,
    is_error: Option<bool>,
    api: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    response_id: Option<String>,
    stop_reason: Option<String>,
    raw_stop_reason: Option<String>,
    usage: Option<Value>,
    timestamp: Option<i64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiMigrationRecord {
    pub id: String,
    pub title: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: String,
    pub cwd: Option<String>,
    pub selected_model_json: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_pinned: bool,
    pub is_shared: bool,
    pub share_token: Option<String>,
    pub redact_tool_content: bool,
    pub context_meta_json: String,
    pub active_segment_index: i64,
    pub total_segment_count: i64,
    pub total_message_count: i64,
    pub segments: Vec<PiMigrationSegment>,
    pub checkpoint: PiMigrationCheckpoint,
    pub source_path: String,
    pub source_version: Option<i64>,
    pub source_entries: usize,
    pub source_unknown_entries: usize,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiMigrationSegment {
    pub segment_index: i64,
    pub segment_id: String,
    pub messages_json: String,
    pub summary_json: Option<String>,
    pub message_count: i64,
    pub start_message_id: Option<String>,
    pub end_message_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub active: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiMigrationCheckpoint {
    pub status: String,
    pub native_path: String,
    pub reason: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiMigrationPage {
    pub conversations: Vec<PiMigrationRecord>,
    pub next_cursor: Option<String>,
    pub complete: bool,
    pub source: String,
}

#[derive(Debug)]
struct PiCandidate {
    path: PathBuf,
    id: String,
    modified_at: i64,
}

fn unix_millis(value: SystemTime) -> i64 {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn pi_agent_root(home: &Path) -> PathBuf {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".pi").join("agent"))
}

fn valid_pi_file(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()) == Some("jsonl")
}

fn collect_pi_files(root: &Path, out: &mut Vec<PiCandidate>, budget: &mut usize) {
    if *budget == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_pi_files(&path, out, budget);
            continue;
        }
        if !metadata.is_file() || !valid_pi_file(&path) || metadata.len() > PI_MAX_FILE_BYTES {
            continue;
        }
        *budget -= 1;
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        let mut reader = BufReader::new(file);
        let mut line = String::new();
        let Ok(read) = reader.read_line(&mut line) else {
            continue;
        };
        if read == 0 || read > PI_MAX_LINE_BYTES {
            continue;
        }
        let Ok(header) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if header.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        let Some(id) = header.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        out.push(PiCandidate {
            path,
            id: id.to_string(),
            modified_at: unix_millis(modified),
        });
    }
}

fn pi_candidates(home: &Path) -> Vec<PiCandidate> {
    let root = std::env::var_os("PI_CODING_AGENT_SESSION_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| pi_agent_root(home).join("sessions"));
    let mut out = Vec::new();
    let mut budget = PI_MAX_FILES_PER_PAGE_SCAN;
    collect_pi_files(&root, &mut out, &mut budget);
    out.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| left.id.cmp(&right.id))
            .then_with(|| left.path.cmp(&right.path))
    });
    out
}

fn parts_from_content(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(parts)) => parts.clone(),
        Some(Value::String(text)) if !text.is_empty() => {
            vec![serde_json::json!({"type":"text", "text": text})]
        }
        _ => Vec::new(),
    }
}

fn timestamp_millis(message: &Value, entry_timestamp: Option<&str>, fallback: i64) -> i64 {
    if let Some(value) = message.get("timestamp").and_then(Value::as_i64) {
        return value;
    }
    if let Some(timestamp) = entry_timestamp {
        if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(timestamp) {
            return parsed.timestamp_millis();
        }
    }
    fallback
}

fn normalized_usage(value: Option<&Value>) -> Option<Value> {
    let object = value?.as_object()?;
    Some(serde_json::json!({
        "input": object.get("input").and_then(Value::as_i64).unwrap_or(0),
        "output": object.get("output").and_then(Value::as_i64).unwrap_or(0),
        "cacheRead": object.get("cacheRead").and_then(Value::as_i64).unwrap_or(0),
        "cacheWrite": object.get("cacheWrite").and_then(Value::as_i64).unwrap_or(0),
    }))
}

fn normalize_message(entry: &Value, fallback_timestamp: i64) -> Option<PiMigrationMessage> {
    let raw = entry.get("message")?.as_object()?;
    let role = raw.get("role")?.as_str()?;
    let entry_timestamp = entry.get("timestamp").and_then(Value::as_str);
    let timestamp = timestamp_millis(
        &Value::Object(raw.clone()),
        entry_timestamp,
        fallback_timestamp,
    );
    let id = entry
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| raw.get("id").and_then(Value::as_str))
        .map(str::to_string);
    let role = match role {
        "system" => return None,
        "user" => "user",
        "assistant" => "assistant",
        "toolResult" => "toolResult",
        "custom" => "user",
        _ => return None,
    };
    let mut tool_calls = Vec::new();
    let mut content_blocks = parts_from_content(raw.get("content"));
    if role == "assistant" {
        tool_calls = raw
            .get("content")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item.get("type").and_then(Value::as_str) == Some("toolCall"))
                    .map(|item| {
                        serde_json::json!({
                            "id": item.get("id"),
                            "name": item.get("name"),
                            "arguments": item.get("arguments").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        content_blocks.retain(|item| item.get("type").and_then(Value::as_str) != Some("toolCall"));
    }
    let tool_call_id = raw
        .get("toolCallId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let tool_name = raw
        .get("toolName")
        .and_then(Value::as_str)
        .map(str::to_string);
    let content = Value::Array(content_blocks);
    Some(PiMigrationMessage {
        id,
        role: role.to_string(),
        content,
        tool_calls,
        tool_call_id,
        tool_name,
        is_error: raw.get("isError").and_then(Value::as_bool),
        api: raw.get("api").and_then(Value::as_str).map(str::to_string),
        provider: raw
            .get("provider")
            .and_then(Value::as_str)
            .map(str::to_string),
        model: raw.get("model").and_then(Value::as_str).map(str::to_string),
        response_id: raw
            .get("responseId")
            .and_then(Value::as_str)
            .map(str::to_string),
        stop_reason: raw
            .get("stopReason")
            .and_then(Value::as_str)
            .map(str::to_string),
        raw_stop_reason: raw
            .get("rawStopReason")
            .and_then(Value::as_str)
            .map(str::to_string),
        usage: normalized_usage(raw.get("usage")),
        timestamp: Some(timestamp),
    })
}

fn entry_id(value: &Value) -> Option<&str> {
    value.get("id").and_then(Value::as_str)
}

fn active_entry_ids(entries: &[Value]) -> HashSet<String> {
    let mut by_id = HashMap::new();
    let mut leaf = None;
    for entry in entries {
        if entry.get("type").and_then(Value::as_str) == Some("session") {
            continue;
        }
        if let Some(id) = entry_id(entry) {
            by_id.insert(id, entry);
            leaf = Some(id);
        }
    }
    let mut active = HashSet::new();
    let mut current = leaf;
    while let Some(id) = current {
        if !active.insert(id.to_string()) {
            break;
        }
        current = by_id
            .get(id)
            .and_then(|entry| entry.get("parentId"))
            .and_then(Value::as_str);
    }
    active
}

fn safe_id(source: &str) -> String {
    let digest = sha2::Sha256::digest(source.as_bytes());
    let hex = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("pi-{hex}")
}

fn read_pi_record(candidate: &PiCandidate) -> Option<PiMigrationRecord> {
    let file = fs::File::open(&candidate.path).ok()?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();
    let mut invalid_lines = 0usize;
    let mut bytes = 0u64;
    for line in reader.lines() {
        let line = line.ok()?;
        bytes = bytes.saturating_add(line.len() as u64 + 1);
        if bytes > PI_MAX_FILE_BYTES || line.len() > PI_MAX_LINE_BYTES {
            return None;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(value) => entries.push(value),
            Err(_) => invalid_lines += 1,
        }
    }
    let header = entries
        .iter()
        .find(|entry| entry.get("type").and_then(Value::as_str) == Some("session"))?;
    let source_id = safe_id(&candidate.path.to_string_lossy());
    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string);
    let source_version = header.get("version").and_then(Value::as_i64);
    let active_ids = active_entry_ids(&entries);
    let mut messages = Vec::new();
    let mut summary = None;
    let mut summary_cutoff = 0usize;
    let mut provider = String::new();
    let mut model = String::new();
    let mut created_at = header
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
        .unwrap_or(candidate.modified_at);
    let mut updated_at = created_at;
    let mut active_segment_messages = Vec::new();
    for entry in entries.iter().filter(|entry| {
        entry.get("type").and_then(Value::as_str) != Some("session")
            && entry_id(entry)
                .map(|id| active_ids.contains(id))
                .unwrap_or(false)
    }) {
        let timestamp = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.timestamp_millis())
            .unwrap_or(updated_at);
        updated_at = updated_at.max(timestamp);
        match entry.get("type").and_then(Value::as_str) {
            Some("model_change") => {
                provider = entry
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                model = entry
                    .get("modelId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
            Some("compaction") => {
                if let Some(text) = entry.get("summary").and_then(Value::as_str) {
                    summary = Some(text.to_string());
                    summary_cutoff = active_segment_messages.len();
                }
            }
            Some("message") => {
                if let Some(message) = normalize_message(entry, updated_at) {
                    if provider.is_empty() {
                        provider = message.provider.clone().unwrap_or_default();
                    }
                    if model.is_empty() {
                        model = message.model.clone().unwrap_or_default();
                    }
                    if message.timestamp.unwrap_or(0) > 0 && created_at == 0 {
                        created_at = message.timestamp.unwrap_or(created_at);
                    }
                    active_segment_messages.push(message);
                }
            }
            Some("custom_message") => {
                let custom = serde_json::json!({
                    "type": "message",
                    "id": entry.get("id"),
                    "timestamp": entry.get("timestamp"),
                    "message": {"role":"custom", "content": entry.get("content")}
                });
                if let Some(message) = normalize_message(&custom, updated_at) {
                    active_segment_messages.push(message);
                }
            }
            _ => {}
        }
    }
    if provider.is_empty() {
        provider = "pi".to_string();
    }
    if model.is_empty() {
        model = "unknown".to_string();
    }
    messages.extend(active_segment_messages.iter().cloned());
    let message_ids = messages
        .iter()
        .filter_map(|message| message.id.clone())
        .collect::<Vec<_>>();
    let first_message_id = message_ids.first().cloned();
    let last_message_id = message_ids.last().cloned();
    let messages_json = serde_json::to_string(&messages).ok()?;
    let summary_json = summary.as_ref().map(|value| {
        serde_json::json!({"role":"summary","id":format!("pi-summary-{source_id}"),"content":value}).to_string()
    });
    let title = header
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            messages
                .iter()
                .find(|message| message.role == "user")
                .and_then(|message| message.content.as_array())
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect::<String>()
                        .chars()
                        .take(64)
                        .collect()
                })
        })
        .unwrap_or_else(|| format!("Pi session {}", &candidate.id[..candidate.id.len().min(8)]));
    let segment_id = format!("pi-segment-{source_id}");
    let total = messages.len() as i64;
    let active_context = if summary.is_some() { summary_cutoff } else { 0 };
    let context_meta = serde_json::json!({
        "schemaVersion": 3,
        "source": "pi-jsonl",
        "piVersion": source_version,
        "activeSegmentIndex": 0,
        "totalSegmentCount": 1,
        "totalMessageCount": total,
        "activeContextCutoff": active_context,
    });
    let (status, reason) = if invalid_lines > 0 {
        (
            "partial",
            format!("{invalid_lines} malformed JSONL line(s) were skipped"),
        )
    } else {
        (
            "not_found",
            "Pi JSONL session does not contain native LiveAgent checkpoint artifacts".to_string(),
        )
    };
    Some(PiMigrationRecord {
        id: source_id,
        title,
        provider_id: provider.clone(),
        model: model.clone(),
        session_id: candidate.id.clone(),
        cwd,
        selected_model_json: Some(
            serde_json::json!({"customProviderId":provider,"model":model}).to_string(),
        ),
        created_at,
        updated_at,
        is_pinned: false,
        is_shared: false,
        share_token: None,
        redact_tool_content: false,
        context_meta_json: context_meta.to_string(),
        active_segment_index: 0,
        total_segment_count: 1,
        total_message_count: total,
        segments: vec![PiMigrationSegment {
            segment_index: 0,
            segment_id,
            messages_json,
            summary_json,
            message_count: total,
            start_message_id: first_message_id,
            end_message_id: last_message_id,
            created_at,
            updated_at,
            active: true,
        }],
        checkpoint: PiMigrationCheckpoint {
            status: status.to_string(),
            native_path: candidate.path.to_string_lossy().to_string(),
            reason,
        },
        source_path: candidate.path.to_string_lossy().to_string(),
        source_version,
        source_entries: entries.len(),
        source_unknown_entries: entries
            .iter()
            .filter(|entry| {
                !matches!(
                    entry.get("type").and_then(Value::as_str),
                    Some("session")
                        | Some("message")
                        | Some("model_change")
                        | Some("compaction")
                        | Some("custom_message")
                )
            })
            .count(),
    })
}

#[tauri::command]
pub fn pi_history_migration_page(cursor: Option<String>) -> Result<PiMigrationPage, String> {
    let home = crate::runtime::data_home::home_dir().ok_or_else(|| "cannot locate user home".to_string())?;
    let candidates = pi_candidates(&home);
    let after = cursor.unwrap_or_default();
    let start = if after.is_empty() {
        0
    } else {
        candidates
            .iter()
            .position(|candidate| safe_id(&candidate.path.to_string_lossy()) == after)
            .map(|index| index + 1)
            .unwrap_or(candidates.len())
    };
    let selected = candidates.iter().skip(start).take(PI_PAGE_SIZE);
    let mut conversations = Vec::new();
    for candidate in selected {
        if let Some(record) = read_pi_record(candidate) {
            conversations.push(record);
        }
    }
    let has_more = start.saturating_add(PI_PAGE_SIZE) < candidates.len();
    let next_cursor = conversations.last().map(|record| record.id.clone());
    Ok(PiMigrationPage {
        conversations,
        next_cursor: has_more.then_some(next_cursor.unwrap_or_default()),
        complete: !has_more,
        source: "pi-jsonl".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn converts_pi_tree_messages_and_preserves_tool_calls() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let lines = [
            serde_json::json!({"type":"session","version":3,"id":"pi-session","timestamp":"2026-01-01T00:00:00Z","cwd":"/workspace"}),
            serde_json::json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"hello","timestamp":1767225601000i64}}),
            serde_json::json!({"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","provider":"openai","model":"gpt","content":[{"type":"text","text":"hi"},{"type":"toolCall","id":"call-1","name":"bash","arguments":{"command":"pwd"}}],"stopReason":"toolUse"}}),
            serde_json::json!({"type":"message","id":"t1","parentId":"a1","timestamp":"2026-01-01T00:00:03Z","message":{"role":"toolResult","toolCallId":"call-1","toolName":"bash","content":[{"type":"text","text":"/workspace"}],"isError":false}}),
        ];
        std::fs::write(
            &path,
            lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let candidate = PiCandidate {
            path,
            id: "pi-session".to_string(),
            modified_at: 1767225603000,
        };
        let record = read_pi_record(&candidate).unwrap();
        assert_eq!(record.provider_id, "openai");
        assert_eq!(record.model, "gpt");
        let messages: Vec<Value> = serde_json::from_str(&record.segments[0].messages_json).unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["toolCalls"][0]["id"], "call-1");
        assert_eq!(messages[2]["role"], "toolResult");
    }

    #[test]
    fn follows_leaf_parent_chain_and_ignores_inactive_branch() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let lines = [
            serde_json::json!({"type":"session","version":2,"id":"pi-session","timestamp":"2026-01-01T00:00:00Z","cwd":"/workspace"}),
            serde_json::json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"root"}}),
            serde_json::json!({"type":"message","id":"inactive","parentId":"u1","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":"inactive"}}),
            serde_json::json!({"type":"message","id":"active","parentId":"u1","timestamp":"2026-01-01T00:00:03Z","message":{"role":"user","content":"active"}}),
        ];
        std::fs::write(
            &path,
            lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let candidate = PiCandidate {
            path,
            id: "pi-session".to_string(),
            modified_at: 1767225603000,
        };
        let record = read_pi_record(&candidate).unwrap();
        let messages: Vec<Value> = serde_json::from_str(&record.segments[0].messages_json).unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|value| value["content"][0]["text"].as_str().unwrap_or(""))
                .collect::<Vec<_>>(),
            vec!["root", "active"]
        );
    }
}
