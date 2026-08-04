//! 命令路由。
//!
//! 每条路由都是同一个形状，没有例外：
//!
//! ```text
//! POST /api/<command_name>   body = { 参数对象，key 与 #[tauri::command] 的参数名逐字一致 }
//!   → 200 { "ok": <返回值> }        命令返回 Ok
//!   → 400 { "error": "<消息>" }     命令返回 Err（业务失败）
//! ```
//!
//! 返回值包一层 `ok` 而不是裸放，是因为一部分命令返回 `()`——裸放会得到 `null`，
//! 和「返回了 null」分不开。包一层让 200 永远是一个对象。
//!
//! 参数结构体逐命令生成，`serde` 的 `rename_all` **必须与该命令的
//! `#[tauri::command(rename_all = ...)]` 一致**：写了 `snake_case` 的用 snake_case，
//! 没写的用 camelCase（Tauri 的默认）。这是前端契约，不能统一。

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;

/// 把命令的 `Result<T, String>` 转成 HTTP 响应。
///
/// 业务失败一律 400 而不是 500：命令返回 `Err(String)` 表示「这次请求做不到」
/// （路径不存在、参数不合法、仓库不是 git 仓库），不是服务端崩了。
/// 真正的 500 留给 panic 和序列化失败。
///
/// ⚠️ 已知不足（P2-25）：约 9 个返回 `Result<(), String>` 的命令无法区分
/// 「成功」「不存在」「无权限」，全都落在 200/400 两档里。补细状态码需要
/// 逐个命令看错误来源，不是这里能糊的。
fn respond<T: serde::Serialize, E: serde::Serialize>(result: Result<T, E>) -> Response {
    match result {
        Ok(value) => match serde_json::to_value(value) {
            Ok(value) => (StatusCode::OK, Json(json!({ "ok": value }))).into_response(),
            Err(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("序列化返回值失败：{error}") })),
            )
                .into_response(),
        },
        // 错误按**原样**序列化，不 stringify：多数命令的错误是 `String`，
        // 但 fs_* 返回的是结构化的 `FsCommandError`（code / path / didYouMean），
        // 前端现在就在读这些字段。转成字符串等于把它们扔掉。
        Err(error) => match serde_json::to_value(error) {
            Ok(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
            Err(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("序列化错误值失败：{error}") })),
            )
                .into_response(),
        },
    }
}

// ---------------------------------------------------------------------------
// 代表性路由（P2-23）：先验证约定，再批量推剩下的。
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct GitStatusArgs {
    workdir: String,
}

async fn git_status(Json(args): Json<GitStatusArgs>) -> Response {
    respond(agent_core::commands::git::git_status(args.workdir).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct FsReadTextArgs {
    workdir: String,
    path: String,
    start_line: Option<usize>,
    limit: Option<usize>,
    page_start: Option<usize>,
    page_limit: Option<usize>,
    cell_start: Option<usize>,
    cell_limit: Option<usize>,
}

async fn fs_read_text(Json(args): Json<FsReadTextArgs>) -> Response {
    respond(
        agent_core::commands::fs::fs_read_text(
            args.workdir,
            args.path,
            args.start_line,
            args.limit,
            args.page_start,
            args.page_limit,
            args.cell_start,
            args.cell_limit,
        )
        .await,
    )
}

/// `settings_load_all` 无参数。仍然走 POST 且允许空 body——
/// 让 195 条路由是同一个形状，客户端不必记「哪些是 GET」。
async fn settings_load_all() -> Response {
    respond(agent_core::commands::settings::settings_load_all().await)
}

/// 带 state 的代表：97/177 条命令需要从 `AppState` 取 registry 句柄。
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct AutomationSnapshotArgs {}

async fn automation_snapshot(
    State(state): State<AppState>,
    _args: Option<Json<AutomationSnapshotArgs>>,
) -> Response {
    respond(agent_core::commands::cron::automation_snapshot(&state.automation_store).await)
}

pub fn api_router() -> Router<AppState> {
    Router::new()
        .route("/git_status", post(git_status))
        .route("/fs_read_text", post(fs_read_text))
        .route("/settings_load_all", post(settings_load_all))
        .route("/automation_snapshot", post(automation_snapshot))
}

/// 已挂路由的命令名。契约测试（P2-29）拿它和 agent-core 导出的命令清单比对，
/// 「新增 command 未加路由」必须导致测试失败。
pub fn routed_commands() -> Vec<&'static str> {
    vec![
        "git_status",
        "fs_read_text",
        "settings_load_all",
        "automation_snapshot",
    ]
}
