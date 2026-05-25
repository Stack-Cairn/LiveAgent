use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Number, Value};
use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::services::cron::{validate_cron_expression, CronManager};
use crate::services::gateway::GatewayController;
use uuid::Uuid;

const DB_FILENAME: &str = "config.sqlite";
const DEFAULT_PROJECT_DIRNAME: &str = "default-project";
const PROVIDER_SETTINGS_TABLE: &str = "provider_settings";
const SYSTEM_SETTINGS_TABLE: &str = "system_settings";
const MCP_SETTINGS_TABLE: &str = "mcp_settings";
const AGENT_PROMPT_TEMPLATES_TABLE: &str = "agent_prompt_templates";
const HOOK_SETTINGS_TABLE: &str = "hook_settings";
const CRON_SETTINGS_TABLE: &str = "cron_settings";
const CRON_EXECUTION_LOGS_TABLE: &str = "cron_execution_logs";
const REMOTE_SETTINGS_TABLE: &str = "remote_settings";
const MEMORY_SETTINGS_TABLE: &str = "memory_settings";

const SYSTEM_EXECUTION_MODE_KEY: &str = "executionMode";
const SYSTEM_WORKDIR_KEY: &str = "workdir";
const SYSTEM_SELECTED_TOOLS_KEY: &str = "selectedSystemTools";
pub(crate) const PROVIDER_API_KEY_UPDATES_FIELD: &str = "providerApiKeyUpdates";

const PROVIDER_SETTINGS_SELECT_SQL: &str = "
    SELECT provider_id, payload_json
    FROM provider_settings
    ORDER BY sort_index ASC, provider_id ASC
";
const PROVIDER_SETTINGS_INSERT_SQL: &str = "
    INSERT INTO provider_settings (provider_id, payload_json, sort_index, updated_at)
    VALUES (?1, ?2, ?3, ?4)
";
const PROVIDER_SETTINGS_DELETE_SQL: &str = "DELETE FROM provider_settings";

const SYSTEM_SETTINGS_SELECT_SQL: &str = "
    SELECT setting_key, payload_json
    FROM system_settings
";
const SYSTEM_SETTINGS_INSERT_SQL: &str = "
    INSERT INTO system_settings (setting_key, payload_json, updated_at)
    VALUES (?1, ?2, ?3)
";
const SYSTEM_SETTINGS_DELETE_SQL: &str = "DELETE FROM system_settings";

const MCP_SETTINGS_SELECT_SQL: &str = "
    SELECT server_id, payload_json
    FROM mcp_settings
    ORDER BY sort_index ASC, server_id ASC
";
const MCP_SETTINGS_INSERT_SQL: &str = "
    INSERT INTO mcp_settings (server_id, payload_json, sort_index, updated_at)
    VALUES (?1, ?2, ?3, ?4)
";
const MCP_SETTINGS_DELETE_SQL: &str = "DELETE FROM mcp_settings";

const AGENT_PROMPT_TEMPLATES_SELECT_SQL: &str = "
    SELECT template_id, name, description, tags_json, prompt, enabled
    FROM agent_prompt_templates
    ORDER BY sort_index ASC, template_id ASC
";
const AGENT_PROMPT_TEMPLATES_INSERT_SQL: &str = "
    INSERT INTO agent_prompt_templates
        (template_id, name, description, tags_json, prompt, enabled, sort_index, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
";
const AGENT_PROMPT_TEMPLATES_DELETE_SQL: &str = "DELETE FROM agent_prompt_templates";

const HOOK_SETTINGS_SELECT_SQL: &str = "
    SELECT hook_id, payload_json
    FROM hook_settings
    ORDER BY sort_index ASC, hook_id ASC
";
const HOOK_SETTINGS_INSERT_SQL: &str = "
    INSERT INTO hook_settings (hook_id, payload_json, sort_index, updated_at)
    VALUES (?1, ?2, ?3, ?4)
";
const HOOK_SETTINGS_DELETE_SQL: &str = "DELETE FROM hook_settings";

const CRON_SETTINGS_SELECT_SQL: &str = "
    SELECT task_id, payload_json
    FROM cron_settings
    ORDER BY sort_index ASC, task_id ASC
";
const CRON_SETTINGS_INSERT_SQL: &str = "
    INSERT INTO cron_settings (task_id, payload_json, sort_index, updated_at)
    VALUES (?1, ?2, ?3, ?4)
";
const CRON_SETTINGS_UPDATE_SQL: &str = "
    UPDATE cron_settings
    SET payload_json = ?1, updated_at = ?2
    WHERE task_id = ?3
";
const CRON_SETTINGS_DELETE_SQL: &str = "DELETE FROM cron_settings";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLoadResponse {
    pub providers: Option<Value>,
    pub system: Option<Value>,
    pub mcp: Option<Value>,
    pub agents: Option<Value>,
    pub hooks: Option<Value>,
    pub cron: Option<Value>,
    pub remote: Option<Value>,
    pub memory: Option<Value>,
    pub default_workdir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettingsPayload {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub gateway_url: String,
    #[serde(default = "default_remote_grpc_port")]
    pub grpc_port: u16,
    #[serde(default)]
    pub grpc_endpoint: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default = "default_remote_auto_reconnect")]
    pub auto_reconnect: bool,
    #[serde(default = "default_remote_heartbeat_interval")]
    pub heartbeat_interval: u64,
}

fn default_remote_grpc_port() -> u16 {
    50051
}

fn default_remote_auto_reconnect() -> bool {
    true
}

fn default_remote_heartbeat_interval() -> u64 {
    30
}

impl Default for RemoteSettingsPayload {
    fn default() -> Self {
        Self {
            enabled: false,
            gateway_url: String::new(),
            grpc_port: default_remote_grpc_port(),
            grpc_endpoint: String::new(),
            token: String::new(),
            agent_id: String::new(),
            auto_reconnect: default_remote_auto_reconnect(),
            heartbeat_interval: default_remote_heartbeat_interval(),
        }
    }
}

pub(crate) fn normalize_remote_settings_payload(
    payload: RemoteSettingsPayload,
) -> RemoteSettingsPayload {
    RemoteSettingsPayload {
        enabled: payload.enabled,
        gateway_url: normalize_base_url_text(&payload.gateway_url),
        grpc_port: if payload.grpc_port == 0 {
            default_remote_grpc_port()
        } else {
            payload.grpc_port
        },
        grpc_endpoint: normalize_grpc_endpoint_text(&payload.grpc_endpoint),
        token: payload.token.trim().to_string(),
        agent_id: payload.agent_id.trim().to_string(),
        auto_reconnect: payload.auto_reconnect,
        heartbeat_interval: payload.heartbeat_interval.max(1),
    }
}

fn normalize_grpc_endpoint_text(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with("http:") || trimmed.starts_with("https:") {
        return normalize_base_url_text(trimmed);
    }
    trimmed.trim_end_matches('/').to_string()
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

fn now_ms() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    duration.as_millis() as i64
}

fn config_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let dir = home.join(format!(".{}", env!("CARGO_PKG_NAME")));
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    Ok(dir)
}

fn default_project_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?.join(DEFAULT_PROJECT_DIRNAME);
    fs::create_dir_all(&dir).map_err(|e| format!("创建默认工作目录失败：{e}"))?;
    Ok(dir)
}

fn default_project_workdir() -> Result<String, String> {
    Ok(default_project_dir()?.to_string_lossy().into_owned())
}

