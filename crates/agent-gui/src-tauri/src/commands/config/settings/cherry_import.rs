#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryProviderImportItem {
    pub source_id: String,
    pub source_version: String,
    pub source_provider_type: String,
    pub provider_type: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub api_key_count: usize,
    pub request_format: String,
    pub enabled: bool,
    pub importable: bool,
    pub reason: String,
    pub warning: String,
    pub excluded_model_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryProvidersResponse {
    pub status: String,
    pub message: String,
    pub version: String,
    pub data_path: String,
    pub total_provider_count: usize,
    pub enabled_provider_count: usize,
    pub providers: Vec<CherryProviderImportItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum CherryImportProtocol {
    Claude,
    CodexCompletions,
    CodexResponses,
    DeepSeek,
    Gemini,
}

impl CherryImportProtocol {
    fn provider_type(self) -> &'static str {
        match self {
            Self::Claude => "claude_code",
            Self::CodexCompletions | Self::CodexResponses => "codex",
            Self::DeepSeek => "deepseek",
            Self::Gemini => "gemini",
        }
    }

    fn request_format(self) -> &'static str {
        match self {
            Self::CodexCompletions | Self::DeepSeek => "openai-completions",
            _ => "openai-responses",
        }
    }

    fn variant(self) -> &'static str {
        match self {
            Self::Claude => "anthropic",
            Self::CodexCompletions => "openai-chat",
            Self::CodexResponses => "openai-responses",
            Self::DeepSeek => "deepseek-chat",
            Self::Gemini => "gemini",
        }
    }
}

#[derive(Debug)]
struct CherryImportGroup {
    protocol: CherryImportProtocol,
    base_url: String,
    models: Vec<String>,
}

#[derive(Debug)]
struct CherryImportScan {
    version: String,
    data_path: PathBuf,
    total_provider_count: usize,
    enabled_provider_count: usize,
    providers: Vec<CherryProviderImportItem>,
}

#[tauri::command]
pub async fn settings_list_cherry_studio_providers() -> Result<CherryProvidersResponse, String> {
    tauri::async_runtime::spawn_blocking(|| {
        cherry_scan_candidates(&cherry_user_data_candidates(), false)
    })
    .await
    .map_err(|error| format!("settings_list_cherry_studio_providers join 失败：{error}"))?
}

#[tauri::command]
pub async fn settings_list_cherry_studio_providers_from_path(
    data_path: String,
) -> Result<CherryProvidersResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = PathBuf::from(data_path.trim());
        if selected.as_os_str().is_empty() {
            return Err("未选择 Cherry Studio 数据目录".to_string());
        }
        cherry_scan_candidates(&cherry_manual_data_candidates(&selected), true)
    })
    .await
    .map_err(|error| {
        format!("settings_list_cherry_studio_providers_from_path join 失败：{error}")
    })?
}

fn cherry_scan_candidates(
    candidates: &[PathBuf],
    require_data: bool,
) -> Result<CherryProvidersResponse, String> {
    let mut read_errors = Vec::new();

    for data_path in candidates {
        let sqlite_path = data_path.join("cherrystudio.sqlite");
        if !sqlite_path.is_file() {
            continue;
        }
        match cherry_read_v2(&sqlite_path, data_path) {
            Ok(scan) => return Ok(cherry_scan_response(scan)),
            Err(error) => read_errors.push(format!("{}：{error}", data_path.display())),
        }
    }

    for data_path in candidates {
        let leveldb_path = data_path.join("Local Storage").join("leveldb");
        if !leveldb_path.is_dir() {
            continue;
        }
        match cherry_read_v1(&leveldb_path, data_path) {
            Ok(scan) => return Ok(cherry_scan_response(scan)),
            Err(error) => read_errors.push(format!("{}：{error}", data_path.display())),
        }
    }

    if require_data {
        if !read_errors.is_empty() {
            return Err(format!(
                "选择的目录不是有效的 Cherry Studio 数据目录：{}",
                read_errors.join("；")
            ));
        }
        return Err(format!(
            "选择的目录中未发现 Cherry Studio 数据，请检查以下位置：{}",
            candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join("、")
        ));
    }

    if !read_errors.is_empty() {
        return Err(read_errors.join("；"));
    }
    Ok(CherryProvidersResponse {
        status: "success".to_string(),
        message: "未发现 Cherry Studio 供应商数据".to_string(),
        version: String::new(),
        data_path: candidates
            .first()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        total_provider_count: 0,
        enabled_provider_count: 0,
        providers: Vec::new(),
    })
}

