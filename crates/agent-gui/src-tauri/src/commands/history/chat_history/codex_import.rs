#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexImportResult {
    pub scanned_count: usize,
    pub imported_count: usize,
    pub skipped_lines: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexImportPreview {
    pub sessions: Vec<CodexConversation>,
    pub scanned_count: usize,
    pub skipped_lines: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexConversation {
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

fn codex_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn codex_timestamp(value: Option<&str>) -> Option<i64> {
    value.and_then(|value| {
        chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|date| date.timestamp_millis())
    })
}

fn codex_text_blocks(value: Option<&Value>, input: bool) -> Vec<Value> {
    let mut blocks = Vec::new();
    let Some(value) = value else { return blocks };
    let values = value.as_array().cloned().unwrap_or_else(|| vec![value.clone()]);
    for item in values {
        match item {
            Value::String(text) if !text.is_empty() => {
                blocks.push(serde_json::json!({ "type": "text", "text": text }));
            }
            Value::Object(object) => {
                let kind = object.get("type").and_then(Value::as_str).unwrap_or_default();
                let accepted = if input { kind == "input_text" } else { kind == "output_text" || kind == "input_text" };
                if accepted {
                    if let Some(text) = object.get("text").and_then(Value::as_str) {
                        blocks.push(serde_json::json!({ "type": "text", "text": text }));
                    }
                }
            }
            _ => {}
        }
    }
    blocks
}

fn codex_arguments(value: Option<&Value>) -> Value {
    let Some(raw) = value.and_then(Value::as_str) else { return serde_json::json!({}) };
    serde_json::from_str(raw).unwrap_or_else(|_| serde_json::json!({ "raw": raw }))
}

fn codex_output_blocks(value: Option<&Value>) -> Vec<Value> {
    let Some(value) = value else { return Vec::new() };
    let values = value.as_array().cloned().unwrap_or_else(|| vec![value.clone()]);
    let mut blocks = Vec::new();
    for item in values {
        match item {
            Value::String(text) => blocks.push(serde_json::json!({ "type": "text", "text": text })),
            Value::Object(object) => {
                if object.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = object.get("text").and_then(Value::as_str) {
                        blocks.push(serde_json::json!({ "type": "text", "text": text }));
                    }
                } else if let Some(text) = object.get("text").and_then(Value::as_str) {
                    blocks.push(serde_json::json!({ "type": "text", "text": text }));
                }
            }
            _ => {}
        }
    }
    blocks
}

fn codex_assistant(
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
        "api": "openai-responses",
        "provider": "codex",
        "model": model,
        "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0 },
        "stopReason": stop_reason,
        "timestamp": timestamp
    })
}

fn codex_session_id(rows: &[(String, Value)]) -> Option<String> {
    rows.iter()
        .filter_map(|(_, row)| (row.get("type").and_then(Value::as_str) == Some("session_meta")).then_some(row))
        .find(|row| row.get("payload").and_then(|p| p.get("thread_source")).and_then(Value::as_str) != Some("subagent"))
        .or_else(|| rows.iter().find_map(|(_, row)| (row.get("type").and_then(Value::as_str) == Some("session_meta")).then_some(row)))
        .and_then(|row| row.get("payload"))
        .and_then(|payload| codex_string(payload.get("session_id")).or_else(|| codex_string(payload.get("id"))))
}

fn codex_import_cwd(cwd: Option<String>, home: &std::path::Path) -> Option<String> {
    let cwd = cwd?;
    let codex_temp = dirs::document_dir()
        .unwrap_or_else(|| home.join("Documents"))
        .join("Codex");
    if std::path::Path::new(&cwd).starts_with(&codex_temp) {
        return Some(
            home.join(format!(".{}", env!("CARGO_PKG_NAME")))
                .join("default-project")
                .to_string_lossy()
                .into_owned(),
        );
    }
    Some(cwd)
}

