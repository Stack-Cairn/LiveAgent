//! 候选地址来源。这里只负责「去哪儿找」，是不是代理由上层握手判定。
//!
//! - 本机监听端口（主来源）：列出所有监听中的 TCP 端口及所属进程，跳过本进程
//!   与 Windows 系统进程。代理软件改了端口也能找到，进程名用作按钮上的名称。
//! - 系统代理设置、进程环境变量：能补上指向局域网代理服务器的情况。
//! - 默认网关的几个常用代理端口：发现软路由上的代理。只查网关这一个私网地址，
//!   不扫网段。
//!
//! 各平台的文本解析函数不加 cfg，便于在任何平台上跑单测。

use super::ProxySource;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// 软路由（OpenClash 等）常见的代理入站端口。
const GATEWAY_PROXY_PORTS: &[u16] = &[7890, 7891, 7893, 1080, 10808, 10809];
const PROXY_ENV_KEYS: &[&str] = &[
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
];

#[derive(Clone, Debug, PartialEq)]
pub(super) struct SourceEntry {
    /// 点击按钮后写进设置的主机。
    pub host: String,
    pub port: u16,
    /// 已知的连接地址；为 None 时由上层解析 `host`。
    pub connect_ip: Option<IpAddr>,
    pub process_name: Option<String>,
    pub source: ProxySource,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct ListeningSocket {
    pub ip: IpAddr,
    pub port: u16,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
}

pub(super) fn gather() -> Vec<SourceEntry> {
    let mut entries = listening_entries(platform::listening_sockets(), std::process::id());
    entries.extend(host_port_entries(
        platform::os_proxy_servers(),
        ProxySource::Os,
    ));
    entries.extend(host_port_entries(
        env_proxy_servers(std::env::vars()),
        ProxySource::Env,
    ));
    if let Some(gateway) = platform::default_gateway().filter(Ipv4Addr::is_private) {
        entries.extend(GATEWAY_PROXY_PORTS.iter().map(|&port| SourceEntry {
            host: gateway.to_string(),
            port,
            connect_ip: Some(IpAddr::V4(gateway)),
            process_name: None,
            source: ProxySource::Gateway,
        }));
    }
    entries
}

fn listening_entries(sockets: Vec<ListeningSocket>, own_pid: u32) -> Vec<SourceEntry> {
    sockets
        .into_iter()
        .filter(|socket| socket.pid != Some(own_pid) && socket.port != 0)
        .filter_map(|socket| {
            let ip = connect_ip_for_bind(socket.ip)?;
            Some(SourceEntry {
                host: ip.to_string(),
                port: socket.port,
                connect_ip: Some(ip),
                process_name: socket.process_name,
                source: ProxySource::Listen,
            })
        })
        .collect()
}

/// 监听在通配或环回地址的服务从本机环回去连；IPv6 链路本地地址需要 scope id，跳过。
fn connect_ip_for_bind(ip: IpAddr) -> Option<IpAddr> {
    match ip {
        IpAddr::V4(v4) if v4.is_unspecified() || v4.is_loopback() => {
            Some(IpAddr::V4(Ipv4Addr::LOCALHOST))
        }
        IpAddr::V6(v6) if v6.is_unspecified() || v6.is_loopback() => {
            Some(IpAddr::V6(Ipv6Addr::LOCALHOST))
        }
        IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80 => None,
        other => Some(other),
    }
}

fn host_port_entries(servers: Vec<(String, u16)>, source: ProxySource) -> Vec<SourceEntry> {
    servers
        .into_iter()
        .map(|(host, port)| SourceEntry {
            host,
            port,
            connect_ip: None,
            process_name: None,
            source,
        })
        .collect()
}

fn env_proxy_servers(vars: impl IntoIterator<Item = (String, String)>) -> Vec<(String, u16)> {
    let mut servers = Vec::new();
    for (key, value) in vars {
        if !PROXY_ENV_KEYS.contains(&key.as_str()) {
            continue;
        }
        if let Some(server) = parse_host_port(&value) {
            if !servers.contains(&server) {
                servers.push(server);
            }
        }
    }
    servers
}

/// 解析 `[scheme://][user:pass@]host:port[/]`。凭据直接丢弃，不进任何结果。
fn parse_host_port(raw: &str) -> Option<(String, u16)> {
    let mut rest = raw.trim();
    if let Some((_, after)) = rest.split_once("://") {
        rest = after;
    }
    rest = rest.trim_end_matches('/');
    if let Some((_, after)) = rest.rsplit_once('@') {
        rest = after;
    }
    let (host, port) = if let Some(bracketed) = rest.strip_prefix('[') {
        let (host, after) = bracketed.split_once(']')?;
        host.parse::<Ipv6Addr>().ok()?;
        (host, after.strip_prefix(':')?)
    } else {
        let (host, port) = rest.rsplit_once(':')?;
        if host.contains(':') {
            return None;
        }
        (host, port)
    };
    let port = port.parse::<u16>().ok().filter(|&port| port != 0)?;
    let host = host.trim();
    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '/' | '\\' | '#' | '?' | '%'))
    {
        return None;
    }
    Some((host.to_string(), port))
}

