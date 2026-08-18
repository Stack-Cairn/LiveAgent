const DEFAULT_TRAJECTORY_WINDOW_SEGMENTS: i64 = 8;
fn trajectory_user_event_needs_id(event: &Value) -> Option<i64> {
    let object = event.as_object()?;
    if object.get("k").and_then(Value::as_str) != Some("user") {
        return None;
    }
    if object
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty())
    {
        return None;
    }
    object
        .get("mi")
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|number| number as i64))
        })
        .filter(|index| *index >= 0)
}

/// Early trajectory builds persisted only the conversation-global message index (`mi`).
/// UI history refs use segment-local indexes, so matching those directly is incorrect after a
/// compaction. Resolve the legacy global index at the SQLite boundary and enrich the response with
/// the same stable message id used by normal history rendering.
fn backfill_legacy_trajectory_user_ids(
    conn: &Connection,
    conversation_id: &str,
    events: &mut [Value],
) -> Result<(), String> {
    let missing = events
        .iter()
        .filter_map(trajectory_user_event_needs_id)
        .collect::<std::collections::BTreeSet<_>>();
    if missing.is_empty() {
        return Ok(());
    }

    let mut stmt = conn
        .prepare(
            "SELECT segment_index, messages_json, message_count
             FROM chatHistorySegment
             WHERE conversation_id = ?1
             ORDER BY segment_index ASC",
        )
        .map_err(|e| format!("准备旧轨迹消息 id 回填查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![conversation_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| format!("查询旧轨迹消息 id 回填数据失败：{e}"))?;

    let mut resolved = HashMap::new();
    let mut global_start = 0_i64;
    for row in rows {
        let (segment_index, raw_messages, message_count) =
            row.map_err(|e| format!("读取旧轨迹消息 id 回填数据失败：{e}"))?;
        let count = message_count.max(0);
        let global_end = global_start.saturating_add(count);
        let needed = missing
            .range(global_start..global_end)
            .copied()
            .collect::<Vec<_>>();
        if !needed.is_empty() {
            // History corruption must not make the diagnostic endpoint fail wholesale. A segment
            // that cannot be parsed simply keeps its old mi-only event and remains structurally
            // readable through the ledger.
            if let Ok(messages) = parse_event_array(&raw_messages, "历史分段消息") {
                for global_index in needed {
                    let local_index =
                        usize::try_from(global_index - global_start).unwrap_or(usize::MAX);
                    let Some(message) = messages.get(local_index) else {
                        continue;
                    };
                    if message.get("role").and_then(Value::as_str) != Some("user") {
                        continue;
                    }
                    resolved.insert(
                        global_index,
                        history_message_stable_id(message, segment_index, local_index),
                    );
                }
            }
        }
        global_start = global_end;
    }

    for event in events {
        let Some(global_index) = trajectory_user_event_needs_id(event) else {
            continue;
        };
        let Some(message_id) = resolved.get(&global_index) else {
            continue;
        };
        if let Some(object) = event.as_object_mut() {
            object.insert("id".to_string(), Value::String(message_id.clone()));
        }
    }
    Ok(())
}

const MAX_TRAJECTORY_WINDOW_SEGMENTS: i64 = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryWindowResponse {
    pub conversation_id: String,
    pub events_json: String,
    pub oldest_segment_index: i64,
    pub returned_segment_count: i64,
    pub total_segment_count: i64,
    pub has_more_before: bool,
    pub truncated: bool,
}

fn load_trajectory_window_sync(
    conn: &Connection,
    conversation_id: &str,
    max_segments: i64,
    before_segment_index: Option<i64>,
) -> Result<TrajectoryWindowResponse, String> {
    let requested = if max_segments <= 0 {
        DEFAULT_TRAJECTORY_WINDOW_SEGMENTS
    } else {
        max_segments.min(MAX_TRAJECTORY_WINDOW_SEGMENTS)
    };
    let total_segment_count = conn
        .query_row(
            "SELECT COALESCE(MAX(segment_index) + 1, 0)
             FROM chatHistorySegment WHERE conversation_id = ?1",
            params![conversation_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("统计轨迹分段失败：{e}"))?;
    let end_exclusive = before_segment_index
        .unwrap_or(total_segment_count)
        .clamp(0, total_segment_count);
    let start_inclusive = end_exclusive.saturating_sub(requested);

    let mut stmt = conn
        .prepare(
            "SELECT segment_index, trajectory_json, trajectory_truncated
             FROM chatHistorySegment
             WHERE conversation_id = ?1
               AND segment_index >= ?2
               AND segment_index < ?3
             ORDER BY segment_index ASC",
        )
        .map_err(|e| format!("准备轨迹窗口查询失败：{e}"))?;
    let rows = stmt
        .query_map(
            params![conversation_id, start_inclusive, end_exclusive],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .map_err(|e| format!("查询轨迹窗口失败：{e}"))?;

    let mut events = Vec::new();
    let mut oldest_segment_index = end_exclusive;
    let mut returned_segment_count = 0_i64;
    let mut truncated = false;
    for row in rows {
        let (segment_index, raw, persisted_truncated) =
            row.map_err(|e| format!("读取轨迹窗口失败：{e}"))?;
        oldest_segment_index = oldest_segment_index.min(segment_index);
        returned_segment_count += 1;
        truncated |= persisted_truncated != 0;
        match parse_event_array(&raw, "轨迹窗口事件") {
            Ok(items) => events.extend(items),
            Err(_) => truncated = true,
        }
    }

    backfill_legacy_trajectory_user_ids(conn, conversation_id, &mut events)?;
    let events_json =
        serde_json::to_string(&events).map_err(|e| format!("序列化轨迹窗口失败：{e}"))?;
    Ok(TrajectoryWindowResponse {
        conversation_id: conversation_id.to_string(),
        events_json,
        oldest_segment_index,
        returned_segment_count,
        total_segment_count,
        has_more_before: returned_segment_count > 0 && oldest_segment_index > 0,
        truncated,
    })
}

pub(crate) async fn trajectory_get_window_inner(
    conversation_id: String,
    max_segments: i64,
    before_segment_index: Option<i64>,
) -> Result<TrajectoryWindowResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        load_trajectory_window_sync(&conn, &conversation_id, max_segments, before_segment_index)
    })
    .await
    .map_err(|e| format!("trajectory_get_window join 失败：{e}"))?
}

#[tauri::command]
pub async fn trajectory_get_window(
    conversation_id: String,
    max_segments: Option<i64>,
    before_segment_index: Option<i64>,
) -> Result<TrajectoryWindowResponse, String> {
    trajectory_get_window_inner(
        conversation_id,
        max_segments.unwrap_or(DEFAULT_TRAJECTORY_WINDOW_SEGMENTS),
        before_segment_index,
    )
    .await
}

#[cfg(test)]
mod trajectory_window_tests {
    use super::*;

    fn open_window_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory window database");
        history_db::initialize_connection(&conn).expect("initialize window schema");
        conn
    }

    fn seed_window_conversation(conn: &Connection, id: &str, segment_count: i64) {
        conn.execute(
            "INSERT INTO chatHistory
             (id, title, provider_id, model, context_meta_json, active_segment_index,
              total_segment_count, total_message_count, created_at, updated_at)
             VALUES (?1, 'T', 'codex', 'gpt-5', '{}', ?2, ?3, 0, 1, 1)",
            params![id, segment_count.saturating_sub(1), segment_count],
        )
        .expect("seed window conversation");
        for index in 0..segment_count {
            let events = serde_json::to_string(&vec![serde_json::json!({
                "k": "user",
                "t": index + 1,
                "at": index + 10,
            })])
            .expect("serialize seed trajectory");
            conn.execute(
                "INSERT INTO chatHistorySegment
                 (conversation_id, segment_index, segment_id, messages_json, message_count,
                  created_at, updated_at, trajectory_json)
                 VALUES (?1, ?2, ?3, '[]', 0, 1, 1, ?4)",
                params![id, index, format!("seg-{index}"), events],
            )
            .expect("seed window segment");
        }
    }

    fn event_turns(raw: &str) -> Vec<i64> {
        serde_json::from_str::<Vec<Value>>(raw)
            .expect("parse window events")
            .iter()
            .filter_map(|event| event.get("t").and_then(Value::as_i64))
            .collect()
    }

    #[test]
    fn reads_tail_and_earlier_pages_in_segment_order() {
        let conn = open_window_db();
        seed_window_conversation(&conn, "c1", 10);

        let tail = load_trajectory_window_sync(&conn, "c1", 3, None).expect("load tail");
        assert_eq!(event_turns(&tail.events_json), vec![8, 9, 10]);
        assert_eq!(tail.oldest_segment_index, 7);
        assert_eq!(tail.returned_segment_count, 3);
        assert_eq!(tail.total_segment_count, 10);
        assert!(tail.has_more_before);

        let earlier =
            load_trajectory_window_sync(&conn, "c1", 3, Some(7)).expect("load earlier page");
        assert_eq!(event_turns(&earlier.events_json), vec![5, 6, 7]);
        assert_eq!(earlier.oldest_segment_index, 4);
        assert!(earlier.has_more_before);

        let first = load_trajectory_window_sync(&conn, "c1", 8, Some(1)).expect("load first page");
        assert_eq!(event_turns(&first.events_json), vec![1]);
        assert_eq!(first.oldest_segment_index, 0);
        assert!(!first.has_more_before);
    }

    #[test]
    fn legacy_global_message_indexes_are_backfilled_with_stable_user_ids() {
        let conn = open_window_db();
        seed_window_conversation(&conn, "legacy", 2);
        conn.execute(
            "UPDATE chatHistorySegment
             SET messages_json = ?3, message_count = 2
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params![
                "legacy",
                0,
                serde_json::json!([
                    {"role":"user","id":"user-0","content":"old","timestamp":1},
                    {"role":"assistant","id":"assistant-1","content":[],"timestamp":2}
                ])
                .to_string()
            ],
        )
        .expect("write first legacy message segment");
        conn.execute(
            "UPDATE chatHistorySegment
             SET messages_json = ?3, message_count = 1, trajectory_json = ?4
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params![
                "legacy",
                1,
                serde_json::json!([
                    {"role":"user","id":"user-2","content":"new","timestamp":3}
                ])
                .to_string(),
                serde_json::json!([
                    {"k":"user","t":2,"at":10,"mi":2},
                    {"k":"turn_end","t":2,"at":20,"st":"complete"}
                ])
                .to_string()
            ],
        )
        .expect("write second legacy message segment");

        let loaded = load_trajectory_window_sync(&conn, "legacy", 1, None)
            .expect("load legacy trajectory window");
        let events = serde_json::from_str::<Vec<Value>>(&loaded.events_json)
            .expect("parse enriched trajectory events");
        assert_eq!(events[0].get("id").and_then(Value::as_str), Some("user-2"));
        assert_eq!(events[0].get("mi").and_then(Value::as_i64), Some(2));
    }

    #[test]
    fn corrupt_or_truncated_segments_mark_only_the_window_incomplete() {
        let conn = open_window_db();
        seed_window_conversation(&conn, "c1", 3);
        conn.execute(
            "UPDATE chatHistorySegment
             SET trajectory_json = '{oops', trajectory_truncated = 1
             WHERE conversation_id = 'c1' AND segment_index = 1",
            [],
        )
        .expect("corrupt middle window segment");

        let loaded = load_trajectory_window_sync(&conn, "c1", 3, None).expect("load window");
        assert_eq!(event_turns(&loaded.events_json), vec![1, 3]);
        assert!(loaded.truncated);
        assert_eq!(loaded.returned_segment_count, 3);
    }
}