pub(crate) fn initialize_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS provider_settings (
            provider_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS system_settings (
            setting_key TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mcp_settings (
            server_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_prompt_templates (
            template_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            prompt TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hook_settings (
            hook_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cron_settings (
            task_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cron_execution_logs (
            log_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            success INTEGER NOT NULL DEFAULT 0,
            duration_ms INTEGER NOT NULL,
            exit_code INTEGER,
            output TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS remote_settings (
            config_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_settings (
            config_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cron_execution_logs_task_started_at
            ON cron_execution_logs (task_id, started_at DESC);
        ",
    )
    .map_err(|e| format!("初始化设置表失败：{e}"))?;
    Ok(())
}

pub(crate) fn open_db() -> Result<Connection, String> {
    let db_path = config_dir()?.join(DB_FILENAME);
    let conn = Connection::open(db_path).map_err(|e| format!("打开设置数据库失败：{e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置 SQLite busy_timeout 失败：{e}"))?;
    initialize_schema(&conn)?;
    Ok(conn)
}

fn serialize_json(value: &Value, label: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("序列化 {label} 失败：{e}"))
}

fn parse_json(raw: &str, label: &str) -> Result<Value, String> {
    serde_json::from_str::<Value>(raw).map_err(|e| format!("解析 {label} JSON 失败：{e}"))
}

fn expect_object(value: Value, label: &str) -> Result<Map<String, Value>, String> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(format!("{label} 必须是对象")),
    }
}

fn expect_array(value: Value, label: &str) -> Result<Vec<Value>, String> {
    match value {
        Value::Array(items) => Ok(items),
        _ => Err(format!("{label} 必须是数组")),
    }
}

fn extract_non_empty_string(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<String, String> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{label}.{key} 不能为空"))?;
    Ok(value.to_string())
}

fn inject_string_field(object: &mut Map<String, Value>, key: &str, value: String) {
    object.insert(key.to_string(), Value::String(value));
}

fn extract_optional_string(object: &Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn extract_bool_with_default(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
    default: bool,
) -> Result<bool, String> {
    match object.get(key) {
        Some(Value::Bool(value)) => Ok(*value),
        Some(Value::Null) | None => Ok(default),
        Some(_) => Err(format!("{label}.{key} 必须是布尔值")),
    }
}

fn extract_string_array(value: Option<&Value>, label: &str) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or_else(|| format!("{label} 必须是字符串数组"))?;

    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(format!("{label} 必须是字符串数组"));
        };
        out.push(text.trim().to_string());
    }
    Ok(out)
}

#[derive(Debug)]
pub(crate) struct ValidatedCronTask {
    pub(crate) task_id: Option<String>,
    pub(crate) payload: Map<String, Value>,
}

#[derive(Debug)]
struct ValidatedHook {
    hook_id: String,
    payload: Map<String, Value>,
}

#[derive(Debug, Clone, Copy)]
struct CronTaskValidationOptions {
    require_id: bool,
    default_enabled: bool,
}

fn validate_hook_lifecycle_event(value: Option<&Value>, label: &str) -> Result<String, String> {
    let event = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("agent_start");
    match event {
        "agent_start"
        | "turn_start"
        | "message_start"
        | "message_update"
        | "message_end"
        | "tool_execution_start"
        | "tool_execution_update"
        | "tool_execution_end"
        | "turn_end"
        | "agent_end" => Ok(event.to_string()),
        other => Err(format!("{label}.event 不支持：{other}")),
    }
}

fn validate_hook_type(hook: &Map<String, Value>, label: &str) -> Result<String, String> {
    let hook_type = hook
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("command");
    match hook_type {
        "command" | "http" => Ok(hook_type.to_string()),
        other => Err(format!("{label}.type 不支持：{other}")),
    }
}

fn validate_and_normalize_hook(
    hook: Map<String, Value>,
    label: &str,
) -> Result<ValidatedHook, String> {
    if hook.contains_key("commands") {
        return Err(format!("{label}.commands 已不再支持，请使用 script"));
    }

    let hook_id = extract_non_empty_string(&hook, "id", label)?;
    let event = validate_hook_lifecycle_event(hook.get("event"), label)?;
    let name = extract_non_empty_string(&hook, "name", label)?;
    let description = extract_optional_string(&hook, "description");
    let enabled = extract_bool_with_default(&hook, "enabled", label, false)?;
    let hook_type = validate_hook_type(&hook, label)?;

    let mut payload = Map::new();
    payload.insert("event".to_string(), Value::String(event));
    payload.insert("name".to_string(), Value::String(name));
    payload.insert("description".to_string(), Value::String(description));
    payload.insert("enabled".to_string(), Value::Bool(enabled));
    payload.insert("type".to_string(), Value::String(hook_type.clone()));

    match hook_type.as_str() {
        "command" => {
            let script = extract_non_empty_string(&hook, "script", label)?;
            payload.insert("script".to_string(), Value::String(script));
        }
        "http" => {
            let requests = validate_http_requests(&hook, label)?;
            payload.insert("requests".to_string(), Value::Array(requests));
        }
        _ => unreachable!(),
    }

    Ok(ValidatedHook { hook_id, payload })
}

fn validate_cron_task_type(task: &Map<String, Value>, label: &str) -> Result<String, String> {
    let task_type = task
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("bash");
    match task_type {
        "bash" | "http" | "prompt" => Ok(task_type.to_string()),
        other => Err(format!("{label}.type 不支持：{other}")),
    }
}

fn validate_cron_script(task: &Map<String, Value>, label: &str) -> Result<String, String> {
    let script = extract_non_empty_string(task, "script", label)?;
    Ok(script)
}

fn validate_cron_remaining_executions(
    task: &Map<String, Value>,
    label: &str,
) -> Result<Option<u64>, String> {
    let Some(value) = task.get("remainingExecutions") else {
        return Ok(None);
    };

    match value {
        Value::Null => Ok(None),
        Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| format!("{label}.remainingExecutions 必须是非负整数"))
            .map(Some),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                trimmed
                    .parse::<u64>()
                    .map(Some)
                    .map_err(|_| format!("{label}.remainingExecutions 必须是非负整数"))
            }
        }
        _ => Err(format!("{label}.remainingExecutions 必须是非负整数")),
    }
}

fn validate_http_method(value: Option<&Value>, label: &str) -> Result<String, String> {
    let method = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("POST")
        .to_ascii_uppercase();
    match method.as_str() {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" => Ok(method),
        _ => Err(format!("{label}.method 不支持：{method}")),
    }
}

fn can_http_method_have_body(method: &str) -> bool {
    matches!(method, "POST" | "PUT" | "PATCH" | "DELETE")
}

fn validate_http_headers(
    value: Option<&Value>,
    label: &str,
) -> Result<Option<Map<String, Value>>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let headers = value
        .as_object()
        .ok_or_else(|| format!("{label}.headers 必须是对象"))?;
    let mut normalized = Map::new();
    for (raw_key, raw_value) in headers {
        let key = raw_key.trim();
        let header_value = match raw_value {
            Value::String(text) => text.trim().to_string(),
            Value::Null => String::new(),
            other => other.to_string().trim().to_string(),
        };
        if key.is_empty() || header_value.is_empty() {
            continue;
        }
        normalized.insert(key.to_string(), Value::String(header_value));
    }
    if normalized.is_empty() {
        Ok(None)
    } else {
        Ok(Some(normalized))
    }
}

