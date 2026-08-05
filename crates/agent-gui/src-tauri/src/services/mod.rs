//! 壳专属服务。其余已迁入 agent-core。
//!
//! - `gateway` / `gateway_bridge`：过渡设施，阶段 4 删除
//! - `tunnel`：按 P1-07 需重写（P2-30）
//! - `proxy`：给 webview 供图的本地 HTTP 服务，阶段 2 末由 agent-backend 取代
//! - `tray`：托盘，前端专属

pub mod gateway;
pub mod gateway_bridge;
pub mod proxy;
pub mod tray;
