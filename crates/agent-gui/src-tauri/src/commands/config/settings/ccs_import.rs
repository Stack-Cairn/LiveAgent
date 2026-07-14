#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcsProviderImportItem {
    pub source_id: String,
    pub app_type: String,
    pub provider_type: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub request_format: String,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcsProvidersResponse {
    pub status: String,
    pub message: String,
    pub providers: Vec<CcsProviderImportItem>,
}

#[tauri::command]
pub async fn settings_list_ccswitch_providers() -> Result<CcsProvidersResponse, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let candidates = ccswitch_db_candidates();
        let path = candidates.iter().find(|path| path.exists());
        let providers = match path {
            Some(path) => list_ccswitch_liveagent_providers_from_db(path)?,
            None => Vec::new(),
        };
        let message = if providers.is_empty() {
            let checked = candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join("；");
            format!("未发现 ccswitch LiveAgent 供应商，已检查：{checked}")
        } else {
            format!("发现 {} 个 ccswitch LiveAgent 供应商", providers.len())
        };
        Ok(CcsProvidersResponse {
            status: "success".to_string(),
            message,
            providers,
        })
    })
    .await
    .map_err(|e| format!("settings_list_ccswitch_providers join 失败：{e}"))?
}

/// ccswitch (Tauri 应用 id `com.ccswitch.desktop`) 允许用户把数据目录整体迁移到
/// 自定义路径（例如同步到 OneDrive），迁移后真正使用的数据库不再位于默认的
/// `~/.cc-switch/` 下，而是记录在其自身配置目录的 `app_paths.json` 里
/// （`app_config_dir_override` 字段）。这里优先用该 override 目录，找不到再回退默认目录。
fn ccswitch_db_candidates() -> Vec<PathBuf> {
    let filename = format!("{}-{}.db", "cc", "switch");
    let mut candidates = Vec::new();
    if let Some(override_dir) = ccswitch_override_config_dir() {
        candidates.push(override_dir.join(&filename));
    }
    candidates.push(ccswitch_legacy_config_dir().join(&filename));
    // Windows 上 `HOME` 可能被 Git/MSYS 等注入且不等于真实用户目录，ccswitch
    // v3.10.3 曾据此把数据库写到 `%HOME%\.cc-switch\`，上游至今保留该位置作读取
    // 兜底（见其 config.rs get_app_config_dir），这里同样纳入候选。
    #[cfg(windows)]
    if let Ok(home_env) = std::env::var("HOME") {
        let trimmed = home_env.trim();
        if !trimmed.is_empty() {
            let legacy = PathBuf::from(trimmed)
                .join(format!(".{}-{}", "cc", "switch"))
                .join(&filename);
            if !candidates.contains(&legacy) {
                candidates.push(legacy);
            }
        }
    }
    candidates
}

fn ccswitch_legacy_config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(format!(".{}-{}", "cc", "switch"))
}

fn ccswitch_override_config_dir() -> Option<PathBuf> {
    let app_paths_file = dirs::config_dir()?
        .join("com.ccswitch.desktop")
        .join("app_paths.json");
    let content = fs::read_to_string(app_paths_file).ok()?;
    let value: Value = serde_json::from_str(&content).ok()?;
    let override_dir = value.get("app_config_dir_override")?.as_str()?.trim();
    if override_dir.is_empty() {
        return None;
    }
    Some(expand_home_prefix(override_dir))
}

/// 与上游 ccswitch 的 `resolve_path` 对齐：支持 `~`、`~/`、`~\` 三种写法
/// （Windows 用户习惯用反斜杠书写迁移路径，ccswitch 自身能解析这些形式）。
fn expand_home_prefix(path: &str) -> PathBuf {
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    } else if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn list_ccswitch_liveagent_providers_from_db(
    path: &std::path::Path,
) -> Result<Vec<CcsProviderImportItem>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("打开 ccswitch 数据库失败 {}：{e}", path.display()))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, app_type, name, settings_config
             FROM providers
             WHERE app_type IN ('codex', 'claude', 'claude-code', 'claude_code', 'gemini')
             ORDER BY
               CASE app_type
                 WHEN 'claude' THEN 0
                 WHEN 'claude-code' THEN 0
                 WHEN 'claude_code' THEN 0
                 WHEN 'codex' THEN 1
                 WHEN 'gemini' THEN 2
                 ELSE 3
               END,
               COALESCE(sort_index, 999999), created_at ASC, id ASC",
        )
        .map_err(|e| format!("读取 ccswitch providers 表失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| format!("查询 ccswitch providers 失败：{e}"))?;

    let mut providers = Vec::new();
    for row in rows {
        let (source_id, app_type, name, settings_config) =
            row.map_err(|e| format!("读取 ccswitch provider 行失败：{e}"))?;
        let Ok(config) = serde_json::from_str::<Value>(&settings_config) else {
            continue;
        };
        if let Some(provider) = ccs_provider_from_value(&source_id, &app_type, &name, &config) {
            providers.push(provider);
        }
    }
    Ok(providers)
}

fn ccs_provider_from_value(
    source_id: &str,
    app_type: &str,
    name: &str,
    config: &Value,
) -> Option<CcsProviderImportItem> {
    let provider_type = ccs_provider_type_from_app_type(app_type)?;
    let base_url = ccs_extract_base_url(provider_type, config).unwrap_or_default();
    let api_key = ccs_extract_api_key(provider_type, config).unwrap_or_default();
    Some(CcsProviderImportItem {
        source_id: source_id.to_string(),
        app_type: app_type.to_string(),
        provider_type: provider_type.to_string(),
        name: strip_ccswitch_suffix(name).to_string(),
        base_url,
        api_key,
        request_format: if provider_type == "codex" && ccs_is_chat_protocol(config) {
            "openai-completions".to_string()
        } else {
            "openai-responses".to_string()
        },
        models: ccs_extract_models(provider_type, config),
    })
}

fn ccs_provider_type_from_app_type(app_type: &str) -> Option<&'static str> {
    match app_type.trim().to_ascii_lowercase().as_str() {
        "codex" => Some("codex"),
        "claude" | "claude-code" | "claude_code" => Some("claude_code"),
        "gemini" => Some("gemini"),
        _ => None,
    }
}

