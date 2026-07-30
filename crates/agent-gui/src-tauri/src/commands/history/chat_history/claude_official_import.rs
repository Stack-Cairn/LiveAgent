// Claude official importer. Locates & parses `conversations.json` inside a
// user-selected Claude data-export ZIP into [`ImportConversation`]. The shared
// struct, DB write, command shell and the `claude_code_assistant` formatter all
// live in `super::import`; this module just supplies the ZIP-specific scan +
// parse plus two tauri commands wired to that core.

use super::import::*;
use super::*;
use std::collections::HashMap;

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
        let Some(name) = import_string(file.get("file_name")) else { continue };
        blocks.push(serde_json::json!({
            "type": "text",
            "text": format!("[Imported file reference: {name}; the original file was not included in the Claude official data]")
        }));
    }
    blocks
}

fn claude_official_content_blocks(
    value: Option<&Value>,
    tool_names: &mut HashMap<String, String>,
) -> (Vec<Value>, Vec<Value>) {
    let mut assistant_blocks = Vec::new();
    let mut tool_results = Vec::new();
    for block in value.and_then(Value::as_array).into_iter().flatten() {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = import_string(block.get("text")) {
                    assistant_blocks.push(serde_json::json!({ "type": "text", "text": text }));
                }
            }
            Some("thinking") => {
                if let Some(thinking) = import_string(block.get("thinking")) {
                    assistant_blocks.push(serde_json::json!({ "type": "thinking", "thinking": thinking }));
                }
            }
            Some("tool_use") => {
                let id = import_string(block.get("id"))
                    .unwrap_or_else(|| format!("claude-official-tool-{}", tool_names.len()));
                let name = import_string(block.get("name"))
                    .unwrap_or_else(|| "claude_official_tool".to_string());
                tool_names.insert(id.clone(), name.clone());
                assistant_blocks.push(serde_json::json!({
                    "type": "toolCall",
                    "id": id,
                    "name": name,
                    "arguments": block.get("input").cloned().unwrap_or_else(|| serde_json::json!({}))
                }));
            }
            Some("tool_result") => {
                let tool_call_id = import_string(block.get("tool_use_id"))
                    .or_else(|| import_string(block.get("tool_call_id")))
                    .unwrap_or_else(|| format!("claude-official-tool-result-{}", tool_results.len()));
                let tool_name = tool_names
                    .get(&tool_call_id)
                    .cloned()
                    .unwrap_or_else(|| "claude_official_tool".to_string());
                tool_results.push(serde_json::json!({
                    "role": "toolResult",
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                    "content": import_text_blocks(block.get("content")),
                    "isError": block.get("is_error").and_then(Value::as_bool).unwrap_or(false)
                }));
            }
            _ => {}
        }
    }
    (assistant_blocks, tool_results)
}

fn convert_claude_official_conversation(
    conversation: &Value,
) -> Option<ImportConversation> {
    let session_id = import_string(conversation.get("uuid"))?;
    let created_at = import_timestamp(conversation.get("created_at").and_then(Value::as_str))
        .unwrap_or_else(now_ms);
    let mut updated_at = import_timestamp(conversation.get("updated_at").and_then(Value::as_str))
        .unwrap_or(created_at);
    let mut messages = Vec::new();
    let mut tool_names = HashMap::new();
    let mut first_user_text = None;

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
        let message_id = import_string(message.get("uuid"))
            .unwrap_or_else(|| format!("{session_id}:{index}"));
        match message.get("sender").and_then(Value::as_str) {
            Some("human") => {
                let mut content = import_text_blocks(message.get("text"));
                if content.is_empty() {
                    content = message
                        .get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|block| import_string(block.get("text")))
                        .map(|text| serde_json::json!({ "type": "text", "text": text }))
                        .collect();
                }
                content.extend(claude_official_attachment_text(message));
                if content.is_empty() {
                    continue;
                }
                let text = content
                    .iter()
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                first_user_text.get_or_insert(text);
                messages.push(serde_json::json!({
                    "role": "user",
                    "id": format!("{session_id}:{message_id}"),
                    "content": content,
                    "timestamp": timestamp
                }));
            }
            Some("assistant") => {
                let (mut content, mut tool_results) =
                    claude_official_content_blocks(message.get("content"), &mut tool_names);
                if content.is_empty() {
                    content = import_text_blocks(message.get("text"));
                }
                if !content.is_empty() {
                    messages.push(claude_code_assistant(
                        format!("{session_id}:{message_id}"),
                        content,
                        "claude-official",
                        timestamp,
                        "stop",
                    ));
                }
                for result in &mut tool_results {
                    if let Some(object) = result.as_object_mut() {
                        object.insert("timestamp".to_string(), serde_json::json!(timestamp));
                    }
                    messages.push(result.clone());
                }
            }
            _ => {}
        }
    }

    if messages.is_empty() {
        return None;
    }
    let title = import_string(conversation.get("name"))
        .or_else(|| first_user_text.map(|text| text.chars().take(80).collect()))
        .unwrap_or_else(|| format!("Claude conversation {session_id}"));
    let message_count = messages.len();
    Some(ImportConversation {
        id: ImportProviderConfig::claude_official().id_prefix_with(&session_id),
        session_id,
        title,
        model: "claude-official".to_string(),
        // Official exports cannot identify a LiveAgent project. All imported
        // official conversations belong to Chat mode, never a workspace.
        cwd: None,
        created_at,
        updated_at,
        messages,
        message_count,
        already_imported: false,
    })
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
    let (sessions, scanned_count, skipped_lines) = tauri::async_runtime::spawn_blocking(move || {
        let (conversations, scanned_count, skipped_lines) = scan_claude_official(std::path::Path::new(&zip_path))?;
        let conn = open_db()?;
        let sessions = conversations.into_iter().map(|mut conversation| {
            conversation.already_imported = get_summary_by_id(&conn, &conversation.id).is_ok();
            conversation
        }).collect();
        Ok::<_, String>((sessions, scanned_count, skipped_lines))
    }).await.map_err(|error| format!("Claude 官方数据扫描失败：{error}"))??;
    Ok(ImportPreview { sessions, scanned_count, skipped_lines })
}

