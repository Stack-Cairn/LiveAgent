//! MCP OAuth 2.1 服务（docs/design/mcp-oauth.md，roadmap P1-③）。
//!
//! 分层：
//! - `discovery` 发现链（RFC 9728/8414 + 旧规范 fallback）
//! - `register` RFC 7591 动态注册
//! - `flow` PKCE/loopback/token 端点机械件
//! - `store` keychain 存储 + 文件降级 + 进程内缓存
//!
//! 本模块编排两条路径：
//! 1. **交互授权**（`authorize`）——仅由显式用户手势触发（MCP Hub Connect），
//!    弹系统浏览器；同 server 进程内互斥。
//! 2. **运行时供 token**（`ensure_bearer` / `refresh_after_unauthorized`）——
//!    transport 每请求取 Bearer，将过期主动刷新、401 被动刷新；绝不弹浏览器。

pub mod discovery;
pub mod flow;
pub mod register;
pub mod store;

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use store::TokenRecord;

/// 稳定标记：错误信息含它即「需要用户去 MCP Hub 完成授权」，前端据此引导。
pub const AUTH_REQUIRED_MARKER: &str = "MCP_OAUTH_AUTHORIZATION_REQUIRED";

#[derive(Debug, Clone)]
pub struct OauthServer {
    pub id: String,
    pub url: String,
    /// 配置里的 scope 覆盖（优先于 PRM scopes_supported）。
    pub scope_override: Option<String>,
    /// 静态 client_id（企业 AS 场景；配置后跳过动态注册）。
    pub static_client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OauthStatusInfo {
    /// "none" | "authorized" | "expired"（expired 且 refreshable 时运行时会自愈）。
    pub state: String,
    pub refreshable: bool,
    /// "keychain" | "file" | "unknown"
    pub storage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

fn none_status() -> OauthStatusInfo {
    OauthStatusInfo {
        state: "none".to_string(),
        refreshable: false,
        storage: store::storage_label().to_string(),
        expires_at_ms: None,
        issuer: None,
        scope: None,
    }
}

fn status_of(record: &TokenRecord) -> OauthStatusInfo {
    let now = store::now_ms();
    OauthStatusInfo {
        state: if record.is_expired(now) {
            "expired".to_string()
        } else {
            "authorized".to_string()
        },
        refreshable: record.refresh_token.is_some(),
        storage: store::storage_label().to_string(),
        expires_at_ms: (record.expires_at_ms != 0).then_some(record.expires_at_ms),
        issuer: Some(record.issuer.clone()),
        scope: record.scope.clone(),
    }
}

/// 读取记录并校验其 server_url 与当前配置一致；不一致视作无 token（防串用）。
fn load_matching(server_id: &str, url: &str) -> Option<TokenRecord> {
    let record = store::load(server_id)?;
    let canonical = discovery::canonical_resource(url).ok()?;
    (record.server_url == canonical).then_some(record)
}

pub fn status(server: &OauthServer) -> OauthStatusInfo {
    match load_matching(&server.id, &server.url) {
        Some(record) => status_of(&record),
        None => none_status(),
    }
}

/// 卸载 server / 用户断开授权时调用：清 keychain 与文件降级条目。
pub fn clear(server_id: &str) -> Result<(), String> {
    store::delete(server_id)
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    // 出站纪律：与 MCP transport 同走应用代理，代理配置异常 fail fast。
    crate::services::system_proxy::blocking_client_builder()
        .map_err(|e| format!("创建 OAuth HTTP client 失败：{e}"))?
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("创建 OAuth HTTP client 失败：{e}"))
}

// ---- 交互授权（进程内同 server 互斥） ----

fn authorize_guard() -> &'static Mutex<HashSet<String>> {
    static GUARD: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(HashSet::new()))
}

struct AuthorizeSlot(String);

impl AuthorizeSlot {
    fn acquire(server_id: &str) -> Result<Self, String> {
        let mut guard = authorize_guard()
            .lock()
            .map_err(|_| "授权互斥锁失败".to_string())?;
        if !guard.insert(server_id.to_string()) {
            return Err(format!("server `{server_id}` 的授权正在进行中，请先完成或等待超时"));
        }
        Ok(Self(server_id.to_string()))
    }
}

impl Drop for AuthorizeSlot {
    fn drop(&mut self) {
        if let Ok(mut guard) = authorize_guard().lock() {
            guard.remove(&self.0);
        }
    }
}

