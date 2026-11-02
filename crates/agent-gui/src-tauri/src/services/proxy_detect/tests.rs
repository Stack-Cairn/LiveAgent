use super::*;
use tokio::net::TcpListener;

#[derive(Clone, Copy)]
enum FakeServer {
    /// 只认 SOCKS5，收到别的直接断开。
    Socks5 { require_auth: bool },
    /// 只认 HTTP CONNECT，回指定状态码；收到 SOCKS5 问候直接断开。
    HttpProxy { status: u16 },
    /// 两种都认（Clash mixed-port）。
    Mixed,
    /// 普通 Web 服务：任何请求回 404。
    WebServer,
    /// 对任何请求都回带响应体的 200（实测 QQ、MouseInc 的本地端口）。
    AlwaysOk,
    /// 接受连接但从不回应。
    Silent,
}

async fn spawn_fake(server: FakeServer) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut first = [0u8; 1];
                if stream.read_exact(&mut first).await.is_err() {
                    return;
                }
                let is_socks = first[0] == 0x05;
                let reply: Option<Vec<u8>> = match (server, is_socks) {
                    (FakeServer::Silent, _) => {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        None
                    }
                    (FakeServer::Socks5 { require_auth }, true) => {
                        Some(vec![0x05, if require_auth { 0xFF } else { 0x00 }])
                    }
                    (FakeServer::Mixed, true) => Some(vec![0x05, 0x00]),
                    (FakeServer::HttpProxy { status: 407 }, false) => Some(
                        b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"x\"\r\n\r\n"
                            .to_vec(),
                    ),
                    (FakeServer::HttpProxy { status }, false) => {
                        Some(format!("HTTP/1.1 {status} Whatever\r\n\r\n").into_bytes())
                    }
                    (FakeServer::Mixed, false) => {
                        Some(b"HTTP/1.1 200 Connection established\r\n\r\n".to_vec())
                    }
                    (FakeServer::AlwaysOk, _) => {
                        Some(b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nNot Found".to_vec())
                    }
                    (FakeServer::WebServer, _) => {
                        Some(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec())
                    }
                    _ => None,
                };
                if let Some(reply) = reply {
                    let _ = stream.write_all(&reply).await;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            });
        }
    });
    addr
}

#[test]
fn socks5_reply_classification() {
    assert_eq!(
        classify_socks5_reply([0x05, 0x00]),
        Handshake::Proxy {
            auth_required: false
        }
    );
    assert_eq!(
        classify_socks5_reply([0x05, 0xFF]),
        Handshake::Proxy {
            auth_required: true
        }
    );
    assert_eq!(classify_socks5_reply([0x48, 0x54]), Handshake::NotProxy);
}

#[test]
fn http_response_classification() {
    let proxy = Handshake::Proxy {
        auth_required: false,
    };
    for head in [
        &b"HTTP/1.1 200 Connection established\r\n\r\n"[..],
        b"HTTP/1.0 200 Connection established\r\nProxy-agent: example/1.0\r\n\r\n",
        b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
        b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n",
        b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html\r\nContent-Length: 120\r\n\r\n",
        b"HTTP/1.1 504 Gateway Timeout\r\n\r\n",
    ] {
        assert_eq!(
            classify_http_response(head),
            proxy,
            "{}",
            String::from_utf8_lossy(head)
        );
    }
    assert_eq!(
        classify_http_response(
            b"HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm=\"clash\"\r\n\r\n"
        ),
        Handshake::Proxy {
            auth_required: true
        }
    );
    for head in [
        // QQ、MouseInc 的本地服务对任何请求都回带响应体的 200。
        &b"HTTP/1.1 200 \r\nContent-Length: 184\r\n\r\n"[..],
        b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nNot Found",
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
        b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n",
        b"HTTP/1.1 404 Not Found\r\n\r\n",
        b"HTTP/1.1 405 Method Not Allowed\r\n\r\n",
        b"HTTP/1.1 400 Bad Request\r\n\r\n",
        // 头不完整（没读到空行）：长度头可能还在后面。
        b"HTTP/1.1 200 Connection established\r\n",
        b"HTTP/1.1 200 OK\r\nX-Padding: aaaa",
        b"SSH-2.0-OpenSSH_9.6\r\n",
        b"",
    ] {
        assert_eq!(
            classify_http_response(head),
            Handshake::NotProxy,
            "{}",
            String::from_utf8_lossy(head)
        );
    }
}

