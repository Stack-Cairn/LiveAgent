//! NAT tunnel agent: the desktop agent owns the desired tunnel set (persisted
//! in the settings DB), publishes it to the gateway, answers webui mutations,
//! probes local targets, and serves the stateless tunnel data plane.

pub mod proxy;
pub mod store;

use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::Duration;

use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::services::gateway::{now_unix_seconds, proto, GatewayController};

pub use proxy::TunnelProxy;
pub use store::TunnelStore;

pub const GATEWAY_TUNNEL_STATE_EVENT: &str = "gateway:tunnel-state";
const TUNNEL_GATEWAY_SUPPORT_TIMEOUT: Duration = Duration::from_secs(10);
const TUNNEL_LOCAL_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub struct TunnelTarget {
    pub url: Url,
}

pub(crate) fn validate_tunnel_target_url(input: &str) -> Result<TunnelTarget, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("targetUrl is required".to_string());
    }
    let mut url = Url::parse(trimmed).map_err(|e| format!("invalid targetUrl: {e}"))?;
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
    // 拒绝 link-local/保留/多播段：tunnel 会把目标暴露到公网，指向云元数据
    // （169.254.169.254 等）或不可路由地址的隧道是 SSRF 扩张面。localhost、
    // 回环与 RFC1918/ULA 私网段是 tunnel 的本职用途（暴露本地/内网服务），
    // 保持放行；网关侧 guard.go 的 enable_web_tunnels 开关是前置授权门。
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_tunnel_target_ip(ip) {
            return Err("targetUrl host is in a blocked IP range".to_string());
        }
    }
    url.set_fragment(None);
    Ok(TunnelTarget { url })
}

/// 判定隧道目标 IP 是否属于禁止暴露的段（与网关 Go 侧 outbound_http.go 的
/// SSRF 黑名单对齐，但保留 loopback 与 RFC1918/ULA：暴露本地服务是 tunnel 本职）。
fn is_blocked_tunnel_target_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_tunnel_target_ipv4(v4),
        IpAddr::V6(v6) => {
            // IPv4-mapped IPv6（::ffff:a.b.c.d）先还原为 IPv4 再走 IPv4 黑名单
            // （与网关 Go 侧 outbound_http.go 的 Unmap() 先例一致）——否则
            // http://[::ffff:169.254.169.254]/ 可绕过元数据段拦截。
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_blocked_tunnel_target_ipv4(v4);
            }
            let segments = v6.segments();
            // ::/128 未指定地址（不可路由）。::1 回环与 127.0.0.1 同语义，是
            // tunnel 的本职暴露目标，保持放行。
            if segments.iter().all(|segment| *segment == 0) {
                return true;
            }
            // fe80::/10 link-local
            if (segments[0] & 0xffc0) == 0xfe80 {
                return true;
            }
            // ff00::/8 多播
            if segments[0] >> 8 == 0xff {
                return true;
            }
            false
        }
    }
}

