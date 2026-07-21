//! 系统代理单一真源：设置保存/启动初始化时写入，shell env 注入与
//! 各 reqwest 出网点（本地反代、图片反代、更新检查、技能下载、
//! MCP http/sse transport、Hook / Cron HTTP、网络自检、Image.url 读取）按需读取。
//! reqwest 侧与 shell env 共用 NO_PROXY_DEFAULT：环回地址永不走代理。
//! 凭据绝不进入日志与错误信息（只输出 host:port）。

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::Value;
use std::net::Ipv6Addr;
use std::sync::{OnceLock, RwLock};

const SYSTEM_PROXY_TYPE_HTTP: &str = "http";
pub const SYSTEM_PROXY_TYPE_SOCKS5: &str = "socks5";
const NO_PROXY_DEFAULT: &str = "localhost,127.0.0.1,::1";

#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SystemProxyConfig {
    pub enabled: bool,
    #[serde(rename = "type")]
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

impl SystemProxyConfig {
    fn scheme(&self) -> &'static str {
        if self.proxy_type == SYSTEM_PROXY_TYPE_SOCKS5 {
            "socks5h"
        } else {
            "http"
        }
    }

    fn proxy_url(&self) -> String {
        let credentials = if self.username.is_empty() && self.password.is_empty() {
            String::new()
        } else {
            format!(
                "{}:{}@",
                utf8_percent_encode(&self.username, NON_ALPHANUMERIC),
                utf8_percent_encode(&self.password, NON_ALPHANUMERIC)
            )
        };
        format!(
            "{}://{}{}:{}",
            self.scheme(),
            credentials,
            self.url_host(),
            self.port
        )
    }

    fn display_target(&self) -> String {
        format!("{}:{}", self.url_host(), self.port)
    }

    fn url_host(&self) -> String {
        let host = self.host.trim();
        if host.starts_with('[') && host.ends_with(']') {
            return host.to_string();
        }
        if host.parse::<Ipv6Addr>().is_ok() {
            return format!("[{host}]");
        }
        host.to_string()
    }
}

fn host_is_valid(host: &str) -> bool {
    let host = host.trim();
    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '/' | '\\' | '@' | '#' | '?' | '%'))
    {
        return false;
    }
    if host.starts_with('[') || host.ends_with(']') {
        return host
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .is_some_and(|value| value.parse::<Ipv6Addr>().is_ok());
    }
    !host.contains(':') || host.parse::<Ipv6Addr>().is_ok()
}

#[derive(Clone, Debug, PartialEq)]
enum ProxyMode {
    Disabled,
    Enabled(SystemProxyConfig),
    Invalid(String),
}

#[derive(Clone, Debug)]
struct ProxySnapshot {
    revision: u64,
    mode: ProxyMode,
}

#[derive(Clone)]
struct CachedAsyncClient {
    revision: u64,
    client: reqwest::Client,
}

struct SystemProxyState {
    snapshot: RwLock<ProxySnapshot>,
    async_client: RwLock<Option<CachedAsyncClient>>,
}

fn state() -> &'static SystemProxyState {
    static STATE: OnceLock<SystemProxyState> = OnceLock::new();
    STATE.get_or_init(|| SystemProxyState {
        snapshot: RwLock::new(ProxySnapshot {
            revision: 0,
            mode: ProxyMode::Disabled,
        }),
        async_client: RwLock::new(None),
    })
}

fn parse_proxy_mode(raw: Option<&Value>) -> ProxyMode {
    let Some(raw) = raw else {
        return ProxyMode::Disabled;
    };
    let mut config = match serde_json::from_value::<SystemProxyConfig>(raw.clone()) {
        Ok(config) => config,
        Err(_) => return ProxyMode::Invalid("应用代理配置格式无效".to_string()),
    };
    if !config.enabled {
        return ProxyMode::Disabled;
    }
    config.host = config.host.trim().to_string();
    config.username = config.username.trim().to_string();
    if !matches!(
        config.proxy_type.as_str(),
        SYSTEM_PROXY_TYPE_HTTP | SYSTEM_PROXY_TYPE_SOCKS5
    ) || config.port == 0
        || !host_is_valid(&config.host)
    {
        return ProxyMode::Invalid("应用代理已启用，但地址、端口或类型无效".to_string());
    }
    match build_proxy(&config) {
        Ok(_) => ProxyMode::Enabled(config),
        Err(error) => ProxyMode::Invalid(error),
    }
}

