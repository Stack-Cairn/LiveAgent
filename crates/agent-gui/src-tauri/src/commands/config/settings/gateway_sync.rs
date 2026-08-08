pub(crate) fn load_gateway_settings_sync_snapshot(conn: &Connection) -> Result<Value, String> {
    let default_workdir = default_project_workdir()?;
    let mut snapshot = Map::new();
    snapshot.insert(
        "system".to_string(),
        redact_system_settings(load_system_with_defaults(conn, &default_workdir)?)?,
    );
    snapshot.insert(
        "customProviders".to_string(),
        redact_provider_credentials(load_providers(conn)?.unwrap_or(Value::Array(Vec::new())))?,
    );
    snapshot.insert(
        "mcp".to_string(),
        load_mcp(conn)?.unwrap_or(Value::Object(Map::new())),
    );
    snapshot.insert(
        "agents".to_string(),
        load_agents(conn)?.unwrap_or(Value::Array(Vec::new())),
    );
    snapshot.insert(
        "ssh".to_string(),
        redact_ssh_settings(load_ssh(conn)?.unwrap_or(Value::Object(Map::from_iter([(
            "hosts".to_string(),
            Value::Array(Vec::new()),
        )]))))?,
    );
    snapshot.insert(
        "automationCron".to_string(),
        load_masked_automation_cron(conn)?,
    );
    snapshot.insert(
        "automationHooks".to_string(),
        load_masked_automation_hooks(conn)?,
    );
    snapshot.insert(
        "memory".to_string(),
        load_memory(conn)?.unwrap_or(Value::Object(Map::new())),
    );
    snapshot.insert(
        "modelFailover".to_string(),
        load_model_failover(conn)?.unwrap_or(Value::Object(Map::new())),
    );
    let remote = load_remote_settings(conn)?;
    snapshot.insert(
        "remote".to_string(),
        json!({
            "enableWebTerminal": remote.enable_web_terminal,
            "enableWebSshTerminal": remote.enable_web_ssh_terminal,
            "enableWebGit": remote.enable_web_git,
            "enableWebTunnels": remote.enable_web_tunnels,
        }),
    );
    // UI-only fields (theme, locale, selectedModel, skills, chatRuntimeControls,
    // customSettings) live in the webview's localStorage, not in this DB. They are
    // deliberately omitted here: merge_settings_sync_snapshot overlays the cached
    // values published by the webview, and receivers treat a missing field as
    // "keep current". Fabricating defaults here (e.g. theme "light") would clobber
    // the user's real theme on every publish that happens before the webview syncs.
    Ok(Value::Object(snapshot))
}

/// Automation snapshots leave the desktop with HTTP header values masked;
/// remote clients round-trip the sentinel and the store restores the stored
/// secret on apply.
fn load_masked_automation_cron(conn: &Connection) -> Result<Value, String> {
    crate::services::automation::db::ensure_schema(conn)?;
    let mut snapshot = crate::services::automation::db::read_cron_snapshot(conn)?;
    for task in &mut snapshot.tasks {
        crate::services::automation::validate::mask_request_headers(&mut task.requests);
    }
    serde_json::to_value(&snapshot).map_err(|e| format!("序列化 automation cron 快照失败：{e}"))
}

fn load_masked_automation_hooks(conn: &Connection) -> Result<Value, String> {
    crate::services::automation::db::ensure_schema(conn)?;
    let mut snapshot = crate::services::automation::db::read_hooks_snapshot(conn)?;
    for hook in &mut snapshot.hooks {
        crate::services::automation::validate::mask_request_headers(&mut hook.requests);
    }
    serde_json::to_value(&snapshot).map_err(|e| format!("序列化 automation hooks 快照失败：{e}"))
}

pub(crate) fn redact_gateway_settings_sync_payload(payload: Value) -> Result<Value, String> {
    let mut snapshot = expect_object(payload, "gateway settings sync payload")?;
    snapshot.remove(PROVIDER_API_KEY_UPDATES_FIELD);
    snapshot.remove(PROVIDER_USAGE_QUERY_SECRET_UPDATES_FIELD);
    snapshot.remove(SSH_SECRET_UPDATES_FIELD);
    snapshot.remove(SYSTEM_PROXY_PASSWORD_UPDATE_FIELD);
    if let Some(providers) = snapshot.remove("customProviders") {
        snapshot.insert(
            "customProviders".to_string(),
            redact_provider_credentials(providers)?,
        );
    }
    if let Some(system) = snapshot.remove("system") {
        snapshot.insert("system".to_string(), redact_system_settings(system)?);
    }
    if let Some(ssh) = snapshot.remove("ssh") {
        snapshot.insert("ssh".to_string(), redact_ssh_settings(ssh)?);
    }
    if let Some(remote) = snapshot.remove("remote") {
        snapshot.insert("remote".to_string(), redact_remote_settings(remote)?);
    }
    Ok(Value::Object(snapshot))
}

