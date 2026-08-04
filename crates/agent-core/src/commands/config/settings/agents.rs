fn load_agents(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(AGENT_PROMPT_TEMPLATES_SELECT_SQL)
        .map_err(|e| format!("准备读取 {AGENT_PROMPT_TEMPLATES_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| format!("读取 {AGENT_PROMPT_TEMPLATES_TABLE} 失败：{e}"))?;

    let mut templates = Vec::new();
    for row in rows {
        let (template_id, name, description, prompt, enabled) =
            row.map_err(|e| format!("读取 {AGENT_PROMPT_TEMPLATES_TABLE} 行失败：{e}"))?;
        templates.push(Value::Object(Map::from_iter([
            ("id".to_string(), Value::String(template_id)),
            ("name".to_string(), Value::String(name)),
            ("description".to_string(), Value::String(description)),
            ("prompt".to_string(), Value::String(prompt)),
            ("enabled".to_string(), Value::Bool(enabled != 0)),
        ])));
    }

    if templates.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Array(templates)))
    }
}
fn save_agents(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let templates = expect_array(payload, "settings_save_agents payload")?;
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {AGENT_PROMPT_TEMPLATES_TABLE} 事务失败：{e}"))?;
    tx.execute(AGENT_PROMPT_TEMPLATES_DELETE_SQL, [])
        .map_err(|e| format!("清空 {AGENT_PROMPT_TEMPLATES_TABLE} 失败：{e}"))?;

    let mut seen = HashSet::new();
    let mut enabled_template_id: Option<String> = None;
    for (sort_index, template) in templates.into_iter().enumerate() {
        let template = expect_object(template, "settings_save_agents payload[]")?;
        let template_id =
            extract_non_empty_string(&template, "id", "settings_save_agents payload[]")?;
        if !seen.insert(template_id.clone()) {
            return Err(format!(
                "{AGENT_PROMPT_TEMPLATES_TABLE}.template_id 重复：{template_id}"
            ));
        }

        let name = extract_non_empty_string(&template, "name", "settings_save_agents payload[]")?;
        let prompt =
            extract_non_empty_string(&template, "prompt", "settings_save_agents payload[]")?;
        let description = extract_optional_string(&template, "description");
        let enabled = match template.get("enabled") {
            Some(Value::Bool(value)) => *value,
            Some(Value::Null) | None => false,
            Some(_) => {
                return Err("settings_save_agents payload[].enabled 必须是布尔值".to_string());
            }
        };
        if enabled {
            if let Some(existing_id) = &enabled_template_id {
                return Err(format!(
                    "{AGENT_PROMPT_TEMPLATES_TABLE}.enabled 只能有一个激活项：{existing_id}, {template_id}"
                ));
            }
            enabled_template_id = Some(template_id.clone());
        }

        tx.execute(
            AGENT_PROMPT_TEMPLATES_INSERT_SQL,
            params![
                template_id,
                name,
                description,
                prompt,
                if enabled { 1_i64 } else { 0_i64 },
                sort_index as i64,
                updated_at
            ],
        )
        .map_err(|e| format!("写入 {AGENT_PROMPT_TEMPLATES_TABLE} 失败：{e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("提交 {AGENT_PROMPT_TEMPLATES_TABLE} 事务失败：{e}"))?;
    Ok(())
}