pub fn set_config(raw: Option<&Value>) {
    let mode = parse_proxy_mode(raw);
    let mut snapshot = state()
        .snapshot
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // 设置保存每次都会刷新代理状态；只有配置真实变化才 bump revision，
    // 否则按 revision 重建的消费方（client 缓存、MCP 运行时）会被无关保存误伤。
    if snapshot.mode == mode {
        return;
    }
    snapshot.revision = snapshot.revision.wrapping_add(1);
    snapshot.mode = mode;
    drop(snapshot);
    *state()
        .async_client
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

/// 当前代理配置的变更计数。长驻连接（如 MCP client）在建立时记录，
/// 复用前与当前值比较即可感知代理配置变更并重建。
/// 直接在读锁下拷贝 u64，不克隆整个快照（本函数在 MCP 命令路径上高频调用）。
pub fn revision() -> u64 {
    state()
        .snapshot
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .revision
}

fn current_snapshot() -> ProxySnapshot {
    state()
        .snapshot
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn shell_proxy_envs_for_mode(mode: &ProxyMode) -> Result<Vec<(String, String)>, String> {
    let config = match mode {
        ProxyMode::Disabled => return Ok(Vec::new()),
        ProxyMode::Invalid(error) => return Err(error.clone()),
        ProxyMode::Enabled(config) => config,
    };
    let proxy_url = config.proxy_url();
    let mut envs = Vec::with_capacity(8);
    for key in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        envs.push((key.to_string(), proxy_url.clone()));
    }
    for key in ["NO_PROXY", "no_proxy"] {
        envs.push((key.to_string(), NO_PROXY_DEFAULT.to_string()));
    }
    Ok(envs)
}

pub fn shell_proxy_envs() -> Result<Vec<(String, String)>, String> {
    shell_proxy_envs_for_mode(&current_snapshot().mode)
}

fn build_proxy(config: &SystemProxyConfig) -> Result<reqwest::Proxy, String> {
    reqwest::Proxy::all(config.proxy_url())
        // 环回地址豁免须与 shell env 注入的 NO_PROXY 一致，
        // 否则本地上游（如 127.0.0.1 的 MCP server）会被错误送进代理。
        .map(|proxy| proxy.no_proxy(reqwest::NoProxy::from_string(NO_PROXY_DEFAULT)))
        .map_err(|_| format!("应用代理地址无效：{}", config.display_target()))
}

fn async_client_builder_for_mode(mode: &ProxyMode) -> Result<reqwest::ClientBuilder, String> {
    let builder = reqwest::Client::builder().no_proxy();
    match mode {
        ProxyMode::Disabled => Ok(builder),
        ProxyMode::Invalid(error) => Err(error.clone()),
        ProxyMode::Enabled(config) => Ok(builder.proxy(build_proxy(config)?)),
    }
}

fn blocking_client_builder_for_mode(
    mode: &ProxyMode,
) -> Result<reqwest::blocking::ClientBuilder, String> {
    let builder = reqwest::blocking::Client::builder().no_proxy();
    match mode {
        ProxyMode::Disabled => Ok(builder),
        ProxyMode::Invalid(error) => Err(error.clone()),
        ProxyMode::Enabled(config) => Ok(builder.proxy(build_proxy(config)?)),
    }
}

pub fn cached_client() -> Result<reqwest::Client, String> {
    let snapshot = current_snapshot();
    {
        let cached = state()
            .async_client
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cached) = cached
            .as_ref()
            .filter(|client| client.revision == snapshot.revision)
        {
            return Ok(cached.client.clone());
        }
    }
    let client = async_client_builder_for_mode(&snapshot.mode)?
        .build()
        .map_err(|_| "创建应用代理 HTTP 客户端失败".to_string())?;
    let current_revision = current_snapshot().revision;
    if current_revision == snapshot.revision {
        *state()
            .async_client
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(CachedAsyncClient {
            revision: snapshot.revision,
            client: client.clone(),
        });
    }
    Ok(client)
}

pub fn client_builder() -> Result<reqwest::ClientBuilder, String> {
    async_client_builder_for_mode(&current_snapshot().mode)
}

