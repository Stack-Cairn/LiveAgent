pub(crate) fn load_providers(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(PROVIDER_SETTINGS_SELECT_SQL)
        .map_err(|e| format!("准备读取 {PROVIDER_SETTINGS_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取 {PROVIDER_SETTINGS_TABLE} 失败：{e}"))?;

    let mut providers = Vec::new();
    for row in rows {
        let (provider_id, payload_json) =
            row.map_err(|e| format!("读取 {PROVIDER_SETTINGS_TABLE} 行失败：{e}"))?;
        let mut provider = expect_object(
            parse_json(&payload_json, PROVIDER_SETTINGS_TABLE)?,
            PROVIDER_SETTINGS_TABLE,
        )?;
        inject_string_field(&mut provider, "id", provider_id);
        providers.push(Value::Object(provider));
    }

    if providers.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Array(providers)))
    }
}
pub(crate) fn redact_provider_credentials(providers: Value) -> Result<Value, String> {
    let items = providers
        .as_array()
        .ok_or_else(|| "provider settings payload is not an array".to_string())?;
    let mut redacted = Vec::with_capacity(items.len());
    for provider in items {
        redacted.push(redact_provider_credential(provider.clone())?);
    }
    Ok(Value::Array(redacted))
}

/// 摘除 `apiKey` 并写 `apiKeyConfigured` 标记。`label` 用于错误信息。
fn redact_api_key_field(payload: &mut Map<String, Value>, label: &str) -> Result<(), String> {
    let api_key_configured = match payload.remove("apiKey") {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => return Err(format!("{label} apiKey must be a string")),
    } || matches!(payload.get("apiKeyConfigured"), Some(Value::Bool(true)));
    payload.insert(
        "apiKeyConfigured".to_string(),
        Value::Bool(api_key_configured),
    );
    Ok(())
}

/// 公开快照脱敏：供应商默认 Key、`credentials[]` 每一把 Key 与用量查询秘密
/// 都只保留 configured 标记。凭据的其他字段（id / label / enabled / modelScope /
/// lastModels）原样保留，接收端按 id 从本地记录恢复 Key 值。
fn redact_provider_credential(provider: Value) -> Result<Value, String> {
    let mut payload = expect_object(provider, "provider settings item")?;
    redact_api_key_field(&mut payload, "provider settings")?;
    if let Some(credentials) = payload.remove("credentials") {
        payload.insert(
            "credentials".to_string(),
            redact_provider_credential_list(credentials)?,
        );
    }
    if let Some(usage_query) = payload.remove("usageQuery") {
        payload.insert("usageQuery".to_string(), redact_usage_query_secrets(usage_query)?);
    }
    Ok(Value::Object(payload))
}

fn redact_provider_credential_list(credentials: Value) -> Result<Value, String> {
    match credentials {
        Value::Null => Ok(Value::Null),
        Value::Array(items) => {
            let mut redacted = Vec::with_capacity(items.len());
            for item in items {
                let mut payload = expect_object(item, "provider settings credentials[]")?;
                redact_api_key_field(&mut payload, "provider settings credentials[]")?;
                redacted.push(Value::Object(payload));
            }
            Ok(Value::Array(redacted))
        }
        _ => Err("provider settings credentials must be an array".to_string()),
    }
}

fn redact_usage_query_secrets(usage_query: Value) -> Result<Value, String> {
    let mut payload = expect_object(usage_query, "provider usage query settings")?;
    let api_key_configured = match payload.remove("apiKey") {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => return Err("provider usage query apiKey must be a string".to_string()),
    } || matches!(payload.get("apiKeyConfigured"), Some(Value::Bool(true)));
    let access_token_configured = match payload.remove("accessToken") {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => return Err("provider usage query accessToken must be a string".to_string()),
    } || matches!(payload.get("accessTokenConfigured"), Some(Value::Bool(true)));
    let secret_access_key_configured = match payload.remove("secretAccessKey") {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => {
            return Err("provider usage query secretAccessKey must be a string".to_string())
        }
    } || matches!(
        payload.get("secretAccessKeyConfigured"),
        Some(Value::Bool(true))
    );
    payload.insert("apiKeyConfigured".to_string(), Value::Bool(api_key_configured));
    payload.insert("accessTokenConfigured".to_string(), Value::Bool(access_token_configured));
    payload.insert(
        "secretAccessKeyConfigured".to_string(),
        Value::Bool(secret_access_key_configured),
    );
    Ok(Value::Object(payload))
}
/// 已落库的供应商 Key 值，按供应商 id 索引；`credentials` 再按凭据 id 索引。
#[derive(Debug, Default, Clone, PartialEq)]
struct StoredProviderKeys {
    api_key: String,
    credentials: HashMap<String, String>,
}