/// Windows `ProxyServer` 有两种写法：`127.0.0.1:7890`，或按协议分开的
/// `http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891`。
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_windows_proxy_server(raw: &str) -> Vec<(String, u16)> {
    let mut servers = Vec::new();
    for part in raw.split(';') {
        let part = part.trim();
        let address = match part.split_once('=') {
            Some((scheme, address)) => {
                let scheme = scheme.trim().to_ascii_lowercase();
                if !matches!(scheme.as_str(), "http" | "https" | "socks") {
                    continue;
                }
                address
            }
            None => part,
        };
        if let Some(server) = parse_host_port(address) {
            if !servers.contains(&server) {
                servers.push(server);
            }
        }
    }
    servers
}

/// `scutil --proxy` 输出形如 `HTTPEnable : 1`、`HTTPProxy : 127.0.0.1`、`HTTPPort : 7890`。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_scutil_proxy(output: &str) -> Vec<(String, u16)> {
    let values: std::collections::HashMap<&str, &str> = output
        .lines()
        .filter_map(|line| line.split_once(" : "))
        .map(|(key, value)| (key.trim(), value.trim()))
        .collect();
    let mut servers = Vec::new();
    for prefix in ["HTTP", "HTTPS", "SOCKS"] {
        if values.get(format!("{prefix}Enable").as_str()) != Some(&"1") {
            continue;
        }
        let host = values.get(format!("{prefix}Proxy").as_str()).copied();
        let port = values
            .get(format!("{prefix}Port").as_str())
            .and_then(|port| port.parse::<u16>().ok());
        if let (Some(host), Some(port)) = (host, port) {
            if let Some(server) = parse_host_port(&format!("{host}:{port}")) {
                if !servers.contains(&server) {
                    servers.push(server);
                }
            }
        }
    }
    servers
}

/// `route -n get default` 里的 `gateway: 192.168.1.1` 行。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_route_get_gateway(output: &str) -> Option<Ipv4Addr> {
    output.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim() == "gateway")
            .then(|| value.trim().parse().ok())
            .flatten()
    })
}

/// `lsof -nP -iTCP -sTCP:LISTEN -F pcn +c 0` 的字段输出：`p<pid>`、`c<命令名>`、
/// `n<地址:端口>`，地址为 `*`、`127.0.0.1` 或 `[::1]`。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_lsof_listeners(output: &str) -> Vec<ListeningSocket> {
    let mut sockets = Vec::new();
    let mut pid = None;
    let mut name = None;
    for line in output.lines() {
        let Some(field) = line.chars().next() else {
            continue;
        };
        let value = &line[field.len_utf8()..];
        match field {
            'p' => {
                pid = value.parse::<u32>().ok();
                name = None;
            }
            'c' => name = Some(value.to_string()).filter(|name| !name.is_empty()),
            'n' => {
                let Some((host, port)) = value.rsplit_once(':') else {
                    continue;
                };
                let Ok(port) = port.parse::<u16>() else {
                    continue;
                };
                let host = host.trim_start_matches('[').trim_end_matches(']');
                let ip = if host == "*" {
                    IpAddr::V4(Ipv4Addr::UNSPECIFIED)
                } else if let Ok(ip) = host.parse::<IpAddr>() {
                    ip
                } else {
                    continue;
                };
                sockets.push(ListeningSocket {
                    ip,
                    port,
                    pid,
                    process_name: name.clone(),
                });
            }
            _ => {}
        }
    }
    sockets
}

