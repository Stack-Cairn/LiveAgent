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
    /// Size and mtime of every file this page looked at, taken before it was read, so the
    /// frontend can remember which file state a conversation came from.
    pub files: Vec<PiSourceFile>,
}

/// One session file as directory metadata sees it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSourceFile {
    pub source_id: String,
    pub size: u64,
    pub mtime_ms: i64,
    /// Page results only: "read" (a conversation was exported), "skipped" (not a session or
    /// unreadable), "changed" (written while it was read; not exported) or "missing".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<&'static str>,
}

/// Every session file with its size and mtime (no file is opened), plus the directory
/// signature computed from the same listing.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiMigrationManifest {
    pub signature: String,
    pub files: Vec<PiSourceFile>,
}

#[derive(Debug)]
struct PiCandidate {
    path: PathBuf,
    id: String,
    modified_at: i64,
    size: u64,
}

/// A `.jsonl` file under the sessions root, from directory metadata only.
#[derive(Debug)]
struct PiFileStat {
    path: PathBuf,
    size: u64,
    modified_nanos: u128,
}

impl PiFileStat {
    fn source_file(&self, status: Option<&'static str>) -> PiSourceFile {
        PiSourceFile {
            source_id: safe_id(&self.path.to_string_lossy()),
            size: self.size,
            mtime_ms: (self.modified_nanos / 1_000_000).min(i64::MAX as u128) as i64,
            status,
        }
    }
}

fn modified_nanos(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0)
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
        if let Some(candidate) = pi_candidate(path, &metadata) {
            out.push(candidate);
        }
    }
}

/// A session file's candidate entry: opens it and parses the header line only.
fn pi_candidate(path: PathBuf, metadata: &fs::Metadata) -> Option<PiCandidate> {
    if !metadata.is_file() || !valid_pi_file(&path) || metadata.len() > PI_MAX_FILE_BYTES {
        return None;
    }
    let file = fs::File::open(&path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let read = reader.read_line(&mut line).ok()?;
    if read == 0 || read > PI_MAX_LINE_BYTES {
        return None;
    }
    let header = serde_json::from_str::<Value>(line.trim()).ok()?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    let id = header.get("id").and_then(Value::as_str)?;
    let modified = metadata.modified().ok()?;
    Some(PiCandidate {
        path,
        id: id.to_string(),
        modified_at: unix_millis(modified),
        size: metadata.len(),
    })
}

fn pi_sessions_root(home: &Path) -> PathBuf {
    std::env::var_os("PI_CODING_AGENT_SESSION_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| pi_agent_root(home).join("sessions"))
}

/// More session files than this and the signature gives up (`None`): the frontend then runs
/// the full pass, as it did before signatures existed.
const PI_MAX_SIGNATURE_FILES: usize = 100_000;

/// Lists every `.jsonl` file under `root` (sorted per directory, symlinks skipped) from
/// directory metadata only. False when there are more than `PI_MAX_SIGNATURE_FILES`.
fn list_pi_files(root: &Path, out: &mut Vec<PiFileStat>) -> bool {
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
            if !list_pi_files(&path, out) {
                return false;
            }
            continue;
        }
        if !metadata.is_file() || !valid_pi_file(&path) {
            continue;
        }
        if out.len() >= PI_MAX_SIGNATURE_FILES {
            return false;
        }
        out.push(PiFileStat {
            size: metadata.len(),
            modified_nanos: modified_nanos(&metadata),
            path,
        });
    }
    true
}

