//! 授权码流机械件（docs/design/mcp-oauth.md §4.1/§6）。
//!
//! PKCE(S256)/state 生成、`127.0.0.1:随机端口` loopback 回调（RFC 8252，
//! one-shot、5 分钟超时、state 恒等校验）、authorize URL 拼装、token
//! 交换与刷新（RFC 8707 `resource` 参数绑定受众）。

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

pub const CALLBACK_PATH: &str = "/callback";
pub const AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(300);

pub fn random_b64url(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("获取随机熵失败：{e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

#[derive(Debug, Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn new_pkce() -> Result<Pkce, String> {
    // RFC 7636：32 字节熵 → base64url 43 字符 verifier；challenge = S256(verifier)。
    let verifier = random_b64url(32)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Ok(Pkce { verifier, challenge })
}

pub fn build_authorize_url(
    authorization_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
    resource: &str,
    scope: Option<&str>,
) -> Result<String, String> {
    let mut url = Url::parse(authorization_endpoint)
        .map_err(|e| format!("authorization_endpoint 无效：{authorization_endpoint}（{e}）"))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("state", state)
            .append_pair("code_challenge", code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("resource", resource);
        if let Some(scope) = scope.map(str::trim).filter(|s| !s.is_empty()) {
            query.append_pair("scope", scope);
        }
    }
    Ok(url.to_string())
}

/// 授权 URL 只允许在系统浏览器里打开 https 或 loopback http（阻断
/// `javascript:` 等注入面，见设计 §6）。
pub fn is_safe_browser_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    match url.scheme() {
        "https" => true,
        "http" => matches!(url.host_str(), Some("127.0.0.1") | Some("localhost")),
        _ => false,
    }
}

// ---- loopback 回调 ----

pub struct Loopback {
    listener: TcpListener,
    port: u16,
}

const CALLBACK_OK_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>LiveAgent</title></head><body style=\"font-family:system-ui;display:flex;align-items:center;justify-content:center;height:90vh\"><div style=\"text-align:center\"><h2>授权完成 / Authorization complete</h2><p>可以关闭此页面，回到 LiveAgent。/ You can close this page and return to LiveAgent.</p></div></body></html>";

const CALLBACK_FAIL_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>LiveAgent</title></head><body style=\"font-family:system-ui;display:flex;align-items:center;justify-content:center;height:90vh\"><div style=\"text-align:center\"><h2>授权未完成 / Authorization failed</h2><p>请回到 LiveAgent 查看详情并重试。/ Return to LiveAgent for details and retry.</p></div></body></html>";

impl Loopback {
    pub fn bind() -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("绑定 loopback 回调端口失败：{e}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("设置 loopback 监听非阻塞失败：{e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("读取 loopback 端口失败：{e}"))?
            .port();
        Ok(Self { listener, port })
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{}", self.port, CALLBACK_PATH)
    }

    /// 阻塞等待浏览器回调，返回授权码。one-shot：拿到结果即返回，listener 随
    /// self drop 关闭。state 不符的请求回 400 并继续等待（防 CSRF 抢答）。
    pub fn wait_for_code(&self, expected_state: &str, timeout: Duration) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return Err("等待浏览器授权回调超时（5 分钟）".to_string());
            }
            let (stream, peer) = match self.listener.accept() {
                Ok(pair) => pair,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                Err(e) => return Err(format!("loopback accept 失败：{e}")),
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            match handle_callback_connection(stream, expected_state) {
                CallbackOutcome::Code(code) => return Ok(code),
                CallbackOutcome::OauthError(message) => return Err(message),
                CallbackOutcome::Ignored => continue,
            }
        }
    }
}

enum CallbackOutcome {
    Code(String),
    OauthError(String),
    Ignored,
}

