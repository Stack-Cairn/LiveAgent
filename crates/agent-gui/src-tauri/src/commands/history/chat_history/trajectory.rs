// 轨迹事件与 prompt 分段的持久化。
//
// 事件挂在 `chatHistorySegment.trajectory_json` 上；整段删除由外键生命周期处理，
// 但分支和段内 edit-resend 仍需显式裁剪，相关逻辑位于 trajectory_lifecycle.rs。
//
// 追加不做事件去重：读取侧的 `buildTrajectoryLedger` 按事件身份幂等收敛。
// 单次追加在 SQLite 事务内执行，避免并发读改写静默覆盖。

use sha2::{Digest as TrajectoryDigest, Sha256 as TrajectorySha256};
use std::collections::HashSet as TrajectorySectionIdSet;

/// 单个分段的事件上限，超出后拒绝继续追加。
///
/// 正常长回合约 150 条 / 18 KB，这个上限留了两个数量级的余量，只用于挡住
/// 埋点失控（例如某个循环反复发同一条）导致数据库无界增长。
const TRAJECTORY_MAX_EVENTS_BYTES: usize = 8 * 1024 * 1024;

/// 单份 prompt 分段的上限。memory overview 自身有 16 KB 帽，工具目录序列化后
/// 通常几十 KB；1 MB 足够容纳异常大的 system prompt 又不至于失控。
const TRAJECTORY_MAX_SECTION_BYTES: usize = 1024 * 1024;
/// SYSTEM details need current+previous request slots; 64 leaves ample room while
/// preventing an authenticated client from constructing an unbounded SQLite IN query.
const TRAJECTORY_MAX_SECTION_REQUESTS: usize = 64;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectorySectionInput {
    pub section_id: String,
    pub slot: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectorySectionRecord {
    pub section_id: String,
    pub slot: String,
    pub content: String,
    pub bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryEventsResponse {
    pub conversation_id: String,
    /// 全会话事件的扁平 JSON 数组文本；无记录时为 `[]`。
    pub events_json: String,
    pub segment_count: i64,
    /// 是否有分段因触顶而停止记录，UI 据此提示轨迹不完整。
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryAppendResult {
    pub stored_bytes: i64,
    /// true 表示本次事件被上限拒绝，没有写入。
    pub truncated: bool,
}

fn parse_event_array(raw: &str, label: &str) -> Result<Vec<Value>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Value =
        serde_json::from_str(trimmed).map_err(|e| format!("解析{label}失败：{e}"))?;
    match parsed {
        Value::Array(items) => Ok(items),
        _ => Err(format!("{label}必须是 JSON 数组")),
    }
}

/// 追加事件到指定分段。
///
/// 分段不存在时返回错误而不是静默建段：轨迹永远跟随已存在的消息分段，凭空建段
/// 会产生没有消息的孤儿轨迹。
fn append_trajectory_events_sync(
    conn: &Connection,
    conversation_id: &str,
    segment_index: i64,
    events_json: &str,
) -> Result<TrajectoryAppendResult, String> {
    let incoming = parse_event_array(events_json, "轨迹事件")?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开启轨迹追加事务失败：{e}"))?;
    let existing: Option<(String, i64)> = tx
        .query_row(
            "SELECT trajectory_json, trajectory_truncated FROM chatHistorySegment
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params![conversation_id, segment_index],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("读取分段轨迹失败：{e}"))?;
    let Some((existing_raw, existing_truncated)) = existing else {
        return Err(format!(
            "分段不存在：conversation={conversation_id} segment={segment_index}"
        ));
    };

    if incoming.is_empty() || existing_truncated != 0 {
        tx.commit()
            .map_err(|e| format!("提交空轨迹追加事务失败：{e}"))?;
        return Ok(TrajectoryAppendResult {
            stored_bytes: existing_raw.len() as i64,
            truncated: existing_truncated != 0,
        });
    }

    let mut merged = match parse_event_array(&existing_raw, "已存轨迹事件") {
        Ok(events) => events,
        Err(_) => {
            tx.execute(
                "UPDATE chatHistorySegment SET trajectory_truncated = 1
                 WHERE conversation_id = ?1 AND segment_index = ?2",
                params![conversation_id, segment_index],
            )
            .map_err(|e| format!("标记损坏轨迹分段失败：{e}"))?;
            tx.commit()
                .map_err(|e| format!("提交损坏轨迹分段标记失败：{e}"))?;
            return Ok(TrajectoryAppendResult {
                stored_bytes: existing_raw.len() as i64,
                truncated: true,
            });
        }
    };
    merged.extend(incoming);
    let serialized =
        serde_json::to_string(&merged).map_err(|e| format!("序列化轨迹事件失败：{e}"))?;

    if serialized.len() > TRAJECTORY_MAX_EVENTS_BYTES {
        // 触顶标记必须持久化；否则重启后读取侧会把不完整轨迹误报为完整。
        tx.execute(
            "UPDATE chatHistorySegment SET trajectory_truncated = 1
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params![conversation_id, segment_index],
        )
        .map_err(|e| format!("标记分段轨迹截断失败：{e}"))?;
        tx.commit()
            .map_err(|e| format!("提交轨迹截断标记失败：{e}"))?;
        return Ok(TrajectoryAppendResult {
            stored_bytes: existing_raw.len() as i64,
            truncated: true,
        });
    }

    tx.execute(
        "UPDATE chatHistorySegment
         SET trajectory_json = ?3
         WHERE conversation_id = ?1 AND segment_index = ?2",
        params![conversation_id, segment_index, serialized],
    )
    .map_err(|e| format!("写入分段轨迹失败：{e}"))?;
    tx.commit()
        .map_err(|e| format!("提交轨迹追加事务失败：{e}"))?;

    Ok(TrajectoryAppendResult {
        stored_bytes: serialized.len() as i64,
        truncated: false,
    })
}

fn load_trajectory_events_sync(
    conn: &Connection,
    conversation_id: &str,
) -> Result<TrajectoryEventsResponse, String> {
    let mut stmt = conn
        .prepare(
            "SELECT trajectory_json, trajectory_truncated FROM chatHistorySegment
             WHERE conversation_id = ?1
             ORDER BY segment_index ASC",
        )
        .map_err(|e| format!("准备轨迹查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("查询轨迹失败：{e}"))?;

    let mut events: Vec<Value> = Vec::new();
    let mut segment_count = 0_i64;
    let mut truncated = false;
    for row in rows {
        let (raw, segment_truncated) = row.map_err(|e| format!("读取轨迹行失败：{e}"))?;
        segment_count += 1;
        truncated |= segment_truncated != 0;
        match parse_event_array(&raw, "轨迹事件") {
            Ok(items) => events.extend(items),
            Err(_) => {
                // 单个分段损坏只让该段降级，其余分段照常返回。
                truncated = true;
            }
        }
    }

    backfill_legacy_trajectory_user_ids(conn, conversation_id, &mut events)?;
    let events_json =
        serde_json::to_string(&events).map_err(|e| format!("序列化轨迹事件失败：{e}"))?;
    Ok(TrajectoryEventsResponse {
        conversation_id: conversation_id.to_string(),
        events_json,
        segment_count,
        truncated,
    })
}

fn resolve_trajectory_turn_number_sync(
    conn: &Connection,
    conversation_id: &str,
    current_user_persisted: bool,
) -> Result<i64, String> {
    let total_message_count = conn
        .query_row(
            "SELECT total_message_count FROM chatHistory WHERE id = ?1",
            params![conversation_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("读取轨迹轮次保守计数失败：{e}"))?
        .unwrap_or(0)
        .max(0);
    let mut stmt = conn
        .prepare(
            "SELECT messages_json, trajectory_json FROM chatHistorySegment
             WHERE conversation_id = ?1 ORDER BY segment_index ASC",
        )
        .map_err(|e| format!("准备轨迹轮次解析失败：{e}"))?;
    let rows = stmt
        .query_map(params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("查询轨迹轮次解析失败：{e}"))?;
    let mut user_turns = 0_i64;
    let mut max_event_turn = 0_i64;
    let mut messages_complete = true;
    for row in rows {
        let (messages_raw, trajectory_raw) =
            row.map_err(|e| format!("读取轨迹轮次分段失败：{e}"))?;
        match parse_event_array(&messages_raw, "历史分段消息") {
            Ok(messages) => {
                for message in messages {
                    if message
                        .as_object()
                        .and_then(|object| object.get("role"))
                        .and_then(Value::as_str)
                        == Some("user")
                    {
                        user_turns = user_turns.saturating_add(1);
                    }
                }
            }
            Err(_) => messages_complete = false,
        }
        if let Ok(events) = parse_event_array(&trajectory_raw, "轨迹事件") {
            for turn in events.iter().filter_map(|event| {
                event
                    .as_object()
                    .and_then(|object| object.get("t"))
                    .and_then(Value::as_i64)
                    .filter(|turn| *turn > 0)
            }) {
                max_event_turn = max_event_turn.max(turn);
            }
        }
    }
    if !messages_complete {
        user_turns = user_turns.max(total_message_count);
    }
    let user_count_candidate = user_turns.saturating_add(i64::from(!current_user_persisted));
    Ok(1_i64
        .max(user_count_candidate)
        .max(max_event_turn.saturating_add(1)))
}

const TRAJECTORY_SECTION_SLOT_NAMES: [&str; 7] = [
    "base",
    "agent",
    "skills",
    "memory",
    "toolsSuffix",
    "toolCatalog",
    "runtime",
];

fn expected_trajectory_section_id(content: &str) -> String {
    let digest = TrajectorySha256::digest(content.as_bytes());
    let prefix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("s_{prefix}")
}

fn validate_trajectory_section(section: &TrajectorySectionInput) -> Result<(), String> {
    let section_id = section.section_id.trim();
    if section_id.is_empty() {
        return Err("分段 id 不能为空".to_string());
    }
    let expected = expected_trajectory_section_id(&section.content);
    if section_id != expected {
        return Err(format!("轨迹分段 id 与内容 SHA-256 不匹配：{section_id}"));
    }
    if !TRAJECTORY_SECTION_SLOT_NAMES.contains(&section.slot.as_str()) {
        return Err(format!("未知轨迹分段槽位：{}", section.slot));
    }
    Ok(())
}

fn put_trajectory_sections_sync(
    conn: &Connection,
    conversation_id: &str,
    sections: &[TrajectorySectionInput],
) -> Result<i64, String> {
    if sections.is_empty() {
        return Ok(0);
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开启轨迹分段事务失败：{e}"))?;
    let now = now_ms();
    let mut stored = 0_i64;
    for section in sections {
        validate_trajectory_section(section)?;
        if section.content.len() > TRAJECTORY_MAX_SECTION_BYTES {
            // 详情缺失是允许的诊断降级；事件骨架仍可继续写入和查看。
            continue;
        }
        let section_id = section.section_id.trim();
        let affected = tx
            .execute(
                "INSERT OR IGNORE INTO chatTrajectorySection
                 (conversation_id, section_id, slot, content, bytes, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    conversation_id,
                    section_id,
                    section.slot,
                    section.content,
                    section.content.len() as i64,
                    now
                ],
            )
            .map_err(|e| format!("写入轨迹分段失败：{e}"))?;
        if affected == 0 {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT content FROM chatTrajectorySection
                     WHERE conversation_id = ?1 AND section_id = ?2",
                    params![conversation_id, section_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("校验轨迹分段冲突失败：{e}"))?;
            // section_id addresses content only. The same exact text may
            // legally occupy multiple prompt slots; refs carry slot position.
            if existing.as_deref() != Some(section.content.as_str()) {
                return Err(format!("轨迹分段内容寻址冲突：{section_id}"));
            }
        }
        stored += affected as i64;
    }
    tx.commit()
        .map_err(|e| format!("提交轨迹分段事务失败：{e}"))?;
    Ok(stored)
}

fn get_trajectory_sections_sync(
    conn: &Connection,
    conversation_id: &str,
    section_ids: &[String],
) -> Result<Vec<TrajectorySectionRecord>, String> {
    if section_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut seen = TrajectorySectionIdSet::new();
    let mut unique_ids = Vec::new();
    for id in section_ids {
        let id = id.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        unique_ids.push(id.to_string());
        if unique_ids.len() > TRAJECTORY_MAX_SECTION_REQUESTS {
            return Err(format!(
                "轨迹分段请求过多：最多 {TRAJECTORY_MAX_SECTION_REQUESTS} 个"
            ));
        }
    }
    if unique_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", unique_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT section_id, slot, content, bytes FROM chatTrajectorySection
         WHERE conversation_id = ?1 AND section_id IN ({placeholders})"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备轨迹分段查询失败：{e}"))?;
    let mut bindings: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(unique_ids.len() + 1);
    bindings.push(&conversation_id);
    for id in &unique_ids {
        bindings.push(id);
    }
    let rows = stmt
        .query_map(bindings.as_slice(), |row| {
            Ok(TrajectorySectionRecord {
                section_id: row.get("section_id")?,
                slot: row.get("slot")?,
                content: row.get("content")?,
                bytes: row.get("bytes")?,
            })
        })
        .map_err(|e| format!("查询轨迹分段失败：{e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("读取轨迹分段行失败：{e}"))?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn trajectory_append_events(
    conversation_id: String,
    segment_index: i64,
    events_json: String,
) -> Result<TrajectoryAppendResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        append_trajectory_events_sync(&conn, &conversation_id, segment_index, &events_json)
    })
    .await
    .map_err(|e| format!("trajectory_append_events join 失败：{e}"))?
}

#[tauri::command]
pub async fn trajectory_get_events(
    conversation_id: String,
) -> Result<TrajectoryEventsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        load_trajectory_events_sync(&conn, &conversation_id)
    })
    .await
    .map_err(|e| format!("trajectory_get_events join 失败：{e}"))?
}

