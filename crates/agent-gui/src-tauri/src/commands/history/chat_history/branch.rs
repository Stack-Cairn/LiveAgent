// 分支会话：从源会话按锚点（用户消息）截取前缀——含该轮完整的助手回复——
// 复制为一条全新会话。所有写入都在同一个 SQLite 事务内完成。

/// Must match BRANCH_CONVERSATION_DEFAULT_TITLE in agent-gui src/lib/chat/page/chatPageHelpers.ts.
pub(crate) const BRANCH_DEFAULT_TITLE: &str = "新分支";

fn parse_branch_segment_messages(segment: &ChatHistorySegmentRecord) -> Result<Vec<Value>, String> {
    let parsed = serde_json::from_str::<Value>(&segment.messages_json)
        .map_err(|e| format!("解析历史分段 {} 失败：{e}", segment.segment_id))?;
    parsed
        .as_array()
        .cloned()
        .ok_or_else(|| format!("历史分段 {} 的消息不是数组", segment.segment_id))
}

fn branch_message_role_is_user(message: &Value) -> bool {
    message
        .as_object()
        .and_then(|object| object.get("role"))
        .and_then(Value::as_str)
        .map(str::trim)
        == Some("user")
}

/// 镜像前端 normalizeSegment（conversationState.ts）：裁剪后重算
/// message_count/start/end/updated_at，保留 segment_id、summary_json、created_at。
/// start/end 的 stable id 与前端 getMessageStableId 同构（history_message_stable_id）。
fn build_branch_sliced_segment(
    record: &ChatHistorySegmentRecord,
    kept_messages: &[Value],
    new_segment_index: i64,
) -> Result<ChatHistorySegmentInput, String> {
    let last_index = kept_messages.len().saturating_sub(1);
    let start_message_id = kept_messages
        .first()
        .map(|message| history_message_stable_id(message, new_segment_index, 0));
    let end_message_id = kept_messages
        .last()
        .map(|message| history_message_stable_id(message, new_segment_index, last_index));
    let updated_at = kept_messages
        .last()
        .map(read_message_timestamp)
        .unwrap_or(record.updated_at);
    let messages_json =
        serde_json::to_string(kept_messages).map_err(|e| format!("序列化分支分段消息失败：{e}"))?;

    Ok(ChatHistorySegmentInput {
        segment_index: new_segment_index,
        segment_id: record.segment_id.clone(),
        summary_json: record.summary_json.clone(),
        messages_json,
        message_count: i64::try_from(kept_messages.len()).unwrap_or(i64::MAX),
        start_message_id,
        end_message_id,
        created_at: record.created_at,
        updated_at,
    })
}

/// 从锚点用户消息开始向前扫描下一条 role=="user" 的消息作为独占切点，
/// 返回复制到新会话的分段列表（已按 0..n-1 重编号）与消息总数。
pub(crate) fn build_branch_segments(
    segments: &[ChatHistorySegmentRecord],
    anchor: &ChatHistoryMessageRef,
) -> Result<(Vec<ChatHistorySegmentInput>, i64), String> {
    let location = locate_history_message_ref(segments, anchor)
        .map_err(|error| format!("未找到匹配的分支锚点消息：{error}"))?;
    let anchor_segment_pos = location.segment_position;
    let anchor_messages = location.messages;
    let anchor_position = location.message_index;

    // 独占切点：锚点之后（跨分段）的第一条 user 消息；没有则整会话复制。
    // 顺带记录切点前是否存在非 user 消息：桌面 done 先于落盘（persist-lag），
    // 助手回复还没写进历史时不允许分支，否则会静默复制出缺少该回复的前缀。
    let mut cut: Option<(usize, usize)> = None;
    let mut saw_reply_after_anchor = false;
    'scan: for (segment_pos, segment) in segments.iter().enumerate().skip(anchor_segment_pos) {
        let parsed;
        let messages: &[Value] = if segment_pos == anchor_segment_pos {
            &anchor_messages
        } else {
            parsed = parse_branch_segment_messages(segment)?;
            &parsed
        };
        let scan_from = if segment_pos == anchor_segment_pos {
            anchor_position + 1
        } else {
            0
        };
        for (message_index, message) in messages.iter().enumerate().skip(scan_from) {
            if branch_message_role_is_user(message) {
                cut = Some((segment_pos, message_index));
                break 'scan;
            }
            saw_reply_after_anchor = true;
        }
    }
    if !saw_reply_after_anchor {
        return Err("分支目标回复尚未写入历史，请稍后重试".to_string());
    }

    let mut kept: Vec<ChatHistorySegmentInput> = Vec::new();
    match cut {
        Some((cut_segment_pos, cut_message_index)) if cut_segment_pos == anchor_segment_pos => {
            // 切点仍在锚点段内：锚点段裁剪，后续分段全部丢弃。
            for segment in &segments[..anchor_segment_pos] {
                kept.push(record_to_segment_input(segment));
            }
            let new_index = kept.len() as i64;
            kept.push(build_branch_sliced_segment(
                &segments[anchor_segment_pos],
                &anchor_messages[..cut_message_index],
                new_index,
            )?);
        }
        Some((cut_segment_pos, cut_message_index)) => {
            // 切点在后续分段：之前的分段整段复制；切点段按 [..j] 裁剪，
            // j == 0 时整段（含 summary）丢弃；再往后的分段全部丢弃。
            for segment in &segments[..cut_segment_pos] {
                kept.push(record_to_segment_input(segment));
            }
            if cut_message_index > 0 {
                let cut_messages = parse_branch_segment_messages(&segments[cut_segment_pos])?;
                let new_index = kept.len() as i64;
                kept.push(build_branch_sliced_segment(
                    &segments[cut_segment_pos],
                    &cut_messages[..cut_message_index],
                    new_index,
                )?);
            }
        }
        None => {
            for segment in segments {
                kept.push(record_to_segment_input(segment));
            }
        }
    }

    for (index, segment) in kept.iter_mut().enumerate() {
        segment.segment_index = index as i64;
    }
    let total_message_count = kept.iter().fold(0_i64, |acc, segment| {
        acc.saturating_add(segment.message_count.max(0))
    });

    Ok((kept, total_message_count))
}

