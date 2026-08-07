//! API 契约测试。
//!
//! 不经前端直接打 JSON API，覆盖后端命令：
//!   - 每条路由可达（POST /api/<name> 不 404/401/5xx）
//!   - 认证与错误语义（无 token/错 token → 401，畸形 body → 400）
//!
//! 路由完整性由 scripts/generate-routes.mjs 保证：routes_gen.rs 从 wrapper 层
//! 生成，CI 里 make check-routes 校验两者一致——新增 command 未重新生成路由
//! 会在那里失败，不再需要第二份手工清单对拍。
//!
//! ⚠️ MemoryStore::open() / AutomationStore::open() / config_db_path() 都从
//! dirs::home_dir() 取路径。测试必须先把 $HOME 重定向到临时目录，否则
//! settings_save_*/memory_wipe_all 等 smoke 会污染开发者真实库。

use std::sync::Arc;

use backend::server::auth;
use backend::server::routed_commands;
use backend::{build_router, build_state};
use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use tower::ServiceExt;

const TOKEN: &str = "test-password";

/// 把 $HOME 重定向到本次进程专属的临时目录，再建 AppState。
/// 这样每个会写库的命令都落在临时目录，绝不碰开发者真实数据。
/// 用 OnceLock 共享同一个 router：三个测试并发各建一份 state 会同时打开
/// 同一 SQLite 文件（automation WAL），触发 "database is locked"。只建一次，
/// 测试间 clone 即可。build_router 已 `.with_state`，返回 `Router`（即 `Router<()>`）。
fn shared_app() -> &'static (axum::Router, String) {
    static APP: std::sync::OnceLock<(axum::Router, String)> = std::sync::OnceLock::new();
    APP.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!(
            "backend-contract-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建测试 HOME 临时目录失败");
        std::env::set_var("HOME", &dir);
        let auth = Arc::new(auth::AuthConfig::new(TOKEN.to_string()));
        // 引擎凭据也从这一份 AuthConfig 里发，测试才测得到真实的那把钥匙。
        let engine_token = auth.rotate_engine_token();
        let state = build_state(auth, 0).expect("build_state 失败");
        (build_router(state), engine_token)
    })
}

fn build_app() -> axum::Router {
    shared_app().0.clone()
}

/// 与运行中的 router 共用同一份 AuthConfig 的引擎凭据。
fn engine_token() -> String {
    shared_app().1.clone()
}

/// Test B：每条路由都可达——POST /api/<name> 带合法 token 和空 body，
/// 绝不 404（路由不存在）/401（认证）/5xx（服务端错误）。
/// 200（无参命令成功）或 400（需参数，{} 反序列化失败）都算可达。
#[tokio::test]
async fn every_route_is_reachable() {
    let app = build_app();
    let mut failures = Vec::new();
    for &name in routed_commands() {
        let req = Request::builder()
            .method(Method::POST)
            .uri(format!("/api/{name}"))
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .expect("构造请求失败");
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            app.clone().oneshot(req),
        )
        .await;
        let resp = match result {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                failures.push(format!("{name}: 请求失败 {e}"));
                continue;
            }
            Err(_) => {
                failures.push(format!("{name}: 超时"));
                continue;
            }
        };
        let status = resp.status();
        if status == StatusCode::NOT_FOUND
            || status == StatusCode::UNAUTHORIZED
            || status.is_server_error()
        {
            failures.push(format!("{name}: 意外状态 {status}"));
        }
    }
    assert!(failures.is_empty(), "不可达路由：\n{}", failures.join("\n"));
}

/// Test D：几条代表性命令带**真实参数**打过去，必须真的成功（200 且带 `ok`）。
///
/// Test B 只验「可达」——400 也算通过，所以一条「路由挂上了但底层根本没初始化」
/// 的命令能骗过它。P2-31 用 curl 实测时就抓到过：`build_state` 漏了
/// `initialize_history_db()`，`chat_history_list` 路由可达但报
/// "no such table: chatHistory"。这个测试就是那次回归的守卫。
#[tokio::test]
async fn representative_commands_actually_succeed() {
    let app = build_app();
    // (命令, 参数) —— 覆盖各自依赖不同存储的子系统。
    let cases: &[(&str, &str)] = &[
        // history 库（曾经漏建表）
        ("chat_history_list", r#"{"page":1,"pageSize":5}"#),
        // settings 库
        ("settings_load_all", "{}"),
        // automation 库
        ("automation_snapshot", "{}"),
        // memory 库
        ("memory_index_overview", "{}"),
        // 内存态 registry
        ("terminal_list", "{}"),
        // 隧道（P2-30）：store 建好了才回得出快照
        ("tunnel_state", "{}"),
    ];
    let mut failures = Vec::new();
    for (name, body) in cases {
        let req = Request::builder()
            .method(Method::POST)
            .uri(format!("/api/{name}"))
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(*body))
            .expect("构造请求失败");
        let resp = app.clone().oneshot(req).await.expect("请求失败");
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .expect("读响应体失败");
        let text = String::from_utf8_lossy(&bytes).to_string();
        if status != StatusCode::OK {
            failures.push(format!("{name}: 状态 {status}，体 {text}"));
        } else if !text.contains("\"ok\"") {
            failures.push(format!("{name}: 200 但没有 ok 字段：{text}"));
        }
    }
    assert!(
        failures.is_empty(),
        "以下命令路由可达但实际不可用：\n{}",
        failures.join("\n")
    );
}