fn cherry_manual_data_candidates(selected: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    cherry_push_unique_path(&mut candidates, selected.to_path_buf());
    cherry_push_unique_path(&mut candidates, selected.join("data"));
    cherry_push_unique_path(&mut candidates, selected.join("CherryStudio"));
    cherry_push_unique_path(&mut candidates, selected.join("Cherry Studio"));

    if selected.file_name().is_some_and(|name| name == "leveldb")
        && selected.parent().and_then(Path::file_name)
            == Some(std::ffi::OsStr::new("Local Storage"))
    {
        if let Some(user_data) = selected.parent().and_then(Path::parent) {
            cherry_push_unique_path(&mut candidates, user_data.to_path_buf());
        }
    } else if selected
        .file_name()
        .is_some_and(|name| name == "Local Storage")
    {
        if let Some(user_data) = selected.parent() {
            cherry_push_unique_path(&mut candidates, user_data.to_path_buf());
        }
    }
    candidates
}

fn cherry_scan_response(scan: CherryImportScan) -> CherryProvidersResponse {
    let ready_count = scan.providers.iter().filter(|item| item.importable).count();
    CherryProvidersResponse {
        status: "success".to_string(),
        message: format!(
            "Cherry Studio {}：发现 {} 个供应商，{} 个可同步配置",
            scan.version, scan.total_provider_count, ready_count
        ),
        version: scan.version,
        data_path: scan.data_path.to_string_lossy().into_owned(),
        total_provider_count: scan.total_provider_count,
        enabled_provider_count: scan.enabled_provider_count,
        providers: scan.providers,
    }
}

fn cherry_user_data_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return candidates;
    };
    let cherry_home = home.join(".cherrystudio");

    cherry_collect_boot_config_paths(&cherry_home.join("boot-config.json"), &mut candidates);
    cherry_collect_legacy_config_paths(
        &cherry_home.join("config").join("config.json"),
        &mut candidates,
    );

    #[cfg(target_os = "macos")]
    cherry_push_unique_path(
        &mut candidates,
        home.join("Library")
            .join("Application Support")
            .join("CherryStudio"),
    );
    #[cfg(target_os = "windows")]
    if let Some(config_dir) = dirs::config_dir() {
        cherry_push_unique_path(&mut candidates, config_dir.join("CherryStudio"));
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let config_dir = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        cherry_push_unique_path(&mut candidates, config_dir.join("CherryStudio"));
    }
    candidates
}

fn cherry_collect_boot_config_paths(path: &std::path::Path, out: &mut Vec<PathBuf>) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let Ok(config) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let Some(paths) = config.get("app.user_data_path").and_then(Value::as_object) else {
        return;
    };
    for value in paths.values().filter_map(Value::as_str) {
        cherry_push_unique_path(out, PathBuf::from(value));
    }
}

fn cherry_collect_legacy_config_paths(path: &std::path::Path, out: &mut Vec<PathBuf>) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let Ok(config) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let Some(value) = config.get("appDataPath") else {
        return;
    };
    if let Some(path) = value.as_str() {
        cherry_push_unique_path(out, PathBuf::from(path));
        return;
    }
    if let Some(items) = value.as_array() {
        for path in items
            .iter()
            .filter_map(|item| item.get("dataPath"))
            .filter_map(Value::as_str)
        {
            cherry_push_unique_path(out, PathBuf::from(path));
        }
    }
}

