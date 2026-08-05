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
//!
//! 路由本身由 `scripts/generate-routes.mjs` 从 `tauri_commands/*.rs` 生成
//! （`routes_gen.rs`），本文件只保留公共的响应组装与对外入口。
//!
//! 自定义路由（不是 tauri 命令）单独在本模块定义和挂载。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::routes_gen;
use crate::state::AppState;

/// 把命令的 `Result<T, E>` 转成 HTTP 响应。
///
/// 业务失败一律 400 而不是 500：命令返回 `Err` 表示「这次请求做不到」
/// （路径不存在、参数不合法、仓库不是 git 仓库），不是服务端崩了。
/// 真正的 500 留给 panic 和序列化失败。
///
/// 状态码刻意保持 200/400 两档（P2-25）：与 Tauri IPC 语义一致（Err 就是失败），
/// 错误体已带字符串，前端在读。补细状态码（404/403）需要逐个命令审计错误来源。
pub(crate) fn respond<T: serde::Serialize, E: serde::Serialize>(result: Result<T, E>) -> Response {
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

/// 工具审批请求。Node 调此接口时会长时间挂起，直到前端应答或超时。
#[derive(Debug, Deserialize)]
pub struct ToolApprovalRequestBody {
    pub tool_name: String,
    pub summary: String,
    #[serde(rename = "recommended")]
    pub recommended: Option<String>, // "approve" | "deny" | "approve_session"
}

/// 工具审批请求的响应。
#[derive(Debug, Serialize)]
pub struct ToolApprovalRequestResponse {
    pub decision: String, // "approve" | "deny" | "approve_session"
}

/// 处理工具审批请求（内部，Node 调）。
/// Node 在执行工具前调此接口，长时间挂起直到前端作出决定。
async fn handler_tool_approval_request(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(body): Json<ToolApprovalRequestBody>,
) -> Response {
    // 解析推荐项。
    let recommended = body.recommended.as_deref().and_then(|s| match s {
        "approve" => Some(crate::approval::Decision::Approve),
        "deny" => Some(crate::approval::Decision::Deny),
        "approve_session" => Some(crate::approval::Decision::ApproveSession),
        _ => None,
    });

    let payload = crate::approval::ApprovalPayload {
        tool_name: body.tool_name,
        summary: body.summary,
        recommended,
    };

    // 发起审批请求，长时间等待直到应答或超时。
    // 注意：此处会 await 很久（最多 60 秒左右），这是正常的。
    let (_, decision) = state
        .approvals
        .request(payload, 60000, state.events.clone())
        .await;

    // 转换为字符串响应。
    let decision_str = match decision {
        crate::approval::Decision::Approve => "approve",
        crate::approval::Decision::Deny => "deny",
        crate::approval::Decision::ApproveSession => "approve_session",
    };

    respond::<ToolApprovalRequestResponse, String>(Ok(ToolApprovalRequestResponse {
        decision: decision_str.to_string(),
    }))
}

/// 工具审批应答请求。
#[derive(Debug, Deserialize)]
pub struct ToolApprovalRespondBody {
    pub approval_id: String,
    pub decision: String, // "approve" | "deny" | "approve_session"
}

/// 处理工具审批应答（前端调）。
/// 前端通过此接口告诉后端用户的审批决定。
async fn handler_tool_approval_respond(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(body): Json<ToolApprovalRespondBody>,
) -> Response {
    // 解析决定。
    let decision = match body.decision.as_str() {
        "approve" => crate::approval::Decision::Approve,
        "deny" => crate::approval::Decision::Deny,
        "approve_session" => crate::approval::Decision::ApproveSession,
        _ => {
            return respond(Err::<(), String>(
                format!("无效的决定值：{}", body.decision),
            ))
        }
    };

    // 应答。respond 返回 Ok(()) 成功或 Err("AlreadyAnswered") 若该审批已被应答过。
    match state
        .approvals
        .respond(&body.approval_id, decision, "frontend")
        .await
    {
        Ok(()) => respond(Ok::<(), String>(())),
        Err(err) => {
            // AlreadyAnswered 应该返回 409（Conflict），但 respond 约定只用 200/400。
            // 这里特殊处理：返回 409 + { "error": "AlreadyAnswered" }。
            if err == "AlreadyAnswered" {
                (
                    StatusCode::CONFLICT,
                    Json(json!({ "error": err })),
                )
                    .into_response()
            } else {
                respond(Err::<(), String>(err))
            }
        }
    }
}

pub fn api_router() -> Router<AppState> {
    // 手动挂载自定义路由（approval 和 engine_proxy）。
    Router::new()
        .route(
            "/tool_approval_request",
            axum::routing::post(handler_tool_approval_request),
        )
        .route(
            "/tool_approval_respond",
            axum::routing::post(handler_tool_approval_respond),
        )
        .merge(crate::engine_proxy::router())
        .merge(routes_gen::gen_router())
}

/// 已挂路由的命令名。契约测试（P2-29）拿它和 agent-core 导出的命令清单比对，
/// 「新增 command 未加路由」必须导致测试失败。与生成器保持单一来源。
pub fn routed_commands() -> &'static [&'static str] {
    routes_gen::ROUTED_COMMANDS
}
