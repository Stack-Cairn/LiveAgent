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

fn redact_provider_credential(provider: Value) -> Result<Value, String> {
    let mut payload = expect_object(provider, "provider settings item")?;
    let api_key_configured =
        match payload.remove("apiKey") {
            Some(Value::String(value)) => !value.trim().is_empty(),
            Some(Value::Null) | None => false,
            Some(_) => return Err("provider settings apiKey must be a string".to_string()),
        } || matches!(payload.get("apiKeyConfigured"), Some(Value::Bool(true)));
    payload.insert(
        "apiKeyConfigured".to_string(),
        Value::Bool(api_key_configured),
    );
    if let Some(usage_query) = payload.remove("usageQuery") {
        payload.insert("usageQuery".to_string(), redact_usage_query_secrets(usage_query)?);
    }
    Ok(Value::Object(payload))
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
fn save_providers(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let providers = expect_array(payload, "settings_save_providers payload")?;
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {PROVIDER_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(PROVIDER_SETTINGS_DELETE_SQL, [])
        .map_err(|e| format!("清空 {PROVIDER_SETTINGS_TABLE} 失败：{e}"))?;

    let mut seen = HashSet::new();
    for (sort_index, provider) in providers.into_iter().enumerate() {
        let provider = expect_object(provider, "settings_save_providers payload[]")?;
        let provider_id =
            extract_non_empty_string(&provider, "id", "settings_save_providers payload[]")?;
        if !seen.insert(provider_id.clone()) {
            return Err(format!("provider_settings.provider_id 重复：{provider_id}"));
        }

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