fn validate_http_requests(task: &Map<String, Value>, label: &str) -> Result<Vec<Value>, String> {
    let Some(requests_value) = task.get("requests") else {
        return Err(format!("{label}.requests 至少需要一个请求"));
    };
    let requests = requests_value
        .as_array()
        .ok_or_else(|| format!("{label}.requests 必须是对象数组"))?;
    if requests.is_empty() {
        return Err(format!("{label}.requests 至少需要一个请求"));
    }

    let mut normalized = Vec::with_capacity(requests.len());
    for (index, request_value) in requests.iter().enumerate() {
        let item_label = format!("{label}.requests[{index}]");
        let request = request_value
            .as_object()
            .ok_or_else(|| format!("{item_label} 必须是对象"))?;
        let id = extract_non_empty_string(request, "id", &item_label)?;
        let url = extract_non_empty_string(request, "url", &item_label)?;
        reqwest::Url::parse(&url).map_err(|_| format!("{item_label}.url 必须是绝对 URL"))?;
        let method = validate_http_method(request.get("method"), &item_label)?;
        let headers = validate_http_headers(request.get("headers"), &item_label)?;
        let body = if can_http_method_have_body(&method) {
            request
                .get("body")
                .filter(|value| !value.is_null())
                .cloned()
        } else {
            None
        };

        let mut normalized_request = Map::new();
        normalized_request.insert("id".to_string(), Value::String(id));
        normalized_request.insert("url".to_string(), Value::String(url));
        normalized_request.insert("method".to_string(), Value::String(method));
        if let Some(headers) = headers {
            normalized_request.insert("headers".to_string(), Value::Object(headers));
        }
        if let Some(body) = body {
            normalized_request.insert("body".to_string(), body);
        }
        normalized.push(Value::Object(normalized_request));
    }

    Ok(normalized)
}

fn validate_cron_selected_model(
    value: Option<&Value>,
    label: &str,
) -> Result<Map<String, Value>, String> {
    let selected_model = expect_object(
        value
            .cloned()
            .ok_or_else(|| format!("{label}.selectedModel 不能为空"))?,
        &format!("{label}.selectedModel"),
    )?;
    let custom_provider_id = extract_non_empty_string(
        &selected_model,
        "customProviderId",
        &format!("{label}.selectedModel"),
    )?;
    let model =
        extract_non_empty_string(&selected_model, "model", &format!("{label}.selectedModel"))?;

    Ok(Map::from_iter([
        (
            "customProviderId".to_string(),
            Value::String(custom_provider_id),
        ),
        ("model".to_string(), Value::String(model)),
    ]))
}

fn validate_and_normalize_cron_task(
    task: Map<String, Value>,
    label: &str,
    options: CronTaskValidationOptions,
) -> Result<ValidatedCronTask, String> {
    let task_id = if options.require_id {
        Some(extract_non_empty_string(&task, "id", label)?)
    } else {
        None
    };
    if task.contains_key("commands") {
        return Err(format!("{label}.commands 已不再支持，请使用 script"));
    }
    let name = extract_non_empty_string(&task, "name", label)?;
    let description = extract_optional_string(&task, "description");
    let cron_expression = extract_non_empty_string(&task, "cron", label)?;
    validate_cron_expression(&cron_expression)?;
    let remaining_executions = validate_cron_remaining_executions(&task, label)?;
    let enabled = extract_bool_with_default(&task, "enabled", label, options.default_enabled)?
        && remaining_executions != Some(0);
    let task_type = validate_cron_task_type(&task, label)?;

    let mut payload = Map::new();
    payload.insert("name".to_string(), Value::String(name));
    payload.insert("description".to_string(), Value::String(description));
    payload.insert("cron".to_string(), Value::String(cron_expression));
    payload.insert("enabled".to_string(), Value::Bool(enabled));
    payload.insert("type".to_string(), Value::String(task_type.clone()));
    if let Some(remaining_executions) = remaining_executions {
        payload.insert(
            "remainingExecutions".to_string(),
            Value::Number(Number::from(remaining_executions)),
        );
    }

    match task_type.as_str() {
        "bash" => {
            let script = validate_cron_script(&task, label)?;
            payload.insert("script".to_string(), Value::String(script));
        }
        "http" => {
            let requests = validate_http_requests(&task, label)?;
            payload.insert("requests".to_string(), Value::Array(requests));
        }
        "prompt" => {
            let prompt = extract_non_empty_string(&task, "prompt", label)?;
            let selected_model = validate_cron_selected_model(task.get("selectedModel"), label)?;
            payload.insert("prompt".to_string(), Value::String(prompt));
            payload.insert("selectedModel".to_string(), Value::Object(selected_model));
        }
        _ => unreachable!(),
    }

    Ok(ValidatedCronTask { task_id, payload })
}