fn handle_callback_connection(stream: TcpStream, expected_state: &str) -> CallbackOutcome {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_nonblocking(false);
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return CallbackOutcome::Ignored;
    }

    let target = match parse_request_target(&request_line) {
        Some(target) => target,
        None => {
            respond(reader.into_inner(), "400 Bad Request", CALLBACK_FAIL_HTML);
            return CallbackOutcome::Ignored;
        }
    };

    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        respond(reader.into_inner(), "400 Bad Request", CALLBACK_FAIL_HTML);
        return CallbackOutcome::Ignored;
    };
    if url.path() != CALLBACK_PATH {
        respond(reader.into_inner(), "404 Not Found", CALLBACK_FAIL_HTML);
        return CallbackOutcome::Ignored;
    }

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut error: Option<String> = None;
    let mut error_description: Option<String> = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            "error_description" => error_description = Some(value.into_owned()),
            _ => {}
        }
    }

    if state.as_deref() != Some(expected_state) {
        // CSRF/串台：不接受也不终止，继续等真正的回调。
        respond(reader.into_inner(), "400 Bad Request", CALLBACK_FAIL_HTML);
        return CallbackOutcome::Ignored;
    }

    if let Some(error) = error {
        respond(reader.into_inner(), "200 OK", CALLBACK_FAIL_HTML);
        let detail = error_description
            .map(|d| format!("：{d}"))
            .unwrap_or_default();
        return CallbackOutcome::OauthError(format!("授权服务器返回错误 {error}{detail}"));
    }

    match code {
        Some(code) if !code.trim().is_empty() => {
            respond(reader.into_inner(), "200 OK", CALLBACK_OK_HTML);
            CallbackOutcome::Code(code)
        }
        _ => {
            respond(reader.into_inner(), "400 Bad Request", CALLBACK_FAIL_HTML);
            CallbackOutcome::Ignored
        }
    }
}

fn parse_request_target(request_line: &str) -> Option<String> {
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?;
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let target = parts.next()?;
    if !target.starts_with('/') {
        return None;
    }
    Some(target.to_string())
}

fn respond(mut stream: TcpStream, status: &str, body: &str) {
    let payload = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(payload.as_bytes());
    let _ = stream.flush();
}

// ---- token 端点 ----

#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub token_type: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OauthErrorBody {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

pub struct ClientCredentials<'a> {
    pub client_id: &'a str,
    pub client_secret: Option<&'a str>,
    /// "none" | "client_secret_post" | "client_secret_basic"
    pub auth_method: &'a str,
}

