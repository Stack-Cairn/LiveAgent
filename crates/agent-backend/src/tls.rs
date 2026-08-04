// TLS 支持模块
//
// 验证的 axum-server 0.7 RustlsConfig::from_pem_file 签名：
// 来源: https://docs.rs/axum-server/0.7/axum_server/tls_rustls/struct.RustlsConfig.html
//
// pub async fn from_pem_file(
//     cert: impl AsRef<Path>,
//     key: impl AsRef<Path>,
// ) -> Result<Self>  // std::io::Result<RustlsConfig>

use std::path::PathBuf;
use axum_server::tls_rustls::RustlsConfig;

/// TLS 证书和私钥的文件路径
#[derive(Debug, Clone)]
pub struct TlsPaths {
    pub cert: PathBuf,
    pub key: PathBuf,
}

/// 从文件加载 TLS 配置
///
/// # Arguments
/// * `paths` - 包含证书和私钥路径的 TlsPaths
///
/// # Returns
/// 成功返回 RustlsConfig，失败返回包含文件路径和问题说明的中文错误信息
///
/// # Errors
/// 当证书或私钥文件不存在或无法读取时返回错误
pub async fn load(paths: &TlsPaths) -> Result<RustlsConfig, String> {
    // 通过 from_pem_file 加载证书和私钥。
    // 若文件不存在，std::io::Result 会返回 NotFound 错误，
    // 需要转换为用户友好的中文错误消息，包含具体是哪个文件有问题。
    RustlsConfig::from_pem_file(&paths.cert, &paths.key)
        .await
        .map_err(|e| {
            // 根据错误类型判断是证书还是私钥文件的问题
            // NotFound (kind == io::ErrorKind::NotFound) 时使用路径信息
            let problem = match e.kind() {
                std::io::ErrorKind::NotFound => {
                    // 尝试分辨是哪个文件不存在（通过文件系统检查）
                    let cert_exists = paths.cert.exists();
                    let key_exists = paths.key.exists();
                    if !cert_exists {
                        format!("证书文件不存在: {}", paths.cert.display())
                    } else if !key_exists {
                        format!("私钥文件不存在: {}", paths.key.display())
                    } else {
                        // 双重检查都存在但还是报错，可能是权限问题
                        format!("无法读取 TLS 文件: {}", e)
                    }
                }
                std::io::ErrorKind::PermissionDenied => {
                    format!("权限不足，无法读取 TLS 文件: {}", e)
                }
                _ => {
                    format!("加载 TLS 文件失败: {}", e)
                }
            };
            problem
        })
}

/// 从命令行参数解析 TLS 路径
///
/// # Arguments
/// * `cert` - 证书文件路径（可选）
/// * `key` - 私钥文件路径（可选）
///
/// # Returns
/// - 若两个都提供: `Ok(Some(TlsPaths))`
/// - 若两个都不提供: `Ok(None)`（纯 HTTP 模式）
/// - 若只提供一个: `Err` 并告知用户必须同时提供
///
/// # Errors
/// 只提供其中一个参数时返回错误
pub fn from_args(
    cert: Option<PathBuf>,
    key: Option<PathBuf>,
) -> Result<Option<TlsPaths>, String> {
    match (cert, key) {
        (Some(cert), Some(key)) => {
            // 两个都给，返回 TlsPaths
            Ok(Some(TlsPaths { cert, key }))
        }
        (None, None) => {
            // 两个都不给，纯 HTTP 模式
            Ok(None)
        }
        (Some(cert_path), None) => {
            // 只给了证书，缺少私钥
            Err(format!(
                "--tls-cert 和 --tls-key 必须同时提供。已提供证书: {}，缺少私钥文件路径。",
                cert_path.display()
            ))
        }
        (None, Some(key_path)) => {
            // 只给了私钥，缺少证书
            Err(format!(
                "--tls-cert 和 --tls-key 必须同时提供。已提供私钥: {}，缺少证书文件路径。",
                key_path.display()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_from_args_both_provided() {
        let cert = Some(PathBuf::from("/path/to/cert.pem"));
        let key = Some(PathBuf::from("/path/to/key.pem"));

        let result = from_args(cert.clone(), key.clone());

        assert!(result.is_ok());
        let paths = result.unwrap().unwrap();
        assert_eq!(paths.cert, PathBuf::from("/path/to/cert.pem"));
        assert_eq!(paths.key, PathBuf::from("/path/to/key.pem"));
    }

    #[test]
    fn test_from_args_neither_provided() {
        let cert = None;
        let key = None;

        let result = from_args(cert, key);

        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn test_from_args_only_cert_provided() {
        let cert = Some(PathBuf::from("/path/to/cert.pem"));
        let key = None;

        let result = from_args(cert, key);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("--tls-cert 和 --tls-key 必须同时提供"));
        assert!(err.contains("缺少私钥文件路径"));
    }

    #[test]
    fn test_from_args_only_key_provided() {
        let cert = None;
        let key = Some(PathBuf::from("/path/to/key.pem"));

        let result = from_args(cert, key);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("--tls-cert 和 --tls-key 必须同时提供"));
        assert!(err.contains("缺少证书文件路径"));
    }

    #[tokio::test]
    async fn test_load_nonexistent_cert_file() {
        let paths = TlsPaths {
            cert: PathBuf::from("/nonexistent/cert.pem"),
            key: PathBuf::from("/nonexistent/key.pem"),
        };

        let result = load(&paths).await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        // 错误消息应该说明是哪个文件（或两个文件）不存在
        assert!(
            err.contains("不存在") || err.contains("无法读取"),
            "Error message should explain file issue: {}",
            err
        );
        // 错误消息中应该包含路径信息
        assert!(err.contains("nonexistent") || err.contains("pem"));
    }
}
