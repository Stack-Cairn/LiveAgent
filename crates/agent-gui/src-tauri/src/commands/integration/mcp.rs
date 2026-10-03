use reqwest::blocking::Client as HttpClient;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::StatusCode;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use crate::runtime::platform::{
    expand_tilde_path, maybe_augment_macos_path, resolve_program_path_with_current_dir,
};
use crate::runtime::process::{configure_child_process_group, kill_child_process_tree_best_effort};
use crate::runtime::shell_runner::ShellRunRegistry;

use super::mcp_protocol::{self, ParamHeader, VersionChoice};

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const LEGACY_SSE_ENDPOINT_WAIT_MS: u64 = 3_000;
const STDERR_TAIL_MAX_LINES: usize = 200;

pub(crate) async fn run_blocking<R: Send + 'static>(
    label: &'static str,
    f: impl FnOnce() -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("{label} join failed: {e}"))?
}

/// OAuth 鉴权配置（docs/design/mcp-oauth.md）。缺省/`type:"none"` = 现状
/// （静态 `headers` 继续生效）；`type:"oauth"` 且 transport 为 http/sse 时
/// 启用 Bearer 注入与 401 刷新链。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthConfig {
    #[serde(rename = "type")]
    pub auth_type: String,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub enabled: bool,
    pub transport: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    pub env: Option<BTreeMap<String, String>>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    pub headers: Option<BTreeMap<String, String>>,
    pub timeout_ms: Option<u64>,
    pub message_url: Option<String>,
    #[serde(default)]
    pub auth: Option<McpAuthConfig>,
}

impl McpServerConfig {
    fn transport(&self) -> &str {
        self.transport.as_deref().unwrap_or("stdio")
    }

    fn timeout(&self) -> Duration {
        let ms = self.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(1);
        Duration::from_millis(ms)
    }

    pub(crate) fn url_trimmed(&self) -> Option<&str> {
        self.url
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
    }

    fn message_url_trimmed(&self) -> Option<&str> {
        self.message_url
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
    }

    pub(crate) fn oauth_enabled(&self) -> bool {
        matches!(self.transport().trim(), "http" | "sse")
            && self
                .auth
                .as_ref()
                .is_some_and(|auth| auth.auth_type.trim() == "oauth")
    }

    pub(crate) fn oauth_server(&self) -> Option<crate::services::mcp_oauth::OauthServer> {
        let url = self.url_trimmed()?;
        let auth = self.auth.as_ref();
        Some(crate::services::mcp_oauth::OauthServer {
            id: self.id.trim().to_string(),
            url: url.to_string(),
            scope_override: auth
                .and_then(|a| a.scope.clone())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            static_client_id: auth
                .and_then(|a| a.client_id.clone())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        })
    }
}

fn build_stdio_command(cmd: &str, args: &[String], cwd: Option<&Path>) -> Command {
    let program = resolve_program_path_with_current_dir(cmd, cwd);

    #[cfg(windows)]
    {
        if is_windows_batch_program(&program) {
            use std::os::windows::process::CommandExt;

            // .cmd/.bat 无法被 CreateProcess 直接执行，需经 cmd.exe 转发。
            // /C 后的命令行必须用 raw_arg 原样传入：arg() 会按 MSVCRT 规则
            // 把内嵌引号转义成 `\"`，cmd.exe 不识别该转义，子进程瞬退，
            // stdin 写入报 os error 232（issue #205）。
            // /E:ON 保证命令扩展可用（`%%cd:~,` 防展开 hack 依赖它），
            // /V:OFF 关闭延迟展开，防止参数里的 `!VAR!` 被替换；
            // 均与 std `make_bat_command_line` 的 `/e:ON /v:OFF` 对齐。
            let mut command = Command::new("cmd.exe");
            command
                .arg("/E:ON")
                .arg("/V:OFF")
                .arg("/D")
                .arg("/S")
                .arg("/C");
            command.raw_arg(windows_cmd_c_argument(&program, args));
            return command;
        }
    }

    let mut command = Command::new(program);
    command.args(args);
    command
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_windows_batch_program(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .unwrap_or(false)
}

/// 组装 `cmd.exe /S /C` 之后的整段命令行：外层再包一对引号，`/S` 语义下
/// cmd 仅剥掉首尾引号，剩余部分按原样执行。
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_cmd_c_argument(program: &Path, args: &[String]) -> String {
    let line = std::iter::once(program.to_string_lossy().into_owned())
        .chain(args.iter().cloned())
        .map(|value| windows_cmd_quote_arg(&value))
        .collect::<Vec<_>>()
        .join(" ");
    format!("\"{line}\"")
}

/// 引号包裹单个参数，转义规则对齐 std `sys/args/windows.rs::append_bat_arg`：
/// - 内嵌引号前的反斜杠补齐至 2n 再把引号翻倍（cmd.exe 不识别 `\"`）；
/// - 收尾引号前的尾部反斜杠同样翻倍，防止 `C:\dir\` 这类参数把闭合引号
///   转义掉、与后一个参数粘连；
/// - `%`/`\r` 前插入 `%%cd:~,` no-op（yt-dlp hack，依赖 `/E:ON`），阻止
///   `%VAR%` 被 cmd 当环境变量展开，子进程仍收到原文。
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_cmd_quote_arg(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    let mut backslashes = 0usize;
    for ch in value.chars() {
        if ch == '\\' {
            backslashes += 1;
        } else {
            if ch == '"' {
                escaped.extend(std::iter::repeat_n('\\', backslashes));
                escaped.push('"');
            } else if ch == '%' || ch == '\r' {
                escaped.push_str("%%cd:~,");
            }
            backslashes = 0;
        }
        escaped.push(ch);
    }
    escaped.extend(std::iter::repeat_n('\\', backslashes));
    escaped.push('"');
    escaped
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server_id: String,
    pub server_label: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// 发给前端的工具结果内容块。
///
/// 注意 serde 的坑：enum 上的 `rename_all` 只重命名**变体名**（`Image` →
/// `"image"`），**不作用于变体内部字段**——字段要靠变体上的 `rename_all`
/// 单独声明。漏掉的话 `mime_type` 会原样以 snake_case 出去，而 TS 侧
/// （pi-ai、UI 预览）读的是 `mimeType`，拿到 undefined 后拼出
/// `data:undefined;base64,…`，下一轮请求带上这条工具结果时被 provider
/// 整个拒掉。字段形状有 `mcp_content_image_serializes_camel_case` 钉住。
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpContent {
    Text {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        data: String,
        mime_type: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallToolResponse {
    pub content: Vec<McpContent>,
    pub is_error: bool,
    pub details: Value,
}

#[derive(Default)]
pub struct McpRuntimeManager {
    clients: Mutex<HashMap<String, Arc<Mutex<McpClient>>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeStatus {
    pub server_id: String,
    pub running: bool,
    pub initialized: bool,
    pub transport: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStopServerResponse {
    pub server_id: String,
    pub stopped: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDiagnosticToolInfo {
    pub server_id: String,
    pub server_label: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeTestResponse {
    pub server_id: String,
    pub ok: bool,
    pub phase: String,
    pub transport: String,
    pub duration_ms: u128,
    pub running: bool,
    pub initialized: bool,
    pub tools_count: usize,
    pub tools: Vec<McpDiagnosticToolInfo>,
    pub error: Option<String>,
    pub stderr_tail: Option<String>,
    /// 实际使用的 MCP 协议版本（modern 如 `2026-07-28`，legacy 为握手协商结果）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    /// oauth 启用时的授权诊断（状态/过期/存储后端），永不含 token 本体。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<crate::services::mcp_oauth::OauthStatusInfo>,
}

fn oauth_diag(cfg: &McpServerConfig) -> Option<crate::services::mcp_oauth::OauthStatusInfo> {
    if !cfg.oauth_enabled() {
        return None;
    }
    cfg.oauth_server()
        .map(|server| crate::services::mcp_oauth::status(&server))
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
    #[serde(default)]
    data: Option<Value>,
}

#[derive(Debug)]
enum McpTransportError {
    Message(String),
    /// JSON-RPC error 响应：保留 code/data，供协议代际探测与版本协商识别
    /// modern 错误（如 UnsupportedProtocolVersion）。
    Rpc {
        code: i64,
        data: Option<Value>,
        message: String,
    },
    /// 超时内没等到响应。stdio 探测据此判定「静默的 legacy server」。
    Timeout(String),
    SessionExpired404,
    /// oauth 启用时的 401：上层做一次被动刷新重试，不可行则转标记性错误。
    Unauthorized,
}

impl McpTransportError {
    fn msg(s: impl Into<String>) -> Self {
        Self::Message(s.into())
    }

    fn into_message(self) -> String {
        match self {
            Self::Message(m) | Self::Timeout(m) | Self::Rpc { message: m, .. } => m,
            Self::SessionExpired404 => "MCP session expired (HTTP 404)".to_string(),
            Self::Unauthorized => "MCP server returned 401 Unauthorized".to_string(),
        }
    }

    /// 在错误文本后追加上下文（如 stdio stderr 尾部），不改变错误分类。
    fn with_suffix(self, suffix: &str) -> Self {
        if suffix.is_empty() {
            return self;
        }
        match self {
            Self::Message(m) => Self::Message(format!("{m}{suffix}")),
            Self::Timeout(m) => Self::Timeout(format!("{m}{suffix}")),
            Self::Rpc {
                code,
                data,
                message,
            } => Self::Rpc {
                code,
                data,
                message: format!("{message}{suffix}"),
            },
            other => other,
        }
    }
}

/// 单次请求的可选项：探测用的短超时、modern HTTP 的 `Mcp-Param-*` 头。
#[derive(Default)]
struct RequestOpts<'a> {
    timeout: Option<Duration>,
    extra_headers: &'a [(String, String)],
}

fn build_header_map(headers: &Option<BTreeMap<String, String>>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    let Some(headers) = headers else {
        return Ok(map);
    };
    for (k, v) in headers {
        let name =
            HeaderName::from_bytes(k.as_bytes()).map_err(|_| format!("无效 header name：{k}"))?;
        let value = HeaderValue::from_str(v).map_err(|_| format!("无效 header value：{k}"))?;
        map.insert(name, value);
    }
    Ok(map)
}

/// 合并静态 headers 与 OAuth Bearer。Bearer 必须经 `HeaderMap::insert` 覆盖
/// 同名条目：静态配置里残留的 `Authorization`（如迁移到 OAuth 前手工填的
/// token）若走 reqwest `RequestBuilder::header`（append 语义）追加，请求会
/// 带上两个 Authorization 头，server/代理可能取错凭据或直接拒收。
fn headers_with_bearer(static_headers: &HeaderMap, bearer: Option<&str>) -> HeaderMap {
    let mut merged = static_headers.clone();
    if let Some(bearer) = bearer {
        if let Ok(value) = HeaderValue::from_str(&format!("Bearer {bearer}")) {
            merged.insert(AUTHORIZATION, value);
        }
    }
    merged
}

fn append_stderr_tail(tail: &Arc<Mutex<Vec<String>>>, line: String) {
    if line.is_empty() {
        return;
    }
    if let Ok(mut buf) = tail.lock() {
        buf.push(line);
        if buf.len() > STDERR_TAIL_MAX_LINES {
            let drain = buf.len() - STDERR_TAIL_MAX_LINES;
            buf.drain(0..drain);
        }
    }
}

fn rpc_error(method: &str, err: &Value, context: &str) -> McpTransportError {
    let rpc_err: JsonRpcError = serde_json::from_value(err.clone()).unwrap_or(JsonRpcError {
        code: -1,
        message: err.to_string(),
        data: None,
    });
    McpTransportError::Rpc {
        code: rpc_err.code,
        message: format!(
            "MCP call failed: method={method}{context} code={} message={}",
            rpc_err.code, rpc_err.message
        ),
        data: rpc_err.data,
    }
}

fn parse_jsonrpc_result(method: &str, id: u64, msg: &Value) -> Result<Value, McpTransportError> {
    let msg_id = msg.get("id");
    if msg_id != Some(&json!(id)) {
        return Err(McpTransportError::msg(format!(
            "MCP response id mismatch: method={method} id={id} msg={msg}"
        )));
    }

    if let Some(err) = msg.get("error") {
        return Err(rpc_error(method, err, ""));
    }

    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
}

/// HTTP 非 2xx：body 若是 JSON-RPC error 则保留 code/data（modern server 用
/// 400 + UnsupportedProtocolVersion 等表达协议错误，代际探测要靠它区分），
/// 否则带上截断的 body 便于诊断。
fn http_status_error(method: &str, status: StatusCode, body: &str) -> McpTransportError {
    if let Some(err) = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").cloned())
    {
        return rpc_error(method, &err, &format!(" status={status}"));
    }
    let body = body.trim();
    let snippet: String = body.chars().take(300).collect();
    let ellipsis = if body.chars().count() > 300 {
        "…"
    } else {
        ""
    };
    if snippet.is_empty() {
        McpTransportError::msg(format!(
            "MCP HTTP request failed: method={method} status={status}"
        ))
    } else {
        McpTransportError::msg(format!(
            "MCP HTTP request failed: method={method} status={status} body={snippet}{ellipsis}"
        ))
    }
}

fn send_error(kind: &str, method: &str, e: reqwest::Error) -> McpTransportError {
    let text = format!("MCP {kind} request failed: method={method} err={e}");
    if e.is_timeout() {
        McpTransportError::Timeout(text)
    } else {
        McpTransportError::Message(text)
    }
}

fn read_sse_for_matching_id<R: BufRead>(
    reader: &mut R,
    method: &str,
    id: u64,
) -> Result<Value, String> {
    let mut line = String::new();
    let mut data_lines: Vec<String> = Vec::new();

    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read the SSE stream: {e}"))?;
        if n == 0 {
            return Err(format!(
                "The SSE stream closed before a response was received: method={method} id={id}"
            ));
        }

        let l = line.trim_end_matches(['\r', '\n']);
        if l.is_empty() {
            // dispatch
            if data_lines.is_empty() {
                continue;
            }

            let data = data_lines.join("\n");
            data_lines.clear();

            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                if v.get("id") == Some(&json!(id)) {
                    return Ok(v);
                }
            }

            continue;
        }

        if l.starts_with(':') {
            continue;
        }
        if let Some(_rest) = l.strip_prefix("event:") {
            continue;
        }
        if let Some(rest) = l.strip_prefix("data:") {
            data_lines.push(rest.trim_start().to_string());
            continue;
        }
        if let Some(_rest) = l.strip_prefix("id:") {
            // Ignore SSE event id.
            continue;
        }
    }
}

#[derive(Debug)]
struct StdioTransport {
    child: Child,
    stdin: ChildStdin,
    stdout_rx: mpsc::Receiver<String>,
    stderr_tail: Arc<Mutex<Vec<String>>>,
}

impl StdioTransport {
    fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        let cmd = config.command.trim();
        if cmd.is_empty() {
            return Err("MCP server command 不能为空（transport=stdio）".to_string());
        }

        let cwd = config
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(expand_tilde_path);

        let mut command = build_stdio_command(cmd, &config.args, cwd.as_deref());
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        maybe_augment_macos_path(&mut command);
        configure_child_process_group(&mut command);
        // 应用代理 env 先注入（含 NO_PROXY 环回豁免），server 配置的 env 后写保持更高优先级；
        // 代理配置异常时 fail fast，不静默直连。
        for (key, value) in crate::services::system_proxy::shell_proxy_envs()? {
            command.env(key, value);
        }
        if let Some(env) = &config.env {
            command.envs(env);
        }
        if let Some(cwd) = &cwd {
            command.current_dir(cwd);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("启动 MCP server 失败：{e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法获取 MCP server stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法获取 MCP server stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法获取 MCP server stderr".to_string())?;

        let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        {
            let tail = stderr_tail.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) => {
                            let l = line.trim_end().to_string();
                            append_stderr_tail(&tail, l);
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if tx.send(trimmed.to_string()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            stdout_rx: rx,
            stderr_tail,
        })
    }

    fn stderr_summary(&self) -> String {
        if let Ok(buf) = self.stderr_tail.lock() {
            if buf.is_empty() {
                return "".to_string();
            }
            let joined = buf.join("\n");
            return format!("\n\n--- MCP server stderr (tail) ---\n{joined}");
        }
        "".to_string()
    }

    fn ensure_running(&mut self) -> Result<(), String> {
        if let Some(status) = self.child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "MCP server exited unexpectedly: status={status}{}",
                self.stderr_summary()
            ));
        }
        Ok(())
    }

    fn send_line(&mut self, line: &str) -> Result<(), String> {
        self.ensure_running()?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| {
                format!(
                    "Failed to write to MCP server stdin: {e}{}",
                    self.stderr_summary()
                )
            })
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let req = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        self.send_line(&req.to_string())
    }

    fn request(
        &mut self,
        timeout: Duration,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, McpTransportError> {
        self.ensure_running().map_err(McpTransportError::Message)?;

        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        self.send_line(&req.to_string())
            .map_err(McpTransportError::Message)?;

        // Read until we see the matching response id. Ignore notifications/other ids.
        let deadline = Instant::now()
            .checked_add(timeout)
            .unwrap_or_else(Instant::now);
        loop {
            let now = Instant::now();
            let remaining = deadline.saturating_duration_since(now);
            if remaining.is_zero() {
                return Err(McpTransportError::Timeout(format!(
                    "MCP request timed out: method={method} id={id}{}",
                    self.stderr_summary()
                )));
            }

            let line = match self.stdout_rx.recv_timeout(remaining) {
                Ok(line) => line,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(McpTransportError::Timeout(format!(
                        "MCP request timed out: method={method} id={id}{}",
                        self.stderr_summary()
                    )))
                }
                Err(e) => {
                    return Err(McpTransportError::Message(format!(
                        "Failed to read MCP server stdout: {e}{}",
                        self.stderr_summary()
                    )))
                }
            };

            let msg: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue, // Non-JSON output on stdout (should not happen, but ignore).
            };

            if msg.get("id") == Some(&json!(id)) {
                return parse_jsonrpc_result(method, id, &msg)
                    .map_err(|e| e.with_suffix(&self.stderr_summary()));
            }
        }
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        kill_child_process_tree_best_effort(&mut self.child);
    }
}

