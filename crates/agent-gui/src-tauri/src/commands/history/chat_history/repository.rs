fn read_goal_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<ChatHistoryGoalSummary>> {
    let context_meta_json: Option<String> = row.get("context_meta_json")?;
    let Some(context_meta_json) = context_meta_json else {
        return Ok(None);
    };
    let Ok(context_meta) = serde_json::from_str::<Value>(&context_meta_json) else {
        return Ok(None);
    };
    let Some(goal) = context_meta.get("goal") else {
        return Ok(None);
    };
    Ok(serde_json::from_value(goal.clone()).ok())
}

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatHistorySummary> {
    Ok(ChatHistorySummary {
        id: row.get("id")?,
        title: row.get("title")?,
        provider_id: row.get("provider_id")?,
        model: row.get("model")?,
        session_id: row.get("session_id")?,
        cwd: row.get("cwd")?,
        selected_model_json: row.get("selected_model_json")?,
        goal: read_goal_summary(row)?,
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
        selected_model_json: row.get("selected_model_json")?,
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
            h.selected_model_json AS selected_model_json,
            h.context_meta_json AS context_meta_json,
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
            h.selected_model_json AS selected_model_json,
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
                h.selected_model_json AS selected_model_json,
                h.context_meta_json AS context_meta_json,
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
                h.selected_model_json AS selected_model_json,
                h.context_meta_json AS context_meta_json,
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
