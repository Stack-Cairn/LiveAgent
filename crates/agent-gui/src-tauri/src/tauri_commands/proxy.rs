//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use crate::services::proxy::*;
use axum::{
    body::{to_bytes, Body},
    extract::{OriginalUri, Path, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::Response,
    routing::{any, get},
    Router,
};
use base64::Engine as _;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    net::{Ipv4Addr, TcpListener},
    sync::Arc,
    time::Duration,
};
use tokio::net::TcpListener as TokioTcpListener;
use uuid::Uuid;

#[tauri::command]
pub fn proxy_get_server_info(state: tauri::State<'_, Arc<ProxyServerState>>) -> ProxyServerInfo {
    crate::services::proxy::proxy_get_server_info(state.inner())
}