fn cherry_push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn cherry_read_v1(
    leveldb_path: &std::path::Path,
    data_path: &std::path::Path,
) -> Result<CherryImportScan, String> {
    let key = b"persist:cherry-studio";
    let records = leveldb_core::read_dir(leveldb_path)
        .map_err(|error| format!("读取 Cherry Studio LevelDB 失败：{error}"))?;
    let latest = records
        .iter()
        .filter(|record| record.key.windows(key.len()).any(|window| window == key))
        .max_by_key(|record| record.seq)
        .ok_or_else(|| "Cherry Studio LevelDB 中没有 persist:cherry-studio".to_string())?;
    if latest.deleted {
        return Err("Cherry Studio 供应商数据已被删除".to_string());
    }
    let persisted_text = cherry_decode_chromium_string(&latest.value)?;
    let persisted = serde_json::from_str::<Value>(&persisted_text)
        .map_err(|error| format!("解析 Cherry Studio Redux 根数据失败：{error}"))?;
    let llm = match persisted.get("llm") {
        Some(Value::String(text)) => serde_json::from_str::<Value>(text)
            .map_err(|error| format!("解析 Cherry Studio llm 数据失败：{error}"))?,
        Some(value) => value.clone(),
        None => return Err("Cherry Studio Redux 数据缺少 llm".to_string()),
    };
    let source_providers = llm
        .get("providers")
        .and_then(Value::as_array)
        .ok_or_else(|| "Cherry Studio llm.providers 格式无效".to_string())?;
    let version = cherry_read_version(data_path).unwrap_or_else(|| "1.x".to_string());
    let enabled_provider_count = source_providers
        .iter()
        .filter(|provider| {
            provider
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        })
        .count();
    let mut providers = Vec::new();
    for provider in source_providers {
        cherry_append_v1_provider(provider, &version, &mut providers);
    }
    Ok(CherryImportScan {
        version,
        data_path: data_path.to_path_buf(),
        total_provider_count: source_providers.len(),
        enabled_provider_count,
        providers,
    })
}

fn cherry_decode_chromium_string(bytes: &[u8]) -> Result<String, String> {
    match bytes.first().copied() {
        Some(0) => {
            let payload = &bytes[1..];
            if !payload.len().is_multiple_of(2) {
                return Err("Cherry Studio Local Storage UTF-16 数据长度无效".to_string());
            }
            let utf16 = payload
                .chunks_exact(2)
                .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                .collect::<Vec<_>>();
            String::from_utf16(&utf16)
                .map_err(|error| format!("解码 Cherry Studio Local Storage 失败：{error}"))
        }
        Some(1) => Ok(bytes[1..].iter().map(|byte| char::from(*byte)).collect()),
        _ => Err("未知的 Cherry Studio Local Storage 字符串编码".to_string()),
    }
}