#[derive(Debug)]
struct HttpTransport {
    endpoint: Url,
    client: HttpClient,
    headers: HeaderMap,
    session_id: Option<String>,
    protocol_version: Option<String>,
}

impl HttpTransport {
    fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        let url = config
            .url_trimmed()
            .ok_or_else(|| "MCP http transport 需要 url".to_string())?;
        let endpoint = Url::parse(url).map_err(|e| format!("MCP url 无效：{url} ({e})"))?;

        let headers = build_header_map(&config.headers)?;

        // 经 system_proxy 构建：应用代理启用时走代理（环回地址豁免），异常配置 fail fast。
        let client = crate::services::system_proxy::blocking_client_builder()
            .map_err(|e| format!("创建 HTTP client 失败：{e}"))?
            .connect_timeout(Duration::from_secs(10))
            .timeout(config.timeout())
            .build()
            .map_err(|e| format!("创建 HTTP client 失败：{e}"))?;

        Ok(Self {
            endpoint,
            client,
            headers,
            session_id: None,
            protocol_version: None,
        })
    }

    fn reset_session(&mut self) {
        self.session_id = None;
        self.protocol_version = None;
    }

    fn apply_common_headers(
        &self,
        mut builder: reqwest::blocking::RequestBuilder,
        bearer: Option<&str>,
    ) -> reqwest::blocking::RequestBuilder {
        let merged = headers_with_bearer(&self.headers, bearer);
        if !merged.is_empty() {
            builder = builder.headers(merged);
        }
        builder.header(ACCEPT, "application/json, text/event-stream")
    }

    fn notify(&mut self, bearer: Option<&str>, method: &str, params: Value) -> Result<(), String> {
        let req = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });

        let mut builder = self.client.post(self.endpoint.clone());
        builder = self.apply_common_headers(builder, bearer);

        if let Some(v) = &self.protocol_version {
            builder = builder.header("MCP-Protocol-Version", v);
        }
        if let Some(sid) = &self.session_id {
            builder = builder.header("MCP-Session-Id", sid);
        }

        let resp = builder
            .header(CONTENT_TYPE, "application/json")
            .body(req.to_string())
            .send()
            .map_err(|e| format!("MCP HTTP notify failed: method={method} err={e}"))?;

        if !resp.status().is_success() {
            return Err(format!(
                "MCP HTTP notify failed: method={method} status={}",
                resp.status()
            ));
        }

        Ok(())
    }

    fn request(
        &mut self,
        oauth: bool,
        bearer: Option<&str>,
        id: u64,
        method: &str,
        params: Value,
        opts: RequestOpts<'_>,
    ) -> Result<Value, McpTransportError> {
        // modern 请求（params._meta 带协议版本）无会话：版本与方法名镜像到请求头。
        let modern_version = mcp_protocol::modern_version_of(&params).map(str::to_string);
        let standard_headers = if modern_version.is_some() {
            mcp_protocol::standard_request_headers(method, &params)
        } else {
            Vec::new()
        };

        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        let mut builder = self.client.post(self.endpoint.clone());
        builder = self.apply_common_headers(builder, bearer);

        if let Some(v) = &modern_version {
            builder = builder.header("MCP-Protocol-Version", v);
            for (name, value) in standard_headers.iter().chain(opts.extra_headers) {
                builder = builder.header(name.as_str(), value.as_str());
            }
        } else {
            // Negotiated protocol version.
            if let Some(v) = &self.protocol_version {
                builder = builder.header("MCP-Protocol-Version", v);
            } else if method == "initialize" {
                if let Some(v) = req
                    .get("params")
                    .and_then(|p| p.get("protocolVersion"))
                    .and_then(|v| v.as_str())
                {
                    builder = builder.header("MCP-Protocol-Version", v);
                }
            }

            // Only attach session id for non-initialize requests.
            if method != "initialize" {
                if let Some(sid) = &self.session_id {
                    builder = builder.header("MCP-Session-Id", sid);
                }
            }
        }

        if let Some(timeout) = opts.timeout {
            builder = builder.timeout(timeout);
        }

        let resp = builder
            .header(CONTENT_TYPE, "application/json")
            .body(req.to_string())
            .send()
            .map_err(|e| send_error("HTTP", method, e))?;

        // oauth 启用时 401 走专属通道：被动刷新一次后重试（上层处理）。
        if oauth && resp.status() == StatusCode::UNAUTHORIZED {
            return Err(McpTransportError::Unauthorized);
        }

        if resp.status() == StatusCode::NOT_FOUND
            && self.session_id.is_some()
            && modern_version.is_none()
            && method != "initialize"
        {
            return Err(McpTransportError::SessionExpired404);
        }

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(http_status_error(method, status, &body));
        }

        let session_header = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let ct = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();

        let msg: Value = if ct.starts_with("text/event-stream") {
            let mut reader = BufReader::new(resp);
            read_sse_for_matching_id(&mut reader, method, id).map_err(McpTransportError::msg)?
        } else {
            let body = resp.text().map_err(|e| {
                McpTransportError::msg(format!("Failed to read the MCP HTTP response: {e}"))
            })?;
            serde_json::from_str(&body).map_err(|e| {
                McpTransportError::msg(format!(
                    "Failed to parse MCP HTTP JSON: method={method} err={e} body={body}"
                ))
            })?
        };

        let result = parse_jsonrpc_result(method, id, &msg)?;

        if method == "initialize" {
            if let Some(sid) = session_header {
                self.session_id = Some(sid);
            }

            if let Some(pv) = result.get("protocolVersion").and_then(|v| v.as_str()) {
                self.protocol_version = Some(pv.to_string());
            } else if let Some(pv) = req
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str())
            {
                self.protocol_version = Some(pv.to_string());
            }
        }

        Ok(result)
    }
}

#[derive(Debug)]
struct SseTransport {
    sse_url: Url,
    message_url_override: Option<Url>,
    post_url: Arc<Mutex<Option<Url>>>,
    client_post: HttpClient,
    headers: HeaderMap,
    rx: mpsc::Receiver<Value>,
    stop: Arc<AtomicBool>,
    _thread: Option<std::thread::JoinHandle<()>>,
}

