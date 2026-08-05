use std::collections::BTreeMap;

use chrono::Local;
use serde_json::{Map, Value};
use tokio_cron_scheduler::Job;
use uuid::Uuid;

use super::types::{
    http_method_can_have_body, CronTask, HookDef, HttpRequestSpec, SelectedModelRef,
    CRON_REASONING_LEVELS, CRON_TASK_KINDS, DEFAULT_CRON_TIMEOUT_SECONDS, HOOK_EVENTS, HOOK_KINDS,
    HTTP_METHODS, MASKED_HEADER_VALUE,
};

pub const MIN_HOOK_TIMEOUT_MS: u64 = 1_000;
pub const MAX_HOOK_TIMEOUT_MS: u64 = 10 * 60_000;

/// Cron timeout bounds. The upper bound mirrors the shell runner's hard cap
/// (MAX_SHELL_TIMEOUT_MS): a larger stored value would silently be cut to ten
/// minutes for bash tasks, so validation refuses to store one.
pub const MIN_CRON_TIMEOUT_SECONDS: u64 = 1;
pub const MAX_CRON_TIMEOUT_SECONDS: u64 = 600;

pub fn validate_cron_expression(expression: &str) -> Result<(), String> {
    let trimmed = expression.trim();
    if trimmed.is_empty() {
        return Err("Cron 表达式不能为空".to_string());
    }
    if trimmed.split_whitespace().count() != 6 {
        return Err("Cron 表达式必须是标准六段格式（秒 分 时 日 月 周）".to_string());
    }
    Job::new_async_tz(trimmed, Local, |_job_id, _lock| Box::pin(async move {}))
        .map(|_| ())
        .map_err(|e| format!("无效 Cron 表达式：{trimmed} ({e})"))
}

fn expect_object(value: Value, label: &str) -> Result<Map<String, Value>, String> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(format!("{label} 必须是对象")),
    }
}

fn required_string(map: &Map<String, Value>, key: &str, label: &str) -> Result<String, String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("{label}.{key} 不能为空"))
}

fn optional_string(map: &Map<String, Value>, key: &str) -> String {
    map.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn bool_with_default(
    map: &Map<String, Value>,
    key: &str,
    label: &str,
    default: bool,
) -> Result<bool, String> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(format!("{label}.{key} 必须是布尔值")),
    }
}

fn parse_remaining_executions(
    map: &Map<String, Value>,
    label: &str,
) -> Result<Option<u64>, String> {
    match map.get("remainingExecutions") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("{label}.remainingExecutions 必须是非负整数")),
        Some(_) => Err(format!("{label}.remainingExecutions 必须是非负整数")),
    }
}

fn parse_timeout_seconds(map: &Map<String, Value>, label: &str) -> Result<u64, String> {
    match map.get("timeoutSeconds") {
        None | Some(Value::Null) => Ok(DEFAULT_CRON_TIMEOUT_SECONDS),
        Some(Value::Number(number)) => {
            let value = number
                .as_u64()
                .ok_or_else(|| format!("{label}.timeoutSeconds 必须是正整数（秒）"))?;
            if !(MIN_CRON_TIMEOUT_SECONDS..=MAX_CRON_TIMEOUT_SECONDS).contains(&value) {
                return Err(format!(
                    "{label}.timeoutSeconds 必须在 {MIN_CRON_TIMEOUT_SECONDS}-{MAX_CRON_TIMEOUT_SECONDS} 秒之间"
                ));
            }
            Ok(value)
        }
        Some(_) => Err(format!("{label}.timeoutSeconds 必须是正整数（秒）")),
    }
}

