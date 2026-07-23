//! v2 线协议（WebSocket+Protobuf）客户端传输层：URL 推导、子协议建连、hello 握手、prost 帧编解码。
//! 一切失败（建连、握手、鉴权被拒）均以错误消息上抛，由连接层统一退避重连。
//! 本模块刻意不依赖 tauri，
//! 便于纯 tokio 测试；业务信封收发主循环由 connection.rs / terminal.rs 驱动。

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use prost::Message as ProstMessage;
use reqwest::Url;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use super::ensure_rustls_crypto_provider;
use super::gateway_proto::v2;

/// v2 WebSocket 子协议名（与 Go 侧 `pbws.Subprotocol` 一致；服务端必须回显）。
pub(crate) const GATEWAY_WS_SUBPROTOCOL: &str = "liveagent.v2.pb";
/// v2 协议版本号（`ClientHello.protocol_version`）。
pub(crate) const GATEWAY_WS_PROTOCOL_VERSION: u32 = 2;
/// 桌面端主链路路径。
pub(crate) const GATEWAY_WS_AGENT_PATH: &str = "/ws/v2/agent";
/// 终端数据面路径。
pub(crate) const GATEWAY_WS_TERMINAL_PATH: &str = "/ws/v2/terminal";
/// 鉴权失败时服务端的自定义关闭码（Go 侧 `closeCodeUnauthorized`）。
pub(crate) const GATEWAY_WS_CLOSE_CODE_UNAUTHORIZED: u16 = 4401;
/// 建连 + hello 应答的整体超时。
pub(crate) const GATEWAY_WS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// 从网关基址推导 v2 WS URL：http→ws、https→wss，保留路径前缀（反代子路径），丢弃查询串与片段。
/// 端口取设置里的 `gateway_port`，非零时覆盖基址端口，与界面预览拼法一致。
pub(crate) fn build_ws_url(
    gateway_url: &str,
    gateway_port: u16,
    path: &str,
) -> Result<String, String> {
    let trimmed = gateway_url.trim();
    if trimmed.is_empty() {
        return Err("gateway URL is empty".to_string());
    }
    let mut url = Url::parse(trimmed).map_err(|e| format!("invalid gateway URL: {e}"))?;
    let ws_scheme = match url.scheme() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        _ => return Err("gateway URL must start with http:// or https://".to_string()),
    };
    url.set_scheme(ws_scheme)
        .map_err(|_| "failed to apply websocket scheme to gateway URL".to_string())?;
    if gateway_port != 0 {
        url.set_port(Some(gateway_port))
            .map_err(|_| "failed to apply gateway port to websocket URL".to_string())?;
    }
    url.set_query(None);
    url.set_fragment(None);
    let base_path = url.path().trim_end_matches('/').to_string();
    url.set_path(&format!("{base_path}{path}"));
    Ok(url.to_string())
}

/// 构造 v2 hello 载荷：桌面端两条链路均以 CLIENT_ROLE_AGENT 建连。
pub(crate) fn build_client_hello(
    token: &str,
    agent_id: String,
    agent_version: String,
) -> v2::ClientHello {
    v2::ClientHello {
        protocol_version: GATEWAY_WS_PROTOCOL_VERSION,
        role: v2::ClientRole::Agent as i32,
        token: token.trim().to_string(),
        agent_id,
        agent_version: agent_version.clone(),
        client_name: "desktop".to_string(),
        client_version: agent_version,
    }
}

/// prost 编码为一条 WS 二进制消息（v2 约定：一帧一消息，无长度前缀）。
pub(crate) fn encode_ws_frame<M: ProstMessage>(frame: &M) -> Message {
    Message::Binary(frame.encode_to_vec().into())
}

/// 从 WS 二进制消息解码一条 prost 帧。
pub(crate) fn decode_ws_frame<M: ProstMessage + Default>(data: &[u8]) -> Result<M, String> {
    M::decode(data).map_err(|error| format!("decode gateway v2 frame failed: {error}"))
}

