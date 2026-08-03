#[tauri::command]
pub async fn chat_history_list(
    page: i64,
    page_size: i64,
    cwd: Option<String>,
    cwd_empty: Option<bool>,
) -> Result<ChatHistoryListResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        list_chat_history_sync_with_filter(
            &conn,
            page,
            page_size,
            ChatHistoryListFilter {
                cwd,
                cwd_empty: cwd_empty.unwrap_or(false),
            },
        )
    })
    .await
    .map_err(|e| format!("chat_history_list join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_workdirs() -> Result<ChatHistoryWorkdirsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        list_chat_history_workdirs_sync(&conn)
    })
    .await
    .map_err(|e| format!("chat_history_workdirs join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_shared_list(
    page: i64,
    page_size: i64,
) -> Result<ChatHistoryListResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_shared_chat_history_page_sync(page, page_size)
    })
    .await
    .map_err(|e| format!("chat_history_shared_list join failed: {e}"))?
}

#[tauri::command]
pub async fn chat_history_search(
    args: ChatHistorySearchArgs,
) -> Result<ChatHistorySearchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || search_chat_history_sync(args))
        .await
        .map_err(|e| format!("chat_history_search join 失败：{e}"))?
}

pub(crate) async fn chat_history_get_summary_inner(
    id: String,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        get_summary_by_id(&conn, &id)
    })
    .await
    .map_err(|e| format!("chat_history_get_summary join 失败：{e}"))?
}

// 桌面前端已迁移到窗口化的 chat_history_get_window；全量读取仅剩
// gateway_bridge 的服务端投影在用，因此不再作为 webview command 暴露。
pub async fn chat_history_get(id: String) -> Result<ChatHistoryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chat_id = id.trim().to_string();
        if chat_id.is_empty() {
            return Err("历史对话 id 不能为空".to_string());
        }

        let conn = open_db()?;
        let mut record = get_record_by_id(&conn, &chat_id)?;
        record.segments = load_segments(&conn, &record.id)?;
        if record.segments.is_empty() {
            return Err("历史对话缺少分段数据".to_string());
        }

        Ok(record)
    })
    .await
    .map_err(|e| format!("chat_history_get join 失败：{e}"))?
}

pub(crate) async fn chat_history_get_tail(
    id: String,
    max_messages: i64,
) -> Result<ChatHistoryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chat_id = id.trim().to_string();
        if chat_id.is_empty() {
            return Err("历史对话 id 不能为空".to_string());
        }

        let conn = open_db()?;
        let mut record = get_record_by_id(&conn, &chat_id)?;
        record.segments = load_tail_segments(&conn, &record.id, max_messages)?;
        if record.segments.is_empty() {
            return Err("历史对话缺少分段数据".to_string());
        }

        Ok(record)
    })
    .await
    .map_err(|e| format!("chat_history_get_tail join 失败：{e}"))?
}

