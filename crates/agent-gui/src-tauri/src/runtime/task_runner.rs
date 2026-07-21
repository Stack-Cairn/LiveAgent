use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::runtime::platform::{expand_tilde_path, strip_windows_verbatim_prefix};

const DEFAULT_HTTP_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestInput {
    pub id: String,
    pub url: String,
    pub method: String,
    pub headers: Option<BTreeMap<String, String>>,
    pub body: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpExecutionResult {
    pub id: String,
    pub url: String,
    pub method: String,
    pub status: u16,
    pub response_body: String,
    pub duration_ms: u128,
}

#[derive(Debug, Clone)]
pub struct HttpExecutionFailure {
    pub duration_ms: u128,
    message: String,
}

impl HttpExecutionFailure {
    fn new(duration_ms: u128, message: String) -> Self {
        Self {
            duration_ms,
            message,
        }
    }
}

impl std::fmt::Display for HttpExecutionFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for HttpExecutionFailure {}

pub(crate) fn resolve_workdir(workdir: Option<String>) -> Result<PathBuf, String> {
    let raw = workdir.unwrap_or_default();
    let base = if raw.trim().is_empty() {
        std::env::current_dir().map_err(|e| format!("读取应用 cwd 失败：{e}"))?
    } else {
        let path = expand_tilde_path(raw.trim());
        if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map_err(|e| format!("读取应用 cwd 失败：{e}"))?
                .join(path)
        }
    };

    let metadata = fs::metadata(&base).map_err(|e| format!("Hook 工作目录无效：{e}"))?;
    if !metadata.is_dir() {
        return Err("Hook 工作目录必须是目录".to_string());
    }
    // The resolved path is stringified into PromptRunRequest.workdir and used
    // as a child-process cwd: keep it in classic Win32 form, not `\\?\`.
    fs::canonicalize(base)
        .map(strip_windows_verbatim_prefix)
        .map_err(|e| format!("解析 Hook 工作目录失败：{e}"))
}

fn build_header_map(headers: &Option<BTreeMap<String, String>>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    let Some(headers) = headers else {
        return Ok(map);
    };

    for (key, value) in headers {
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| format!("无效 Hook header name：{key}"))?;
        let value =
            HeaderValue::from_str(value).map_err(|_| format!("无效 Hook header value：{key}"))?;
        map.insert(name, value);
    }

    Ok(map)
}

/// `timeout_ms` bounds every request made by the returned client; `None`
/// keeps the legacy 10s default used by hooks.
///
/// Hook / Cron HTTP 与其他应用出网点同策略：应用代理启用时经代理出网
/// （环回地址豁免），配置异常 fail fast；未启用则直连并忽略环境代理，
/// 避免 OS 级 HTTP(S)_PROXY 悄悄劫持自动化请求。
pub(crate) fn build_http_client(timeout_ms: Option<u64>) -> Result<Client, String> {
    crate::services::system_proxy::blocking_client_builder()
        .map_err(|e| format!("创建 Hook HTTP client 失败：{e}"))?
        .timeout(Duration::from_millis(
            timeout_ms.unwrap_or(DEFAULT_HTTP_TIMEOUT_MS).max(1),
        ))
        .build()
        .map_err(|e| format!("创建 Hook HTTP client 失败：{e}"))
}

pub(crate) fn run_single_http_request(
    client: &Client,
    request: HttpRequestInput,
) -> Result<HttpExecutionResult, HttpExecutionFailure> {
    let method_raw = request.method.trim().to_uppercase();
    let method = Method::from_bytes(method_raw.as_bytes()).map_err(|_| {
        HttpExecutionFailure::new(0, format!("无效 Hook HTTP method：{method_raw}"))
    })?;
    let url = request.url.trim().to_string();
    if url.is_empty() {
        return Err(HttpExecutionFailure::new(
            0,
            "Hook HTTP 请求 URL 不能为空".to_string(),
        ));
    }
    Url::parse(&url)
        .map_err(|e| HttpExecutionFailure::new(0, format!("无效 Hook HTTP URL：{url} ({e})")))?;

    let headers = build_header_map(&request.headers)
        .map_err(|message| HttpExecutionFailure::new(0, message))?;
    let start = Instant::now();
    let mut builder = client.request(method.clone(), &url);
    if !headers.is_empty() {
        builder = builder.headers(headers);
    }
    if matches!(
        method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        if let Some(body) = &request.body {
            builder = builder.json(body);
        }
    }

    let response = builder.send().map_err(|e| {
        HttpExecutionFailure::new(
            start.elapsed().as_millis(),
            format!("Hook HTTP 请求失败：{} {} ({e})", method, url),
        )
    })?;
    let status = response.status();
    let response_body = response.text().map_err(|e| {
        HttpExecutionFailure::new(
            start.elapsed().as_millis(),
            format!("读取 Hook HTTP 响应失败：{} {} ({e})", method, url),
        )
    })?;
    let duration_ms = start.elapsed().as_millis();

    if !status.is_success() {
        let preview = response_body.trim();
        return Err(HttpExecutionFailure::new(
            duration_ms,
            if preview.is_empty() {
                format!("Hook HTTP 请求失败：{} {} -> {}", method, url, status)
            } else {
                format!(
                    "Hook HTTP 请求失败：{} {} -> {}\n{}",
                    method, url, status, preview
                )
            },
        ));
    }

    Ok(HttpExecutionResult {
        id: request.id,
        url,
        method: method_raw,
        status: status.as_u16(),
        response_body,
        duration_ms,
    })
}
