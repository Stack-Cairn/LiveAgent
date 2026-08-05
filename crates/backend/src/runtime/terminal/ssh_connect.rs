use base64::Engine;
use russh::client;
use russh::keys::ssh_key::HashAlg;
use russh::keys::{PublicKey, PublicKeyBase64};
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::commands::settings::{
    check_runtime_ssh_known_host, RuntimeSshHostConfig, RuntimeSshKnownHostKey,
    RuntimeSshKnownHostStatus,
};

use super::*;

/// An SFTP subsystem channel opened on a terminal SSH session's connection.
/// It does not own the connection: the terminal session runtime does, and the
/// SFTP session dies with it (reconnects invalidate it via the connection id).
pub(crate) struct TerminalSftpConnection {
    pub(crate) session: russh_sftp::client::SftpSession,
}

pub(crate) struct LiveAgentSshClient {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) captured_host_key: Arc<tokio::sync::Mutex<Option<CapturedHostKey>>>,
}

impl client::Handler for LiveAgentSshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let key_base64 =
            base64::engine::general_purpose::STANDARD.encode(server_public_key.public_key_bytes());
        let key = RuntimeSshKnownHostKey {
            host: self.host.clone(),
            port: self.port,
            key_type: server_public_key.algorithm().as_str().to_string(),
            key_base64,
            fingerprint_sha256: server_public_key.fingerprint(HashAlg::Sha256).to_string(),
        };
        match check_runtime_ssh_known_host(&key) {
            Ok(RuntimeSshKnownHostStatus::Known) => Ok(true),
            Ok(status) => {
                *self.captured_host_key.lock().await = Some(CapturedHostKey { key, status });
                Ok(false)
            }
            Err(error) => {
                *self.captured_host_key.lock().await = Some(CapturedHostKey {
                    key,
                    status: RuntimeSshKnownHostStatus::Changed {
                        stored_fingerprint: error,
                    },
                });
                Ok(false)
            }
        }
    }
}

