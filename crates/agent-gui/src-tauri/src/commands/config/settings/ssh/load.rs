fn load_ssh(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(SSH_SETTINGS_SELECT_SQL)
        .map_err(|e| format!("准备读取 {SSH_SETTINGS_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let proxy_json = row.get::<_, String>(14)?;
            let proxy = parse_json(&proxy_json, SSH_SETTINGS_TABLE).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    14,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
                )
            })?;
            Ok(Value::Object(Map::from_iter([
                ("id".to_string(), Value::String(row.get::<_, String>(0)?)),
                ("name".to_string(), Value::String(row.get::<_, String>(1)?)),
                (
                    "description".to_string(),
                    Value::String(row.get::<_, String>(2)?),
                ),
                ("host".to_string(), Value::String(row.get::<_, String>(3)?)),
                (
                    "port".to_string(),
                    Value::Number(Number::from(row.get::<_, i64>(4)?)),
                ),
                (
                    "username".to_string(),
                    Value::String(row.get::<_, String>(5)?),
                ),
                (
                    "authType".to_string(),
                    Value::String(row.get::<_, String>(6)?),
                ),
                (
                    "password".to_string(),
                    Value::String(row.get::<_, String>(7)?),
                ),
                (
                    "passwordConfigured".to_string(),
                    Value::Bool(row.get::<_, i64>(8)? != 0),
                ),
                (
                    "privateKey".to_string(),
                    Value::String(row.get::<_, String>(9)?),
                ),
                (
                    "privateKeyPath".to_string(),
                    Value::String(row.get::<_, String>(10)?),
                ),
                (
                    "privateKeyConfigured".to_string(),
                    Value::Bool(row.get::<_, i64>(11)? != 0),
                ),
                (
                    "privateKeyPassphrase".to_string(),
                    Value::String(row.get::<_, String>(12)?),
                ),
                (
                    "privateKeyPassphraseConfigured".to_string(),
                    Value::Bool(row.get::<_, i64>(13)? != 0),
                ),
                ("proxy".to_string(), proxy),
            ])))
        })
        .map_err(|e| format!("读取 {SSH_SETTINGS_TABLE} 失败：{e}"))?;

    let mut hosts = Vec::new();
    for row in rows {
        hosts.push(row.map_err(|e| format!("读取 {SSH_SETTINGS_TABLE} 行失败：{e}"))?);
    }

    let project_host_associations = load_ssh_project_host_associations(conn, &hosts)?;
    if hosts.is_empty() && project_host_associations.is_empty() {
        return Ok(None);
    }
    Ok(Some(Value::Object(Map::from_iter([
        ("hosts".to_string(), Value::Array(hosts)),
        (
            "projectHostAssociations".to_string(),
            Value::Object(project_host_associations),
        ),
    ]))))
}

fn load_ssh_project_host_associations(
    conn: &Connection,
    hosts: &[Value],
) -> Result<Map<String, Value>, String> {
    let host_ids = hosts
        .iter()
        .filter_map(|host| host.get("id").and_then(Value::as_str).map(str::to_string))
        .collect::<HashSet<_>>();
    let mut stmt = conn
        .prepare(SSH_PROJECT_HOST_ASSOCIATIONS_SELECT_SQL)
        .map_err(|e| format!("准备读取 {SSH_PROJECT_HOST_ASSOCIATIONS_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取 {SSH_PROJECT_HOST_ASSOCIATIONS_TABLE} 失败：{e}"))?;
    let mut associations = Map::new();
    let mut canonical_keys = HashSet::new();
    for row in rows {
        let (project_path_key, host_ids_json) =
            row.map_err(|e| format!("读取 {SSH_PROJECT_HOST_ASSOCIATIONS_TABLE} 行失败：{e}"))?;
        let normalized_project_path_key = normalize_project_path_key(&project_path_key);
        if normalized_project_path_key.is_empty() {
            continue;
        }
        let parsed = parse_json(&host_ids_json, SSH_PROJECT_HOST_ASSOCIATIONS_TABLE)?;
        let ids = expect_array(parsed, SSH_PROJECT_HOST_ASSOCIATIONS_TABLE)?
            .into_iter()
            .filter_map(|item| item.as_str().map(str::trim).map(str::to_string))
            .filter(|id| !id.is_empty() && host_ids.contains(id))
            .collect::<Vec<_>>();
        if ids.is_empty() {
            continue;
        }
        insert_normalized_project_key_value(
            &mut associations,
            &mut canonical_keys,
            &project_path_key,
            Value::Array(ids.into_iter().map(Value::String).collect()),
        );
    }
    Ok(associations)
}