fn ccs_extract_models(provider_type: &str, config: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut push_model = |value: String| {
        let model = value.trim().to_string();
        if !model.is_empty() && !out.iter().any(|item| item == &model) {
            out.push(model);
        }
    };

    match provider_type {
        "claude_code" => {
            for key in [
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            ] {
                if let Some(model) = ccs_string_at_path(config, &["env", key]) {
                    push_model(model);
                }
            }
        }
        "gemini" => {
            for key in ["GEMINI_MODEL", "GOOGLE_GEMINI_MODEL", "GOOGLE_MODEL"] {
                if let Some(model) = ccs_string_at_path(config, &["env", key]) {
                    push_model(model);
                }
            }
        }
        _ => {}
    }

    for key in ["model", "default_model", "defaultModel"] {
        if let Some(model) = ccs_string_at(config, &[key]) {
            push_model(model);
        }
        if let Some(model) = config
            .get("config")
            .and_then(|value| ccs_string_at(value, &[key]))
        {
            push_model(model);
        }
    }
    if let Some(config_text) = config.get("config").and_then(Value::as_str) {
        if let Some(model) = ccs_extract_toml_string_value(config_text, "model") {
            push_model(model);
        }
    }
    out
}

fn ccs_extract_base_url(provider_type: &str, config: &Value) -> Option<String> {
    match provider_type {
        "claude_code" => ccs_string_at_path(config, &["env", "ANTHROPIC_BASE_URL"])
            .or_else(|| ccs_string_at_path(config, &["config", "ANTHROPIC_BASE_URL"])),
        "gemini" => ccs_string_at_path(config, &["env", "GEMINI_BASE_URL"])
            .or_else(|| ccs_string_at_path(config, &["env", "GOOGLE_GEMINI_BASE_URL"]))
            .or_else(|| ccs_string_at_path(config, &["config", "base_url"])),
        _ => ccs_string_at(config, &["base_url", "baseURL"])
            .or_else(|| {
                config
                    .get("config")
                    .and_then(|value| ccs_string_at(value, &["base_url", "baseURL"]))
            })
            .or_else(|| {
                config
                    .get("config")
                    .and_then(Value::as_str)
                    .and_then(|text| ccs_extract_toml_string_value(text, "base_url"))
            }),
    }
    .map(|value| value.trim().trim_end_matches('/').to_string())
}

fn ccs_extract_api_key(provider_type: &str, config: &Value) -> Option<String> {
    match provider_type {
        "claude_code" => ccs_string_at_path(config, &["env", "ANTHROPIC_AUTH_TOKEN"])
            .or_else(|| ccs_string_at_path(config, &["env", "ANTHROPIC_API_KEY"])),
        "gemini" => ccs_string_at_path(config, &["env", "GEMINI_API_KEY"])
            .or_else(|| ccs_string_at_path(config, &["env", "GOOGLE_API_KEY"])),
        _ => config
            .pointer("/env/OPENAI_API_KEY")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                config
                    .pointer("/auth/OPENAI_API_KEY")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| ccs_string_at(config, &["apiKey", "api_key"]))
            .or_else(|| {
                config
                    .get("config")
                    .and_then(|value| ccs_string_at(value, &["apiKey", "api_key"]))
            }),
    }
}

fn ccs_is_chat_protocol(config: &Value) -> bool {
    ccs_string_at(config, &["api_format", "apiFormat"])
        .map(|value| ccs_matches_chat_protocol(&value))
        .unwrap_or(false)
        || config
            .get("config")
            .and_then(Value::as_str)
            .and_then(|text| ccs_extract_toml_string_value(text, "wire_api"))
            .map(|value| ccs_matches_chat_protocol(&value))
            .unwrap_or(false)
        || ccs_extract_base_url("codex", config)
            .map(|value| value.to_ascii_lowercase().ends_with("/chat/completions"))
            .unwrap_or(false)
}

fn ccs_matches_chat_protocol(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "chat" | "chat_completions" | "chat-completions" | "openai_chat" | "openai-chat"
    )
}

fn ccs_string_at(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::to_string)
}

fn ccs_string_at_path(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_string)
}

fn ccs_extract_toml_string_value(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix(key) else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start();
        let quote = rest.chars().next()?;
        if quote != '"' && quote != '\'' {
            continue;
        }
        let rest = &rest[quote.len_utf8()..];
        let end = rest.find(quote)?;
        return Some(rest[..end].to_string());
    }
    None
}

fn strip_ccswitch_suffix(name: &str) -> &str {
    name.trim()
        .strip_suffix("（ccswitch）")
        .or_else(|| name.trim().strip_suffix("(ccswitch)"))
        .unwrap_or_else(|| name.trim())
}