#[tokio::test]
async fn probe_identifies_proxies_and_rejects_other_services() {
    let socks = spawn_fake(FakeServer::Socks5 {
        require_auth: false,
    })
    .await;
    let socks_auth = spawn_fake(FakeServer::Socks5 { require_auth: true }).await;
    let http = spawn_fake(FakeServer::HttpProxy { status: 502 }).await;
    let http_auth = spawn_fake(FakeServer::HttpProxy { status: 407 }).await;
    let mixed = spawn_fake(FakeServer::Mixed).await;
    let web = spawn_fake(FakeServer::WebServer).await;
    let always_ok = spawn_fake(FakeServer::AlwaysOk).await;
    let silent = spawn_fake(FakeServer::Silent).await;
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap()
    };

    assert_eq!(probe_target(socks).await, Some((ProxyKind::Socks5, false)));
    assert_eq!(
        probe_target(socks_auth).await,
        Some((ProxyKind::Socks5, true))
    );
    assert_eq!(probe_target(http).await, Some((ProxyKind::Http, false)));
    assert_eq!(probe_target(http_auth).await, Some((ProxyKind::Http, true)));
    assert_eq!(probe_target(mixed).await, Some((ProxyKind::Http, false)));
    assert_eq!(probe_target(web).await, None);
    assert_eq!(probe_target(always_ok).await, None);
    assert_eq!(probe_target(silent).await, None);
    assert_eq!(probe_target(closed).await, None);
}

fn entry(host: &str, port: u16, source: ProxySource, name: Option<&str>) -> sources::SourceEntry {
    sources::SourceEntry {
        host: host.to_string(),
        port,
        connect_ip: None,
        process_name: name.map(str::to_string),
        source,
    }
}

#[test]
fn merge_targets_combines_sources_and_orders_by_priority() {
    let loopback: SocketAddr = "127.0.0.1:7890".parse().unwrap();
    let lan: SocketAddr = "10.0.0.2:3128".parse().unwrap();
    let other: SocketAddr = "127.0.0.1:1080".parse().unwrap();
    let targets = merge_targets(vec![
        (
            loopback,
            entry("127.0.0.1", 7890, ProxySource::Listen, Some("mihomo")),
        ),
        (other, entry("127.0.0.1", 1080, ProxySource::Listen, None)),
        (loopback, entry("localhost", 7890, ProxySource::Os, None)),
        (lan, entry("proxy.corp.local", 3128, ProxySource::Env, None)),
    ]);
    assert_eq!(targets.len(), 3);
    assert_eq!(targets[0].addr, loopback);
    assert_eq!(targets[0].host, "127.0.0.1");
    assert_eq!(targets[0].process_name.as_deref(), Some("mihomo"));
    assert_eq!(
        targets[0].sources.iter().copied().collect::<Vec<_>>(),
        vec![ProxySource::Os, ProxySource::Listen]
    );
    assert_eq!(targets[1].host, "proxy.corp.local");
    assert_eq!(targets[2].addr, other);
}