pub fn blocking_client_builder() -> Result<reqwest::blocking::ClientBuilder, String> {
    blocking_client_builder_for_mode(&current_snapshot().mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(value: Value) -> SystemProxyConfig {
        match parse_proxy_mode(Some(&value)) {
            ProxyMode::Enabled(config) => config,
            mode => panic!("expected enabled proxy config, got {mode:?}"),
        }
    }

    #[test]
    fn proxy_url_http_without_credentials() {
        let parsed = config(json!({
            "enabled": true, "type": "http", "host": "proxy.local", "port": 8080,
            "username": "", "password": ""
        }));
        assert_eq!(parsed.proxy_url(), "http://proxy.local:8080");
    }

    #[test]
    fn proxy_url_socks5_uses_socks5h_and_percent_encodes_credentials() {
        let parsed = config(json!({
            "enabled": true, "type": "socks5", "host": "10.0.0.1", "port": 1080,
            "username": "user@corp", "password": "p@ss:w0rd"
        }));
        assert_eq!(
            parsed.proxy_url(),
            "socks5h://user%40corp:p%40ss%3Aw0rd@10.0.0.1:1080"
        );
    }

    #[test]
    fn proxy_url_brackets_ipv6_hosts() {
        let parsed = config(json!({
            "enabled": true, "type": "http", "host": "::1", "port": 8080
        }));
        assert_eq!(parsed.proxy_url(), "http://[::1]:8080");
    }

    #[test]
    fn invalid_enabled_configs_fail_instead_of_becoming_disabled() {
        assert!(matches!(
            parse_proxy_mode(Some(&json!({
                "enabled": false, "type": "http", "host": "proxy.local", "port": 8080
            }))),
            ProxyMode::Disabled
        ));
        for value in [
            json!({
            "enabled": true, "type": "http", "host": "", "port": 8080
            }),
            json!({
            "enabled": true, "type": "http", "host": "proxy.local", "port": 0
            }),
            json!({
            "enabled": true, "type": "http", "host": "bad host/@", "port": 8080
            }),
            json!({
                "enabled": true, "type": "https", "host": "proxy.local", "port": 8080
            }),
        ] {
            let mode = parse_proxy_mode(Some(&value));
            assert!(matches!(mode, ProxyMode::Invalid(_)));
            assert!(async_client_builder_for_mode(&mode).is_err());
            assert!(blocking_client_builder_for_mode(&mode).is_err());
            assert!(shell_proxy_envs_for_mode(&mode).is_err());
        }
    }

    #[test]
    fn proxy_mode_equality_drives_set_config_dedupe() {
        let config = json!({
            "enabled": true, "type": "http", "host": "proxy.local", "port": 8080
        });
        // set_config 以 ProxyMode 相等与否决定是否 bump revision：
        // 同配置重复保存必须判等，任一字段变化必须判不等。
        assert_eq!(
            parse_proxy_mode(Some(&config)),
            parse_proxy_mode(Some(&config))
        );
        let changed_port = json!({
            "enabled": true, "type": "http", "host": "proxy.local", "port": 8081
        });
        assert_ne!(
            parse_proxy_mode(Some(&config)),
            parse_proxy_mode(Some(&changed_port))
        );
        assert_eq!(parse_proxy_mode(None), ProxyMode::Disabled);
    }

    #[test]
    fn shell_proxy_envs_cover_all_variables() {
        let mode = parse_proxy_mode(Some(&json!({
            "enabled": true, "type": "socks5", "host": "127.0.0.2", "port": 1080,
            "username": "", "password": ""
        })));
        let envs = shell_proxy_envs_for_mode(&mode).expect("proxy envs");
        let map: std::collections::HashMap<_, _> = envs.iter().cloned().collect();
        assert_eq!(envs.len(), 8);
        for key in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            assert_eq!(
                map.get(key).map(String::as_str),
                Some("socks5h://127.0.0.2:1080")
            );
        }
        for key in ["NO_PROXY", "no_proxy"] {
            assert_eq!(map.get(key).map(String::as_str), Some(NO_PROXY_DEFAULT));
        }
        assert!(shell_proxy_envs_for_mode(&ProxyMode::Disabled)
            .expect("disabled proxy envs")
            .is_empty());
    }
}
