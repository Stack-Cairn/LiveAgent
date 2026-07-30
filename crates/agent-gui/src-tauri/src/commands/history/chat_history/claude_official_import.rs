// Claude official importer. Locates & parses `conversations.json` inside a
// user-selected Claude data-export ZIP into [`ImportConversation`]. The shared
// struct, DB write and message builders live in `super::import`; this module
// just supplies the ZIP-specific scan + parse plus two tauri commands wired to
// that core.

use super::import::*;
use super::*;
use std::collections::HashMap;
use std::sync::Arc;

const CLAUDE_OFFICIAL_CONVERSATIONS_ENTRY: &str = "conversations.json";

fn read_claude_official_conversations(path: &std::path::Path) -> Result<Vec<Value>, String> {
    if path.extension().and_then(|extension| extension.to_str()) != Some("zip") {
        return Err("请选择 Claude 官方数据 ZIP 文件".to_string());
    }
    let file = std::fs::File::open(path)
        .map_err(|error| format!("读取 Claude 官方数据文件失败：{}: {error}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("无法打开 Claude 官方数据 ZIP：{error}"))?;
    let entry_index = (0..archive.len())
        .find(|index| {
            archive
                .by_index(*index)
                .ok()
                .is_some_and(|entry| entry.name() == CLAUDE_OFFICIAL_CONVERSATIONS_ENTRY)
        })
        .ok_or_else(|| "此 ZIP 不包含 Claude 官方数据的 conversations.json".to_string())?;
    let mut entry = archive
        .by_index(entry_index)
        .map_err(|error| format!("读取 conversations.json 失败：{error}"))?;
    use std::io::Read;
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|error| format!("读取 conversations.json 内容失败：{error}"))?;
    serde_json::from_str::<Vec<Value>>(&text)
        .map_err(|error| format!("Claude 官方数据的 conversations.json 格式无效：{error}"))
}

fn claude_official_attachment_text(message: &Value) -> Vec<Value> {
    let mut blocks = Vec::new();
    for attachment in message
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = import_string(attachment.get("file_name"))
            .unwrap_or_else(|| "unnamed attachment".to_string());
        let file_type = import_string(attachment.get("file_type"));
        let size = attachment.get("file_size").and_then(Value::as_u64);
        let mut text = format!("[Imported attachment: {name}");
        if let Some(file_type) = file_type {
            text.push_str(&format!(", {file_type}"));
        }
        if let Some(size) = size {
            text.push_str(&format!(", {size} bytes"));
        }
        text.push(']');
        if let Some(extracted) = import_string(attachment.get("extracted_content")) {
            text.push('\n');
            text.push_str(&extracted);
        }
        blocks.push(serde_json::json!({ "type": "text", "text": text }));
    }
    for file in message
        .get("files")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(name) = import_string(file.get("file_name")) else {
            continue;
        };
        blocks.push(serde_json::json!({
            "type": "text",
            "text": format!("[Imported file reference: {name}; the original file was not included in the Claude official data]")
        }));
    }
    blocks
}