pub(crate) fn build_chat_history_window_record(
    conn: &Connection,
    record: &ChatHistoryRecord,
    max_messages: i64,
    before_offset: Option<i64>,
    expected_revision: Option<&str>,
    include_active_segment: bool,
) -> Result<ChatHistoryWindowRecord, String> {
    let chat_id = record.id.trim();
    if chat_id.is_empty() {
        return Err("历史对话 id 不能为空".to_string());
    }
    if max_messages <= 0 {
        return Err("历史窗口 maxMessages 必须大于 0".to_string());
    }

    let revision = build_history_revision(
        &record.id,
        record.updated_at,
        record.active_segment_index,
        record.total_segment_count,
        record.total_message_count,
    );
    validate_expected_history_revision(expected_revision, &revision)?;

    let end_offset = before_offset
        .unwrap_or(record.total_message_count)
        .clamp(0, record.total_message_count);
    let requested_oldest_offset = end_offset.saturating_sub(max_messages).max(0);
    let (segments, first_segment_offset) =
        load_message_window_segments(conn, &record.id, requested_oldest_offset, end_offset)?;
    if end_offset > requested_oldest_offset && segments.is_empty() {
        return Err("历史窗口未找到对应的分段数据".to_string());
    }
    let relative_end_offset = end_offset.saturating_sub(first_segment_offset);
    let window =
        build_history_message_window(&segments, max_messages, Some(relative_end_offset), true)?;
    let oldest_offset = first_segment_offset.saturating_add(window.oldest_offset);
    if oldest_offset > requested_oldest_offset
        || first_segment_offset.saturating_add(window.end_offset) != end_offset
        || window.returned_message_count != end_offset.saturating_sub(oldest_offset)
    {
        return Err("历史窗口消息统计与权威 offset 不一致".to_string());
    }
    let segment_windows = serialize_history_segment_windows(&window)?;
    let conversation = get_summary_by_id(conn, &record.id)?;
    let active_segment = if include_active_segment {
        Some(load_segment_by_index(
            conn,
            &record.id,
            record.active_segment_index,
        )?)
    } else {
        None
    };

    Ok(ChatHistoryWindowRecord {
        conversation,
        segments: segment_windows,
        active_segment,
        context_meta_json: record.context_meta_json.clone(),
        active_segment_index: record.active_segment_index,
        total_segment_count: record.total_segment_count,
        total_message_count: record.total_message_count,
        returned_message_count: window.returned_message_count,
        oldest_offset,
        has_more_before: oldest_offset > 0,
        revision,
        updated_at: record.updated_at,
    })
}

pub(crate) fn chat_history_get_window_sync(
    conn: &mut Connection,
    id: &str,
    max_messages: i64,
    before_offset: Option<i64>,
    expected_revision: Option<&str>,
    include_active_segment: bool,
) -> Result<ChatHistoryWindowRecord, String> {
    let chat_id = id.trim();
    if chat_id.is_empty() {
        return Err("历史对话 id 不能为空".to_string());
    }

    let tx = conn
        .transaction()
        .map_err(|e| format!("开启历史窗口读取事务失败：{e}"))?;
    let record = get_record_by_id(&tx, chat_id)?;
    let result = build_chat_history_window_record(
        &tx,
        &record,
        max_messages,
        before_offset,
        expected_revision,
        include_active_segment,
    )?;
    tx.commit()
        .map_err(|e| format!("提交历史窗口读取事务失败：{e}"))?;
    Ok(result)
}

#[tauri::command]
pub async fn chat_history_get_window(
    id: String,
    max_messages: i64,
    before_offset: Option<i64>,
    expected_revision: Option<String>,
    include_active_segment: bool,
) -> Result<ChatHistoryWindowRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        chat_history_get_window_sync(
            &mut conn,
            &id,
            max_messages,
            before_offset,
            expected_revision.as_deref(),
            include_active_segment,
        )
    })
    .await
    .map_err(|e| format!("chat_history_get_window join 失败：{e}"))?
}

