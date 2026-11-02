//! 本机代理服务检测：应用代理设置里「检测到的代理服务」按钮的数据来源。
//!
//! 只认握手通过的服务。先汇总候选地址（本机监听端口、系统代理设置、环境变量、
//! 默认网关上的常用代理端口，见 `sources`），再对每个地址分别做 SOCKS5 与
//! HTTP CONNECT 握手；端口开着但不是代理的（开发服务器等）一律丢弃。
//! 结果不含任何凭据：同一份 JSON 会经 Gateway 送到 WebUI。

mod sources;

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;

use crate::services::system_proxy::{self, SystemProxyConfig, SYSTEM_PROXY_TYPE_SOCKS5};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
const SOCKS_REPLY_TIMEOUT: Duration = Duration::from_millis(700);
const HTTP_REPLY_TIMEOUT: Duration = Duration::from_millis(1500);
/// CONNECT 回应的响应头最多读这么多字节；超出仍没读到空行按非代理处理。
const HTTP_HEAD_LIMIT: usize = 8192;
/// 收到 200 后再等这么久：真代理此时在等客户端发数据，不会主动送字节过来。
const HTTP_TUNNEL_QUIET_WINDOW: Duration = Duration::from_millis(200);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(1);
/// 监听端口很多的机器上只握手前这么多个（按来源优先级排序后截断）。
const MAX_PROBE_TARGETS: usize = 256;
const PROBE_CONCURRENCY: usize = 48;
/// 测速记录的「检测过的代理」上限；超出时清空重来，避免长期运行无界增长。
const MAX_REMEMBERED_CANDIDATES: usize = 512;
const TEST_URL: &str = "https://www.google.com/generate_204";
/// connect 阶段含经代理的 CONNECT 隧道与 TLS 握手；实测节点慢时 2.5–8.5s 才通，
/// 卡太紧会把慢但可用的代理标成不可用。按钮不等测速，可以放宽。
const TEST_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const TEST_TIMEOUT: Duration = Duration::from_secs(10);
/// `.invalid` 顶级域保证不存在（RFC 6761），代理解析失败会立刻回 502/503，
/// 也不会真的替我们去连任何外部主机。
const HTTP_PROBE_REQUEST: &[u8] =
    b"CONNECT probe.invalid:443 HTTP/1.1\r\nHost: probe.invalid:443\r\n\r\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyKind {
    Http,
    Socks5,
}

impl ProxyKind {
    fn as_str(self) -> &'static str {
        match self {
            ProxyKind::Http => "http",
            ProxyKind::Socks5 => SYSTEM_PROXY_TYPE_SOCKS5,
        }
    }
}