fn cherry_append_v1_provider(
    provider: &Value,
    version: &str,
    out: &mut Vec<CherryProviderImportItem>,
) {
    let source_id = cherry_value_string(provider, "id");
    let name = cherry_value_string(provider, "name");
    let source_provider_type = cherry_value_string(provider, "type");
    if source_id.is_empty() || name.is_empty() {
        return;
    }
    let enabled = provider
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let api_keys = cherry_split_v1_api_keys(&cherry_value_string(provider, "apiKey"));
    let api_key = api_keys.first().cloned().unwrap_or_default();
    let auth_type = cherry_value_string(provider, "authType");
    let source_models = provider
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut groups = Vec::<CherryImportGroup>::new();
    let mut excluded_model_count = 0usize;

    for model in &source_models {
        let model_id = cherry_value_string(model, "id");
        let explicit_endpoint = cherry_value_string(model, "endpoint_type");
        let protocol = if explicit_endpoint.is_empty() {
            cherry_v1_default_protocol(&source_provider_type)
        } else {
            cherry_protocol_from_endpoint(&explicit_endpoint)
        };
        let Some(protocol) = protocol else {
            excluded_model_count += 1;
            continue;
        };
        if model_id.is_empty() || !cherry_model_is_chat_compatible(model, &model_id) {
            excluded_model_count += 1;
            continue;
        }
        let base_url = cherry_v1_base_url(provider, &source_provider_type, protocol);
        let protocol = cherry_reclassify_deepseek_protocol(protocol, &base_url);
        cherry_group_add_model(&mut groups, protocol, base_url, model_id);
    }

    if groups.is_empty() {
        let Some(protocol) = cherry_v1_default_protocol(&source_provider_type) else {
            return;
        };
        let base_url = cherry_v1_base_url(provider, &source_provider_type, protocol);
        groups.push(CherryImportGroup {
            protocol: cherry_reclassify_deepseek_protocol(protocol, &base_url),
            base_url,
            models: Vec::new(),
        });
    }

    let warning = if provider
        .get("extra_headers")
        .and_then(Value::as_object)
        .is_some_and(|headers| !headers.is_empty())
    {
        "Cherry Studio 的自定义请求头不会同步".to_string()
    } else if api_keys.len() > 1 {
        format!("检测到 {} 个 API Key，将使用第一个", api_keys.len())
    } else {
        String::new()
    };

    for group in groups {
        let models_only_unsupported = !source_models.is_empty() && group.models.is_empty();
        let reason = if auth_type == "oauth" {
            "OAuth 登录凭据不支持迁移".to_string()
        } else if api_key.is_empty() {
            "未配置可迁移的 API Key".to_string()
        } else if group.base_url.is_empty() {
            "未配置 Base URL".to_string()
        } else if models_only_unsupported {
            "仅包含 LiveAgent 不支持的非聊天模型".to_string()
        } else {
            String::new()
        };
        out.push(CherryProviderImportItem {
            source_id: format!("{}::{}", source_id, group.protocol.variant()),
            source_version: version.to_string(),
            source_provider_type: source_provider_type.clone(),
            provider_type: group.protocol.provider_type().to_string(),
            name: name.clone(),
            base_url: group.base_url,
            api_key: api_key.clone(),
            api_key_count: api_keys.len(),
            request_format: group.protocol.request_format().to_string(),
            enabled,
            importable: reason.is_empty(),
            reason,
            warning: warning.clone(),
            excluded_model_count,
        });
    }
}

