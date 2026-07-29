#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeImportResult {
    pub scanned_count: usize,
    pub imported_count: usize,
    pub skipped_lines: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeImportPreview {
    pub sessions: Vec<ClaudeCodeConversation>,
    pub scanned_count: usize,
    pub skipped_lines: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeCodeConversation {
    id: String,
    session_id: String,
    title: String,
    model: String,
    cwd: Option<String>,
    created_at: i64,
    updated_at: i64,
    #[serde(skip)]
    messages: Vec<Value>,
    message_count: usize,
    already_imported: bool,
}

fn claude_code_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn claude_code_timestamp(value: Option<&str>) -> Option<i64> {
    value.and_then(|value| {
        chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|date| date.timestamp_millis())
    })
}

fn claude_code_text_blocks(value: Option<&Value>) -> Vec<Value> {
    let Some(value) = value else { return Vec::new() };
    let values = value.as_array().cloned().unwrap_or_else(|| vec![value.clone()]);
    values
        .into_iter()
        .filter_map(|value| match value {
            Value::String(text) if !text.is_empty() => {
                Some(serde_json::json!({ "type": "text", "text": text }))
            }
            Value::Object(object) if object.get("type").and_then(Value::as_str) == Some("text") => {
                object.get("text").and_then(Value::as_str).filter(|text| !text.is_empty()).map(|text| {
                    serde_json::json!({ "type": "text", "text": text })
                })
            }
            _ => None,
        })
        .collect()
}

fn claude_code_is_internal_user_message(row: &Value, content: &str) -> bool {
    row.get("isMeta").and_then(Value::as_bool) == Some(true)
        || content.starts_with("<local-command-caveat>")
        || content.starts_with("<command-name>")
        || content.starts_with("<command-message>")
        || content.starts_with("<local-command-stdout>")
        || content.starts_with("<local-command-stderr>")
}

fn claude_code_assistant(
    id: String,
    content: Vec<Value>,
    model: &str,
    timestamp: i64,
    stop_reason: &str,
) -> Value {
    serde_json::json!({
        "role": "assistant",
        "id": id,
        "content": content,
        "api": "anthropic-messages",
        "provider": "claude_code",
        "model": model,
        "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0 },
        "stopReason": stop_reason,
        "timestamp": timestamp
    })
}

fn claude_code_tool_result_blocks(value: Option<&Value>) -> Vec<Value> {
    claude_code_text_blocks(value)
}

fn claude_code_session_id(rows: &[(String, Value)], path: &std::path::Path) -> Option<String> {
    rows.iter()
        .find_map(|(_, row)| {
            claude_code_string(row.get("sessionId"))
                .or_else(|| claude_code_string(row.get("session_id")))
        })
        .or_else(|| path.file_stem().and_then(|name| name.to_str()).map(str::to_string))
}

