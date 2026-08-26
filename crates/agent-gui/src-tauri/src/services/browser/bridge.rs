//! 扩展桥接：本地 WebSocket 服务，接受 LiveAgent 浏览器扩展（MV3，
//! `crates/agent-gui/browser-extension/`）的反向连接。扩展用 `chrome.debugger`
//! 在用户日常浏览器里中继 CDP——自动化因此复用用户的登录态，且不用另起
//! 浏览器进程。协议线型与原生 CDP 完全一致（{id,method,params,sessionId} /
//! {id,result|error} / 事件），Rust 侧的 CdpConnection/PageSession 原样复用。
//!
//! 安全边界：只绑 127.0.0.1；握手校验 Origin 为 chrome-extension://（本机
//! 恶意进程仍可伪造该头，与 Claude Code native messaging 相比这是折衷——
//! 扩展侧只暴露自己创建的自动化标签页，攻击面限于"驱动一个新标签页"）。
//! 同一时刻只保留最新连接：扩展重连即替换。

use std::sync::Mutex as StdMutex;
use std::sync::Arc;

use tokio::net::TcpListener;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{
    ErrorResponse, Request, Response as HandshakeResponse,
};

use super::cdp::CdpConnection;

/// 缺省监听端口；可用 LIVEAGENT_BROWSER_BRIDGE_PORT 覆盖（扩展侧需同步改）。
const DEFAULT_BRIDGE_PORT: u16 = 19_222;

pub(crate) fn bridge_port() -> u16 {
    std::env::var("LIVEAGENT_BROWSER_BRIDGE_PORT")
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_BRIDGE_PORT)
}

#[derive(Default)]
pub(crate) struct ExtensionBridge {
    latest: StdMutex<Option<Arc<CdpConnection>>>,
}

impl ExtensionBridge {
    /// 启动监听 task。绑定失败（端口被占等）只打日志不阻断 app 启动——
    /// 桥接不可用时 BrowserManager 自动回退 launcher 模式。
    pub(crate) fn start(self: &Arc<Self>) {
        let bridge = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let port = bridge_port();
            let listener = match TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("browser extension bridge: bind 127.0.0.1:{port} failed: {error}");
                    return;
                }
            };
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                let ws = accept_hdr_async(stream, verify_extension_origin).await;
                match ws {
                    Ok(ws) => {
                        let connection = CdpConnection::from_stream(ws);
                        if let Ok(mut latest) = bridge.latest.lock() {
                            *latest = Some(connection);
                        }
                    }
                    Err(error) => {
                        eprintln!("browser extension bridge: handshake rejected: {error}");
                    }
                }
            }
        });
    }

    /// 当前存活的扩展连接（已断开的连接视同无）。
    pub(crate) fn live_connection(&self) -> Option<Arc<CdpConnection>> {
        self.latest
            .lock()
            .ok()?
            .as_ref()
            .filter(|connection| !connection.is_closed())
            .cloned()
    }
}

/// 只接受浏览器扩展发起的握手：Chromium 系扩展 service worker 的 WebSocket
/// 请求带 Origin: chrome-extension://<id>。
fn verify_extension_origin(
    request: &Request,
    response: HandshakeResponse,
) -> Result<HandshakeResponse, ErrorResponse> {
    let origin_ok = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(|origin| origin.starts_with("chrome-extension://"))
        .unwrap_or(false);
    if origin_ok {
        Ok(response)
    } else {
        let mut rejection = ErrorResponse::new(Some("forbidden origin".to_string()));
        *rejection.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
        Err(rejection)
    }
}
