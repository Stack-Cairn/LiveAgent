fn read_trimmed_string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn compute_message_stable_id(message: &Value, segment_index: i64, message_index: usize) -> String {
    if let Some(object) = message.as_object() {
        if let Some(id) = read_trimmed_string_field(object, "id") {
            return id;
        }
        if matches!(
            read_trimmed_string_field(object, "role").as_deref(),
            Some("assistant")
        ) {
            if let Some(response_id) = read_trimmed_string_field(object, "responseId") {
                return response_id;
            }
        }
    }

    format!(
        "segment-{segment_index}-message-{message_index}-{}",
        read_message_timestamp(message)
    )
}

fn normalize_history_search_text(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn push_text_piece(out: &mut Vec<String>, label: Option<&str>, text: &str) {
    let normalized = normalize_history_search_text(text);
    if normalized.is_empty() {
        return;
    }
    if let Some(label) = label.filter(|value| !value.trim().is_empty()) {
        out.push(format!("{label}: {normalized}"));
    } else {
        out.push(normalized);
    }
}

fn stringify_short_json(value: &Value) -> Option<String> {
    let text = serde_json::to_string(value).ok()?;
    let normalized = normalize_history_search_text(&text);
    if normalized.is_empty() {
        None
    } else if normalized.len() > 512 {
        let truncated = normalized.chars().take(512).collect::<String>();
        Some(format!("{truncated}..."))
    } else {
        Some(normalized)
    }
}

fn extract_tool_call_summary(record: &Map<String, Value>) -> Option<String> {
    let name = ["name", "toolName", "tool_name"]
        .iter()
        .find_map(|key| read_trimmed_string_field(record, key));
    let args = ["arguments", "args", "input", "parameters"]
        .iter()
        .find_map(|key| record.get(*key).and_then(stringify_short_json));

    match (name, args) {
        (Some(name), Some(args)) => Some(format!("tool call {name} {args}")),
        (Some(name), None) => Some(format!("tool call {name}")),
        (None, Some(args)) => Some(format!("tool call {args}")),
        (None, None) => None,
    }
}

fn extract_content_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return normalize_history_search_text(text);
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };

    let mut pieces = Vec::new();
    for item in items {
        let Some(record) = item.as_object() else {
            continue;
        };
        match read_trimmed_string_field(record, "type").as_deref() {
            Some("text") => {
                if let Some(text) = record.get("text").and_then(Value::as_str) {
                    push_text_piece(&mut pieces, None, text);
                }
            }
            Some("toolCall") | Some("tool_use") => {
                if let Some(summary) = extract_tool_call_summary(record) {
                    push_text_piece(&mut pieces, None, &summary);
                }
            }
            Some("thinking") => {
                // Do not index hidden reasoning or encrypted thinking payloads.
            }
            _ => {}
        }
    }
    pieces.join("\n")
}

fn extract_searchable_history_messages(
    segment: &ChatHistorySegmentInput,
) -> Vec<SearchableHistoryMessage> {
    let Ok(parsed) = serde_json::from_str::<Value>(&segment.messages_json) else {
        return Vec::new();
    };
    let Some(items) = parsed.as_array() else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(object) = item.as_object() else {
            continue;
        };
        let role = read_trimmed_string_field(object, "role");
        let mut pieces = Vec::new();
        if let Some(tool_name) = read_trimmed_string_field(object, "toolName") {
            push_text_piece(&mut pieces, Some("tool"), &tool_name);
        }
        let content_text = extract_content_text(object.get("content"));
        push_text_piece(&mut pieces, role.as_deref(), &content_text);
        let text = pieces.join("\n");
        if text.trim().is_empty() {
            continue;
        }

        out.push(SearchableHistoryMessage {
            message_index: i64::try_from(index).unwrap_or(i64::MAX),
            message_id: read_trimmed_string_field(object, "id").or_else(|| {
                Some(compute_message_stable_id(
                    item,
                    segment.segment_index,
                    index,
                ))
            }),
            role,
            text,
            updated_at: read_message_timestamp_with_fallback(item, segment.updated_at),
        });
    }
    out
}