#[test]
fn finalize_drops_ipv6_loopback_duplicates_and_sorts() {
    let make = |host: &str, port: u16, source: ProxySource| DetectedProxy {
        id: format!("http://{host}:{port}"),
        kind: ProxyKind::Http,
        host: host.to_string(),
        port,
        process_name: None,
        sources: vec![source],
        auth_required: false,
    };
    let candidates = finalize_candidates(vec![
        make("::1", 7890, ProxySource::Listen),
        make("127.0.0.1", 7890, ProxySource::Listen),
        make("::1", 1080, ProxySource::Listen),
        make("192.168.1.1", 7890, ProxySource::Gateway),
        make("127.0.0.1", 7897, ProxySource::Os),
    ]);
    let ids: Vec<&str> = candidates.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "http://127.0.0.1:7897",
            "http://::1:1080",
            "http://127.0.0.1:7890",
            "http://192.168.1.1:7890"
        ]
    );
}

#[test]
fn candidate_id_brackets_ipv6_hosts() {
    let target = ProbeTarget {
        addr: "[::1]:1080".parse().unwrap(),
        host: "::1".to_string(),
        process_name: None,
        sources: BTreeSet::from([ProxySource::Listen]),
    };
    let candidate = to_candidate(target, ProxyKind::Socks5, false);
    assert_eq!(candidate.id, "socks5://[::1]:1080");
    let json = serde_json::to_value(&candidate).unwrap();
    assert_eq!(json["type"], "socks5");
    assert_eq!(json["sources"], serde_json::json!(["listen"]));
    assert_eq!(json["authRequired"], false);
    assert!(json["processName"].is_null());
}

#[tokio::test]
async fn test_rejects_proxies_that_were_not_detected() {
    let error = test(ProxyTestInput {
        kind: ProxyKind::Http,
        host: "203.0.113.9".to_string(),
        port: 8080,
    })
    .await
    .unwrap_err();
    assert!(error.contains("检测到"), "{error}");
}

/// 起一个只接受连接、对每个连接按顺序回几段固定字节（段间隔 50ms）后保持或关闭连接的服务。
async fn spawn_canned(segments: Vec<Vec<u8>>, close_after: bool) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let segments = segments.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf).await;
                for segment in segments {
                    let _ = stream.write_all(&segment).await;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                if !close_after {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            });
        }
    });
    addr
}

/// 对任何请求回 200 的 Web 服务，长度头排在一个很长的头之后：读满上限仍没读到空行，
/// 或在上限内读到长度头，都不能判成代理（评审发现，修复前被判成 HTTP 代理）。
#[tokio::test]
async fn always_ok_web_server_with_long_headers_is_not_a_proxy() {
    for repeat in [150, 600] {
        let reply = format!(
            "HTTP/1.1 200 OK\r\nContent-Security-Policy: {}\r\nContent-Type: text/html\r\nContent-Length: 9\r\n\r\nNot Found",
            "default-src 'self'; ".repeat(repeat)
        )
        .into_bytes();
        let addr = spawn_canned(vec![reply], false).await;
        assert_eq!(probe_target(addr).await, None, "header repeat {repeat}");
    }
}

/// 200 之后紧跟正文（同一段或稍后单独一段到达）：代理建立隧道后会等客户端先发数据，
/// 不会主动送字节过来（评审发现，修复前被判成 HTTP 代理）。
#[tokio::test]
async fn ok_followed_by_body_bytes_is_not_a_proxy() {
    assert_eq!(
        classify_http_response(
            b"HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\n<html><body>hello</body></html>"
        ),
        Handshake::NotProxy
    );
    let addr = spawn_canned(
        vec![
            b"HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\n".to_vec(),
            b"<html>hello</html>".to_vec(),
        ],
        true,
    )
    .await;
    assert_eq!(probe_target(addr).await, None);
}

/// mihomo 先回 200 再拨号，拨号失败（probe.invalid 解析不到）就直接断开：仍是代理。
#[tokio::test]
async fn ok_then_close_still_counts_as_proxy() {
    let addr = spawn_canned(
        vec![b"HTTP/1.1 200 Connection established\r\n\r\n".to_vec()],
        true,
    )
    .await;
    assert_eq!(probe_target(addr).await, Some((ProxyKind::Http, false)));
}