pub(crate) async fn chat_history_upsert_inner(
    input: ChatHistoryUpsertInput,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_upsert_input(&input)?;
        let conversation = ChatHistoryConversationInput {
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
        };

        let mut conn = open_db()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启聊天历史事务失败：{e}"))?;
        upsert_chat_history_header(&tx, &conversation)?;

        sync_segments(
            &tx,
            input.id.trim(),
            &input.segments,
            input.total_segment_count,
        )?;
        verify_chat_history_consistency(&tx, input.id.trim())?;

        tx.commit()
            .map_err(|e| format!("提交聊天历史事务失败：{e}"))?;

        get_summary_by_id(&conn, input.id.trim())
    })
    .await
    .map_err(|e| format!("chat_history_upsert join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_upsert(
    input: ChatHistoryUpsertInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_upsert_inner(input).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_upsert_active_segment_inner(
    input: ChatHistorySegmentMutationInput,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_segment_mutation_input(&input)?;
        let mut conn = open_db()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启 active segment 事务失败：{e}"))?;

        upsert_chat_history_header(&tx, &input.conversation)?;
        upsert_single_segment(&tx, input.conversation.id.trim(), &input.segment)?;
        verify_chat_history_consistency(&tx, input.conversation.id.trim())?;

        tx.commit()
            .map_err(|e| format!("提交 active segment 事务失败：{e}"))?;

        get_summary_by_id(&conn, input.conversation.id.trim())
    })
    .await
    .map_err(|e| format!("chat_history_upsert_active_segment join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_upsert_active_segment(
    input: ChatHistorySegmentMutationInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_upsert_active_segment_inner(input).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_append_segment_inner(
    input: ChatHistorySegmentMutationInput,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_segment_mutation_input(&input)?;
        let mut conn = open_db()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启 append segment 事务失败：{e}"))?;

        validate_append_segment_preconditions(&tx, &input)?;
        upsert_chat_history_header(&tx, &input.conversation)?;
        insert_single_segment(&tx, input.conversation.id.trim(), &input.segment)?;
        verify_chat_history_consistency(&tx, input.conversation.id.trim())?;

        tx.commit()
            .map_err(|e| format!("提交 append segment 事务失败：{e}"))?;

        get_summary_by_id(&conn, input.conversation.id.trim())
    })
    .await
    .map_err(|e| format!("chat_history_append_segment join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_append_segment(
    input: ChatHistorySegmentMutationInput,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_append_segment_inner(input).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_rename_inner(
    id: String,
    title: String,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        rename_chat_history_sync(&conn, &id, &title)
    })
    .await
    .map_err(|e| format!("chat_history_rename join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_rename(
    id: String,
    title: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_rename_inner(id, title).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_set_pinned_inner(
    id: String,
    is_pinned: bool,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        set_chat_history_pinned_sync(&conn, &id, is_pinned)
    })
    .await
    .map_err(|e| format!("chat_history_set_pinned join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_set_pinned(
    id: String,
    is_pinned: bool,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_set_pinned_inner(id, is_pinned).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_set_model_inner(
    id: String,
    selected_model_json: String,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        set_chat_history_model_sync(&conn, &id, &selected_model_json)
    })
    .await
    .map_err(|e| format!("chat_history_set_model join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_set_model(
    id: String,
    selected_model_json: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_set_model_inner(id, selected_model_json).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_set_skills_inner(
    id: String,
    skill_preset_id: String,
    skills_disabled: bool,
) -> Result<ChatHistorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        set_chat_history_skills_sync(&conn, &id, &skill_preset_id, skills_disabled)
    })
    .await
    .map_err(|e| format!("chat_history_set_skills join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_set_skills(
    id: String,
    skill_preset_id: String,
    skills_disabled: bool,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_set_skills_inner(id, skill_preset_id, skills_disabled).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}

pub(crate) async fn chat_history_share_get_inner(
    id: String,
) -> Result<ChatHistoryShareStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        get_chat_history_share_status_sync(&conn, &id)
    })
    .await
    .map_err(|e| format!("chat_history_share_get join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_share_get(id: String) -> Result<ChatHistoryShareStatus, String> {
    chat_history_share_get_inner(id).await
}

pub(crate) async fn chat_history_share_set_inner(
    id: String,
    enabled: bool,
    redact_tool_content: Option<bool>,
) -> Result<ChatHistoryShareStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        set_chat_history_share_enabled_sync(&conn, &id, enabled, redact_tool_content)
    })
    .await
    .map_err(|e| format!("chat_history_share_set join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_share_set(
    id: String,
    enabled: bool,
    redact_tool_content: Option<bool>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<ChatHistoryShareStatus, String> {
    let status = chat_history_share_set_inner(id, enabled, redact_tool_content).await?;
    match chat_history_get_summary_inner(status.conversation_id.clone()).await {
        Ok(summary) => {
            gateway_controller
                .publish_history_sync(build_history_sync_upsert(&summary))
                .await;
        }
        Err(error) => eprintln!("publish history share sync event failed: {error}"),
    }
    Ok(status)
}

pub(crate) async fn chat_history_share_resolve_inner(
    token: String,
) -> Result<ChatHistoryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        resolve_chat_history_share_sync(&conn, &token)
    })
    .await
    .map_err(|e| format!("chat_history_share_resolve join 失败：{e}"))?
}
