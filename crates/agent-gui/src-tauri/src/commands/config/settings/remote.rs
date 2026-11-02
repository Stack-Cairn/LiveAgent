fn default_remote_gateway_port() -> u16 {
    // 桌面端 WebSocket 经该端口连接网关。
    443
}

fn default_local_gateway_port() -> u16 {
    50052
}

fn default_remote_auto_reconnect() -> bool {
    true
}

fn default_remote_heartbeat_interval() -> u64 {
    30
}

const GENERATED_AGENT_ID_PREFIX: &str = "agent-";

fn generate_agent_id() -> String {
    format!("{GENERATED_AGENT_ID_PREFIX}{}", Uuid::new_v4())
}

fn is_generated_agent_id(agent_id: &str) -> bool {
    agent_id
        .trim()
        .strip_prefix(GENERATED_AGENT_ID_PREFIX)
        .and_then(|value| Uuid::parse_str(value).ok())
        .is_some_and(|value| value.get_version_num() == 4)
}

impl Default for RemoteSettingsPayload {
    fn default() -> Self {
        Self {
            enabled: false,
            managed_local: false,
            local_gateway_port: default_local_gateway_port(),
            local_gateway_token: String::new(),
            gateway_url: String::new(),
            gateway_port: default_remote_gateway_port(),
            token: String::new(),
            agent_id: String::new(),
            auto_reconnect: default_remote_auto_reconnect(),
            heartbeat_interval: default_remote_heartbeat_interval(),
            enable_web_terminal: false,
            enable_web_ssh_terminal: false,
            enable_web_git: false,
            enable_web_tunnels: false,
        }
    }
}

impl RemoteSettingsPayload {
    /// Resolve the active connection without overwriting the user's external configuration.
    pub(crate) fn effective_gateway_settings(&self) -> Self {
        let mut settings = self.clone();
        if self.managed_local {
            settings.gateway_url = "http://127.0.0.1".to_string();
            settings.gateway_port = self.local_gateway_port;
            settings.token = self.local_gateway_token.clone();
        }
        settings
    }
}

pub(crate) fn normalize_remote_settings_payload(
    payload: RemoteSettingsPayload,
) -> RemoteSettingsPayload {
    RemoteSettingsPayload {
        enabled: payload.enabled,
        managed_local: payload.managed_local,
        local_gateway_port: if payload.local_gateway_port == 0 {
            default_local_gateway_port()
        } else {
            payload.local_gateway_port
        },
        local_gateway_token: payload.local_gateway_token.trim().to_string(),
        gateway_url: normalize_base_url_text(&payload.gateway_url),
        gateway_port: if payload.gateway_port == 0 {
            default_remote_gateway_port()
        } else {
            payload.gateway_port
        },
        token: payload.token.trim().to_string(),
        agent_id: payload.agent_id.trim().to_string(),
        auto_reconnect: payload.auto_reconnect,
        heartbeat_interval: payload.heartbeat_interval.max(1),
        enable_web_terminal: payload.enable_web_terminal,
        enable_web_ssh_terminal: payload.enable_web_ssh_terminal,
        enable_web_git: payload.enable_web_git,
        enable_web_tunnels: payload.enable_web_tunnels,
    }
}

fn normalize_base_url_text(input: &str) -> String {
    let trimmed = input.trim();
    let repaired = repair_url_scheme_slashes(trimmed);
    repaired.trim_end_matches('/').to_string()
}

fn repair_url_scheme_slashes(input: &str) -> String {
    for scheme in ["http:", "https:"] {
        if !input
            .get(..scheme.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(scheme))
        {
            continue;
        }
        let rest = &input[scheme.len()..];
        if rest.starts_with("//") {
            return input.to_string();
        }
        return format!("{scheme}//{}", rest.trim_start_matches('/'));
    }
    input.to_string()
}

pub(crate) fn parse_remote_settings_payload(value: Value) -> Result<RemoteSettingsPayload, String> {
    let parsed = serde_json::from_value::<RemoteSettingsPayload>(value)
        .map_err(|e| format!("解析 remote settings 失败：{e}"))?;
    Ok(normalize_remote_settings_payload(parsed))
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

pub(crate) fn load_remote_settings(conn: &Connection) -> Result<RemoteSettingsPayload, String> {
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

// Initialize installation identity and the local Gateway credential atomically. Only a
// database without a remote record opts into local hosting; existing records retain
// their external settings and explicit enabled=false, including generated identities.
pub(crate) fn ensure_remote_agent_id(conn: &mut Connection) -> Result<String, String> {
    let current = load_remote_settings(conn)?;
    if is_generated_agent_id(&current.agent_id) && !current.local_gateway_token.is_empty() {
        return Ok(current.agent_id);
    }

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("开启 Agent ID 初始化事务失败：{e}"))?;
    let mut settings = match load_remote(&tx)? {
        Some(value) => parse_remote_settings_payload(value)?,
        None => RemoteSettingsPayload {
            enabled: true,
            managed_local: true,
            ..RemoteSettingsPayload::default()
        },
    };
    let mut changed = false;
    if !is_generated_agent_id(&settings.agent_id) {
        settings.agent_id = generate_agent_id();
        changed = true;
    }
    if settings.local_gateway_token.is_empty() {
        // UUID v4 uses the OS random source. Two UUIDs provide 244 random bits;
        // this per-installation credential is independent of external credentials.
        settings.local_gateway_token =
            format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        changed = true;
    }
    if changed {
        persist_remote_settings(&tx, &settings)?;
    }
    let agent_id = settings.agent_id.clone();
    tx.commit()
        .map_err(|e| format!("提交 Agent ID 初始化事务失败：{e}"))?;
    Ok(agent_id)
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
fn save_remote(conn: &mut Connection, payload: Value) -> Result<RemoteSettingsPayload, String> {
    let mut normalized = parse_remote_settings_payload(payload)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("开启 {REMOTE_SETTINGS_TABLE} 事务失败：{e}"))?;
    let persisted = load_remote_settings(&tx)?;
    if !is_generated_agent_id(&persisted.agent_id) {
        return Err("Agent ID 尚未初始化".to_string());
    }
    // Agent ID 是安装身份，不接受设置页面或 IPC 载荷覆盖。
    normalized.agent_id = persisted.agent_id;
    // The local Gateway credential belongs to this installation. In particular,
    // legacy clients saving unrelated settings must not clear or replace it.
    normalized.local_gateway_token = persisted.local_gateway_token;
    persist_remote_settings(&tx, &normalized)?;
    tx.commit()
        .map_err(|e| format!("提交 {REMOTE_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(normalized)
}
