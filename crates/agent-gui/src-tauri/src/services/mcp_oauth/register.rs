//! RFC 7591 动态客户端注册（docs/design/mcp-oauth.md §3）。
//!
//! 托管 MCP server 普遍开放 DCR；注册为公共客户端
//! （`token_endpoint_auth_method: "none"`），AS 若坚持发 secret 则按其返回的
//! auth method 使用。注册结果随 TokenRecord 同存 keychain。

use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredClient {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub token_endpoint_auth_method: String,
}

#[derive(Debug, Deserialize)]
struct RegistrationResponse {
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    token_endpoint_auth_method: Option<String>,
}

pub fn dynamic_register(
    client: &Client,
    registration_endpoint: &str,
    redirect_uri: &str,
    scope: Option<&str>,
) -> Result<RegisteredClient, String> {
    let mut body = json!({
        "client_name": "LiveAgent",
        "client_uri": "https://github.com/Stack-Cairn/LiveAgent",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    if let Some(scope) = scope.map(str::trim).filter(|s| !s.is_empty()) {
        body["scope"] = json!(scope);
    }

    let resp = client
        .post(registration_endpoint)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .map_err(|e| format!("动态注册请求失败（{registration_endpoint}）：{e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .map_err(|e| format!("读取动态注册响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!(
            "动态注册被拒绝（{registration_endpoint} 返回 {status}）：{}",
            truncate_for_error(&text)
        ));
    }

    let parsed: RegistrationResponse = serde_json::from_str(&text)
        .map_err(|e| format!("解析动态注册响应失败：{e}（{}）", truncate_for_error(&text)))?;
    let client_id = parsed.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("动态注册响应缺少 client_id".to_string());
    }

    Ok(RegisteredClient {
        client_id,
        client_secret: parsed.client_secret.filter(|s| !s.trim().is_empty()),
        token_endpoint_auth_method: parsed
            .token_endpoint_auth_method
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "none".to_string()),
    })
}

fn truncate_for_error(text: &str) -> String {
    const MAX: usize = 300;
    let trimmed = text.trim();
    if trimmed.len() <= MAX {
        return trimmed.to_string();
    }
    let mut cut = MAX;
    while cut > 0 && !trimmed.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &trimmed[..cut])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_long_error_bodies_at_char_boundary() {
        let long = "错".repeat(200);
        let out = truncate_for_error(&long);
        assert!(out.ends_with('…'));
        assert!(out.len() <= 310);
        assert_eq!(truncate_for_error("  short  "), "short");
    }
}