impl SseTransport {
    fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        let url = config
            .url_trimmed()
            .ok_or_else(|| "MCP sse transport 需要 url（SSE endpoint）".to_string())?;
        let sse_url = Url::parse(url).map_err(|e| format!("MCP url 无效：{url} ({e})"))?;

        let headers = build_header_map(&config.headers)?;

        let message_url_override = match config.message_url_trimmed() {
            None => None,
            Some(raw) => {
                // Support relative urls.
                Url::parse(raw)
                    .or_else(|_| sse_url.join(raw))
                    .map(Some)
                    .map_err(|e| format!("messageUrl 无效：{raw} ({e})"))?
            }
        };

        // 两个 client 均经 system_proxy 构建（GET 长连接不设总超时），语义同 HttpTransport。
        let client_get = crate::services::system_proxy::blocking_client_builder()
            .map_err(|e| format!("创建 SSE http client 失败：{e}"))?
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| format!("创建 SSE http client 失败：{e}"))?;

        let client_post = crate::services::system_proxy::blocking_client_builder()
            .map_err(|e| format!("创建 POST http client 失败：{e}"))?
            .connect_timeout(Duration::from_secs(10))
            .timeout(config.timeout())
            .build()
            .map_err(|e| format!("创建 POST http client 失败：{e}"))?;

        let post_url: Arc<Mutex<Option<Url>>> = Arc::new(Mutex::new(message_url_override.clone()));

        let (tx, rx) = mpsc::channel::<Value>();
        let stop = Arc::new(AtomicBool::new(false));

        let thread_sse_url = sse_url.clone();
        let thread_post_url = post_url.clone();
        let thread_headers = headers.clone();
        let thread_stop = stop.clone();
        let thread_client = client_get.clone();
        // oauth：GET 长连在每次（重）连时取当下 Bearer——token 刷新后重连即生效，
        // 不把 spawn 时刻的 token 固化进线程。
        let thread_oauth = config.oauth_enabled();
        let thread_server_id = config.id.trim().to_string();
        let thread_server_url = url.to_string();

        // 失败重连用退避：固定 1s 会在上游不可达时以每秒一次的频率反复建连
        //（DNS + TCP + TLS 握手），而"配置了 SSE server 却连不上"时这个循环是
        // 常驻的。连上一次即复位，避免把瞬时抖动放大成持续退避。
        const SSE_RECONNECT_MIN: Duration = Duration::from_secs(1);
        const SSE_RECONNECT_MAX: Duration = Duration::from_secs(30);
        let handle = std::thread::spawn(move || {
            let mut backoff = SSE_RECONNECT_MIN;
            loop {
            if thread_stop.load(Ordering::Relaxed) {
                break;
            }

            let mut builder = thread_client.get(thread_sse_url.clone());
            let bearer = if thread_oauth {
                crate::services::mcp_oauth::ensure_bearer(&thread_server_id, &thread_server_url)
            } else {
                None
            };
            let merged = headers_with_bearer(&thread_headers, bearer.as_deref());
            if !merged.is_empty() {
                builder = builder.headers(merged);
            }
            builder = builder.header(ACCEPT, "text/event-stream");

            let resp = match builder.send() {
                Ok(r) => {
                    // 建连成功即复位退避：下一次失败重新从最小间隔起，避免把
                    // 瞬时抖动累积成持续 30s 才重连一次。
                    backoff = SSE_RECONNECT_MIN;
                    r
                }
                Err(_) => {
                    std::thread::sleep(backoff);
                    backoff = (backoff * 2).min(SSE_RECONNECT_MAX);
                    continue;
                }
            };

            if !resp.status().is_success() {
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(SSE_RECONNECT_MAX);
                continue;
            }

            let mut reader = BufReader::new(resp);
            let mut line = String::new();
            let mut event_name: Option<String> = None;
            let mut data_lines: Vec<String> = Vec::new();

            loop {
                if thread_stop.load(Ordering::Relaxed) {
                    return;
                }

                line.clear();
                let n = match reader.read_line(&mut line) {
                    Ok(n) => n,
                    Err(_) => break,
                };
                if n == 0 {
                    break;
                }

                let l = line.trim_end_matches(['\r', '\n']);
                if l.is_empty() {
                    if data_lines.is_empty() {
                        event_name = None;
                        continue;
                    }

                    let data = data_lines.join("\n");
                    data_lines.clear();

                    let ty = event_name.take().unwrap_or_else(|| "message".to_string());

                    if ty == "endpoint" {
                        let raw = data.trim();
                        if raw.is_empty() {
                            continue;
                        }
                        if let Ok(u) = Url::parse(raw).or_else(|_| thread_sse_url.join(raw)) {
                            if let Ok(mut locked) = thread_post_url.lock() {
                                *locked = Some(u);
                            }
                        }
                        continue;
                    }

                    if let Ok(v) = serde_json::from_str::<Value>(&data) {
                        let _ = tx.send(v);
                    }

                    continue;
                }

                if l.starts_with(':') {
                    continue;
                }
                if let Some(rest) = l.strip_prefix("event:") {
                    event_name = Some(rest.trim().to_string());
                    continue;
                }
                if let Some(rest) = l.strip_prefix("data:") {
                    data_lines.push(rest.trim_start().to_string());
                    continue;
                }
            }
            }
        });

        Ok(Self {
            sse_url,
            message_url_override,
            post_url,
            client_post,
            headers,
            rx,
            stop,
            _thread: Some(handle),
        })
    }

    fn wait_or_guess_post_url(&self, timeout: Duration) -> Result<Url, String> {
        if let Some(u) = &self.message_url_override {
            return Ok(u.clone());
        }

        // Wait for endpoint event a little while (if the stream is slow to emit).
        let wait_ms = timeout.as_millis() as u64;
        let wait_ms = wait_ms.clamp(1, LEGACY_SSE_ENDPOINT_WAIT_MS);
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(wait_ms))
            .unwrap_or_else(Instant::now);

        loop {
            if let Ok(locked) = self.post_url.lock() {
                if let Some(u) = &*locked {
                    return Ok(u.clone());
                }
            }

            if Instant::now() >= deadline {
                break;
            }

            std::thread::sleep(Duration::from_millis(50));
        }

        // Fallback: /sse -> /message
        let path = self.sse_url.path();
        if let Some(prefix) = path.strip_suffix("/sse") {
            let mut u = self.sse_url.clone();
            u.set_path(&format!("{prefix}/message"));
            return Ok(u);
        }

        Err(
            "No endpoint event was received, and the message endpoint could not be inferred. Please provide Message URL."
                .to_string(),
        )
    }

    fn notify(
        &mut self,
        timeout: Duration,
        bearer: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<(), String> {
        let post_url = self.wait_or_guess_post_url(timeout)?;

        let req = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });

        let mut builder = self.client_post.post(post_url);
        let merged = headers_with_bearer(&self.headers, bearer);
        if !merged.is_empty() {
            builder = builder.headers(merged);
        }
        let resp = builder
            .header(CONTENT_TYPE, "application/json")
            .body(req.to_string())
            .send()
            .map_err(|e| format!("MCP SSE notify failed: method={method} err={e}"))?;

        if !resp.status().is_success() {
            return Err(format!(
                "MCP SSE notify failed: method={method} status={}",
                resp.status()
            ));
        }

        Ok(())
    }

    fn request(
        &mut self,
        timeout: Duration,
        oauth: bool,
        bearer: Option<&str>,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, McpTransportError> {
        let post_url = self
            .wait_or_guess_post_url(timeout)
            .map_err(McpTransportError::msg)?;

        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        let mut builder = self.client_post.post(post_url);
        let merged = headers_with_bearer(&self.headers, bearer);
        if !merged.is_empty() {
            builder = builder.headers(merged);
        }
        let resp = builder
            .header(CONTENT_TYPE, "application/json")
            .body(req.to_string())
            .send()
            .map_err(|e| {
                McpTransportError::msg(format!("MCP SSE request failed: method={method} err={e}"))
            })?;

        if oauth && resp.status() == StatusCode::UNAUTHORIZED {
            return Err(McpTransportError::Unauthorized);
        }

        if !resp.status().is_success() {
            return Err(McpTransportError::msg(format!(
                "MCP SSE request failed: method={method} status={}",
                resp.status()
            )));
        }

        let deadline = Instant::now()
            .checked_add(timeout)
            .unwrap_or_else(Instant::now);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(McpTransportError::msg(format!(
                    "MCP SSE request timed out: method={method} id={id}"
                )));
            }

            let msg = self.rx.recv_timeout(remaining).map_err(|e| {
                McpTransportError::msg(format!(
                    "Failed to wait for the SSE response or the wait timed out: {e}"
                ))
            })?;

            if msg.get("id") == Some(&json!(id)) {
                return parse_jsonrpc_result(method, id, &msg);
            }
        }
    }
}

impl Drop for SseTransport {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[derive(Debug)]
enum McpTransport {
    Stdio(StdioTransport),
    Http(HttpTransport),
    Sse(SseTransport),
}

impl McpTransport {
    fn ensure_running(&mut self) -> Result<(), String> {
        match self {
            McpTransport::Stdio(t) => t.ensure_running(),
            McpTransport::Http(_) | McpTransport::Sse(_) => Ok(()),
        }
    }

    fn stderr_tail(&self) -> Option<String> {
        match self {
            McpTransport::Stdio(t) => {
                let text = t.stderr_summary();
                if text.trim().is_empty() {
                    None
                } else {
                    Some(text)
                }
            }
            McpTransport::Http(_) | McpTransport::Sse(_) => None,
        }
    }

    fn reset_session(&mut self) {
        if let McpTransport::Http(h) = self {
            h.reset_session();
        }
    }

    /// oauth 启用时取当前 Bearer（进程内缓存 + 将过期主动刷新）；未授权返回
    /// None，请求裸发，401 由上层转成「需授权」标记错误。
    fn bearer_for(cfg: &McpServerConfig) -> Option<String> {
        if !cfg.oauth_enabled() {
            return None;
        }
        let url = cfg.url_trimmed()?;
        crate::services::mcp_oauth::ensure_bearer(cfg.id.trim(), url)
    }

    fn notify(
        &mut self,
        cfg: &McpServerConfig,
        method: &str,
        params: Value,
    ) -> Result<(), McpTransportError> {
        let timeout = cfg.timeout();
        let bearer = Self::bearer_for(cfg);
        match self {
            McpTransport::Stdio(t) => t.notify(method, params).map_err(McpTransportError::msg),
            McpTransport::Http(t) => t
                .notify(bearer.as_deref(), method, params)
                .map_err(McpTransportError::msg),
            McpTransport::Sse(t) => t
                .notify(timeout, bearer.as_deref(), method, params)
                .map_err(McpTransportError::msg),
        }
    }