fn convert_codex_file(
    path: &std::path::Path,
    titles: &HashMap<String, String>,
    home: &std::path::Path,
) -> Result<(Option<CodexConversation>, usize), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读取 Codex 会话失败：{}: {e}", path.display()))?;
    let mut rows = Vec::new();
    let mut skipped_lines = 0;
    for line in text.lines() {
        match serde_json::from_str::<Value>(line) {
            Ok(row) if row.get("type").and_then(Value::as_str).is_some() => {
                let timestamp = codex_string(row.get("timestamp")).unwrap_or_default();
                rows.push((timestamp, row));
            }
            _ => skipped_lines += 1,
        }
    }
    if rows.is_empty() {
        return Ok((None, skipped_lines));
    }
    let Some(session_id) = codex_session_id(&rows) else {
        return Ok((None, skipped_lines));
    };

    let mut model = None;
    let mut cwd = None;
    let mut created_at = None;
    for (timestamp, row) in &rows {
        match row.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if let Some(payload) = row.get("payload") {
                    model = model.or_else(|| codex_string(payload.get("model")));
                    cwd = cwd.or_else(|| codex_string(payload.get("cwd")));
                    created_at = created_at.or_else(|| codex_timestamp(Some(timestamp)));
                }
            }
            Some("turn_context") => {
                if let Some(payload) = row.get("payload") {
                    model = codex_string(payload.get("model")).or(model);
                    cwd = codex_string(payload.get("cwd")).or(cwd);
                }
            }
            _ => {}
        }
    }
    let model = model.unwrap_or_else(|| "codex".to_string());
    let mut messages = Vec::new();
    let mut call_names = HashMap::new();
    let mut first_user_text = None;
    let mut last_timestamp = created_at.unwrap_or_else(now_ms);

    for (index, (timestamp, row)) in rows.iter().enumerate() {
        let timestamp = codex_timestamp(Some(timestamp)).unwrap_or(last_timestamp);
        last_timestamp = timestamp;
        if let Some(payload) = row.get("payload") {
            if row.get("type").and_then(Value::as_str) != Some("response_item") { continue; }
            let item_type = payload.get("type").and_then(Value::as_str).unwrap_or_default();
            let item_id = codex_string(payload.get("id")).unwrap_or_else(|| format!("{session_id}:{index}"));
            match item_type {
                "message" => {
                    let role = payload.get("role").and_then(Value::as_str).unwrap_or_default();
                    if role == "user" {
                        let content = codex_text_blocks(payload.get("content"), true);
                        if content.is_empty() { continue; }
                        let text = content.iter().filter_map(|v| v.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n");
                        first_user_text.get_or_insert(text);
                        messages.push(serde_json::json!({ "role": "user", "id": format!("{session_id}:{item_id}"), "content": content, "timestamp": timestamp }));
                    } else if role == "assistant" {
                        let content = codex_text_blocks(payload.get("content"), false);
                        if !content.is_empty() { messages.push(codex_assistant(format!("{session_id}:{item_id}"), content, &model, timestamp, "stop")); }
                    }
                }
                "reasoning" => {
                    let summary = payload.get("summary").and_then(Value::as_array).map(|items| items.iter().filter_map(|item| item.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")).unwrap_or_default();
                    if !summary.is_empty() { messages.push(codex_assistant(format!("{session_id}:{item_id}"), vec![serde_json::json!({ "type": "thinking", "thinking": summary })], &model, timestamp, "stop")); }
                }
                "function_call" | "custom_tool_call" => {
                    let call_id = codex_string(payload.get("call_id")).unwrap_or_else(|| item_id.clone());
                    let name = codex_string(payload.get("name")).unwrap_or_else(|| "codex_tool".to_string());
                    call_names.insert(call_id.clone(), name.clone());
                    let arguments = if item_type == "function_call" { codex_arguments(payload.get("arguments")) } else { codex_arguments(payload.get("input")) };
                    messages.push(codex_assistant(format!("{session_id}:{item_id}"), vec![serde_json::json!({ "type": "toolCall", "id": call_id, "name": name, "arguments": arguments })], &model, timestamp, "toolUse"));
                }
                "function_call_output" | "custom_tool_call_output" => {
                    let call_id = codex_string(payload.get("call_id")).unwrap_or_else(|| item_id.clone());
                    let tool_name = call_names.get(&call_id).cloned().unwrap_or_else(|| "codex_tool".to_string());
                    let content = codex_output_blocks(payload.get("output"));
                    messages.push(serde_json::json!({ "role": "toolResult", "toolCallId": call_id, "toolName": tool_name, "content": content, "isError": false, "timestamp": timestamp }));
                }
                _ => {}
            }
        }
    }
    if messages.is_empty() {
        return Ok((None, skipped_lines));
    }
    let title = titles
        .get(&session_id)
        .cloned()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| first_user_text.map(|s| s.chars().take(80).collect()))
        .unwrap_or_else(|| format!("Codex session {session_id}"));
    let message_count = messages.len();
    Ok((
        Some(CodexConversation {
            id: format!("codex:{session_id}"),
            session_id,
            title,
            model,
            cwd: codex_import_cwd(cwd, home),
            created_at: created_at.unwrap_or(last_timestamp),
            updated_at: last_timestamp,
            messages,
            message_count,
            already_imported: false,
        }),
        skipped_lines,
    ))
}

fn read_codex_titles(home: &std::path::Path) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    let path = home.join(".codex/session_index.jsonl");
    let Ok(text) = std::fs::read_to_string(path) else { return titles };
    for line in text.lines() {
        if let Ok(row) = serde_json::from_str::<Value>(line) {
            if let (Some(id), Some(title)) = (codex_string(row.get("id")), codex_string(row.get("thread_name"))) { titles.insert(id, title); }
        }
    }
    titles
}

