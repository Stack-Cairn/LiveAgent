//! 隧道端到端测试(P2-30 验收)。
//!
//! 起一个真的上游服务(模拟 dev server),开一条真的隧道,用真的 HTTP 客户端
//! 走隧道端口访问它。这是 P2-30 的验收标准本身:
//! 「前端请求后端隧道路由,能访问到 localhost:5173 的 dev server」。
//!
//! 单测只能覆盖纯函数(`decide_access`/`upstream_url`);监听、认证、转发这条
//! 完整链路只有真跑一遍才算数——路由接错、cookie 没种上、body 没转发,
//! 这些在单测里全是绿的。

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use backend::tunnel::TunnelDataPlane;
use backend::services::tunnel::{TunnelBinding, TunnelDataPlane as _};
use axum::routing::{get, post};
use axum::Router;

const TOKEN: &str = "test-access-token-0123456789abcdef";

/// 起一个模拟的 dev server,返回它的地址。
async fn spawn_upstream() -> String {
    let app = Router::new()
        // 绝对路径的资源——这正是子路径方案需要重写、独立端口方案不需要碰的东西。
        .route("/assets/main.js", get(|| async { "console.log('hi')" }))
        .route("/", get(|| async { "<script src=\"/assets/main.js\"></script>" }))
        .route(
            "/echo",
            post(|body: String| async move { format!("echoed:{body}") }),
        )
        .route(
            "/headers",
            get(|headers: axum::http::HeaderMap| async move {
                // 回显 Cookie，用来断言隧道自己的 cookie 没漏给上游。
                headers
                    .get(axum::http::header::COOKIE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("<none>")
                    .to_string()
            }),
        );
    let listener = tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .expect("bind upstream");
    let addr = listener.local_addr().expect("upstream addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://127.0.0.1:{}", addr.port())
}

/// 不跟随重定向、不带 cookie jar 的裸客户端。
fn raw_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("build client")
}

async fn start_tunnel(target: &str) -> (Arc<TunnelDataPlane>, u16) {
    let plane = Arc::new(TunnelDataPlane::new());
    let port = plane
        .start(TunnelBinding {
            id: "tun_test".to_string(),
            target_url: target.to_string(),
            access_token: TOKEN.to_string(),
        })
        .expect("start tunnel");
    // 给 axum::serve 一点时间真正开始 accept。
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    (plane, port)
}

#[tokio::test]
async fn tunnel_proxies_to_upstream_after_token_handshake() {
    let upstream = spawn_upstream().await;
    let (_plane, port) = start_tunnel(&upstream).await;
    let client = raw_client();
    let base = format!("http://127.0.0.1:{port}");

    // 1. 无凭证 → 401。端口能被扫到，但扫到了也进不去。
    let resp = client.get(&base).send().await.expect("request");
    assert_eq!(resp.status(), 401, "无 token 必须拒绝");

    // 2. 带 token 首访 → 302 + Set-Cookie，且 token 从 Location 里消失。
    let resp = client
        .get(format!("{base}/?t={TOKEN}"))
        .send()
        .await
        .expect("request");
    assert_eq!(resp.status(), 302);
    let cookie = resp
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .expect("Set-Cookie")
        .to_string();
    assert!(cookie.contains("liveagent_tunnel_tun_test="));
    assert!(cookie.contains("HttpOnly"), "cookie 必须 HttpOnly：{cookie}");
    let location = resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .expect("Location");
    assert_eq!(location, "/", "token 必须从地址栏消失");

    // 3. 带 cookie → 真的拿到上游内容。
    let cookie_header = cookie.split(';').next().expect("cookie pair").to_string();
    let resp = client
        .get(&base)
        .header("cookie", &cookie_header)
        .send()
        .await
        .expect("request");
    assert_eq!(resp.status(), 200);
    let body = resp.text().await.expect("body");
    assert!(body.contains("/assets/main.js"), "应拿到上游 HTML：{body}");

    // 4. 关键断言：上游发的绝对路径 /assets/main.js 直接可用，无需任何重写。
    //    这就是「一隧道一端口」让 1000 行重写代码蒸发的原因。
    let resp = client
        .get(format!("{base}/assets/main.js"))
        .header("cookie", &cookie_header)
        .send()
        .await
        .expect("request");
    assert_eq!(resp.status(), 200, "绝对路径必须 1:1 命中，不需要前缀重写");
    assert_eq!(resp.text().await.expect("body"), "console.log('hi')");
}

