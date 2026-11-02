#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationCheckpointRecord {
    schema: u32,
    turn_seq: u64,
    turn_id: String,
    root: String,
    rel_path: String,
    kind: String,
    existed_before: bool,
    blob: Option<String>,
    blob_base64: Option<String>,
    size: u64,
    mtime_ms: u64,
    captured_at: u64,
    note: Option<String>,
    mode: Option<u32>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationCheckpoint {
    status: String,
    native_path: String,
    index_path: String,
    index_jsonl: String,
    records: Vec<LegacyMigrationCheckpointRecord>,
    invalid_lines: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeCheckpointRecord {
    schema: u32,
    turn_seq: u64,
    turn_id: String,
    root: String,
    rel_path: String,
    kind: String,
    existed_before: bool,
    blob: Option<String>,
    size: u64,
    mtime_ms: u64,
    captured_at: u64,
    note: Option<String>,
    mode: Option<u32>,
}

fn migration_read_artifact(
    home: &std::path::Path,
    rel: &std::path::Path,
    limit: u64,
) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut path = home.to_path_buf();
    for component in rel.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("unsafe checkpoint artifact path".to_string());
        }
        path.push(component);
        let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("symlinked checkpoint artifact".to_string());
        }
    }
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("checkpoint export size or file type limit".to_string());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("checkpoint export size limit".to_string());
    }
    Ok(bytes)
}

fn checkpoint_safe_id(conversation_id: &str) -> String {
    let safe: String = conversation_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    safe.trim_matches('.').to_string()
}

