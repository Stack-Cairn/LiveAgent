//! API 契约测试（P2-29）。
//!
//! 不经前端直接打 JSON API，覆盖 backend.txt 里的后端命令：
//!   - 每条命令都有路由（新增 command 未加路由 → ROUTED_COMMANDS 与 backend.txt 不符 → 失败）
//!   - 每条路由可达（POST /api/<name> 不 404/401/5xx）
//!   - 认证与错误语义（无 token/错 token → 401，畸形 body → 400）
//!
//! 契约清单唯一来源是 docs/architecture/command-classes/backend.txt（阶段起点
//! 8c90a424 已机器核对其与 #[tauri::command] 注册清单一致）。排除集与
//! scripts/generate-routes.mjs 保持一致：12 条无 wrapper（provider_usage_*/
//! workspace_watch_set/system_* 除 5 条 skills 命令）+ 3 条 WS 流式。
//!
//! ⚠️ MemoryStore::open() / AutomationStore::open() / config_db_path() 都从
//! dirs::home_dir() 取路径。测试必须先把 $HOME 重定向到临时目录，否则
//! settings_save_*/memory_wipe_all 等 smoke 会污染开发者真实库。

use std::collections::HashSet;
use std::sync::Arc;

use backend::server::auth;
use backend::server::routed_commands;
use backend::{build_router, build_state};
use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use tower::ServiceExt;

const TOKEN: &str = "test-password";

/// backend.txt 里没有薄包装的命令:`provider_usage_*`/`workspace_watch_set` 与
/// gateway 脱离未完成,`system_*` 未迁移。它们现在不做 HTTP 路由,等对应阶段
/// 补上后移出本列表。
///
/// 隧道 5 条已随 P2-30 重写补齐路由(名字从 `gateway_tunnel_*` 改为 `tunnel_*`),
/// 不再在此列。
const NO_WRAPPER: &[&str] = &[
    "provider_usage_query",
    "provider_usage_test",
    "workspace_watch_set",
    "system_append_debug_jsonl",
    "system_begin_power_activity",
    "system_create_project_folder",
    "system_end_power_activity",
    "system_import_pasted_texts",
    "system_import_readable_file_paths",
    "system_import_uploaded_readable_files",
    "system_read_uploaded_image_preview",
    "system_read_uploaded_native_attachment",
];

/// 流式端点走 WS（/api/events），不做 HTTP 路由。
const WS_STREAM: &[&str] = &[
    "terminal_stream_attach",
    "terminal_stream_input",
    "terminal_stream_resize",
];

fn backend_txt_path() -> &'static str {
    concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/architecture/command-classes/backend.txt"
    )
}

/// 契约期望的命令集：backend.txt 全量 − 无 wrapper − WS 流式。
fn expected_commands() -> HashSet<String> {
    let txt = std::fs::read_to_string(backend_txt_path())
        .unwrap_or_else(|e| panic!("读不到 {}：{e}", backend_txt_path()));
    txt.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|name| !NO_WRAPPER.contains(name) && !WS_STREAM.contains(name))
        .map(str::to_string)
        .collect()
}

/// 把 $HOME 重定向到本次进程专属的临时目录，再建 AppState。
/// 这样每个会写库的命令都落在临时目录，绝不碰开发者真实数据。
/// 用 OnceLock 共享同一个 router：三个测试并发各建一份 state 会同时打开
/// 同一 SQLite 文件（automation WAL），触发 "database is locked"。只建一次，
/// 测试间 clone 即可。build_router 已 `.with_state`，返回 `Router`（即 `Router<()>`）。
fn build_app() -> axum::Router {
    static APP: std::sync::OnceLock<axum::Router> = std::sync::OnceLock::new();
    APP.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!(
            "backend-contract-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建测试 HOME 临时目录失败");
        std::env::set_var("HOME", &dir);
        let state = build_state(Arc::new(auth::AuthConfig::new(TOKEN.to_string())), 0)
            .expect("build_state 失败");
        build_router(state)
    })
    .clone()
}

/// Test A：ROUTED_COMMANDS 与 backend.txt 契约完全一致（双向）。
/// 新增 command 未加路由 → expected 有而 routed 没有 → 失败；
/// 路由表里有多余命令（删了后端命令忘了删路由）→ 同样失败。
#[test]
fn routed_commands_match_expected_contract() {
    let expected = expected_commands();
    let routed: HashSet<String> = routed_commands().iter().map(|s| s.to_string()).collect();
    assert_eq!(routed, expected, "ROUTED_COMMANDS 与 backend.txt 契约不一致");
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
