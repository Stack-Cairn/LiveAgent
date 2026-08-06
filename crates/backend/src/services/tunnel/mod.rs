//! 本机隧道:把工作机上的 dev server 暴露成一个可访问的 HTTP 端口。
//!
//! ## 与旧实现的区别
//!
//! 旧实现里隧道是「桌面端 → 公网 Gateway」的注册协议:端口注册到 Gateway,
//! Gateway 开 `/t/{slug}` 公开反代,把每个 HTTP 请求/WS 帧拆成 protobuf 帧
//! 跨中继来回搬,再重写 HTML 属性、CSS `url()`、注入 shim、改 CSP
//! (`tunnel_rewrite.go`,约 1000 行)才能让子路径下的页面正常工作。
//!
//! 新架构里后端**就在**那台工作机上,且自己就是网络入口。于是:
//!
//! | 旧 | 新 |
//! |---|---|
//! | slug 注册协议 | 没有。id 本地生成,不需要跟谁协商 |
//! | 跨中继 protobuf 分帧 | 没有。后端直接 TCP 连 `localhost:5173` |
//! | 子路径 `/t/{slug}/` + 1000 行重写 | **一隧道一端口,路径 1:1**,重写代码为 0 |
//! | 公开无认证入口 | 首访 token → cookie(见 `TunnelAccess`) |
//!
//! **一隧道一端口是「消除特殊情况」而不是省事**:挂子路径时 dev server 吐的
//! `<script src="/assets/main.js">` 会打到隧道之外,所以必须重写它发出的每一个
//! URL——HTML 属性、CSS、以及运行时的 fetch/XHR/WebSocket。独立端口下这个
//! 绝对路径本来就是对的,整类问题不存在。
//!
//! ## 本模块的边界
//!
//! 这里只有**状态**:规格的增删改查、过期清理、健康探测结果。真正监听端口、
//! 转发 HTTP/WS 的数据面在 `backend`——它需要 axum,而 backend 不能
//! 碰 axum(会把 HTTP 服务器拖进核心库)。两者靠 `TunnelDataPlane` trait 对接。
//!
//! **端口由数据面分配**,不是 store。数据面从 bind 到 close 全程持有那个
//! listener,所以不存在「探测到端口 → 释放 → 稍后重绑时已被抢走」的竞态。
//!
//! 数据流:`TunnelStore` 拥有全部状态 → 发 `tunnel:state` 事件到 EventBus →
//! 前端(webview sink 或 WS sink)收到后重渲染。

pub mod data_plane;
pub mod probe;
pub mod store;

use std::net::IpAddr;

use serde::{Deserialize, Serialize};

pub use store::TunnelStore;

/// 隧道数据面:真正监听端口并反代到目标。
///
/// 定义在这里、实现在 `backend`,是因为 backend 不能依赖 axum
/// (编译期防线只挡 tauri,但把 HTTP 服务器塞进核心库同样是错的)。
///
/// 全部方法都是同步的:`start` 内部用 `std::net::TcpListener::bind` 拿端口,
/// 再 `tokio::spawn` 起服务。同步签名省掉了 async trait 的装箱,也让「端口
/// 分配」这件事有一个明确的、不可能失手的所有者。
pub trait TunnelDataPlane: Send + Sync {
    /// 起一条隧道的监听,返回内核分配的实际端口。
    ///
    /// 同 id 已在跑时必须先停掉旧的——`tunnel_update` 改目标就走这条路。
    fn start(&self, binding: TunnelBinding) -> Result<u16, String>;

    /// 停一条隧道的监听。不存在时是 no-op。
    fn stop(&self, tunnel_id: &str);
}

/// 数据面起一条隧道所需的一切。端口不在里面——那是 `start` 的返回值。
#[derive(Debug, Clone)]
pub struct TunnelBinding {
    pub id: String,
    pub target_url: String,
    pub access_token: String,
}

/// 什么都不做的数据面。用于测试,以及没有网络入口的场景。
pub struct NullDataPlane;

impl TunnelDataPlane for NullDataPlane {
    fn start(&self, _binding: TunnelBinding) -> Result<u16, String> {
        Ok(0)
    }
    fn stop(&self, _tunnel_id: &str) {}
}

/// 隧道状态变更事件。前端订阅它重渲染隧道面板。
///
/// 名字从 `gateway:tunnel-state` 改为 `tunnel:state`——新架构里没有 gateway,
/// 事件名不该再提它。
pub const TUNNEL_STATE_EVENT: &str = "tunnel:state";

/// 单个 agent 最多同时开的隧道数。沿用旧实现的上限。
pub const MAX_TUNNELS: usize = 5;

/// 允许的 TTL 档位(秒)。0 表示不过期。这是 Rust 侧唯一的 TTL 真值来源。
pub const TTL_WHITELIST: [u32; 4] = [0, 900, 3600, 14400];

/// 没传 `ttlSeconds` 时的默认存活时间。
pub const DEFAULT_TTL_SECONDS: u32 = 3600;

