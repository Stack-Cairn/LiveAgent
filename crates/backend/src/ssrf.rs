//! SSRF（服务端请求伪造）防护。
//!
//! 包含 IP 黑名单、URL 验证、域名解析与检查等核心防护机制。
//! 调用方必须使用这里的函数来校验所有外部请求的目标地址。

// Url 从 reqwest 转出来用，不额外引 url crate：连接最终就是交给 reqwest 发的，
// 两处用同一个解析器才不会出现「校验时是一个 host、请求时是另一个」。
use reqwest::Url;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// URL 解析结果，包含 host 和 port。
#[derive(Debug, Clone)]
pub struct UrlParts {
    pub host: String,
    pub port: u16,
}

/// 检查 IP 地址是否在黑名单中。
///
/// # IP 黑名单清单
///
/// **IPv4：**
/// - 10.0.0.0/8 - 私有网段
/// - 172.16.0.0/12 - 私有网段
/// - 192.168.0.0/16 - 私有网段
/// - 127.0.0.0/8 - Loopback
/// - 169.254.0.0/16 - Link-local
/// - 100.64.0.0/10 - Carrier-grade NAT
/// - 0.0.0.0/8 - 当前网络
/// - 255.255.255.255/32 - 广播
/// - 224.0.0.0/4 - 组播
/// - 240.0.0.0/4 - 保留
///
/// **IPv6：**
/// - ::1/128 - Loopback
/// - ::/128 - 未指定地址
/// - fe80::/10 - Link-local
/// - fc00::/7 - 唯一本地地址
/// - ff00::/8 - 组播
/// - 64:ff9b::/96 - NAT64（需递归检查内嵌 IPv4）
/// - 2002::/16 - 6to4（需递归检查内嵌 IPv4）
/// - ::ffff:0:0/96 - IPv4-mapped IPv6（需递归检查内嵌 IPv4）
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => is_blocked_ipv4(ipv4),
        IpAddr::V6(ipv6) => is_blocked_ipv6(ipv6),
    }
}

/// 检查 IPv4 地址是否被拦截。
fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();

    // 10.0.0.0/8
    if octets[0] == 10 {
        return true;
    }

    // 172.16.0.0/12
    if octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31 {
        return true;
    }

    // 192.168.0.0/16
    if octets[0] == 192 && octets[1] == 168 {
        return true;
    }

    // 127.0.0.0/8 - Loopback
    if octets[0] == 127 {
        return true;
    }

    // 169.254.0.0/16 - Link-local
    if octets[0] == 169 && octets[1] == 254 {
        return true;
    }

    // 100.64.0.0/10 - CGNAT
    if octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127 {
        return true;
    }

    // 0.0.0.0/8
    if octets[0] == 0 {
        return true;
    }

    // 255.255.255.255/32 - 广播
    if ip == Ipv4Addr::BROADCAST {
        return true;
    }

    // 224.0.0.0/4 - 组播
    if octets[0] >= 224 && octets[0] <= 239 {
        return true;
    }

    // 240.0.0.0/4 - 保留
    if octets[0] >= 240 {
        return true;
    }

    false
}

