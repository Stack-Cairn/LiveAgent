#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcsProviderImportItem {
    pub source_id: String,
    pub app_type: String,
    pub provider_type: String,
    pub name: String,
    pub base_url: String,
    pub is_full_url: bool,
    pub models_url: String,
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
    // meta 是 ccswitch providers 表的独立列（TEXT NOT NULL DEFAULT '{}'），
    // Claude Desktop 的接入模式、上游格式与模型路由都存在这里，而不在
    // settings_config。极老的 v0 库尚未迁移出 meta 列（LiveAgent 只读打开、
    // 不会触发 ccswitch 迁移），这种库也早于 Claude Desktop 支持，退化为
    // 空 meta 查询即可。
    let has_meta_column = ccswitch_providers_has_meta_column(&conn);
    let meta_select = if has_meta_column { "meta" } else { "NULL" };
    let sql = format!(
        "SELECT id, app_type, name, settings_config, {meta_select} AS meta
         FROM providers
         WHERE app_type IN (
           'codex',
           'claude', 'claude-code', 'claude_code',
           'claude-desktop', 'claude_desktop', 'claudeDesktop',
           'gemini',
           'grokbuild', 'grok-build', 'grok_build', 'grok', 'xai',
           'deepseek'
         )
         ORDER BY
           CASE app_type
             WHEN 'claude' THEN 0
             WHEN 'claude-code' THEN 0
             WHEN 'claude_code' THEN 0
             WHEN 'claude-desktop' THEN 0
             WHEN 'claude_desktop' THEN 0
             WHEN 'claudeDesktop' THEN 0
             WHEN 'codex' THEN 1
             WHEN 'gemini' THEN 2
             WHEN 'grokbuild' THEN 3
             WHEN 'grok-build' THEN 3
             WHEN 'grok_build' THEN 3
             WHEN 'grok' THEN 3
             WHEN 'xai' THEN 3
             WHEN 'deepseek' THEN 4
             ELSE 5
           END,
           COALESCE(sort_index, 999999), created_at ASC, id ASC"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("读取 ccswitch providers 表失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| format!("查询 ccswitch providers 失败：{e}"))?;

    let mut providers = Vec::new();
    for row in rows {
        let (source_id, app_type, name, settings_config, meta_str) =
            row.map_err(|e| format!("读取 ccswitch provider 行失败：{e}"))?;
        let Ok(config) = serde_json::from_str::<Value>(&settings_config) else {
            continue;
        };
        // meta 解析失败按空处理，不影响该行其余字段的导入。
        let meta = meta_str
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or(Value::Null);
        if let Some(provider) =
            ccs_provider_from_value(&source_id, &app_type, &name, &config, &meta)
        {
            providers.push(provider);
        }
    }
    Ok(providers)
}

fn ccswitch_providers_has_meta_column(conn: &Connection) -> bool {
    let Ok(mut stmt) = conn.prepare("PRAGMA table_info(providers)") else {
        return false;
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) else {
        return false;
    };
    for name in rows.flatten() {
        if name == "meta" {
            return true;
        }
    }
    false
}

fn ccs_provider_from_value(
    source_id: &str,
    app_type: &str,
    name: &str,
    config: &Value,
    meta: &Value,
) -> Option<CcsProviderImportItem> {
    let mapped_provider_type = ccs_provider_type_from_app_type(app_type)?;

    // Claude Desktop（ccswitch app_type=claude-desktop）供应商归入 Anthropic 协议标签，
    // 但只有 Anthropic 原生格式的才可直接作为 claude_code 导入：代理模式声明的
    // openai_chat / openai_responses / gemini_native 上游需要本地转协议，直接当作
    // Anthropic 供应商导入会得到协议不符的坏配置，这里跳过。
    let is_claude_desktop = ccs_is_claude_desktop_app_type(app_type);
    if is_claude_desktop && !ccs_claude_desktop_is_anthropic(meta) {
        return None;
    }

    let mapped_base_url = ccs_extract_base_url(mapped_provider_type, config).unwrap_or_default();
    let provider_type = if mapped_provider_type == "codex"
        && ccs_is_chat_protocol(config)
        && is_official_deepseek_base_url(&mapped_base_url)
    {
        "deepseek"
    } else {
        mapped_provider_type
    };
    let base_url = ccs_extract_base_url(provider_type, config).unwrap_or_default();
    let api_key = ccs_extract_api_key(provider_type, config).unwrap_or_default();

    let mut models = ccs_extract_models(provider_type, config);
    if is_claude_desktop {
        // Claude Desktop 的模型不写在 env，而是 meta.claudeDesktopModelRoutes：
        // 直连模式 route_id 即模型名，映射模式取 route.model 的真实上游模型。
        for model in ccs_extract_claude_desktop_models(meta) {
            if !models.iter().any(|item| item == &model) {
                models.push(model);
            }
        }
    }

    Some(CcsProviderImportItem {
        source_id: source_id.to_string(),
        app_type: app_type.to_string(),
        provider_type: provider_type.to_string(),
        name: strip_ccswitch_suffix(name).to_string(),
        base_url,
        is_full_url: config
            .get("meta")
            .and_then(|meta| meta.get("isFullUrl").or_else(|| meta.get("is_full_url")))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        models_url: config
            .get("meta")
            .and_then(|meta| meta.get("modelsUrl").or_else(|| meta.get("models_url")))
            .or_else(|| config.get("modelsUrl").or_else(|| config.get("models_url")))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
        api_key,
        request_format: if provider_type == "deepseek" {
            "openai-completions".to_string()
        } else if provider_type == "xai" {
            // Grok / xAI 在 LiveAgent 固定 Responses。
            "openai-responses".to_string()
        } else if provider_type == "codex" && ccs_is_chat_protocol(config) {
            "openai-completions".to_string()
        } else {
            "openai-responses".to_string()
        },
        models,
    })
}

