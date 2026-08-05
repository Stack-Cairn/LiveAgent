//! Node 引擎反向代理。
//!
//! chat 引擎运行在 Node 后端进程。Rust 后端作为前端的唯一网络入口，
//! 代理 chat 相关请求到 Node，同时接收事件回流——两个通道合一。
//!
//! 反向代理路由：
//! - POST /api/chat_send        → http://127.0.0.1:$node_port/chat_send
//! - POST /api/chat_abort       → http://127.0.0.1:$node_port/chat_abort
//! - GET /api/conversation_live → http://127.0.0.1:$node_port/conversation_live
//!
//! 事件回流路由（仅内部 token）：
//! - POST /api/engine_emit_event {event, payload} → 直接广播到 EventBus

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use agent_core::events::EventSink;
use crate::state::AppState;

/// 调用方身份标记，存在 Request extensions 里供 handler 判别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallerIdentity {
    /// 用户通过密码认证。
    User,
    /// 内部服务通过内部 token 认证。
    Internal,
}

/// 引擎事件回流请求体。
#[derive(Debug, Deserialize)]
pub struct EngineEmitEventBody {
    pub event: String,
    pub payload: serde_json::Value,
}

/// 处理引擎事件回流。仅内部 token 可调。
pub async fn handler_engine_emit_event(
    State(state): State<AppState>,
    req: Request,
) -> Response {
    // 从 request extensions 中提取调用方身份。
    let identity = req
        .extensions()
        .get::<CallerIdentity>()
        .copied()
        .unwrap_or(CallerIdentity::User);

    // 检查调用方身份：仅允许内部服务。
    if identity != CallerIdentity::Internal {
        return (StatusCode::FORBIDDEN, "仅内部服务可调此接口").into_response();
    }

    // 读取 body。
    let body_bytes = match axum::body::to_bytes(req.into_body(), usize::MAX).await {
        Ok(b) => b,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, "无法读取请求体").into_response();
        }
    };

    // 解析 JSON。
    let body: EngineEmitEventBody = match serde_json::from_slice(&body_bytes) {
        Ok(b) => b,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, "JSON 解析失败").into_response();
        }
    };

    // 直接广播到 EventBus。
    state.events.emit_json(&body.event, body.payload);

    // 返回 200 OK，不包装。
    (StatusCode::OK, "").into_response()
}

/// 反向代理到 Node 的通用处理。剥掉 /api 前缀后转发。
pub async fn proxy_to_node(
    State(state): State<AppState>,
    req: Request,
) -> Response {
    // 检查 Node 引擎是否已启动。
    let node_port = {
        let port_lock = state.node_port.read().await;
        port_lock.clone()
    };

    let Some(port) = node_port else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "引擎未启动" })),
        )
            .into_response();
    };

    // 重写目标 URL。入口路径如 `/api/chat_send` 剥掉 `/api` 后变 `/chat_send`。
    // 保留 query string，如 `/api/conversation_live?conversationId=x` 转发时不丢 query。
    let path_and_query = req.uri().path_and_query().map(|pq| pq.as_str()).unwrap_or("");
    let target_path = if let Some(stripped) = path_and_query.strip_prefix("/api") {
        stripped
    } else {
        path_and_query
    };
    let target_url = format!("http://127.0.0.1:{}{}", port, target_path);

    // 构造代理请求。保留原始方法与 body；header 不透传（Node 只认内部 token）。
    let method = req.method().clone();
    let (_parts, body) = req.into_parts();

    // 读取 body。
    let body_bytes = match axum::body::to_bytes(body, usize::MAX).await {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "无法读取请求体" })),
            )
                .into_response();
        }
    };

    // 用 reqwest 转发请求。Node 只认内部 token，这里显式带上——
    // parts.headers 不会被 reqwest 自动使用，漏带就是 401。
    let internal_auth = format!("Bearer {}", state.internal_token);
    let client = reqwest::Client::new();
    let response = match method.as_str() {
        "GET" => client
            .get(&target_url)
            .header("authorization", &internal_auth)
            .send()
            .await,
        "POST" => client
            .post(&target_url)
            .header("authorization", &internal_auth)
            .header("content-type", "application/json")
            .body(body_bytes)
            .send()
            .await,
        _ => {
            return (
                StatusCode::METHOD_NOT_ALLOWED,
                "仅支持 GET 和 POST",
            )
                .into_response();
        }
    };

    // 转发 Node 的响应。
    match response {
        Ok(resp) => {
            let status = resp.status();
            let headers = resp.headers().clone();

            match resp.bytes().await {
                Ok(body_bytes) => {
                    let mut response_builder = axum::http::Response::builder().status(status);

                    // 复制 header，但剥掉 hop-by-hop 头。
                    // 因为 body 已通过 resp.bytes() 读完解码，不能再有 Transfer-Encoding 等编码声明。
                    let hop_by_hop = [
                        "transfer-encoding",
                        "connection",
                        "keep-alive",
                        "content-length",
                    ];
                    for (key, value) in headers.iter() {
                        let key_lower = key.as_str().to_lowercase();
                        if !hop_by_hop.contains(&key_lower.as_str()) {
                            response_builder = response_builder.header(key.clone(), value.clone());
                        }
                    }

                    response_builder
                        .body(axum::body::Body::from(body_bytes))
                        .unwrap_or_else(|_| {
                            (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                "响应构造失败",
                            )
                                .into_response()
                        })
                }
                Err(_) => (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": "无法读取 Node 响应体" })),
                )
                    .into_response(),
            }
        }
        Err(err) => {
            eprintln!("引擎代理请求失败：{}", err);
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("无法连接引擎：{}", err) })),
            )
                .into_response()
        }
    }
}

/// 挂载引擎相关路由。
pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/engine_emit_event",
            axum::routing::post(handler_engine_emit_event),
        )
        // 使用单独的路由挂载三条代理路由。
        .route("/chat_send", axum::routing::post(proxy_to_node))
        .route("/chat_abort", axum::routing::post(proxy_to_node))
        .route("/conversation_live", axum::routing::get(proxy_to_node))
}