/// Fingerprint of the Pi session files from directory metadata only (path, size, mtime of
/// every `.jsonl` file; no file is opened). Any added, removed, rewritten or appended session
/// changes it, so an unchanged directory lets startup skip the full rescan. The value must
/// stay the same for the same files: an upgrade compares it with the stored completion.
fn pi_signature_for_files(root: &Path, files: &[PiFileStat]) -> String {
    let mut hasher = sha2::Sha256::new();
    hasher.update(b"pi-sessions-v1\0");
    let root_text = root.to_string_lossy();
    hasher.update((root_text.len() as u64).to_le_bytes());
    hasher.update(root_text.as_bytes());
    for file in files {
        let path = file.path.to_string_lossy();
        hasher.update((path.len() as u64).to_le_bytes());
        hasher.update(path.as_bytes());
        hasher.update(file.size.to_le_bytes());
        hasher.update(file.modified_nanos.to_le_bytes());
    }
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("pi:{}:{hex}", files.len())
}

fn pi_history_signature_for_root(root: &Path) -> Option<String> {
    let mut files = Vec::new();
    list_pi_files(root, &mut files).then(|| pi_signature_for_files(root, &files))
}

/// Source id to path for the files of the last manifest, so reading a few changed sessions
/// does not walk the directory again.
static MANIFEST_PATHS: std::sync::Mutex<Option<(PathBuf, HashMap<String, PathBuf>)>> =
    std::sync::Mutex::new(None);

fn remember_manifest_paths(root: &Path, files: &[PiFileStat]) {
    let paths = files
        .iter()
        .map(|file| (safe_id(&file.path.to_string_lossy()), file.path.clone()))
        .collect();
    *MANIFEST_PATHS
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some((root.to_path_buf(), paths));
}

fn pi_manifest_for_root(root: &Path) -> Option<PiMigrationManifest> {
    let mut files = Vec::new();
    if !list_pi_files(root, &mut files) {
        return None;
    }
    remember_manifest_paths(root, &files);
    Some(PiMigrationManifest {
        signature: pi_signature_for_files(root, &files),
        files: files.iter().map(|file| file.source_file(None)).collect(),
    })
}

/// Every session file's source id, size and mtime, read from directory metadata only. The
/// frontend compares it with what it already migrated and reads just the changed files.
#[tauri::command]
pub async fn pi_history_migration_manifest() -> Result<Option<PiMigrationManifest>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::runtime::data_home::home_dir()
            .ok_or_else(|| "cannot locate user home".to_string())?;
        Ok(pi_manifest_for_root(&pi_sessions_root(&home)))
    })
    .await
    .map_err(|e| format!("pi history manifest join failed: {e}"))?
}

/// At most this many sessions per read, like one page of the full pass.
const PI_MAX_READ_IDS: usize = PI_PAGE_SIZE;

fn paths_for_ids(root: &Path, ids: &[String]) -> HashMap<String, PathBuf> {
    let cached = MANIFEST_PATHS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .filter(|(cached_root, _)| cached_root == root)
        .map(|(_, paths)| paths.clone());
    if let Some(paths) = cached {
        if ids.iter().all(|id| paths.contains_key(id)) {
            return paths;
        }
    }
    // A file added since the manifest, or no manifest in this process: list again.
    let mut files = Vec::new();
    list_pi_files(root, &mut files);
    remember_manifest_paths(root, &files);
    files
        .into_iter()
        .map(|file| (safe_id(&file.path.to_string_lossy()), file.path))
        .collect()
}

fn file_stat(path: &Path) -> Option<(fs::Metadata, PiFileStat)> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    }
    let stat = PiFileStat {
        path: path.to_path_buf(),
        size: metadata.len(),
        modified_nanos: modified_nanos(&metadata),
    };
    Some((metadata, stat))
}