#[tokio::test]
async fn tunnel_forwards_request_bodies_and_hides_its_own_cookie() {
    let upstream = spawn_upstream().await;
    let (_plane, port) = start_tunnel(&upstream).await;
    let client = raw_client();
    let base = format!("http://127.0.0.1:{port}");
    let cookie_header = format!("liveagent_tunnel_tun_test={TOKEN}");

    // POST body 要原样到上游。
    let resp = client
        .post(format!("{base}/echo"))
        .header("cookie", &cookie_header)
        .body("payload-1234")
        .send()
        .await
        .expect("request");
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.text().await.expect("body"), "echoed:payload-1234");

    // 隧道自己的 cookie 不能漏给上游；用户自己的要留着。
    let resp = client
        .get(format!("{base}/headers"))
        .header("cookie", format!("{cookie_header}; user_session=abc"))
        .send()
        .await
        .expect("request");
    let seen = resp.text().await.expect("body");
    assert!(
        !seen.contains(TOKEN),
        "上游不该看到隧道 token，但收到了：{seen}"
    );
    assert!(seen.contains("user_session=abc"), "用户自己的 cookie 要转发：{seen}");
}

#[tokio::test]
async fn stopping_a_tunnel_closes_its_port() {
    let upstream = spawn_upstream().await;
    let (plane, port) = start_tunnel(&upstream).await;
    let client = raw_client();
    let base = format!("http://127.0.0.1:{port}");

    assert_eq!(plane.running_count(), 1);
    // 起着的时候连得上（401 也算连上了）。
    assert!(client.get(&base).send().await.is_ok());

    plane.stop("tun_test");
    assert_eq!(plane.running_count(), 0);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // 停掉之后端口不再服务。
    assert!(
        client.get(&base).send().await.is_err(),
        "隧道关掉后端口必须不再接受连接"
    );
}

#[tokio::test]
async fn restarting_the_same_id_replaces_the_old_listener() {
    let first = spawn_upstream().await;
    let second = spawn_upstream().await;
    let (plane, first_port) = start_tunnel(&first).await;

    // 同 id 再 start（tunnel_update 改目标走的就是这条路）。
    let second_port = plane
        .start(TunnelBinding {
            id: "tun_test".to_string(),
            target_url: second.clone(),
            access_token: TOKEN.to_string(),
        })
        .expect("restart tunnel");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    assert_eq!(plane.running_count(), 1, "同 id 不该留下两个监听");
    assert_ne!(first_port, second_port, "重启会拿到新端口");

    let client = raw_client();
    let resp = client
        .get(format!("http://127.0.0.1:{second_port}/assets/main.js"))
        .header("cookie", format!("liveagent_tunnel_tun_test={TOKEN}"))
        .send()
        .await
        .expect("request");
    assert_eq!(resp.status(), 200, "新监听要指向新目标");
}

#[tokio::test]
async fn tunnel_rejects_a_token_from_another_tunnel() {
    let upstream = spawn_upstream().await;
    let (_plane, port) = start_tunnel(&upstream).await;
    let client = raw_client();
    let base = format!("http://127.0.0.1:{port}");

    // 另一条隧道的 cookie 名，值即使正确也不该放行。
    let resp = client
        .get(&base)
        .header("cookie", format!("liveagent_tunnel_tun_other={TOKEN}"))
        .send()
        .await
        .expect("request");
    assert_eq!(resp.status(), 401);

    // 错的 token 同样拒绝。
    let resp = client
        .get(format!("{base}/?t=wrong-token"))
        .send()
        .await
        .expect("request");
    assert_eq!(resp.status(), 401);
}