fn convert_claude_official_conversation(conversation: &Value) -> Option<ImportConversation> {
    let session_id = import_string(conversation.get("uuid"))?;
    let created_at = import_timestamp(conversation.get("created_at").and_then(Value::as_str))
        .unwrap_or_else(now_ms);
    let mut updated_at = import_timestamp(conversation.get("updated_at").and_then(Value::as_str))
        .unwrap_or(created_at);
    let config = ImportProviderConfig::claude_official();
    let mut messages = Vec::new();
    let mut tool_names: HashMap<String, String> = HashMap::new();

    for (index, message) in conversation
        .get("chat_messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let timestamp = import_timestamp(message.get("created_at").and_then(Value::as_str))
            .unwrap_or(updated_at);
        updated_at = updated_at.max(timestamp);
        let message_id =
            import_string(message.get("uuid")).unwrap_or_else(|| format!("{session_id}:{index}"));
        let event_id = format!("{session_id}:{message_id}");
        match message.get("sender").and_then(Value::as_str) {
            Some("human") => {
                let mut content = import_text_blocks(message.get("text"), &["text"]);
                if content.is_empty() {
                    content = message
                        .get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|block| {
                            import_string(block.get("text"))
                                .map(|text| serde_json::json!({ "type": "text", "text": text }))
                        })
                        .collect();
                }
                content.extend(claude_official_attachment_text(message));
                if !content.is_empty() {
                    messages.push(user_message(event_id, content, timestamp));
                }
            }
            Some("assistant") => {
                let mut assistant_blocks = Vec::new();
                let mut tool_results = Vec::new();
                for block in message
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(text) = import_string(block.get("text")) {
                                assistant_blocks
                                    .push(serde_json::json!({ "type": "text", "text": text }));
                            }
                        }
                        Some("thinking") => {
                            if let Some(thinking) = import_string(block.get("thinking")) {
                                assistant_blocks.push(
                                    serde_json::json!({ "type": "thinking", "thinking": thinking }),
                                );
                            }
                        }
                        Some("tool_use") => {
                            let id = import_string(block.get("id")).unwrap_or_else(|| {
                                format!("claude-official-tool-{}", tool_names.len())
                            });
                            let name = import_string(block.get("name"))
                                .unwrap_or_else(|| "claude_official_tool".to_string());
                            tool_names.insert(id.clone(), name.clone());
                            assistant_blocks.push(serde_json::json!({ "type": "toolCall", "id": id, "name": name, "arguments": block.get("input").cloned().unwrap_or_else(|| serde_json::json!({})) }));
                        }
                        Some("tool_result") => {
                            let tool_call_id = import_string(block.get("tool_use_id"))
                                .or_else(|| import_string(block.get("tool_call_id")))
                                .unwrap_or_else(|| {
                                    format!("claude-official-tool-result-{}", tool_results.len())
                                });
                            let tool_name = tool_names
                                .get(&tool_call_id)
                                .cloned()
                                .unwrap_or_else(|| "claude_official_tool".to_string());
                            tool_results.push(tool_result_message(
                                event_id.clone(),
                                tool_call_id,
                                tool_name,
                                import_text_blocks(block.get("content"), &["text"]),
                                block
                                    .get("is_error")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                                timestamp,
                            ));
                        }
                        _ => {}
                    }
                }
                if assistant_blocks.is_empty() {
                    if let Some(text) = message
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                    {
                        assistant_blocks.push(serde_json::json!({ "type": "text", "text": text }));
                    } else {
                        assistant_blocks = message
                            .get("text")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter(|block| {
                                block.get("type").and_then(Value::as_str) == Some("text")
                            })
                            .filter_map(|block| {
                                import_string(block.get("text"))
                                    .map(|text| serde_json::json!({ "type": "text", "text": text }))
                            })
                            .collect();
                    }
                }
                if !assistant_blocks.is_empty() {
                    messages.push(assistant_message(
                        event_id,
                        &config,
                        "claude-official",
                        assistant_blocks,
                        "stop",
                        timestamp,
                    ));
                }
                messages.extend(tool_results);
            }
            _ => {}
        }
    }
    finalize_import_conversation(
        &config,
        session_id,
        "claude-official".to_string(),
        None,
        created_at,
        updated_at,
        import_string(conversation.get("name")),
        messages,
    )
}

fn scan_claude_official(
    zip_path: &std::path::Path,
) -> Result<(Vec<ImportConversation>, usize, usize), String> {
    let records = read_claude_official_conversations(zip_path)?;
    let scanned_count = records.len();
    let mut skipped_lines = 0;
    let mut conversations = Vec::new();
    for record in &records {
        match convert_claude_official_conversation(record) {
            Some(conversation) => conversations.push(conversation),
            None => skipped_lines += 1,
        }
    }
    conversations.sort_by_key(|conversation| conversation.created_at);
    Ok((conversations, scanned_count, skipped_lines))
}

#[tauri::command]
pub async fn chat_history_scan_claude_official(zip_path: String) -> Result<ImportPreview, String> {
    let path = zip_path.clone();
    scan_preview_command(
        move || scan_claude_official(std::path::Path::new(&path)),
        "Claude 官方数据",
    )
    .await
}

#[tauri::command]
pub async fn chat_history_import_claude_official(
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
    zip_path: String,
    ids: Vec<String>,
) -> Result<ImportResult, String> {
    let path = zip_path.clone();
    import_selected_command(
        move || scan_claude_official(std::path::Path::new(&path)),
        ImportProviderConfig::claude_official(),
        ids,
        &gateway_controller,
    )
    .await
}
