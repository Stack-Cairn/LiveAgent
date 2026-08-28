pub(crate) fn load_model_failover(conn: &Connection) -> Result<Option<Value>, String> {
    let payload_json = conn
        .query_row(
            &format!(
                "SELECT payload_json FROM {MODEL_FAILOVER_SETTINGS_TABLE} WHERE config_id = 'default'"
            ),
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取 {MODEL_FAILOVER_SETTINGS_TABLE} 失败：{e}"))?;

    match payload_json {
        Some(raw) => Ok(Some(parse_json(&raw, MODEL_FAILOVER_SETTINGS_TABLE)?)),
        None => Ok(None),
    }
}
fn save_model_failover(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let model_failover = Value::Object(expect_object(
        payload,
        "settings_save_model_failover payload",
    )?);
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {MODEL_FAILOVER_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(
        &format!("DELETE FROM {MODEL_FAILOVER_SETTINGS_TABLE} WHERE config_id = 'default'"),
        [],
    )
    .map_err(|e| format!("清空 {MODEL_FAILOVER_SETTINGS_TABLE} 失败：{e}"))?;
    tx.execute(
        &format!(
            "INSERT INTO {MODEL_FAILOVER_SETTINGS_TABLE} (config_id, payload_json, updated_at) VALUES ('default', ?1, ?2)"
        ),
        params![
            serialize_json(&model_failover, MODEL_FAILOVER_SETTINGS_TABLE)?,
            updated_at
        ],
    )
    .map_err(|e| format!("写入 {MODEL_FAILOVER_SETTINGS_TABLE} 失败：{e}"))?;
    tx.commit()
        .map_err(|e| format!("提交 {MODEL_FAILOVER_SETTINGS_TABLE} 事务失败：{e}"))?;
    // 标脏放在 commit 之后：事务回滚时不该触发自动同步。
    crate::services::webdav_auto_sync::mark_dirty();
    Ok(())
}
