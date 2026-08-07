/// 全是布尔开关，没有可归一化的东西——反序列化本身就是归一化。
pub fn parse_remote_settings_payload(value: Value) -> Result<RemoteSettingsPayload, String> {
    serde_json::from_value::<RemoteSettingsPayload>(value)
        .map_err(|e| format!("解析 remote settings 失败：{e}"))
}

pub(crate) fn load_remote(conn: &Connection) -> Result<Option<Value>, String> {
    let payload_json = conn
        .query_row(
            &format!(
                "SELECT payload_json FROM {REMOTE_SETTINGS_TABLE} WHERE config_id = 'default'"
            ),
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取 {REMOTE_SETTINGS_TABLE} 失败：{e}"))?;

    match payload_json {
        Some(raw) => Ok(Some(parse_json(&raw, REMOTE_SETTINGS_TABLE)?)),
        None => Ok(None),
    }
}

pub fn load_remote_settings(conn: &Connection) -> Result<RemoteSettingsPayload, String> {
    match load_remote(conn)? {
        Some(value) => parse_remote_settings_payload(value),
        None => Ok(RemoteSettingsPayload::default()),
    }
}

fn persist_remote_settings(
    conn: &Connection,
    settings: &RemoteSettingsPayload,
) -> Result<(), String> {
    let payload = serde_json::to_value(settings)
        .map_err(|e| format!("序列化 {REMOTE_SETTINGS_TABLE} 失败：{e}"))?;
    conn.execute(
        &format!(
            "INSERT INTO {REMOTE_SETTINGS_TABLE} (config_id, payload_json, updated_at)
             VALUES ('default', ?1, ?2)
             ON CONFLICT(config_id) DO UPDATE SET
               payload_json = excluded.payload_json,
               updated_at = excluded.updated_at"
        ),
        params![serialize_json(&payload, REMOTE_SETTINGS_TABLE)?, now_ms()],
    )
    .map_err(|e| format!("写入 {REMOTE_SETTINGS_TABLE} 失败：{e}"))?;
    Ok(())
}

fn redact_remote_settings(remote: Value) -> Result<Value, String> {
    let remote = expect_object(remote, "remote settings payload")?;
    let enable_web_terminal = remote
        .get("enableWebTerminal")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let enable_web_git = remote
        .get("enableWebGit")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let enable_web_ssh_terminal = remote
        .get("enableWebSshTerminal")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let enable_web_tunnels = remote
        .get("enableWebTunnels")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(json!({
        "enableWebTerminal": enable_web_terminal,
        "enableWebSshTerminal": enable_web_ssh_terminal,
        "enableWebGit": enable_web_git,
        "enableWebTunnels": enable_web_tunnels,
    }))
}

// 一条 INSERT ... ON CONFLICT 本身就是原子的：整份配置直接覆盖，
// 不再有需要「先读后写」保护的安装身份字段，事务也就没必要了。
fn save_remote(conn: &Connection, payload: Value) -> Result<RemoteSettingsPayload, String> {
    let normalized = parse_remote_settings_payload(payload)?;
    persist_remote_settings(conn, &normalized)?;
    Ok(normalized)
}
