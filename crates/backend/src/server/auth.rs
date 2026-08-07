//! Bearer token 认证模块。
//!
//! 决策 7：密码 = Bearer token。不用 JWT 或 session，用户只有一把钥匙。
//! - 不给密码就用默认值 `pleasechangethepassword`，启动时在 stderr 提醒改掉。
//! - 每个 request 的 Authorization: Bearer <password> header 里的密码就是这个。
//! - 常量时间比较，防止时序侧信道泄露密码内容。
//!
//! 第二把钥匙是**引擎凭据**：本机 Node 引擎（core）回调后端时不能拿用户密码
//! （它会出现在子进程的环境里），所以每次 spawn 现生成一个随机串，经
//! `LIVEAGENT_BACKEND_TOKEN` 下发，进程活多久它有效多久，重启即失效。
//!
//! 这两把钥匙**替代了原来的 loopback 豁免**。豁免按来源地址放行，而
//! `CorsLayer::permissive` 之下「来自本机」根本不构成身份——浏览器里任意一个
//! 页面猜中端口就能无凭据调 `shell_run`。现在没有任何请求可以不带凭据进 /api。

use axum::http::HeaderMap;
use subtle::ConstantTimeEq;

/// 未配置密码时的默认值。众所周知的固定串——只适合本机/内网试用，
/// 对外部署必须显式设置密码（启动时会在 stderr 提醒）。
pub const DEFAULT_PASSWORD: &str = "pleasechangethepassword";

/// 常量时间比较。
///
/// 长度不等时拿 secret 跟自己比：比较耗时始终只取决于 secret 的长度，
/// 不让攻击者通过响应时间推断有没有猜中。
fn constant_time_eq(secret: &str, presented: &str) -> bool {
    let secret_bytes = secret.as_bytes();
    let presented_bytes = presented.as_bytes();
    let len_eq = secret_bytes.len() == presented_bytes.len();
    let target = if len_eq { presented_bytes } else { secret_bytes };
    let data_eq: bool = secret_bytes.ct_eq(target).into();
    len_eq && data_eq
}

/// 认证配置：用户密码 + 引擎凭据两把钥匙。
pub struct AuthConfig {
    password: String,
    /// 本机 Node 引擎的一次性凭据，`None` 表示引擎还没起来。
    /// 用 `std::sync` 而不是 tokio 的锁：临界区只是一次字符串比较，
    /// 不跨 await，异步锁在这里只会把中间件染成必须 await 的形状。
    engine_token: std::sync::RwLock<Option<String>>,
}

impl AuthConfig {
    pub fn new(password: String) -> Self {
        Self {
            password,
            engine_token: std::sync::RwLock::new(None),
        }
    }

    /// 为一次 core spawn 生成新的引擎凭据，顶掉上一次的。
    ///
    /// 每次 spawn 都换：旧进程的凭据随之作废，泄露的窗口不会跨越进程生命周期。
    /// 返回值由调用方经环境变量交给子进程——除此之外它不落盘、不进日志。
    pub fn rotate_engine_token(&self) -> String {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        *self.write_engine_token() = Some(token.clone());
        token
    }

    /// 引擎退出后作废凭据。
    pub fn clear_engine_token(&self) {
        *self.write_engine_token() = None;
    }

    /// 常量时间验证 Bearer token：用户密码或引擎凭据，任一命中即通过。
    ///
    /// 两个比较都做完再取或，不用 `||` 短路——短路会让「密码对不对」
    /// 从响应时间里泄出来。
    pub fn verify(&self, presented: &str) -> bool {
        let password_hit = constant_time_eq(&self.password, presented);
        let engine_hit = self
            .read_engine_token()
            .as_deref()
            .is_some_and(|token| constant_time_eq(token, presented));
        password_hit | engine_hit
    }

    /// 锁中毒不该让认证瘫痪：里面只有一个 String，没有「写到一半」的坏状态。
    fn read_engine_token(&self) -> std::sync::RwLockReadGuard<'_, Option<String>> {
        self.engine_token.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write_engine_token(&self) -> std::sync::RwLockWriteGuard<'_, Option<String>> {
        self.engine_token.write().unwrap_or_else(|e| e.into_inner())
    }
}


/// Axum middleware：校验 Authorization: Bearer <token> header。
///
/// 没有例外：本机 Node 引擎也要带 `LIVEAGENT_BACKEND_TOKEN` 里的引擎凭据。
/// 三种失败情况（缺 header、格式错、凭据错）都返回同样的 401，不暴露细节。
pub async fn require_bearer(
    axum::extract::State(state): axum::extract::State<crate::server::state::AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    let token = extract_bearer_token(req.headers()).ok_or(axum::http::StatusCode::UNAUTHORIZED)?;
    if state.auth.verify(token) {
        Ok(next.run(req).await)
    } else {
        Err(axum::http::StatusCode::UNAUTHORIZED)
    }
}