/// `/proc/net/tcp`(6) 每行的本地地址是按主机字节序打印的 32 位字（IPv6 为四个），
/// `st` 为 `0A` 表示 LISTEN。返回 (地址, 端口, socket inode)。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_proc_net_tcp(content: &str) -> Vec<(IpAddr, u16, u64)> {
    let mut rows = Vec::new();
    for line in content.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 || fields[3] != "0A" {
            continue;
        }
        let Some((addr_hex, port_hex)) = fields[1].split_once(':') else {
            continue;
        };
        let Ok(port) = u16::from_str_radix(port_hex, 16) else {
            continue;
        };
        let Ok(inode) = fields[9].parse::<u64>() else {
            continue;
        };
        let ip = match addr_hex.len() {
            8 => match u32::from_str_radix(addr_hex, 16) {
                Ok(word) => IpAddr::V4(Ipv4Addr::from(word.to_ne_bytes())),
                Err(_) => continue,
            },
            32 => {
                let mut octets = [0u8; 16];
                let mut valid = true;
                for (index, chunk) in octets.chunks_mut(4).enumerate() {
                    match u32::from_str_radix(&addr_hex[index * 8..index * 8 + 8], 16) {
                        Ok(word) => chunk.copy_from_slice(&word.to_ne_bytes()),
                        Err(_) => valid = false,
                    }
                }
                if !valid {
                    continue;
                }
                IpAddr::V6(Ipv6Addr::from(octets))
            }
            _ => continue,
        };
        rows.push((ip, port, inode));
    }
    rows
}

/// `/proc/net/route` 中目标为 `00000000` 的默认路由行，网关字段同样按主机字节序打印。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_proc_net_route_gateway(content: &str) -> Option<Ipv4Addr> {
    content.lines().skip(1).find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 || fields[1] != "00000000" {
            return None;
        }
        let word = u32::from_str_radix(fields[2], 16).ok()?;
        let gateway = Ipv4Addr::from(word.to_ne_bytes());
        (!gateway.is_unspecified()).then_some(gateway)
    })
}

#[cfg(windows)]
mod platform {
    use super::{parse_windows_proxy_server, ListeningSocket};
    use std::collections::HashMap;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    use std::path::Path;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetBestRoute, GetExtendedTcpTable, MIB_IPFORWARDROW, MIB_TCP6ROW_OWNER_PID,
        MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    const INTERNET_SETTINGS_KEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 端口按网络字节序存在 DWORD 的低 16 位。
    fn table_port(raw: u32) -> u16 {
        let bytes = raw.to_ne_bytes();
        u16::from_be_bytes([bytes[0], bytes[1]])
    }

    /// 读一张监听表，返回 (表头之后的行数据, 行数)。缓冲按 u32 分配以满足对齐。
    fn read_tcp_table(family: u32) -> Option<(Vec<u32>, usize)> {
        let mut size = 0u32;
        for _ in 0..4 {
            let mut buffer = vec![0u32; (size as usize).div_ceil(4).max(1)];
            let mut capacity = (buffer.len() * 4) as u32;
            let status = unsafe {
                GetExtendedTcpTable(
                    buffer.as_mut_ptr().cast(),
                    &mut capacity,
                    0,
                    family,
                    TCP_TABLE_OWNER_PID_LISTENER,
                    0,
                )
            };
            if status == NO_ERROR {
                let rows = buffer[0] as usize;
                return Some((buffer, rows));
            }
            if status != ERROR_INSUFFICIENT_BUFFER {
                return None;
            }
            size = capacity;
        }
        None
    }

    fn table_rows<T: Copy>(buffer: &[u32], rows: usize) -> Vec<T> {
        let available = (buffer.len().saturating_sub(1) * 4) / std::mem::size_of::<T>();
        let start = unsafe { buffer.as_ptr().add(1).cast::<T>() };
        (0..rows.min(available))
            .map(|index| unsafe { start.add(index).read_unaligned() })
            .collect()
    }