pub(crate) fn load_runtime_ssh_host(host_id: &str) -> Result<Option<RuntimeSshHostConfig>, String> {
    let host_id = host_id.trim();
    if host_id.is_empty() {
        return Ok(None);
    }
    let conn = open_db()?;
    conn.query_row(
        "
        SELECT
            host_id,
            name,
            host,
            port,
            username,
            auth_type,
            password,
            private_key,
            private_key_path,
            private_key_passphrase,
            proxy_json
        FROM ssh_settings
        WHERE host_id = ?1
        ",
        params![host_id],
        |row| {
            let proxy_json = row.get::<_, String>(10)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                proxy_json,
            ))
        },
    )
    .optional()
    .map_err(|e| format!("读取 {SSH_SETTINGS_TABLE} runtime host 失败：{e}"))?
    .map(
        |(
            id,
            name,
            host,
            port,
            username,
            auth_type,
            password,
            private_key,
            private_key_path,
            private_key_passphrase,
            proxy_json,
        )| {
            let proxy_value = parse_json(&proxy_json, SSH_SETTINGS_TABLE)?;
            let proxy = expect_object(proxy_value, "ssh runtime proxy")?;
            let port = u16::try_from(port)
                .ok()
                .filter(|port| *port >= 1)
                .ok_or_else(|| format!("{SSH_SETTINGS_TABLE}.port 无效：{port}"))?;
            Ok(RuntimeSshHostConfig {
                id,
                name,
                host,
                port,
                username,
                auth_type,
                password,
                private_key,
                private_key_path,
                private_key_passphrase,
                proxy: RuntimeSshProxyConfig {
                    proxy_type: extract_optional_string(&proxy, "type"),
                    url: extract_optional_string(&proxy, "url"),
                    port: proxy.get("port").and_then(Value::as_i64).unwrap_or(0),
                    username: extract_optional_string(&proxy, "username"),
                    password: extract_optional_string(&proxy, "password"),
                    password_configured: proxy
                        .get("passwordConfigured")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    use_system_proxy: proxy
                        .get("useSystemProxy")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                },
            })
        },
    )
    .transpose()
}

pub(crate) fn check_runtime_ssh_known_host(
    key: &RuntimeSshKnownHostKey,
) -> Result<RuntimeSshKnownHostStatus, String> {
    let conn = open_db()?;
    check_runtime_ssh_known_host_with_conn(&conn, key)
}

fn check_runtime_ssh_known_host_with_conn(
    conn: &Connection,
    key: &RuntimeSshKnownHostKey,
) -> Result<RuntimeSshKnownHostStatus, String> {
    let stored = conn
        .query_row(
            "
            SELECT key_base64, fingerprint_sha256
            FROM ssh_known_hosts
            WHERE host = ?1 AND port = ?2
            ",
            params![key.host.trim(), i64::from(key.port)],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| format!("读取 {SSH_KNOWN_HOSTS_TABLE} 失败：{e}"))?;
    let Some((stored_key_base64, stored_fingerprint)) = stored else {
        return Ok(RuntimeSshKnownHostStatus::Unknown);
    };
    if stored_key_base64 == key.key_base64 || stored_fingerprint == key.fingerprint_sha256 {
        Ok(RuntimeSshKnownHostStatus::Known)
    } else {
        Ok(RuntimeSshKnownHostStatus::Changed { stored_fingerprint })
    }
}

pub(crate) fn trust_runtime_ssh_known_host(key: &RuntimeSshKnownHostKey) -> Result<(), String> {
    let conn = open_db()?;
    trust_runtime_ssh_known_host_with_conn(&conn, key)
}

fn trust_runtime_ssh_known_host_with_conn(
    conn: &Connection,
    key: &RuntimeSshKnownHostKey,
) -> Result<(), String> {
    let now = now_ms();
    conn.execute(
        "
        INSERT INTO ssh_known_hosts (
            host,
            port,
            key_type,
            key_base64,
            fingerprint_sha256,
            trusted_at,
            updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(host, port) DO UPDATE SET
            key_type = excluded.key_type,
            key_base64 = excluded.key_base64,
            fingerprint_sha256 = excluded.fingerprint_sha256,
            updated_at = excluded.updated_at
        ",
        params![
            key.host.trim(),
            i64::from(key.port),
            key.key_type.trim(),
            key.key_base64.trim(),
            key.fingerprint_sha256.trim(),
            now,
            now
        ],
    )
    .map_err(|e| format!("写入 {SSH_KNOWN_HOSTS_TABLE} 失败：{e}"))?;
    Ok(())
}

pub(crate) fn reset_runtime_ssh_known_host(host: &str, port: u16) -> Result<usize, String> {
    let conn = open_db()?;
    reset_runtime_ssh_known_host_with_conn(&conn, host, port)
}

fn reset_runtime_ssh_known_host_with_conn(
    conn: &Connection,
    host: &str,
    port: u16,
) -> Result<usize, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("SSH host is required".to_string());
    }
    if port == 0 {
        return Err("SSH port is required".to_string());
    }
    conn.execute(SSH_KNOWN_HOSTS_DELETE_SQL, params![host, i64::from(port)])
        .map_err(|e| format!("重置 {SSH_KNOWN_HOSTS_TABLE} 失败：{e}"))
}