/// 从 Authorization header 提取 Bearer token。
///
/// 返回 None 如果：
/// - 没有 Authorization header
/// - 格式不是 "Bearer <token>"（case-insensitive Bearer）
/// - token 为空
fn extract_bearer_token(headers: &HeaderMap) -> Option<&str> {
    let auth_str = headers.get("authorization")?.to_str().ok()?;
    if auth_str.len() < 7 {
        return None;
    }
    let (scheme, rest) = auth_str.split_at(6);
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = rest.trim_start();
    if token.is_empty() {
        return None;
    }
    Some(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 引擎凭据没生成时,verify 不该把任何东西放进来——尤其不是空串。
    #[test]
    fn engine_token_absent_rejects_everything() {
        let config = AuthConfig::new("pw".to_string());
        assert!(!config.verify(""));
        assert!(!config.verify("anything"));
        assert!(config.verify("pw"));
    }

    /// 两把钥匙各开各的门，互不影响。
    #[test]
    fn engine_token_and_password_both_verify() {
        let config = AuthConfig::new("pw".to_string());
        let engine = config.rotate_engine_token();
        assert!(config.verify(&engine), "引擎凭据必须能过");
        assert!(config.verify("pw"), "用户密码不能被引擎凭据顶掉");
        assert!(!config.verify("pw2"));
    }

    /// 每次 spawn 换一把：旧凭据当场作废，泄露窗口不跨进程生命周期。
    #[test]
    fn rotating_engine_token_invalidates_the_previous_one() {
        let config = AuthConfig::new("pw".to_string());
        let first = config.rotate_engine_token();
        let second = config.rotate_engine_token();
        assert_ne!(first, second, "每次必须是新的随机串");
        assert!(!config.verify(&first), "旧凭据必须失效");
        assert!(config.verify(&second));
    }

    /// 引擎退出后凭据作废。
    #[test]
    fn clearing_engine_token_revokes_access() {
        let config = AuthConfig::new("pw".to_string());
        let engine = config.rotate_engine_token();
        config.clear_engine_token();
        assert!(!config.verify(&engine));
        assert!(config.verify("pw"), "清引擎凭据不该动用户密码");
    }

    /// 凭据得够长——猜得中的随机串等于没有随机串。
    #[test]
    fn engine_token_is_long_enough_to_be_unguessable() {
        let token = AuthConfig::new("pw".to_string()).rotate_engine_token();
        assert_eq!(token.len(), 64, "两个 uuid v4 的 simple 形式");
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_verify_correct_password() {
        let config = AuthConfig::new("my_secret_password".to_string());
        assert!(config.verify("my_secret_password"));
    }

    #[test]
    fn test_verify_wrong_password() {
        let config = AuthConfig::new("my_secret_password".to_string());
        assert!(!config.verify("wrong_password"));
    }

    /// 不同长度的输入也要被拒绝，且不泄露长度信息（常量时间）。
    #[test]
    fn test_verify_different_length_constant_time() {
        let config = AuthConfig::new("password123".to_string());
        assert!(!config.verify("pass"));
        assert!(!config.verify("password123extra"));
        assert!(!config.verify("xyz"));
        assert!(!config.verify(""));
    }

    #[test]
    fn test_extract_bearer_token_success() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer my_token".parse().unwrap());
        assert_eq!(extract_bearer_token(&headers), Some("my_token"));
    }

    #[test]
    fn test_extract_bearer_token_case_insensitive() {
        for value in ["bearer my_token", "BEARER my_token", "BeArEr my_token"] {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", value.parse().unwrap());
            assert_eq!(extract_bearer_token(&headers), Some("my_token"));
        }
    }

    #[test]
    fn test_extract_bearer_token_missing_header() {
        assert_eq!(extract_bearer_token(&HeaderMap::new()), None);
    }

    #[test]
    fn test_extract_bearer_token_wrong_scheme() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Basic xyz".parse().unwrap());
        assert_eq!(extract_bearer_token(&headers), None);
    }

    #[test]
    fn test_extract_bearer_token_missing_token() {
        for value in ["Bearer ", "Bearer"] {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", value.parse().unwrap());
            assert_eq!(extract_bearer_token(&headers), None);
        }
    }
}
