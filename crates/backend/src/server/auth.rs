//! 密码认证模块。密码直接当 Bearer token。
//!
//! 决策 7：密码 = Bearer token。不用 JWT 或 session，整个系统只有一把钥匙。
//! - 不给密码就用默认值 `pleasechangethepassword`，启动时在 stderr 提醒改掉。
//! - 每个 request 的 Authorization: Bearer <password> header 里的密码就是这个。
//! - 常量时间比较，防止时序侧信道泄露密码内容。

use axum::http::HeaderMap;
use subtle::ConstantTimeEq;

/// 未配置密码时的默认值。众所周知的固定串——只适合本机/内网试用，
/// 对外部署必须显式设置密码（启动时会在 stderr 提醒）。
pub const DEFAULT_PASSWORD: &str = "pleasechangethepassword";

/// 密码认证配置。常量时间比较防时序侧信道。
#[derive(Clone)]
pub struct AuthConfig {
    password: String,
}

impl AuthConfig {
    pub fn new(password: String) -> Self {
        Self { password }
    }

    /// 常量时间验证 Bearer token。
    ///
    /// 长度不等时跟自己比：比较耗时始终只取决于存储值的长度，
    /// 不让攻击者通过响应时间推断有没有猜中。
    pub fn verify(&self, presented: &str) -> bool {
        let password_bytes = self.password.as_bytes();
        let presented_bytes = presented.as_bytes();
        let len_eq = password_bytes.len() == presented_bytes.len();
        let target = if len_eq { presented_bytes } else { password_bytes };
        let data_eq: bool = password_bytes.ct_eq(target).into();
        len_eq && data_eq
    }
}

/// Axum middleware：校验 Authorization: Bearer <token> header。
///
/// 三种失败情况（缺 header、格式错、密码错）都返回同样的 401，不暴露细节。
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