fn parse_http_requests(
    map: &Map<String, Value>,
    label: &str,
) -> Result<Vec<HttpRequestSpec>, String> {
    let requests = map
        .get("requests")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{label}.requests 至少需要一个请求"))?;
    if requests.is_empty() {
        return Err(format!("{label}.requests 至少需要一个请求"));
    }

    let mut normalized = Vec::with_capacity(requests.len());
    for (index, request_value) in requests.iter().enumerate() {
        let item_label = format!("{label}.requests[{index}]");
        let request = request_value
            .as_object()
            .ok_or_else(|| format!("{item_label} 必须是对象"))?;
        let id = request
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let url = required_string(request, "url", &item_label)?;
        reqwest::Url::parse(&url).map_err(|_| format!("{item_label}.url 必须是绝对 URL"))?;
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("POST")
            .to_ascii_uppercase();
        if !HTTP_METHODS.contains(&method.as_str()) {
            return Err(format!("{item_label}.method 不支持：{method}"));
        }
        let headers = parse_headers(request.get("headers"), &item_label)?;
        let body = if http_method_can_have_body(&method) {
            request
                .get("body")
                .filter(|value| !value.is_null())
                .cloned()
        } else {
            None
        };
        normalized.push(HttpRequestSpec {
            id,
            url,
            method,
            headers,
            body,
        });
    }
    Ok(normalized)
}

fn parse_headers(
    value: Option<&Value>,
    label: &str,
) -> Result<Option<BTreeMap<String, String>>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let headers = value
        .as_object()
        .ok_or_else(|| format!("{label}.headers 必须是对象"))?;
    let mut normalized = BTreeMap::new();
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
        normalized.insert(key.to_string(), header_value);
    }
    if normalized.is_empty() {
        Ok(None)
    } else {
        Ok(Some(normalized))
    }
}

fn parse_selected_model(value: Option<&Value>, label: &str) -> Result<SelectedModelRef, String> {
    let map = value
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{label}.selectedModel 不能为空"))?;
    Ok(SelectedModelRef {
        custom_provider_id: required_string(
            map,
            "customProviderId",
            &format!("{label}.selectedModel"),
        )?,
        model: required_string(map, "model", &format!("{label}.selectedModel"))?,
    })
}

/// Validate a full cron task object. `id` must already be present (callers
/// mint one for creates before validation).
pub fn validate_cron_task(value: Value, label: &str) -> Result<CronTask, String> {
    let map = expect_object(value, label)?;
    let id = required_string(&map, "id", label)?;
    let name = required_string(&map, "name", label)?;
    let description = optional_string(&map, "description");
    let cron = required_string(&map, "cron", label)?;
    validate_cron_expression(&cron)?;
    let remaining_executions = parse_remaining_executions(&map, label)?;
    let timeout_seconds = parse_timeout_seconds(&map, label)?;
    let enabled =
        bool_with_default(&map, "enabled", label, false)? && remaining_executions != Some(0);
    let kind = map
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("bash")
        .to_string();
    if !CRON_TASK_KINDS.contains(&kind.as_str()) {
        return Err(format!("{label}.type 不支持：{kind}"));
    }

    let mut task = CronTask {
        id,
        name,
        description,
        cron,
        enabled,
        remaining_executions,
        timeout_seconds,
        kind: kind.clone(),
        script: None,
        requests: None,
        prompt: None,
        selected_model: None,
        reasoning: None,
        workdir: None,
        last_error: None,
    };

    match kind.as_str() {
        "bash" => {
            task.script = Some(required_string(&map, "script", label)?);
        }
        "http" => {
            task.requests = Some(parse_http_requests(&map, label)?);
        }
        "prompt" => {
            task.prompt = Some(required_string(&map, "prompt", label)?);
            task.selected_model = Some(parse_selected_model(map.get("selectedModel"), label)?);
            // Empty/missing means the runtime default thinking level.
            let reasoning = optional_string(&map, "reasoning");
            if !reasoning.is_empty() {
                if !CRON_REASONING_LEVELS.contains(&reasoning.as_str()) {
                    return Err(format!("{label}.reasoning 不支持：{reasoning}"));
                }
                task.reasoning = Some(reasoning);
            }
        }
        _ => unreachable!(),
    }

    // Empty/missing/null all mean "follow the active workspace"; http tasks
    // never carry a workdir.
    if kind != "http" {
        let workdir = optional_string(&map, "workdir");
        if !workdir.is_empty() {
            task.workdir = Some(workdir);
        }
    }

    Ok(task)
}