fn cherry_read_v2(
    sqlite_path: &std::path::Path,
    data_path: &std::path::Path,
) -> Result<CherryImportScan, String> {
    let conn = Connection::open_with_flags(sqlite_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("打开 Cherry Studio SQLite 失败：{error}"))?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|error| format!("设置 Cherry Studio SQLite 超时失败：{error}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT provider_id, name, endpoint_configs, default_chat_endpoint,
                    api_keys, auth_config, provider_settings, is_enabled
             FROM user_provider
             ORDER BY order_key ASC, provider_id ASC",
        )
        .map_err(|error| format!("读取 Cherry Studio user_provider 失败：{error}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, bool>(7)?,
            ))
        })
        .map_err(|error| format!("查询 Cherry Studio user_provider 失败：{error}"))?;
    let mut source_rows = Vec::new();
    for row in rows {
        source_rows
            .push(row.map_err(|error| format!("读取 Cherry Studio provider 行失败：{error}"))?);
    }
    let total_provider_count = source_rows.len();
    let enabled_provider_count = source_rows.iter().filter(|row| row.7).count();
    let version = cherry_read_version(data_path).unwrap_or_else(|| "2.x".to_string());
    let mut providers = Vec::new();

    for (
        source_id,
        name,
        endpoint_configs_text,
        default_endpoint,
        api_keys_text,
        auth_config_text,
        provider_settings_text,
        enabled,
    ) in source_rows
    {
        let endpoint_configs = cherry_parse_optional_json(endpoint_configs_text.as_deref());
        let api_keys = cherry_v2_api_keys(api_keys_text.as_deref());
        let api_key = api_keys.first().cloned().unwrap_or_default();
        let auth_config = cherry_parse_optional_json(auth_config_text.as_deref());
        let auth_type = auth_config
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("api-key");
        let mut model_stmt = conn
            .prepare(
                "SELECT model_id, endpoint_types, capabilities, output_modalities,
                        is_enabled, is_hidden
                 FROM user_model
                 WHERE provider_id = ?1
                 ORDER BY order_key ASC, model_id ASC",
            )
            .map_err(|error| format!("读取 Cherry Studio user_model 失败：{error}"))?;
        let model_rows = model_stmt
            .query_map([&source_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, bool>(5)?,
                ))
            })
            .map_err(|error| format!("查询 Cherry Studio user_model 失败：{error}"))?;
        let mut groups = Vec::<CherryImportGroup>::new();
        let mut source_model_count = 0usize;
        let mut excluded_model_count = 0usize;
        for row in model_rows {
            let (model_id, endpoints_text, capabilities_text, output_text, model_enabled, hidden) =
                row.map_err(|error| format!("读取 Cherry Studio model 行失败：{error}"))?;
            if !model_enabled || hidden {
                continue;
            }
            source_model_count += 1;
            let endpoints = cherry_parse_optional_json(endpoints_text.as_deref());
            let endpoint = endpoints
                .as_array()
                .and_then(|values| values.first())
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| default_endpoint.clone())
                .unwrap_or_default();
            let Some(protocol) = cherry_protocol_from_endpoint(&endpoint) else {
                excluded_model_count += 1;
                continue;
            };
            let capabilities = cherry_parse_optional_json(capabilities_text.as_deref());
            let output_modalities = cherry_parse_optional_json(output_text.as_deref());
            if !cherry_v2_model_is_chat_compatible(&model_id, &capabilities, &output_modalities) {
                excluded_model_count += 1;
                continue;
            }
            let base_url = cherry_v2_endpoint_base_url(&endpoint_configs, &endpoint);
            let protocol = cherry_reclassify_deepseek_protocol(protocol, &base_url);
            cherry_group_add_model(&mut groups, protocol, base_url, model_id);
        }

        if groups.is_empty() {
            let Some(protocol) = default_endpoint
                .as_deref()
                .and_then(cherry_protocol_from_endpoint)
            else {
                continue;
            };
            let base_url = cherry_v2_endpoint_base_url(
                &endpoint_configs,
                default_endpoint.as_deref().unwrap_or_default(),
            );
            groups.push(CherryImportGroup {
                protocol: cherry_reclassify_deepseek_protocol(protocol, &base_url),
                base_url,
                models: Vec::new(),
            });
        }

        let settings = cherry_parse_optional_json(provider_settings_text.as_deref());
        let warning = if settings
            .get("extraHeaders")
            .and_then(Value::as_object)
            .is_some_and(|headers| !headers.is_empty())
        {
            "Cherry Studio 的自定义请求头不会同步".to_string()
        } else if api_keys.len() > 1 {
            format!("检测到 {} 个启用 API Key，将使用第一个", api_keys.len())
        } else {
            String::new()
        };

        for group in groups {
            let models_only_unsupported = source_model_count > 0 && group.models.is_empty();
            let reason = if auth_type != "api-key" {
                format!("{auth_type} 登录凭据不支持迁移")
            } else if api_key.is_empty() {
                "未配置启用的 API Key".to_string()
            } else if group.base_url.is_empty() {
                "未配置当前协议的 Base URL".to_string()
            } else if models_only_unsupported {
                "仅包含 LiveAgent 不支持的非聊天模型".to_string()
            } else {
                String::new()
            };
            providers.push(CherryProviderImportItem {
                source_id: format!("{}::{}", source_id, group.protocol.variant()),
                source_version: version.clone(),
                source_provider_type: default_endpoint.clone().unwrap_or_default(),
                provider_type: group.protocol.provider_type().to_string(),
                name: name.clone(),
                base_url: group.base_url,
                api_key: api_key.clone(),
                api_key_count: api_keys.len(),
                request_format: group.protocol.request_format().to_string(),
                enabled,
                importable: reason.is_empty(),
                reason,
                warning: warning.clone(),
                excluded_model_count,
            });
        }
    }

    Ok(CherryImportScan {
        version,
        data_path: data_path.to_path_buf(),
        total_provider_count,
        enabled_provider_count,
        providers,
    })
}

