fn generate_history_share_token() -> String {
    let alphabet_len = HISTORY_SHARE_TOKEN_ALPHABET.len() as u128;
    let mut value = u128::from_be_bytes(*Uuid::new_v4().as_bytes());
    let mut token = String::with_capacity(HISTORY_SHARE_TOKEN_LEN);

    for _ in 0..HISTORY_SHARE_TOKEN_LEN {
        let index = (value % alphabet_len) as usize;
        token.push(HISTORY_SHARE_TOKEN_ALPHABET[index] as char);
        value /= alphabet_len;
    }

    token
}

fn is_unique_constraint_error(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(err, _)
            if err.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

fn empty_chat_history_share_status(conversation_id: &str) -> ChatHistoryShareStatus {
    ChatHistoryShareStatus {
        conversation_id: conversation_id.to_string(),
        enabled: false,
        token: None,
        created_at: None,
        updated_at: None,
        redact_tool_content: false,
    }
}

fn row_to_share_status(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatHistoryShareStatus> {
    let enabled = row.get::<_, i64>("enabled")? != 0;
    let token = row
        .get::<_, Option<String>>("token")?
        .filter(|value| !value.trim().is_empty());
    let is_enabled = enabled && token.is_some();
    Ok(ChatHistoryShareStatus {
        conversation_id: row.get("conversation_id")?,
        enabled: is_enabled,
        token: if is_enabled { token } else { None },
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        redact_tool_content: row.get::<_, i64>("redact_tool_content")? != 0,
    })
}

fn ensure_chat_history_exists(conn: &Connection, id: &str) -> Result<String, String> {
    let chat_id = id.trim();
    if chat_id.is_empty() {
        return Err("历史对话 id 不能为空".to_string());
    }

    conn.query_row(
        "SELECT id FROM chatHistory WHERE id = ?1",
        params![chat_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("检查历史对话是否存在失败：{e}"))?
    .ok_or_else(|| "未找到对应的历史对话".to_string())
}

fn get_chat_history_share_status_sync(
    conn: &Connection,
    id: &str,
) -> Result<ChatHistoryShareStatus, String> {
    let chat_id = ensure_chat_history_exists(conn, id)?;
    let status = conn
        .query_row(
            "
            SELECT conversation_id, token, enabled, redact_tool_content, created_at, updated_at
            FROM chatHistoryShare
            WHERE conversation_id = ?1
            ",
            params![chat_id],
            row_to_share_status,
        )
        .optional()
        .map_err(|e| format!("读取历史对话分享状态失败：{e}"))?;

    Ok(status.unwrap_or_else(|| empty_chat_history_share_status(&chat_id)))
}

fn set_chat_history_share_enabled_sync(
    conn: &Connection,
    id: &str,
    enabled: bool,
    redact_tool_content: Option<bool>,
) -> Result<ChatHistoryShareStatus, String> {
    let chat_id = ensure_chat_history_exists(conn, id)?;
    let now = now_ms();

    if enabled {
        let current = conn
            .query_row(
                "
                SELECT conversation_id, token, enabled, redact_tool_content, created_at, updated_at
                FROM chatHistoryShare
                WHERE conversation_id = ?1
                ",
                params![chat_id],
                row_to_share_status,
            )
            .optional()
            .map_err(|e| format!("读取历史对话分享状态失败：{e}"))?;
        let desired_redact_tool_content = redact_tool_content
            .or_else(|| current.as_ref().map(|status| status.redact_tool_content))
            .unwrap_or(false);
        if let Some(status) = current.as_ref() {
            if status.enabled && status.token.is_some() {
                if redact_tool_content
                    .map(|value| value == status.redact_tool_content)
                    .unwrap_or(true)
                {
                    return Ok(status.clone());
                }
                conn.execute(
                    "
                    UPDATE chatHistoryShare
                    SET redact_tool_content = ?1, updated_at = ?2
                    WHERE conversation_id = ?3
                    ",
                    params![
                        if desired_redact_tool_content { 1 } else { 0 },
                        now,
                        chat_id
                    ],
                )
                .map_err(|e| format!("更新历史对话分享脱敏设置失败：{e}"))?;
                return get_chat_history_share_status_sync(conn, &chat_id);
            }
        }

        let mut wrote_share_token = false;
        for _ in 0..HISTORY_SHARE_TOKEN_INSERT_ATTEMPTS {
            let token = generate_history_share_token();
            match conn.execute(
                "
                INSERT INTO chatHistoryShare (
                    conversation_id,
                    token,
                    enabled,
                    redact_tool_content,
                    created_at,
                    updated_at
                ) VALUES (?1, ?2, 1, ?3, ?4, ?4)
                ON CONFLICT(conversation_id) DO UPDATE SET
                    token = excluded.token,
                    enabled = 1,
                    redact_tool_content = excluded.redact_tool_content,
                    updated_at = excluded.updated_at
                ",
                params![
                    chat_id,
                    token,
                    if desired_redact_tool_content { 1 } else { 0 },
                    now
                ],
            ) {
                Ok(_) => {
                    wrote_share_token = true;
                    break;
                }
                Err(error) if is_unique_constraint_error(&error) => continue,
                Err(error) => return Err(format!("开启历史对话分享失败：{error}")),
            }
        }

        if !wrote_share_token {
            return Err("开启历史对话分享失败：生成唯一分享路径失败".to_string());
        }
    } else {
        conn.execute(
            "
            UPDATE chatHistoryShare
            SET token = NULL, enabled = 0, updated_at = ?1
            WHERE conversation_id = ?2
            ",
            params![now, chat_id],
        )
        .map_err(|e| format!("关闭历史对话分享失败：{e}"))?;
        if let Some(redact_tool_content) = redact_tool_content {
            conn.execute(
                "
                UPDATE chatHistoryShare
                SET redact_tool_content = ?1, updated_at = ?2
                WHERE conversation_id = ?3
                ",
                params![if redact_tool_content { 1 } else { 0 }, now, chat_id],
            )
            .map_err(|e| format!("更新历史对话分享脱敏设置失败：{e}"))?;
        }
    }

    get_chat_history_share_status_sync(conn, &chat_id)
}

fn resolve_chat_history_share_sync(
    conn: &Connection,
    token: &str,
) -> Result<ChatHistoryRecord, String> {
    let share_token = token.trim();
    if share_token.is_empty() {
        return Err("分享 token 不能为空".to_string());
    }

    let conversation_id = conn
        .query_row(
            "
            SELECT conversation_id
            FROM chatHistoryShare
            WHERE token = ?1 AND enabled = 1
            ",
            params![share_token],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取历史对话分享链接失败：{e}"))?
        .ok_or_else(|| "分享链接不存在或已关闭".to_string())?;

    let mut record = get_record_by_id(conn, &conversation_id)?;
    record.segments = load_segments(conn, &record.id)?;

    Ok(record)
}