/// 校验过的隧道目标。只接受 http + 本机/IP 主机名。
#[derive(Debug, Clone)]
pub struct TunnelTarget {
    pub url: reqwest::Url,
}

/// 校验隧道目标 URL。
///
/// 只放行 `http://` + `localhost`/IP 字面量:隧道是给**本机**服务开的,
/// 允许任意域名等于把后端变成开放代理。这条限制与旧实现逐字一致
/// (`services/tunnel/mod.rs` 的同名函数),前端的 `validateLocalHttpTarget`
/// 也在做同一件事,两边必须同时通过。
pub fn validate_tunnel_target_url(input: &str) -> Result<TunnelTarget, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("targetUrl is required".to_string());
    }
    let mut url = reqwest::Url::parse(trimmed).map_err(|e| format!("invalid targetUrl: {e}"))?;
    if url.scheme() != "http" {
        return Err("targetUrl must use http".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("targetUrl must not include credentials".to_string());
    }
    if url.fragment().is_some() {
        return Err("targetUrl must not include a fragment".to_string());
    }
    let host = url
        .host_str()
        .map(|value| value.trim().to_ascii_lowercase())
        .ok_or_else(|| "targetUrl host is required".to_string())?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host != "localhost" && host.parse::<IpAddr>().is_err() {
        return Err("targetUrl host must be localhost or an IP address".to_string());
    }
    url.set_fragment(None);
    Ok(TunnelTarget { url })
}

/// 创建隧道的入参。JSON key 沿用旧命令的 camelCase(前端现在就在这么传)。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelCreateInput {
    pub target_url: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub ttl_seconds: Option<u32>,
    #[serde(default)]
    pub project_path_key: Option<String>,
}

/// 更新隧道的入参。`ttl_seconds` 缺省表示保持当前过期时间不变。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelUpdateInput {
    pub id: String,
    pub target_url: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub ttl_seconds: Option<u32>,
    #[serde(default)]
    pub project_path_key: Option<String>,
}

/// 一次本地探活的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelHealth {
    pub status: String,
    pub http_status: u32,
    pub error: String,
    pub checked_at: i64,
    pub rtt_ms: u32,
}

impl TunnelHealth {
    pub fn failed(error: String, checked_at: i64) -> Self {
        Self {
            status: "failed".to_string(),
            http_status: 0,
            error,
            checked_at,
            rtt_ms: 0,
        }
    }
}

/// 单条隧道对前端的视图。
///
/// 字段与旧 `TunnelStatusPayload` 保持一致(前端 `TunnelStatus` 类型在读),
/// 但 `slug` 恒为空、`public_path` 恒为 `/`——新架构下入口是端口不是路径。
/// 保留它们是为了不动前端类型定义;阶段 4 前端改造时一并清掉。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub id: String,
    /// 恒为空。旧架构里是 Gateway 分配的公开 slug,新架构没有这个概念。
    pub slug: String,
    pub name: String,
    pub target_url: String,
    /// 恒为 `/`。入口由 `public_url` 给出。
    pub public_path: String,
    /// 本隧道的完整访问地址,含首访 token。这是新增字段。
    pub public_url: String,
    /// 本隧道监听的端口。
    pub port: u16,
    pub created_at: i64,
    pub expires_at: i64,
    pub active_connections: u32,
    pub project_path_key: String,
    pub local: Option<TunnelHealth>,
}

/// 隧道面板的完整快照。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelState {
    pub revision: u64,
    /// 恒为 true:后端自己在跑,不存在「agent 离线」。旧架构里这表示
    /// 桌面端与 Gateway 的链路状态。
    pub agent_online: bool,
    /// 恒为 None:没有中继可言。
    pub relay: Option<TunnelHealth>,
    pub tunnels: Vec<TunnelStatus>,
}

/// 隧道变更失败的结构化错误。`code` 供前端分支,`message` 供展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelError {
    pub code: &'static str,
    pub message: String,
}

impl TunnelError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message)
    }

    pub fn not_found() -> Self {
        Self::new("not_found", "tunnel not found")
    }
}

impl std::fmt::Display for TunnelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::validate_tunnel_target_url;

    #[test]
    fn accepts_localhost_and_ip_http_targets() {
        for value in [
            "http://localhost:3000",
            "http://127.0.0.1:8080/app",
            "http://[::1]:5173",
            "http://192.168.1.5:3000",
            "http://10.0.0.20:8080/app",
            "http://[fd00::1]:5173",
        ] {
            assert!(validate_tunnel_target_url(value).is_ok(), "{value}");
        }
    }

    #[test]
    fn rejects_non_local_and_malformed_targets() {
        for value in [
            "https://localhost:3000",
            "http://example.com",
            "http://user:pass@localhost:3000",
            "http://localhost:3000/#fragment",
            "",
            "   ",
            "not-a-url",
        ] {
            assert!(validate_tunnel_target_url(value).is_err(), "{value}");
        }
    }
}