/// 完整交互授权流（阻塞数分钟，必须在 spawn_blocking 里跑）。
/// `open_url` 由命令层注入（tauri-plugin-opener），保持服务层无 Tauri 依赖。
pub fn authorize(
    server: &OauthServer,
    open_url: &dyn Fn(&str) -> Result<(), String>,
) -> Result<OauthStatusInfo, String> {
    let server_id = server.id.trim();
    if server_id.is_empty() {
        return Err("server id 不能为空".to_string());
    }
    let _slot = AuthorizeSlot::acquire(server_id)?;

    let client = http_client()?;
    let discovered = discovery::discover(&client, &server.url)?;

    // 先绑端口再定 redirect_uri，动态注册才能带上准确的回调地址。
    let loopback = flow::Loopback::bind()?;
    let redirect_uri = loopback.redirect_uri();

    // client 凭据：静态配置 > keychain 存量注册（issuer 一致才复用）> 动态注册。
    let stored = load_matching(server_id, &server.url);
    let reused_stored_client = stored
        .as_ref()
        .is_some_and(|record| record.issuer == discovered.issuer && !record.client_id.is_empty());
    let (client_id, client_secret, auth_method) = if let Some(static_id) = server
        .static_client_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        (static_id.to_string(), None, "none".to_string())
    } else if let (true, Some(record)) = (reused_stored_client, stored.as_ref()) {
        (
            record.client_id.clone(),
            record.client_secret.clone(),
            record.token_endpoint_auth_method.clone(),
        )
    } else {
        let endpoint = discovered.registration_endpoint.as_deref().ok_or_else(|| {
            format!(
                "授权服务器 {} 未开放动态注册，请在 server 配置里填写 OAuth Client ID",
                discovered.issuer
            )
        })?;
        let registered = register::dynamic_register(
            &client,
            endpoint,
            &redirect_uri,
            server.scope_override.as_deref(),
        )?;
        (
            registered.client_id,
            registered.client_secret,
            registered.token_endpoint_auth_method,
        )
    };

    let scope = server
        .scope_override
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            (!discovered.scopes_supported.is_empty())
                .then(|| discovered.scopes_supported.join(" "))
        });

    let pkce = flow::new_pkce()?;
    let state = flow::random_b64url(32)?;
    let authorize_url = flow::build_authorize_url(
        &discovered.authorization_endpoint,
        &client_id,
        &redirect_uri,
        &state,
        &pkce.challenge,
        &discovered.resource,
        scope.as_deref(),
    )?;
    if !flow::is_safe_browser_url(&authorize_url) {
        return Err(format!("拒绝打开不安全的授权 URL：{authorize_url}"));
    }
    open_url(&authorize_url)?;

    let code = match loopback.wait_for_code(&state, flow::AUTHORIZE_TIMEOUT) {
        Ok(code) => code,
        Err(error) => {
            // 复用的存量 client 可能已被 AS 作废（浏览器阶段报错）。清掉记录，
            // 下次重试走全新动态注册自愈。
            if reused_stored_client && server.static_client_id.is_none() {
                let _ = store::delete(server_id);
            }
            return Err(error);
        }
    };

    let credentials = flow::ClientCredentials {
        client_id: &client_id,
        client_secret: client_secret.as_deref(),
        auth_method: &auth_method,
    };
    let tokens = flow::exchange_code(
        &client,
        &discovered.token_endpoint,
        &credentials,
        &code,
        &pkce.verifier,
        &redirect_uri,
        &discovered.resource,
    )?;

    let now = store::now_ms();
    let record = TokenRecord {
        version: 1,
        server_url: discovered.resource.clone(),
        issuer: discovered.issuer.clone(),
        authorization_endpoint: discovered.authorization_endpoint.clone(),
        token_endpoint: discovered.token_endpoint.clone(),
        registration_endpoint: discovered.registration_endpoint.clone(),
        client_id,
        client_secret,
        token_endpoint_auth_method: auth_method,
        scope: tokens.scope.clone().or(scope),
        resource: discovered.resource.clone(),
        access_token: tokens.access_token.clone(),
        refresh_token: tokens.refresh_token.clone(),
        expires_at_ms: tokens
            .expires_in
            .map(|secs| now.saturating_add(secs.saturating_mul(1000)))
            .unwrap_or(0),
    };
    store::save(server_id, &record)?;
    Ok(status_of(&record))
}

// ---- 运行时 token 供给 ----