/// 检查 IPv6 地址是否被拦截。
fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    // ::1/128 - Loopback
    if ip == Ipv6Addr::LOCALHOST {
        return true;
    }

    // ::/128 - 未指定地址
    if ip == Ipv6Addr::UNSPECIFIED {
        return true;
    }

    // fe80::/10 - Link-local
    // 前 10 位固定为 1111111010，对应 0xfe80 到 0xfebf
    if (ip.segments()[0] & 0xffc0) == 0xfe80 {
        return true;
    }

    // fc00::/7 - 唯一本地地址（fc00::/7 和 fd00::/7）
    // 前 7 位固定，对应 0xfc00 到 0xfdff
    if (ip.segments()[0] & 0xfe00) == 0xfc00 {
        return true;
    }

    // ff00::/8 - 组播
    if ip.segments()[0] >> 8 == 0xff {
        return true;
    }

    // IPv4-mapped IPv6: ::ffff:0:0/96
    // 形式：::ffff:a.b.c.d 或 ::ffff:c0a8:1（16进制）
    if ip.segments()[0..6] == [0, 0, 0, 0, 0, 0xffff] {
        // segments[6] 和 segments[7] 组成 IPv4 地址
        let ipv4 = Ipv4Addr::new(
            (ip.segments()[6] >> 8) as u8,
            ip.segments()[6] as u8,
            (ip.segments()[7] >> 8) as u8,
            ip.segments()[7] as u8,
        );
        return is_blocked_ipv4(ipv4);
    }

    // 6to4: 2002::/16
    // 形式：2002:aabb:ccdd::（其中 aabb:ccdd 是 IPv4 的 4 个八位组）
    if ip.segments()[0] == 0x2002 {
        let ipv4 = Ipv4Addr::new(
            (ip.segments()[1] >> 8) as u8,
            ip.segments()[1] as u8,
            (ip.segments()[2] >> 8) as u8,
            ip.segments()[2] as u8,
        );
        return is_blocked_ipv4(ipv4);
    }

    // NAT64: 64:ff9b::/96
    // 形式：64:ff9b:0:0:0:0:aabb:ccdd（最后 32 bit 是 IPv4）
    if ip.segments()[0] == 0x0064
        && ip.segments()[1] == 0xff9b
        && ip.segments()[2] == 0
        && ip.segments()[3] == 0
        && ip.segments()[4] == 0
        && ip.segments()[5] == 0
    {
        let ipv4 = Ipv4Addr::new(
            (ip.segments()[6] >> 8) as u8,
            ip.segments()[6] as u8,
            (ip.segments()[7] >> 8) as u8,
            ip.segments()[7] as u8,
        );
        return is_blocked_ipv4(ipv4);
    }

    false
}

/// 验证 URL，返回提取的 host 和 port。
///
/// # 检查项
/// - 仅允许 http 和 https scheme
/// - 拒绝 URL 中的嵌入用户名密码
/// - 确保 port 为标准端口（http:80, https:443）或显式指定
///
/// # 返回
/// 成功返回 `UrlParts { host, port }`，失败返回错误信息。
pub fn validate_url(raw: &str) -> Result<UrlParts, String> {
    let url = Url::parse(raw).map_err(|e| format!("无效的URL: {}", e))?;

    // 检查 scheme
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err(format!("不支持的 scheme: {}", url.scheme())),
    }

    // 拒绝嵌入的用户名密码
    if url.username() != "" || url.password().is_some() {
        return Err("不允许URL中包含用户名或密码".to_string());
    }

    // 获取 host
    let host = url.host_str().ok_or("URL缺少有效的主机名")?.to_string();

    // 获取 port，使用 default_port() 处理标准端口
    let port = url.port().unwrap_or_else(|| match url.scheme() {
        "https" => 443,
        _ => 80,
    });

    Ok(UrlParts { host, port })
}