/// IPv4 黑名单本体:0.0.0.0/8、169.254.0.0/16(云元数据/link-local)、
/// 224.0.0.0/4 多播、240.0.0.0/4 保留(含广播)。loopback 与 RFC1918 放行
/// (暴露本地/内网服务是 tunnel 本职)。
fn is_blocked_tunnel_target_ipv4(v4: Ipv4Addr) -> bool {
    let octets = v4.octets();
    if octets[0] == 0 {
        return true;
    }
    if octets[0] == 169 && octets[1] == 254 {
        return true;
    }
    if (224..=239).contains(&octets[0]) {
        return true;
    }
    octets[0] >= 240
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayTunnelCreateInput {
    pub target_url: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub ttl_seconds: Option<u32>,
    #[serde(default)]
    pub project_path_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayTunnelUpdateInput {
    pub id: String,
    pub target_url: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub ttl_seconds: Option<u32>,
    #[serde(default)]
    pub project_path_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelHealthPayload {
    pub status: String,
    pub http_status: u32,
    pub error: String,
    pub checked_at: i64,
    pub rtt_ms: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatusPayload {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub target_url: String,
    pub public_path: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub active_connections: u32,
    pub project_path_key: String,
    pub local: Option<TunnelHealthPayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatePayload {
    pub revision: u64,
    pub agent_online: bool,
    pub relay: Option<TunnelHealthPayload>,
    pub tunnels: Vec<TunnelStatusPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_unsupported: Option<bool>,
}

impl TunnelStatePayload {
    pub fn offline_empty() -> Self {
        Self {
            revision: 0,
            agent_online: false,
            relay: None,
            tunnels: Vec::new(),
            gateway_unsupported: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TunnelMutationError {
    pub code: &'static str,
    pub message: String,
}

impl TunnelMutationError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message)
    }

    pub(crate) fn not_found() -> Self {
        Self::new("not_found", "tunnel not found")
    }
}

fn tunnel_health_payload_to_proto(health: &TunnelHealthPayload) -> proto::TunnelHealth {
    proto::TunnelHealth {
        status: health.status.clone(),
        http_status: health.http_status,
        error: health.error.clone(),
        checked_at: health.checked_at,
        rtt_ms: health.rtt_ms,
    }
}

pub(crate) fn tunnel_health_payload_from_proto(
    health: &proto::TunnelHealth,
) -> TunnelHealthPayload {
    TunnelHealthPayload {
        status: health.status.clone(),
        http_status: health.http_status,
        error: health.error.clone(),
        checked_at: health.checked_at,
        rtt_ms: health.rtt_ms,
    }
}

impl GatewayController {
    fn tunnel_store(&self) -> &TunnelStore {
        &self.tunnel_store
    }

    pub(crate) fn start_tunnel_store(self: &Arc<Self>) {
        let controller = Arc::clone(self);
        self.tunnel_store_once.call_once(move || {
            tauri::async_runtime::spawn(async move {
                if let Err(error) = controller.tunnel_store().initialize().await {
                    eprintln!("initialize gateway tunnel store failed: {error}");
                }
                controller.emit_local_tunnel_state();
            });
        });
    }

    pub(crate) fn emit_local_tunnel_state(&self) {
        let agent_online = self.status().online;
        match self.tunnel_store().build_local_state(agent_online) {
            Ok(payload) => self.tunnel_store().cache_and_emit(payload),
            Err(error) => eprintln!("build local gateway tunnel state failed: {error}"),
        }
    }

    /// Sweeps expired specs and pushes the full desired tunnel set to the
    /// gateway. Called on WebSocket connect and after every local mutation.
    pub(crate) async fn publish_desired_tunnels(self: &Arc<Self>) -> Result<(), String> {
        let expired = self.tunnel_store().take_expired_specs()?;
        if !expired.is_empty() {
            if let Err(error) = store::delete_tunnel_specs(expired).await {
                eprintln!("delete expired gateway tunnel specs failed: {error}");
            }
        }
        let (tunnels, revision) = self.tunnel_store().desired_state()?;
        // Bump the watch epoch before sending so a snapshot that races the
        // publish cannot be misread as missing.
        let watch_epoch = self.tunnel_store().begin_publish_watch()?;
        self.send_agent_envelope(proto::AgentEnvelope {
            request_id: format!("tunnel-desired-{revision}"),
            timestamp: now_unix_seconds(),
            payload: Some(proto::agent_envelope::Payload::TunnelDesired(
                proto::TunnelDesiredState { tunnels, revision },
            )),
        })
        .await?;
        self.watch_tunnel_gateway_support(watch_epoch);
        Ok(())
    }

    /// Flags the gateway as tunnel-unsupported when no TunnelState snapshot
    /// follows a desired-state publish within the timeout.
    fn watch_tunnel_gateway_support(self: &Arc<Self>, epoch: u64) {
        let controller = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(TUNNEL_GATEWAY_SUPPORT_TIMEOUT).await;
            match controller
                .tunnel_store()
                .mark_gateway_unsupported_if_stale(epoch)
            {
                Ok(true) => controller.emit_local_tunnel_state(),
                Ok(false) => {}
                Err(error) => eprintln!("check gateway tunnel support failed: {error}"),
            }
        });
    }

    pub(crate) fn handle_tunnel_state_snapshot(
        self: &Arc<Self>,
        snapshot: proto::TunnelStateSnapshot,
    ) {
        let controller = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            match controller.tunnel_store().record_snapshot(&snapshot) {
                Ok(changed_specs) => {
                    for spec in changed_specs {
                        if let Err(error) = store::persist_tunnel_spec(spec).await {
                            eprintln!("persist gateway tunnel slug failed: {error}");
                        }
                    }
                }
                Err(error) => eprintln!("record gateway tunnel snapshot failed: {error}"),
            }
        });
    }

    pub(crate) fn handle_tunnel_mutation_request(
        self: &Arc<Self>,
        request_id: String,
        mutation: proto::TunnelMutation,
    ) {
        let controller = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let action = mutation.action.trim().to_ascii_lowercase();
            let requested_tunnel_id = mutation.tunnel_id.trim().to_string();
            let result = match action.as_str() {
                "create" => {
                    controller
                        .tunnel_create_inner(GatewayTunnelCreateInput {
                            target_url: mutation.target_url,
                            name: Some(mutation.name),
                            ttl_seconds: mutation.ttl_seconds,
                            project_path_key: Some(mutation.project_path_key),
                        })
                        .await
                }
                "update" => {
                    controller
                        .tunnel_update_inner(GatewayTunnelUpdateInput {
                            id: mutation.tunnel_id,
                            target_url: mutation.target_url,
                            name: Some(mutation.name),
                            ttl_seconds: mutation.ttl_seconds,
                            project_path_key: Some(mutation.project_path_key),
                        })
                        .await
                }
                "close" => controller.tunnel_close_inner(mutation.tunnel_id).await,
                "check" => {
                    let tunnel_id =
                        (!requested_tunnel_id.is_empty()).then(|| requested_tunnel_id.clone());
                    controller.tunnel_check_inner(tunnel_id).await
                }
                other => Err(TunnelMutationError::new(
                    "invalid_action",
                    format!("unsupported tunnel action: {other}"),
                )),
            };
            let (tunnel_id, error_code, error_message) = match result {
                Ok(tunnel_id) => (tunnel_id, String::new(), String::new()),
                Err(error) => (requested_tunnel_id, error.code.to_string(), error.message),
            };
            // The webui correlates the verdict by this envelope echoing the
            // gateway's request_id verbatim.
            let send_result = controller
                .send_agent_envelope(proto::AgentEnvelope {
                    request_id,
                    timestamp: now_unix_seconds(),
                    payload: Some(proto::agent_envelope::Payload::TunnelMutationResult(
                        proto::TunnelMutationResult {
                            tunnel_id,
                            error_code,
                            error_message,
                        },
                    )),
                })
                .await;
            if let Err(error) = send_result {
                eprintln!("send gateway tunnel mutation result failed: {error}");
            }
        });
    }

    pub fn tunnel_state(&self) -> TunnelStatePayload {
        self.tunnel_store()
            .cached_state()
            .unwrap_or_else(TunnelStatePayload::offline_empty)
    }

    pub async fn tunnel_create(
        self: &Arc<Self>,
        input: GatewayTunnelCreateInput,
    ) -> Result<(), String> {
        self.tunnel_create_inner(input)
            .await
            .map(|_| ())
            .map_err(|error| error.message)
    }

    pub async fn tunnel_update(
        self: &Arc<Self>,
        input: GatewayTunnelUpdateInput,
    ) -> Result<(), String> {
        self.tunnel_update_inner(input)
            .await
            .map(|_| ())
            .map_err(|error| error.message)
    }

    pub async fn tunnel_close(self: &Arc<Self>, tunnel_id: String) -> Result<(), String> {
        self.tunnel_close_inner(tunnel_id)
            .await
            .map(|_| ())
            .map_err(|error| error.message)
    }

    pub async fn tunnel_check(self: &Arc<Self>, tunnel_id: Option<String>) -> Result<(), String> {
        self.tunnel_check_inner(tunnel_id)
            .await
            .map(|_| ())
            .map_err(|error| error.message)
    }

    async fn tunnel_create_inner(
        self: &Arc<Self>,
        input: GatewayTunnelCreateInput,
    ) -> Result<String, TunnelMutationError> {
        let spec = self.tunnel_store().prepare_create(input)?;
        store::persist_tunnel_spec(spec.clone())
            .await
            .map_err(TunnelMutationError::internal)?;
        self.tunnel_store()
            .commit_spec(spec.clone())
            .map_err(TunnelMutationError::internal)?;
        self.after_tunnel_mutation(Some(vec![spec.id.clone()]))
            .await;
        Ok(spec.id)
    }

    async fn tunnel_update_inner(
        self: &Arc<Self>,
        input: GatewayTunnelUpdateInput,
    ) -> Result<String, TunnelMutationError> {
        let spec = self.tunnel_store().prepare_update(input)?;
        store::persist_tunnel_spec(spec.clone())
            .await
            .map_err(TunnelMutationError::internal)?;
        self.tunnel_store()
            .commit_spec(spec.clone())
            .map_err(TunnelMutationError::internal)?;
        self.after_tunnel_mutation(Some(vec![spec.id.clone()]))
            .await;
        Ok(spec.id)
    }

    async fn tunnel_close_inner(
        self: &Arc<Self>,
        tunnel_id: String,
    ) -> Result<String, TunnelMutationError> {
        let tunnel_id = tunnel_id.trim().to_string();
        if tunnel_id.is_empty() {
            return Err(TunnelMutationError::not_found());
        }
        if !self
            .tunnel_store()
            .spec_exists(&tunnel_id)
            .map_err(TunnelMutationError::internal)?
        {
            return Err(TunnelMutationError::not_found());
        }
        store::delete_tunnel_specs(vec![tunnel_id.clone()])
            .await
            .map_err(TunnelMutationError::internal)?;
        self.tunnel_store()
            .remove_spec(&tunnel_id)
            .map_err(TunnelMutationError::internal)?;
        self.after_tunnel_mutation(None).await;
        Ok(tunnel_id)
    }

    async fn tunnel_check_inner(
        self: &Arc<Self>,
        tunnel_id: Option<String>,
    ) -> Result<String, TunnelMutationError> {
        let tunnel_id = tunnel_id
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty());
        if let Some(id) = tunnel_id.as_ref() {
            if !self
                .tunnel_store()
                .spec_exists(id)
                .map_err(TunnelMutationError::internal)?
            {
                return Err(TunnelMutationError::not_found());
            }
        }
        self.run_tunnel_probes(tunnel_id.clone().map(|id| vec![id]), true)
            .await;
        Ok(tunnel_id.unwrap_or_default())
    }

    async fn after_tunnel_mutation(self: &Arc<Self>, probe_ids: Option<Vec<String>>) {
        let mut published = false;
        if self.status().online {
            match self.publish_desired_tunnels().await {
                Ok(()) => published = true,
                Err(error) => eprintln!("publish gateway tunnel desired state failed: {error}"),
            }
        }
        if !published || self.tunnel_store().is_gateway_unsupported() {
            self.emit_local_tunnel_state();
        }
        if probe_ids.is_some() {
            self.spawn_tunnel_probes(probe_ids, false);
        }
    }

    pub(crate) fn spawn_tunnel_probes(
        self: &Arc<Self>,
        tunnel_ids: Option<Vec<String>>,
        bypass_throttle: bool,
    ) {
        let controller = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            controller
                .run_tunnel_probes(tunnel_ids, bypass_throttle)
                .await;
        });
    }

    async fn run_tunnel_probes(
        self: &Arc<Self>,
        tunnel_ids: Option<Vec<String>>,
        bypass_throttle: bool,
    ) {
        let targets = match self
            .tunnel_store()
            .claim_probe_targets(tunnel_ids, bypass_throttle)
        {
            Ok(targets) => targets,
            Err(error) => {
                eprintln!("collect gateway tunnel probe targets failed: {error}");
                return;
            }
        };
        if targets.is_empty() {
            return;
        }
        let checks = targets
            .into_iter()
            .map(|(tunnel_id, target_url)| async move {
                let health = probe_tunnel_target(&target_url).await;
                (tunnel_id, health)
            });
        let results = futures_util::future::join_all(checks).await;
        if let Err(error) = self.tunnel_store().record_local_health(&results) {
            eprintln!("record gateway tunnel probe results failed: {error}");
        }
        let report = proto::TunnelProbeReport {
            results: results
                .iter()
                .map(|(tunnel_id, health)| proto::TunnelProbeResult {
                    tunnel_id: tunnel_id.clone(),
                    local: Some(tunnel_health_payload_to_proto(health)),
                })
                .collect(),
        };
        let online = self.status().online;
        if online {
            let send_result = self
                .send_agent_envelope(proto::AgentEnvelope {
                    request_id: format!("tunnel-probe-{}", now_unix_seconds()),
                    timestamp: now_unix_seconds(),
                    payload: Some(proto::agent_envelope::Payload::TunnelProbeReport(report)),
                })
                .await;
            if let Err(error) = send_result {
                eprintln!("send gateway tunnel probe report failed: {error}");
            }
        }
        if !online || self.tunnel_store().is_gateway_unsupported() {
            self.emit_local_tunnel_state();
        }
    }
}

