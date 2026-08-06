//! chat 路由：前端与 pi 引擎之间的那三条接口。
//!
//! 这里以前是到 Node 引擎的反向代理（`engine_proxy`），现在引擎在进程内，
//! 三条路由直接落到 `PiSessionManager`：
//!
//! - `POST /api/chat_send`        → 受理一条消息，202
//! - `POST /api/chat_abort`       → 中止当前运行
//! - `GET  /api/conversation_live` → live 快照，无会话 404
//!
//! 事件回流路由（`POST /api/engine_emit_event`）随 Node 一起没了：事件现在
//! 由翻译层直接打进 EventBus，不再绕一圈 HTTP。
//!
//! 响应形状严格照旧（见 docs/design/pi-rpc-event-contract.md §4），
//! 前端零改动是这次迁移的铁律。

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::pi::ChatSendRequest;
use crate::server::state::AppState;

/// 受理一条消息。
///
/// 202 而不是 200：这里只表示**收下了**，实际生成结果走 WS 事件。
/// body 包一层 `ok` 是全局约定（前端 `parseResponse` 会拆它）。
async fn handler_chat_send(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    // 先收成 Value 再转结构体，是为了让「字段不对」也走统一的 `{error}` 形状；
    // 直接用 `Json<ChatSendRequest>` 的话 axum 会回一段 text/plain，
    // 前端 parseResponse 只能报 "invalid JSON"，排查时看不出是哪个字段。
    let request: ChatSendRequest = match serde_json::from_value(body) {
        Ok(request) => request,
        Err(error) => return bad_request(format!("chat_send 请求体不合法：{error}")),
    };

    match state.pi_sessions.chat_send(request).await {
        Ok(accepted) => (StatusCode::ACCEPTED, Json(json!({ "ok": accepted }))).into_response(),
        Err(error) => bad_request(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAbortRequest {
    conversation_id: String,
}

async fn handler_chat_abort(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let request: ChatAbortRequest = match serde_json::from_value(body) {
        Ok(request) => request,
        Err(error) => return bad_request(format!("chat_abort 请求体不合法：{error}")),
    };

    let aborted = state.pi_sessions.abort(request.conversation_id.trim()).await;
    (StatusCode::OK, Json(json!({ "ok": { "aborted": aborted } }))).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationLiveQuery {
    conversation_id: String,
}

/// live 快照。404 表示**内存里没有这个会话**，不表示会话不存在——
/// 这个区分是现有契约的一部分，前端靠它判断要不要走恢复流程。
async fn handler_conversation_live(
    State(state): State<AppState>,
    Query(query): Query<ConversationLiveQuery>,
) -> Response {
    match state.pi_sessions.live_snapshot(query.conversation_id.trim()) {
        Some(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "该会话没有 live 状态" })),
        )
            .into_response(),
    }
}

fn bad_request(message: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": message.into() })),
    )
        .into_response()
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/chat_send", axum::routing::post(handler_chat_send))
        .route("/chat_abort", axum::routing::post(handler_chat_abort))
        .route(
            "/conversation_live",
            axum::routing::get(handler_conversation_live),
        )
}