/// 解析域名并验证所有解析结果的 IP 地址。
///
/// 本函数执行异步 DNS 查询，并逐个检查返回的 IP 地址是否在黑名单中。
/// 只要有一个 IP 被拦截，整个操作就失败。
///
/// # 重要提示：DNS rebinding 防护
///
/// 为了防止 DNS rebinding 攻击（攻击者在第一次 DNS 查询返回公网 IP，
/// 第二次查询返回内网 IP），调用方**必须**使用 reqwest 的 `resolve()` 方法
/// 将连接钉死在本函数返回的已校验 IP 列表上：
///
/// ```ignore
/// let socket_addrs = resolve_and_validate("example.com", 80).await?;
/// let mut client_builder = reqwest::Client::builder();
/// for addr in &socket_addrs {
///     client_builder = client_builder.resolve("example.com", *addr);
/// }
/// let client = client_builder.build()?;
/// // 使用 client 发起请求，则无法 rebind 到其他 IP
/// ```
///
/// # 返回
/// 成功返回通过校验的 `SocketAddr` 列表。列表不为空保证全部 IP 都合法。
/// 失败返回错误信息（包含被拦截的 IP）。
pub async fn resolve_and_validate(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    use std::str::FromStr;

    // 首先尝试直接解析为 IP 地址（如果 host 本身是 IP）
    if let Ok(ip) = IpAddr::from_str(host) {
        if is_blocked_ip(ip) {
            return Err(format!("IP地址 {} 在黑名单中", ip));
        }
        return Ok(vec![SocketAddr::new(ip, port)]);
    }

    // 使用 tokio::net::lookup_host 进行异步 DNS 解析
    let lookup_string = format!("{}:{}", host, port);
    let addrs = tokio::net::lookup_host(&lookup_string)
        .await
        .map_err(|e| format!("DNS查询失败: {}", e))?;

    let mut validated_addrs = Vec::new();

    for socket_addr in addrs {
        let ip = socket_addr.ip();
        if is_blocked_ip(ip) {
            return Err(format!("主机 {} 解析得到被拦截的IP: {}", host, ip));
        }
        validated_addrs.push(socket_addr);
    }

    // 解析出 0 个地址不能算通过：调用方要拿这个列表去 reqwest 的 resolve() 钉死连接，
    // 空列表钉不住任何东西，等于把 DNS 决定权还给了系统解析器。
    if validated_addrs.is_empty() {
        return Err(format!("主机 {host} 没有解析出任何地址"));
    }

    if validated_addrs.is_empty() {
        return Err(format!("无法解析主机: {}", host));
    }

    Ok(validated_addrs)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============ IPv4 黑名单测试 ============

    #[test]
    fn test_ipv4_private_10() {
        // 拒绝: 10.0.0.0/8
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(10, 255, 255, 255))));

        // 通过: 9.255.255.255 和 11.0.0.0
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(9, 255, 255, 255))));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(11, 0, 0, 0))));
    }

    #[test]
    fn test_ipv4_private_172() {
        // 拒绝: 172.16.0.0/12
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(172, 31, 255, 255))));

        // 通过: 172.15.255.255 和 172.32.0.0
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(172, 15, 255, 255))));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(172, 32, 0, 0))));
    }

    #[test]
    fn test_ipv4_private_192() {
        // 拒绝: 192.168.0.0/16
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 255, 255))));

        // 通过: 192.167.255.255 和 192.169.0.0
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(
            192, 167, 255, 255
        ))));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(192, 169, 0, 0))));
    }

    #[test]
    fn test_ipv4_loopback() {
        // 拒绝: 127.0.0.0/8
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(127, 255, 255, 255))));

        // 通过
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(
            126, 255, 255, 255
        ))));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(128, 0, 0, 0))));
    }

    #[test]
    fn test_ipv4_link_local() {
        // 拒绝: 169.254.0.0/16
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 255, 255))));

        // 通过
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(
            169, 253, 255, 255
        ))));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(169, 255, 0, 0))));
    }

    #[test]
    fn test_ipv4_cgnat() {
        // 拒绝: 100.64.0.0/10
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(100, 127, 255, 255))));

        // 通过
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(100, 63, 255, 255))));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(100, 128, 0, 0))));
    }

    #[test]
    fn test_ipv4_zero_network() {
        // 拒绝: 0.0.0.0/8
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(0, 0, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(0, 255, 255, 255))));

        // 通过
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(1, 0, 0, 0))));
    }

    #[test]
    fn test_ipv4_broadcast() {
        // 拒绝: 255.255.255.255
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::BROADCAST)));

        // 255.255.255.254 也拒绝：它落在 240/4 保留段里。
        // 「只有 .255 是广播」是常见误解——240/4 整段都不可路由。
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(255, 255, 255, 254))));
    }

    #[test]
    fn test_ipv4_multicast() {
        // 拒绝: 224.0.0.0/4
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(239, 255, 255, 255))));

        // 通过
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(
            223, 255, 255, 255
        ))));
    }

    #[test]
    fn test_ipv4_reserved() {
        // 拒绝: 240.0.0.0/4
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(240, 0, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(255, 255, 255, 254))));

        // 239.255.255.255 是 224/4 多播的上界，同样拒绝。
        // 240/4 的下界是 240.0.0.0，两段首尾相接不留缝。
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(239, 255, 255, 255))));
        // 223.255.255.255 是多播段之下的最后一个公网地址，必须放行。
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(
            223, 255, 255, 255
        ))));
    }

    #[test]
    fn test_ipv4_public_pass() {
        // 公网地址应通过
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)))); // Cloudflare DNS
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)))); // Google DNS
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(200, 0, 0, 1))));
    }

    // ============ IPv6 黑名单测试 ============

    #[test]
    fn test_ipv6_loopback() {
        // 拒绝: ::1
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));

        // 通过: ::2
        assert!(!is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0, 0, 0, 0, 0, 0, 0, 2
        ))));
    }

    #[test]
    fn test_ipv6_unspecified() {
        // 拒绝: ::
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
    }

    #[test]
    fn test_ipv6_link_local() {
        // 拒绝: fe80::/10（fe80 到 febf）
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xfe80, 0, 0, 0, 0, 0, 0, 1
        ))));
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xfe80, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff
        ))));
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xfea0, 0, 0, 0, 0, 0, 0, 1
        ))));
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xfebf, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff
        ))));

        // 通过: fe7f::（在 fe80 之前）
        assert!(!is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xfe7f, 0, 0, 0, 0, 0, 0, 1
        ))));

        // 通过: fec0::（超过 febf，不在 link-local 范围）
        assert!(!is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xfec0, 0, 0, 0, 0, 0, 0, 1
        ))));
    }

    #[test]
    fn test_ipv6_unique_local() {
        // 拒绝: fc00::/7 和 fd00::/7
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xfc00, 0, 0, 0, 0, 0, 0, 1
        ))));
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xfd00, 0, 0, 0, 0, 0, 0, 1
        ))));

        // 通过: fb00::
        assert!(!is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xfb00, 0, 0, 0, 0, 0, 0, 1
        ))));

        // 通过: fe00::
        assert!(!is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xfe00, 0, 0, 0, 0, 0, 0, 1
        ))));
    }

    #[test]
    fn test_ipv6_multicast() {
        // 拒绝: ff00::/8
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xff00, 0, 0, 0, 0, 0, 0, 1
        ))));
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff
        ))));

        // 通过: fe00::
        assert!(!is_blocked_ip(IpAddr::V6(Ipv6Addr::new(
            0xfe00, 0, 0, 0, 0, 0, 0, 1
        ))));
    }

    #[test]
    fn test_ipv6_ipv4_mapped() {
        // IPv4-mapped: ::ffff:127.0.0.1 应被拒绝（内嵌 loopback）
        // 127.0.0.1 = 0x7f000001
        let ipv4_loopback_mapped = Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001);
        assert!(is_blocked_ip(IpAddr::V6(ipv4_loopback_mapped)));

        // IPv4-mapped: ::ffff:192.168.1.1 应被拒绝（内嵌私有网段）
        // 192.168.1.1 = 0xc0a8:0101
        let ipv4_private_mapped = Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0101);
        assert!(is_blocked_ip(IpAddr::V6(ipv4_private_mapped)));

        // IPv4-mapped: ::ffff:1.1.1.1 应通过（公网地址）
        // 1.1.1.1 = 0x0101:0101
        let ipv4_public_mapped = Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x0101, 0x0101);
        assert!(!is_blocked_ip(IpAddr::V6(ipv4_public_mapped)));
    }

    #[test]
    fn test_ipv6_6to4() {
        // 6to4: 2002:aabb:ccdd:: 内嵌 aa:bb:cc:dd（IPv4 形式）
        // 2002:7f00:0001:: 内嵌 127.0.0.1，应被拒绝
        let ipv6_6to4_loopback = Ipv6Addr::new(0x2002, 0x7f00, 0x0001, 0, 0, 0, 0, 0);
        assert!(is_blocked_ip(IpAddr::V6(ipv6_6to4_loopback)));

        // 2002:c0a8:0101:: 内嵌 192.168.1.1，应被拒绝
        let ipv6_6to4_private = Ipv6Addr::new(0x2002, 0xc0a8, 0x0101, 0, 0, 0, 0, 0);
        assert!(is_blocked_ip(IpAddr::V6(ipv6_6to4_private)));

        // 2002:0101:0101:: 内嵌 1.1.1.1，应通过
        let ipv6_6to4_public = Ipv6Addr::new(0x2002, 0x0101, 0x0101, 0, 0, 0, 0, 0);
        assert!(!is_blocked_ip(IpAddr::V6(ipv6_6to4_public)));
    }

    #[test]
    fn test_ipv6_nat64() {
        // NAT64: 64:ff9b:0:0:0:0:aabb:ccdd
        // 64:ff9b::7f00:1 内嵌 127.0.0.1，应被拒绝
        let ipv6_nat64_loopback = Ipv6Addr::new(0x0064, 0xff9b, 0, 0, 0, 0, 0x7f00, 0x0001);
        assert!(is_blocked_ip(IpAddr::V6(ipv6_nat64_loopback)));

        // 64:ff9b::c0a8:101 内嵌 192.168.1.1，应被拒绝
        let ipv6_nat64_private = Ipv6Addr::new(0x0064, 0xff9b, 0, 0, 0, 0, 0xc0a8, 0x0101);
        assert!(is_blocked_ip(IpAddr::V6(ipv6_nat64_private)));

        // 64:ff9b::0101:0101 内嵌 1.1.1.1，应通过
        let ipv6_nat64_public = Ipv6Addr::new(0x0064, 0xff9b, 0, 0, 0, 0, 0x0101, 0x0101);
        assert!(!is_blocked_ip(IpAddr::V6(ipv6_nat64_public)));
    }

    #[test]
    fn test_ipv6_public_pass() {
        // 公网 IPv6 应通过
        // 2606:4700::1111 (Cloudflare DNS)
        let ipv6_public = Ipv6Addr::new(0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111);
        assert!(!is_blocked_ip(IpAddr::V6(ipv6_public)));
    }

    // ============ URL 验证测试 ============

    #[test]
    fn test_validate_url_http() {
        let result = validate_url("http://example.com/path").unwrap();
        assert_eq!(result.host, "example.com");
        assert_eq!(result.port, 80);
    }

    #[test]
    fn test_validate_url_https() {
        let result = validate_url("https://example.com/path").unwrap();
        assert_eq!(result.host, "example.com");
        assert_eq!(result.port, 443);
    }

    #[test]
    fn test_validate_url_explicit_port() {
        let result = validate_url("http://example.com:8080/path").unwrap();
        assert_eq!(result.host, "example.com");
        assert_eq!(result.port, 8080);
    }

    #[test]
    fn test_validate_url_with_credentials_rejected() {
        let result = validate_url("http://user:pass@example.com/path");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("用户名或密码"));
    }

    #[test]
    fn test_validate_url_ftp_rejected() {
        let result = validate_url("ftp://example.com/file");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不支持的 scheme"));
    }

    #[test]
    fn test_validate_url_invalid() {
        let result = validate_url("not a url");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_url_with_username_only() {
        let result = validate_url("http://user@example.com/path");
        assert!(result.is_err());
    }

    // ============ 异步域名解析测试 ============

    #[tokio::test]
    async fn test_resolve_direct_ip_public() {
        // 直接给定公网 IP，应通过
        let result = resolve_and_validate("1.1.1.1", 80).await;
        assert!(result.is_ok());
        let addrs = result.unwrap();
        assert!(!addrs.is_empty());
    }

    #[tokio::test]
    async fn test_resolve_direct_ip_loopback_rejected() {
        // 直接给定 loopback，应拒绝
        let result = resolve_and_validate("127.0.0.1", 80).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("黑名单"));
    }

    #[tokio::test]
    async fn test_resolve_direct_ip_private_rejected() {
        // 直接给定私有 IP，应拒绝
        let result = resolve_and_validate("192.168.1.1", 80).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("黑名单"));
    }

    #[tokio::test]
    async fn test_resolve_direct_ipv6_loopback_rejected() {
        // 直接给定 IPv6 loopback，应拒绝
        let result = resolve_and_validate("::1", 80).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("黑名单"));
    }

    #[tokio::test]
    async fn test_resolve_localhost() {
        // localhost 解析为 127.0.0.1，应被拒绝
        let result = resolve_and_validate("localhost", 80).await;
        let error = result.expect_err("localhost 解析到回环地址，必须拒绝");
        // 断言错误点出了具体 IP，而不是断言某句措辞——措辞会变，「说清是哪个 IP 被拦」
        // 才是这条错误信息存在的意义。
        assert!(
            error.contains("127.0.0.1") || error.contains("::1"),
            "错误信息没说明是哪个 IP 被拦截：{error}"
        );
    }
}