/// 声明顺序即排序优先级：系统代理设置指向的服务最可能就是用户正在用的那个。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxySource {
    Os,
    Env,
    Listen,
    Gateway,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedProxy {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub process_name: Option<String>,
    pub sources: Vec<ProxySource>,
    pub auth_required: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyDetectResult {
    pub candidates: Vec<DetectedProxy>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestInput {
    #[serde(rename = "type")]
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestResult {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    /// 失败原因代码，由前端翻译：`timeout` / `connect` / `status:<code>` / `request`。
    pub error: Option<String>,
}

/// 合并后的待握手地址。`host` 是点击按钮后写进设置的值，`addr` 是实际连接的地址。
#[derive(Clone, Debug, PartialEq)]
struct ProbeTarget {
    addr: SocketAddr,
    host: String,
    process_name: Option<String>,
    sources: BTreeSet<ProxySource>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Handshake {
    NotProxy,
    Proxy { auth_required: bool },
}

pub async fn detect() -> ProxyDetectResult {
    let entries = tokio::task::spawn_blocking(sources::gather)
        .await
        .unwrap_or_default();
    let mut resolved = Vec::with_capacity(entries.len());
    for entry in entries {
        if let Some(addr) = resolve_entry(&entry).await {
            resolved.push((addr, entry));
        }
    }
    let targets = merge_targets(resolved);

    let semaphore = Arc::new(Semaphore::new(PROBE_CONCURRENCY));
    let probes = targets.into_iter().map(|target| {
        let semaphore = semaphore.clone();
        async move {
            let _permit = semaphore.acquire().await.ok()?;
            let (kind, auth_required) = probe_target(target.addr).await?;
            Some(to_candidate(target, kind, auth_required))
        }
    });
    let candidates = finalize_candidates(
        futures_util::future::join_all(probes)
            .await
            .into_iter()
            .flatten()
            .collect(),
    );
    remember_candidates(&candidates);
    ProxyDetectResult { candidates }
}

/// 经候选代理访问固定地址并计时。只接受本进程检测到过的代理，避免这条
/// 命令（WebUI 经 Gateway 也能调）被拿去让桌面端连任意主机。
pub async fn test(input: ProxyTestInput) -> Result<ProxyTestResult, String> {
    let host = input.host.trim().to_string();
    if !was_detected(input.kind, &host, input.port) {
        return Err("只能测试检测到的代理服务".to_string());
    }
    let config = SystemProxyConfig {
        enabled: true,
        proxy_type: input.kind.as_str().to_string(),
        host,
        port: input.port,
        ..SystemProxyConfig::default()
    };
    let client = reqwest::Client::builder()
        .proxy(system_proxy::build_proxy(&config)?)
        .connect_timeout(TEST_CONNECT_TIMEOUT)
        .timeout(TEST_TIMEOUT)
        .build()
        .map_err(|e| format!("构建测速客户端失败：{e}"))?;
    let started = Instant::now();
    let result = match client.get(TEST_URL).send().await {
        Ok(response) if response.status().is_success() => ProxyTestResult {
            ok: true,
            latency_ms: Some(started.elapsed().as_millis() as u64),
            error: None,
        },
        Ok(response) => failed_test(format!("status:{}", response.status().as_u16())),
        Err(error) if error.is_timeout() => failed_test("timeout".to_string()),
        Err(error) if error.is_connect() => failed_test("connect".to_string()),
        Err(_) => failed_test("request".to_string()),
    };
    Ok(result)
}

fn failed_test(error: String) -> ProxyTestResult {
    ProxyTestResult {
        ok: false,
        latency_ms: None,
        error: Some(error),
    }
}

async fn resolve_entry(entry: &sources::SourceEntry) -> Option<SocketAddr> {
    if let Some(ip) = entry.connect_ip {
        return Some(SocketAddr::new(ip, entry.port));
    }
    if let Ok(ip) = entry.host.parse::<IpAddr>() {
        return Some(SocketAddr::new(ip, entry.port));
    }
    let lookup = tokio::net::lookup_host((entry.host.as_str(), entry.port));
    let mut addrs = tokio::time::timeout(RESOLVE_TIMEOUT, lookup)
        .await
        .ok()?
        .ok()?;
    addrs.next()
}

/// 同一连接地址的多条来源合并成一个候选，按优先级截断到 `MAX_PROBE_TARGETS`。
fn merge_targets(entries: Vec<(SocketAddr, sources::SourceEntry)>) -> Vec<ProbeTarget> {
    let mut by_addr: HashMap<SocketAddr, ProbeTarget> = HashMap::new();
    for (addr, entry) in entries {
        let target = by_addr.entry(addr).or_insert_with(|| ProbeTarget {
            addr,
            host: entry.host.clone(),
            process_name: None,
            sources: BTreeSet::new(),
        });
        // 填写值取优先级最高的来源；环回地址统一写成 IP，别把 localhost 之类带进设置。
        let best_before = target.sources.first().copied();
        if best_before.is_none_or(|best| entry.source < best) {
            target.host = entry.host.clone();
        }
        if addr.ip().is_loopback() {
            target.host = addr.ip().to_string();
        }
        if target.process_name.is_none() {
            target.process_name = entry.process_name.clone();
        }
        target.sources.insert(entry.source);
    }
    let mut targets: Vec<ProbeTarget> = by_addr.into_values().collect();
    targets.sort_by(|a, b| sort_key(a).cmp(&sort_key(b)));
    targets.truncate(MAX_PROBE_TARGETS);
    targets
}

fn sort_key(target: &ProbeTarget) -> (Option<ProxySource>, u16, String) {
    (
        target.sources.first().copied(),
        target.addr.port(),
        target.host.clone(),
    )
}

fn to_candidate(target: ProbeTarget, kind: ProxyKind, auth_required: bool) -> DetectedProxy {
    let url_host = if target.host.parse::<Ipv6Addr>().is_ok() {
        format!("[{}]", target.host)
    } else {
        target.host.clone()
    };
    DetectedProxy {
        id: format!("{}://{}:{}", kind.as_str(), url_host, target.addr.port()),
        kind,
        host: target.host,
        port: target.addr.port(),
        process_name: target.process_name,
        sources: target.sources.into_iter().collect(),
        auth_required,
    }
}

/// 同一服务常同时监听 IPv4 与 IPv6 环回，只留 127.0.0.1 那条；再按来源优先级排序。
fn finalize_candidates(mut candidates: Vec<DetectedProxy>) -> Vec<DetectedProxy> {
    let v4_loopback_ports: HashSet<u16> = candidates
        .iter()
        .filter(|candidate| candidate.host == Ipv4Addr::LOCALHOST.to_string())
        .map(|candidate| candidate.port)
        .collect();
    candidates.retain(|candidate| {
        candidate.host != Ipv6Addr::LOCALHOST.to_string()
            || !v4_loopback_ports.contains(&candidate.port)
    });
    candidates.sort_by(|a, b| {
        (a.sources.first(), a.port, &a.host).cmp(&(b.sources.first(), b.port, &b.host))
    });
    candidates
}

fn remembered() -> &'static RwLock<HashSet<(ProxyKind, String, u16)>> {
    static REMEMBERED: OnceLock<RwLock<HashSet<(ProxyKind, String, u16)>>> = OnceLock::new();
    REMEMBERED.get_or_init(|| RwLock::new(HashSet::new()))
}

fn remember_candidates(candidates: &[DetectedProxy]) {
    let mut set = remembered()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if set.len() + candidates.len() > MAX_REMEMBERED_CANDIDATES {
        set.clear();
    }
    for candidate in candidates {
        set.insert((candidate.kind, candidate.host.clone(), candidate.port));
    }
}

fn was_detected(kind: ProxyKind, host: &str, port: u16) -> bool {
    remembered()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(&(kind, host.to_string(), port))
}

/// 两种握手都通过的混合端口按 HTTP 填：SOCKS5 配置会把 `socks5h://` 写进 shell
/// 的 `HTTP_PROXY`（见 system_proxy::shell_proxy_envs），不少命令行工具不认。
async fn probe_target(addr: SocketAddr) -> Option<(ProxyKind, bool)> {
    let (http, socks) = tokio::join!(probe_http(addr), probe_socks5(addr));
    match (http, socks) {
        (Handshake::Proxy { auth_required }, _) => Some((ProxyKind::Http, auth_required)),
        (Handshake::NotProxy, Handshake::Proxy { auth_required }) => {
            Some((ProxyKind::Socks5, auth_required))
        }
        (Handshake::NotProxy, Handshake::NotProxy) => None,
    }
}

async fn connect(addr: SocketAddr) -> Option<TcpStream> {
    tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .ok()?
        .ok()
}

async fn probe_socks5(addr: SocketAddr) -> Handshake {
    let Some(mut stream) = connect(addr).await else {
        return Handshake::NotProxy;
    };
    // 只提供「无认证」一种方法：回 05 00 即可直接用，回 05 FF 说明服务端要求认证。
    if stream.write_all(&[0x05, 0x01, 0x00]).await.is_err() {
        return Handshake::NotProxy;
    }
    let mut reply = [0u8; 2];
    match tokio::time::timeout(SOCKS_REPLY_TIMEOUT, stream.read_exact(&mut reply)).await {
        Ok(Ok(_)) => classify_socks5_reply(reply),
        _ => Handshake::NotProxy,
    }
}

fn classify_socks5_reply(reply: [u8; 2]) -> Handshake {
    match reply {
        [0x05, 0x00] => Handshake::Proxy {
            auth_required: false,
        },
        [0x05, 0x02] | [0x05, 0xFF] => Handshake::Proxy {
            auth_required: true,
        },
        _ => Handshake::NotProxy,
    }
}

async fn probe_http(addr: SocketAddr) -> Handshake {
    let Some(mut stream) = connect(addr).await else {
        return Handshake::NotProxy;
    };
    if stream.write_all(HTTP_PROBE_REQUEST).await.is_err() {
        return Handshake::NotProxy;
    }
    // 读到响应头结束（空行）为止；超时或超出上限时头不完整，按非代理处理。
    let deadline = Instant::now() + HTTP_REPLY_TIMEOUT;
    let mut head = Vec::with_capacity(256);
    let mut chunk = [0u8; 512];
    while head.len() < HTTP_HEAD_LIMIT && find_head_end(&head).is_none() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(remaining, stream.read(&mut chunk)).await {
            Ok(Ok(read)) if read > 0 => head.extend_from_slice(&chunk[..read]),
            _ => break,
        }
    }
    let handshake = classify_http_response(&head);
    // 隧道建立后代理会等客户端先发 TLS ClientHello；这时还主动送来数据的是在发正文的
    // Web 服务。连接被关闭（读到 0）不算：mihomo 先回 200 再拨号，拨号失败就直接断开。
    if matches!(handshake, Handshake::Proxy { .. }) && is_2xx(&head) {
        let mut probe = [0u8; 1];
        if let Ok(Ok(read)) =
            tokio::time::timeout(HTTP_TUNNEL_QUIET_WINDOW, stream.read(&mut probe)).await
        {
            if read > 0 {
                return Handshake::NotProxy;
            }
        }
    }
    handshake
}

fn find_head_end(head: &[u8]) -> Option<usize> {
    head.windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

/// `HTTP/1.x ` 之后第一位状态码（调用前已由 classify_http_response 校验过前缀）。
fn is_2xx(head: &[u8]) -> bool {
    head.get(9) == Some(&b'2')
}

/// 代理对 CONNECT 的典型回应：200 已建立隧道，502/503/504 上游不可达，
/// 407 要求认证。普通 Web 服务通常回 400/404/405，按非代理丢弃。
///
/// 有些本地服务对任何请求都回 200（实测 QQ、MouseInc 的本地端口），靠协议约束
/// 区分：代理对 CONNECT 的 2xx 不得带 Content-Length / Transfer-Encoding，也不会
/// 在头后面跟数据（RFC 9110 §9.3.6）；407 必须带 Proxy-Authenticate（§15.5.8）。
/// 头必须完整（读到空行），否则长度头可能藏在截断之后。
///
/// 已知漏检：不带上游转发的 Privoxy / tinyproxy 会先解析 probe.invalid，失败后回
/// 404 / 500，和普通 Web 服务分不开，这类代理需要用户手动填写。
fn classify_http_response(head: &[u8]) -> Handshake {
    let Some(head_end) = find_head_end(head) else {
        return Handshake::NotProxy;
    };
    let trailing_bytes = head.len() > head_end;
    let text = String::from_utf8_lossy(&head[..head_end]);
    let mut lines = text.split("\r\n");
    let mut status_parts = lines.next().unwrap_or_default().split_whitespace();
    if !status_parts
        .next()
        .is_some_and(|version| version.starts_with("HTTP/1."))
    {
        return Handshake::NotProxy;
    }
    let Some(status) = status_parts
        .next()
        .and_then(|status| status.parse::<u16>().ok())
    else {
        return Handshake::NotProxy;
    };
    let headers: Vec<(String, &str)> = lines
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim()))
        .collect();
    let has_header = |wanted: &str| headers.iter().any(|(name, _)| name == wanted);
    let has_body = headers.iter().any(|(name, value)| {
        name == "transfer-encoding" || (name == "content-length" && *value != "0")
    });
    match status {
        200 if !has_body && !trailing_bytes => Handshake::Proxy {
            auth_required: false,
        },
        502..=504 => Handshake::Proxy {
            auth_required: false,
        },
        407 if has_header("proxy-authenticate") => Handshake::Proxy {
            auth_required: true,
        },
        _ => Handshake::NotProxy,
    }
}

#[cfg(test)]
mod tests;