/// ServerHello 校验：ok=false 即鉴权被拒（服务端随即以 4401 关闭），透传服务端消息。
pub(crate) fn vet_server_hello(hello: v2::ServerHello) -> Result<v2::ServerHello, String> {
    if hello.ok {
        return Ok(hello);
    }
    let message = hello.message.trim();
    Err(if message.is_empty() {
        "gateway authentication failed".to_string()
    } else {
        message.to_string()
    })
}

/// hello 应答前收到关闭帧的错误消息：4401 透传鉴权拒绝原因，其余带上关闭码。
pub(crate) fn pre_hello_close_error(frame: Option<&CloseFrame>) -> String {
    match frame {
        Some(frame) if u16::from(frame.code) == GATEWAY_WS_CLOSE_CODE_UNAUTHORIZED => {
            let reason = frame.reason.trim();
            if reason.is_empty() {
                "gateway authentication failed".to_string()
            } else {
                reason.to_string()
            }
        }
        Some(frame) => format!(
            "gateway v2 connection closed before hello (code {})",
            u16::from(frame.code)
        ),
        None => "gateway v2 connection closed before hello".to_string(),
    }
}

/// 建立 v2 主链路（/ws/v2/agent）：建连并完成 hello 握手，返回流与 ServerHello。
pub(crate) async fn connect_agent_ws(
    url: &str,
    hello: v2::ClientHello,
) -> Result<(WsStream, v2::ServerHello), String> {
    let frame = encode_ws_frame(&v2::AgentClientFrame {
        payload: Some(v2::agent_client_frame::Payload::Hello(hello)),
    });
    connect_and_hello(url, frame, decode_agent_server_hello).await
}

/// 建立 v2 终端数据面链路：连接 /ws/v2/terminal（角色 AGENT），流程同主链路。
pub(crate) async fn connect_terminal_ws(
    url: &str,
    hello: v2::ClientHello,
) -> Result<(WsStream, v2::ServerHello), String> {
    let frame = encode_ws_frame(&v2::TerminalClientFrame {
        payload: Some(v2::terminal_client_frame::Payload::Hello(hello)),
    });
    connect_and_hello(url, frame, decode_terminal_server_hello).await
}

fn decode_agent_server_hello(data: &[u8]) -> Result<Option<v2::ServerHello>, String> {
    let frame: v2::AgentServerFrame = decode_ws_frame(data)?;
    Ok(match frame.payload {
        Some(v2::agent_server_frame::Payload::Hello(hello)) => Some(hello),
        _ => None,
    })
}

fn decode_terminal_server_hello(data: &[u8]) -> Result<Option<v2::ServerHello>, String> {
    let frame: v2::TerminalServerFrame = decode_ws_frame(data)?;
    Ok(match frame.payload {
        Some(v2::terminal_server_frame::Payload::Hello(hello)) => Some(hello),
        _ => None,
    })
}

/// 建连 + hello 握手的公共骨架，整体受 [`GATEWAY_WS_HANDSHAKE_TIMEOUT`] 约束。
async fn connect_and_hello(
    url: &str,
    hello_frame: Message,
    decode_hello: fn(&[u8]) -> Result<Option<v2::ServerHello>, String>,
) -> Result<(WsStream, v2::ServerHello), String> {
    let handshake = async {
        let mut stream = connect_ws(url).await?;
        stream
            .send(hello_frame)
            .await
            .map_err(|error| format!("send gateway v2 hello failed: {error}"))?;
        let hello = await_server_hello(&mut stream, decode_hello).await?;
        Ok((stream, hello))
    };
    tokio::time::timeout(GATEWAY_WS_HANDSHAKE_TIMEOUT, handshake)
        .await
        .map_err(|_| "gateway v2 handshake timed out".to_string())?
}