/// Reads only the listed sessions. Each file's size and mtime are taken before it is read
/// and compared after: a file another client wrote in between is reported as "changed" and
/// not exported, so a half-written session is never imported.
fn pi_history_read_for_root(root: &Path, ids: &[String]) -> PiMigrationPage {
    let ids = &ids[..ids.len().min(PI_MAX_READ_IDS)];
    let paths = paths_for_ids(root, ids);
    let mut conversations = Vec::new();
    let mut files = Vec::new();
    for id in ids {
        let Some((metadata, before)) = paths.get(id).and_then(|path| file_stat(path)) else {
            files.push(PiSourceFile {
                source_id: id.clone(),
                size: 0,
                mtime_ms: 0,
                status: Some("missing"),
            });
            continue;
        };
        let record = pi_candidate(before.path.clone(), &metadata)
            .and_then(|candidate| read_pi_record(&candidate));
        let Some(record) = record else {
            files.push(before.source_file(Some("skipped")));
            continue;
        };
        let unchanged = file_stat(&before.path).is_some_and(|(_, after)| {
            after.size == before.size && after.modified_nanos == before.modified_nanos
        });
        if !unchanged {
            files.push(before.source_file(Some("changed")));
            continue;
        }
        files.push(before.source_file(Some("read")));
        conversations.push(record);
    }
    PiMigrationPage {
        conversations,
        next_cursor: None,
        complete: true,
        source: "pi-jsonl".to_string(),
        files,
    }
}

