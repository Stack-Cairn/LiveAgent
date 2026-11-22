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

fn pi_sessions_root(home: &Path) -> PathBuf {
    std::env::var_os("PI_CODING_AGENT_SESSION_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| pi_agent_root(home).join("sessions"))
}

/// More session files than this and the signature gives up (`None`): the frontend then runs
/// the full pass, as it did before signatures existed.
const PI_MAX_SIGNATURE_FILES: usize = 100_000;

fn hash_pi_files(root: &Path, hasher: &mut sha2::Sha256, count: &mut usize) -> bool {
    let Ok(entries) = fs::read_dir(root) else {
        return true;
    };
    let mut entries: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
    entries.sort();
    for path in entries {
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if !hash_pi_files(&path, hasher, count) {
                return false;
            }
            continue;
        }
        if !metadata.is_file() || !valid_pi_file(&path) {
            continue;
        }
        *count += 1;
        if *count > PI_MAX_SIGNATURE_FILES {
            return false;
        }
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let path = path.to_string_lossy();
        hasher.update((path.len() as u64).to_le_bytes());
        hasher.update(path.as_bytes());
        hasher.update(metadata.len().to_le_bytes());
        hasher.update(modified.to_le_bytes());
    }
    true
}

/// Fingerprint of the Pi session files from directory metadata only (path, size, mtime of
/// every `.jsonl` file; no file is opened). Any added, removed, rewritten or appended session
/// changes it, so an unchanged directory lets startup skip the full rescan.
fn pi_history_signature_for_root(root: &Path) -> Option<String> {
    let mut hasher = sha2::Sha256::new();
    hasher.update(b"pi-sessions-v1\0");
    let root_text = root.to_string_lossy();
    hasher.update((root_text.len() as u64).to_le_bytes());
    hasher.update(root_text.as_bytes());
    let mut count = 0;
    if !hash_pi_files(root, &mut hasher, &mut count) {
        return None;
    }
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Some(format!("pi:{count}:{hex}"))
}

#[tauri::command]
pub async fn pi_history_migration_signature() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::runtime::data_home::home_dir()
            .ok_or_else(|| "cannot locate user home".to_string())?;
        Ok(pi_history_signature_for_root(&pi_sessions_root(&home)))
    })
    .await
    .map_err(|e| format!("pi history signature join failed: {e}"))?
}