/// Validate a full hook object. `id` must already be present.
pub fn validate_hook(value: Value, label: &str) -> Result<HookDef, String> {
    let map = expect_object(value, label)?;
    let id = required_string(&map, "id", label)?;
    let name = required_string(&map, "name", label)?;
    let description = optional_string(&map, "description");
    let event = map
        .get("event")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("agent_start")
        .to_string();
    if !HOOK_EVENTS.contains(&event.as_str()) {
        return Err(format!("{label}.event 不支持：{event}"));
    }
    let enabled = bool_with_default(&map, "enabled", label, false)?;
    let kind = map
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("command")
        .to_string();
    if !HOOK_KINDS.contains(&kind.as_str()) {
        return Err(format!("{label}.type 不支持：{kind}"));
    }
    let timeout_ms = match map.get("timeoutMs") {
        None | Some(Value::Null) => None,
        Some(Value::Number(number)) => {
            let value = number
                .as_u64()
                .ok_or_else(|| format!("{label}.timeoutMs 必须是正整数"))?;
            Some(value.clamp(MIN_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS))
        }
        Some(_) => return Err(format!("{label}.timeoutMs 必须是正整数")),
    };

    let mut hook = HookDef {
        id,
        name,
        description,
        event,
        enabled,
        kind: kind.clone(),
        script: None,
        requests: None,
        timeout_ms,
    };

    match kind.as_str() {
        "command" => {
            hook.script = Some(required_string(&map, "script", label)?);
        }
        "http" => {
            hook.requests = Some(parse_http_requests(&map, label)?);
        }
        _ => unreachable!(),
    }

    Ok(hook)
}

/// Merge a partial patch onto a stored item (top-level keys), returning the
/// merged object for re-validation.
pub fn merge_patch(
    stored: &impl serde::Serialize,
    patch: Value,
    label: &str,
) -> Result<Value, String> {
    let base = serde_json::to_value(stored).map_err(|e| format!("{label} 序列化失败：{e}"))?;
    let mut merged = expect_object(base, label)?;
    let patch = expect_object(patch, &format!("{label}.patch"))?;
    for (key, value) in patch {
        if key == "id" {
            continue;
        }
        merged.insert(key, value);
    }
    Ok(Value::Object(merged))
}

/// Replace masked header values in `incoming` with the currently stored values
/// so remote clients can round-trip requests without seeing secrets.
pub fn restore_masked_headers(incoming: &mut Value, stored_requests: Option<&[HttpRequestSpec]>) {
    let Some(requests) = incoming.get_mut("requests").and_then(Value::as_array_mut) else {
        return;
    };
    for request in requests {
        let request_id = request
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let stored_headers = stored_requests
            .and_then(|stored| stored.iter().find(|item| item.id == request_id))
            .and_then(|item| item.headers.as_ref());
        let Some(headers) = request.get_mut("headers").and_then(Value::as_object_mut) else {
            continue;
        };
        for (key, value) in headers.iter_mut() {
            if value.as_str() == Some(MASKED_HEADER_VALUE) {
                *value = stored_headers
                    .and_then(|stored| stored.get(key))
                    .map(|stored| Value::String(stored.clone()))
                    .unwrap_or(Value::Null);
            }
        }
    }
}

/// Mask header values for snapshots leaving the desktop.
pub fn mask_request_headers(requests: &mut Option<Vec<HttpRequestSpec>>) {
    if let Some(requests) = requests {
        for request in requests {
            if let Some(headers) = request.headers.as_mut() {
                for value in headers.values_mut() {
                    *value = MASKED_HEADER_VALUE.to_string();
                }
            }
        }
    }
}