/// Test C：认证与错误语义。缺 token / 错 token → 401，畸形 body → 400。
#[tokio::test]
async fn auth_and_error_semantics() {
    let app = build_app();

    // 缺 Authorization header → 401
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/git_status")
        .body(Body::empty())
        .expect("构造请求失败");
    let resp = app.clone().oneshot(req).await.expect("请求失败");
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // 错密码 → 401
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/git_status")
        .header(header::AUTHORIZATION, "Bearer wrong-password")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .expect("构造请求失败");
    let resp = app.clone().oneshot(req).await.expect("请求失败");
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // 畸形 body → 400（Json 反序列化失败）
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/git_status")
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{"))
        .expect("构造请求失败");
    let resp = app.clone().oneshot(req).await.expect("请求失败");
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // 合法 JSON 但缺必填字段 → 也必须是 400 + {"error": ...}。
    // axum 默认给 422 纯文本，会把按契约解析错误体的客户端炸掉（crate::server::json::Json 的存在理由）。
    let assert_error_shape = |status: StatusCode, bytes: &[u8], case: &str| {
        assert_eq!(status, StatusCode::BAD_REQUEST, "{case}: 状态必须是 400");
        let value: serde_json::Value =
            serde_json::from_slice(bytes).unwrap_or_else(|e| panic!("{case}: 错误体不是 JSON：{e}"));
        assert!(
            value.get("error").is_some(),
            "{case}: 错误体必须带 error 字段：{value}"
        );
    };

    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat_history_list")
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"page":1}"#))
        .expect("构造请求失败");
    let resp = app.clone().oneshot(req).await.expect("请求失败");
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
        .await
        .expect("读响应体失败");
    assert_error_shape(status, &bytes, "缺必填字段");

    // 没带 Content-Type → 同样 400 + {"error": ...}（axum 默认是 415 纯文本）。
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat_history_list")
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
        .body(Body::from(r#"{"page":1,"pageSize":5}"#))
        .expect("构造请求失败");
    let resp = app.clone().oneshot(req).await.expect("请求失败");
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
        .await
        .expect("读响应体失败");
    assert_error_shape(status, &bytes, "缺 Content-Type");
}

/// Test D：loopback 不再是身份。
///
/// 原来这里有一条按来源地址放行的豁免，本机 core 靠它无凭据回流。但
/// `CorsLayer::permissive` 之下「来自本机」谁都能伪造——浏览器里任意一个页面
/// 猜中端口就能无凭据调 `shell_run`。现在 core 带 per-spawn 的引擎凭据，
/// 豁免整个删掉：回环地址不带凭据一律 401，带引擎凭据则与带密码等价。
#[tokio::test]
async fn loopback_without_credentials_is_rejected() {
    let app = build_app();
    let engine_token = engine_token();
    let loopback = axum::extract::ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 54321)));

    let call = |uri: &'static str, bearer: Option<String>| {
        let app = app.clone();
        // ConnectInfo 是 Copy：闭包按引用捕获，这里解引用取一份值。
        let loopback = *loopback;
        async move {
            let mut builder = Request::builder()
                .method(Method::POST)
                .uri(uri)
                .header(header::CONTENT_TYPE, "application/json");
            if let Some(bearer) = bearer {
                builder = builder.header(header::AUTHORIZATION, format!("Bearer {bearer}"));
            }
            let mut req = builder.body(Body::from("{}")).expect("构造请求失败");
            req.extensions_mut().insert(loopback);
            app.oneshot(req).await.expect("请求失败").status()
        }
    };

    // 回环 + 无凭据 → 401，连 core 自己的回流路径也不例外。
    for uri in ["/api/engine_emit_event", "/api/settings_load_all", "/api/shell_run"] {
        assert_eq!(
            call(uri, None).await,
            StatusCode::UNAUTHORIZED,
            "{uri}：来自回环地址不构成身份"
        );
    }

    // 回环 + 引擎凭据 → 放行（后面可能 400/500，但绝不能是 401）。
    for uri in ["/api/engine_emit_event", "/api/settings_load_all"] {
        assert_ne!(
            call(uri, Some(engine_token.clone())).await,
            StatusCode::UNAUTHORIZED,
            "{uri}：core 带引擎凭据必须能回流"
        );
    }

    // 编的凭据不行（轮换失效由 auth.rs 的单测覆盖）。
    assert_eq!(
        call("/api/settings_load_all", Some("not-a-token".to_string())).await,
        StatusCode::UNAUTHORIZED,
        "随便编的凭据必须 401"
    );
}