fn pi_candidates_for_root(root: &Path) -> Vec<PiCandidate> {
    let mut out = Vec::new();
    let mut budget = PI_MAX_FILES_PER_PAGE_SCAN;
    collect_pi_files(root, &mut out, &mut budget);
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

/// Scans and parses session files, so it runs off the main thread: a synchronous command
/// would freeze the window (and the startup screen with it) while a large directory is read.
#[tauri::command]
pub async fn pi_history_migration_page(cursor: Option<String>) -> Result<PiMigrationPage, String> {
    tauri::async_runtime::spawn_blocking(move || pi_history_migration_page_sync(cursor))
        .await
        .map_err(|e| format!("pi history migration join failed: {e}"))?
}

fn pi_history_migration_page_sync(cursor: Option<String>) -> Result<PiMigrationPage, String> {
    let home = crate::runtime::data_home::home_dir()
        .ok_or_else(|| "cannot locate user home".to_string())?;
    Ok(pi_history_page_for_root(&pi_sessions_root(&home), cursor))
}

/// The candidate list of the pass in progress. A pass reads its pages in a row, and scanning
/// (one open and header parse per file) on every page made a full pass quadratic in the
/// number of sessions; the first page of a pass scans, its continuations reuse that scan.
static PASS_CANDIDATES: std::sync::Mutex<Option<(PathBuf, std::sync::Arc<Vec<PiCandidate>>)>> =
    std::sync::Mutex::new(None);

fn candidates_for_page(root: &Path, continuing: bool) -> std::sync::Arc<Vec<PiCandidate>> {
    let mut cached = PASS_CANDIDATES
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if continuing {
        if let Some((cached_root, candidates)) = cached.as_ref() {
            if cached_root == root {
                return std::sync::Arc::clone(candidates);
            }
        }
    }
    let candidates = std::sync::Arc::new(pi_candidates_for_root(root));
    *cached = Some((root.to_path_buf(), std::sync::Arc::clone(&candidates)));
    candidates
}

fn cursor_position(candidates: &[PiCandidate], after: &str) -> Option<usize> {
    candidates
        .iter()
        .position(|candidate| safe_id(&candidate.path.to_string_lossy()) == after)
        .map(|index| index + 1)
}

fn pi_history_page_for_root(root: &Path, cursor: Option<String>) -> PiMigrationPage {
    let after = cursor.unwrap_or_default();
    let mut candidates = candidates_for_page(root, !after.is_empty());
    let start = if after.is_empty() {
        0
    } else {
        match cursor_position(&candidates, &after) {
            Some(start) => start,
            None => {
                // Not in this pass's scan (another pass started since): scan again, as every
                // page did before the scan was shared.
                candidates = candidates_for_page(root, false);
                cursor_position(&candidates, &after).unwrap_or(candidates.len())
            }
        }
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
    PiMigrationPage {
        conversations,
        next_cursor: has_more.then_some(next_cursor.unwrap_or_default()),
        complete: !has_more,
        source: "pi-jsonl".to_string(),
    }
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

    fn write_session(dir: &Path, name: &str, id: &str, messages: usize) -> PathBuf {
        let path = dir.join(name);
        let mut lines = vec![
            serde_json::json!({"type":"session","version":3,"id":id,"timestamp":"2026-01-01T00:00:00Z","cwd":"/workspace"}),
        ];
        let mut parent = Value::Null;
        for index in 0..messages {
            let entry_id = format!("{id}-m{index}");
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            lines.push(serde_json::json!({"type":"message","id":entry_id,"parentId":parent,"timestamp":"2026-01-01T00:00:01Z","message":{"role":role,"content":format!("synthetic message {index} of {id}")}}));
            parent = Value::String(entry_id);
        }
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
        path
    }

    #[test]
    fn signature_is_stable_and_follows_every_session_file_change() {
        let root = tempdir().unwrap();
        let sessions = root.path().join("sessions");
        let missing = pi_history_signature_for_root(&sessions).expect("missing dir signature");
        assert!(missing.starts_with("pi:0:"), "{missing}");

        let project = sessions.join("--workspace--");
        std::fs::create_dir_all(&project).unwrap();
        let first = write_session(&project, "a.jsonl", "a", 2);
        write_session(&project, "b.jsonl", "b", 2);
        std::fs::write(project.join("notes.txt"), "not a session").unwrap();
        let base = pi_history_signature_for_root(&sessions).unwrap();
        assert!(base.starts_with("pi:2:"), "{base}");
        assert_eq!(pi_history_signature_for_root(&sessions).unwrap(), base);

        // Non-session files do not count.
        std::fs::write(project.join("notes.txt"), "still not a session").unwrap();
        assert_eq!(pi_history_signature_for_root(&sessions).unwrap(), base);

        // Appending to a session changes its size.
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&first)
            .unwrap();
        std::io::Write::write_all(&mut file, b"{\"type\":\"message\"}\n").unwrap();
        drop(file);
        let appended = pi_history_signature_for_root(&sessions).unwrap();
        assert_ne!(appended, base);

        // A rewrite with the same size changes its mtime.
        let earlier = SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&first)
            .unwrap()
            .set_modified(earlier)
            .unwrap();
        let touched = pi_history_signature_for_root(&sessions).unwrap();
        assert_ne!(touched, appended);

        // Added and removed sessions, including in a new subdirectory.
        let other = sessions.join("--other--");
        std::fs::create_dir_all(&other).unwrap();
        let added = write_session(&other, "c.jsonl", "c", 1);
        let with_new = pi_history_signature_for_root(&sessions).unwrap();
        assert!(with_new.starts_with("pi:3:"), "{with_new}");
        std::fs::remove_file(added).unwrap();
        assert_eq!(pi_history_signature_for_root(&sessions).unwrap(), touched);
    }

    #[test]
    fn a_pass_reads_every_session_once_with_one_scan_and_recovers_from_a_foreign_cursor() {
        let root = tempdir().unwrap();
        let sessions = root.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        for index in 0..(PI_PAGE_SIZE * 2 + 5) {
            write_session(
                &sessions,
                &format!("s{index:03}.jsonl"),
                &format!("s{index:03}"),
                2,
            );
        }
        let mut seen = Vec::new();
        let mut cursor = None;
        let mut pages = 0;
        loop {
            let page = pi_history_page_for_root(&sessions, cursor.clone());
            pages += 1;
            seen.extend(
                page.conversations
                    .iter()
                    .map(|record| record.session_id.clone()),
            );
            if page.complete {
                break;
            }
            cursor = page.next_cursor;
            // Files written during the pass are not part of its scan; the next pass sees them.
            if pages == 1 {
                write_session(&sessions, "late.jsonl", "late", 1);
            }
        }
        assert_eq!(pages, 3);
        let mut unique = seen.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), seen.len(), "no session is read twice");
        assert_eq!(seen.len(), PI_PAGE_SIZE * 2 + 5);
        assert!(!seen.contains(&"late".to_string()));

        // A new pass scans again and includes the late file.
        let first = pi_history_page_for_root(&sessions, None);
        assert!(!first.complete);
        // A cursor this scan does not know (e.g. from another root's pass) rescans
        // instead of ending the pass early.
        let other = root.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        write_session(&other, "x.jsonl", "x", 1);
        let _ = pi_history_page_for_root(&other, None);
        let resumed = pi_history_page_for_root(&sessions, first.next_cursor.clone());
        assert_eq!(resumed.conversations.len(), PI_PAGE_SIZE);
    }

    /// `cargo test --lib pi_migration::tests::bench_ -- --ignored --nocapture`
    #[test]
    #[ignore = "benchmark: prints Pi startup rescan timings for 2000 synthetic sessions"]
    fn bench_pi_startup_rescan_2000_sessions() {
        let root = tempdir().unwrap();
        let sessions = root.path().join("sessions");
        for project in 0..20 {
            let dir = sessions.join(format!("--project-{project}--"));
            std::fs::create_dir_all(&dir).unwrap();
            for index in 0..100 {
                write_session(
                    &dir,
                    &format!("{index:04}.jsonl"),
                    &format!("p{project}-s{index}"),
                    20,
                );
            }
        }
        let pass = |shared_scan: bool| {
            let started = std::time::Instant::now();
            let mut cursor: Option<String> = None;
            let mut records = 0;
            loop {
                let page = if shared_scan {
                    pi_history_page_for_root(&sessions, cursor.clone())
                } else {
                    // What every page did before: a fresh scan of all files.
                    *PASS_CANDIDATES.lock().unwrap() = None;
                    pi_history_page_for_root(&sessions, cursor.clone())
                };
                records += page.conversations.len();
                if page.complete {
                    break;
                }
                cursor = page.next_cursor;
            }
            assert_eq!(records, 2000);
            started.elapsed()
        };
        for round in 0..3 {
            let rescanning = pass(false);
            let shared = pass(true);
            let started = std::time::Instant::now();
            let signature = pi_history_signature_for_root(&sessions).unwrap();
            let signature_time = started.elapsed();
            assert!(signature.starts_with("pi:2000:"));
            println!(
                "round {round}: full pass, scan per page {:?}; full pass, one scan {:?}; unchanged launch (signature only) {:?}",
                rescanning, shared, signature_time
            );
        }
    }
}