pub(crate) enum ResolvedSshAuth {
    Password(String),
    PrivateKey {
        key: String,
        passphrase: Option<String>,
    },
    KeyboardInteractive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SshProxyKind {
    Socks5,
    Http,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedSshProxy {
    pub(crate) kind: SshProxyKind,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) password: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SshPathProfile {
    Windows,
    Posix,
}

pub(crate) fn ssh_proxy_configured(host: &RuntimeSshHostConfig) -> bool {
    !host.proxy.url.trim().is_empty()
        || host.proxy.port > 0
        || !host.proxy.username.trim().is_empty()
        || host.proxy.password_configured
}

pub(crate) async fn connect_ssh_handle(
    host_config: &RuntimeSshHostConfig,
    captured_host_key: Arc<tokio::sync::Mutex<Option<CapturedHostKey>>>,
) -> Result<client::Handle<LiveAgentSshClient>, String> {
    let ssh_client = LiveAgentSshClient {
        host: host_config.host.clone(),
        port: host_config.port,
        captured_host_key,
    };
    let config = Arc::new(ssh_client_config());
    let stream = open_ssh_transport(host_config).await?;
    client::connect_stream(config, stream, ssh_client)
        .await
        .map_err(|error| format!("SSH connection failed: {error}"))
}

pub(crate) fn ssh_client_config() -> client::Config {
    client::Config {
        keepalive_interval: Some(SSH_KEEPALIVE_INTERVAL),
        keepalive_max: SSH_KEEPALIVE_MAX_MISSES,
        nodelay: true,
        ..Default::default()
    }
}

pub(crate) async fn open_ssh_transport(
    host_config: &RuntimeSshHostConfig,
) -> Result<TcpStream, String> {
    if !ssh_proxy_configured(host_config) {
        let stream = TcpStream::connect((host_config.host.as_str(), host_config.port))
            .await
            .map_err(|error| {
                format!(
                    "SSH TCP connection to {}:{} failed: {error}",
                    host_config.host, host_config.port
                )
            })?;
        configure_ssh_transport_stream(&stream);
        return Ok(stream);
    }

    let proxy = resolve_ssh_proxy(host_config)?;
    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(|error| {
            format!(
                "SSH proxy connection to {}:{} failed: {error}",
                proxy.host, proxy.port
            )
        })?;
    match proxy.kind {
        SshProxyKind::Http => {
            http_connect_proxy(
                &mut stream,
                host_config.host.as_str(),
                host_config.port,
                &proxy,
            )
            .await?;
        }
        SshProxyKind::Socks5 => {
            socks5_connect_proxy(
                &mut stream,
                host_config.host.as_str(),
                host_config.port,
                &proxy,
            )
            .await?;
        }
    }
    configure_ssh_transport_stream(&stream);
    Ok(stream)
}

pub(crate) fn configure_ssh_transport_stream(stream: &TcpStream) {
    let _ = stream.set_nodelay(true);
}

pub(crate) fn resolve_ssh_proxy(
    host_config: &RuntimeSshHostConfig,
) -> Result<ResolvedSshProxy, String> {
    let raw_url = host_config.proxy.url.trim();
    if raw_url.is_empty() {
        return Err("SSH proxy host is required".to_string());
    }
    let (scheme, authority) = split_proxy_scheme(raw_url);
    let kind = resolve_proxy_kind(host_config.proxy.proxy_type.as_str(), scheme)?;
    let authority = authority
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(authority)
        .trim();
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (proxy_host, url_port) = split_host_port(authority);
    if proxy_host.trim().is_empty() {
        return Err("SSH proxy host is required".to_string());
    }
    let configured_port = u16::try_from(host_config.proxy.port)
        .ok()
        .filter(|port| *port >= 1);
    let default_port = match kind {
        SshProxyKind::Socks5 => 1080,
        SshProxyKind::Http => 8080,
    };
    Ok(ResolvedSshProxy {
        kind,
        host: proxy_host,
        port: configured_port.or(url_port).unwrap_or(default_port),
        username: host_config.proxy.username.trim().to_string(),
        password: host_config.proxy.password.trim().to_string(),
    })
}

pub(crate) fn split_proxy_scheme(input: &str) -> (Option<&str>, &str) {
    if let Some(index) = input.find("://") {
        let (scheme, rest) = input.split_at(index);
        return (Some(scheme), &rest[3..]);
    }
    (None, input)
}

pub(crate) fn resolve_proxy_kind(
    raw_type: &str,
    scheme: Option<&str>,
) -> Result<SshProxyKind, String> {
    let source = scheme.unwrap_or(raw_type).trim().to_ascii_lowercase();
    match source.as_str() {
        "http" => Ok(SshProxyKind::Http),
        "" | "socks5" | "socks" => Ok(SshProxyKind::Socks5),
        other => Err(format!("SSH proxy type is not supported: {other}")),
    }
}

pub(crate) fn split_host_port(authority: &str) -> (String, Option<u16>) {
    let authority = authority.trim();
    if let Some(rest) = authority.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let host = rest[..end].to_string();
            let port = rest[end + 1..].strip_prefix(':').and_then(parse_u16_port);
            return (host, port);
        }
    }
    if let Some((host, port)) = authority.rsplit_once(':') {
        if !host.contains(':') {
            return (host.to_string(), parse_u16_port(port));
        }
    }
    (authority.to_string(), None)
}

pub(crate) fn parse_u16_port(value: &str) -> Option<u16> {
    value.trim().parse::<u16>().ok().filter(|port| *port >= 1)
}