fn checkpoint_export(conversation_id: &str, home: &std::path::Path) -> LegacyMigrationCheckpoint {
    let safe = checkpoint_safe_id(conversation_id);
    let safe = safe.as_str();
    let native_path = format!("~/.liveagent/checkpoints/{safe}");
    let mut out = LegacyMigrationCheckpoint {
        status: "partial".to_string(),
        index_path: format!("{native_path}/index.jsonl"),
        native_path,
        index_jsonl: String::new(),
        records: vec![],
        invalid_lines: vec![],
    };
    if safe.is_empty() {
        out.invalid_lines
            .push("invalid checkpoint conversation identity".to_string());
        return out;
    }
    let rel = std::path::Path::new(".liveagent")
        .join("checkpoints")
        .join(safe);
    // Keep the complete import request below the backend's bounded JSON transport.
    let bytes = match migration_read_artifact(home, &rel.join("index.jsonl"), 256 * 1024) {
        Ok(bytes) => bytes,
        Err(error) => {
            if let Err(e) = std::fs::symlink_metadata(home.join(&rel)) {
                if e.kind() == std::io::ErrorKind::NotFound {
                    out.status = "not_found".to_string();
                    return out;
                }
            }
            out.invalid_lines.push(error);
            return out;
        }
    };
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => {
            out.invalid_lines
                .push("checkpoint index is not UTF-8".to_string());
            return out;
        }
    };
    let mut blob_budget = 512 * 1024u64;
    for (line_number, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let record = match serde_json::from_str::<NativeCheckpointRecord>(line) {
            Ok(record) => record,
            Err(_) => {
                out.invalid_lines
                    .push(format!("line {}: invalid checkpoint JSON", line_number + 1));
                continue;
            }
        };
        if record.schema != 2 {
            out.invalid_lines.push(format!(
                "line {}: unsupported checkpoint schema",
                line_number + 1
            ));
            continue;
        }
        let blob_base64 = record.blob.as_ref().and_then(|blob| {
            if blob.is_empty() || blob.contains(['/', '\\']) || blob == "." || blob == ".." {
                out.invalid_lines.push(format!(
                    "line {}: unsafe checkpoint blob name",
                    line_number + 1
                ));
                return None;
            }
            match migration_read_artifact(home, &rel.join("blobs").join(blob), blob_budget) {
                Ok(bytes) => {
                    blob_budget -= bytes.len() as u64;
                    if bytes.len() as u64 != record.size {
                        out.invalid_lines.push(format!(
                            "line {}: checkpoint blob size mismatch",
                            line_number + 1
                        ));
                        return None;
                    }
                    Some(base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        bytes,
                    ))
                }
                Err(error) => {
                    out.invalid_lines
                        .push(format!("line {}: {error}", line_number + 1));
                    None
                }
            }
        });
        out.records.push(LegacyMigrationCheckpointRecord {
            schema: record.schema,
            turn_seq: record.turn_seq,
            turn_id: record.turn_id,
            root: record.root,
            rel_path: record.rel_path,
            kind: record.kind,
            existed_before: record.existed_before,
            blob: record.blob,
            blob_base64,
            size: record.size,
            mtime_ms: record.mtime_ms,
            captured_at: record.captured_at,
            note: record.note,
            mode: record.mode,
        });
    }
    out.index_jsonl = text;
    out.status = if out.invalid_lines.is_empty() {
        "available"
    } else {
        "partial"
    }
    .to_string();
    out
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationSegment {
    segment_index: i64,
    segment_id: String,
    messages_json: String,
    summary_json: Option<String>,
    message_count: i64,
    start_message_id: Option<String>,
    end_message_id: Option<String>,
    created_at: i64,
    updated_at: i64,
    active: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationConversation {
    id: String,
    title: String,
    provider_id: String,
    model: String,
    session_id: Option<String>,
    cwd: Option<String>,
    selected_model_json: Option<String>,
    created_at: i64,
    updated_at: i64,
    is_pinned: bool,
    is_shared: bool,
    share_token: Option<String>,
    redact_tool_content: bool,
    context_meta_json: String,
    active_segment_index: i64,
    total_segment_count: i64,
    total_message_count: i64,
    segments: Vec<LegacyMigrationSegment>,
    checkpoint: LegacyMigrationCheckpoint,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationPage {
    conversations: Vec<LegacyMigrationConversation>,
    next_cursor: Option<String>,
    complete: bool,
}

type LegacyMigrationRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    i64,
    i64,
    bool,
    bool,
    Option<String>,
    bool,
);

fn migration_page_sync(
    conn: &Connection,
    cursor: Option<&str>,
    home: &std::path::Path,
) -> Result<LegacyMigrationPage, String> {
    const PAGE_SIZE: i64 = 20;
    let after = cursor.unwrap_or("");
    let mut stmt = conn
        .prepare(
            "SELECT h.id, h.title, h.provider_id, h.model, h.session_id, h.cwd,
                    h.selected_model_json, h.context_meta_json, h.active_segment_index,
                    h.total_segment_count, h.total_message_count, h.created_at, h.updated_at,
                    h.is_pinned, COALESCE(share.enabled, 0), share.token,
                    COALESCE(share.redact_tool_content, 0)
               FROM chatHistory h
               LEFT JOIN chatHistoryShare share ON share.conversation_id = h.id
              WHERE h.id > ?1 ORDER BY h.id ASC LIMIT ?2",
        )
        .map_err(|e| format!("prepare legacy migration page failed: {e}"))?;
    let rows: Vec<LegacyMigrationRow> = stmt
        .query_map(rusqlite::params![after, PAGE_SIZE], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get::<_, Option<String>>(7)?
                    .unwrap_or_else(|| "{}".to_string()),
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
                row.get::<_, i64>(13)? != 0,
                row.get::<_, i64>(14)? != 0,
                row.get(15)?,
                row.get::<_, i64>(16)? != 0,
            ))
        })
        .map_err(|e| format!("query legacy migration page failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read legacy migration rows failed: {e}"))?;
    drop(stmt);

    let mut conversations = Vec::with_capacity(rows.len());
    for (
        id,
        title,
        provider_id,
        model,
        session_id,
        cwd,
        selected_model_json,
        context_meta_json,
        active_segment_index,
        total_segment_count,
        total_message_count,
        created_at,
        updated_at,
        is_pinned,
        is_shared,
        share_token,
        redact_tool_content,
    ) in rows
    {
        let mut segments_stmt = conn
            .prepare(
                "SELECT segment_index, segment_id, messages_json, summary_json,
                        message_count, start_message_id, end_message_id, created_at, updated_at
                   FROM chatHistorySegment
                  WHERE conversation_id = ?1 ORDER BY segment_index ASC",
            )
            .map_err(|e| format!("prepare legacy segments failed: {e}"))?;
        let segments = segments_stmt
            .query_map(rusqlite::params![&id], |row| {
                Ok(LegacyMigrationSegment {
                    segment_index: row.get(0)?,
                    segment_id: row.get(1)?,
                    messages_json: row.get(2)?,
                    summary_json: row.get(3)?,
                    message_count: row.get(4)?,
                    start_message_id: row.get(5)?,
                    end_message_id: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                    active: row.get::<_, i64>(0)? == active_segment_index.unwrap_or(-1),
                })
            })
            .map_err(|e| format!("query legacy segments failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read legacy segments failed: {e}"))?;
        conversations.push(LegacyMigrationConversation {
            id: id.clone(),
            title,
            provider_id,
            model,
            session_id,
            cwd,
            selected_model_json,
            created_at,
            updated_at,
            is_pinned,
            is_shared,
            share_token: is_shared.then_some(share_token).flatten(),
            redact_tool_content,
            context_meta_json,
            active_segment_index: active_segment_index.unwrap_or(0),
            total_segment_count: total_segment_count.unwrap_or(segments.len() as i64),
            total_message_count: total_message_count.unwrap_or(0),
            segments,
            checkpoint: checkpoint_export(&id, home),
        });
    }
    let next_cursor = conversations.last().map(|item| item.id.clone());
    let complete = conversations.len() < PAGE_SIZE as usize;
    Ok(LegacyMigrationPage {
        conversations,
        next_cursor: (!complete).then_some(next_cursor.unwrap_or_default()),
        complete,
    })
}