fn scan_codex_sessions() -> Result<(Vec<CodexConversation>, usize, usize), String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let root = home.join(".codex/sessions");
    if !root.exists() { return Ok((Vec::new(), 0, 0)); }
    let titles = read_codex_titles(&home);
    let mut conversations = Vec::new();
    let mut scanned = 0;
    let mut skipped = 0;
    for entry in walkdir::WalkDir::new(root).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if !entry.file_type().is_file() || path.extension().and_then(|s| s.to_str()) != Some("jsonl") || !path.file_name().and_then(|s| s.to_str()).unwrap_or_default().starts_with("rollout-") { continue; }
        scanned += 1;
        match convert_codex_file(path, &titles, &home) {
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

fn import_codex_conversation(
    conn: &mut Connection,
    conversation: CodexConversation,
) -> Result<(ChatHistorySummary, bool), String> {
    if let Ok(summary) = get_summary_by_id(conn, &conversation.id) {
        return Ok((summary, false));
    }
    let messages_json = serde_json::to_string(&conversation.messages)
        .map_err(|e| format!("序列化 Codex 消息失败：{e}"))?;
    let message_count = conversation.message_count as i64;
    let segment_id = format!("{}:segment:0", conversation.id);
    let start_message_id = conversation
        .messages
        .first()
        .and_then(|message| codex_string(message.get("id")));
    let end_message_id = conversation
        .messages
        .last()
        .and_then(|message| codex_string(message.get("id")));
    let input = ChatHistoryUpsertInput {
        id: conversation.id.clone(),
        title: conversation.title,
        provider_id: "codex".to_string(),
        model: conversation.model.clone(),
        session_id: Some(conversation.session_id),
        cwd: conversation.cwd,
        selected_model_json: Some(
            serde_json::json!({ "customProviderId": "codex", "model": conversation.model })
                .to_string(),
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
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 Codex 导入事务失败：{e}"))?;
    upsert_chat_history_header(&tx, &conversation_input)?;
    sync_segments(&tx, input.id.trim(), &input.segments, input.total_segment_count)?;
    verify_chat_history_consistency(&tx, input.id.trim())?;
    tx.commit().map_err(|e| format!("提交 Codex 导入事务失败：{e}"))?;
    Ok((get_summary_by_id(conn, input.id.trim())?, true))
}

#[tauri::command]
pub async fn chat_history_scan_codex() -> Result<CodexImportPreview, String> {
    let (sessions, scanned_count, skipped_lines) =
        tauri::async_runtime::spawn_blocking(|| -> Result<_, String> {
            let (conversations, scanned_count, skipped_lines) = scan_codex_sessions()?;
            let conn = open_db()?;
            let sessions = conversations
                .into_iter()
                .map(|mut conversation| {
                    conversation.already_imported =
                        get_summary_by_id(&conn, &conversation.id).is_ok();
                    conversation
                })
                .collect();
            Ok::<_, String>((sessions, scanned_count, skipped_lines))
        })
        .await
        .map_err(|e| format!("Codex 扫描失败：{e}"))??;
    Ok(CodexImportPreview {
        sessions,
        scanned_count,
        skipped_lines,
    })
}

#[tauri::command]
pub async fn chat_history_import_codex(
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
    ids: Vec<String>,
) -> Result<CodexImportResult, String> {
    let selected: HashSet<String> = ids.into_iter().filter(|id| !id.trim().is_empty()).collect();
    let (summaries, scanned_count, skipped_lines) = tauri::async_runtime::spawn_blocking(move || {
        let (conversations, scanned_count, skipped_lines) = scan_codex_sessions()?;
        let mut conn = open_db()?;
        let summaries = conversations
            .into_iter()
            .filter(|conversation| selected.contains(&conversation.id))
            .map(|conversation| import_codex_conversation(&mut conn, conversation))
            .collect::<Result<Vec<_>, _>>()?;
        Ok::<_, String>((summaries, scanned_count, skipped_lines))
    })
    .await
    .map_err(|e| format!("Codex 导入失败：{e}"))??;
    let mut imported_count = 0;
    for summary in &summaries {
        if summary.1 {
            gateway_controller
                .publish_history_sync(build_history_sync_upsert(&summary.0))
                .await;
            imported_count += 1;
        }
    }
    Ok(CodexImportResult {
        scanned_count,
        imported_count,
        skipped_lines,
    })
}
