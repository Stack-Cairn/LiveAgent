fn ssh_payload_string(payload: &Map<String, Value>, key: &str) -> Result<String, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| format!("{SSH_SETTINGS_TABLE}.{key} 必须是字符串"))
}

fn ssh_payload_i64(payload: &Map<String, Value>, key: &str) -> Result<i64, String> {
    payload
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("{SSH_SETTINGS_TABLE}.{key} 必须是整数"))
}

fn ssh_payload_bool(payload: &Map<String, Value>, key: &str) -> Result<bool, String> {
    payload
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("{SSH_SETTINGS_TABLE}.{key} 必须是布尔值"))
}

fn ssh_payload_proxy_json(payload: &Map<String, Value>) -> Result<String, String> {
    let proxy = payload
        .get("proxy")
        .cloned()
        .ok_or_else(|| format!("{SSH_SETTINGS_TABLE}.proxy 不能为空"))?;
    serialize_json(&proxy, SSH_SETTINGS_TABLE)
}

fn insert_ssh_settings_row(
    conn: &Connection,
    host_id: &str,
    payload: &Map<String, Value>,
    sort_index: i64,
    updated_at: i64,
) -> Result<(), String> {
    conn.execute(
        SSH_SETTINGS_INSERT_SQL,
        params![
            host_id,
            ssh_payload_string(payload, "name")?,
            ssh_payload_string(payload, "description")?,
            ssh_payload_string(payload, "host")?,
            ssh_payload_i64(payload, "port")?,
            ssh_payload_string(payload, "username")?,
            ssh_payload_string(payload, "authType")?,
            ssh_payload_string(payload, "password")?,
            ssh_payload_bool(payload, "passwordConfigured")?,
            ssh_payload_string(payload, "privateKey")?,
            ssh_payload_string(payload, "privateKeyPath")?,
            ssh_payload_bool(payload, "privateKeyConfigured")?,
            ssh_payload_string(payload, "privateKeyPassphrase")?,
            ssh_payload_bool(payload, "privateKeyPassphraseConfigured")?,
            ssh_payload_proxy_json(payload)?,
            sort_index,
            updated_at
        ],
    )
    .map_err(|e| format!("写入 {SSH_SETTINGS_TABLE} 失败：{e}"))?;
    Ok(())
}

fn save_ssh_rows(conn: &Connection, payload: Value) -> Result<(), String> {
    let mut ssh = expect_object(payload, "settings_save_ssh payload")?;
    let hosts = expect_array(
        ssh.remove("hosts").unwrap_or(Value::Array(Vec::new())),
        "settings_save_ssh payload.hosts",
    )?;
    let raw_project_host_associations = ssh
        .remove("projectHostAssociations")
        .unwrap_or(Value::Object(Map::new()));
    let updated_at = now_ms();
    conn.execute(SSH_SETTINGS_DELETE_SQL, [])
        .map_err(|e| format!("清空 {SSH_SETTINGS_TABLE} 失败：{e}"))?;
    conn.execute(SSH_PROJECT_HOST_ASSOCIATIONS_DELETE_SQL, [])
        .map_err(|e| format!("清空 {SSH_PROJECT_HOST_ASSOCIATIONS_TABLE} 失败：{e}"))?;

    let mut seen = HashSet::new();
    for (sort_index, host) in hosts.into_iter().enumerate() {
        let (host_id, payload) = validate_and_normalize_ssh_host(
            expect_object(host, "settings_save_ssh payload.hosts[]")?,
            "settings_save_ssh payload.hosts[]",
        )?;
        if !seen.insert(host_id.clone()) {
            return Err(format!("{SSH_SETTINGS_TABLE}.host_id 重复：{host_id}"));
        }

        insert_ssh_settings_row(conn, &host_id, &payload, sort_index as i64, updated_at)?;
    }

    let project_host_associations =
        normalize_ssh_project_host_associations_value(raw_project_host_associations, Some(&seen))?;
    for (project_path_key, host_ids) in project_host_associations {
        conn.execute(
            SSH_PROJECT_HOST_ASSOCIATIONS_INSERT_SQL,
            params![
                project_path_key,
                serialize_json(&host_ids, SSH_PROJECT_HOST_ASSOCIATIONS_TABLE)?,
                updated_at
            ],
        )
        .map_err(|e| format!("写入 {SSH_PROJECT_HOST_ASSOCIATIONS_TABLE} 失败：{e}"))?;
    }
    Ok(())
}

fn save_ssh(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {SSH_SETTINGS_TABLE} 事务失败：{e}"))?;
    save_ssh_rows(&tx, payload)?;

    tx.commit()
        .map_err(|e| format!("提交 {SSH_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(())
}

fn empty_ssh_settings_value() -> Value {
    json!({
        "hosts": [],
        "projectHostAssociations": {},
    })
}

fn load_ssh_or_empty(conn: &Connection) -> Result<Value, String> {
    Ok(load_ssh(conn)?.unwrap_or_else(empty_ssh_settings_value))
}