fn ccs_provider_type_from_app_type(app_type: &str) -> Option<&'static str> {
    match app_type.trim().to_ascii_lowercase().as_str() {
        "codex" => Some("codex"),
        // Claude Desktop 与 Claude Code CLI 同为 Anthropic 协议供应商。
        "claude" | "claude-code" | "claude_code" | "claude-desktop" | "claude_desktop"
        | "claudedesktop" => Some("claude_code"),
        "gemini" => Some("gemini"),
        "deepseek" => Some("deepseek"),
        // CC-Switch Grok Build 应用桶（与上游 AppType::GrokBuild 别名对齐）。
        "grokbuild" | "grok-build" | "grok_build" | "grok" | "xai" => Some("xai"),
        _ => None,
    }
}

fn ccs_is_claude_desktop_app_type(app_type: &str) -> bool {
    matches!(
        app_type.trim().to_ascii_lowercase().as_str(),
        "claude-desktop" | "claude_desktop" | "claudedesktop"
    )
}

/// Claude Desktop 供应商是否使用 Anthropic 原生上游格式。
///
/// ccswitch 直连模式固定写 meta.apiFormat = "anthropic"；映射（proxy）模式可以声明
/// openai_chat / openai_responses / gemini_native 等格式，由 ccswitch 内置网关转协议。
/// 缺省（历史数据无 apiFormat）按 Anthropic 处理，与 ccswitch 的默认值一致。
fn ccs_claude_desktop_is_anthropic(meta: &Value) -> bool {
    match meta.get("apiFormat").and_then(Value::as_str) {
        Some(format) => format.trim().eq_ignore_ascii_case("anthropic") || format.trim().is_empty(),
        None => true,
    }
}

/// 从 meta.claudeDesktopModelRoutes 提取 Claude Desktop 的模型列表。
///
/// 路由表形如 { "<route_id>": { "model": "<上游模型>", ... } }：直连模式下 route_id
/// 就是模型名（model 字段同值）；映射模式下 model 字段才是真实上游模型。统一优先取
/// model 字段，为空时回退 route_id。
fn ccs_extract_claude_desktop_models(meta: &Value) -> Vec<String> {
    let Some(routes) = meta
        .get("claudeDesktopModelRoutes")
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (route_id, route) in routes {
        let model = route
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| route_id.trim());
        if model.is_empty() || out.iter().any(|item| item == model) {
            continue;
        }
        out.push(model.to_string());
    }
    out.sort();
    out
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
        "deepseek" => {
            for key in [
                "DEEPSEEK_MODEL",
                "DEEPSEEK_DEFAULT_MODEL",
                "DEEPSEEK_CHAT_MODEL",
                "DEEPSEEK_REASONER_MODEL",
            ] {
                if let Some(model) = ccs_string_at_path(config, &["env", key])
                    .or_else(|| ccs_string_at_path(config, &["config", key]))
                {
                    push_model(model);
                }
            }
        }
        "xai" => {
            // Grok Build：settings_config.config 为 TOML，[models].default 与
            // [model."<id>"].model 为模型 id。
            if let Some(config_text) = config.get("config").and_then(Value::as_str) {
                if let Some(model) = ccs_extract_toml_string_value(config_text, "default") {
                    push_model(model);
                }
                if let Some(model) = ccs_extract_toml_string_value(config_text, "model") {
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
        "deepseek" => ccs_string_at_path(config, &["env", "DEEPSEEK_BASE_URL"])
            .or_else(|| ccs_string_at_path(config, &["config", "DEEPSEEK_BASE_URL"]))
            .or_else(|| ccs_string_at(config, &["base_url", "baseURL"]))
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
        "xai" => ccs_string_at(config, &["base_url", "baseURL"])
            .or_else(|| {
                config
                    .get("config")
                    .and_then(|value| ccs_string_at(value, &["base_url", "baseURL"]))
            })
            .or_else(|| {
                // Grok Build：config 字段是完整 TOML 文本。
                config
                    .get("config")
                    .and_then(Value::as_str)
                    .and_then(|text| ccs_extract_toml_string_value(text, "base_url"))
            }),
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
        "deepseek" => ccs_string_at_path(config, &["env", "DEEPSEEK_API_KEY"])
            .or_else(|| ccs_string_at_path(config, &["config", "DEEPSEEK_API_KEY"]))
            .or_else(|| {
                config
                    .pointer("/auth/DEEPSEEK_API_KEY")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| {
                config
                    .pointer("/env/OPENAI_API_KEY")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| {
                config
                    .pointer("/auth/OPENAI_API_KEY")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| ccs_string_at(config, &["apiKey", "api_key"])),
        "xai" => config
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
            })
            .or_else(|| {
                // Grok Build TOML：api_key = "..."
                config
                    .get("config")
                    .and_then(Value::as_str)
                    .and_then(|text| ccs_extract_toml_string_value(text, "api_key"))
            }),
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

fn is_official_deepseek_base_url(value: &str) -> bool {
    reqwest::Url::parse(value.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "api.deepseek.com")
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
