use std::collections::HashSet as TrajectoryHashSet;

#[derive(Debug)]
struct StoredTrajectorySegment {
    segment_index: i64,
    events: Vec<Value>,
    truncated: bool,
}

fn trajectory_event_kind(event: &Value) -> Option<&str> {
    event
        .as_object()
        .and_then(|object| object.get("k"))
        .and_then(Value::as_str)
}


fn trajectory_section_refs(events: &[Value]) -> TrajectoryHashSet<String> {
    let mut refs = TrajectoryHashSet::new();
    for event in events {
        if trajectory_event_kind(event) != Some("header") {
            continue;
        }
        let Some(sections) = event
            .as_object()
            .and_then(|object| object.get("sec"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for section_id in sections.iter().filter_map(Value::as_str) {
            if !section_id.trim().is_empty() {
                refs.insert(section_id.to_string());
            }
        }
    }
    refs
}

fn load_stored_trajectory_segments(
    conn: &Connection,
    conversation_id: &str,
    segment_count: i64,
) -> Result<Vec<StoredTrajectorySegment>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT segment_index, trajectory_json, trajectory_truncated
             FROM chatHistorySegment
             WHERE conversation_id = ?1 AND segment_index < ?2
             ORDER BY segment_index ASC",
        )
        .map_err(|e| format!("准备轨迹生命周期查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![conversation_id, segment_count], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| format!("查询轨迹生命周期数据失败：{e}"))?;

    let mut segments = Vec::new();
    for row in rows {
        let (segment_index, raw, persisted_truncated) =
            row.map_err(|e| format!("读取轨迹生命周期数据失败：{e}"))?;
        let (events, parse_truncated) = match parse_event_array(&raw, "轨迹生命周期事件") {
            Ok(events) => (events, false),
            Err(_) => (Vec::new(), true),
        };
        segments.push(StoredTrajectorySegment {
            segment_index,
            events,
            truncated: persisted_truncated != 0 || parse_truncated,
        });
    }
    Ok(segments)
}

/// Keep everything before the first user event outside the retained message prefix.
fn retain_trajectory_prefix(
    mut segments: Vec<StoredTrajectorySegment>,
    _cutoff_message_index: i64,
    retained_user_turns: usize,
) -> Vec<StoredTrajectorySegment> {
    let mut seen_users = 0_usize;
    let mut stopped = false;
    for segment in &mut segments {
        if stopped {
            segment.events.clear();
            continue;
        }
        let mut retained = Vec::with_capacity(segment.events.len());
        for event in segment.events.drain(..) {
            if trajectory_event_kind(&event) == Some("user") {
                // The retained user count is computed from the authoritative message position.
                // Do not compare event `mi` with HistoryMessageRef.messageIndex: the former is
                // conversation-global and the latter segment-local after compaction.
                let outside_by_order = seen_users >= retained_user_turns;
                if outside_by_order {
                    stopped = true;
                    break;
                }
                seen_users += 1;
            }
            retained.push(event);
        }
        segment.events = retained;
    }
    segments
}

fn write_stored_trajectory_segments(
    conn: &Connection,
    conversation_id: &str,
    segments: &[StoredTrajectorySegment],
) -> Result<(), String> {
    for segment in segments {
        let events_json = serde_json::to_string(&segment.events)
            .map_err(|e| format!("序列化生命周期轨迹失败：{e}"))?;
        conn.execute(
            "UPDATE chatHistorySegment
             SET trajectory_json = ?3, trajectory_truncated = ?4
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params![
                conversation_id,
                segment.segment_index,
                events_json,
                i64::from(segment.truncated)
            ],
        )
        .map_err(|e| format!("写入生命周期轨迹失败：{e}"))?;
    }
    Ok(())
}

fn all_trajectory_section_refs(segments: &[StoredTrajectorySegment]) -> TrajectoryHashSet<String> {
    let mut refs = TrajectoryHashSet::new();
    for segment in segments {
        refs.extend(trajectory_section_refs(&segment.events));
    }
    refs
}

fn copy_referenced_trajectory_sections(
    conn: &Connection,
    source_id: &str,
    destination_id: &str,
    section_ids: &TrajectoryHashSet<String>,
) -> Result<(), String> {
    for section_id in section_ids {
        conn.execute(
            "INSERT INTO chatTrajectorySection
             (conversation_id, section_id, slot, content, bytes, created_at)
             SELECT ?2, section_id, slot, content, bytes, created_at
             FROM chatTrajectorySection
             WHERE conversation_id = ?1 AND section_id = ?3
             ON CONFLICT(conversation_id, section_id) DO NOTHING",
            params![source_id, destination_id, section_id],
        )
        .map_err(|e| format!("复制分支轨迹分段失败：{e}"))?;
    }
    Ok(())
}

fn prune_unreferenced_trajectory_sections(
    conn: &Connection,
    conversation_id: &str,
    referenced: &TrajectoryHashSet<String>,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT section_id FROM chatTrajectorySection
             WHERE conversation_id = ?1",
        )
        .map_err(|e| format!("准备清理轨迹分段查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![conversation_id], |row| row.get::<_, String>(0))
        .map_err(|e| format!("查询待清理轨迹分段失败：{e}"))?;
    let mut stale = Vec::new();
    for row in rows {
        let section_id = row.map_err(|e| format!("读取待清理轨迹分段失败：{e}"))?;
        if !referenced.contains(&section_id) {
            stale.push(section_id);
        }
    }
    drop(stmt);
    for section_id in stale {
        conn.execute(
            "DELETE FROM chatTrajectorySection
             WHERE conversation_id = ?1 AND section_id = ?2",
            params![conversation_id, section_id],
        )
        .map_err(|e| format!("清理未引用轨迹分段失败：{e}"))?;
    }
    Ok(())
}

fn count_user_messages(values: &[Value]) -> usize {
    values
        .iter()
        .filter(|message| branch_message_role_is_user(message))
        .count()
}

fn count_user_messages_in_segment_inputs(
    segments: &[ChatHistorySegmentInput],
) -> Result<usize, String> {
    let mut total = 0_usize;
    for segment in segments {
        let messages = parse_event_array(&segment.messages_json, "历史分段消息")?;
        total = total.saturating_add(count_user_messages(&messages));
    }
    Ok(total)
}

fn count_user_messages_before_position(
    conn: &Connection,
    conversation_id: &str,
    segment_index: i64,
    message_index: usize,
) -> Result<usize, String> {
    let segments = load_segments(conn, conversation_id)?;
    let mut total = 0_usize;
    for segment in segments {
        if segment.segment_index > segment_index {
            break;
        }
        let messages = parse_branch_segment_messages(&segment)?;
        let slice = if segment.segment_index == segment_index {
            &messages[..message_index.min(messages.len())]
        } else {
            &messages[..]
        };
        total = total.saturating_add(count_user_messages(slice));
    }
    Ok(total)
}

pub(crate) fn copy_branch_trajectory_prefix(
    conn: &Connection,
    source_id: &str,
    destination_id: &str,
    destination_segment_count: i64,
    cutoff_message_index: i64,
    retained_user_turns: usize,
) -> Result<(), String> {
    let source = load_stored_trajectory_segments(conn, source_id, destination_segment_count)?;
    let retained = retain_trajectory_prefix(source, cutoff_message_index, retained_user_turns);
    write_stored_trajectory_segments(conn, destination_id, &retained)?;
    copy_referenced_trajectory_sections(
        conn,
        source_id,
        destination_id,
        &all_trajectory_section_refs(&retained),
    )
}

pub(crate) fn truncate_conversation_trajectory_prefix(
    conn: &Connection,
    conversation_id: &str,
    segment_count: i64,
    cutoff_message_index: i64,
    retained_user_turns: usize,
) -> Result<(), String> {
    let stored = load_stored_trajectory_segments(conn, conversation_id, segment_count)?;
    let retained = retain_trajectory_prefix(stored, cutoff_message_index, retained_user_turns);
    write_stored_trajectory_segments(conn, conversation_id, &retained)?;
    prune_unreferenced_trajectory_sections(
        conn,
        conversation_id,
        &all_trajectory_section_refs(&retained),
    )
}

#[cfg(test)]
mod trajectory_lifecycle_tests {
    use super::*;

    fn open_lifecycle_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory lifecycle database");
        history_db::initialize_connection(&conn).expect("initialize lifecycle schema");
        conn
    }

    fn seed_lifecycle_conversation(conn: &Connection, id: &str, segment_count: i64) {
        conn.execute(
            "INSERT INTO chatHistory
             (id, title, provider_id, model, context_meta_json, active_segment_index,
              total_segment_count, total_message_count, created_at, updated_at)
             VALUES (?1, 'T', 'codex', 'gpt-5', '{}', ?2, ?3, 0, 1, 1)",
            params![id, segment_count.saturating_sub(1), segment_count],
        )
        .expect("seed lifecycle conversation");
        for index in 0..segment_count {
            conn.execute(
                "INSERT INTO chatHistorySegment
                 (conversation_id, segment_index, segment_id, messages_json, message_count,
                  created_at, updated_at)
                 VALUES (?1, ?2, ?3, '[]', 0, 1, 1)",
                params![id, index, format!("seg-{index}")],
            )
            .expect("seed lifecycle segment");
        }
    }

    fn write_events(
        conn: &Connection,
        conversation_id: &str,
        segment_index: i64,
        events: &[Value],
        truncated: bool,
    ) {
        conn.execute(
            "UPDATE chatHistorySegment
             SET trajectory_json = ?3, trajectory_truncated = ?4
             WHERE conversation_id = ?1 AND segment_index = ?2",
            params![
                conversation_id,
                segment_index,
                serde_json::to_string(events).expect("serialize lifecycle events"),
                i64::from(truncated)
            ],
        )
        .expect("write lifecycle events");
    }

    fn insert_section(conn: &Connection, conversation_id: &str, section_id: &str) {
        conn.execute(
            "INSERT INTO chatTrajectorySection
             (conversation_id, section_id, slot, content, bytes, created_at)
             VALUES (?1, ?2, 'base', ?2, length(?2), 1)",
            params![conversation_id, section_id],
        )
        .expect("insert lifecycle section");
    }

    fn segment_events(conn: &Connection, conversation_id: &str, segment_index: i64) -> Vec<Value> {
        let raw: String = conn
            .query_row(
                "SELECT trajectory_json FROM chatHistorySegment
                 WHERE conversation_id = ?1 AND segment_index = ?2",
                params![conversation_id, segment_index],
                |row| row.get(0),
            )
            .expect("read lifecycle trajectory");
        serde_json::from_str(&raw).expect("parse lifecycle trajectory")
    }

    fn section_ids(conn: &Connection, conversation_id: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT section_id FROM chatTrajectorySection
                 WHERE conversation_id = ?1 ORDER BY section_id",
            )
            .expect("prepare lifecycle sections");
        stmt.query_map(params![conversation_id], |row| row.get::<_, String>(0))
            .expect("query lifecycle sections")
            .map(|row| row.expect("read lifecycle section"))
            .collect()
    }

    fn prefix_fixture() -> Vec<StoredTrajectorySegment> {
        vec![
            StoredTrajectorySegment {
                segment_index: 0,
                events: vec![
                    serde_json::json!({"k":"header","hid":"h1","sec":["s_keep"]}),
                    serde_json::json!({"k":"user","t":1,"mi":0}),
                    serde_json::json!({"k":"turn_end","t":1}),
                ],
                truncated: true,
            },
            StoredTrajectorySegment {
                segment_index: 1,
                events: vec![
                    serde_json::json!({"k":"user","t":2,"mi":2}),
                    serde_json::json!({"k":"header","hid":"h2","sec":["s_drop"]}),
                    serde_json::json!({"k":"step_start","t":2,"s":1}),
                ],
                truncated: false,
            },
        ]
    }

    #[test]
    fn prefix_retention_stops_before_the_first_removed_user() {
        let retained = retain_trajectory_prefix(prefix_fixture(), 2, 1);
        assert_eq!(retained[0].events.len(), 3);
        assert!(retained[0].truncated);
        assert!(retained[1].events.is_empty());
    }

    #[test]
    fn prefix_retention_uses_authoritative_user_order_not_mismatched_message_indexes() {
        let fixture = vec![StoredTrajectorySegment {
            segment_index: 0,
            events: vec![
                serde_json::json!({"k":"user","t":40,"mi":800}),
                serde_json::json!({"k":"turn_end","t":40}),
                serde_json::json!({"k":"user","t":41,"mi":802}),
            ],
            truncated: false,
        }];
        // A segment-local cutoff of 2 must not discard the first globally-indexed user (mi=800).
        let retained = retain_trajectory_prefix(fixture, 2, 1);
        assert_eq!(retained[0].events.len(), 2);
        assert_eq!(trajectory_event_kind(&retained[0].events[0]), Some("user"));
    }

    #[test]
    fn edit_resend_truncates_events_and_prunes_unreferenced_sections() {
        let conn = open_lifecycle_db();
        seed_lifecycle_conversation(&conn, "c1", 2);
        let fixture = prefix_fixture();
        for segment in &fixture {
            write_events(
                &conn,
                "c1",
                segment.segment_index,
                &segment.events,
                segment.truncated,
            );
        }
        insert_section(&conn, "c1", "s_keep");
        insert_section(&conn, "c1", "s_drop");

        truncate_conversation_trajectory_prefix(&conn, "c1", 2, 2, 1)
            .expect("truncate lifecycle prefix");

        assert_eq!(segment_events(&conn, "c1", 0).len(), 3);
        assert!(segment_events(&conn, "c1", 1).is_empty());
        assert_eq!(section_ids(&conn, "c1"), vec!["s_keep"]);
    }

    #[test]
    fn branch_copies_only_the_retained_events_and_sections() {
        let conn = open_lifecycle_db();
        seed_lifecycle_conversation(&conn, "source", 2);
        seed_lifecycle_conversation(&conn, "branch", 2);
        let fixture = prefix_fixture();
        for segment in &fixture {
            write_events(
                &conn,
                "source",
                segment.segment_index,
                &segment.events,
                segment.truncated,
            );
        }
        insert_section(&conn, "source", "s_keep");
        insert_section(&conn, "source", "s_drop");

        copy_branch_trajectory_prefix(&conn, "source", "branch", 2, 2, 1)
            .expect("copy branch lifecycle prefix");

        assert_eq!(segment_events(&conn, "branch", 0).len(), 3);
        assert!(segment_events(&conn, "branch", 1).is_empty());
        assert_eq!(section_ids(&conn, "branch"), vec!["s_keep"]);
        let branch_truncated: i64 = conn
            .query_row(
                "SELECT trajectory_truncated FROM chatHistorySegment
                 WHERE conversation_id = 'branch' AND segment_index = 0",
                [],
                |row| row.get(0),
            )
            .expect("read copied truncated marker");
        assert_eq!(branch_truncated, 1);
    }
}
