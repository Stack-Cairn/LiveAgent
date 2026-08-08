// Codex importer. Knows only how to locate & parse `~/.codex/sessions/**/rollout-*.jsonl`
// into [`ImportConversation`]. The shared struct, DB write and message builders
// live in `super::import`; this module just supplies the Codex-specific scan +
// parse plus two tauri commands wired to that core.

use super::import::*;
use super::*;
use std::collections::HashMap;
use std::sync::Arc;

fn codex_arguments(value: Option<&Value>) -> Value {
    let Some(raw) = value.and_then(Value::as_str) else {
        return serde_json::json!({});
    };
    serde_json::from_str(raw).unwrap_or_else(|_| serde_json::json!({ "raw": raw }))
}

fn codex_output_blocks(value: Option<&Value>) -> Vec<Value> {
    let Some(value) = value else {
        return Vec::new();
    };
    let values = value
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![value.clone()]);
    values
        .into_iter()
        .filter_map(|value| match value {
            Value::String(text) if !text.is_empty() => {
                Some(serde_json::json!({ "type": "text", "text": text }))
            }
            Value::Object(object) => object
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(|text| serde_json::json!({ "type": "text", "text": text })),
            _ => None,
        })
        .collect()
}

fn codex_session_id(rows: &[(String, Value)]) -> Option<String> {
    rows.iter()
        .filter_map(|(_, row)| {
            (row.get("type").and_then(Value::as_str) == Some("session_meta")).then_some(row)
        })
        .find(|row| {
            row.get("payload")
                .and_then(|p| p.get("thread_source"))
                .and_then(Value::as_str)
                != Some("subagent")
        })
        .or_else(|| {
            rows.iter().find_map(|(_, row)| {
                (row.get("type").and_then(Value::as_str) == Some("session_meta")).then_some(row)
            })
        })
        .and_then(|row| row.get("payload"))
        .and_then(|payload| {
            import_string(payload.get("session_id")).or_else(|| import_string(payload.get("id")))
        })
}

pub(crate) fn codex_remap_cwd(
    cwd: Option<String>,
    codex_temp_root: &std::path::Path,
    default_project: &std::path::Path,
) -> Option<String> {
    let cwd = cwd?;
    if std::path::Path::new(&cwd).starts_with(codex_temp_root) {
        return Some(default_project.to_string_lossy().into_owned());
    }
    Some(cwd)
}