pub(crate) async fn http_connect_proxy(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    proxy: &ResolvedSshProxy,
) -> Result<(), String> {
    let target = host_port_authority(target_host, target_port);
    let mut request =
        format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: Keep-Alive\r\n");
    if !proxy.username.is_empty() || !proxy.password.is_empty() {
        let token = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", proxy.username, proxy.password));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| format!("SSH HTTP proxy CONNECT request failed: {error}"))?;

    let mut response = Vec::with_capacity(512);
    let mut byte = [0u8; 1];
    while !response.ends_with(b"\r\n\r\n") {
        if response.len() >= 16 * 1024 {
            return Err("SSH HTTP proxy CONNECT response is too large".to_string());
        }
        let n = stream
            .read(&mut byte)
            .await
            .map_err(|error| format!("SSH HTTP proxy CONNECT response failed: {error}"))?;
        if n == 0 {
            return Err("SSH HTTP proxy closed before CONNECT completed".to_string());
        }
        response.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&response);
    let status_line = text.lines().next().unwrap_or_default();
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    if !(200..300).contains(&status_code) {
        return Err(format!(
            "SSH HTTP proxy CONNECT failed: {}",
            status_line.trim()
        ));
    }
    Ok(())
}

pub(crate) async fn socks5_connect_proxy(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    proxy: &ResolvedSshProxy,
) -> Result<(), String> {
    let wants_auth = !proxy.username.is_empty() || !proxy.password.is_empty();
    if wants_auth
        && (proxy.username.len() > u8::MAX as usize || proxy.password.len() > u8::MAX as usize)
    {
        return Err("SSH SOCKS5 proxy username/password is too long".to_string());
    }
    let greeting: &[u8] = if wants_auth {
        &[0x05, 0x02, 0x00, 0x02]
    } else {
        &[0x05, 0x01, 0x00]
    };
    stream
        .write_all(greeting)
        .await
        .map_err(|error| format!("SSH SOCKS5 proxy greeting failed: {error}"))?;
    let mut method = [0u8; 2];
    stream
        .read_exact(&mut method)
        .await
        .map_err(|error| format!("SSH SOCKS5 proxy method response failed: {error}"))?;
    if method[0] != 0x05 {
        return Err("SSH SOCKS5 proxy returned an invalid version".to_string());
    }
    match method[1] {
        0x00 => {}
        0x02 => {
            let mut auth = Vec::with_capacity(3 + proxy.username.len() + proxy.password.len());
            auth.push(0x01);
            auth.push(proxy.username.len() as u8);
            auth.extend_from_slice(proxy.username.as_bytes());
            auth.push(proxy.password.len() as u8);
            auth.extend_from_slice(proxy.password.as_bytes());
            stream
                .write_all(&auth)
                .await
                .map_err(|error| format!("SSH SOCKS5 proxy auth request failed: {error}"))?;
            let mut auth_response = [0u8; 2];
            stream
                .read_exact(&mut auth_response)
                .await
                .map_err(|error| format!("SSH SOCKS5 proxy auth response failed: {error}"))?;
            if auth_response != [0x01, 0x00] {
                return Err("SSH SOCKS5 proxy authentication failed".to_string());
            }
        }
        0xff => return Err("SSH SOCKS5 proxy has no acceptable auth method".to_string()),
        other => {
            return Err(format!(
                "SSH SOCKS5 proxy selected unsupported auth method: {other}"
            ))
        }
    }

    let mut request = Vec::new();
    request.extend_from_slice(&[0x05, 0x01, 0x00]);
    write_socks5_address(&mut request, target_host)?;
    request.extend_from_slice(&target_port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|error| format!("SSH SOCKS5 proxy CONNECT request failed: {error}"))?;

    let mut response = [0u8; 4];
    stream
        .read_exact(&mut response)
        .await
        .map_err(|error| format!("SSH SOCKS5 proxy CONNECT response failed: {error}"))?;
    if response[0] != 0x05 {
        return Err("SSH SOCKS5 proxy returned an invalid CONNECT version".to_string());
    }
    if response[1] != 0x00 {
        return Err(format!(
            "SSH SOCKS5 proxy CONNECT failed: {}",
            socks5_reply_label(response[1])
        ));
    }
    let address_len = match response[3] {
        0x01 => 4,
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .await
                .map_err(|error| format!("SSH SOCKS5 proxy response failed: {error}"))?;
            usize::from(len[0])
        }
        0x04 => 16,
        other => {
            return Err(format!(
                "SSH SOCKS5 proxy returned unsupported address type: {other}"
            ))
        }
    };
    let mut discard = vec![0u8; address_len + 2];
    stream
        .read_exact(&mut discard)
        .await
        .map_err(|error| format!("SSH SOCKS5 proxy response failed: {error}"))?;
    Ok(())
}

pub(crate) fn write_socks5_address(out: &mut Vec<u8>, host: &str) -> Result<(), String> {
    let normalized_host = strip_ipv6_brackets(host.trim());
    if let Ok(ip) = normalized_host.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(ip) => {
                out.push(0x01);
                out.extend_from_slice(&ip.octets());
            }
            IpAddr::V6(ip) => {
                out.push(0x04);
                out.extend_from_slice(&ip.octets());
            }
        }
        return Ok(());
    }
    if normalized_host.is_empty() || normalized_host.len() > u8::MAX as usize {
        return Err("SSH SOCKS5 target host is empty or too long".to_string());
    }
    out.push(0x03);
    out.push(normalized_host.len() as u8);
    out.extend_from_slice(normalized_host.as_bytes());
    Ok(())
}

pub(crate) fn strip_ipv6_brackets(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
}

pub(crate) fn host_port_authority(host: &str, port: u16) -> String {
    let host = host.trim();
    if strip_ipv6_brackets(host).parse::<Ipv6Addr>().is_ok() && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

pub(crate) fn socks5_reply_label(code: u8) -> &'static str {
    match code {
        0x01 => "general failure",
        0x02 => "connection not allowed",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused",
        0x06 => "TTL expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown error",
    }
}
