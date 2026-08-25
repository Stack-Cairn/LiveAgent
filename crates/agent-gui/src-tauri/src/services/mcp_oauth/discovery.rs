//! OAuth 发现链（docs/design/mcp-oauth.md §4.1/§4.3）。
//!
//! 401 `WWW-Authenticate` 的 `resource_metadata`（RFC 9728）→ PRM
//! `authorization_servers[0]` → RFC 8414 AS 元数据（路径感知候选 + OIDC
//! fallback）；全程拿不到时退 2025-03-26 旧规范（AS = server origin，缺元数据
//! 用默认 `/authorize` `/token` `/register` 端点）。

use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE, WWW_AUTHENTICATE};
use reqwest::StatusCode;
use reqwest::Url;
use serde::Deserialize;
use serde_json::json;

/// 发现结果：授权流所需的全部端点与 scope 线索。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Discovered {
    /// RFC 8707 resource 参数值（规范化 server URL）。
    pub resource: String,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    /// PRM `scopes_supported`（授权请求的默认 scope 来源）。
    pub scopes_supported: Vec<String>,
    /// 走了旧规范默认端点（未取到任何 AS 元数据）。
    pub legacy_default_endpoints: bool,
}

#[derive(Debug, Default, Deserialize)]
struct ProtectedResourceMetadata {
    #[serde(default)]
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AuthServerMetadata {
    #[serde(default)]
    issuer: Option<String>,
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    registration_endpoint: Option<String>,
    #[serde(default)]
    code_challenge_methods_supported: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

/// MCP 规范的 canonical resource：小写 scheme/host、去默认端口、去 fragment、
/// 根路径省略尾斜杠。`Url` 序列化天然覆盖前三项。
pub fn canonical_resource(raw: &str) -> Result<String, String> {
    let mut url =
        Url::parse(raw.trim()).map_err(|e| format!("MCP server URL 无效：{raw}（{e}）"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("MCP server URL 必须是 http/https：{raw}"));
    }
    url.set_fragment(None);
    let mut out = url.to_string();
    if url.path() == "/" && url.query().is_none() {
        out.truncate(out.trim_end_matches('/').len());
    }
    Ok(out)
}

/// 解析 `WWW-Authenticate` 挑战里的 `resource_metadata` auth-param（RFC 9728 §5.1）。
pub fn parse_resource_metadata_param(header: &str) -> Option<String> {
    let lower = header.to_ascii_lowercase();
    let key_at = lower.find("resource_metadata")?;
    let rest = &header[key_at + "resource_metadata".len()..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    if let Some(quoted) = rest.strip_prefix('"') {
        let end = quoted.find('"')?;
        let value = quoted[..end].trim();
        return (!value.is_empty()).then(|| value.to_string());
    }
    let end = rest
        .find([',', ' ', '\t'])
        .unwrap_or(rest.len());
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// 未带凭据探测 MCP endpoint，收集 401 的 `WWW-Authenticate` resource_metadata。
/// 非 401（甚至成功）返回 None——由上层走 well-known 推导。
fn probe_resource_metadata_url(client: &Client, server_url: &Url) -> Option<String> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "clientInfo": { "name": "LiveAgent", "version": crate::app_version() },
            "capabilities": {}
        }
    });
    let resp = client
        .post(server_url.clone())
        .header(ACCEPT, "application/json, text/event-stream")
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .ok()?;
    if resp.status() != StatusCode::UNAUTHORIZED {
        return None;
    }
    resp.headers()
        .get_all(WWW_AUTHENTICATE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(parse_resource_metadata_param)
}

fn origin_of(url: &Url) -> Url {
    let mut origin = url.clone();
    origin.set_path("/");
    origin.set_query(None);
    origin.set_fragment(None);
    origin
}

/// RFC 9728 well-known 候选：带路径的 server 先试路径插入形式，再试根形式。
pub fn prm_well_known_candidates(server_url: &Url) -> Vec<String> {
    let mut out = Vec::new();
    let origin = origin_of(server_url).to_string();
    let base = origin.trim_end_matches('/');
    let path = server_url.path().trim_end_matches('/');
    if !path.is_empty() {
        out.push(format!("{base}/.well-known/oauth-protected-resource{path}"));
    }
    out.push(format!("{base}/.well-known/oauth-protected-resource"));
    out
}

/// RFC 8414 + OIDC 的 AS 元数据候选序列（设计 §4.3）。
pub fn as_metadata_candidates(issuer: &str) -> Vec<String> {
    let Ok(url) = Url::parse(issuer.trim()) else {
        return Vec::new();
    };
    if !matches!(url.scheme(), "http" | "https") {
        return Vec::new();
    }
    let origin = origin_of(&url).to_string();
    let base = origin.trim_end_matches('/').to_string();
    let path = url.path().trim_end_matches('/');

    if path.is_empty() {
        vec![
            format!("{base}/.well-known/oauth-authorization-server"),
            format!("{base}/.well-known/openid-configuration"),
        ]
    } else {
        vec![
            format!("{base}/.well-known/oauth-authorization-server{path}"),
            format!("{base}/.well-known/openid-configuration{path}"),
            format!("{base}{path}/.well-known/openid-configuration"),
        ]
    }
}

fn fetch_json<T: for<'de> Deserialize<'de>>(client: &Client, url: &str) -> Result<T, String> {
    let resp = client
        .get(url)
        .header(ACCEPT, "application/json")
        .send()
        .map_err(|e| format!("请求 {url} 失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("请求 {url} 返回 {}", resp.status()));
    }
    let body = resp
        .text()
        .map_err(|e| format!("读取 {url} 响应失败：{e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("解析 {url} JSON 失败：{e}"))
}

fn fetch_as_metadata(client: &Client, issuer: &str) -> Option<AuthServerMetadata> {
    as_metadata_candidates(issuer)
        .iter()
        .find_map(|candidate| fetch_json::<AuthServerMetadata>(client, candidate).ok())
}

/// 完整发现链。`server_url_raw` 为配置里的 MCP endpoint。
pub fn discover(client: &Client, server_url_raw: &str) -> Result<Discovered, String> {
    let resource = canonical_resource(server_url_raw)?;
    let server_url = Url::parse(&resource).map_err(|e| format!("URL 解析失败：{e}"))?;

    // 1) PRM：优先 401 挑战里的 resource_metadata，退 well-known 推导。
    let mut prm_urls: Vec<String> = Vec::new();
    if let Some(from_challenge) = probe_resource_metadata_url(client, &server_url) {
        prm_urls.push(from_challenge);
    }
    prm_urls.extend(prm_well_known_candidates(&server_url));

    let prm = prm_urls
        .iter()
        .find_map(|url| fetch_json::<ProtectedResourceMetadata>(client, url).ok());

    // 2) issuer：PRM 声明优先，拿不到退旧规范（AS = server origin）。
    let (issuer, scopes_supported, legacy_issuer) = match prm {
        Some(doc) if !doc.authorization_servers.is_empty() => {
            (doc.authorization_servers[0].clone(), doc.scopes_supported, false)
        }
        Some(doc) => {
            let origin = origin_of(&server_url).to_string();
            (
                origin.trim_end_matches('/').to_string(),
                doc.scopes_supported,
                true,
            )
        }
        None => {
            let origin = origin_of(&server_url).to_string();
            (origin.trim_end_matches('/').to_string(), Vec::new(), true)
        }
    };

    // 3) AS 元数据；全败且处于旧规范分支时用默认端点。
    match fetch_as_metadata(client, &issuer) {
        Some(meta) => {
            // MCP 规范要求确认 S256 支持；字段缺失（旧 AS）放行，声明了就必须包含。
            if !meta.code_challenge_methods_supported.is_empty()
                && !meta
                    .code_challenge_methods_supported
                    .iter()
                    .any(|m| m == "S256")
            {
                return Err(format!(
                    "授权服务器 {issuer} 不支持 PKCE S256（code_challenge_methods_supported={:?}），MCP 规范要求 S256",
                    meta.code_challenge_methods_supported
                ));
            }
            let scopes = if scopes_supported.is_empty() {
                meta.scopes_supported
            } else {
                scopes_supported
            };
            Ok(Discovered {
                resource,
                issuer: meta.issuer.unwrap_or(issuer),
                authorization_endpoint: meta.authorization_endpoint,
                token_endpoint: meta.token_endpoint,
                registration_endpoint: meta.registration_endpoint,
                scopes_supported: scopes,
                legacy_default_endpoints: false,
            })
        }
        None if legacy_issuer => Ok(Discovered {
            resource,
            authorization_endpoint: format!("{issuer}/authorize"),
            token_endpoint: format!("{issuer}/token"),
            registration_endpoint: Some(format!("{issuer}/register")),
            issuer,
            scopes_supported,
            legacy_default_endpoints: true,
        }),
        None => Err(format!(
            "无法获取授权服务器元数据：{issuer}（已尝试 {:?}）",
            as_metadata_candidates(&issuer)
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_resource_normalizes_case_port_and_root_slash() {
        assert_eq!(
            canonical_resource("HTTPS://MCP.Example.COM:443/").expect("root"),
            "https://mcp.example.com"
        );
        assert_eq!(
            canonical_resource("https://mcp.example.com:8443/mcp#frag").expect("path"),
            "https://mcp.example.com:8443/mcp"
        );
        assert_eq!(
            canonical_resource(" https://mcp.example.com/mcp/ ").expect("trim"),
            "https://mcp.example.com/mcp/"
        );
        assert!(canonical_resource("ftp://x.example.com").is_err());
        assert!(canonical_resource("not a url").is_err());
    }

    #[test]
    fn parses_resource_metadata_from_challenge_variants() {
        assert_eq!(
            parse_resource_metadata_param(
                r#"Bearer realm="mcp", resource_metadata="https://s.example.com/.well-known/oauth-protected-resource""#
            ),
            Some("https://s.example.com/.well-known/oauth-protected-resource".to_string())
        );
        assert_eq!(
            parse_resource_metadata_param(
                "Bearer resource_metadata=https://s.example.com/prm, error=\"invalid_token\""
            ),
            Some("https://s.example.com/prm".to_string())
        );
        assert_eq!(
            parse_resource_metadata_param(r#"Bearer RESOURCE_METADATA="https://s.example.com/x""#),
            Some("https://s.example.com/x".to_string())
        );
        assert_eq!(parse_resource_metadata_param("Bearer realm=\"mcp\""), None);
        assert_eq!(parse_resource_metadata_param("Bearer resource_metadata=\"\""), None);
    }

    #[test]
    fn prm_candidates_prefer_path_insertion() {
        let url = Url::parse("https://mcp.example.com/v1/mcp").expect("url");
        assert_eq!(
            prm_well_known_candidates(&url),
            vec![
                "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp".to_string(),
                "https://mcp.example.com/.well-known/oauth-protected-resource".to_string(),
            ]
        );

        let root = Url::parse("https://mcp.example.com/").expect("url");
        assert_eq!(
            prm_well_known_candidates(&root),
            vec!["https://mcp.example.com/.well-known/oauth-protected-resource".to_string()]
        );
    }

    #[test]
    fn as_candidates_cover_pathless_and_tenant_issuers() {
        assert_eq!(
            as_metadata_candidates("https://auth.example.com"),
            vec![
                "https://auth.example.com/.well-known/oauth-authorization-server".to_string(),
                "https://auth.example.com/.well-known/openid-configuration".to_string(),
            ]
        );
        assert_eq!(
            as_metadata_candidates("https://auth.example.com/tenant1"),
            vec![
                "https://auth.example.com/.well-known/oauth-authorization-server/tenant1"
                    .to_string(),
                "https://auth.example.com/.well-known/openid-configuration/tenant1".to_string(),
                "https://auth.example.com/tenant1/.well-known/openid-configuration".to_string(),
            ]
        );
        assert!(as_metadata_candidates("::bad::").is_empty());
    }
}