#[tauri::command]
pub async fn trajectory_resolve_turn_number(
    conversation_id: String,
    current_user_persisted: bool,
) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        resolve_trajectory_turn_number_sync(&conn, &conversation_id, current_user_persisted)
    })
    .await
    .map_err(|e| format!("trajectory_resolve_turn_number join 失败：{e}"))?
}

#[tauri::command]
pub async fn trajectory_put_sections(
    conversation_id: String,
    sections: Vec<TrajectorySectionInput>,
) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        put_trajectory_sections_sync(&conn, &conversation_id, &sections)
    })
    .await
    .map_err(|e| format!("trajectory_put_sections join 失败：{e}"))?
}

#[tauri::command]
pub async fn trajectory_get_sections(
    conversation_id: String,
    section_ids: Vec<String>,
) -> Result<Vec<TrajectorySectionRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        get_trajectory_sections_sync(&conn, &conversation_id, &section_ids)
    })
    .await
    .map_err(|e| format!("trajectory_get_sections join 失败：{e}"))?
}

#[cfg(test)]
mod trajectory_tests {
    use super::*;

    fn open_trajectory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory trajectory database");
        history_db::initialize_connection(&conn).expect("initialize trajectory schema");
        conn
    }

    fn seed_conversation(conn: &Connection, id: &str, segment_indexes: &[i64]) {
        conn.execute(
            "INSERT INTO chatHistory
             (id, title, provider_id, model, context_meta_json, active_segment_index,
              total_segment_count, total_message_count, created_at, updated_at)
             VALUES (?1, 'T', 'codex', 'gpt-5', '{}', 0, ?2, 0, 1, 1)",
            params![id, segment_indexes.len() as i64],
        )
        .expect("seed conversation");
        for index in segment_indexes {
            conn.execute(
                "INSERT INTO chatHistorySegment
                 (conversation_id, segment_index, segment_id, messages_json, message_count,
                  created_at, updated_at)
                 VALUES (?1, ?2, ?3, '[]', 0, 1, 1)",
                params![id, index, format!("seg-{index}")],
            )
            .expect("seed segment");
        }
    }

    fn trajectory_raw(conn: &Connection, id: &str, segment_index: i64) -> String {
        conn.query_row(
            "SELECT trajectory_json FROM chatHistorySegment
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params![id, segment_index],
            |row| row.get(0),
        )
        .expect("read trajectory column")
    }

    #[test]
    fn migration_adds_the_segment_column_and_section_table() {
        let conn = open_trajectory_db();
        let mut stmt = conn
            .prepare("PRAGMA table_info(chatHistorySegment)")
            .expect("prepare pragma");
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query pragma")
            .map(|row| row.expect("read column"))
            .collect();
        assert!(columns.iter().any(|column| column == "trajectory_json"));
        assert!(columns
            .iter()
            .any(|column| column == "trajectory_truncated"));

        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chatTrajectorySection'",
                [],
                |row| row.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(table_count, 1);
    }

    #[test]
    fn a_fresh_segment_starts_with_an_empty_event_array() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        assert_eq!(trajectory_raw(&conn, "c1", 0), "[]");
        let loaded = load_trajectory_events_sync(&conn, "c1").expect("load events");
        assert_eq!(loaded.events_json, "[]");
        assert_eq!(loaded.segment_count, 1);
        assert!(!loaded.truncated);
    }

    #[test]
    fn appends_accumulate_in_order_across_calls() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
            .expect("first append");
        append_trajectory_events_sync(
            &conn,
            "c1",
            0,
            r#"[{"k":"step_start","t":1,"s":1,"at":20}]"#,
        )
        .expect("second append");

        let loaded = load_trajectory_events_sync(&conn, "c1").expect("load events");
        let events: Vec<Value> = serde_json::from_str(&loaded.events_json).expect("parse events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["k"], "user");
        assert_eq!(events[1]["k"], "step_start");
    }

    #[test]
    fn events_are_concatenated_in_segment_order() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0, 1]);
        append_trajectory_events_sync(&conn, "c1", 1, r#"[{"k":"turn_end","t":2,"at":90}]"#)
            .expect("append later segment");
        append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
            .expect("append earlier segment");

        let loaded = load_trajectory_events_sync(&conn, "c1").expect("load events");
        let events: Vec<Value> = serde_json::from_str(&loaded.events_json).expect("parse events");
        assert_eq!(events[0]["k"], "user");
        assert_eq!(events[1]["k"], "turn_end");
        assert_eq!(loaded.segment_count, 2);
    }

    #[test]
    fn appending_to_a_missing_segment_is_an_error_not_a_silent_create() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        let error = append_trajectory_events_sync(&conn, "c1", 7, r#"[{"k":"user","t":1,"at":1}]"#)
            .expect_err("missing segment must fail");
        assert!(error.contains("分段不存在"));
    }

    #[test]
    fn a_non_array_payload_is_rejected() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        assert!(append_trajectory_events_sync(&conn, "c1", 0, r#"{"k":"user"}"#).is_err());
        assert!(append_trajectory_events_sync(&conn, "c1", 0, "not json").is_err());
    }

    #[test]
    fn an_empty_batch_leaves_storage_untouched() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
            .expect("seed one event");
        let before = trajectory_raw(&conn, "c1", 0);
        append_trajectory_events_sync(&conn, "c1", 0, "[]").expect("empty append");
        assert_eq!(trajectory_raw(&conn, "c1", 0), before);
    }

    #[test]
    fn a_corrupt_segment_degrades_alone_and_is_reported() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0, 1]);
        append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
            .expect("append good segment");
        conn.execute(
            "UPDATE chatHistorySegment SET trajectory_json = '{oops'
             WHERE conversation_id = 'c1' AND segment_index = 1",
            [],
        )
        .expect("corrupt segment");

        let loaded = load_trajectory_events_sync(&conn, "c1").expect("load events");
        let events: Vec<Value> = serde_json::from_str(&loaded.events_json).expect("parse events");
        assert_eq!(events.len(), 1);
        assert!(loaded.truncated);
    }

    #[test]
    fn appending_to_a_corrupt_segment_marks_it_truncated_without_overwriting_it() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        conn.execute(
            "UPDATE chatHistorySegment SET trajectory_json = '{oops' WHERE conversation_id = 'c1'",
            [],
        )
        .expect("corrupt trajectory");
        let result =
            append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
                .expect("diagnostic append degrades");
        assert!(result.truncated);
        assert_eq!(trajectory_raw(&conn, "c1", 0), "{oops");
        let flag: i64 = conn
            .query_row(
                "SELECT trajectory_truncated FROM chatHistorySegment WHERE conversation_id = 'c1'",
                [],
                |row| row.get(0),
            )
            .expect("read truncation flag");
        assert_eq!(flag, 1);
    }

    #[test]
    fn oversized_batches_are_refused_without_losing_existing_events() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
            .expect("seed one event");
        let huge = format!(
            r#"[{{"k":"context","t":1,"at":1,"tx":"{}"}}]"#,
            "x".repeat(TRAJECTORY_MAX_EVENTS_BYTES + 1)
        );
        let result =
            append_trajectory_events_sync(&conn, "c1", 0, &huge).expect("oversized append");
        assert!(result.truncated);

        let loaded = load_trajectory_events_sync(&conn, "c1").expect("load events");
        let events: Vec<Value> = serde_json::from_str(&loaded.events_json).expect("parse events");
        assert_eq!(
            events.len(),
            1,
            "existing events must survive a refused append"
        );
    }

    fn section(slot: &str, content: &str) -> TrajectorySectionInput {
        TrajectorySectionInput {
            section_id: expected_trajectory_section_id(content),
            slot: slot.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn sections_are_idempotent_by_content_address() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        let stored = put_trajectory_sections_sync(
            &conn,
            "c1",
            &[section("base", "BASE"), section("memory", "MEM")],
        )
        .expect("first put");
        assert_eq!(stored, 2);

        let again = put_trajectory_sections_sync(&conn, "c1", &[section("base", "BASE")])
            .expect("second put");
        assert_eq!(again, 0);

        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chatTrajectorySection WHERE conversation_id = 'c1'",
                [],
                |row| row.get(0),
            )
            .expect("count sections");
        assert_eq!(rows, 2);
    }

    #[test]
    fn only_requested_sections_come_back_and_bytes_are_recorded() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        put_trajectory_sections_sync(
            &conn,
            "c1",
            &[section("base", "BASE"), section("memory", "MEM")],
        )
        .expect("put sections");

        let memory_id = expected_trajectory_section_id("MEM");
        let fetched = get_trajectory_sections_sync(
            &conn,
            "c1",
            &[memory_id.clone(), "s_0000000000000000".to_string()],
        )
        .expect("get sections");
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].section_id, memory_id);
        assert_eq!(fetched[0].slot, "memory");
        assert_eq!(fetched[0].content, "MEM");
        assert_eq!(fetched[0].bytes, 3);

        assert!(get_trajectory_sections_sync(&conn, "c1", &[])
            .expect("empty request")
            .is_empty());
    }

    #[test]
    fn section_reads_deduplicate_ids_and_reject_unbounded_requests() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        put_trajectory_sections_sync(&conn, "c1", &[section("base", "BASE")]).expect("put section");
        let id = expected_trajectory_section_id("BASE");
        let fetched =
            get_trajectory_sections_sync(&conn, "c1", &[id.clone(), id.clone(), "  ".to_string()])
                .expect("deduplicated read");
        assert_eq!(fetched.len(), 1);

        let too_many = (0..=TRAJECTORY_MAX_SECTION_REQUESTS)
            .map(|index| format!("s_{index:016x}"))
            .collect::<Vec<_>>();
        assert!(get_trajectory_sections_sync(&conn, "c1", &too_many).is_err());
    }

    #[test]
    fn an_empty_section_id_is_rejected() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        assert!(put_trajectory_sections_sync(
            &conn,
            "c1",
            &[TrajectorySectionInput {
                section_id: "  ".to_string(),
                slot: "base".to_string(),
                content: "X".to_string(),
            }],
        )
        .is_err());
    }

    #[test]
    fn an_oversized_section_is_skipped_rather_than_stored() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        let huge = "x".repeat(TRAJECTORY_MAX_SECTION_BYTES + 1);
        let stored = put_trajectory_sections_sync(&conn, "c1", &[section("base", &huge)])
            .expect("put oversized section");
        assert_eq!(stored, 0);
        let huge_id = expected_trajectory_section_id(&huge);
        assert!(get_trajectory_sections_sync(&conn, "c1", &[huge_id])
            .expect("get sections")
            .is_empty());
    }

    #[test]
    fn sections_are_scoped_per_conversation() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        seed_conversation(&conn, "c2", &[0]);
        put_trajectory_sections_sync(&conn, "c1", &[section("base", "ONE")]).expect("put c1");
        put_trajectory_sections_sync(&conn, "c2", &[section("base", "TWO")]).expect("put c2");

        let one_id = expected_trajectory_section_id("ONE");
        let two_id = expected_trajectory_section_id("TWO");
        assert!(get_trajectory_sections_sync(&conn, "c2", &[one_id])
            .expect("c1 section must not leak")
            .is_empty());
        let from_c2 = get_trajectory_sections_sync(&conn, "c2", &[two_id]).expect("get from c2");
        assert_eq!(from_c2[0].content, "TWO");
    }

    #[test]
    fn identical_content_can_be_reused_across_prompt_slots() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        let stored = put_trajectory_sections_sync(
            &conn,
            "c1",
            &[section("base", "SHARED"), section("memory", "SHARED")],
        )
        .expect("reuse content across slots");
        assert_eq!(stored, 1);
        let id = expected_trajectory_section_id("SHARED");
        let fetched =
            get_trajectory_sections_sync(&conn, "c1", &[id]).expect("read shared section");
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].content, "SHARED");
    }

    #[test]
    fn resolves_turn_from_user_count_across_all_segments() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0, 1]);
        conn.execute(
            "UPDATE chatHistorySegment SET messages_json = ?3, message_count = 3
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params![
                "c1",
                0,
                r#"[{"role":"user"},{"role":"assistant"},{"role":"user"}]"#
            ],
        )
        .expect("seed first messages");
        conn.execute(
            "UPDATE chatHistorySegment SET messages_json = ?3, message_count = 2
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params!["c1", 1, r#"[{"role":"assistant"},{"role":"user"}]"#],
        )
        .expect("seed second messages");
        assert_eq!(
            resolve_trajectory_turn_number_sync(&conn, "c1", false).unwrap(),
            4
        );
        assert_eq!(
            resolve_trajectory_turn_number_sync(&conn, "c1", true).unwrap(),
            3
        );
    }

    #[test]
    fn persisted_event_turn_keeps_future_turns_monotonic_after_a_fallback() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        conn.execute(
            "UPDATE chatHistorySegment SET messages_json = ?3, message_count = 3,
             trajectory_json = ?4 WHERE conversation_id = ?1 AND segment_index = ?2",
            params![
                "c1",
                0,
                r#"[{"role":"user"},{"role":"assistant"},{"role":"user"}]"#,
                r#"[{"k":"user","t":21,"at":10},{"k":"turn_end","t":21,"at":20}]"#
            ],
        )
        .expect("seed fallback trajectory turn");

        assert_eq!(
            resolve_trajectory_turn_number_sync(&conn, "c1", false).unwrap(),
            22
        );
    }

    #[test]
    fn malformed_messages_use_total_message_count_as_a_conservative_candidate() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        conn.execute(
            "UPDATE chatHistory SET total_message_count = 17 WHERE id = 'c1'",
            [],
        )
        .expect("seed total message count");
        conn.execute(
            "UPDATE chatHistorySegment SET messages_json = '{oops', message_count = 17
             WHERE conversation_id = 'c1' AND segment_index = 0",
            [],
        )
        .expect("seed malformed messages");

        assert_eq!(
            resolve_trajectory_turn_number_sync(&conn, "c1", false).unwrap(),
            18
        );
    }

    #[test]
    fn deleting_a_conversation_reclaims_its_sections_and_events() {
        let conn = open_trajectory_db();
        seed_conversation(&conn, "c1", &[0]);
        append_trajectory_events_sync(&conn, "c1", 0, r#"[{"k":"user","t":1,"at":10}]"#)
            .expect("append events");
        put_trajectory_sections_sync(&conn, "c1", &[section("base", "BASE")])
            .expect("put sections");

        conn.execute("DELETE FROM chatHistory WHERE id = 'c1'", [])
            .expect("delete conversation");

        let sections: i64 = conn
            .query_row("SELECT COUNT(*) FROM chatTrajectorySection", [], |row| {
                row.get(0)
            })
            .expect("count sections");
        assert_eq!(sections, 0);
        let segments: i64 = conn
            .query_row("SELECT COUNT(*) FROM chatHistorySegment", [], |row| {
                row.get(0)
            })
            .expect("count segments");
        assert_eq!(segments, 0);
    }
}