/// 重启后隧道要能自己回来。
///
/// 这条是 P2-31 用 curl 实测抓到的真实缺口：`main.rs` 建完 state 就直接 serve，
/// 从没调过 `TunnelStore::initialize()`，于是规格好好躺在库里但监听没起——
/// 单测和契约测试全绿，重启后隧道却全没了。
///
/// 用 `TunnelStore` 走完整条路（建 → 落库 → 新 store 恢复），而不是只测数据面：
/// 漏掉的正是这两者之间的那一步。
#[tokio::test]
async fn tunnels_are_restored_after_a_restart_with_fresh_ports() {
    use backend::events::EventBus;
    use backend::services::tunnel::{TunnelCreateInput, TunnelStore};

    // 隔离 HOME：TunnelStore 落库到 settings 库，不能碰开发者真实数据。
    let dir = std::env::temp_dir().join(format!("backend-tunnel-restart-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("创建临时 HOME 失败");
    std::env::set_var("HOME", &dir);

    let upstream = spawn_upstream().await;

    // 第一个进程：建一条隧道。
    let first_plane = Arc::new(TunnelDataPlane::new());
    let first = Arc::new(TunnelStore::new(
        Arc::new(EventBus::new()),
        Arc::clone(&first_plane) as Arc<dyn backend::services::tunnel::TunnelDataPlane>,
    ));
    first
        .create(TunnelCreateInput {
            target_url: upstream.clone(),
            name: Some("restart-me".to_string()),
            ttl_seconds: Some(3600),
            project_path_key: None,
        })
        .await
        .expect("create tunnel");
    let before = first.state().expect("state");
    assert_eq!(before.tunnels.len(), 1);
    let old_url = before.tunnels[0].public_url.clone();

    // 模拟进程退出：数据面随之消失。
    drop(first);
    drop(first_plane);

    // 第二个进程：全新 store + 全新数据面，只靠库恢复。
    let second_plane = Arc::new(TunnelDataPlane::new());
    let second = Arc::new(TunnelStore::new(
        Arc::new(EventBus::new()),
        Arc::clone(&second_plane) as Arc<dyn backend::services::tunnel::TunnelDataPlane>,
    ));
    second.initialize().await.expect("initialize");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let after = second.state().expect("state");
    assert_eq!(after.tunnels.len(), 1, "隧道必须从库里恢复");
    let restored = &after.tunnels[0];
    assert_eq!(restored.name, "restart-me");
    assert_eq!(restored.target_url, upstream + "/");
    assert_ne!(restored.port, 0, "恢复的隧道要有真实端口");
    assert_ne!(
        restored.public_url, old_url,
        "端口与 token 都是新的，链接必然变（见 store.rs 模块文档）"
    );

    // 决定性断言：恢复出来的隧道真的能转发。
    let client = raw_client();
    let resp = client
        .get(format!(
            "http://127.0.0.1:{}/assets/main.js",
            restored.port
        ))
        .header(
            "cookie",
            format!(
                "liveagent_tunnel_{}={}",
                restored.id,
                access_token_from_url(&restored.public_url)
            ),
        )
        .send()
        .await
        .expect("request");
    assert_eq!(resp.status(), 200, "恢复的隧道必须真的能转发");
    assert_eq!(resp.text().await.expect("body"), "console.log('hi')");

    // 清理，避免影响同机的其他测试运行。
    second.close(restored.id.clone()).await.expect("close");
}

/// 从 `publicUrl` 里取回访问 token。
fn access_token_from_url(url: &str) -> String {
    url.split("?t=").nth(1).unwrap_or_default().to_string()
}
