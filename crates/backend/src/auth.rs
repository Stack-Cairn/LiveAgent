//! 密码认证模块。密码直接当 Bearer token。
//!
//! 决策 7：密码 = Bearer token。不用 JWT 或 session，整个系统只有一把钥匙。
//! - 启动时要么读配置文件，要么动态生成一个临时密码并打印到终端。
//! - 每个 request 的 Authorization: Bearer <password> header 里的密码就是这个。
//! - 常量时间比较，防止时序侧信道泄露密码长度。

use axum::http::HeaderMap;
use rand::Rng;
use subtle::ConstantTimeEq;

/// 密码认证配置。支持用户密码和内部服务 token。常量时间比较防时序侧信道。
#[derive(Clone)]
pub struct AuthConfig {
    /// 用户密码（管理面/前端）。
    password: String,
    /// 内部服务 token（Node 引擎⇄Rust 后端）。
    internal_token: String,
}

impl AuthConfig {
    /// 新建一个认证配置。传入用户密码和内部 token。
    pub fn new(password: String, internal_token: String) -> Self {
        Self { password, internal_token }
    }

    /// 常量时间验证 Bearer token。接受用户密码或内部 token。
    ///
    /// 返回调用方身份：`Some(CallerIdentity)` 如果验证成功，否则 `None`。
    ///
    /// 长度不等时跟自己比：比较耗时始终只取决于存储值的长度，
    /// 不让攻击者通过响应时间推断有没有猜中。
    ///
    /// 两个 token 一个比不上就试另一个，最后一个才是真正的比较目标。
    pub fn verify_with_identity(&self, presented: &str) -> Option<crate::engine_proxy::CallerIdentity> {
        let password_bytes = self.password.as_bytes();
        let internal_bytes = self.internal_token.as_bytes();
        let presented_bytes = presented.as_bytes();

        // 尝试匹配用户密码。
        let password_match = {
            let len_eq = password_bytes.len() == presented_bytes.len();
            let target = if len_eq { presented_bytes } else { password_bytes };
            let data_eq: bool = password_bytes.ct_eq(target).into();
            len_eq && data_eq
        };

        if password_match {
            return Some(crate::engine_proxy::CallerIdentity::User);
        }

        // 用户密码不匹配，尝试内部 token。
        let internal_match = {
            let len_eq = internal_bytes.len() == presented_bytes.len();
            let target = if len_eq { presented_bytes } else { internal_bytes };
            let data_eq: bool = internal_bytes.ct_eq(target).into();
            len_eq && data_eq
        };

        if internal_match {
            return Some(crate::engine_proxy::CallerIdentity::Internal);
        }

        None
    }

    /// 常量时间验证 Bearer token。接受用户密码或内部 token。
    ///
    /// 长度不等时跟自己比：比较耗时始终只取决于存储值的长度，
    /// 不让攻击者通过响应时间推断有没有猜中。
    ///
    /// 两个 token 一个比不上就试另一个，最后一个才是真正的比较目标。
    pub fn verify(&self, presented: &str) -> bool {
        self.verify_with_identity(presented).is_some()
    }
}

/// 生成至少 32 字符的 URL-safe 随机密码。
///
/// 使用 base62 字符集：0-9, a-z, A-Z。共 62 种。
/// 这种不包含下划线和破折号，但在 HTTP Bearer token 中很常见。
pub fn generate_password() -> String {
    // URL-safe 字符集。64 种是 base64，但我们用更少、更兼容的 base62。
    const CHARSET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const PASSWORD_LEN: usize = 32;

    let mut rng = rand::rng();
    let mut password = String::with_capacity(PASSWORD_LEN);

    for _ in 0..PASSWORD_LEN {
        let idx = rng.random_range(0..CHARSET.len());
        password.push(CHARSET[idx] as char);
    }

    password
}

