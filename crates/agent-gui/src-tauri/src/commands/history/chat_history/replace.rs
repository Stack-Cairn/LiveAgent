fn validate_replacement_user_message(replacement_message: &Value) -> Result<String, String> {
    let object = replacement_message
        .as_object()
        .ok_or_else(|| "replacement_message must be an object".to_string())?;
    let role = object
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if role != "user" {
        return Err("replacement_message role must be user".to_string());
    }
    history_message_id_for_ref(replacement_message)
        .ok_or_else(|| "replacement_message requires a non-empty stable id".to_string())
}

fn load_message_count_before_segment(
    conn: &Connection,
    conversation_id: &str,
    segment_index: i64,
) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(SUM(CASE WHEN message_count > 0 THEN message_count ELSE 0 END), 0) FROM chatHistorySegment WHERE conversation_id = ?1 AND segment_index < ?2",
        params![conversation_id, segment_index],
        |row| row.get(0),
    )
    .map_err(|e| format!("统计 edit-resend 前置历史消息失败：{e}"))
}

pub(crate) fn chat_history_replace_from_message_sync(
    conn: &mut Connection,
    id: &str,
    base_message_ref: &ChatHistoryMessageRef,
    replacement_message: &Value,
    max_messages: i64,
    expected_revision: &str,
) -> Result<ChatHistoryWindowRecord, String> {
    let chat_id = id.trim();
    if chat_id.is_empty() {
        return Err("历史对话 id 不能为空".to_string());
    }
    if max_messages <= 0 {
        return Err("历史窗口 maxMessages 必须大于 0".to_string());
    }
    if expected_revision.trim().is_empty() {
        return Err("expected_revision must not be empty".to_string());
    }
    validate_user_history_message_ref(base_message_ref)?;
    let replacement_message_id = validate_replacement_user_message(replacement_message)?;
    let mut replacement_message = replacement_message.clone();
    if let Some(object) = replacement_message.as_object_mut() {
        object.remove("liveAgentHistoryRef");
    }

    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 edit-resend 替换事务失败：{e}"))?;
    let record = get_record_by_id(&tx, chat_id)?;
    let current_revision = build_history_revision(
        &record.id,
        record.updated_at,
        record.active_segment_index,
        record.total_segment_count,
        record.total_message_count,
    );
    validate_expected_history_revision(Some(expected_revision), &current_revision)?;
    let source_segment = load_segment_by_index(&tx, chat_id, base_message_ref.segment_index)?;
    let location =
        locate_history_message_ref(std::slice::from_ref(&source_segment), base_message_ref)?;
    let mut target_messages = location.messages[..location.message_index].to_vec();
    target_messages.push(replacement_message.clone());

    let active_segment_index = source_segment.segment_index;
    let total_segment_count = active_segment_index.saturating_add(1);
    let total_message_count =
        load_message_count_before_segment(&tx, chat_id, active_segment_index)?
            .saturating_add(i64::try_from(target_messages.len()).unwrap_or(i64::MAX));
    let context_meta_json = patch_history_context_meta(
        &record.context_meta_json,
        active_segment_index,
        total_segment_count,
        total_message_count,
    );
    let updated_at = now_ms().max(record.updated_at.saturating_add(1));
    let target_updated_at = read_message_timestamp_with_fallback(&replacement_message, updated_at);
    let target_segment = ChatHistorySegmentInput {
        segment_index: active_segment_index,
        segment_id: source_segment.segment_id.clone(),
        summary_json: source_segment.summary_json.clone(),
        messages_json: serde_json::to_string(&target_messages)
            .map_err(|e| format!("序列化 edit-resend 替换分段失败：{e}"))?,
        message_count: i64::try_from(target_messages.len()).unwrap_or(i64::MAX),
        start_message_id: target_messages
            .first()
            .map(|message| history_message_stable_id(message, active_segment_index, 0)),
        end_message_id: Some(replacement_message_id),
        created_at: source_segment.created_at,
        updated_at: target_updated_at,
    };
    let conversation_input = ChatHistoryConversationInput {
        id: record.id.clone(),
        title: record.title.clone(),
        provider_id: record.provider_id.clone(),
        model: record.model.clone(),
        session_id: record.session_id.clone(),
        cwd: record.cwd.clone(),
        selected_model_json: record.selected_model_json.clone(),
        context_meta_json,
        active_segment_index,
        total_segment_count,
        total_message_count,
        created_at: Some(record.created_at),
        updated_at,
    };

    delete_chat_history_fts_from_segment(&tx, chat_id, active_segment_index)?;
    tx.execute(
        "DELETE FROM chatHistorySegment WHERE conversation_id = ?1 AND segment_index > ?2",
        params![chat_id, active_segment_index],
    )
    .map_err(|e| format!("删除 edit-resend 后续历史分段失败：{e}"))?;
    upsert_chat_history_header(&tx, &conversation_input)?;
    upsert_single_segment(&tx, chat_id, &target_segment)?;
    verify_chat_history_consistency(&tx, chat_id)?;

    let updated_record = get_record_by_id(&tx, chat_id)?;
    let result =
        build_chat_history_window_record(&tx, &updated_record, max_messages, None, None, true)?;

    tx.commit()
        .map_err(|e| format!("提交 edit-resend 替换事务失败：{e}"))?;
    Ok(result)
}

pub(crate) async fn chat_history_replace_from_message_inner(
    id: String,
    base_message_ref: ChatHistoryMessageRef,
    replacement_message: Value,
    max_messages: i64,
    expected_revision: String,
) -> Result<ChatHistoryWindowRecord, String> {
    crate::compat::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        chat_history_replace_from_message_sync(
            &mut conn,
            &id,
            &base_message_ref,
            &replacement_message,
            max_messages,
            &expected_revision,
        )
    })
    .await
    .map_err(|e| format!("chat_history_replace_from_message join 失败：{e}"))?
}

pub async fn chat_history_replace_from_message(
    id: String,
    base_message_ref: ChatHistoryMessageRef,
    replacement_message: Value,
    max_messages: i64,
    expected_revision: String,
    gateway_controller: &Arc<GatewayController>,
) -> Result<ChatHistoryWindowRecord, String> {
    let result = chat_history_replace_from_message_inner(
        id,
        base_message_ref,
        replacement_message,
        max_messages,
        expected_revision,
    )
    .await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&result.conversation))
        .await;
    Ok(result)
}
