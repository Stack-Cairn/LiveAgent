pub(crate) fn load_memory(conn: &Connection) -> Result<Option<Value>, String> {
    let payload_json = conn
        .query_row(
            &format!(
                "SELECT payload_json FROM {MEMORY_SETTINGS_TABLE} WHERE config_id = 'default'"
            ),
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取 {MEMORY_SETTINGS_TABLE} 失败：{e}"))?;

    match payload_json {
        Some(raw) => Ok(Some(parse_json(&raw, MEMORY_SETTINGS_TABLE)?)),
        None => Ok(None),
    }
}
fn save_memory(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let memory = Value::Object(expect_object(payload, "settings_save_memory payload")?);
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {MEMORY_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(
        &format!("DELETE FROM {MEMORY_SETTINGS_TABLE} WHERE config_id = 'default'"),
        [],
    )
    .map_err(|e| format!("清空 {MEMORY_SETTINGS_TABLE} 失败：{e}"))?;
    tx.execute(
        &format!(
            "INSERT INTO {MEMORY_SETTINGS_TABLE} (config_id, payload_json, updated_at) VALUES ('default', ?1, ?2)"
        ),
        params![serialize_json(&memory, MEMORY_SETTINGS_TABLE)?, updated_at],
    )
    .map_err(|e| format!("写入 {MEMORY_SETTINGS_TABLE} 失败：{e}"))?;
    tx.commit()
        .map_err(|e| format!("提交 {MEMORY_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(())
}