async fn probe_tunnel_target(target_url: &str) -> TunnelHealthPayload {
    let checked_at = now_unix_seconds();
    let failed = |error: String| TunnelHealthPayload {
        status: "failed".to_string(),
        http_status: 0,
        error,
        checked_at,
        rtt_ms: 0,
    };
    // 探活目标与转发目标一致（本机/内网）：同样忽略环境代理，见 proxy.rs。
    let client = match reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TUNNEL_LOCAL_PROBE_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return failed(format!(
                "failed to build local tunnel probe client: {error}"
            ))
        }
    };
    match client.get(target_url).send().await {
        Ok(response) => TunnelHealthPayload {
            status: "ok".to_string(),
            http_status: u32::from(response.status().as_u16()),
            error: String::new(),
            checked_at,
            rtt_ms: 0,
        },
        Err(error) => failed(format!("local tunnel probe failed: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::validate_tunnel_target_url;

    #[test]
    fn validate_tunnel_target_url_accepts_localhost_and_ip_http_targets() {
        for value in [
            "http://localhost:3000",
            "http://127.0.0.1:8080/app",
            "http://[::1]:5173",
            "http://192.168.1.5:3000",
            "http://10.0.0.20:8080/app",
            "http://[fd00::1]:5173",
            "http://8.8.8.8:8080",
        ] {
            assert!(validate_tunnel_target_url(value).is_ok(), "{value}");
        }

        for value in [
            "https://localhost:3000",
            "http://example.com",
            "http://user:pass@localhost:3000",
            "http://localhost:3000/#fragment",
        ] {
            assert!(validate_tunnel_target_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn validate_tunnel_target_url_rejects_link_local_metadata_and_reserved_ranges() {
        // 云元数据与 link-local：暴露这些段的隧道是 SSRF 扩张面。
        for value in [
            "http://169.254.169.254:80/latest/meta-data/",
            "http://169.254.170.2:80/",
            "http://169.254.1.1:8080",
            "http://[fe80::1]:8080",
            "http://[fe80::1234]:8080",
        ] {
            assert!(validate_tunnel_target_url(value).is_err(), "{value}");
        }

        // 保留/多播/广播段不可路由，无合法暴露用途。
        for value in [
            "http://0.0.0.0:8080",
            "http://224.0.0.1:8080",
            "http://239.255.255.250:8080",
            "http://240.0.0.1:8080",
            "http://255.255.255.255:8080",
            "http://[::]:8080",
            "http://[ff02::1]:8080",
        ] {
            assert!(validate_tunnel_target_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn validate_tunnel_target_url_rejects_ipv4_mapped_metadata_ranges() {
        // IPv4-mapped IPv6 必须先 unmap 再走 IPv4 黑名单(与网关 Go 侧
        // Unmap() 先例一致):::ffff:169.254.169.254 等价于云元数据地址,
        // 不得作为隧道目标。创建路径(validate)与数据面(proxy.rs 复用同一
        // 校验)共用此函数,此处即覆盖两条路径的判定。
        for value in [
            "http://[::ffff:169.254.169.254]:80/latest/meta-data/",
            "http://[::ffff:a9fe:a9fe]:80/",
            "http://[::ffff:169.254.170.2]:80/",
            "http://[::ffff:224.0.0.1]:8080",
            "http://[::ffff:255.255.255.255]:8080",
        ] {
            assert!(validate_tunnel_target_url(value).is_err(), "{value}");
        }

        // mapped 形式的合法段(RFC1918/公网)语义不变:暴露内网/本地服务
        // 是 tunnel 本职,与直写 IPv4 形式同权放行。
        for value in [
            "http://[::ffff:192.168.1.5]:3000",
            "http://[::ffff:10.0.0.20]:8080",
            "http://[::ffff:8.8.8.8]:8080",
        ] {
            assert!(validate_tunnel_target_url(value).is_ok(), "{value}");
        }
    }
}
