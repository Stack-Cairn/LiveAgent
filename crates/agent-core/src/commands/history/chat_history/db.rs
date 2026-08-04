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