fn open_migration_path(path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("open legacy history read-only failed: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("set migration timeout failed: {e}"))?;
    Ok(conn)
}

/// Hashes every row a query returns, column by column, and also returns its first column.
fn hash_query_rows(
    conn: &Connection,
    sql: &str,
    columns: usize,
) -> Result<(Vec<String>, String), String> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("prepare legacy history signature failed: {e}"))?;
    let mut hash = <sha2::Sha256 as sha2::Digest>::new();
    let keys = stmt
        .query_map([], |row| {
            let mut fields = Vec::with_capacity(columns);
            for index in 0..columns {
                let value: rusqlite::types::Value = row.get(index)?;
                fields.push(format!("{value:?}"));
            }
            Ok((row.get::<_, String>(0)?, fields))
        })
        .map_err(|e| format!("query legacy history signature failed: {e}"))?
        .map(|row| {
            let (key, fields) = row?;
            for field in fields {
                sha2::Digest::update(&mut hash, field.len().to_le_bytes());
                sha2::Digest::update(&mut hash, field.as_bytes());
            }
            Ok(key)
        })
        .collect::<Result<Vec<String>, rusqlite::Error>>()
        .map_err(|e| format!("read legacy history signature failed: {e}"))?;
    let digest = sha2::Digest::finalize(hash)
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((keys, digest))
}

/// Cheap fingerprint of everything a legacy migration pass exports: the conversation and share
/// rows themselves, the segment count and latest segment update, plus size and mtime of each
/// conversation's checkpoint index. Startup skips the full export while it is unchanged since a
/// complete pass. Segment bodies are trusted through updated_at to avoid reading them.
fn migration_signature_sync(conn: &Connection, home: &std::path::Path) -> Result<String, String> {
    let (segments, segments_at): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(MAX(updated_at), 0) FROM chatHistorySegment",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("read legacy history signature failed: {e}"))?;
    // Older builds rename, pin and move conversations without touching updated_at, so the
    // exported conversation columns are hashed instead of trusted through the timestamp.
    let (ids, rows_digest) = hash_query_rows(
        conn,
        "SELECT id, title, provider_id, model, session_id, cwd, context_meta_json,
                active_segment_index, total_segment_count, total_message_count,
                created_at, updated_at, is_pinned, selected_model_json
           FROM chatHistory ORDER BY id ASC",
        14,
    )?;
    let (_, shares_digest) = hash_query_rows(
        conn,
        "SELECT conversation_id, token, enabled, redact_tool_content
           FROM chatHistoryShare ORDER BY conversation_id ASC",
        4,
    )?;
    let rows = ids.len();
    let checkpoints = home.join(".liveagent").join("checkpoints");
    let (mut indexes, mut index_bytes, mut index_mtime) = (0u64, 0u64, 0u128);
    for id in ids {
        let safe = checkpoint_safe_id(&id);
        if safe.is_empty() {
            continue;
        }
        let Ok(metadata) = std::fs::metadata(checkpoints.join(safe).join("index.jsonl")) else {
            continue;
        };
        indexes += 1;
        index_bytes = index_bytes.wrapping_add(metadata.len());
        if let Ok(modified) = metadata.modified() {
            if let Ok(since) = modified.duration_since(std::time::UNIX_EPOCH) {
                index_mtime = index_mtime.max(since.as_nanos());
            }
        }
    }
    Ok(format!(
        "v1:{rows}:{rows_digest}:{shares_digest}:{segments}:{segments_at}:{indexes}:{index_bytes}:{index_mtime}"
    ))
}

#[tauri::command]
pub async fn legacy_history_migration_signature() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::runtime::data_home::home_dir()
            .ok_or_else(|| "cannot locate legacy history home".to_string())?;
        let path = home
            .join(format!(".{}", env!("CARGO_PKG_NAME")))
            .join("chat-history.sqlite3");
        if !path.exists() {
            return Ok(None);
        }
        let conn = open_migration_path(&path)?;
        migration_signature_sync(&conn, &home).map(Some)
    })
    .await
    .map_err(|e| format!("legacy history signature join failed: {e}"))?
}

#[tauri::command]
pub async fn legacy_history_migration_page(
    cursor: Option<String>,
) -> Result<LegacyMigrationPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home =
            crate::runtime::data_home::home_dir().ok_or_else(|| "cannot locate legacy history home".to_string())?;
        let path = home
            .join(format!(".{}", env!("CARGO_PKG_NAME")))
            .join("chat-history.sqlite3");
        if !path.exists() {
            return Ok(LegacyMigrationPage {
                conversations: vec![],
                next_cursor: None,
                complete: true,
            });
        }
        let mut conn = open_migration_path(&path)?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin migration snapshot failed: {e}"))?;
        migration_page_sync(&tx, cursor.as_deref(), &home)
    })
    .await
    .map_err(|e| format!("legacy history migration join failed: {e}"))?
}