/// Exports the given sessions (source ids from the manifest), off the main thread.
#[tauri::command]
pub async fn pi_history_migration_read(source_ids: Vec<String>) -> Result<PiMigrationPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::runtime::data_home::home_dir()
            .ok_or_else(|| "cannot locate user home".to_string())?;
        Ok(pi_history_read_for_root(
            &pi_sessions_root(&home),
            &source_ids,
        ))
    })
    .await
    .map_err(|e| format!("pi history read join failed: {e}"))?
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
    let mut files = Vec::new();
    for candidate in selected {
        let record = read_pi_record(candidate);
        files.push(PiSourceFile {
            source_id: safe_id(&candidate.path.to_string_lossy()),
            size: candidate.size,
            mtime_ms: candidate.modified_at,
            status: Some(if record.is_some() { "read" } else { "skipped" }),
        });
        if let Some(record) = record {
            conversations.push(record);
        }
    }
    let has_more = start.saturating_add(PI_PAGE_SIZE) < candidates.len();
    // The last file looked at, not the last exported one: a page that ends in files that are
    // not sessions must still advance.
    let next_cursor = files.last().map(|file| file.source_id.clone());
    PiMigrationPage {
        conversations,
        next_cursor: has_more.then_some(next_cursor.unwrap_or_default()),
        complete: !has_more,
        source: "pi-jsonl".to_string(),
        files,
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
            size: 0,
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
            size: 0,
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

    /// The signature before it shared the manifest's listing. An upgrade compares the stored
    /// completion with the new value, so the two must agree for the same files.
    fn previous_signature(root: &Path) -> String {
        fn walk(root: &Path, hasher: &mut sha2::Sha256, count: &mut usize) {
            let Ok(entries) = fs::read_dir(root) else {
                return;
            };
            let mut entries: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
            entries.sort();
            for path in entries {
                let metadata = fs::symlink_metadata(&path).unwrap();
                if metadata.is_dir() {
                    walk(&path, hasher, count);
                    continue;
                }
                if !metadata.is_file() || !valid_pi_file(&path) {
                    continue;
                }
                *count += 1;
                let modified = modified_nanos(&metadata);
                let path = path.to_string_lossy();
                hasher.update((path.len() as u64).to_le_bytes());
                hasher.update(path.as_bytes());
                hasher.update(metadata.len().to_le_bytes());
                hasher.update(modified.to_le_bytes());
            }
        }
        let mut hasher = sha2::Sha256::new();
        hasher.update(b"pi-sessions-v1\0");
        let root_text = root.to_string_lossy();
        hasher.update((root_text.len() as u64).to_le_bytes());
        hasher.update(root_text.as_bytes());
        let mut count = 0;
        walk(root, &mut hasher, &mut count);
        let hex: String = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        format!("pi:{count}:{hex}")
    }

    #[test]
    fn manifest_lists_every_session_file_with_the_unchanged_signature() {
        let root = tempdir().unwrap();
        let sessions = root.path().join("sessions");
        let project = sessions.join("--workspace--");
        std::fs::create_dir_all(&project).unwrap();
        let a = write_session(&project, "a.jsonl", "a", 2);
        write_session(&sessions, "b.jsonl", "b", 3);
        std::fs::write(project.join("notes.txt"), "not a session").unwrap();
        // Not a session, but still a .jsonl file: listed, so a later read can settle it.
        std::fs::write(project.join("junk.jsonl"), "not json\n").unwrap();

        let manifest = pi_manifest_for_root(&sessions).unwrap();
        assert_eq!(manifest.signature, previous_signature(&sessions));
        assert_eq!(
            Some(manifest.signature.clone()),
            pi_history_signature_for_root(&sessions)
        );
        assert_eq!(manifest.files.len(), 3);
        let entry = manifest
            .files
            .iter()
            .find(|file| file.source_id == safe_id(&a.to_string_lossy()))
            .expect("a.jsonl is listed");
        let metadata = std::fs::metadata(&a).unwrap();
        assert_eq!(entry.size, metadata.len());
        assert_eq!(entry.mtime_ms, unix_millis(metadata.modified().unwrap()));
        assert_eq!(entry.status, None);
        let json = serde_json::to_value(entry).unwrap();
        assert!(json.get("sourceId").is_some() && json.get("mtimeMs").is_some());
        assert!(json.get("status").is_none());
    }

    #[test]
    fn read_exports_only_the_requested_sessions_and_settles_the_rest() {
        let root = tempdir().unwrap();
        let sessions = root.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let wanted = write_session(&sessions, "wanted.jsonl", "wanted", 2);
        write_session(&sessions, "other.jsonl", "other", 2);
        let junk = sessions.join("junk.jsonl");
        std::fs::write(&junk, "not json\n").unwrap();
        let manifest = pi_manifest_for_root(&sessions).unwrap();
        assert_eq!(manifest.files.len(), 3);

        let wanted_id = safe_id(&wanted.to_string_lossy());
        let junk_id = safe_id(&junk.to_string_lossy());
        let page = pi_history_read_for_root(
            &sessions,
            &[wanted_id.clone(), junk_id.clone(), "pi-gone".to_string()],
        );
        assert!(page.complete);
        assert_eq!(page.next_cursor, None);
        assert_eq!(
            page.conversations.len(),
            1,
            "only the requested session is exported"
        );
        assert_eq!(page.conversations[0].id, wanted_id);
        assert_eq!(page.conversations[0].session_id, "wanted");
        let statuses: Vec<_> = page
            .files
            .iter()
            .map(|file| (file.source_id.as_str(), file.status.unwrap()))
            .collect();
        assert_eq!(
            statuses,
            vec![
                (wanted_id.as_str(), "read"),
                (junk_id.as_str(), "skipped"),
                ("pi-gone", "missing"),
            ]
        );
        let read = &page.files[0];
        assert_eq!(read.size, std::fs::metadata(&wanted).unwrap().len());

        // A session added after the manifest is found by listing again.
        let late = write_session(&sessions, "late.jsonl", "late", 1);
        let late_id = safe_id(&late.to_string_lossy());
        let page = pi_history_read_for_root(&sessions, std::slice::from_ref(&late_id));
        assert_eq!(page.conversations.len(), 1);
        assert_eq!(page.files[0].status, Some("read"));
    }

    #[test]
    fn a_full_pass_page_reports_the_files_it_read_and_advances_past_non_sessions() {
        let root = tempdir().unwrap();
        let sessions = root.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        for index in 0..(PI_PAGE_SIZE + 3) {
            write_session(
                &sessions,
                &format!("s{index:03}.jsonl"),
                &format!("s{index:03}"),
                1,
            );
        }
        *PASS_CANDIDATES.lock().unwrap() = None;
        let first = pi_history_page_for_root(&sessions, None);
        assert_eq!(first.files.len(), PI_PAGE_SIZE);
        assert!(first
            .files
            .iter()
            .all(|file| file.status == Some("read") && file.size > 0 && file.mtime_ms > 0));
        assert_eq!(
            first.next_cursor.as_deref(),
            Some(first.files.last().unwrap().source_id.as_str())
        );
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

    /// `cargo test --lib pi_migration::tests::bench_pi_second -- --ignored --nocapture`
    /// Set `PI_BENCH_DUMP=<dir>` to also write the native results for a frontend replay.
    #[test]
    #[ignore = "benchmark: prints the native cost of a second launch after one appended file"]
    fn bench_pi_second_start_after_one_append() {
        let root = tempdir().unwrap();
        let sessions = root.path().join("sessions");
        let mut appended = PathBuf::new();
        for project in 0..10 {
            let dir = sessions.join(format!("--project-{project}--"));
            std::fs::create_dir_all(&dir).unwrap();
            for index in 0..30 {
                // One large session per project (about 4.5 MB), the rest small.
                let messages = if index == 0 { 30_000 } else { 40 };
                let path = write_session(
                    &dir,
                    &format!("{index:04}.jsonl"),
                    &format!("p{project}-s{index}"),
                    messages,
                );
                if project == 3 && index == 7 {
                    appended = path;
                }
            }
        }
        let full_pass = || {
            let mut cursor: Option<String> = None;
            let mut pages = Vec::new();
            loop {
                let page = pi_history_page_for_root(&sessions, cursor.clone());
                let complete = page.complete;
                cursor = page.next_cursor.clone();
                pages.push(page);
                if complete {
                    break;
                }
            }
            pages
        };
        let bytes: u64 = pi_manifest_for_root(&sessions)
            .unwrap()
            .files
            .iter()
            .map(|file| file.size)
            .sum();
        println!(
            "synthetic directory: 300 session files, {:.1} MB",
            bytes as f64 / 1048576.0
        );
        let first = full_pass();
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&appended)
            .unwrap();
        use std::io::Write;
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"message","id":"appended","parentId":"p3-s7-m39","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":"appended"}})
        )
        .unwrap();
        drop(file);
        let appended_id = safe_id(&appended.to_string_lossy());
        let mut dump = None;
        for round in 0..3 {
            *PASS_CANDIDATES.lock().unwrap() = None;
            let started = std::time::Instant::now();
            pi_history_signature_for_root(&sessions).unwrap();
            let pages = full_pass();
            let before = started.elapsed();
            *MANIFEST_PATHS.lock().unwrap() = None;
            let started = std::time::Instant::now();
            pi_history_signature_for_root(&sessions).unwrap();
            let manifest = pi_manifest_for_root(&sessions).unwrap();
            let read = pi_history_read_for_root(&sessions, std::slice::from_ref(&appended_id));
            let after = started.elapsed();
            assert_eq!(read.conversations.len(), 1);
            println!(
                "round {round}: second launch after one appended file, native work: before (signature + full pass) {before:?}; after (signature + manifest + one read) {after:?}"
            );
            dump = Some((pages, manifest, read));
        }
        if let Some(dir) = std::env::var_os("PI_BENCH_DUMP") {
            let (pages, manifest, read) = dump.unwrap();
            let dir = PathBuf::from(dir);
            std::fs::create_dir_all(&dir).unwrap();
            let write = |name: &str, value: serde_json::Value| {
                std::fs::write(dir.join(name), value.to_string()).unwrap();
            };
            write("first-pass.json", serde_json::to_value(&first).unwrap());
            write("second-pass.json", serde_json::to_value(&pages).unwrap());
            write("manifest.json", serde_json::to_value(&manifest).unwrap());
            write("read.json", serde_json::to_value(&read).unwrap());
        }
    }
}