    fn process_image_path(pid: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut buffer = [0u16; 1024];
            let mut length = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                buffer.as_mut_ptr(),
                &mut length,
            );
            CloseHandle(handle);
            (ok != 0).then(|| String::from_utf16_lossy(&buffer[..length as usize]))
        }
    }

    /// 返回 None 表示应跳过（System/Idle 或 Windows 目录下的系统进程）；
    /// 读不到路径（受保护进程）时保留，名称留空，交给握手判定。
    fn classify_process(pid: u32, system_root: &str) -> Option<Option<String>> {
        if pid == 0 || pid == 4 {
            return None;
        }
        let Some(path) = process_image_path(pid) else {
            return Some(None);
        };
        if path.to_ascii_lowercase().starts_with(system_root) {
            return None;
        }
        Some(
            Path::new(&path)
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned()),
        )
    }

    pub(super) fn listening_sockets() -> Vec<ListeningSocket> {
        let mut raw: Vec<(IpAddr, u16, u32)> = Vec::new();
        if let Some((buffer, rows)) = read_tcp_table(AF_INET) {
            for row in table_rows::<MIB_TCPROW_OWNER_PID>(&buffer, rows) {
                let ip = IpAddr::V4(Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()));
                raw.push((ip, table_port(row.dwLocalPort), row.dwOwningPid));
            }
        }
        if let Some((buffer, rows)) = read_tcp_table(AF_INET6) {
            for row in table_rows::<MIB_TCP6ROW_OWNER_PID>(&buffer, rows) {
                let ip = IpAddr::V6(Ipv6Addr::from(row.ucLocalAddr));
                raw.push((ip, table_port(row.dwLocalPort), row.dwOwningPid));
            }
        }
        let system_root = format!(
            "{}\\",
            std::env::var("SystemRoot")
                .unwrap_or_else(|_| r"C:\Windows".to_string())
                .trim_end_matches('\\')
                .to_ascii_lowercase()
        );
        let mut processes: HashMap<u32, Option<Option<String>>> = HashMap::new();
        raw.into_iter()
            .filter_map(|(ip, port, pid)| {
                let process = processes
                    .entry(pid)
                    .or_insert_with(|| classify_process(pid, &system_root))
                    .clone()?;
                Some(ListeningSocket {
                    ip,
                    port,
                    pid: Some(pid),
                    process_name: process,
                })
            })
            .collect()
    }

    fn read_registry_dword(name: &str) -> Option<u32> {
        let key = wide(INTERNET_SETTINGS_KEY);
        let value = wide(name);
        let mut data = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut data as *mut u32).cast(),
                &mut size,
            )
        };
        (status == NO_ERROR).then_some(data)
    }

    fn read_registry_string(name: &str) -> Option<String> {
        let key = wide(INTERNET_SETTINGS_KEY);
        let value = wide(name);
        let mut buffer = vec![0u16; 2048];
        let mut size = (buffer.len() * 2) as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != NO_ERROR {
            return None;
        }
        let length = (size as usize / 2).min(buffer.len());
        let text = String::from_utf16_lossy(&buffer[..length]);
        Some(text.trim_end_matches('\0').to_string())
    }

    pub(super) fn os_proxy_servers() -> Vec<(String, u16)> {
        if read_registry_dword("ProxyEnable") != Some(1) {
            return Vec::new();
        }
        read_registry_string("ProxyServer")
            .map(|raw| parse_windows_proxy_server(&raw))
            .unwrap_or_default()
    }

    pub(super) fn default_gateway() -> Option<Ipv4Addr> {
        let mut route = MIB_IPFORWARDROW::default();
        let destination = u32::from_ne_bytes([8, 8, 8, 8]);
        let status = unsafe { GetBestRoute(destination, 0, &mut route) };
        if status != NO_ERROR {
            return None;
        }
        let gateway = Ipv4Addr::from(route.dwForwardNextHop.to_ne_bytes());
        (!gateway.is_unspecified()).then_some(gateway)
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{
        parse_lsof_listeners, parse_route_get_gateway, parse_scutil_proxy, ListeningSocket,
    };
    use std::net::Ipv4Addr;
    use std::process::Command;

    fn run(program: &str, args: &[&str]) -> Option<String> {
        let output = Command::new(program).args(args).output().ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    }

    pub(super) fn listening_sockets() -> Vec<ListeningSocket> {
        run(
            "/usr/sbin/lsof",
            &["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn", "+c", "0"],
        )
        .map(|output| parse_lsof_listeners(&output))
        .unwrap_or_default()
    }

    pub(super) fn os_proxy_servers() -> Vec<(String, u16)> {
        run("/usr/sbin/scutil", &["--proxy"])
            .map(|output| parse_scutil_proxy(&output))
            .unwrap_or_default()
    }

    pub(super) fn default_gateway() -> Option<Ipv4Addr> {
        run("/sbin/route", &["-n", "get", "default"])
            .and_then(|output| parse_route_get_gateway(&output))
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{parse_proc_net_route_gateway, parse_proc_net_tcp, ListeningSocket};
    use std::collections::HashMap;
    use std::net::Ipv4Addr;

    /// 扫 `/proc/<pid>/fd` 建 socket inode → (pid, 进程名)。只读得到当前用户的进程，
    /// 其余端口照样握手，只是没有名称。
    fn socket_owners() -> HashMap<u64, (u32, Option<String>)> {
        let mut owners = HashMap::new();
        let Ok(processes) = std::fs::read_dir("/proc") else {
            return owners;
        };
        for process in processes.flatten() {
            let Some(pid) = process
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            let Ok(fds) = std::fs::read_dir(process.path().join("fd")) else {
                continue;
            };
            let name = std::fs::read_to_string(process.path().join("comm"))
                .ok()
                .map(|comm| comm.trim().to_string())
                .filter(|comm| !comm.is_empty());
            for fd in fds.flatten() {
                let Ok(target) = std::fs::read_link(fd.path()) else {
                    continue;
                };
                let target = target.to_string_lossy();
                if let Some(inode) = target
                    .strip_prefix("socket:[")
                    .and_then(|rest| rest.strip_suffix(']'))
                    .and_then(|inode| inode.parse::<u64>().ok())
                {
                    owners.entry(inode).or_insert_with(|| (pid, name.clone()));
                }
            }
        }
        owners
    }

    pub(super) fn listening_sockets() -> Vec<ListeningSocket> {
        let mut rows = Vec::new();
        for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(content) = std::fs::read_to_string(path) {
                rows.extend(parse_proc_net_tcp(&content));
            }
        }
        let owners = socket_owners();
        rows.into_iter()
            .map(|(ip, port, inode)| {
                let owner = owners.get(&inode);
                ListeningSocket {
                    ip,
                    port,
                    pid: owner.map(|(pid, _)| *pid),
                    process_name: owner.and_then(|(_, name)| name.clone()),
                }
            })
            .collect()
    }

    pub(super) fn os_proxy_servers() -> Vec<(String, u16)> {
        Vec::new()
    }

    pub(super) fn default_gateway() -> Option<Ipv4Addr> {
        std::fs::read_to_string("/proc/net/route")
            .ok()
            .and_then(|content| parse_proc_net_route_gateway(&content))
    }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod platform {
    use super::ListeningSocket;
    use std::net::Ipv4Addr;

    pub(super) fn listening_sockets() -> Vec<ListeningSocket> {
        Vec::new()
    }

    pub(super) fn os_proxy_servers() -> Vec<(String, u16)> {
        Vec::new()
    }

    pub(super) fn default_gateway() -> Option<Ipv4Addr> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_host_port_strips_scheme_credentials_and_trailing_slash() {
        assert_eq!(
            parse_host_port("http://user:p%40ss@127.0.0.1:7890/"),
            Some(("127.0.0.1".to_string(), 7890))
        );
        assert_eq!(
            parse_host_port("socks5h://[::1]:1080"),
            Some(("::1".to_string(), 1080))
        );
        assert_eq!(
            parse_host_port("proxy.corp.local:3128"),
            Some(("proxy.corp.local".to_string(), 3128))
        );
        assert_eq!(parse_host_port("127.0.0.1"), None);
        assert_eq!(parse_host_port("127.0.0.1:0"), None);
        assert_eq!(parse_host_port("::1:1080"), None);
        assert_eq!(parse_host_port(""), None);
    }

    #[test]
    fn windows_proxy_server_supports_single_and_per_scheme_forms() {
        assert_eq!(
            parse_windows_proxy_server("127.0.0.1:7890"),
            vec![("127.0.0.1".to_string(), 7890)]
        );
        assert_eq!(
            parse_windows_proxy_server(
                "http=127.0.0.1:7890;https=127.0.0.1:7890;ftp=10.0.0.1:21;socks=127.0.0.1:7891"
            ),
            vec![
                ("127.0.0.1".to_string(), 7890),
                ("127.0.0.1".to_string(), 7891)
            ]
        );
        assert_eq!(
            parse_windows_proxy_server("http://127.0.0.1:10809"),
            vec![("127.0.0.1".to_string(), 10809)]
        );
    }

    #[test]
    fn env_proxy_servers_reads_known_keys_and_dedupes() {
        let vars = vec![
            (
                "HTTP_PROXY".to_string(),
                "http://127.0.0.1:7890".to_string(),
            ),
            (
                "https_proxy".to_string(),
                "http://127.0.0.1:7890".to_string(),
            ),
            (
                "ALL_PROXY".to_string(),
                "socks5://127.0.0.1:7891".to_string(),
            ),
            ("NO_PROXY".to_string(), "localhost:1".to_string()),
            ("PATH".to_string(), "C:/bin:1".to_string()),
        ];
        assert_eq!(
            env_proxy_servers(vars),
            vec![
                ("127.0.0.1".to_string(), 7890),
                ("127.0.0.1".to_string(), 7891)
            ]
        );
    }

    #[test]
    fn scutil_proxy_reads_only_enabled_entries() {
        let output = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n  }\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n  HTTPSProxy : 127.0.0.1\n  SOCKSEnable : 0\n  SOCKSPort : 7891\n  SOCKSProxy : 127.0.0.1\n}\n";
        assert_eq!(
            parse_scutil_proxy(output),
            vec![("127.0.0.1".to_string(), 7890)]
        );
    }

    #[test]
    fn route_get_gateway_parses_default_route() {
        let output = "   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.31.1\n  interface: en0\n";
        assert_eq!(
            parse_route_get_gateway(output),
            Some(Ipv4Addr::new(192, 168, 31, 1))
        );
        assert_eq!(parse_route_get_gateway("interface: utun3\n"), None);
    }

    #[test]
    fn lsof_listeners_track_pid_and_command_per_process() {
        let output = "p812\ncverge-mihomo\nf9\nn127.0.0.1:7897\nf10\nn*:7898\np901\ncrapportd\nf4\nn[::1]:49152\n";
        let sockets = parse_lsof_listeners(output);
        assert_eq!(sockets.len(), 3);
        assert_eq!(sockets[0].ip, IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_eq!(sockets[0].port, 7897);
        assert_eq!(sockets[0].pid, Some(812));
        assert_eq!(sockets[0].process_name.as_deref(), Some("verge-mihomo"));
        assert_eq!(sockets[1].ip, IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert_eq!(sockets[2].ip, IpAddr::V6(Ipv6Addr::LOCALHOST));
        assert_eq!(sockets[2].process_name.as_deref(), Some("rapportd"));
    }

    #[test]
    fn proc_net_tcp_keeps_listen_rows_only() {
        let v4_loopback = u32::from_ne_bytes([127, 0, 0, 1]);
        let v6_loopback: String = Ipv6Addr::LOCALHOST
            .octets()
            .chunks(4)
            .map(|chunk| format!("{:08X}", u32::from_ne_bytes(chunk.try_into().unwrap())))
            .collect();
        let content = format!(
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: {v4_loopback:08X}:1ED2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1\n   1: {v4_loopback:08X}:1ED3 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 4343 1\n   2: {v6_loopback}:0438 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4444 1\n"
        );
        assert_eq!(
            parse_proc_net_tcp(&content),
            vec![
                (IpAddr::V4(Ipv4Addr::LOCALHOST), 7890, 4242),
                (IpAddr::V6(Ipv6Addr::LOCALHOST), 1080, 4444)
            ]
        );
    }

    #[test]
    fn proc_net_route_finds_default_gateway() {
        let gateway = u32::from_ne_bytes([192, 168, 1, 1]);
        let content = format!(
            "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\neth0\t0001A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\neth0\t00000000\t{gateway:08X}\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"
        );
        assert_eq!(
            parse_proc_net_route_gateway(&content),
            Some(Ipv4Addr::new(192, 168, 1, 1))
        );
    }

    #[test]
    fn listening_entries_skip_own_process_and_map_wildcards_to_loopback() {
        let sockets = vec![
            ListeningSocket {
                ip: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
                port: 7890,
                pid: Some(10),
                process_name: Some("mihomo".to_string()),
            },
            ListeningSocket {
                ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
                port: 1420,
                pid: Some(99),
                process_name: Some("liveagent".to_string()),
            },
            ListeningSocket {
                ip: "fe80::1".parse().unwrap(),
                port: 7891,
                pid: Some(10),
                process_name: None,
            },
            ListeningSocket {
                ip: IpAddr::V6(Ipv6Addr::UNSPECIFIED),
                port: 10808,
                pid: None,
                process_name: None,
            },
        ];
        let entries = listening_entries(sockets, 99);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].host, "127.0.0.1");
        assert_eq!(entries[0].port, 7890);
        assert_eq!(entries[0].process_name.as_deref(), Some("mihomo"));
        assert_eq!(entries[1].host, "::1");
        assert_eq!(entries[1].source, ProxySource::Listen);
    }
}
