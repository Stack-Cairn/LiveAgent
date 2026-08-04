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
        selected_model_json: input.selected_model_json.clone(),
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

fn load_message_window_segments(
    conn: &Connection,
    conversation_id: &str,
    start_offset: i64,
    end_offset: i64,
) -> Result<(Vec<ChatHistorySegmentRecord>, i64), String> {
    if end_offset <= start_offset {
        return Ok((Vec::new(), start_offset.max(0)));
    }

    let mut metadata_stmt = conn
        .prepare(
            "
            SELECT segment_index, message_count
            FROM chatHistorySegment
            WHERE conversation_id = ?1
            ORDER BY segment_index ASC
            ",
        )
        .map_err(|e| format!("准备历史窗口分段元数据查询失败：{e}"))?;
    let metadata_rows = metadata_stmt
        .query_map(params![conversation_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("查询历史窗口分段元数据失败：{e}"))?;

    let mut first_segment_index = None;
    let mut last_segment_index = None;
    let mut first_segment_offset = 0_i64;
    let mut segment_start_offset = 0_i64;
    for row in metadata_rows {
        let (segment_index, message_count) =
            row.map_err(|e| format!("读取历史窗口分段元数据失败：{e}"))?;
        let segment_end_offset = segment_start_offset.saturating_add(message_count.max(0));
        if segment_end_offset > start_offset && segment_start_offset < end_offset {
            if first_segment_index.is_none() {
                first_segment_index = Some(segment_index);
                first_segment_offset = segment_start_offset;
            }
            last_segment_index = Some(segment_index);
        }
        segment_start_offset = segment_end_offset;
    }
    drop(metadata_stmt);

    let (Some(first_segment_index), Some(last_segment_index)) =
        (first_segment_index, last_segment_index)
    else {
        return Ok((Vec::new(), start_offset.max(0)));
    };
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
              AND segment_index BETWEEN ?2 AND ?3
            ORDER BY segment_index ASC
            ",
        )
        .map_err(|e| format!("准备历史窗口分段查询失败：{e}"))?;
    let rows = stmt
        .query_map(
            params![conversation_id, first_segment_index, last_segment_index],
            row_to_segment,
        )
        .map_err(|e| format!("查询历史窗口分段失败：{e}"))?;
    let mut segments = Vec::new();
    for row in rows {
        segments.push(row.map_err(|e| format!("读取历史窗口分段失败：{e}"))?);
    }
    Ok((segments, first_segment_offset))
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
    let selected_model_json = input
        .selected_model_json
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
            selected_model_json,
            context_meta_json,
            active_segment_index,
            total_segment_count,
            total_message_count,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            provider_id = excluded.provider_id,
            model = excluded.model,
            session_id = excluded.session_id,
            cwd = excluded.cwd,
            selected_model_json = COALESCE(excluded.selected_model_json, chatHistory.selected_model_json),
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
            selected_model_json,
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

fn set_chat_history_model_sync(
    conn: &Connection,
    id: &str,
    selected_model_json: &str,
) -> Result<ChatHistorySummary, String> {
    let chat_id = id.trim();
    if chat_id.is_empty() {
        return Err("历史对话 id 不能为空".to_string());
    }

    let payload = selected_model_json.trim();
    let parsed: serde_json::Value =
        serde_json::from_str(payload).map_err(|_| "会话模型选择格式无效".to_string())?;
    let has_non_empty = |key: &str| {
        parsed
            .get(key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    };
    if !has_non_empty("customProviderId") || !has_non_empty("model") {
        return Err("会话模型选择格式无效".to_string());
    }

    let affected = conn
        .execute(
            "
            UPDATE chatHistory
            SET selected_model_json = ?1
            WHERE id = ?2
            ",
            params![payload, chat_id],
        )
        .map_err(|e| format!("更新历史对话模型选择失败：{e}"))?;

    if affected == 0 {
        return Err("未找到对应的历史对话".to_string());
    }

    get_summary_by_id(conn, chat_id)
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
            SET title = ?1
            WHERE id = ?2
            ",
            params![next_title, chat_id],
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