fn cherry_v1_default_protocol(provider_type: &str) -> Option<CherryImportProtocol> {
    match provider_type.trim().to_ascii_lowercase().as_str() {
        "anthropic" | "vertex-anthropic" => Some(CherryImportProtocol::Claude),
        "gemini" | "vertexai" => Some(CherryImportProtocol::Gemini),
        "deepseek" => Some(CherryImportProtocol::DeepSeek),
        "openai-response" => Some(CherryImportProtocol::CodexResponses),
        "openai" | "new-api" | "gateway" | "ollama" => Some(CherryImportProtocol::CodexCompletions),
        _ => None,
    }
}

fn cherry_protocol_from_endpoint(endpoint: &str) -> Option<CherryImportProtocol> {
    match endpoint.trim().to_ascii_lowercase().as_str() {
        "anthropic" | "anthropic-messages" | "messages" => Some(CherryImportProtocol::Claude),
        "gemini" | "google-generate-content" | "generatecontent" | "streamgeneratecontent" => {
            Some(CherryImportProtocol::Gemini)
        }
        "deepseek" | "deepseek-chat" | "deepseek-chat-completions" => {
            Some(CherryImportProtocol::DeepSeek)
        }
        "openai-response" | "openai-responses" | "responses" | "response" => {
            Some(CherryImportProtocol::CodexResponses)
        }
        "openai" | "openai-chat-completions" | "chat/completions" | "ollama-chat" => {
            Some(CherryImportProtocol::CodexCompletions)
        }
        _ => None,
    }
}

fn cherry_reclassify_deepseek_protocol(
    protocol: CherryImportProtocol,
    base_url: &str,
) -> CherryImportProtocol {
    if protocol != CherryImportProtocol::CodexCompletions {
        return protocol;
    }
    if is_official_deepseek_base_url(base_url) {
        CherryImportProtocol::DeepSeek
    } else {
        protocol
    }
}

fn cherry_v1_base_url(
    provider: &Value,
    provider_type: &str,
    protocol: CherryImportProtocol,
) -> String {
    let raw = if protocol == CherryImportProtocol::Claude && provider_type != "new-api" {
        let anthropic = cherry_value_string(provider, "anthropicApiHost");
        if anthropic.is_empty() {
            cherry_value_string(provider, "apiHost")
        } else {
            anthropic
        }
    } else {
        cherry_value_string(provider, "apiHost")
    };
    cherry_normalize_routed_base_url(&raw)
}

fn cherry_normalize_routed_base_url(value: &str) -> String {
    let trimmed = value.trim();
    if !trimmed.ends_with('#') {
        return trimmed.trim_end_matches('/').to_string();
    }
    let mut base = trimmed
        .trim_end_matches('#')
        .trim_end_matches('/')
        .to_string();
    let lower = base.to_ascii_lowercase();
    for suffix in [
        "/chat/completions",
        "/responses",
        "/response",
        "/messages",
        ":streamgeneratecontent",
        ":generatecontent",
        "/streamgeneratecontent",
        "/generatecontent",
    ] {
        if lower.ends_with(suffix) {
            base.truncate(base.len() - suffix.len());
            break;
        }
    }
    base.trim_end_matches(['/', ':']).to_string()
}