pub(crate) fn convert_codex_file(
    path: &std::path::Path,
    titles: &HashMap<String, String>,
    codex_temp_root: &std::path::Path,
    default_project: &std::path::Path,
) -> Result<(Option<ImportConversation>, usize), String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("读取 Codex 会话失败：{}: {e}", path.display()))?;
    let (rows, skipped_lines) = parse_jsonl_lines(&text);
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
                    model = model.or_else(|| import_string(payload.get("model")));
                    cwd = cwd.or_else(|| import_string(payload.get("cwd")));
                    created_at = created_at.or_else(|| import_timestamp(Some(timestamp)));
                }
            }
            Some("turn_context") => {
                if let Some(payload) = row.get("payload") {
                    model = import_string(payload.get("model")).or(model);
                    cwd = import_string(payload.get("cwd")).or(cwd);
                }
            }
            _ => {}
        }
    }
    let model = model.unwrap_or_else(|| "codex".to_string());
    let config = ImportProviderConfig::codex(&model);
    let mut messages = Vec::new();
    let mut call_names: HashMap<String, String> = HashMap::new();
    let mut last_timestamp = created_at.unwrap_or_else(now_ms);

    for (index, (timestamp, row)) in rows.iter().enumerate() {
        let timestamp = import_timestamp(Some(timestamp)).unwrap_or(last_timestamp);
        last_timestamp = timestamp;
        if row.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let Some(payload) = row.get("payload") else {
            continue;
        };
        let item_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let item_id =
            import_string(payload.get("id")).unwrap_or_else(|| format!("{session_id}:{index}"));
        let event_id = format!("{session_id}:{item_id}");
        match item_type {
            "message" => {
                let role = payload
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if role == "user" {
                    let content = import_text_blocks(payload.get("content"), &["input_text"]);
                    if !content.is_empty() {
                        messages.push(user_message(event_id, content, timestamp));
                    }
                } else if role == "assistant" {
                    let content =
                        import_text_blocks(payload.get("content"), &["output_text", "input_text"]);
                    if !content.is_empty() {
                        messages.push(assistant_message(
                            event_id, &config, &model, content, "stop", timestamp,
                        ));
                    }
                }
            }
            "reasoning" => {
                let summary = payload
                    .get("summary")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                if !summary.is_empty() {
                    messages.push(assistant_message(
                        event_id,
                        &config,
                        &model,
                        vec![serde_json::json!({ "type": "thinking", "thinking": summary })],
                        "stop",
                        timestamp,
                    ));
                }
            }
            "function_call" | "custom_tool_call" => {
                let call_id =
                    import_string(payload.get("call_id")).unwrap_or_else(|| item_id.clone());
                let name =
                    import_string(payload.get("name")).unwrap_or_else(|| "codex_tool".to_string());
                call_names.insert(call_id.clone(), name.clone());
                let arguments = if item_type == "function_call" {
                    codex_arguments(payload.get("arguments"))
                } else {
                    codex_arguments(payload.get("input"))
                };
                messages.push(assistant_message(
                    event_id,
                    &config,
                    &model,
                    vec![
                        serde_json::json!({ "type": "toolCall", "id": call_id, "name": name, "arguments": arguments }),
                    ],
                    "toolUse",
                    timestamp,
                ));
            }
            "function_call_output" | "custom_tool_call_output" => {
                let call_id =
                    import_string(payload.get("call_id")).unwrap_or_else(|| item_id.clone());
                let tool_name = call_names
                    .get(&call_id)
                    .cloned()
                    .unwrap_or_else(|| "codex_tool".to_string());
                messages.push(tool_result_message(
                    event_id,
                    call_id,
                    tool_name,
                    codex_output_blocks(payload.get("output")),
                    false,
                    timestamp,
                ));
            }
            _ => {}
        }
    }
    let title = titles
        .get(&session_id)
        .cloned()
        .filter(|s| !s.trim().is_empty());
    let cwd = codex_remap_cwd(cwd, codex_temp_root, default_project);
    Ok((
        finalize_import_conversation(
            &config,
            session_id,
            model,
            cwd,
            created_at.unwrap_or(last_timestamp),
            last_timestamp,
            title,
            messages,
        ),
        skipped_lines,
    ))
}

fn read_codex_titles(home: &std::path::Path) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    let path = home.join(".codex/session_index.jsonl");
    let Ok(text) = std::fs::read_to_string(path) else {
        return titles;
    };
    for line in text.lines() {
        if let Ok(row) = serde_json::from_str::<Value>(line) {
            if let (Some(id), Some(title)) = (
                import_string(row.get("id")),
                import_string(row.get("thread_name")),
            ) {
                titles.insert(id, title);
            }
        }
    }
    titles
}

fn scan_codex_sessions() -> Result<(Vec<ImportConversation>, usize, usize), String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let root = home.join(".codex/sessions");
    if !root.exists() {
        return Ok((Vec::new(), 0, 0));
    }
    let titles = read_codex_titles(&home);
    let codex_temp_root = dirs::document_dir()
        .unwrap_or_else(|| home.join("Documents"))
        .join("Codex");
    let default_project = home
        .join(format!(".{}", env!("CARGO_PKG_NAME")))
        .join("default-project");
    let mut conversations = Vec::new();
    let mut scanned = 0;
    let mut skipped = 0;
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !entry.file_type().is_file()
            || path.extension().and_then(|s| s.to_str()) != Some("jsonl")
            || !path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .starts_with("rollout-")
        {
            continue;
        }
        scanned += 1;
        match convert_codex_file(path, &titles, &codex_temp_root, &default_project) {
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
pub async fn chat_history_scan_codex() -> Result<ImportPreview, String> {
    scan_preview_command(scan_codex_sessions, "Codex").await
}

#[tauri::command]
pub async fn chat_history_import_codex(
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
    ids: Vec<String>,
) -> Result<ImportResult, String> {
    import_selected_command(
        scan_codex_sessions,
        ImportProviderConfig::codex("codex"),
        ids,
        &gateway_controller,
    )
    .await
}