    fn request(
        &mut self,
        cfg: &McpServerConfig,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, McpTransportError> {
        self.request_with(cfg, id, method, params, RequestOpts::default())
    }

    fn request_with(
        &mut self,
        cfg: &McpServerConfig,
        id: u64,
        method: &str,
        params: Value,
        opts: RequestOpts<'_>,
    ) -> Result<Value, McpTransportError> {
        let timeout = opts.timeout.unwrap_or_else(|| cfg.timeout());
        let oauth = cfg.oauth_enabled();
        let bearer = Self::bearer_for(cfg);
        match self {
            McpTransport::Stdio(t) => t.request(timeout, id, method, params),
            McpTransport::Http(t) => t.request(oauth, bearer.as_deref(), id, method, params, opts),
            McpTransport::Sse(t) => {
                t.request(timeout, oauth, bearer.as_deref(), id, method, params)
            }
        }
    }

    /// 2026-07-28 的 modern 协议只定义了 stdio 与 Streamable HTTP 绑定；
    /// 已废弃的 HTTP+SSE 只能走 legacy。
    fn supports_modern(&self) -> bool {
        !matches!(self, McpTransport::Sse(_))
    }
}

/// 协议代际判定结果。按规范是 server 的属性：stdio 按进程、HTTP 按 origin 缓存。
#[derive(Debug, Clone, PartialEq, Eq)]
enum ProtocolEra {
    /// 无握手，每个请求在 `_meta` 携带该版本。
    Modern(String),
    /// initialize 握手协商出的版本。
    Legacy(String),
}

impl ProtocolEra {
    fn version(&self) -> &str {
        match self {
            ProtocolEra::Modern(v) | ProtocolEra::Legacy(v) => v,
        }
    }
}

/// stdio 探测 `server/discover` 的超时：legacy server 对握手前的未知请求可能
/// 静默不回，不能等满整个请求超时。慢启动的 modern server 由「legacy 握手
/// 失败后用完整超时再探测一次」兜底。
const MODERN_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// 跨 client 重建（配置变更、手动重启）复用的代际判定，避免每次重连都为
/// 静默的 legacy server 白等探测超时。假设失效时会重新探测。
static PROTOCOL_ERA_CACHE: std::sync::LazyLock<Mutex<HashMap<String, ProtocolEra>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn era_cache_key(cfg: &McpServerConfig) -> String {
    match cfg.transport() {
        "http" | "sse" => format!(
            "{}\u{1f}{}",
            cfg.transport(),
            cfg.url_trimmed().unwrap_or("")
        ),
        _ => format!(
            "stdio\u{1f}{}\u{1f}{}\u{1f}{}",
            cfg.command.trim(),
            cfg.args.join("\u{1e}"),
            cfg.cwd.as_deref().unwrap_or("").trim()
        ),
    }
}

enum ProbeOutcome {
    Modern(String),
    /// 对端不是 modern server（或只支持 legacy 版本）：走 initialize。
    Legacy {
        timed_out: bool,
    },
    /// modern server，但无法兼容 / 需授权：直接报错，不回退。
    Fatal(String),
}

#[derive(Debug)]
struct McpClient {
    config: McpServerConfig,
    /// spawn 时的应用代理配置 revision。transport 的 reqwest client 与
    /// stdio 子进程 env 都在 spawn 时固化，ensure_client 据此在代理配置
    /// 变更后重建连接。
    proxy_revision: u64,
    transport: McpTransport,
    next_id: u64,
    /// 已可发业务请求：legacy 完成 initialize 握手，或 modern 选定了版本。
    initialized: bool,
    era: Option<ProtocolEra>,
    /// modern Streamable HTTP：工具名 → `x-mcp-header` 标注（来自 tools/list）。
    tool_param_headers: HashMap<String, Vec<ParamHeader>>,
}

/// 组成带稳定标记的「需授权」错误：前端/诊断按标记引导用户去 MCP Hub Connect。
fn oauth_required_error(cfg: &McpServerConfig, reason: &str) -> String {
    format!(
        "MCP server `{}` 需要 OAuth 授权（{}）。请在 MCP Hub 中对该 server 执行 Connect 完成授权。原因：{reason}",
        cfg.id.trim(),
        crate::services::mcp_oauth::AUTH_REQUIRED_MARKER
    )
}

fn no_compatible_version_error(supported: &[String], detail: Option<&str>) -> String {
    let mut text = format!(
        "MCP server supports no protocol version LiveAgent can speak: server={supported:?} client={:?}",
        mcp_protocol::MODERN_PROTOCOL_VERSIONS
            .iter()
            .chain(mcp_protocol::LEGACY_PROTOCOL_VERSIONS)
            .collect::<Vec<_>>()
    );
    if let Some(detail) = detail {
        text.push_str(&format!(" ({detail})"));
    }
    text
}

impl McpClient {
    fn spawn(config: McpServerConfig) -> Result<Self, String> {
        // 在建 transport 之前取 revision：若 spawn 期间代理配置变更，
        // 记录的旧值会在下次 ensure_client 触发重建，宁可多建一次。
        let proxy_revision = crate::services::system_proxy::revision();
        let transport = match config.transport().trim() {
            "http" => McpTransport::Http(HttpTransport::spawn(&config)?),
            "sse" => McpTransport::Sse(SseTransport::spawn(&config)?),
            _ => McpTransport::Stdio(StdioTransport::spawn(&config)?),
        };

        Ok(Self {
            config,
            proxy_revision,
            transport,
            next_id: 1,
            initialized: false,
            era: None,
            tool_param_headers: HashMap::new(),
        })
    }

    fn is_modern(&self) -> bool {
        matches!(self.era, Some(ProtocolEra::Modern(_)))
    }

    fn protocol_version(&self) -> Option<String> {
        self.era.as_ref().map(|era| era.version().to_string())
    }

    fn cached_era(&self) -> Option<ProtocolEra> {
        PROTOCOL_ERA_CACHE
            .lock()
            .ok()?
            .get(&era_cache_key(&self.config))
            .cloned()
    }

    fn set_era(&mut self, era: ProtocolEra) {
        if let Ok(mut cache) = PROTOCOL_ERA_CACHE.lock() {
            cache.insert(era_cache_key(&self.config), era.clone());
        }
        self.era = Some(era);
        self.initialized = true;
    }

    fn forget_era(&mut self) {
        if let Ok(mut cache) = PROTOCOL_ERA_CACHE.lock() {
            cache.remove(&era_cache_key(&self.config));
        }
        self.era = None;
        self.initialized = false;
    }

    fn next_rpc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        id
    }

    /// 401 被动刷新（每次调用点只允许一次）。成功后 transport 下个请求会经
    /// `bearer_for` 拿到新 token；失败返回「需授权」标记错误。
    fn recover_unauthorized(&mut self) -> Result<(), String> {
        let url = self
            .config
            .url_trimmed()
            .ok_or_else(|| oauth_required_error(&self.config, "server 未配置 URL"))?;
        crate::services::mcp_oauth::refresh_after_unauthorized(self.config.id.trim(), url)
            .map(|_| ())
            .map_err(|reason| oauth_required_error(&self.config, &reason))
    }

    /// 协议代际协商（规范 2026-07-28 basic/versioning「Backward Compatibility」）：
    /// 先以 modern 版本发 `server/discover` 探测——成功或返回已识别的 modern
    /// 错误即判 modern；其他错误或超时判 legacy，回退 initialize 握手。
    fn ensure_initialized(&mut self) -> Result<(), String> {
        if self.initialized {
            return Ok(());
        }
        if !self.transport.supports_modern() {
            return self.legacy_initialize();
        }

        // 之前判为 legacy：直接握手；失败说明假设可能失效（如 server 升级），重新探测。
        if matches!(self.cached_era(), Some(ProtocolEra::Legacy(_))) {
            let legacy_err = match self.legacy_initialize() {
                Ok(()) => return Ok(()),
                Err(e) => e,
            };
            self.forget_era();
            return self.finish_probe(self.config.timeout(), legacy_err);
        }

        let probe_timeout = MODERN_PROBE_TIMEOUT.min(self.config.timeout());
        match self.probe_modern(probe_timeout) {
            ProbeOutcome::Modern(v) => {
                self.set_era(ProtocolEra::Modern(v));
                Ok(())
            }
            ProbeOutcome::Fatal(e) => Err(e),
            ProbeOutcome::Legacy { timed_out } => {
                self.respawn_if_exited()?;
                let legacy = match self.legacy_initialize() {
                    // 进程可能在处理探测请求时才退出：重启后（新进程不会再收到探测）再握手一次。
                    Err(_) if self.respawn_if_exited()? => self.legacy_initialize(),
                    other => other,
                };
                match legacy {
                    Ok(()) => Ok(()),
                    // 探测超时也可能只是 server 启动慢：握手同样失败时用完整超时再探测一次。
                    Err(legacy_err) if timed_out => {
                        self.finish_probe(self.config.timeout(), legacy_err)
                    }
                    Err(e) => Err(e),
                }
            }
        }
    }

    /// legacy 握手失败后的最后一次 modern 探测；仍判 legacy 则报握手错误。
    fn finish_probe(&mut self, timeout: Duration, legacy_err: String) -> Result<(), String> {
        match self.probe_modern(timeout) {
            ProbeOutcome::Modern(v) => {
                self.set_era(ProtocolEra::Modern(v));
                Ok(())
            }
            ProbeOutcome::Fatal(e) => Err(e),
            ProbeOutcome::Legacy { .. } => Err(legacy_err),
        }
    }

    /// 有的 legacy server 收到握手前的未知请求会直接退出：重启进程再握手。
    /// 返回是否发生了重启。
    fn respawn_if_exited(&mut self) -> Result<bool, String> {
        if matches!(self.transport, McpTransport::Stdio(_))
            && self.transport.ensure_running().is_err()
        {
            self.transport = McpTransport::Stdio(StdioTransport::spawn(&self.config)?);
            return Ok(true);
        }
        Ok(false)
    }

    fn probe_modern(&mut self, timeout: Duration) -> ProbeOutcome {
        let mut version = mcp_protocol::MODERN_PROTOCOL_VERSIONS[0].to_string();
        let mut tried: Vec<String> = Vec::new();
        let mut auth_retry_used = false;

        loop {
            tried.push(version.clone());
            let params = mcp_protocol::with_modern_meta(json!({}), &version, crate::app_version());
            let id = self.next_rpc_id();
            let opts = RequestOpts {
                timeout: Some(timeout),
                ..Default::default()
            };
            match self
                .transport
                .request_with(&self.config, id, "server/discover", params, opts)
            {
                Ok(result) => {
                    let supported = mcp_protocol::discover_supported_versions(&result);
                    if supported.is_empty() {
                        return ProbeOutcome::Modern(version);
                    }
                    return match mcp_protocol::choose_version(&supported) {
                        VersionChoice::Modern(v) => ProbeOutcome::Modern(v),
                        VersionChoice::Legacy => ProbeOutcome::Legacy { timed_out: false },
                        VersionChoice::None => {
                            ProbeOutcome::Fatal(no_compatible_version_error(&supported, None))
                        }
                    };
                }
                Err(McpTransportError::Rpc {
                    code,
                    data,
                    message,
                    ..
                }) if code == mcp_protocol::ERR_UNSUPPORTED_PROTOCOL_VERSION => {
                    let supported = mcp_protocol::error_supported_versions(data.as_ref());
                    match mcp_protocol::choose_version(&supported) {
                        VersionChoice::Modern(v) if !tried.contains(&v) => version = v,
                        VersionChoice::Legacy => return ProbeOutcome::Legacy { timed_out: false },
                        _ => {
                            return ProbeOutcome::Fatal(no_compatible_version_error(
                                &supported,
                                Some(&message),
                            ))
                        }
                    }
                }
                Err(McpTransportError::Rpc { code, message, .. })
                    if mcp_protocol::is_modern_error_code(code) =>
                {
                    return ProbeOutcome::Fatal(message)
                }
                Err(McpTransportError::Unauthorized) => {
                    if auth_retry_used {
                        return ProbeOutcome::Fatal(oauth_required_error(
                            &self.config,
                            "刷新后仍返回 401",
                        ));
                    }
                    auth_retry_used = true;
                    if let Err(e) = self.recover_unauthorized() {
                        return ProbeOutcome::Fatal(e);
                    }
                }
                Err(McpTransportError::Timeout(_)) => {
                    return ProbeOutcome::Legacy { timed_out: true }
                }
                Err(_) => return ProbeOutcome::Legacy { timed_out: false },
            }
        }
    }

    fn legacy_initialize(&mut self) -> Result<(), String> {
        let mut last_err: Option<String> = None;
        // 整个 initialize 尝试序列共享一次被动刷新额度：401 与协议版本无关，
        // 刷新后重试当前版本；再 401 或刷新失败直接判「需授权」，不再空转其余版本。
        let mut auth_retry_used = false;

        for v in mcp_protocol::LEGACY_PROTOCOL_VERSIONS {
            let init_params = json!({
                "protocolVersion": v,
                "clientInfo": { "name": "LiveAgent", "version": crate::app_version() },
                "capabilities": {}
            });

            loop {
                let id = self.next_rpc_id();
                match self
                    .transport
                    .request(&self.config, id, "initialize", init_params.clone())
                {
                    Ok(result) => {
                        // Some servers require this notification before accepting further requests.
                        let _ = self.transport.notify(
                            &self.config,
                            "notifications/initialized",
                            json!({}),
                        );
                        let negotiated = result
                            .get("protocolVersion")
                            .and_then(|v| v.as_str())
                            .unwrap_or(v)
                            .to_string();
                        self.set_era(ProtocolEra::Legacy(negotiated));
                        return Ok(());
                    }
                    Err(McpTransportError::Unauthorized) => {
                        if auth_retry_used {
                            return Err(oauth_required_error(&self.config, "刷新后仍返回 401"));
                        }
                        auth_retry_used = true;
                        self.recover_unauthorized()?;
                        continue;
                    }
                    Err(McpTransportError::SessionExpired404) => {
                        last_err = Some("Session expired during initialize (404)".to_string());
                        break;
                    }
                    Err(other) => {
                        last_err = Some(other.into_message());
                        break;
                    }
                }
            }
        }

        Err(last_err.unwrap_or_else(|| "initialize failed".to_string()))
    }