fn load_chat_history_fts_conversation_info(
    conn: &Connection,
    conversation_id: &str,
) -> Result<ChatHistoryFtsConversationInfo, String> {
    conn.query_row(
        "
        SELECT id, title, cwd, updated_at
        FROM chatHistory
        WHERE id = ?1
        ",
        params![conversation_id],
        |row| {
            Ok(ChatHistoryFtsConversationInfo {
                id: row.get("id")?,
                title: row.get("title")?,
                cwd: row.get("cwd")?,
                updated_at: row.get("updated_at")?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => "未找到对应的历史对话".to_string(),
        _ => format!("读取历史 FTS 对话信息失败：{e}"),
    })
}

fn delete_chat_history_segment_fts(
    conn: &Connection,
    conversation_id: &str,
    segment_index: i64,
) -> Result<(), String> {
    conn.execute(
        "
        DELETE FROM chatHistoryFtsSegmentIndex
        WHERE conversation_id = ?1 AND segment_index = ?2
        ",
        params![conversation_id, segment_index],
    )
    .map_err(|e| format!("删除历史 FTS 元数据失败：{e}"))?;
    conn.execute(
        "
        DELETE FROM chatHistoryMessageFts
        WHERE conversation_id = ?1 AND segment_index = ?2
        ",
        params![conversation_id, segment_index],
    )
    .map_err(|e| format!("删除历史消息 FTS 行失败：{e}"))?;
    conn.execute(
        "
        DELETE FROM chatHistorySegmentFts
        WHERE conversation_id = ?1 AND segment_index = ?2
        ",
        params![conversation_id, segment_index],
    )
    .map_err(|e| format!("删除历史分段 FTS 行失败：{e}"))?;
    Ok(())
}

fn delete_chat_history_fts_from_segment(
    conn: &Connection,
    conversation_id: &str,
    from_segment_index: i64,
) -> Result<(), String> {
    conn.execute(
        "
        DELETE FROM chatHistoryFtsSegmentIndex
        WHERE conversation_id = ?1 AND segment_index >= ?2
        ",
        params![conversation_id, from_segment_index],
    )
    .map_err(|e| format!("清理截断历史 FTS 元数据失败：{e}"))?;
    conn.execute(
        "
        DELETE FROM chatHistoryMessageFts
        WHERE conversation_id = ?1 AND segment_index >= ?2
        ",
        params![conversation_id, from_segment_index],
    )
    .map_err(|e| format!("清理截断历史消息 FTS 行失败：{e}"))?;
    conn.execute(
        "
        DELETE FROM chatHistorySegmentFts
        WHERE conversation_id = ?1 AND segment_index >= ?2
        ",
        params![conversation_id, from_segment_index],
    )
    .map_err(|e| format!("清理截断历史分段 FTS 行失败：{e}"))?;
    Ok(())
}

fn delete_chat_history_conversation_fts(
    conn: &Connection,
    conversation_id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM chatHistoryFtsSegmentIndex WHERE conversation_id = ?1",
        params![conversation_id],
    )
    .map_err(|e| format!("删除历史对话 FTS 元数据失败：{e}"))?;
    conn.execute(
        "DELETE FROM chatHistoryMessageFts WHERE conversation_id = ?1",
        params![conversation_id],
    )
    .map_err(|e| format!("删除历史对话消息 FTS 行失败：{e}"))?;
    conn.execute(
        "DELETE FROM chatHistorySegmentFts WHERE conversation_id = ?1",
        params![conversation_id],
    )
    .map_err(|e| format!("删除历史对话分段 FTS 行失败：{e}"))?;
    Ok(())
}

fn is_chat_history_segment_fts_current(
    conn: &Connection,
    conversation: &ChatHistoryFtsConversationInfo,
    segment: &ChatHistorySegmentInput,
) -> Result<bool, String> {
    let current = conn
        .query_row(
            "
            SELECT 1
            FROM chatHistoryFtsSegmentIndex
            WHERE conversation_id = ?1
              AND segment_index = ?2
              AND segment_updated_at = ?3
              AND conversation_updated_at = ?4
            LIMIT 1
            ",
            params![
                conversation.id,
                segment.segment_index,
                segment.updated_at,
                conversation.updated_at
            ],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("检查历史 FTS 当前状态失败：{e}"))?;
    Ok(current.is_some())
}

fn index_chat_history_segment_fts(
    conn: &Connection,
    conversation: &ChatHistoryFtsConversationInfo,
    segment: &ChatHistorySegmentInput,
) -> Result<(), String> {
    delete_chat_history_segment_fts(conn, &conversation.id, segment.segment_index)?;

    let messages = extract_searchable_history_messages(segment);
    let segment_body = messages
        .iter()
        .map(|message| {
            let role = message.role.as_deref().unwrap_or("message");
            format!("{role}: {}", message.text)
        })
        .collect::<Vec<_>>()
        .join("\n");

    conn.execute(
        "
        INSERT INTO chatHistorySegmentFts (
            conversation_id,
            segment_index,
            segment_id,
            title,
            cwd,
            body,
            segment_updated_at,
            conversation_updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ",
        params![
            conversation.id,
            segment.segment_index,
            segment.segment_id.trim(),
            conversation.title.trim(),
            conversation.cwd.as_deref(),
            segment_body,
            segment.updated_at,
            conversation.updated_at
        ],
    )
    .map_err(|e| format!("写入历史分段 FTS 失败：{e}"))?;

    for message in messages {
        conn.execute(
            "
        INSERT INTO chatHistoryMessageFts (
                conversation_id,
                segment_index,
                segment_id,
                message_index,
                message_id,
                role,
                title,
                cwd,
                body,
                message_updated_at,
                segment_updated_at,
                conversation_updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ",
            params![
                conversation.id,
                segment.segment_index,
                segment.segment_id.trim(),
                message.message_index,
                message.message_id.as_deref(),
                message.role.as_deref(),
                conversation.title.trim(),
                conversation.cwd.as_deref(),
                message.text,
                message.updated_at,
                segment.updated_at,
                conversation.updated_at
            ],
        )
        .map_err(|e| format!("写入历史消息 FTS 失败：{e}"))?;
    }

    conn.execute(
        "
        INSERT INTO chatHistoryFtsSegmentIndex (
            conversation_id,
            segment_index,
            segment_updated_at,
            conversation_updated_at
        ) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(conversation_id, segment_index) DO UPDATE SET
            segment_updated_at = excluded.segment_updated_at,
            conversation_updated_at = excluded.conversation_updated_at
        ",
        params![
            conversation.id,
            segment.segment_index,
            segment.updated_at,
            conversation.updated_at,
        ],
    )
    .map_err(|e| format!("写入历史 FTS 元数据失败：{e}"))?;

    Ok(())
}

fn reindex_chat_history_conversation_fts(
    conn: &Connection,
    conversation_id: &str,
) -> Result<(), String> {
    let conversation = load_chat_history_fts_conversation_info(conn, conversation_id)?;
    let segments = load_segments(conn, conversation_id)?;
    for segment in segments {
        let input = record_to_segment_input(&segment);
        index_chat_history_segment_fts(conn, &conversation, &input)?;
    }
    Ok(())
}