fn refresh_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn refresh_lock_for(server_id: &str) -> Arc<Mutex<()>> {
    let mut locks = match refresh_locks().lock() {
        Ok(locks) => locks,
        Err(poisoned) => poisoned.into_inner(),
    };
    locks
        .entry(server_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// 刷新并落盘；单飞：并发到达的请求拿锁后重读，若别人刚刷完直接复用。
fn refresh_record(server_id: &str, stale: &TokenRecord) -> Result<TokenRecord, String> {
    let lock = refresh_lock_for(server_id);
    let _guard = lock.lock().map_err(|_| "刷新互斥锁失败".to_string())?;

    if let Some(current) = store::load(server_id) {
        if current.access_token != stale.access_token && !current.is_expiring(store::now_ms()) {
            return Ok(current);
        }
        let refresh_token = current
            .refresh_token
            .clone()
            .ok_or_else(|| "无 refresh_token，需重新授权".to_string())?;

        let client = http_client()?;
        let credentials = flow::ClientCredentials {
            client_id: &current.client_id,
            client_secret: current.client_secret.as_deref(),
            auth_method: &current.token_endpoint_auth_method,
        };
        let tokens = flow::refresh_grant(
            &client,
            &current.token_endpoint,
            &credentials,
            &refresh_token,
            &current.resource,
        )?;

        let now = store::now_ms();
        let mut next = current.clone();
        next.access_token = tokens.access_token;
        // RFC 6749 §6：AS 可轮换 refresh_token；未返回则沿用旧值。
        if let Some(rotated) = tokens.refresh_token {
            next.refresh_token = Some(rotated);
        }
        if let Some(scope) = tokens.scope {
            next.scope = Some(scope);
        }
        next.expires_at_ms = tokens
            .expires_in
            .map(|secs| now.saturating_add(secs.saturating_mul(1000)))
            .unwrap_or(0);
        store::save(server_id, &next)?;
        Ok(next)
    } else {
        Err("token 记录已不存在，需重新授权".to_string())
    }
}

/// transport 每请求取 Bearer：无记录/URL 不符返回 None（请求裸发，401 走被动
/// 路径）；将过期且可刷新时主动刷新，刷新失败仍返回旧 token 兜底尝试。
pub fn ensure_bearer(server_id: &str, url: &str) -> Option<String> {
    let record = load_matching(server_id, url)?;
    if record.is_expiring(store::now_ms()) && record.refresh_token.is_some() {
        match refresh_record(server_id.trim(), &record) {
            Ok(next) => return Some(next.access_token),
            Err(error) => {
                eprintln!("[MCP OAuth] server `{server_id}` 主动刷新失败，回退旧 token：{error}");
            }
        }
    }
    Some(record.access_token)
}

/// 401 被动刷新：成功返回新 Bearer；不可行（无记录/无 refresh_token/刷新被拒）
/// 返回 Err——调用方应转成带 [`AUTH_REQUIRED_MARKER`] 的用户可见错误。
pub fn refresh_after_unauthorized(server_id: &str, url: &str) -> Result<String, String> {
    let record = load_matching(server_id, url)
        .ok_or_else(|| "尚未完成 OAuth 授权（无 token 记录）".to_string())?;
    let refreshed = refresh_record(server_id.trim(), &record)?;
    Ok(refreshed.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_slot_blocks_concurrent_same_server() {
        let slot = AuthorizeSlot::acquire("dup-server").expect("first");
        let second = AuthorizeSlot::acquire("dup-server");
        assert!(second.is_err(), "同 server 并发授权必须被拒");
        assert!(AuthorizeSlot::acquire("other-server").is_ok(), "不同 server 不受影响");
        drop(slot);
        assert!(AuthorizeSlot::acquire("dup-server").is_ok(), "释放后可再授权");
    }

    #[test]
    fn status_maps_expiry_and_refreshability() {
        let now = store::now_ms();
        let mut record = TokenRecord {
            version: 1,
            server_url: "https://mcp.example.com/mcp".to_string(),
            issuer: "https://auth.example.com".to_string(),
            authorization_endpoint: "https://auth.example.com/authorize".to_string(),
            token_endpoint: "https://auth.example.com/token".to_string(),
            registration_endpoint: None,
            client_id: "c".to_string(),
            client_secret: None,
            token_endpoint_auth_method: "none".to_string(),
            scope: Some("s".to_string()),
            resource: "https://mcp.example.com/mcp".to_string(),
            access_token: "at".to_string(),
            refresh_token: Some("rt".to_string()),
            expires_at_ms: now + 3_600_000,
        };
        let live = status_of(&record);
        assert_eq!(live.state, "authorized");
        assert!(live.refreshable);
        assert_eq!(live.expires_at_ms, Some(record.expires_at_ms));

        record.expires_at_ms = 1;
        record.refresh_token = None;
        let dead = status_of(&record);
        assert_eq!(dead.state, "expired");
        assert!(!dead.refreshable);
    }
}