    /// 按当前代际发送一次：modern 注入 `_meta`（HTTP 另由 transport 镜像请求头）。
    fn send(
        &mut self,
        method: &str,
        params: &Value,
        extra_headers: &[(String, String)],
    ) -> Result<Value, McpTransportError> {
        let params = match &self.era {
            Some(ProtocolEra::Modern(v)) => {
                mcp_protocol::with_modern_meta(params.clone(), v, crate::app_version())
            }
            _ => params.clone(),
        };
        let id = self.next_rpc_id();
        let opts = RequestOpts {
            timeout: None,
            extra_headers,
        };
        self.transport
            .request_with(&self.config, id, method, params, opts)
    }

    fn request_with_retry(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_retry_raw(method, params, &[])
            .map_err(McpTransportError::into_message)
    }

    /// 同 `request_with_retry`，但保留错误分类（tools/call 要识别 HeaderMismatch）。
    fn request_with_retry_raw(
        &mut self,
        method: &str,
        params: Value,
        extra_headers: &[(String, String)],
    ) -> Result<Value, McpTransportError> {
        let result = match self.send(method, &params, extra_headers) {
            Ok(v) => v,
            Err(McpTransportError::SessionExpired404) => {
                // Streamable HTTP: session expired, clear session and re-initialize once, then retry.
                self.transport.reset_session();
                self.initialized = false;
                self.ensure_initialized()
                    .map_err(McpTransportError::Message)?;

                match self.send(method, &params, extra_headers) {
                    Ok(v) => v,
                    Err(McpTransportError::Unauthorized) => {
                        return Err(McpTransportError::Message(oauth_required_error(
                            &self.config,
                            "会话重建后返回 401",
                        )))
                    }
                    Err(McpTransportError::SessionExpired404) => {
                        return Err(McpTransportError::msg(
                            "MCP session still returned 404 after retry (the server may be unhealthy)",
                        ))
                    }
                    Err(other) => return Err(other),
                }
            }
            Err(McpTransportError::Unauthorized) => {
                // token 过期/被撤销：被动刷新一次后重试原请求。
                self.recover_unauthorized()
                    .map_err(McpTransportError::Message)?;

                match self.send(method, &params, extra_headers) {
                    Ok(v) => v,
                    Err(McpTransportError::Unauthorized) => {
                        return Err(McpTransportError::Message(oauth_required_error(
                            &self.config,
                            "刷新后仍返回 401",
                        )))
                    }
                    Err(McpTransportError::SessionExpired404) => {
                        return Err(McpTransportError::msg(
                            "MCP session returned 404 right after refresh (the server may be unhealthy)",
                        ))
                    }
                    Err(other) => return Err(other),
                }
            }
            Err(McpTransportError::Rpc { code, .. })
                if code == mcp_protocol::ERR_UNSUPPORTED_PROTOCOL_VERSION && self.is_modern() =>
            {
                // server 支持的版本集变了（如升级/降级）：重新协商一次后重试。
                self.forget_era();
                self.ensure_initialized()
                    .map_err(McpTransportError::Message)?;
                self.send(method, &params, extra_headers)?
            }
            Err(other) => return Err(other),
        };
        mcp_protocol::ensure_complete_result(method, &result)
            .map_err(McpTransportError::Message)?;
        Ok(result)
    }

    fn tools_list(&mut self) -> Result<Vec<McpToolInfo>, String> {
        self.ensure_initialized()?;
        let result = self.request_with_retry("tools/list", json!({}))?;
        let tools = result
            .get("tools")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        // modern Streamable HTTP 要把 `x-mcp-header` 标注的参数镜像到请求头；
        // 标注违反约束的工具定义按规范必须拒收。
        let mirror_param_headers =
            self.is_modern() && matches!(self.transport, McpTransport::Http(_));
        self.tool_param_headers.clear();

        let mut out: Vec<McpToolInfo> = Vec::new();
        for t in tools {
            let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
            if name.is_empty() {
                continue;
            }
            let description = t
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let input_schema = t
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object" }));

            if mirror_param_headers {
                match mcp_protocol::param_headers_from_schema(&input_schema) {
                    Ok(headers) if headers.is_empty() => {}
                    Ok(headers) => {
                        self.tool_param_headers.insert(name.to_string(), headers);
                    }
                    Err(reason) => {
                        eprintln!(
                            "[mcp] skip tool `{name}` of server `{}`: invalid x-mcp-header ({reason})",
                            self.config.id
                        );
                        continue;
                    }
                }
            }

            out.push(McpToolInfo {
                server_id: self.config.id.clone(),
                server_label: self.config.id.clone(),
                name: name.to_string(),
                description,
                input_schema,
            });
        }

        Ok(out)
    }

    fn runtime_status(&mut self) -> McpRuntimeStatus {
        let last_error = self.transport.ensure_running().err();
        McpRuntimeStatus {
            server_id: self.config.id.clone(),
            running: last_error.is_none(),
            initialized: self.initialized,
            transport: self.config.transport().to_string(),
            last_error,
        }
    }

    fn stderr_tail(&self) -> Option<String> {
        self.transport.stderr_tail()
    }

    fn tools_call(
        &mut self,
        tool_name: &str,
        arguments: Value,
    ) -> Result<McpCallToolResponse, String> {
        self.ensure_initialized()?;
        let param_header_values = |client: &Self| match client.tool_param_headers.get(tool_name) {
            Some(headers) if client.is_modern() => {
                mcp_protocol::param_header_values(headers, &arguments)
            }
            _ => Vec::new(),
        };
        let params = json!({
            "name": tool_name,
            "arguments": arguments
        });
        let headers = param_header_values(self);
        let result = match self.request_with_retry_raw("tools/call", params.clone(), &headers) {
            Ok(result) => result,
            Err(McpTransportError::Rpc { code, .. })
                if code == mcp_protocol::ERR_HEADER_MISMATCH && self.is_modern() =>
            {
                // 工具 inputSchema 的 x-mcp-header 标注可能变了（或尚未 tools/list）：
                // 刷新后带上新的 Mcp-Param-* 头重试一次。
                self.tools_list()?;
                let headers = param_header_values(self);
                self.request_with_retry_raw("tools/call", params, &headers)
                    .map_err(McpTransportError::into_message)?
            }
            Err(e) => return Err(e.into_message()),
        };

        let is_error = result
            .get("isError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mut content_out: Vec<McpContent> = Vec::new();
        if let Some(items) = result.get("content").and_then(|v| v.as_array()) {
            for item in items {
                let ty = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match ty {
                    "text" => {
                        let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        if !text.is_empty() {
                            content_out.push(McpContent::Text {
                                text: text.to_string(),
                            });
                        }
                    }
                    "image" => {
                        let data = item.get("data").and_then(|v| v.as_str()).unwrap_or("");
                        let mime_type = item
                            .get("mimeType")
                            .and_then(|v| v.as_str())
                            .unwrap_or("application/octet-stream");
                        if !data.is_empty() {
                            content_out.push(McpContent::Image {
                                data: data.to_string(),
                                mime_type: mime_type.to_string(),
                            });
                        }
                    }
                    _ => {
                        // Unknown content type: keep a JSON preview as text to avoid losing info.
                        content_out.push(McpContent::Text {
                            text: item.to_string(),
                        });
                    }
                }
            }
        }

        if content_out.is_empty() {
            content_out.push(McpContent::Text {
                text: result.to_string(),
            });
        }

        Ok(McpCallToolResponse {
            content: content_out,
            is_error,
            details: result,
        })
    }
}

fn to_diagnostic_tools(
    tools: Vec<McpToolInfo>,
    include_schema: bool,
) -> Vec<McpDiagnosticToolInfo> {
    tools
        .into_iter()
        .map(|tool| McpDiagnosticToolInfo {
            server_id: tool.server_id,
            server_label: tool.server_label,
            name: tool.name,
            description: tool.description,
            input_schema: include_schema.then_some(tool.input_schema),
        })
        .collect()
}

fn validate_runtime_config(cfg: &McpServerConfig) -> Result<(), String> {
    let id = cfg.id.trim();
    if id.is_empty() {
        return Err("MCP server name cannot be empty".to_string());
    }

    match cfg.transport() {
        "http" | "sse" => {
            let u = cfg.url_trimmed().unwrap_or("");
            if u.is_empty() {
                return Err(format!(
                    "MCP server({id}) transport={} requires url",
                    cfg.transport()
                ));
            }
        }
        _ => {
            if cfg.command.trim().is_empty() {
                return Err(format!("MCP server({id}) transport=stdio requires command"));
            }
        }
    }

    Ok(())
}

fn classify_start_failure(error: &str) -> &'static str {
    if error.contains("启动 MCP server")
        || error.contains("Failed to start")
        || error.contains("No such file")
        || error.contains("os error 2")
    {
        "spawn"
    } else {
        "config"
    }
}

fn run_client_test(
    id: String,
    transport: String,
    start: Instant,
    client: &mut McpClient,
    include_schema: bool,
) -> McpRuntimeTestResponse {
    let oauth = oauth_diag(&client.config);
    let mut phase = "tools_list".to_string();
    let tools = match client.tools_list() {
        Ok(tools) => tools,
        Err(error) => {
            let initialized = client.initialized;
            let running = client.transport.ensure_running().is_ok();
            let stderr_tail = client.stderr_tail();
            if !initialized {
                phase = "initialize".to_string();
            }
            // 401 →「需授权」标记错误发生后再取一次状态，让 expired 等新鲜可见。
            let oauth = oauth_diag(&client.config);
            return McpRuntimeTestResponse {
                server_id: id,
                ok: false,
                phase,
                transport,
                duration_ms: start.elapsed().as_millis(),
                running,
                initialized,
                tools_count: 0,
                tools: Vec::new(),
                error: Some(error),
                stderr_tail,
                protocol_version: client.protocol_version(),
                oauth,
            };
        }
    };
    let tools_count = tools.len();
    let initialized = client.initialized;
    let running = client.transport.ensure_running().is_ok();
    let stderr_tail = client.stderr_tail();
    McpRuntimeTestResponse {
        server_id: id,
        ok: true,
        phase: "tools_list".to_string(),
        transport,
        duration_ms: start.elapsed().as_millis(),
        running,
        initialized,
        tools_count,
        tools: to_diagnostic_tools(tools, include_schema),
        error: None,
        stderr_tail,
        protocol_version: client.protocol_version(),
        oauth,
    }
}

impl McpRuntimeManager {
    // Lock discipline: the clients-map lock is only ever held for a get/insert
    // and is never held while locking an individual client or spawning one.
    // Holding the map lock across a busy client (long tools/call) or a slow
    // spawn would stall every other server's commands behind it. Two threads
    // racing with an identical config can briefly double-spawn; the loser's
    // client is dropped (and its transport killed) when the Arc goes away,
    // which is the correct trade-off versus global head-of-line blocking.
    fn ensure_client(&self, cfg: McpServerConfig) -> Result<Arc<Mutex<McpClient>>, String> {
        let id = cfg.id.trim().to_string();
        validate_runtime_config(&cfg)?;

        let existing = self
            .clients
            .lock()
            .map_err(|_| "MCP 状态锁失败".to_string())?
            .get(&id)
            .cloned();
        if let Some(existing) = existing.as_ref() {
            // Restart if config changed. Same-id calls serialize on the client
            // lock (protocol streams cannot be shared), other servers do not.
            // 应用代理配置变更（revision 变化）同样视作配置变化重建连接。
            let proxy_revision = crate::services::system_proxy::revision();
            let same_config = existing
                .lock()
                .map(|client| client.config == cfg && client.proxy_revision == proxy_revision)
                .unwrap_or(false);
            if same_config {
                return Ok(existing.clone());
            }
        }

        let client = match McpClient::spawn(cfg) {
            Ok(client) => client,
            Err(error) => {
                // 重建失败必须逐出已判定过期的旧 client：mcp_call_tool 直读 map
                // 不经本函数，留着旧 client 会让失效配置（如无效应用代理）下的
                // 调用继续走旧通道，违背 fail fast 不静默直连的语义。
                // 仅在 map 里仍是同一个 Arc 时移除，避免误杀并发换上的新 client。
                if let Some(stale) = existing {
                    if let Ok(mut map) = self.clients.lock() {
                        if map
                            .get(&id)
                            .is_some_and(|current| Arc::ptr_eq(current, &stale))
                        {
                            map.remove(&id);
                        }
                    }
                }
                return Err(error);
            }
        };
        let arc = Arc::new(Mutex::new(client));
        self.clients
            .lock()
            .map_err(|_| "MCP 状态锁失败".to_string())?
            .insert(id, arc.clone());
        Ok(arc)
    }