fn convert_claude_code_file(
    path: &std::path::Path,
) -> Result<(Option<ClaudeCodeConversation>, usize), String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("读取 Claude Code 会话失败：{}: {error}", path.display()))?;
    let mut rows = Vec::new();
    let mut skipped_lines = 0;
    for line in text.lines() {
        match serde_json::from_str::<Value>(line) {
            Ok(row) if row.get("type").and_then(Value::as_str).is_some() => {
                rows.push((claude_code_string(row.get("timestamp")).unwrap_or_default(), row));
            }
            _ => skipped_lines += 1,
        }
    }
    if rows.is_empty() {
        return Ok((None, skipped_lines));
    }
    let Some(session_id) = claude_code_session_id(&rows, path) else {
        return Ok((None, skipped_lines));
    };

    let mut model = None;
    let mut cwd = None;
    let mut created_at = None;
    let mut title = None;
    for (timestamp, row) in &rows {
        cwd = cwd.or_else(|| claude_code_string(row.get("cwd")));
        created_at = created_at.or_else(|| claude_code_timestamp(Some(timestamp)));
        match row.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                model = model.or_else(|| {
                    row.get("message")
                        .and_then(|message| claude_code_string(message.get("model")))
                });
            }
            Some("ai-title") => title = claude_code_string(row.get("aiTitle")).or(title),
            _ => {}
        }
    }
    let model = model.unwrap_or_else(|| "claude_code".to_string());
    let mut messages = Vec::new();
    let mut tool_names = HashMap::new();
    let mut first_user_text = None;
    let mut last_timestamp = created_at.unwrap_or_else(now_ms);

    for (index, (timestamp, row)) in rows.iter().enumerate() {
        if row.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let timestamp = claude_code_timestamp(Some(timestamp)).unwrap_or(last_timestamp);
        last_timestamp = timestamp;
        let entry_id = claude_code_string(row.get("uuid"))
            .unwrap_or_else(|| format!("{session_id}:{index}"));
        match row.get("type").and_then(Value::as_str) {
            Some("user") => {
                let Some(message) = row.get("message") else { continue };
                let content = message.get("content");
                if let Some(text) = content.and_then(Value::as_str) {
                    if claude_code_is_internal_user_message(row, text) {
                        continue;
                    }
                    if text.trim().is_empty() {
                        continue;
                    }
                    first_user_text.get_or_insert_with(|| text.to_string());
                    messages.push(serde_json::json!({
                        "role": "user",
                        "id": format!("{session_id}:{entry_id}"),
                        "content": [{ "type": "text", "text": text }],
                        "timestamp": timestamp
                    }));
                    continue;
                }

                let Some(blocks) = content.and_then(Value::as_array) else { continue };
                let text_blocks = claude_code_text_blocks(content);
                if !text_blocks.is_empty() {
                    let text = text_blocks
                        .iter()
                        .filter_map(|block| block.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n");
                    first_user_text.get_or_insert(text);
                    messages.push(serde_json::json!({
                        "role": "user",
                        "id": format!("{session_id}:{entry_id}"),
                        "content": text_blocks,
                        "timestamp": timestamp
                    }));
                }
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let tool_call_id = claude_code_string(block.get("tool_use_id"))
                        .unwrap_or_else(|| format!("{session_id}:{entry_id}"));
                    let tool_name = tool_names
                        .get(&tool_call_id)
                        .cloned()
                        .unwrap_or_else(|| "claude_code_tool".to_string());
                    messages.push(serde_json::json!({
                        "role": "toolResult",
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "content": claude_code_tool_result_blocks(block.get("content")),
                        "isError": block.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                        "timestamp": timestamp
                    }));
                }
            }
            Some("assistant") => {
                let Some(message) = row.get("message") else { continue };
                let message_model = claude_code_string(message.get("model")).unwrap_or_else(|| model.clone());
                let stop_reason = if message.get("stop_reason").and_then(Value::as_str) == Some("tool_use") {
                    "toolUse"
                } else {
                    "stop"
                };
                let Some(blocks) = message.get("content").and_then(Value::as_array) else { continue };
                for (block_index, block) in blocks.iter().enumerate() {
                    let id = format!("{session_id}:{entry_id}:{block_index}");
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(text) = block.get("text").and_then(Value::as_str).filter(|text| !text.is_empty()) {
                                messages.push(claude_code_assistant(
                                    id,
                                    vec![serde_json::json!({ "type": "text", "text": text })],
                                    &message_model,
                                    timestamp,
                                    stop_reason,
                                ));
                            }
                        }
                        Some("thinking") => {
                            if let Some(thinking) = block.get("thinking").and_then(Value::as_str).filter(|text| !text.is_empty()) {
                                messages.push(claude_code_assistant(
                                    id,
                                    vec![serde_json::json!({ "type": "thinking", "thinking": thinking })],
                                    &message_model,
                                    timestamp,
                                    "stop",
                                ));
                            }
                        }
                        Some("tool_use") => {
                            let tool_call_id = claude_code_string(block.get("id")).unwrap_or_else(|| id.clone());
                            let tool_name = claude_code_string(block.get("name")).unwrap_or_else(|| "claude_code_tool".to_string());
                            tool_names.insert(tool_call_id.clone(), tool_name.clone());
                            messages.push(claude_code_assistant(
                                id,
                                vec![serde_json::json!({
                                    "type": "toolCall",
                                    "id": tool_call_id,
                                    "name": tool_name,
                                    "arguments": block.get("input").cloned().unwrap_or_else(|| serde_json::json!({}))
                                })],
                                &message_model,
                                timestamp,
                                "toolUse",
                            ));
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    if messages.is_empty() {
        return Ok((None, skipped_lines));
    }
    let title = title
        .filter(|title| !title.trim().is_empty())
        .or_else(|| first_user_text.map(|text| text.chars().take(80).collect()))
        .unwrap_or_else(|| format!("Claude Code session {session_id}"));
    let message_count = messages.len();
    Ok((
        Some(ClaudeCodeConversation {
            id: format!("claude-code:{session_id}"),
            session_id,
            title,
            model,
            // Desktop Chat/Cowork has no public Claude Code transcript format. For a
            // transcript that genuinely lacks cwd, preserve None so the UI groups it as
            // no workspace instead of inventing a project directory.
            cwd,
            created_at: created_at.unwrap_or(last_timestamp),
            updated_at: last_timestamp,
            messages,
            message_count,
            already_imported: false,
        }),
        skipped_lines,
    ))
}

fn scan_claude_code_sessions() -> Result<(Vec<ClaudeCodeConversation>, usize, usize), String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let root = home.join(".claude/projects");
    if !root.exists() {
        return Ok((Vec::new(), 0, 0));
    }
    let mut conversations = Vec::new();
    let mut scanned = 0;
    let mut skipped = 0;
    for entry in walkdir::WalkDir::new(root).max_depth(2).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if !entry.file_type().is_file() || path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        scanned += 1;
        match convert_claude_code_file(path) {
            Ok((Some(conversation), skipped_lines)) => {
                skipped += skipped_lines;
                conversations.push(conversation);
            }
            Ok((None, skipped_lines)) => skipped += skipped_lines,
            Err(_) => skipped += 1,
        }
    }
    conversations.sort_by_key(|conversation| conversation.created_at);
    Ok((conversations, scanned, skipped))
}

fn import_claude_code_conversation(
    conn: &mut Connection,
    conversation: ClaudeCodeConversation,
) -> Result<(ChatHistorySummary, bool), String> {
    if let Ok(summary) = get_summary_by_id(conn, &conversation.id) {
        return Ok((summary, false));
    }
    let messages_json = serde_json::to_string(&conversation.messages)
        .map_err(|error| format!("序列化 Claude Code 消息失败：{error}"))?;
    let message_count = conversation.message_count as i64;
    let segment_id = format!("{}:segment:0", conversation.id);
    let start_message_id = conversation
        .messages
        .first()
        .and_then(|message| claude_code_string(message.get("id")));
    let end_message_id = conversation
        .messages
        .last()
        .and_then(|message| claude_code_string(message.get("id")));
    let input = ChatHistoryUpsertInput {
        id: conversation.id.clone(),
        title: conversation.title,
        provider_id: "claude_code".to_string(),
        model: conversation.model.clone(),
        session_id: Some(conversation.session_id),
        cwd: conversation.cwd,
        selected_model_json: Some(
            serde_json::json!({ "customProviderId": "builtin-claude_code", "model": conversation.model }).to_string(),
        ),
        context_meta_json: serde_json::json!({ "schemaVersion": 3, "activeSegmentIndex": 0, "totalSegmentCount": 1, "totalMessageCount": message_count }).to_string(),
        active_segment_index: 0,
        total_segment_count: 1,
        total_message_count: message_count,
        segments: vec![ChatHistorySegmentInput {
            segment_index: 0,
            segment_id,
            summary_json: None,
            messages_json,
            message_count,
            start_message_id,
            end_message_id,
            created_at: conversation.created_at,
            updated_at: conversation.updated_at,
        }],
        created_at: Some(conversation.created_at),
        updated_at: conversation.updated_at,
    };
    validate_upsert_input(&input)?;
    let conversation_input = ChatHistoryConversationInput {
        id: input.id.clone(),
        title: input.title,
        provider_id: input.provider_id,
        model: input.model,
        session_id: input.session_id,
        cwd: input.cwd,
        selected_model_json: input.selected_model_json,
        context_meta_json: input.context_meta_json,
        active_segment_index: input.active_segment_index,
        total_segment_count: input.total_segment_count,
        total_message_count: input.total_message_count,
        created_at: input.created_at,
        updated_at: input.updated_at,
    };
    let tx = conn.transaction().map_err(|error| format!("开启 Claude Code 导入事务失败：{error}"))?;
    upsert_chat_history_header(&tx, &conversation_input)?;
    sync_segments(&tx, input.id.trim(), &input.segments, input.total_segment_count)?;
    verify_chat_history_consistency(&tx, input.id.trim())?;
    tx.commit().map_err(|error| format!("提交 Claude Code 导入事务失败：{error}"))?;
    Ok((get_summary_by_id(conn, input.id.trim())?, true))
}

#[tauri::command]
pub async fn chat_history_scan_claude_code() -> Result<ClaudeCodeImportPreview, String> {
    let (sessions, scanned_count, skipped_lines) = tauri::async_runtime::spawn_blocking(|| -> Result<_, String> {
        let (conversations, scanned_count, skipped_lines) = scan_claude_code_sessions()?;
        let conn = open_db()?;
        let sessions = conversations
            .into_iter()
            .map(|mut conversation| {
                conversation.already_imported = get_summary_by_id(&conn, &conversation.id).is_ok();
                conversation
            })
            .collect();
        Ok::<_, String>((sessions, scanned_count, skipped_lines))
    })
    .await
    .map_err(|error| format!("Claude Code 扫描失败：{error}"))??;
    Ok(ClaudeCodeImportPreview { sessions, scanned_count, skipped_lines })
}

#[tauri::command]
pub async fn chat_history_import_claude_code(
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
    ids: Vec<String>,
) -> Result<ClaudeCodeImportResult, String> {
    let selected: HashSet<String> = ids.into_iter().filter(|id| !id.trim().is_empty()).collect();
    let (summaries, scanned_count, skipped_lines) = tauri::async_runtime::spawn_blocking(move || {
        let (conversations, scanned_count, skipped_lines) = scan_claude_code_sessions()?;
        let mut conn = open_db()?;
        let summaries = conversations
            .into_iter()
            .filter(|conversation| selected.contains(&conversation.id))
            .map(|conversation| import_claude_code_conversation(&mut conn, conversation))
            .collect::<Result<Vec<_>, _>>()?;
        Ok::<_, String>((summaries, scanned_count, skipped_lines))
    })
    .await
    .map_err(|error| format!("Claude Code 导入失败：{error}"))??;
    let mut imported_count = 0;
    for summary in &summaries {
        if summary.1 {
            gateway_controller.publish_history_sync(build_history_sync_upsert(&summary.0)).await;
            imported_count += 1;
        }
    }
    Ok(ClaudeCodeImportResult { scanned_count, imported_count, skipped_lines })
}