fn encode_form(pairs: &[(&'static str, String)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

fn token_request(
    client: &Client,
    token_endpoint: &str,
    credentials: &ClientCredentials<'_>,
    params: Vec<(&'static str, String)>,
) -> Result<TokenResponse, String> {
    let mut form = params;
    form.push(("client_id", credentials.client_id.to_string()));

    let mut builder = client
        .post(token_endpoint)
        .header(ACCEPT, "application/json");
    match (credentials.auth_method, credentials.client_secret) {
        ("client_secret_basic", Some(secret)) => {
            builder = builder.basic_auth(credentials.client_id, Some(secret));
        }
        (_, Some(secret)) => {
            // 未知 method 但持有 secret 时按 client_secret_post 处理。
            form.push(("client_secret", secret.to_string()));
        }
        _ => {}
    }

    let resp = builder
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(encode_form(&form))
        .send()
        .map_err(|e| format!("token 请求失败（{token_endpoint}）：{e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .map_err(|e| format!("读取 token 响应失败：{e}"))?;

    if !status.is_success() {
        if let Ok(err) = serde_json::from_str::<OauthErrorBody>(&text) {
            let detail = err
                .error_description
                .map(|d| format!("：{d}"))
                .unwrap_or_default();
            return Err(format!("token 端点返回 {}（{}{detail}）", status, err.error));
        }
        return Err(format!("token 端点返回 {status}"));
    }

    let parsed: TokenResponse =
        serde_json::from_str(&text).map_err(|e| format!("解析 token 响应失败：{e}"))?;
    if parsed.access_token.trim().is_empty() {
        return Err("token 响应缺少 access_token".to_string());
    }
    if let Some(token_type) = parsed.token_type.as_deref() {
        if !token_type.eq_ignore_ascii_case("bearer") {
            return Err(format!("不支持的 token_type：{token_type}（仅支持 Bearer）"));
        }
    }
    Ok(parsed)
}

#[allow(clippy::too_many_arguments)]
pub fn exchange_code(
    client: &Client,
    token_endpoint: &str,
    credentials: &ClientCredentials<'_>,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
    resource: &str,
) -> Result<TokenResponse, String> {
    token_request(
        client,
        token_endpoint,
        credentials,
        vec![
            ("grant_type", "authorization_code".to_string()),
            ("code", code.to_string()),
            ("redirect_uri", redirect_uri.to_string()),
            ("code_verifier", code_verifier.to_string()),
            ("resource", resource.to_string()),
        ],
    )
}

pub fn refresh_grant(
    client: &Client,
    token_endpoint: &str,
    credentials: &ClientCredentials<'_>,
    refresh_token: &str,
    resource: &str,
) -> Result<TokenResponse, String> {
    token_request(
        client,
        token_endpoint,
        credentials,
        vec![
            ("grant_type", "refresh_token".to_string()),
            ("refresh_token", refresh_token.to_string()),
            ("resource", resource.to_string()),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_s256() {
        let pkce = new_pkce().expect("pkce");
        assert!(pkce.verifier.len() >= 43, "32 字节熵应产出 ≥43 字符 verifier");
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(pkce.verifier.as_bytes()));
        assert_eq!(pkce.challenge, expected);
        // 不重复（熵源有效）。
        assert_ne!(new_pkce().expect("pkce2").verifier, pkce.verifier);
    }

    #[test]
    fn authorize_url_contains_required_oauth_params() {
        let url = build_authorize_url(
            "https://auth.example.com/authorize?audience=x",
            "client-1",
            "http://127.0.0.1:23456/callback",
            "state-1",
            "challenge-1",
            "https://mcp.example.com/mcp",
            Some("mcp.read"),
        )
        .expect("url");
        let parsed = Url::parse(&url).expect("parse");
        let pairs: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(pairs.get("audience").map(String::as_str), Some("x"));
        assert_eq!(pairs.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(pairs.get("client_id").map(String::as_str), Some("client-1"));
        assert_eq!(
            pairs.get("redirect_uri").map(String::as_str),
            Some("http://127.0.0.1:23456/callback")
        );
        assert_eq!(pairs.get("code_challenge_method").map(String::as_str), Some("S256"));
        assert_eq!(
            pairs.get("resource").map(String::as_str),
            Some("https://mcp.example.com/mcp")
        );
        assert_eq!(pairs.get("scope").map(String::as_str), Some("mcp.read"));
    }

    #[test]
    fn browser_url_safety_blocks_non_https_non_loopback() {
        assert!(is_safe_browser_url("https://auth.example.com/authorize"));
        assert!(is_safe_browser_url("http://127.0.0.1:8080/authorize"));
        assert!(is_safe_browser_url("http://localhost/authorize"));
        assert!(!is_safe_browser_url("http://auth.example.com/authorize"));
        assert!(!is_safe_browser_url("javascript:alert(1)"));
        assert!(!is_safe_browser_url("file:///etc/passwd"));
    }

    #[test]
    fn request_target_parser_accepts_get_only() {
        assert_eq!(
            parse_request_target("GET /callback?code=1 HTTP/1.1\r\n"),
            Some("/callback?code=1".to_string())
        );
        assert_eq!(parse_request_target("POST /callback HTTP/1.1\r\n"), None);
        assert_eq!(parse_request_target("GET http://evil/ HTTP/1.1\r\n"), None);
        assert_eq!(parse_request_target("garbage"), None);
    }

    #[test]
    fn loopback_roundtrip_returns_code_and_rejects_wrong_state() {
        let loopback = Loopback::bind().expect("bind");
        let uri = loopback.redirect_uri();
        let port = Url::parse(&uri).expect("uri").port().expect("port");

        let hit = std::thread::spawn(move || {
            // 先来一个 state 不符的请求（应被 400 拒绝且不终止等待），再来正确回调。
            let send = |path: &str| {
                let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
                s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
                    .expect("write");
                let mut buf = String::new();
                let _ = BufReader::new(s).read_line(&mut buf);
                buf
            };
            std::thread::sleep(Duration::from_millis(50));
            let first = send("/callback?code=evil&state=wrong");
            std::thread::sleep(Duration::from_millis(50));
            let second = send("/callback?code=good-code&state=expected");
            (first, second)
        });

        let code = loopback
            .wait_for_code("expected", Duration::from_secs(5))
            .expect("code");
        assert_eq!(code, "good-code");
        let (first, second) = hit.join().expect("join");
        assert!(first.contains("400"), "state 不符必须 400：{first}");
        assert!(second.contains("200"), "正确回调必须 200：{second}");
    }

    #[test]
    fn loopback_reports_oauth_error_from_callback() {
        let loopback = Loopback::bind().expect("bind");
        let uri = loopback.redirect_uri();
        let port = Url::parse(&uri).expect("uri").port().expect("port");

        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            s.write_all(
                b"GET /callback?error=access_denied&error_description=nope&state=expected HTTP/1.1\r\nHost: x\r\n\r\n",
            )
            .expect("write");
            let mut buf = String::new();
            let _ = BufReader::new(s).read_line(&mut buf);
        });

        let err = loopback
            .wait_for_code("expected", Duration::from_secs(5))
            .expect_err("must fail");
        assert!(err.contains("access_denied"));
        assert!(err.contains("nope"));
    }
}