    fn stop_client(&self, server_id: &str) -> Result<bool, String> {
        let id = server_id.trim();
        if id.is_empty() {
            return Err("server_id cannot be empty".to_string());
        }
        let mut map = self
            .clients
            .lock()
            .map_err(|_| "MCP state lock failed".to_string())?;
        Ok(map.remove(id).is_some())
    }

    fn runtime_status(&self, server_id: &str) -> Result<McpRuntimeStatus, String> {
        let id = server_id.trim().to_string();
        if id.is_empty() {
            return Err("server_id cannot be empty".to_string());
        }
        let map = self
            .clients
            .lock()
            .map_err(|_| "MCP state lock failed".to_string())?;
        let Some(client) = map.get(&id).cloned() else {
            return Ok(McpRuntimeStatus {
                server_id: id,
                running: false,
                initialized: false,
                transport: "unknown".to_string(),
                last_error: None,
            });
        };
        drop(map);
        let mut locked = client
            .lock()
            .map_err(|_| "MCP client lock failed".to_string())?;
        Ok(locked.runtime_status())
    }

    fn test_client(
        &self,
        cfg: McpServerConfig,
        include_schema: bool,
        restart: bool,
        persist: bool,
    ) -> Result<McpRuntimeTestResponse, String> {
        let id = cfg.id.trim().to_string();
        if id.is_empty() {
            return Err("MCP server name cannot be empty".to_string());
        }
        let transport = cfg.transport().to_string();
        let start = Instant::now();

        if restart && persist {
            let _ = self.stop_client(&id);
        }

        if !persist {
            if let Err(error) = validate_runtime_config(&cfg) {
                return Ok(McpRuntimeTestResponse {
                    server_id: id,
                    ok: false,
                    phase: "config".to_string(),
                    transport,
                    duration_ms: start.elapsed().as_millis(),
                    running: false,
                    initialized: false,
                    tools_count: 0,
                    tools: Vec::new(),
                    error: Some(error),
                    stderr_tail: None,
                    protocol_version: None,
                    oauth: oauth_diag(&cfg),
                });
            }
            let mut client = match McpClient::spawn(cfg) {
                Ok(client) => client,
                Err(error) => {
                    let phase = classify_start_failure(&error);
                    return Ok(McpRuntimeTestResponse {
                        server_id: id,
                        ok: false,
                        phase: phase.to_string(),
                        transport,
                        duration_ms: start.elapsed().as_millis(),
                        running: false,
                        initialized: false,
                        tools_count: 0,
                        tools: Vec::new(),
                        error: Some(error),
                        stderr_tail: None,
                        protocol_version: None,
                        oauth: None,
                    });
                }
            };
            return Ok(run_client_test(
                id,
                transport,
                start,
                &mut client,
                include_schema,
            ));
        }

        let client = match self.ensure_client(cfg) {
            Ok(client) => client,
            Err(error) => {
                let phase = classify_start_failure(&error);
                return Ok(McpRuntimeTestResponse {
                    server_id: id,
                    ok: false,
                    phase: phase.to_string(),
                    transport,
                    duration_ms: start.elapsed().as_millis(),
                    running: false,
                    initialized: false,
                    tools_count: 0,
                    tools: Vec::new(),
                    error: Some(error),
                    stderr_tail: None,
                    protocol_version: None,
                    oauth: None,
                });
            }
        };

        let mut locked = client
            .lock()
            .map_err(|_| "MCP client lock failed".to_string())?;
        Ok(run_client_test(
            id,
            transport,
            start,
            &mut locked,
            include_schema,
        ))
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_list_tools(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    servers: Vec<McpServerConfig>,
) -> Result<Vec<McpToolInfo>, String> {
    // IMPORTANT: tool listing can block (process spawn / network / pipes). Offload.
    let manager = state.inner().clone();
    run_blocking("mcp_list_tools", move || {
        let mut out: Vec<McpToolInfo> = Vec::new();

        let mut succeeded = 0usize;
        let mut failures: Vec<String> = Vec::new();
        for cfg in servers.into_iter().filter(|s| s.enabled) {
            let server_id = cfg.id.clone();
            let tools = match manager.ensure_client(cfg.clone()) {
                Ok(client) => {
                    let mut locked = client.lock().map_err(|_| "MCP client 锁失败".to_string())?;
                    locked.tools_list()
                }
                Err(err) => Err(err),
            };

            match tools {
                Ok(tools) => {
                    succeeded += 1;
                    out.extend(tools);
                }
                Err(err) => {
                    eprintln!(
                        "[MCP] 跳过 server `{}` 的 tools/list，继续对话流程：{}",
                        server_id, err
                    );
                    failures.push(format!("{server_id}: {err}"));
                }
            }
        }

        // 部分失败沿用跳过语义；全军覆没（如应用代理配置异常一次性击毁全部
        // server）必须让前端可见（onLoadError/throw），否则工具静默消失无从排查。
        if succeeded == 0 && !failures.is_empty() {
            return Err(format!(
                "所有已启用的 MCP server 都不可用：\n{}",
                failures.join("\n")
            ));
        }

        Ok(out)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_call_tool(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    run_registry: tauri::State<'_, Arc<ShellRunRegistry>>,
    server_id: String,
    tool_name: String,
    arguments: Value,
    run_id: Option<String>,
) -> Result<McpCallToolResponse, String> {
    // IMPORTANT: tool call can block (network / pipes / SSE). Offload.
    let manager = state.inner().clone();
    let normalized_run_id = run_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let cancel_token = normalized_run_id
        .as_deref()
        .map(|id| run_registry.register(id));
    let registered_token = cancel_token.clone();
    let mut task = tauri::async_runtime::spawn_blocking(move || {
        let id = server_id.trim().to_string();
        if id.is_empty() {
            return Err("server_id cannot be empty".to_string());
        }

        let map = manager
            .clients
            .lock()
            .map_err(|_| "Failed to lock MCP state".to_string())?;
        let client = map.get(&id).cloned().ok_or_else(|| {
            format!(
                "Unknown MCP server: {id} (it may have been reconfigured or stopped; \
                 the tool list refreshes on the next conversation turn)"
            )
        })?;
        drop(map);

        let mut locked = client
            .lock()
            .map_err(|_| "Failed to lock MCP client".to_string())?;
        locked.tools_call(tool_name.trim(), arguments)
    });
    let result = if let Some(cancel_token) = cancel_token {
        tokio::select! {
            join = &mut task => {
                join.map_err(|error| format!("mcp_call_tool join failed: {error}"))?
            }
            _ = cancel_token.cancelled() => Err("Cancelled".to_string()),
        }
    } else {
        task.await
            .map_err(|error| format!("mcp_call_tool join failed: {error}"))?
    };
    if let (Some(run_id), Some(token)) = (normalized_run_id.as_deref(), registered_token.as_ref()) {
        run_registry.unregister(run_id, token);
    }
    result
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_runtime_status(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    server_id: String,
) -> Result<McpRuntimeStatus, String> {
    let manager = state.inner().clone();
    run_blocking("mcp_runtime_status", move || {
        manager.runtime_status(&server_id)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_stop_server(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    server_id: String,
) -> Result<McpStopServerResponse, String> {
    let manager = state.inner().clone();
    run_blocking("mcp_stop_server", move || {
        let id = server_id.trim().to_string();
        let stopped = manager.stop_client(&id)?;
        Ok(McpStopServerResponse {
            server_id: id,
            stopped,
        })
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_test_server(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    server: McpServerConfig,
    include_schema: Option<bool>,
    persist: Option<bool>,
) -> Result<McpRuntimeTestResponse, String> {
    let manager = state.inner().clone();
    run_blocking("mcp_test_server", move || {
        manager.test_client(
            server,
            include_schema.unwrap_or(false),
            false,
            persist.unwrap_or(true),
        )
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_restart_server(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    server: McpServerConfig,
    include_schema: Option<bool>,
    persist: Option<bool>,
) -> Result<McpRuntimeTestResponse, String> {
    let manager = state.inner().clone();
    run_blocking("mcp_restart_server", move || {
        manager.test_client(
            server,
            include_schema.unwrap_or(false),
            true,
            persist.unwrap_or(true),
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_content_image_serializes_camel_case() {
        // TS 侧（pi-ai 的 data URL 拼接、UI 预览）读的是 `mimeType`。字段一旦
        // 以 snake_case 出去，前端拿到 undefined，拼出 `data:undefined;base64,…`
        // ——图片进不了模型上下文，还会让下一轮 provider 请求整个失败。
        let image = McpContent::Image {
            data: "aW1n".to_string(),
            mime_type: "image/png".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&image).expect("serialize image block"),
            serde_json::json!({ "type": "image", "data": "aW1n", "mimeType": "image/png" }),
        );

        let text = McpContent::Text {
            text: "hi".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&text).expect("serialize text block"),
            serde_json::json!({ "type": "text", "text": "hi" }),
        );
    }

    fn stdio_config(id: &str, command: &str) -> McpServerConfig {
        McpServerConfig {
            id: id.to_string(),
            enabled: true,
            transport: Some("stdio".to_string()),
            command: command.to_string(),
            args: Vec::new(),
            env: None,
            cwd: None,
            url: None,
            headers: None,
            timeout_ms: Some(1_000),
            message_url: None,
            auth: None,
        }
    }

    fn url_config(id: &str, transport: &str, url: Option<&str>) -> McpServerConfig {
        McpServerConfig {
            id: id.to_string(),
            enabled: true,
            transport: Some(transport.to_string()),
            command: String::new(),
            args: Vec::new(),
            env: None,
            cwd: None,
            url: url.map(|value| value.to_string()),
            headers: None,
            timeout_ms: Some(1_000),
            message_url: None,
            auth: None,
        }
    }

    #[test]
    fn bearer_overrides_static_authorization_header() {
        let mut static_headers = HeaderMap::new();
        static_headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer stale"));
        static_headers.insert("x-extra", HeaderValue::from_static("keep"));

        let merged = headers_with_bearer(&static_headers, Some("fresh"));
        let values: Vec<_> = merged.get_all(AUTHORIZATION).iter().collect();
        assert_eq!(
            values.len(),
            1,
            "OAuth Bearer 必须覆盖静态 Authorization，不能追加"
        );
        assert_eq!(values[0], "Bearer fresh");
        assert_eq!(
            merged.get("x-extra").unwrap(),
            "keep",
            "其余静态 header 保留"
        );

        // 无 bearer 时原样透传（含静态 Authorization 的现状行为）。
        let untouched = headers_with_bearer(&static_headers, None);
        assert_eq!(untouched.get(AUTHORIZATION).unwrap(), "Bearer stale");
    }

    #[test]
    fn oauth_enabled_requires_remote_transport_and_oauth_type() {
        let mut cfg = url_config("srv", "http", Some("https://mcp.example.com/mcp"));
        assert!(!cfg.oauth_enabled(), "无 auth 配置 = 现状");

        cfg.auth = Some(McpAuthConfig {
            auth_type: "none".to_string(),
            scope: None,
            client_id: None,
        });
        assert!(!cfg.oauth_enabled(), "type=none = 现状");

        cfg.auth = Some(McpAuthConfig {
            auth_type: "oauth".to_string(),
            scope: Some(" mcp.read ".to_string()),
            client_id: Some("".to_string()),
        });
        assert!(cfg.oauth_enabled());
        let server = cfg.oauth_server().expect("oauth server");
        assert_eq!(server.id, "srv");
        assert_eq!(server.scope_override.as_deref(), Some("mcp.read"));
        assert_eq!(server.static_client_id, None, "空串 client_id 视作未配置");

        // stdio 上配 oauth 无意义，必须不生效。
        let mut stdio = stdio_config("local", "server-bin");
        stdio.auth = Some(McpAuthConfig {
            auth_type: "oauth".to_string(),
            scope: None,
            client_id: None,
        });
        assert!(!stdio.oauth_enabled());
    }

    #[test]
    fn server_config_deserializes_with_and_without_auth() {
        let legacy: McpServerConfig = serde_json::from_value(json!({
            "id": "srv",
            "enabled": true,
            "transport": "http",
            "command": "",
            "args": [],
            "url": "https://mcp.example.com/mcp"
        }))
        .expect("legacy config");
        assert_eq!(legacy.auth, None);

        let with_auth: McpServerConfig = serde_json::from_value(json!({
            "id": "srv",
            "enabled": true,
            "transport": "http",
            "command": "",
            "args": [],
            "url": "https://mcp.example.com/mcp",
            "auth": { "type": "oauth", "scope": "a b", "clientId": "cid" }
        }))
        .expect("auth config");
        let auth = with_auth.auth.expect("auth present");
        assert_eq!(auth.auth_type, "oauth");
        assert_eq!(auth.scope.as_deref(), Some("a b"));
        assert_eq!(auth.client_id.as_deref(), Some("cid"));
    }

    #[test]
    fn runtime_status_reports_missing_server_without_starting() {
        let manager = McpRuntimeManager::default();
        let status = manager
            .runtime_status("missing")
            .expect("runtime status should succeed");
        assert_eq!(status.server_id, "missing");
        assert!(!status.running);
        assert!(!status.initialized);
    }

    #[test]
    fn stop_client_reports_whether_server_was_running() {
        let manager = McpRuntimeManager::default();
        assert!(!manager.stop_client("missing").expect("stop missing"));
    }

    #[test]
    fn test_client_rejects_invalid_stdio_config_as_config_phase() {
        let manager = McpRuntimeManager::default();
        let result = manager
            .test_client(stdio_config("bad", ""), false, false, true)
            .expect("test client response");
        assert!(!result.ok);
        assert_eq!(result.phase, "config");
        assert_eq!(result.tools_count, 0);
        assert!(result.error.unwrap().contains("command"));
    }

    #[test]
    fn test_client_rejects_missing_http_and_sse_url_as_config_phase() {
        let manager = McpRuntimeManager::default();
        for transport in ["http", "sse"] {
            let result = manager
                .test_client(url_config(transport, transport, None), false, false, true)
                .expect("test client response");
            assert!(!result.ok);
            assert_eq!(result.phase, "config");
            assert_eq!(result.tools_count, 0);
            assert!(result.error.unwrap().contains("url"));
        }
    }

    #[test]
    fn stderr_tail_is_truncated_to_recent_lines() {
        let tail = Arc::new(Mutex::new(Vec::new()));
        for index in 0..(STDERR_TAIL_MAX_LINES + 5) {
            append_stderr_tail(&tail, format!("line-{index}"));
        }
        let locked = tail.lock().expect("tail lock");
        assert_eq!(locked.len(), STDERR_TAIL_MAX_LINES);
        assert_eq!(locked.first().map(String::as_str), Some("line-5"));
        assert_eq!(
            locked.last(),
            Some(&format!("line-{}", STDERR_TAIL_MAX_LINES + 4))
        );
    }

    // http transport spawn only parses the URL and builds a client, so real
    // pool entries can be constructed offline.
    fn offline_http_config(id: &str) -> McpServerConfig {
        url_config(id, "http", Some("http://127.0.0.1:9/mcp"))
    }

    #[test]
    fn ensure_client_reuses_same_config_and_replaces_changed_config() {
        let manager = McpRuntimeManager::default();
        let first = manager
            .ensure_client(offline_http_config("srv"))
            .expect("first ensure");
        let second = manager
            .ensure_client(offline_http_config("srv"))
            .expect("second ensure");
        assert!(Arc::ptr_eq(&first, &second));

        let changed = manager
            .ensure_client(url_config("srv", "http", Some("http://127.0.0.1:9/mcp2")))
            .expect("changed ensure");
        assert!(!Arc::ptr_eq(&first, &changed));
    }

    #[test]
    fn ensure_client_evicts_stale_client_when_respawn_fails() {
        let manager = McpRuntimeManager::default();
        manager
            .ensure_client(offline_http_config("srv"))
            .expect("initial ensure");

        // 换成必然 spawn 失败的配置（URL 通过存在性校验但解析失败）：
        // 旧 client 必须被逐出，否则 mcp_call_tool 直读 map 会继续走失效通道。
        manager
            .ensure_client(url_config("srv", "http", Some("::not-a-url::")))
            .expect_err("respawn must fail");
        assert!(
            !manager
                .clients
                .lock()
                .expect("clients lock")
                .contains_key("srv"),
            "stale client must be evicted after failed respawn"
        );
    }

    #[test]
    fn busy_client_does_not_block_other_servers() {
        use std::sync::Barrier;
        use std::time::Duration;

        let manager = Arc::new(McpRuntimeManager::default());
        let client_a = manager
            .ensure_client(offline_http_config("server-a"))
            .expect("seed server-a");

        let barrier = Arc::new(Barrier::new(3));
        // Holder simulates a long-running tools/call on server A.
        let holder = {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let _guard = client_a.lock().expect("hold server-a");
                barrier.wait();
                std::thread::sleep(Duration::from_millis(800));
            })
        };
        // Contender blocks on server A's client lock inside ensure_client. The
        // old implementation did this while holding the pool map lock, which
        // stalled every other server's commands behind it.
        let contender = {
            let manager = manager.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                manager.ensure_client(offline_http_config("server-a"))
            })
        };

        barrier.wait();
        std::thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        manager
            .ensure_client(offline_http_config("server-b"))
            .expect("ensure server-b");
        let status = manager.runtime_status("server-b").expect("status server-b");
        assert_eq!(status.server_id, "server-b");
        assert!(manager.stop_client("server-b").expect("stop server-b"));
        assert!(
            started.elapsed() < Duration::from_millis(400),
            "server-b commands stalled behind server-a's busy client"
        );

        contender
            .join()
            .expect("join contender")
            .expect("contender ensure eventually succeeds");
        holder.join().expect("join holder");
    }

    #[test]
    fn detects_windows_batch_programs_by_extension() {
        assert!(is_windows_batch_program(Path::new(
            r"C:\Program Files\nodejs\npx.cmd"
        )));
        assert!(is_windows_batch_program(Path::new(r"C:\tools\run.BAT")));
        assert!(!is_windows_batch_program(Path::new(
            r"C:\Program Files\nodejs\node.exe"
        )));
        assert!(!is_windows_batch_program(Path::new("npx")));
    }

    #[test]
    fn windows_cmd_quote_arg_doubles_embedded_quotes() {
        // cmd.exe 不认 `\"` 转义，翻倍才能保持引号配对。
        assert_eq!(windows_cmd_quote_arg("-y"), r#""-y""#);
        assert_eq!(windows_cmd_quote_arg(r#"a"b"#), r#""a""b""#);
        assert_eq!(windows_cmd_quote_arg("with space"), r#""with space""#);
    }

    #[test]
    fn windows_cmd_quote_arg_doubles_backslashes_before_quotes() {
        // 内嵌引号前的反斜杠须补齐至 2n，重解析后还原为 n 个反斜杠 + 字面引号。
        assert_eq!(windows_cmd_quote_arg(r#"a\"b"#), r#""a\\""b""#);
        // 尾部反斜杠若不翻倍会把闭合引号转义掉，与后一个参数粘连。
        assert_eq!(windows_cmd_quote_arg(r"C:\data\"), r#""C:\data\\""#);
        // 非贴引号的反斜杠保持原样（路径分隔符不受影响）。
        assert_eq!(windows_cmd_quote_arg(r"C:\a\b"), r#""C:\a\b""#);
        assert_eq!(windows_cmd_quote_arg(""), r#""""#);
    }

    #[test]
    fn windows_cmd_quote_arg_neutralizes_percent_expansion() {
        // `%%cd:~,` no-op 打断 %VAR% 配对，cmd 展开后子进程仍收到原文。
        assert_eq!(windows_cmd_quote_arg("%PATH%"), r#""%%cd:~,%PATH%%cd:~,%""#);
        assert_eq!(windows_cmd_quote_arg("100%"), r#""100%%cd:~,%""#);
        assert_eq!(windows_cmd_quote_arg("a\rb"), "\"a%%cd:~,\rb\"");
    }

    #[test]
    fn windows_cmd_c_argument_wraps_whole_line_for_slash_s() {
        // `/S` 语义：cmd 剥掉首尾引号后必须还原出可执行的完整命令行。
        let program = Path::new(r"C:\Program Files\nodejs\npx.cmd");
        let args = vec!["-y".to_string(), "@playwright/mcp".to_string()];
        assert_eq!(
            windows_cmd_c_argument(program, &args),
            r#"""C:\Program Files\nodejs\npx.cmd" "-y" "@playwright/mcp"""#
        );
    }

    #[test]
    fn windows_cmd_c_argument_without_args_still_quotes_program() {
        let program = Path::new(r"C:\tools\npx.cmd");
        assert_eq!(
            windows_cmd_c_argument(program, &[]),
            r#"""C:\tools\npx.cmd"""#
        );
    }

    #[test]
    fn windows_cmd_c_argument_survives_trailing_backslash_arg() {
        // filesystem 类 MCP server 常见传法：目录参数带尾部反斜杠。
        let program = Path::new(r"C:\Program Files\nodejs\npx.cmd");
        let args = vec![
            "-y".to_string(),
            "@modelcontextprotocol/server-filesystem".to_string(),
            r"C:\Users\me\docs\".to_string(),
        ];
        assert_eq!(
            windows_cmd_c_argument(program, &args),
            r#"""C:\Program Files\nodejs\npx.cmd" "-y" "@modelcontextprotocol/server-filesystem" "C:\Users\me\docs\\"""#
        );
    }

    // ---- 协议代际兼容（modern 2026-07-28 / legacy initialize）----

    #[derive(Debug, Clone)]
    struct MockRequest {
        headers: HashMap<String, String>,
        body: Value,
    }

    impl MockRequest {
        fn method(&self) -> &str {
            self.body
                .get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("")
        }
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .get(&name.to_ascii_lowercase())
                .map(String::as_str)
        }
    }

    struct MockResponse {
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: String,
    }

    fn ok_result(req: &MockRequest, result: Value) -> MockResponse {
        MockResponse {
            status: 200,
            headers: Vec::new(),
            body: json!({ "jsonrpc": "2.0", "id": req.body["id"], "result": result }).to_string(),
        }
    }

    fn error_response(req: &MockRequest, status: u16, code: i64, data: Value) -> MockResponse {
        MockResponse {
            status,
            headers: Vec::new(),
            body: json!({
                "jsonrpc": "2.0",
                "id": req.body["id"],
                "error": { "code": code, "message": "mock error", "data": data }
            })
            .to_string(),
        }
    }

    fn accepted() -> MockResponse {
        MockResponse {
            status: 202,
            headers: Vec::new(),
            body: String::new(),
        }
    }

    /// 极简 HTTP/1.1 mock：每个连接处理一个请求（Connection: close），记录所有请求。
    fn spawn_mock_http<F>(handler: F) -> (String, Arc<Mutex<Vec<MockRequest>>>)
    where
        F: Fn(&MockRequest) -> MockResponse + Send + 'static,
    {
        use std::io::Read;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let log: Arc<Mutex<Vec<MockRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let log_thread = log.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut headers = HashMap::new();
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    let l = line.trim_end();
                    if l.is_empty() {
                        break;
                    }
                    if let Some((k, v)) = l.split_once(':') {
                        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
                    }
                }
                let len: usize = headers
                    .get("content-length")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let mut body = vec![0u8; len];
                reader.read_exact(&mut body).unwrap();
                let req = MockRequest {
                    headers,
                    body: serde_json::from_slice(&body).unwrap_or(Value::Null),
                };
                log_thread.lock().unwrap().push(req.clone());
                let resp = handler(&req);
                let mut out = format!(
                    "HTTP/1.1 {} Mock\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                    resp.status,
                    resp.body.len()
                );
                for (k, v) in &resp.headers {
                    out.push_str(&format!("{k}: {v}\r\n"));
                }
                out.push_str("\r\n");
                out.push_str(&resp.body);
                let _ = stream.write_all(out.as_bytes());
                let _ = stream.flush();
            }
        });
        (url, log)
    }

    fn methods(log: &Arc<Mutex<Vec<MockRequest>>>) -> Vec<String> {
        log.lock()
            .unwrap()
            .iter()
            .map(|r| r.method().to_string())
            .collect()
    }

    #[test]
    fn modern_http_server_is_used_without_initialize() {
        let (url, log) = spawn_mock_http(|req| {
            // 纯 modern server：缺 _meta 一律 400（issue #822 的报错形态）。
            let Some(version) = req.body["params"]["_meta"]
                ["io.modelcontextprotocol/protocolVersion"]
                .as_str()
                .map(str::to_string)
            else {
                return MockResponse {
                    status: 400,
                    headers: Vec::new(),
                    body: "params._meta is required".to_string(),
                };
            };
            if req.header("mcp-protocol-version") != Some(version.as_str())
                || req.header("mcp-method") != Some(req.method())
            {
                return error_response(req, 400, -32020, Value::Null);
            }
            match req.method() {
                "server/discover" => ok_result(
                    req,
                    json!({ "resultType": "complete", "supportedVersions": ["2026-07-28"], "capabilities": { "tools": {} } }),
                ),
                "tools/list" => ok_result(
                    req,
                    json!({
                        "resultType": "complete",
                        "tools": [{
                            "name": "get_weather",
                            "inputSchema": {
                                "type": "object",
                                "properties": { "region": { "type": "string", "x-mcp-header": "Region" } }
                            }
                        }],
                        "ttlMs": 0,
                        "cacheScope": "private"
                    }),
                ),
                "tools/call" => {
                    if req.header("mcp-name") != Some("get_weather")
                        || req.header("mcp-param-region") != Some("us-west1")
                    {
                        return error_response(req, 400, -32020, Value::Null);
                    }
                    ok_result(
                        req,
                        json!({ "resultType": "complete", "content": [{ "type": "text", "text": "sunny" }] }),
                    )
                }
                _ => error_response(req, 404, -32601, Value::Null),
            }
        });

        let mut client = McpClient::spawn(url_config("modern-http", "http", Some(&url))).unwrap();
        assert_eq!(client.tools_list().unwrap().len(), 1);
        assert_eq!(client.protocol_version().as_deref(), Some("2026-07-28"));

        let resp = client
            .tools_call("get_weather", json!({ "region": "us-west1" }))
            .unwrap();
        assert!(!resp.is_error);
        assert!(matches!(&resp.content[0], McpContent::Text { text } if text == "sunny"));

        assert_eq!(
            methods(&log),
            vec!["server/discover", "tools/list", "tools/call"]
        );
        assert!(log
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.header("mcp-session-id").is_none()));
    }

    #[test]
    fn modern_tools_call_refreshes_param_headers_on_header_mismatch() {
        let (url, log) = spawn_mock_http(|req| match req.method() {
            "server/discover" => ok_result(
                req,
                json!({ "resultType": "complete", "supportedVersions": ["2026-07-28"], "capabilities": {} }),
            ),
            "tools/list" => ok_result(
                req,
                json!({ "resultType": "complete", "tools": [{
                    "name": "q",
                    "inputSchema": { "type": "object", "properties": { "db": { "type": "string", "x-mcp-header": "Db" } } }
                }] }),
            ),
            "tools/call" if req.header("mcp-param-db") == Some("main") => {
                ok_result(req, json!({ "resultType": "complete", "content": [] }))
            }
            _ => error_response(req, 400, -32020, Value::Null),
        });

        // 未先 tools/list：首个 tools/call 缺 Mcp-Param-Db → HeaderMismatch → 刷新后重试。
        let mut client = McpClient::spawn(url_config("mismatch-http", "http", Some(&url))).unwrap();
        client.tools_call("q", json!({ "db": "main" })).unwrap();
        assert_eq!(
            methods(&log),
            vec!["server/discover", "tools/call", "tools/list", "tools/call"]
        );
    }

    #[test]
    fn legacy_http_server_falls_back_to_initialize() {
        let (url, log) = spawn_mock_http(|req| {
            match req.method() {
            "initialize" => {
                let mut resp = ok_result(
                    req,
                    json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": { "name": "legacy", "version": "1" } }),
                );
                resp.headers.push(("Mcp-Session-Id", "sess-1".to_string()));
                resp
            }
            "notifications/initialized" => accepted(),
            _ if req.header("mcp-session-id") != Some("sess-1") => MockResponse {
                // 典型 legacy SDK：无会话的非 initialize 请求回 400 + 非 modern 错误码。
                status: 400,
                headers: Vec::new(),
                body: json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32000, "message": "Bad Request: Server not initialized" } }).to_string(),
            },
            "tools/list" => ok_result(
                req,
                json!({ "tools": [{ "name": "echo", "inputSchema": { "type": "object" } }] }),
            ),
            _ => error_response(req, 200, -32601, Value::Null),
        }
        });

        let mut client = McpClient::spawn(url_config("legacy-http", "http", Some(&url))).unwrap();
        assert_eq!(client.tools_list().unwrap().len(), 1);
        assert_eq!(client.protocol_version().as_deref(), Some("2025-06-18"));
        assert_eq!(
            methods(&log),
            vec![
                "server/discover",
                "initialize",
                "notifications/initialized",
                "tools/list"
            ]
        );
        // legacy 请求不带 modern _meta
        let list_req = log.lock().unwrap()[3].clone();
        assert!(list_req.body["params"].get("_meta").is_none());
        assert_eq!(list_req.header("mcp-protocol-version"), Some("2025-06-18"));

        // 判定结果被缓存：同配置的新 client 直接握手，不再探测。
        let mut again = McpClient::spawn(url_config("legacy-http", "http", Some(&url))).unwrap();
        again.tools_list().unwrap();
        assert_eq!(methods(&log)[4], "initialize");
    }

    #[test]
    fn unsupported_version_error_with_legacy_list_falls_back() {
        let (url, log) = spawn_mock_http(|req| match req.method() {
            "server/discover" => error_response(
                req,
                400,
                -32022,
                json!({ "supported": ["2025-11-25"], "requested": "2026-07-28" }),
            ),
            "initialize" => ok_result(
                req,
                json!({ "protocolVersion": "2025-11-25", "capabilities": {} }),
            ),
            "notifications/initialized" => accepted(),
            "tools/list" => ok_result(req, json!({ "tools": [] })),
            _ => error_response(req, 404, -32601, Value::Null),
        });

        let mut client = McpClient::spawn(url_config("dual-http", "http", Some(&url))).unwrap();
        client.tools_list().unwrap();
        assert_eq!(client.protocol_version().as_deref(), Some("2025-11-25"));
        assert_eq!(methods(&log)[..2], ["server/discover", "initialize"]);
    }

    #[test]
    fn incompatible_modern_server_reports_error_without_initialize() {
        let (url, log) = spawn_mock_http(|req| {
            error_response(
                req,
                400,
                -32022,
                json!({ "supported": ["2099-01-01"], "requested": "2026-07-28" }),
            )
        });

        let mut client = McpClient::spawn(url_config("future-http", "http", Some(&url))).unwrap();
        let err = client.tools_list().unwrap_err();
        assert!(err.contains("2099-01-01"), "{err}");
        assert_eq!(methods(&log), vec!["server/discover"]);
    }

    #[test]
    fn input_required_result_is_reported_as_error() {
        let (url, _log) = spawn_mock_http(|req| match req.method() {
            "server/discover" => ok_result(
                req,
                json!({ "resultType": "complete", "supportedVersions": ["2026-07-28"], "capabilities": {} }),
            ),
            "tools/call" => ok_result(
                req,
                json!({ "resultType": "input_required", "inputRequests": {} }),
            ),
            _ => ok_result(req, json!({ "resultType": "complete", "tools": [] })),
        });

        let mut client = McpClient::spawn(url_config("mrtr-http", "http", Some(&url))).unwrap();
        let err = client.tools_call("anything", json!({})).unwrap_err();
        assert!(err.contains("input_required"), "{err}");
    }

    #[cfg(unix)]
    fn sh_server(id: &str, script: &str) -> McpServerConfig {
        let mut cfg = stdio_config(id, "sh");
        cfg.args = vec!["-c".to_string(), script.to_string()];
        cfg.timeout_ms = Some(2_000);
        cfg
    }

    /// sh 版 server：每行一个请求，取出 id；未匹配的 method 不回包（模拟静默）。
    #[cfg(unix)]
    const SH_ID: &str = r#"id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"#;

    #[cfg(unix)]
    #[test]
    fn silent_legacy_stdio_server_falls_back_after_probe_timeout() {
        let script = format!(
            r#"while IFS= read -r line; do {SH_ID}
case "$line" in
  *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"protocolVersion":"2024-11-05","capabilities":{{}}}}}}\n' "$id";;
  *'"method":"tools/list"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"tools":[{{"name":"echo"}}]}}}}\n' "$id";;
esac
done"#
        );
        let mut client = McpClient::spawn(sh_server("silent-legacy-stdio", &script)).unwrap();
        assert_eq!(client.tools_list().unwrap().len(), 1);
        assert_eq!(client.protocol_version().as_deref(), Some("2024-11-05"));
    }

    #[cfg(unix)]
    #[test]
    fn modern_stdio_server_gets_meta_on_every_request() {
        // 缺 modern _meta 的请求（含 initialize）一律回 -32602，模拟纯 modern server。
        let script = format!(
            r#"while IFS= read -r line; do {SH_ID}
case "$line" in
  *'io.modelcontextprotocol/protocolVersion":"2026-07-28"'*)
    case "$line" in
      *'"method":"server/discover"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{{"tools":{{}}}}}}}}\n' "$id";;
      *'"method":"tools/list"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"resultType":"complete","tools":[{{"name":"a"}},{{"name":"b"}}]}}}}\n' "$id";;
    esac;;
  *) printf '{{"jsonrpc":"2.0","id":%s,"error":{{"code":-32602,"message":"params._meta is required"}}}}\n' "$id";;
esac
done"#
        );
        let mut client = McpClient::spawn(sh_server("modern-stdio", &script)).unwrap();
        assert_eq!(client.tools_list().unwrap().len(), 2);
        assert_eq!(client.protocol_version().as_deref(), Some("2026-07-28"));
    }

    #[cfg(unix)]
    #[test]
    fn legacy_stdio_server_that_exits_on_probe_is_respawned() {
        // 握手前收到任何非 initialize 请求就退出（部分老 SDK 的行为）。
        let script = format!(
            r#"while IFS= read -r line; do {SH_ID}
case "$line" in
  *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"protocolVersion":"2025-03-26","capabilities":{{}}}}}}\n' "$id";;
  *'"method":"notifications/initialized"'*) ;;
  *'"method":"tools/list"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"tools":[]}}}}\n' "$id";;
  *) exit 1;;
esac
done"#
        );
        let mut client = McpClient::spawn(sh_server("exiting-legacy-stdio", &script)).unwrap();
        client.tools_list().unwrap();
        assert_eq!(client.protocol_version().as_deref(), Some("2025-03-26"));
    }
}