pub(crate) fn append_cron_task(
    conn: &mut Connection,
    payload: Value,
) -> Result<ValidatedCronTask, String> {
    let task = expect_object(payload, "system_add_cron_task payload")?;
    let mut validated = validate_and_normalize_cron_task(
        task,
        "system_add_cron_task payload",
        CronTaskValidationOptions {
            require_id: false,
            default_enabled: true,
        },
    )?;
    let task_id = Uuid::new_v4().to_string();
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    let sort_index: i64 = tx
        .query_row(
            &format!("SELECT COALESCE(MAX(sort_index), -1) + 1 FROM {CRON_SETTINGS_TABLE}"),
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取 {CRON_SETTINGS_TABLE} 排序索引失败：{e}"))?;

    tx.execute(
        CRON_SETTINGS_INSERT_SQL,
        params![
            task_id,
            serialize_json(
                &Value::Object(validated.payload.clone()),
                CRON_SETTINGS_TABLE
            )?,
            sort_index,
            updated_at
        ],
    )
    .map_err(|e| format!("写入 {CRON_SETTINGS_TABLE} 失败：{e}"))?;

    tx.commit()
        .map_err(|e| format!("提交 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    validated.task_id = Some(task_id);
    Ok(validated)
}

pub(crate) fn update_cron_task(
    conn: &mut Connection,
    task_id: &str,
    payload: Value,
) -> Result<ValidatedCronTask, String> {
    let normalized_task_id = task_id.trim();
    if normalized_task_id.is_empty() {
        return Err("system_manage_cron_task payload.task_id 不能为空".to_string());
    }

    let existing = load_cron_task(conn, normalized_task_id)?
        .ok_or_else(|| format!("{CRON_SETTINGS_TABLE}.task_id 不存在：{normalized_task_id}"))?;
    let mut merged = expect_object(existing, "stored cron task")?;
    let patch = expect_object(payload, "system_manage_cron_task payload.task")?;
    for (key, value) in patch {
        merged.insert(key, value);
    }

    let mut validated = validate_and_normalize_cron_task(
        merged,
        "system_manage_cron_task payload.task",
        CronTaskValidationOptions {
            require_id: true,
            default_enabled: true,
        },
    )?;
    let validated_task_id = validated
        .task_id
        .clone()
        .ok_or_else(|| "system_manage_cron_task payload.task.id 不能为空".to_string())?;
    if validated_task_id != normalized_task_id {
        return Err("system_manage_cron_task 不允许修改 task_id".to_string());
    }

    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    let affected_rows = tx
        .execute(
            CRON_SETTINGS_UPDATE_SQL,
            params![
                serialize_json(
                    &Value::Object(validated.payload.clone()),
                    CRON_SETTINGS_TABLE
                )?,
                updated_at,
                normalized_task_id
            ],
        )
        .map_err(|e| format!("更新 {CRON_SETTINGS_TABLE} 失败：{e}"))?;
    if affected_rows == 0 {
        return Err(format!(
            "{CRON_SETTINGS_TABLE}.task_id 不存在：{normalized_task_id}"
        ));
    }

    tx.commit()
        .map_err(|e| format!("提交 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    validated.task_id = Some(normalized_task_id.to_string());
    Ok(validated)
}

pub(crate) fn delete_cron_task(conn: &mut Connection, task_id: &str) -> Result<Value, String> {
    let normalized_task_id = task_id.trim();
    if normalized_task_id.is_empty() {
        return Err("system_manage_cron_task payload.task_id 不能为空".to_string());
    }

    let existing = load_cron_task(conn, normalized_task_id)?
        .ok_or_else(|| format!("{CRON_SETTINGS_TABLE}.task_id 不存在：{normalized_task_id}"))?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(
        &format!("DELETE FROM {CRON_EXECUTION_LOGS_TABLE} WHERE task_id = ?1"),
        params![normalized_task_id],
    )
    .map_err(|e| format!("清理 {CRON_EXECUTION_LOGS_TABLE} 失败：{e}"))?;
    let affected_rows = tx
        .execute(
            &format!("DELETE FROM {CRON_SETTINGS_TABLE} WHERE task_id = ?1"),
            params![normalized_task_id],
        )
        .map_err(|e| format!("删除 {CRON_SETTINGS_TABLE} 失败：{e}"))?;
    if affected_rows == 0 {
        return Err(format!(
            "{CRON_SETTINGS_TABLE}.task_id 不存在：{normalized_task_id}"
        ));
    }

    tx.commit()
        .map_err(|e| format!("提交 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(existing)
}

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

fn load_system(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(SYSTEM_SETTINGS_SELECT_SQL)
        .map_err(|e| format!("准备读取 {SYSTEM_SETTINGS_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取 {SYSTEM_SETTINGS_TABLE} 失败：{e}"))?;

    let mut system = Map::new();
    for row in rows {
        let (setting_key, payload_json) =
            row.map_err(|e| format!("读取 {SYSTEM_SETTINGS_TABLE} 行失败：{e}"))?;
        system.insert(
            setting_key,
            parse_json(&payload_json, SYSTEM_SETTINGS_TABLE)?,
        );
    }

    if system.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Object(system)))
    }
}

fn system_value_with_defaults(raw: Option<Value>, default_workdir: &str) -> Value {
    let mut system = match raw {
        Some(Value::Object(system)) => system,
        _ => Map::new(),
    };

    let execution_mode = system
        .get(SYSTEM_EXECUTION_MODE_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if execution_mode.is_empty() {
        system.insert(
            SYSTEM_EXECUTION_MODE_KEY.to_string(),
            Value::String("tools".to_string()),
        );
    }

    let workdir = system
        .get(SYSTEM_WORKDIR_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if workdir.is_empty() {
        system.insert(
            SYSTEM_WORKDIR_KEY.to_string(),
            Value::String(default_workdir.to_string()),
        );
    }

    if !matches!(system.get(SYSTEM_SELECTED_TOOLS_KEY), Some(Value::Array(_))) {
        system.insert(
            SYSTEM_SELECTED_TOOLS_KEY.to_string(),
            Value::Array(Vec::new()),
        );
    }

    Value::Object(system)
}

fn load_system_with_defaults(conn: &Connection, default_workdir: &str) -> Result<Value, String> {
    Ok(system_value_with_defaults(
        load_system(conn)?,
        default_workdir,
    ))
}

fn load_mcp(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(MCP_SETTINGS_SELECT_SQL)
        .map_err(|e| format!("准备读取 {MCP_SETTINGS_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取 {MCP_SETTINGS_TABLE} 失败：{e}"))?;

    let mut servers = Vec::new();
    let mut selected = Vec::new();

    for row in rows {
        let (server_id, payload_json) =
            row.map_err(|e| format!("读取 {MCP_SETTINGS_TABLE} 行失败：{e}"))?;
        let mut server = expect_object(
            parse_json(&payload_json, MCP_SETTINGS_TABLE)?,
            MCP_SETTINGS_TABLE,
        )?;

        let selected_flag = match server.remove("selected") {
            Some(Value::Bool(value)) => value,
            Some(Value::Null) | None => false,
            Some(_) => return Err("mcp_settings.selected 必须是布尔值".to_string()),
        };
        if selected_flag {
            selected.push(Value::String(server_id.clone()));
        }

        inject_string_field(&mut server, "id", server_id);
        servers.push(Value::Object(server));
    }

    if servers.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Object(Map::from_iter([
            ("servers".to_string(), Value::Array(servers)),
            ("selected".to_string(), Value::Array(selected)),
        ]))))
    }
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

pub(crate) fn load_memory(conn: &Connection) -> Result<Option<Value>, String> {
    let payload_json = conn
        .query_row(
            &format!(
                "SELECT payload_json FROM {MEMORY_SETTINGS_TABLE} WHERE config_id = 'default'"
            ),
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取 {MEMORY_SETTINGS_TABLE} 失败：{e}"))?;

    match payload_json {
        Some(raw) => Ok(Some(parse_json(&raw, MEMORY_SETTINGS_TABLE)?)),
        None => Ok(None),
    }
}

pub(crate) fn load_gateway_settings_sync_snapshot(conn: &Connection) -> Result<Value, String> {
    let default_workdir = default_project_workdir()?;
    let mut snapshot = Map::new();
    snapshot.insert(
        "system".to_string(),
        load_system_with_defaults(conn, &default_workdir)?,
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
        "hooks".to_string(),
        load_hooks(conn)?.unwrap_or(Value::Array(Vec::new())),
    );
    snapshot.insert(
        "cron".to_string(),
        load_cron(conn)?.unwrap_or(Value::Array(Vec::new())),
    );
    snapshot.insert(
        "memory".to_string(),
        load_memory(conn)?.unwrap_or(Value::Object(Map::new())),
    );
    snapshot.insert("skills".to_string(), Value::Object(Map::new()));
    snapshot.insert(
        "chatRuntimeControls".to_string(),
        json!({
            "thinkingEnabled": true,
            "nativeWebSearchEnabled": true,
            "reasoning": "high",
            "reasoningByProvider": {
                "claude_code": "high",
                "codex_openai_responses": "high",
                "codex_openai_completions": "high",
                "gemini": "high",
            },
        }),
    );
    snapshot.insert("selectedModel".to_string(), Value::Null);
    snapshot.insert("theme".to_string(), Value::String("light".to_string()));
    snapshot.insert("locale".to_string(), Value::String("zh-CN".to_string()));
    Ok(Value::Object(snapshot))
}

pub(crate) fn redact_gateway_settings_sync_payload(payload: Value) -> Result<Value, String> {
    let mut snapshot = expect_object(payload, "gateway settings sync payload")?;
    snapshot.remove(PROVIDER_API_KEY_UPDATES_FIELD);
    if let Some(providers) = snapshot.remove("customProviders") {
        snapshot.insert(
            "customProviders".to_string(),
            redact_provider_credentials(providers)?,
        );
    }
    Ok(Value::Object(snapshot))
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
    Ok(Value::Object(payload))
}

fn load_agents(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(AGENT_PROMPT_TEMPLATES_SELECT_SQL)
        .map_err(|e| format!("准备读取 {AGENT_PROMPT_TEMPLATES_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| format!("读取 {AGENT_PROMPT_TEMPLATES_TABLE} 失败：{e}"))?;

    let mut templates = Vec::new();
    for row in rows {
        let (template_id, name, description, tags_json, prompt, enabled) =
            row.map_err(|e| format!("读取 {AGENT_PROMPT_TEMPLATES_TABLE} 行失败：{e}"))?;
        let tags_value = parse_json(&tags_json, AGENT_PROMPT_TEMPLATES_TABLE)?;
        let tags = extract_string_array(Some(&tags_value), AGENT_PROMPT_TEMPLATES_TABLE)?;
        templates.push(Value::Object(Map::from_iter([
            ("id".to_string(), Value::String(template_id)),
            ("name".to_string(), Value::String(name)),
            ("description".to_string(), Value::String(description)),
            (
                "tags".to_string(),
                Value::Array(tags.into_iter().map(Value::String).collect()),
            ),
            ("prompt".to_string(), Value::String(prompt)),
            ("enabled".to_string(), Value::Bool(enabled != 0)),
        ])));
    }

    if templates.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Array(templates)))
    }
}

fn load_hooks(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(HOOK_SETTINGS_SELECT_SQL)
        .map_err(|e| format!("准备读取 {HOOK_SETTINGS_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取 {HOOK_SETTINGS_TABLE} 失败：{e}"))?;

    let mut hooks = Vec::new();
    for row in rows {
        let (hook_id, payload_json) =
            row.map_err(|e| format!("读取 {HOOK_SETTINGS_TABLE} 行失败：{e}"))?;
        let mut hook = expect_object(
            parse_json(&payload_json, HOOK_SETTINGS_TABLE)?,
            HOOK_SETTINGS_TABLE,
        )?;
        inject_string_field(&mut hook, "id", hook_id);
        hooks.push(Value::Object(hook));
    }

    if hooks.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Array(hooks)))
    }
}

pub(crate) fn load_cron(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(CRON_SETTINGS_SELECT_SQL)
        .map_err(|e| format!("准备读取 {CRON_SETTINGS_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取 {CRON_SETTINGS_TABLE} 失败：{e}"))?;

    let mut tasks = Vec::new();
    for row in rows {
        let (task_id, payload_json) =
            row.map_err(|e| format!("读取 {CRON_SETTINGS_TABLE} 行失败：{e}"))?;
        let mut task = expect_object(
            parse_json(&payload_json, CRON_SETTINGS_TABLE)?,
            CRON_SETTINGS_TABLE,
        )?;
        inject_string_field(&mut task, "id", task_id);
        tasks.push(Value::Object(task));
    }

    if tasks.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Array(tasks)))
    }
}

