//! 与错误契约一致的 JSON 提取器。
//!
//! axum 自带的 `Json` 在 body 反序列化失败时回 422、Content-Type 不对时回 415,
//! 且都是纯文本——而本服务承诺**所有**失败都是 400 + `{ "error": ... }`
//! (见 routes.rs 模块文档)。这里包一层,把所有提取失败折进同一个形状,
//! 让「没有例外」真的没有例外。

use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

pub struct Json<T>(pub T);

impl<S, T> FromRequest<S> for Json<T>
where
    axum::Json<T>: FromRequest<S, Rejection = JsonRejection>,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match axum::Json::<T>::from_request(req, state).await {
            Ok(axum::Json(value)) => Ok(Self(value)),
            Err(rejection) => Err((
                StatusCode::BAD_REQUEST,
                axum::Json(json!({ "error": rejection.body_text() })),
            )
                .into_response()),
        }
    }
}