fn redact_ssh_settings(ssh: Value) -> Result<Value, String> {
    let mut ssh = expect_object(ssh, "ssh settings payload")?;
    let hosts = expect_array(
        ssh.remove("hosts").unwrap_or(Value::Array(Vec::new())),
        "ssh settings hosts",
    )?;
    let project_host_associations = ssh
        .remove("projectHostAssociations")
        .unwrap_or(Value::Object(Map::new()));
    let redacted = hosts
        .into_iter()
        .map(redact_ssh_host_secret)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Object(Map::from_iter([
        ("hosts".to_string(), Value::Array(redacted)),
        (
            "projectHostAssociations".to_string(),
            Value::Object(normalize_ssh_project_host_associations_value(
                project_host_associations,
                None,
            )?),
        ),
    ])))
}

fn redact_ssh_host_secret(host: Value) -> Result<Value, String> {
    let mut payload = expect_object(host, "ssh settings host")?;
    let auth_type = payload
        .get("authType")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("password");
    let is_keyboard_interactive_auth = auth_type == "keyboardInteractive";
    let password_configured =
        match payload.remove("password") {
            Some(Value::String(value)) => !value.trim().is_empty(),
            Some(Value::Null) | None => false,
            Some(_) => return Err("ssh settings password must be a string".to_string()),
        } || matches!(payload.get("passwordConfigured"), Some(Value::Bool(true)));
    let private_key_configured = match payload.remove("privateKey") {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => return Err("ssh settings privateKey must be a string".to_string()),
    } || payload
        .get("privateKeyPath")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        || matches!(payload.get("privateKeyConfigured"), Some(Value::Bool(true)));
    let private_key_passphrase_configured = match payload.remove("privateKeyPassphrase") {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => return Err("ssh settings privateKeyPassphrase must be a string".to_string()),
    } || matches!(
        payload.get("privateKeyPassphraseConfigured"),
        Some(Value::Bool(true))
    );
    payload.insert(
        "passwordConfigured".to_string(),
        Value::Bool(!is_keyboard_interactive_auth && password_configured),
    );
    payload.insert(
        "privateKeyConfigured".to_string(),
        Value::Bool(!is_keyboard_interactive_auth && private_key_configured),
    );
    payload.insert(
        "privateKeyPassphraseConfigured".to_string(),
        Value::Bool(!is_keyboard_interactive_auth && private_key_passphrase_configured),
    );
    if let Some(proxy) = payload.remove("proxy") {
        if !matches!(proxy, Value::Null) {
            payload.insert("proxy".to_string(), redact_ssh_proxy_secret(proxy)?);
        }
    }
    Ok(Value::Object(payload))
}

fn redact_ssh_proxy_secret(proxy: Value) -> Result<Value, String> {
    let mut payload = expect_object(proxy, "ssh settings proxy")?;
    let password_configured =
        match payload.remove("password") {
            Some(Value::String(value)) => !value.trim().is_empty(),
            Some(Value::Null) | None => false,
            Some(_) => return Err("ssh settings proxy.password must be a string".to_string()),
        } || matches!(payload.get("passwordConfigured"), Some(Value::Bool(true)));
    payload.insert(
        "passwordConfigured".to_string(),
        Value::Bool(password_configured),
    );
    Ok(Value::Object(payload))
}

/// system 快照出口脱敏：systemProxy.password 摘除并写 passwordConfigured 标记。
fn redact_system_settings(system: Value) -> Result<Value, String> {
    let mut payload = expect_object(system, "system settings payload")?;
    if let Some(proxy) = payload.remove(SYSTEM_SYSTEM_PROXY_KEY) {
        if !matches!(proxy, Value::Null) {
            payload.insert(
                SYSTEM_SYSTEM_PROXY_KEY.to_string(),
                redact_system_proxy_secret(proxy)?,
            );
        }
    }
    Ok(Value::Object(payload))
}

fn redact_system_proxy_secret(proxy: Value) -> Result<Value, String> {
    let mut payload = expect_object(proxy, "system settings systemProxy")?;
    let password_configured = match payload.remove("password") {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => {
            return Err("system settings systemProxy.password must be a string".to_string())
        }
    } || matches!(payload.get("passwordConfigured"), Some(Value::Bool(true)));
    payload.insert(
        "passwordConfigured".to_string(),
        Value::Bool(password_configured),
    );
    Ok(Value::Object(payload))
}