/// context_meta_json 是前端 StoredChatContextMeta 的序列化：只覆写三个计数
/// 字段，其余键保持原样；无法解析时原样保留。
pub(crate) fn chat_history_branch_sync(
    conn: &mut Connection,
    source_id: &str,
    anchor: &ChatHistoryMessageRef,
) -> Result<ChatHistorySummary, String> {
    let source_id = source_id.trim();
    if source_id.is_empty() {
        return Err("历史对话 id 不能为空".to_string());
    }
    validate_user_history_message_ref(anchor)?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("开启分支会话事务失败：{e}"))?;

    let source = get_record_by_id(&tx, source_id)?;
    let source_segments = load_segments(&tx, &source.id)?;
    if source_segments.is_empty() {
        return Err("历史对话缺少分段数据".to_string());
    }

    let (segments, total_message_count) = build_branch_segments(&source_segments, anchor)?;
    let total_segment_count = segments.len() as i64;
    let active_segment_index = total_segment_count - 1;
    let context_meta_json = patch_history_context_meta(
        &source.context_meta_json,
        active_segment_index,
        total_segment_count,
        total_message_count,
    );

    let new_id = Uuid::new_v4().to_string();
    let now = now_ms();
    let conversation = ChatHistoryConversationInput {
        id: new_id.clone(),
        title: BRANCH_DEFAULT_TITLE.to_string(),
        provider_id: source.provider_id.clone(),
        model: source.model.clone(),
        session_id: None,
        cwd: source.cwd.clone(),
        selected_model_json: source.selected_model_json.clone(),
        context_meta_json,
        active_segment_index,
        total_segment_count,
        total_message_count,
        created_at: Some(now),
        updated_at: now,
    };
    validate_conversation_input(&conversation)?;

    upsert_chat_history_header(&tx, &conversation)?;
    for segment in &segments {
        insert_single_segment(&tx, &new_id, segment)?;
    }
    verify_chat_history_consistency(&tx, &new_id)?;

    tx.commit()
        .map_err(|e| format!("提交分支会话事务失败：{e}"))?;

    get_summary_by_id(conn, &new_id)
}

pub(crate) async fn chat_history_branch_inner(
    id: String,
    anchor: ChatHistoryMessageRef,
) -> Result<ChatHistorySummary, String> {
    crate::compat::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        chat_history_branch_sync(&mut conn, &id, &anchor)
    })
    .await
    .map_err(|e| format!("chat_history_branch join 失败：{e}"))?
}

pub async fn chat_history_branch(
    id: String,
    base_message_ref: ChatHistoryMessageRef,
    gateway_controller: &Arc<GatewayController>,
) -> Result<ChatHistorySummary, String> {
    let summary = chat_history_branch_inner(id, base_message_ref).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_upsert(&summary))
        .await;
    Ok(summary)
}