fn cherry_group_add_model(
    groups: &mut Vec<CherryImportGroup>,
    protocol: CherryImportProtocol,
    base_url: String,
    model_id: String,
) {
    if let Some(group) = groups
        .iter_mut()
        .find(|group| group.protocol == protocol && group.base_url == base_url)
    {
        if !group.models.iter().any(|model| model == &model_id) {
            group.models.push(model_id);
        }
        return;
    }
    groups.push(CherryImportGroup {
        protocol,
        base_url,
        models: vec![model_id],
    });
}

fn cherry_model_is_chat_compatible(model: &Value, model_id: &str) -> bool {
    if cherry_model_id_looks_non_chat(model_id) {
        return false;
    }
    let types = model
        .get("type")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    if !types.is_empty()
        && !types.iter().any(|kind| {
            matches!(
                kind.to_ascii_lowercase().as_str(),
                "text" | "vision" | "reasoning" | "function_calling" | "web_search"
            )
        })
    {
        return false;
    }
    true
}

fn cherry_v2_model_is_chat_compatible(
    model_id: &str,
    capabilities: &Value,
    output_modalities: &Value,
) -> bool {
    if cherry_model_id_looks_non_chat(model_id) {
        return false;
    }
    if let Some(outputs) = output_modalities.as_array() {
        let values = outputs
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_ascii_lowercase)
            .collect::<Vec<_>>();
        if !values.is_empty() && !values.iter().any(|value| value == "text") {
            return false;
        }
    }
    if let Some(values) = capabilities.as_array() {
        let only_non_chat = !values.is_empty()
            && values.iter().filter_map(Value::as_str).all(|value| {
                matches!(
                    value.to_ascii_lowercase().as_str(),
                    "embedding"
                        | "rerank"
                        | "image-generation"
                        | "audio-generation"
                        | "audio-transcript"
                        | "video-generation"
                )
            });
        if only_non_chat {
            return false;
        }
    }
    true
}

fn cherry_model_id_looks_non_chat(model_id: &str) -> bool {
    let lower = model_id.to_ascii_lowercase();
    [
        "embedding",
        "rerank",
        "whisper",
        "realtime",
        "audio-preview",
        "audio-realtime",
        "image",
        "video",
        "banana",
        "dall-e",
        "imagen",
        "sora-",
        "veo-",
        "tts-",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn cherry_split_v1_api_keys(value: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            if character == ',' {
                current.push(',');
            } else {
                current.push('\\');
                current.push(character);
            }
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == ',' {
            let key = current.trim();
            if !key.is_empty() {
                keys.push(key.to_string());
            }
            current.clear();
        } else {
            current.push(character);
        }
    }
    if escaped {
        current.push('\\');
    }
    let key = current.trim();
    if !key.is_empty() {
        keys.push(key.to_string());
    }
    keys
}

fn cherry_v2_api_keys(text: Option<&str>) -> Vec<String> {
    cherry_parse_optional_json(text)
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| {
            entry
                .get("isEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        })
        .filter_map(|entry| entry.get("key").and_then(Value::as_str))
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .collect()
}

fn cherry_v2_endpoint_base_url(endpoint_configs: &Value, endpoint: &str) -> String {
    endpoint_configs
        .get(endpoint)
        .and_then(|config| config.get("baseUrl"))
        .and_then(Value::as_str)
        .map(cherry_normalize_routed_base_url)
        .unwrap_or_default()
}

fn cherry_parse_optional_json(text: Option<&str>) -> Value {
    text.and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap_or(Value::Null)
}

fn cherry_value_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn cherry_read_version(data_path: &std::path::Path) -> Option<String> {
    let text = fs::read_to_string(data_path.join("version.log")).ok()?;
    text.lines()
        .rev()
        .find_map(|line| line.split('|').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