fn non_empty_api_key(payload: &Map<String, Value>) -> Option<String> {
    payload
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn api_key_configured_flag(payload: &Map<String, Value>) -> bool {
    matches!(payload.get("apiKeyConfigured"), Some(Value::Bool(true)))
}

fn collect_stored_provider_keys(conn: &Connection) -> Result<HashMap<String, StoredProviderKeys>, String> {
    let Some(Value::Array(providers)) = load_providers(conn)? else {
        return Ok(HashMap::new());
    };
    let mut stored = HashMap::with_capacity(providers.len());
    for provider in providers {
        let Value::Object(provider) = provider else {
            continue;
        };
        let Some(provider_id) = provider.get("id").and_then(Value::as_str) else {
            continue;
        };
        let mut keys = StoredProviderKeys {
            api_key: non_empty_api_key(&provider).unwrap_or_default(),
            credentials: HashMap::new(),
        };
        if let Some(Value::Array(credentials)) = provider.get("credentials") {
            for credential in credentials {
                let Some(credential) = credential.as_object() else {
                    continue;
                };
                let Some(credential_id) = credential.get("id").and_then(Value::as_str) else {
                    continue;
                };
                if let Some(api_key) = non_empty_api_key(credential) {
                    keys.credentials
                        .insert(credential_id.to_string(), api_key);
                }
            }
        }
        stored.insert(provider_id.to_string(), keys);
    }
    Ok(stored)
}

/// 保存路径的"保留旧值"规则：收到的供应商若某把 Key 为空却标着
/// `apiKeyConfigured: true`（即经过公开快照脱敏的形状），按 id 回填已落库的
/// Key 值，不让脱敏快照把已存 Key 清空。默认 Key 按供应商 id 回填；
/// `credentials[]` 按凭据 id 回填，首把凭据缺失时退回供应商默认 Key（与 TS
/// 归一化 `apiKey == credentials[0].apiKey` 的约定一致）。用量查询秘密不在此处理。
fn restore_stored_provider_keys(
    provider: &mut Map<String, Value>,
    stored: Option<&StoredProviderKeys>,
) {
    let mut api_key = non_empty_api_key(provider);
    if api_key.is_none() && api_key_configured_flag(provider) {
        if let Some(stored_key) = stored
            .map(|keys| keys.api_key.as_str())
            .filter(|value| !value.is_empty())
        {
            provider.insert("apiKey".to_string(), Value::String(stored_key.to_string()));
            api_key = Some(stored_key.to_string());
        }
    }

    let Some(Value::Array(credentials)) = provider.get_mut("credentials") else {
        return;
    };
    for (index, credential) in credentials.iter_mut().enumerate() {
        let Some(credential) = credential.as_object_mut() else {
            continue;
        };
        if non_empty_api_key(credential).is_some() || !api_key_configured_flag(credential) {
            continue;
        }
        let credential_id = credential.get("id").and_then(Value::as_str);
        let restored = credential_id
            .and_then(|id| stored.and_then(|keys| keys.credentials.get(id)))
            .cloned()
            .or_else(|| (index == 0).then(|| api_key.clone()).flatten());
        if let Some(restored) = restored {
            credential.insert("apiKey".to_string(), Value::String(restored));
        }
    }

    // 默认 Key 仍为空而首把凭据已恢复出 Key 时补齐，维持 apiKey == credentials[0].apiKey。
    if api_key.is_none() {
        let primary_key = credentials
            .first()
            .and_then(Value::as_object)
            .and_then(non_empty_api_key);
        if let Some(primary_key) = primary_key {
            provider.insert("apiKey".to_string(), Value::String(primary_key));
        }
    }
}

fn save_providers(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let providers = expect_array(payload, "settings_save_providers payload")?;
    let stored_keys = collect_stored_provider_keys(conn)?;
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {PROVIDER_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(PROVIDER_SETTINGS_DELETE_SQL, [])
        .map_err(|e| format!("清空 {PROVIDER_SETTINGS_TABLE} 失败：{e}"))?;

    let mut seen = HashSet::new();
    for (sort_index, provider) in providers.into_iter().enumerate() {
        let mut provider = expect_object(provider, "settings_save_providers payload[]")?;
        let provider_id =
            extract_non_empty_string(&provider, "id", "settings_save_providers payload[]")?;
        if !seen.insert(provider_id.clone()) {
            return Err(format!("provider_settings.provider_id 重复：{provider_id}"));
        }
        restore_stored_provider_keys(&mut provider, stored_keys.get(&provider_id));

        tx.execute(
            PROVIDER_SETTINGS_INSERT_SQL,
            params![
                provider_id,
                serialize_json(&Value::Object(provider), PROVIDER_SETTINGS_TABLE)?,
                sort_index as i64,
                updated_at
            ],
        )
        .map_err(|e| format!("写入 {PROVIDER_SETTINGS_TABLE} 失败：{e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("提交 {PROVIDER_SETTINGS_TABLE} 事务失败：{e}"))?;
    // 标脏放在 commit 之后：事务回滚时不该触发自动同步。
    crate::services::webdav_auto_sync::mark_dirty();
    Ok(())
}