#[tauri::command]
pub async fn chat_history_import_claude_official(
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
    zip_path: String,
    ids: Vec<String>,
) -> Result<ImportResult, String> {
    let selected: HashSet<String> = ids.into_iter().filter(|id| !id.trim().is_empty()).collect();
    let (conversations, _scanned_count, skipped_lines) =
        tauri::async_runtime::spawn_blocking(move || scan_claude_official(std::path::Path::new(&zip_path)))
            .await
            .map_err(|error| format!("Claude 官方数据导入失败：{error}"))??;
    run_import(ImportProviderConfig::claude_official(), conversations, skipped_lines, selected, &gateway_controller).await
}

#[cfg(test)]
mod claude_official_import_tests {
    use super::*;

    #[test]
    fn imports_official_conversations_into_chat_mode() {
        let conversation = serde_json::json!({
            "uuid": "conversation-1",
            "cwd": "/tmp/linked-workspace", "name": "Official conversation",
            "created_at": "2026-07-29T07:30:25.134893Z", "updated_at": "2026-07-29T07:30:28.537983Z",
            "chat_messages": [
                {"uuid":"user-1", "sender":"human", "text":"Hello", "content":[], "attachments":[], "files":[], "created_at":"2026-07-29T07:30:25.134893Z"},
                {"uuid":"assistant-1", "sender":"assistant", "text":"", "content":[
                    {"type":"thinking", "thinking":"I should answer."}, {"type":"text", "text":"Hi"},
                    {"type":"tool_use", "id":"tool-1", "name":"view", "input":{"path":"README.md"}},
                    {"type":"tool_result", "tool_use_id":"tool-1", "content":"contents", "is_error":false}
                ], "created_at":"2026-07-29T07:30:28.537983Z"}
            ]
        });
        let imported = convert_claude_official_conversation(&conversation).expect("official conversation should be importable");
        assert_eq!(imported.id, "claude-official:conversation-1");
        assert_eq!(imported.cwd, None);
        assert_eq!(imported.message_count, 3);
        assert_eq!(imported.messages[0]["role"], "user");
        assert_eq!(imported.messages[1]["content"][0]["type"], "thinking");
        assert_eq!(imported.messages[1]["content"][1]["type"], "text");
        assert_eq!(imported.messages[1]["content"][2]["type"], "toolCall");
        assert_eq!(imported.messages[2]["role"], "toolResult");
        assert_eq!(imported.messages[2]["toolCallId"], "tool-1");
    }

    #[test]
    fn ignores_official_workspace_metadata() {
        for (key, value) in [
            ("cwd", "/Users/tester/project"),
            ("source_cwd", "/Users/tester/project"),
            ("workspace_path", "/Users/tester/project"),
            ("workspacePath", "/Users/tester/project"),
            ("cwd", "/home/claude/project"),
        ] {
            let conversation = serde_json::json!({
                "uuid": format!("conversation-{key}"),
                key: value,
                "chat_messages": [{"uuid":"user-1", "sender":"human", "text":"Hello"}]
            });
            let imported = convert_claude_official_conversation(&conversation)
                .expect("official conversation should be importable");
            assert_eq!(imported.cwd, None, "{key} must not create a workspace");
        }
    }

    #[test]
    fn sends_workspace_less_conversations_to_chat_mode() {
        let conversation = serde_json::json!({
            "uuid": "workspace-less-conversation",
            "chat_messages": [{
                "uuid": "user-1",
                "sender": "human",
                "text": "Hello",
                "created_at": "2026-07-29T07:30:25.134893Z"
            }]
        });

        let imported = convert_claude_official_conversation(&conversation)
            .expect("workspace-less conversation should be importable");
        assert_eq!(imported.cwd, None);
    }

    #[test]
    fn skips_official_conversation_without_displayable_messages() {
        let conversation = serde_json::json!({"uuid":"empty-conversation", "name":"", "chat_messages":[]});
        assert!(convert_claude_official_conversation(&conversation).is_none());
    }
}