/// Axum middleware：校验 Authorization: Bearer <token> header，并把调用方身份放入 extensions。
///
/// 三种失败情况（缺 header、格式错、密码错）都返回同样的 401，不暴露细节。
pub async fn require_bearer_with_identity(
    axum::extract::State(state): axum::extract::State<crate::state::AppState>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    let headers = req.headers();

    // 试图从 Authorization header 提取 Bearer token。
    let token = extract_bearer_token(headers).ok_or(axum::http::StatusCode::UNAUTHORIZED)?;

    // 用 auth 配置验证，并获取调用方身份。
    if let Some(identity) = state.auth.verify_with_identity(token) {
        // 把身份信息放入 request extensions。
        req.extensions_mut().insert(identity);
        Ok(next.run(req).await)
    } else {
        Err(axum::http::StatusCode::UNAUTHORIZED)
    }
}

/// Axum middleware：校验 Authorization: Bearer <token> header（兼容性）。
///
/// 三种失败情况（缺 header、格式错、密码错）都返回同样的 401，不暴露细节。
pub async fn require_bearer(
    axum::extract::State(state): axum::extract::State<crate::state::AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    let headers = req.headers();

    // 试图从 Authorization header 提取 Bearer token。
    let token = extract_bearer_token(headers).ok_or(axum::http::StatusCode::UNAUTHORIZED)?;

    // 用 auth 配置验证。
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
    let auth_header = headers.get("authorization")?;
    let auth_str = auth_header.to_str().ok()?;

    // 检查前缀是否是 "Bearer "（case-insensitive）。
    // "Bearer " 至少需要 7 个字符（6 个"Bearer"加至少一个空格）。
    if auth_str.len() < 7 {
        return None;
    }

    let (scheme, rest) = auth_str.split_at(6); // 前 6 个字符是 "Bearer"
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }

    // 跳过 "Bearer" 后面的空格。
    let token = rest.trim_start();
    if token.is_empty() {
        return None;
    }

    Some(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试正确的用户密码被接受。
    #[test]
    fn test_verify_correct_password() {
        let config = AuthConfig::new("my_secret_password".to_string(), "internal_token_123".to_string());
        assert!(config.verify("my_secret_password"));
    }

    /// 测试正确的内部 token 被接受。
    #[test]
    fn test_verify_correct_internal_token() {
        let config = AuthConfig::new("user_password".to_string(), "internal_token_xyz".to_string());
        assert!(config.verify("internal_token_xyz"));
    }

    /// 测试错误的密码和 token 都被拒绝。
    #[test]
    fn test_verify_wrong_both() {
        let config = AuthConfig::new("my_secret_password".to_string(), "internal_token_123".to_string());
        assert!(!config.verify("wrong_password"));
        assert!(!config.verify("wrong_token"));
    }

    /// 测试不同长度的密码也被拒绝，且不泄露长度信息（常量时间）。
    /// 长度比密码短、长、或完全不同，都应该走完整个比较流程。
    #[test]
    fn test_verify_different_length_constant_time() {
        let config = AuthConfig::new("password123".to_string(), "internal_xyz".to_string());

        // 更短的输入。
        assert!(!config.verify("pass"));

        // 更长的输入。
        assert!(!config.verify("password123extra"));

        // 完全不同长度。
        assert!(!config.verify("xyz"));

        // 空字符串。
        assert!(!config.verify(""));
    }

    /// 测试生成的密码长度至少 32。
    #[test]
    fn test_generate_password_length() {
        let pwd = generate_password();
        assert!(pwd.len() >= 32, "Generated password too short: {}", pwd);
    }

    /// 测试生成密码的随机性——多次调用不相同且长度达标。
    #[test]
    fn test_generate_password_randomness() {
        let pwd1 = generate_password();
        let pwd2 = generate_password();

        assert_ne!(pwd1, pwd2, "Generated passwords should be different");
        assert!(pwd1.len() >= 32);
        assert!(pwd2.len() >= 32);
    }

    /// 测试生成密码只包含 URL-safe 字符（base62）。
    #[test]
    fn test_generate_password_charset() {
        let pwd = generate_password();
        for c in pwd.chars() {
            assert!(
                c.is_ascii_alphanumeric(),
                "Generated password contains non-alphanumeric char: {}",
                c
            );
        }
    }

    /// 测试 extract_bearer_token 成功提取。
    #[test]
    fn test_extract_bearer_token_success() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer my_token".parse().unwrap());

        let token = extract_bearer_token(&headers);
        assert_eq!(token, Some("my_token"));
    }

    /// 测试 extract_bearer_token 处理大小写敏感的 Bearer（case-insensitive）。
    #[test]
    fn test_extract_bearer_token_case_insensitive() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "bearer my_token".parse().unwrap());

        let token = extract_bearer_token(&headers);
        assert_eq!(token, Some("my_token"));

        let mut headers = HeaderMap::new();
        headers.insert("authorization", "BEARER my_token".parse().unwrap());

        let token = extract_bearer_token(&headers);
        assert_eq!(token, Some("my_token"));

        let mut headers = HeaderMap::new();
        headers.insert("authorization", "BeArEr my_token".parse().unwrap());

        let token = extract_bearer_token(&headers);
        assert_eq!(token, Some("my_token"));
    }

    /// 测试缺少 Authorization header。
    #[test]
    fn test_extract_bearer_token_missing_header() {
        let headers = HeaderMap::new();
        let token = extract_bearer_token(&headers);
        assert_eq!(token, None);
    }

    /// 测试格式错误——不是 Bearer scheme。
    #[test]
    fn test_extract_bearer_token_wrong_scheme() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Basic xyz".parse().unwrap());

        let token = extract_bearer_token(&headers);
        assert_eq!(token, None);
    }

    /// 测试格式错误——缺少 token（只有 Bearer 和空格）。
    #[test]
    fn test_extract_bearer_token_missing_token() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer ".parse().unwrap());

        let token = extract_bearer_token(&headers);
        assert_eq!(token, None);
    }

    /// 测试格式错误——只有 Bearer，没有空格和 token。
    #[test]
    fn test_extract_bearer_token_bearer_only() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer".parse().unwrap());

        let token = extract_bearer_token(&headers);
        assert_eq!(token, None);
    }

    /// 测试：正确用户密码的 Bearer token 被接受。
    #[test]
    fn test_valid_bearer_token_password() {
        let config = AuthConfig::new("secret123".to_string(), "internal_abc".to_string());
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer secret123".parse().unwrap());

        let token = extract_bearer_token(&headers);
        assert!(token.is_some());
        assert!(config.verify(token.unwrap()));
    }

    /// 测试：正确内部 token 的 Bearer token 被接受。
    #[test]
    fn test_valid_bearer_token_internal() {
        let config = AuthConfig::new("secret123".to_string(), "internal_token_xyz".to_string());
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer internal_token_xyz".parse().unwrap());

        let token = extract_bearer_token(&headers);
        assert!(token.is_some());
        assert!(config.verify(token.unwrap()));
    }

    /// 测试：错误密码和 token 的 Bearer token 都被拒绝。
    #[test]
    fn test_invalid_bearer_token_both_wrong() {
        let config = AuthConfig::new("secret123".to_string(), "internal_abc".to_string());
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer wrong_token".parse().unwrap());

        let token = extract_bearer_token(&headers);
        assert!(token.is_some());
        assert!(!config.verify(token.unwrap()));
    }

    /// 测试：缺少 Authorization header——无法提取 token。
    #[test]
    fn test_missing_header_no_token() {
        let headers = HeaderMap::new();
        let token = extract_bearer_token(&headers);
        assert_eq!(token, None);
    }

    /// 测试：格式错误的 Authorization header——无法提取 token。
    #[test]
    fn test_invalid_header_format_no_token() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Basic xyz".parse().unwrap());

        let token = extract_bearer_token(&headers);
        assert_eq!(token, None);
    }
}