pub(crate) fn load_cron_task(conn: &Connection, task_id: &str) -> Result<Option<Value>, String> {
    let normalized_task_id = task_id.trim();
    if normalized_task_id.is_empty() {
        return Err("cron task_id 不能为空".to_string());
    }

    let payload_json = conn
        .query_row(
            &format!(
                "
                SELECT payload_json
                FROM {CRON_SETTINGS_TABLE}
                WHERE task_id = ?1
                "
            ),
            params![normalized_task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取 {CRON_SETTINGS_TABLE} 失败：{e}"))?;

    let Some(payload_json) = payload_json else {
        return Ok(None);
    };

    let mut task = expect_object(
        parse_json(&payload_json, CRON_SETTINGS_TABLE)?,
        CRON_SETTINGS_TABLE,
    )?;
    inject_string_field(&mut task, "id", normalized_task_id.to_string());
    Ok(Some(Value::Object(task)))
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
    Ok(())
}

fn save_agents(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let templates = expect_array(payload, "settings_save_agents payload")?;
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {AGENT_PROMPT_TEMPLATES_TABLE} 事务失败：{e}"))?;
    tx.execute(AGENT_PROMPT_TEMPLATES_DELETE_SQL, [])
        .map_err(|e| format!("清空 {AGENT_PROMPT_TEMPLATES_TABLE} 失败：{e}"))?;

    let mut seen = HashSet::new();
    let mut enabled_template_id: Option<String> = None;
    for (sort_index, template) in templates.into_iter().enumerate() {
        let template = expect_object(template, "settings_save_agents payload[]")?;
        let template_id =
            extract_non_empty_string(&template, "id", "settings_save_agents payload[]")?;
        if !seen.insert(template_id.clone()) {
            return Err(format!(
                "{AGENT_PROMPT_TEMPLATES_TABLE}.template_id 重复：{template_id}"
            ));
        }

        let name = extract_non_empty_string(&template, "name", "settings_save_agents payload[]")?;
        let prompt =
            extract_non_empty_string(&template, "prompt", "settings_save_agents payload[]")?;
        let description = extract_optional_string(&template, "description");
        let tags =
            extract_string_array(template.get("tags"), "settings_save_agents payload[].tags")?;
        let enabled = match template.get("enabled") {
            Some(Value::Bool(value)) => *value,
            Some(Value::Null) | None => false,
            Some(_) => {
                return Err("settings_save_agents payload[].enabled 必须是布尔值".to_string());
            }
        };
        if enabled {
            if let Some(existing_id) = &enabled_template_id {
                return Err(format!(
                    "{AGENT_PROMPT_TEMPLATES_TABLE}.enabled 只能有一个激活项：{existing_id}, {template_id}"
                ));
            }
            enabled_template_id = Some(template_id.clone());
        }
        let tags_json = serialize_json(
            &Value::Array(tags.into_iter().map(Value::String).collect()),
            AGENT_PROMPT_TEMPLATES_TABLE,
        )?;

        tx.execute(
            AGENT_PROMPT_TEMPLATES_INSERT_SQL,
            params![
                template_id,
                name,
                description,
                tags_json,
                prompt,
                if enabled { 1_i64 } else { 0_i64 },
                sort_index as i64,
                updated_at
            ],
        )
        .map_err(|e| format!("写入 {AGENT_PROMPT_TEMPLATES_TABLE} 失败：{e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("提交 {AGENT_PROMPT_TEMPLATES_TABLE} 事务失败：{e}"))?;
    Ok(())
}

fn save_hooks(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let hooks = expect_array(payload, "settings_save_hooks payload")?;
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {HOOK_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(HOOK_SETTINGS_DELETE_SQL, [])
        .map_err(|e| format!("清空 {HOOK_SETTINGS_TABLE} 失败：{e}"))?;

    let mut seen = HashSet::new();
    for (sort_index, hook) in hooks.into_iter().enumerate() {
        let hook = expect_object(hook, "settings_save_hooks payload[]")?;
        let validated = validate_and_normalize_hook(hook, "settings_save_hooks payload[]")?;
        let hook_id = validated.hook_id;
        if !seen.insert(hook_id.clone()) {
            return Err(format!("{HOOK_SETTINGS_TABLE}.hook_id 重复：{hook_id}"));
        }

        tx.execute(
            HOOK_SETTINGS_INSERT_SQL,
            params![
                hook_id,
                serialize_json(&Value::Object(validated.payload), HOOK_SETTINGS_TABLE)?,
                sort_index as i64,
                updated_at
            ],
        )
        .map_err(|e| format!("写入 {HOOK_SETTINGS_TABLE} 失败：{e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("提交 {HOOK_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(())
}

fn save_cron(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let tasks = expect_array(payload, "settings_save_cron payload")?;
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(CRON_SETTINGS_DELETE_SQL, [])
        .map_err(|e| format!("清空 {CRON_SETTINGS_TABLE} 失败：{e}"))?;

    let mut seen = HashSet::new();
    for (sort_index, task) in tasks.into_iter().enumerate() {
        let validated = validate_and_normalize_cron_task(
            expect_object(task, "settings_save_cron payload[]")?,
            "settings_save_cron payload[]",
            CronTaskValidationOptions {
                require_id: true,
                default_enabled: false,
            },
        )?;
        let task_id = validated
            .task_id
            .clone()
            .ok_or_else(|| "settings_save_cron payload[].id 不能为空".to_string())?;
        if !seen.insert(task_id.clone()) {
            return Err(format!("{CRON_SETTINGS_TABLE}.task_id 重复：{task_id}"));
        }

        tx.execute(
            CRON_SETTINGS_INSERT_SQL,
            params![
                task_id,
                serialize_json(&Value::Object(validated.payload), CRON_SETTINGS_TABLE)?,
                sort_index as i64,
                updated_at
            ],
        )
        .map_err(|e| format!("写入 {CRON_SETTINGS_TABLE} 失败：{e}"))?;
    }

    tx.execute(
        &format!(
            "DELETE FROM {CRON_EXECUTION_LOGS_TABLE} WHERE task_id NOT IN (SELECT task_id FROM {CRON_SETTINGS_TABLE})"
        ),
        [],
    )
    .map_err(|e| format!("清理 {CRON_EXECUTION_LOGS_TABLE} 失败：{e}"))?;

    tx.commit()
        .map_err(|e| format!("提交 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(())
}

fn save_system(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let default_workdir = default_project_workdir()?;
    save_system_with_default_workdir(conn, payload, &default_workdir)
}

fn save_system_with_default_workdir(
    conn: &mut Connection,
    payload: Value,
    default_workdir: &str,
) -> Result<(), String> {
    let system = match system_value_with_defaults(
        Some(Value::Object(expect_object(
            payload,
            "settings_save_system payload",
        )?)),
        default_workdir,
    ) {
        Value::Object(system) => system,
        _ => unreachable!(),
    };
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {SYSTEM_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(SYSTEM_SETTINGS_DELETE_SQL, [])
        .map_err(|e| format!("清空 {SYSTEM_SETTINGS_TABLE} 失败：{e}"))?;

    for key in [
        SYSTEM_EXECUTION_MODE_KEY,
        SYSTEM_WORKDIR_KEY,
        SYSTEM_SELECTED_TOOLS_KEY,
    ] {
        let value = system.get(key).cloned().unwrap_or(Value::Null);
        tx.execute(
            SYSTEM_SETTINGS_INSERT_SQL,
            params![
                key,
                serialize_json(&value, SYSTEM_SETTINGS_TABLE)?,
                updated_at
            ],
        )
        .map_err(|e| format!("写入 {SYSTEM_SETTINGS_TABLE}.{key} 失败：{e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("提交 {SYSTEM_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(())
}

fn save_mcp(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let mcp = expect_object(payload, "settings_save_mcp payload")?;
    let servers = expect_array(
        mcp.get("servers")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
        "settings_save_mcp payload.servers",
    )?;
    let selected_ids =
        extract_string_array(mcp.get("selected"), "settings_save_mcp payload.selected")?;
    let selected_ids: HashSet<String> = selected_ids.into_iter().collect();

    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {MCP_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(MCP_SETTINGS_DELETE_SQL, [])
        .map_err(|e| format!("清空 {MCP_SETTINGS_TABLE} 失败：{e}"))?;

    let mut seen = HashSet::new();
    for (sort_index, server) in servers.into_iter().enumerate() {
        let mut server = expect_object(server, "settings_save_mcp payload.servers[]")?;
        let server_id =
            extract_non_empty_string(&server, "id", "settings_save_mcp payload.servers[]")?;
        if !seen.insert(server_id.clone()) {
            return Err(format!("mcp_settings.server_id 重复：{server_id}"));
        }

        server.insert(
            "selected".to_string(),
            Value::Bool(selected_ids.contains(&server_id)),
        );

        tx.execute(
            MCP_SETTINGS_INSERT_SQL,
            params![
                server_id,
                serialize_json(&Value::Object(server), MCP_SETTINGS_TABLE)?,
                sort_index as i64,
                updated_at
            ],
        )
        .map_err(|e| format!("写入 {MCP_SETTINGS_TABLE} 失败：{e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("提交 {MCP_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(())
}

fn save_remote(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let normalized = parse_remote_settings_payload(payload)?;
    let payload_json = serde_json::to_value(&normalized)
        .map_err(|e| format!("序列化 {REMOTE_SETTINGS_TABLE} 失败：{e}"))?;
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {REMOTE_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(
        &format!("DELETE FROM {REMOTE_SETTINGS_TABLE} WHERE config_id = 'default'"),
        [],
    )
    .map_err(|e| format!("清空 {REMOTE_SETTINGS_TABLE} 失败：{e}"))?;
    tx.execute(
        &format!(
            "INSERT INTO {REMOTE_SETTINGS_TABLE} (config_id, payload_json, updated_at) VALUES ('default', ?1, ?2)"
        ),
        params![serialize_json(&payload_json, REMOTE_SETTINGS_TABLE)?, updated_at],
    )
    .map_err(|e| format!("写入 {REMOTE_SETTINGS_TABLE} 失败：{e}"))?;
    tx.commit()
        .map_err(|e| format!("提交 {REMOTE_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(())
}

fn save_memory(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let memory = Value::Object(expect_object(payload, "settings_save_memory payload")?);
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {MEMORY_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(
        &format!("DELETE FROM {MEMORY_SETTINGS_TABLE} WHERE config_id = 'default'"),
        [],
    )
    .map_err(|e| format!("清空 {MEMORY_SETTINGS_TABLE} 失败：{e}"))?;
    tx.execute(
        &format!(
            "INSERT INTO {MEMORY_SETTINGS_TABLE} (config_id, payload_json, updated_at) VALUES ('default', ?1, ?2)"
        ),
        params![serialize_json(&memory, MEMORY_SETTINGS_TABLE)?, updated_at],
    )
    .map_err(|e| format!("写入 {MEMORY_SETTINGS_TABLE} 失败：{e}"))?;
    tx.commit()
        .map_err(|e| format!("提交 {MEMORY_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn settings_load_all() -> Result<SettingsLoadResponse, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let conn = open_db()?;
        let default_workdir = default_project_workdir()?;
        Ok(SettingsLoadResponse {
            providers: load_providers(&conn)?,
            system: Some(load_system_with_defaults(&conn, &default_workdir)?),
            mcp: load_mcp(&conn)?,
            agents: load_agents(&conn)?,
            hooks: load_hooks(&conn)?,
            cron: load_cron(&conn)?,
            remote: load_remote(&conn)?,
            memory: load_memory(&conn)?,
            default_workdir,
        })
    })
    .await
    .map_err(|e| format!("settings_load_all join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_providers(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_providers(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_providers join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_system(
    payload: Value,
    cron_manager: tauri::State<'_, Arc<CronManager>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_system(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_system join 失败：{e}"))??;
    cron_manager.request_reload();
    Ok(())
}

#[tauri::command]
pub async fn settings_save_mcp(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_mcp(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_mcp join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_remote(
    payload: Value,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    let normalized = parse_remote_settings_payload(payload)?;
    let persisted = serde_json::to_value(&normalized)
        .map_err(|e| format!("序列化 {REMOTE_SETTINGS_TABLE} 失败：{e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_remote(&mut conn, persisted)
    })
    .await
    .map_err(|e| format!("settings_save_remote join 失败：{e}"))??;
    gateway_controller.apply_config(normalized)
}

#[tauri::command]
pub async fn settings_save_memory(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_memory(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_memory join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_agents(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_agents(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_agents join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_hooks(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_hooks(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_hooks join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_cron(
    payload: Value,
    cron_manager: tauri::State<'_, Arc<CronManager>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_cron(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_cron join 失败：{e}"))??;
    cron_manager.request_reload();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open_memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        initialize_schema(&conn).expect("initialize schema");
        conn
    }

    #[test]
    fn initialize_schema_creates_all_tables() {
        let conn = open_memory_db();

        for table in [
            PROVIDER_SETTINGS_TABLE,
            SYSTEM_SETTINGS_TABLE,
            MCP_SETTINGS_TABLE,
            AGENT_PROMPT_TEMPLATES_TABLE,
            HOOK_SETTINGS_TABLE,
            CRON_SETTINGS_TABLE,
            CRON_EXECUTION_LOGS_TABLE,
            REMOTE_SETTINGS_TABLE,
            MEMORY_SETTINGS_TABLE,
        ] {
            let exists = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |row| row.get::<_, i64>(0),
                )
                .expect("query sqlite_master");
            assert_eq!(exists, 1, "table {table} should exist");
        }
    }

    #[test]
    fn save_memory_persists_default_payload_and_sync_snapshot() {
        let mut conn = open_memory_db();
        let payload = json!({
            "organizerModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5"
            },
            "summaryModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5.4"
            }
        });

        save_memory(&mut conn, payload.clone()).expect("save memory settings");

        assert_eq!(
            load_memory(&conn).expect("load memory settings"),
            Some(payload.clone())
        );
        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["memory"], payload);
    }

    #[test]
    fn normalize_remote_settings_repairs_single_slash_gateway_url() {
        let normalized = normalize_remote_settings_payload(RemoteSettingsPayload {
            enabled: true,
            gateway_url: " https:/agent.cnweb.org/ ".to_string(),
            grpc_port: 443,
            grpc_endpoint: " tcp.proxy.rlwy.net:12345/ ".to_string(),
            token: " agent-token-dev ".to_string(),
            agent_id: " mac-mini ".to_string(),
            auto_reconnect: true,
            heartbeat_interval: 30,
        });

        assert_eq!(normalized.gateway_url, "https://agent.cnweb.org");
        assert_eq!(normalized.grpc_endpoint, "tcp.proxy.rlwy.net:12345");
        assert_eq!(normalized.token, "agent-token-dev");
        assert_eq!(normalized.agent_id, "mac-mini");
    }

    #[test]
    fn save_providers_persists_one_row_per_provider_and_preserves_order() {
        let mut conn = open_memory_db();
        save_providers(
            &mut conn,
            json!([
                { "id": "provider-b", "name": "B" },
                { "id": "provider-a", "name": "A" }
            ]),
        )
        .expect("save providers");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM provider_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count provider rows");
        let loaded = load_providers(&conn).expect("load providers");

        assert_eq!(row_count, 2);
        assert_eq!(
            loaded,
            Some(json!([
                { "id": "provider-b", "name": "B" },
                { "id": "provider-a", "name": "A" }
            ]))
        );
    }

    #[test]
    fn gateway_settings_snapshot_redacts_provider_api_keys() {
        let mut conn = open_memory_db();
        save_providers(
            &mut conn,
            json!([
                {
                    "id": "provider-a",
                    "name": "A",
                    "apiKey": "secret-key",
                    "apiKeyConfigured": false
                },
                {
                    "id": "provider-b",
                    "name": "B",
                    "apiKey": "",
                    "apiKeyConfigured": true
                }
            ]),
        )
        .expect("save providers");

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["customProviders"][0]["apiKey"], Value::Null);
        assert_eq!(snapshot["customProviders"][0]["apiKeyConfigured"], true);
        assert_eq!(snapshot["customProviders"][1]["apiKey"], Value::Null);
        assert_eq!(snapshot["customProviders"][1]["apiKeyConfigured"], true);
    }

    #[test]
    fn save_mcp_persists_one_row_per_server_and_restores_selection() {
        let mut conn = open_memory_db();
        save_mcp(
            &mut conn,
            json!({
                "servers": [
                    { "id": "alpha", "enabled": true, "transport": "stdio" },
                    { "id": "beta", "enabled": false, "transport": "http" }
                ],
                "selected": ["beta"]
            }),
        )
        .expect("save mcp");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM mcp_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count mcp rows");
        let selected_flag = conn
            .query_row(
                "SELECT payload_json FROM mcp_settings WHERE server_id = 'beta'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("query beta payload");
        let loaded = load_mcp(&conn).expect("load mcp");

        assert_eq!(row_count, 2);
        assert!(
            selected_flag.contains("\"selected\":true"),
            "selected flag should be stored inline"
        );
        assert_eq!(
            loaded,
            Some(json!({
                "servers": [
                    { "id": "alpha", "enabled": true, "transport": "stdio" },
                    { "id": "beta", "enabled": false, "transport": "http" }
                ],
                "selected": ["beta"]
            }))
        );
    }

    #[test]
    fn save_agents_persists_one_row_per_template_and_restores_columns() {
        let mut conn = open_memory_db();
        save_agents(
            &mut conn,
            json!([
                {
                    "id": "reviewer",
                    "name": "代码审查",
                    "description": "用于审查 PR 和补测试缺口",
                    "tags": ["review", "qa"],
                    "prompt": "你是一个严格的代码审查助手。",
                    "enabled": true
                },
                {
                    "id": "planner",
                    "name": "任务规划",
                    "description": "",
                    "tags": [],
                    "prompt": "先拆任务，再执行。",
                    "enabled": false
                }
            ]),
        )
        .expect("save agents");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM agent_prompt_templates", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count agent rows");
        let stored_tags = conn
            .query_row(
                "SELECT tags_json FROM agent_prompt_templates WHERE template_id = 'reviewer'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("query reviewer tags");
        let stored_enabled = conn
            .query_row(
                "SELECT enabled FROM agent_prompt_templates WHERE template_id = 'reviewer'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("query reviewer enabled");
        let loaded = load_agents(&conn).expect("load agents");

        assert_eq!(row_count, 2);
        assert_eq!(stored_tags, "[\"review\",\"qa\"]");
        assert_eq!(stored_enabled, 1);
        assert_eq!(
            loaded,
            Some(json!([
                {
                    "id": "reviewer",
                    "name": "代码审查",
                    "description": "用于审查 PR 和补测试缺口",
                    "tags": ["review", "qa"],
                    "prompt": "你是一个严格的代码审查助手。",
                    "enabled": true
                },
                {
                    "id": "planner",
                    "name": "任务规划",
                    "description": "",
                    "tags": [],
                    "prompt": "先拆任务，再执行。",
                    "enabled": false
                }
            ]))
        );
    }

    #[test]
    fn save_system_persists_three_distinct_setting_rows() {
        let mut conn = open_memory_db();
        save_system(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "E:/Code/test_directory/003",
                "selectedSystemTools": ["http_get_test"]
            }),
        )
        .expect("save system");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM system_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count system rows");
        let keys = {
            let mut stmt = conn
                .prepare("SELECT setting_key FROM system_settings ORDER BY setting_key ASC")
                .expect("prepare key query");
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query keys");
            rows.into_iter()
                .map(|row| row.expect("key row"))
                .collect::<Vec<_>>()
        };
        let loaded = load_system(&conn).expect("load system");

        assert_eq!(row_count, 3);
        assert_eq!(
            keys,
            vec![
                SYSTEM_EXECUTION_MODE_KEY.to_string(),
                SYSTEM_SELECTED_TOOLS_KEY.to_string(),
                SYSTEM_WORKDIR_KEY.to_string(),
            ]
        );
        assert_eq!(
            loaded,
            Some(json!({
                "executionMode": "tools",
                "workdir": "E:/Code/test_directory/003",
                "selectedSystemTools": ["http_get_test"]
            }))
        );
    }

    #[test]
    fn save_system_backfills_empty_workdir_with_default_project() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "",
                "selectedSystemTools": []
            }),
            "/tmp/liveagent-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn).expect("load system");
        assert_eq!(
            loaded,
            Some(json!({
                "executionMode": "tools",
                "workdir": "/tmp/liveagent-default-project",
                "selectedSystemTools": []
            }))
        );
    }

    #[test]
    fn load_system_with_defaults_returns_agent_mode_and_default_project() {
        let conn = open_memory_db();
        let loaded = load_system_with_defaults(&conn, "/tmp/liveagent-default-project")
            .expect("load system");

        assert_eq!(
            loaded,
            json!({
                "executionMode": "tools",
                "workdir": "/tmp/liveagent-default-project",
                "selectedSystemTools": []
            })
        );
    }

    #[test]
    fn save_hooks_persists_one_row_per_hook_and_preserves_order() {
        let mut conn = open_memory_db();
        save_hooks(
            &mut conn,
            json!([
                {
                    "id": "hook-a",
                    "event": "agent_start",
                    "name": "Command Hook",
                    "description": "",
                    "type": "command",
                    "enabled": true,
                    "script": "echo hook-a"
                },
                {
                    "id": "hook-b",
                    "event": "agent_end",
                    "name": "HTTP Hook",
                    "description": "",
                    "type": "http",
                    "enabled": false,
                    "requests": [
                        {
                            "id": "request-1",
                            "url": "https://example.com/hook",
                            "method": "POST",
                            "headers": { "x-test": "1" }
                        }
                    ]
                }
            ]),
        )
        .expect("save hooks");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM hook_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count hook rows");
        let loaded = load_hooks(&conn).expect("load hooks");

        assert_eq!(row_count, 2);
        assert_eq!(
            loaded,
            Some(json!([
                {
                    "id": "hook-a",
                    "event": "agent_start",
                    "name": "Command Hook",
                    "description": "",
                    "type": "command",
                    "enabled": true,
                    "script": "echo hook-a"
                },
                {
                    "id": "hook-b",
                    "event": "agent_end",
                    "name": "HTTP Hook",
                    "description": "",
                    "type": "http",
                    "enabled": false,
                    "requests": [
                        {
                            "id": "request-1",
                            "url": "https://example.com/hook",
                            "method": "POST",
                            "headers": { "x-test": "1" }
                        }
                    ]
                }
            ]))
        );
    }

    #[test]
    fn save_hooks_rejects_legacy_commands() {
        let mut conn = open_memory_db();
        let error = save_hooks(
            &mut conn,
            json!([
                {
                    "id": "hook-a",
                    "event": "agent_start",
                    "name": "Command Hook",
                    "description": "",
                    "type": "command",
                    "enabled": true,
                    "commands": [["cmd", "/C", "echo", "a"]]
                }
            ]),
        )
        .expect_err("reject legacy hook commands");

        assert!(error.contains("commands"));
        let count = conn
            .query_row("SELECT COUNT(*) FROM hook_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count hook rows");
        assert_eq!(count, 0);
    }

    #[test]
    fn save_cron_persists_one_row_per_task_and_restores_order() {
        let mut conn = open_memory_db();
        save_cron(
            &mut conn,
            json!([
                {
                    "id": "cron-a",
                    "name": "Build",
                    "description": "Run build",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "bash",
                    "script": "npm run build"
                },
                {
                    "id": "cron-b",
                    "name": "Daily Summary",
                    "description": "",
                    "cron": "0 0 * * * *",
                    "enabled": false,
                    "type": "prompt",
                    "prompt": "Summarize yesterday's important changes.",
                    "selectedModel": {
                        "customProviderId": "builtin-codex",
                        "model": "gpt-5"
                    }
                }
            ]),
        )
        .expect("save cron");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM cron_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count cron rows");
        let loaded = load_cron(&conn).expect("load cron");

        assert_eq!(row_count, 2);
        assert_eq!(
            loaded,
            Some(json!([
                {
                    "id": "cron-a",
                    "name": "Build",
                    "description": "Run build",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "bash",
                    "script": "npm run build"
                },
                {
                    "id": "cron-b",
                    "name": "Daily Summary",
                    "description": "",
                    "cron": "0 0 * * * *",
                    "enabled": false,
                    "type": "prompt",
                    "prompt": "Summarize yesterday's important changes.",
                    "selectedModel": {
                        "customProviderId": "builtin-codex",
                        "model": "gpt-5"
                    }
                }
            ]))
        );
    }

    #[test]
    fn save_cron_normalizes_remaining_executions_and_disables_exhausted_tasks() {
        let mut conn = open_memory_db();
        save_cron(
            &mut conn,
            json!([
                {
                    "id": "cron-finite",
                    "name": "Finite",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "remainingExecutions": "2",
                    "type": "bash",
                    "script": "echo finite"
                },
                {
                    "id": "cron-exhausted",
                    "name": "Exhausted",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "remainingExecutions": 0,
                    "type": "bash",
                    "script": "echo exhausted"
                },
                {
                    "id": "cron-unlimited",
                    "name": "Unlimited",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "remainingExecutions": null,
                    "type": "bash",
                    "script": "echo unlimited"
                }
            ]),
        )
        .expect("save cron");

        let loaded = load_cron(&conn).expect("load cron").expect("cron payload");
        assert_eq!(
            loaded,
            json!([
                {
                    "id": "cron-finite",
                    "name": "Finite",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "remainingExecutions": 2,
                    "type": "bash",
                    "script": "echo finite"
                },
                {
                    "id": "cron-exhausted",
                    "name": "Exhausted",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": false,
                    "remainingExecutions": 0,
                    "type": "bash",
                    "script": "echo exhausted"
                },
                {
                    "id": "cron-unlimited",
                    "name": "Unlimited",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "bash",
                    "script": "echo unlimited"
                }
            ])
        );
    }

    #[test]
    fn save_cron_rejects_empty_bash_script() {
        let mut conn = open_memory_db();
        let error = save_cron(
            &mut conn,
            json!([
                {
                    "id": "cron-a",
                    "name": "Build",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "bash",
                    "script": ""
                }
            ]),
        )
        .expect_err("reject empty bash script");

        assert!(error.contains("script"));
        let count = conn
            .query_row("SELECT COUNT(*) FROM cron_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count cron rows");
        assert_eq!(count, 0);
    }

    #[test]
    fn save_cron_rejects_legacy_bash_commands() {
        let mut conn = open_memory_db();
        let error = save_cron(
            &mut conn,
            json!([
                {
                    "id": "cron-a",
                    "name": "Build",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "bash",
                    "commands": [["npm", "run", "build"]]
                }
            ]),
        )
        .expect_err("reject legacy bash commands");

        assert!(error.contains("commands"));
        let count = conn
            .query_row("SELECT COUNT(*) FROM cron_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count cron rows");
        assert_eq!(count, 0);
    }

    #[test]
    fn save_cron_rejects_commands_field_for_non_bash_tasks() {
        let mut conn = open_memory_db();
        let error = save_cron(
            &mut conn,
            json!([
                {
                    "id": "cron-a",
                    "name": "Webhook",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "http",
                    "commands": [["npm", "run", "build"]],
                    "requests": [
                        {
                            "id": "request-1",
                            "url": "https://example.com/hook",
                            "method": "POST"
                        }
                    ]
                }
            ]),
        )
        .expect_err("reject commands field on non-bash task");

        assert!(error.contains("commands"));
        let count = conn
            .query_row("SELECT COUNT(*) FROM cron_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count cron rows");
        assert_eq!(count, 0);
    }

    #[test]
    fn save_cron_rejects_http_request_with_relative_url() {
        let mut conn = open_memory_db();
        let error = save_cron(
            &mut conn,
            json!([
                {
                    "id": "cron-a",
                    "name": "Webhook",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "http",
                    "requests": [
                        {
                            "id": "request-1",
                            "url": "/relative",
                            "method": "POST"
                        }
                    ]
                }
            ]),
        )
        .expect_err("reject relative url");

        assert!(error.contains("绝对 URL"));
        let count = conn
            .query_row("SELECT COUNT(*) FROM cron_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count cron rows");
        assert_eq!(count, 0);
    }
}
