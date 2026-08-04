fn load_mcp(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(MCP_SETTINGS_SELECT_SQL)
        .map_err(|e| format!("准备读取 {MCP_SETTINGS_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取 {MCP_SETTINGS_TABLE} 失败：{e}"))?;

    let mut servers = Vec::new();
    let mut selected = Vec::new();

    for row in rows {
        let (server_id, payload_json) =
            row.map_err(|e| format!("读取 {MCP_SETTINGS_TABLE} 行失败：{e}"))?;
        let mut server = expect_object(
            parse_json(&payload_json, MCP_SETTINGS_TABLE)?,
            MCP_SETTINGS_TABLE,
        )?;

        let selected_flag = match server.remove("selected") {
            Some(Value::Bool(value)) => value,
            Some(Value::Null) | None => false,
            Some(_) => return Err("mcp_settings.selected 必须是布尔值".to_string()),
        };
        if selected_flag {
            selected.push(Value::String(server_id.clone()));
        }

        inject_string_field(&mut server, "id", server_id);
        servers.push(Value::Object(server));
    }

    if servers.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Object(Map::from_iter([
            ("servers".to_string(), Value::Array(servers)),
            ("selected".to_string(), Value::Array(selected)),
        ]))))
    }
}
fn save_mcp(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let mcp = expect_object(payload, "settings_save_mcp payload")?;
    let servers = expect_array(
        mcp.get("servers")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
        "settings_save_mcp payload.servers",
    )?;
    let selected_ids =
        extract_string_array(mcp.get("selected"), "settings_save_mcp payload.selected")?;
    let selected_ids: HashSet<String> = selected_ids.into_iter().collect();

    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {MCP_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(MCP_SETTINGS_DELETE_SQL, [])
        .map_err(|e| format!("清空 {MCP_SETTINGS_TABLE} 失败：{e}"))?;

    let mut seen = HashSet::new();
    for (sort_index, server) in servers.into_iter().enumerate() {
        let mut server = expect_object(server, "settings_save_mcp payload.servers[]")?;
        let server_id =
            extract_non_empty_string(&server, "id", "settings_save_mcp payload.servers[]")?;
        if !seen.insert(server_id.clone()) {
            return Err(format!("mcp_settings.server_id 重复：{server_id}"));
        }

        server.insert(
            "selected".to_string(),
            Value::Bool(selected_ids.contains(&server_id)),
        );

        tx.execute(
            MCP_SETTINGS_INSERT_SQL,
            params![
                server_id,
                serialize_json(&Value::Object(server), MCP_SETTINGS_TABLE)?,
                sort_index as i64,
                updated_at
            ],
        )
        .map_err(|e| format!("写入 {MCP_SETTINGS_TABLE} 失败：{e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("提交 {MCP_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(())
}