/// 以 v2 子协议发起 WS 升级并校验服务端回显（旧网关兜底路由可能接受升级却不认识 v2 帧）。
async fn connect_ws(url: &str) -> Result<WsStream, String> {
    if url.starts_with("wss://") {
        // rustls 连接器复用进程级默认 crypto provider（ensure_rustls_crypto_provider 负责唯一一次 ring 安装）。
        ensure_rustls_crypto_provider();
    }
    let mut request = url
        .into_client_request()
        .map_err(|error| format!("build gateway v2 request failed: {error}"))?;
    request.headers_mut().insert(
        SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(GATEWAY_WS_SUBPROTOCOL),
    );
    let (stream, response) = connect_async(request)
        .await
        .map_err(|error| format!("gateway v2 connect failed: {error}"))?;
    let echoed = response
        .headers()
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if echoed != GATEWAY_WS_SUBPROTOCOL {
        return Err(format!(
            "gateway v2 subprotocol mismatch: expected {GATEWAY_WS_SUBPROTOCOL:?}, got {echoed:?}"
        ));
    }
    Ok(stream)
}

/// 等待 ServerHello；hello 前容忍 Ping/Pong 控制帧，其余帧按协议错误（hello 必为首帧）。
async fn await_server_hello(
    stream: &mut WsStream,
    decode_hello: fn(&[u8]) -> Result<Option<v2::ServerHello>, String>,
) -> Result<v2::ServerHello, String> {
    loop {
        match stream.next().await {
            None => return Err(pre_hello_close_error(None)),
            Some(Err(error)) => return Err(format!("gateway v2 hello receive failed: {error}")),
            Some(Ok(Message::Binary(data))) => {
                return match decode_hello(&data)? {
                    Some(hello) => vet_server_hello(hello),
                    None => Err("gateway v2 sent a non-hello first frame".to_string()),
                };
            }
            Some(Ok(Message::Close(frame))) => return Err(pre_hello_close_error(frame.as_ref())),
            // WS 控制帧（Ping/Pong）不参与握手语义。
            Some(Ok(_)) => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::gateway::proto;
    use tokio_tungstenite::tungstenite::handshake::server::{
        Request as ServerRequest, Response as ServerResponse,
    };
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

    #[test]
    fn build_ws_url_maps_http_to_ws() {
        // 端口框（gateway_port）与界面预览一致：无条件覆盖基址端口。
        assert_eq!(
            build_ws_url(
                "http://gateway.example.com:8080",
                8080,
                GATEWAY_WS_AGENT_PATH
            )
            .expect("build ws url"),
            "ws://gateway.example.com:8080/ws/v2/agent"
        );
    }

    #[test]
    fn build_ws_url_applies_configured_port_to_portless_base() {
        // 回归用例：端口单独存于 gateway_port、基址不带端口时，曾因未补端口导致 v2 拨到 80。
        assert_eq!(
            build_ws_url("http://127.0.0.1", 50052, GATEWAY_WS_AGENT_PATH)
                .expect("build ws url with configured port"),
            "ws://127.0.0.1:50052/ws/v2/agent"
        );
    }

    #[test]
    fn build_ws_url_overrides_explicit_base_port() {
        // 界面预览的语义：端口框优先于基址里写的端口。
        assert_eq!(
            build_ws_url(
                "http://gateway.example.com:9999",
                50052,
                GATEWAY_WS_AGENT_PATH
            )
            .expect("build ws url overriding base port"),
            "ws://gateway.example.com:50052/ws/v2/agent"
        );
    }

    #[test]
    fn build_ws_url_maps_https_to_wss() {
        assert_eq!(
            build_ws_url("https://gateway.example.com", 443, GATEWAY_WS_TERMINAL_PATH)
                .expect("build wss url"),
            "wss://gateway.example.com/ws/v2/terminal"
        );
    }

    #[test]
    fn build_ws_url_preserves_base_path_and_strips_query() {
        assert_eq!(
            build_ws_url(
                " https://gateway.example.com/liveagent/?token=x#frag ",
                443,
                GATEWAY_WS_AGENT_PATH
            )
            .expect("build ws url with base path"),
            "wss://gateway.example.com/liveagent/ws/v2/agent"
        );
    }

    #[test]
    fn build_ws_url_rejects_bad_input() {
        assert!(build_ws_url("", 50052, GATEWAY_WS_AGENT_PATH).is_err());
        assert!(build_ws_url("   ", 50052, GATEWAY_WS_AGENT_PATH).is_err());
        assert!(build_ws_url("ftp://gateway.example.com", 50052, GATEWAY_WS_AGENT_PATH).is_err());
        assert!(build_ws_url("not a url", 50052, GATEWAY_WS_AGENT_PATH).is_err());
    }

    #[test]
    fn vet_server_hello_classifies_auth_rejection() {
        let ok = vet_server_hello(v2::ServerHello {
            ok: true,
            session_id: "session-1".to_string(),
            ..Default::default()
        })
        .expect("ok hello passes");
        assert_eq!(ok.session_id, "session-1");

        assert_eq!(
            vet_server_hello(v2::ServerHello {
                ok: false,
                message: " unauthorized ".to_string(),
                ..Default::default()
            }),
            Err("unauthorized".to_string())
        );
        assert_eq!(
            vet_server_hello(v2::ServerHello::default()),
            Err("gateway authentication failed".to_string())
        );
    }

    #[test]
    fn pre_hello_close_error_surfaces_unauthorized_reason() {
        // 4401 透传服务端拒绝原因；其余关闭码/无关闭帧给出带上下文的握手失败消息。
        let unauthorized = CloseFrame {
            code: CloseCode::from(GATEWAY_WS_CLOSE_CODE_UNAUTHORIZED),
            reason: "unauthorized".into(),
        };
        assert_eq!(pre_hello_close_error(Some(&unauthorized)), "unauthorized");

        let normal = CloseFrame {
            code: CloseCode::Normal,
            reason: "".into(),
        };
        assert!(pre_hello_close_error(Some(&normal)).contains("closed before hello (code"));
        assert_eq!(
            pre_hello_close_error(None),
            "gateway v2 connection closed before hello"
        );
    }

    fn echo_subprotocol(
        _request: &ServerRequest,
        mut response: ServerResponse,
    ) -> Result<ServerResponse, tokio_tungstenite::tungstenite::handshake::server::ErrorResponse>
    {
        response.headers_mut().insert(
            SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static(GATEWAY_WS_SUBPROTOCOL),
        );
        Ok(response)
    }

    async fn read_binary(ws: &mut WebSocketStream<TcpStream>) -> Vec<u8> {
        loop {
            match ws.next().await.expect("ws frame").expect("ws message") {
                Message::Binary(data) => return data.to_vec(),
                _ => continue,
            }
        }
    }

    #[tokio::test]
    async fn agent_handshake_and_envelope_roundtrip() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local listener");
        let addr = listener.local_addr().expect("local addr");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept tcp");
            let mut ws = tokio_tungstenite::accept_hdr_async(stream, echo_subprotocol)
                .await
                .expect("accept ws");

            // 首帧必须是携带 AGENT 角色与令牌的 hello。
            let hello_frame: v2::AgentClientFrame =
                decode_ws_frame(&read_binary(&mut ws).await).expect("decode hello frame");
            let Some(v2::agent_client_frame::Payload::Hello(hello)) = hello_frame.payload else {
                panic!("first frame must be hello");
            };
            assert_eq!(hello.protocol_version, GATEWAY_WS_PROTOCOL_VERSION);
            assert_eq!(hello.role, v2::ClientRole::Agent as i32);
            assert_eq!(hello.token, "test-token");
            assert_eq!(hello.client_name, "desktop");

            ws.send(encode_ws_frame(&v2::AgentServerFrame {
                payload: Some(v2::agent_server_frame::Payload::Hello(v2::ServerHello {
                    ok: true,
                    session_id: "session-9".to_string(),
                    heartbeat_period_seconds: 15,
                    ..Default::default()
                })),
            }))
            .await
            .expect("send server hello");

            // 回显一条信封（request_id 原样带回）。
            let envelope_frame: v2::AgentClientFrame =
                decode_ws_frame(&read_binary(&mut ws).await).expect("decode envelope frame");
            let Some(v2::agent_client_frame::Payload::Envelope(envelope)) = envelope_frame.payload
            else {
                panic!("second frame must be an envelope");
            };
            ws.send(encode_ws_frame(&v2::AgentServerFrame {
                payload: Some(v2::agent_server_frame::Payload::Envelope(
                    proto::GatewayEnvelope {
                        request_id: envelope.request_id,
                        timestamp: 1,
                        payload: Some(proto::gateway_envelope::Payload::Ping(proto::PingRequest {
                            timestamp: 1,
                        })),
                    },
                )),
            }))
            .await
            .expect("send envelope reply");
        });

        let (mut ws, server_hello) = connect_agent_ws(
            &format!("ws://{addr}"),
            build_client_hello("test-token", "agent-1".to_string(), "0.0.0".to_string()),
        )
        .await
        .expect("agent ws handshake");
        assert_eq!(server_hello.session_id, "session-9");
        assert_eq!(server_hello.heartbeat_period_seconds, 15);

        ws.send(encode_ws_frame(&v2::AgentClientFrame {
            payload: Some(v2::agent_client_frame::Payload::Envelope(
                proto::AgentEnvelope {
                    request_id: "req-1".to_string(),
                    timestamp: 1,
                    payload: Some(proto::agent_envelope::Payload::Pong(proto::PongResponse {
                        timestamp: 1,
                    })),
                },
            )),
        }))
        .await
        .expect("send envelope");

        let reply = loop {
            match ws
                .next()
                .await
                .expect("reply frame")
                .expect("reply message")
            {
                Message::Binary(data) => {
                    break decode_ws_frame::<v2::AgentServerFrame>(&data).expect("decode reply")
                }
                _ => continue,
            }
        };
        let Some(v2::agent_server_frame::Payload::Envelope(envelope)) = reply.payload else {
            panic!("reply must be an envelope");
        };
        assert_eq!(envelope.request_id, "req-1");

        server.await.expect("server task");
    }

    #[tokio::test]
    async fn agent_handshake_rejection_surfaces_server_message() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local listener");
        let addr = listener.local_addr().expect("local addr");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept tcp");
            let mut ws = tokio_tungstenite::accept_hdr_async(stream, echo_subprotocol)
                .await
                .expect("accept ws");
            let _ = read_binary(&mut ws).await;
            ws.send(encode_ws_frame(&v2::AgentServerFrame {
                payload: Some(v2::agent_server_frame::Payload::Hello(v2::ServerHello {
                    ok: false,
                    message: "unauthorized".to_string(),
                    ..Default::default()
                })),
            }))
            .await
            .expect("send rejection hello");
        });

        let result = connect_agent_ws(
            &format!("ws://{addr}"),
            build_client_hello("bad-token", "agent-1".to_string(), "0.0.0".to_string()),
        )
        .await;
        assert_eq!(result.err(), Some("unauthorized".to_string()));

        server.await.expect("server task");
    }

    #[tokio::test]
    async fn missing_subprotocol_echo_is_a_handshake_failure() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local listener");
        let addr = listener.local_addr().expect("local addr");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept tcp");
            // 不回显子协议：模拟旧网关上恰好接受任意升级的兜底路由。
            let _ws = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept ws");
        });

        let result = connect_agent_ws(
            &format!("ws://{addr}"),
            build_client_hello("test-token", "agent-1".to_string(), "0.0.0".to_string()),
        )
        .await;
        match result.err() {
            Some(message) => {
                assert!(message.contains("subprotocol"), "unexpected: {message}");
            }
            None => panic!("expected handshake failure"),
        }

        server.await.expect("server task");
    }
}
