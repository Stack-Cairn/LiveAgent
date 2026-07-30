// Claude Code importer. Locates & parses `~/.claude/projects/**` depth-2 JSONL
// into [`ImportConversation`]. The shared struct, DB write, command shell and
// the `claude_code_assistant` formatter all live in `super::import`; this
// module just supplies the Claude Code-specific scan + parse plus two tauri
// commands wired to that core.

use super::import::*;
use super::*;
use std::collections::HashMap;
use std::sync::Arc;

fn claude_code_is_internal_user_message(row: &Value, content: &str) -> bool {
    row.get("isMeta").and_then(Value::as_bool) == Some(true)
        || content.starts_with("<local-command-caveat>")
        || content.starts_with("<command-name>")
        || content.starts_with("<command-message>")
        || content.starts_with("<local-command-stdout>")
        || content.starts_with("<local-command-stderr>")
}

fn claude_code_tool_result_blocks(value: Option<&Value>) -> Vec<Value> {
    import_text_blocks(value)
}

fn claude_code_session_id(rows: &[(String, Value)], path: &std::path::Path) -> Option<String> {
    rows.iter()
        .find_map(|(_, row)| {
            import_string(row.get("sessionId")).or_else(|| import_string(row.get("session_id")))
        })
        .or_else(|| path.file_stem().and_then(|name| name.to_str()).map(str::to_string))
}

fn convert_claude_code_file(
    path: &std::path::Path,
) -> Result<(Option<ImportConversation>, usize), String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("读取 Claude Code 会话失败：{}: {error}", path.display()))?;
    let mut rows = Vec::new();
    let mut skipped_lines = 0;
    for line in text.lines() {
        match serde_json::from_str::<Value>(line) {
            Ok(row) if row.get("type").and_then(Value::as_str).is_some() => {
                rows.push((import_string(row.get("timestamp")).unwrap_or_default(), row));
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
        cwd = cwd.or_else(|| import_string(row.get("cwd")));
        created_at = created_at.or_else(|| import_timestamp(Some(timestamp)));
        match row.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                model = model.or_else(|| {
                    row.get("message")
                        .and_then(|message| import_string(message.get("model")))
                });
            }
            Some("ai-title") => title = import_string(row.get("aiTitle")).or(title),
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
        let timestamp = import_timestamp(Some(timestamp)).unwrap_or(last_timestamp);
        last_timestamp = timestamp;
        let entry_id = import_string(row.get("uuid"))
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
                let text_blocks = import_text_blocks(content);
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
                    let tool_call_id = import_string(block.get("tool_use_id"))
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
                let message_model = import_string(message.get("model")).unwrap_or_else(|| model.clone());
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
                            let tool_call_id = import_string(block.get("id")).unwrap_or_else(|| id.clone());
                            let tool_name = import_string(block.get("name")).unwrap_or_else(|| "claude_code_tool".to_string());
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
        Some(ImportConversation {
            id: ImportProviderConfig::claude_code(&model).id_prefix_with(&session_id),
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

fn scan_claude_code_sessions() -> Result<(Vec<ImportConversation>, usize, usize), String> {
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

#[tauri::command]
pub async fn chat_history_scan_claude_code() -> Result<ImportPreview, String> {
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
    Ok(ImportPreview { sessions, scanned_count, skipped_lines })
}

#[tauri::command]
pub async fn chat_history_import_claude_code(
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
    ids: Vec<String>,
) -> Result<ImportResult, String> {
    let selected: HashSet<String> = ids.into_iter().filter(|id| !id.trim().is_empty()).collect();
    let (conversations, _scanned_count, skipped_lines) =
        tauri::async_runtime::spawn_blocking(scan_claude_code_sessions)
            .await
            .map_err(|error| format!("Claude Code 扫描失败：{error}"))??;
    run_import(ImportProviderConfig::claude_code("claude_code"), conversations, skipped_lines, selected, &gateway_controller).await
}