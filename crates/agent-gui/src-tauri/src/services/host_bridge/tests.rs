use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, put},
    Json, Router,
};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

use super::registration::{advertised_tools, HostBridgeState, HostBridgeStatus};
use super::*;
use crate::commands::settings::RemoteSettingsPayload;
use crate::services::kbrain_backend::KBrainBackendConnection;
use crate::services::tunnel::{validate_tunnel_target_url, TunnelStatusPayload};

// ---------------------------------------------------------------------------
// Fake backend: terminal reads go to a real registry (so its project scoping is
// exercised); tunnel calls are recorded.

#[derive(Debug, Clone, PartialEq)]
enum Call {
    ReadTail(String, Option<String>, Option<usize>),
    State,
    Create(String, Option<String>, Option<u32>),
    Close(String),
    Check(Option<String>),
}

struct FakeBackend {
    terminals: Arc<TerminalSessionRegistry>,
    tunnels_enabled: bool,
    calls: Mutex<Vec<Call>>,
    link: Mutex<FakeLink>,
}

/// Gateway link of the fake: offline by default. Online, a created tunnel is listed
/// `land_after` later (never when `None`), like the real cached state.
#[derive(Default)]
struct FakeLink {
    online: bool,
    land_after: Option<Duration>,
    listed: Vec<String>,
    landing: Option<(tokio::time::Instant, String)>,
}

fn fake_tunnel(id: &str) -> TunnelStatusPayload {
    TunnelStatusPayload {
        id: id.to_string(),
        slug: format!("{id}-slug"),
        name: String::new(),
        target_url: "http://localhost:5173".to_string(),
        public_path: format!("/t/{id}-slug/"),
        created_at: 0,
        expires_at: 0,
        active_connections: 0,
        project_path_key: String::new(),
        local: None,
    }
}

impl FakeBackend {
    fn new(tunnels_enabled: bool) -> Arc<Self> {
        Arc::new(Self {
            terminals: Arc::new(TerminalSessionRegistry::default()),
            tunnels_enabled,
            calls: Mutex::new(Vec::new()),
            link: Mutex::new(FakeLink::default()),
        })
    }

    fn online(land_after: Option<Duration>, listed: &[&str]) -> Arc<Self> {
        let backend = Self::new(true);
        *backend.link.lock().unwrap() = FakeLink {
            online: true,
            land_after,
            listed: listed.iter().map(|id| id.to_string()).collect(),
            landing: None,
        };
        backend
    }

    fn state_reads(&self) -> usize {
        self.calls()
            .iter()
            .filter(|call| **call == Call::State)
            .count()
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    fn record(&self, call: Call) {
        self.calls.lock().unwrap().push(call);
    }
}

#[async_trait]
impl HostBridgeBackend for FakeBackend {
    fn terminal_read_tail(
        &self,
        project_path_key: String,
        session_id: Option<String>,
        max_bytes: Option<usize>,
    ) -> Result<TerminalReadTailResponse, String> {
        self.record(Call::ReadTail(
            project_path_key.clone(),
            session_id.clone(),
            max_bytes,
        ));
        self.terminals
            .read_tail(project_path_key, session_id, max_bytes)
    }

    fn tunnels_enabled(&self) -> bool {
        self.tunnels_enabled
    }

    fn tunnel_public_base_url(&self) -> String {
        "https://gw.example.test:8443".to_string()
    }

    fn tunnel_state(&self) -> Result<TunnelStatePayload, String> {
        self.record(Call::State);
        let mut link = self.link.lock().unwrap();
        if !link.online {
            return Ok(TunnelStatePayload::offline_empty());
        }
        if link
            .landing
            .as_ref()
            .is_some_and(|(at, _)| tokio::time::Instant::now() >= *at)
        {
            let (_, id) = link.landing.take().unwrap();
            link.listed.push(id);
        }
        let mut state = TunnelStatePayload::offline_empty();
        state.agent_online = true;
        state.tunnels = link.listed.iter().map(|id| fake_tunnel(id)).collect();
        Ok(state)
    }

    async fn tunnel_create(&self, input: GatewayTunnelCreateInput) -> Result<(), String> {
        self.record(Call::Create(
            input.target_url.clone(),
            input.name.clone(),
            input.ttl_seconds,
        ));
        // First step of the real `GatewayController::tunnel_create` path.
        validate_tunnel_target_url(&input.target_url)?;
        let mut link = self.link.lock().unwrap();
        if let Some(delay) = link.land_after {
            let id = format!("tun-{}", link.listed.len() + 1);
            link.landing = Some((tokio::time::Instant::now() + delay, id));
        }
        Ok(())
    }

    async fn tunnel_close(&self, tunnel_id: String) -> Result<(), String> {
        self.record(Call::Close(tunnel_id.clone()));
        if tunnel_id == "missing" {
            return Err("tunnel not found".to_string());
        }
        Ok(())
    }

    async fn tunnel_check(&self, tunnel_id: Option<String>) -> Result<(), String> {
        self.record(Call::Check(tunnel_id));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Server + raw HTTP client (raw so tests control every header, including Host).

struct TestServer {
    endpoint: HostBridgeEndpoint,
    addr: SocketAddr,
}

async fn serve(backend: Arc<dyn HostBridgeBackend>) -> TestServer {
    let (listener, endpoint) = bind_loopback().expect("bind host bridge");
    let addr = listener.local_addr().expect("local addr");
    let app = router(endpoint.clone(), backend);
    let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve host bridge");
    });
    TestServer { endpoint, addr }
}

struct RawResponse {
    status: u16,
    headers: String,
    body: Value,
}

async fn raw_request(addr: SocketAddr, head: &str, body: &[u8]) -> RawResponse {
    let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
    let mut request = head.as_bytes().to_vec();
    request.extend_from_slice(body);
    // The server may answer (413) and close before the whole body is written.
    let _ = stream.write_all(&request).await;
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw).await;
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text.split_once("\r\n\r\n").expect("http response");
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .expect("status code");
    RawResponse {
        status,
        headers: head.to_ascii_lowercase(),
        body: serde_json::from_str(body).unwrap_or(Value::Null),
    }
}

impl TestServer {
    fn host(&self) -> String {
        format!("127.0.0.1:{}", self.endpoint.port)
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.endpoint.token())
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        extra_headers: &[(&str, String)],
        body: &str,
    ) -> RawResponse {
        let mut head = format!(
            "{method} {path} HTTP/1.1\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        );
        for (name, value) in extra_headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        raw_request(self.addr, &head, body.as_bytes()).await
    }

    async fn post(&self, command: &str, body: &str) -> RawResponse {
        self.send(
            "POST",
            &format!("/v1/host/{command}"),
            &[("Host", self.host()), ("Authorization", self.auth())],
            body,
        )
        .await
    }
}

// ---------------------------------------------------------------------------
// Listener and token

#[tokio::test]
async fn listener_binds_loopback_only_with_a_fresh_token() {
    let (listener, endpoint) = bind_loopback().expect("bind");
    let addr = listener.local_addr().unwrap();
    assert_eq!(addr.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
    assert!(!addr.ip().is_unspecified());
    assert_ne!(addr.port(), 0);
    assert_eq!(endpoint.url(), format!("http://127.0.0.1:{}", addr.port()));
    // 32 CSPRNG bytes, hex encoded.
    assert_eq!(endpoint.token().len(), TOKEN_BYTES * 2);
    assert!(endpoint.token().chars().all(|c| c.is_ascii_hexdigit()));
    let (_other_listener, other) = bind_loopback().expect("bind again");
    assert_ne!(endpoint.token(), other.token());
}

#[test]
fn endpoint_debug_redacts_the_token() {
    let (_listener, endpoint) = bind_loopback().expect("bind");
    let printed = format!("{endpoint:?}");
    assert!(!printed.contains(endpoint.token()));
    assert!(printed.contains("<redacted>"));
}

// ---------------------------------------------------------------------------
// Guards

#[tokio::test]
async fn requests_without_or_with_wrong_bearer_are_unauthorized() {
    let backend = FakeBackend::new(true);
    let server = serve(backend.clone()).await;
    let missing = server
        .send(
            "POST",
            "/v1/host/gateway_tunnel_state",
            &[("Host", server.host())],
            "{}",
        )
        .await;
    assert_eq!(missing.status, 401);
    assert_eq!(missing.body["ok"], false);
    assert_eq!(missing.body["error"]["code"], "unauthorized");

    let wrong_token = format!("Bearer {}", "0".repeat(TOKEN_BYTES * 2));
    let wrong = server
        .send(
            "POST",
            "/v1/host/gateway_tunnel_state",
            &[("Host", server.host()), ("Authorization", wrong_token)],
            "{}",
        )
        .await;
    assert_eq!(wrong.status, 401);

    let prefix = format!("Bearer {}", &server.endpoint.token()[..10]);
    let truncated = server
        .send(
            "POST",
            "/v1/host/gateway_tunnel_state",
            &[("Host", server.host()), ("Authorization", prefix)],
            "{}",
        )
        .await;
    assert_eq!(truncated.status, 401);

    let basic = server
        .send(
            "POST",
            "/v1/host/gateway_tunnel_state",
            &[
                ("Host", server.host()),
                (
                    "Authorization",
                    format!("Basic {}", server.endpoint.token()),
                ),
            ],
            "{}",
        )
        .await;
    assert_eq!(basic.status, 401);
    // Unknown paths are guarded too and do not reveal anything.
    let unknown_path = server
        .send("POST", "/v1/other", &[("Host", server.host())], "{}")
        .await;
    assert_eq!(unknown_path.status, 401);
    assert!(backend.calls().is_empty());

    let ok = server.post("gateway_tunnel_state", "{}").await;
    assert_eq!(ok.status, 200);
    assert_eq!(ok.body["ok"], true);
    assert!(ok.headers.contains("cache-control: no-store"));
}

#[tokio::test]
async fn non_loopback_host_headers_are_refused() {
    let backend = FakeBackend::new(true);
    let server = serve(backend.clone()).await;
    let port = server.endpoint.port;
    for host in [
        format!("evil.example:{port}"),
        format!("127.0.0.1.nip.io:{port}"),
        "127.0.0.1".to_string(),
        format!("127.0.0.1:{}", port.wrapping_add(1)),
        format!("0.0.0.0:{port}"),
    ] {
        let response = server
            .send(
                "POST",
                "/v1/host/gateway_tunnel_state",
                &[("Host", host.clone()), ("Authorization", server.auth())],
                "{}",
            )
            .await;
        assert_eq!(response.status, 403, "host {host} must be refused");
        assert_eq!(response.body["error"]["code"], "forbidden");
    }
    let localhost = server
        .send(
            "POST",
            "/v1/host/gateway_tunnel_state",
            &[
                ("Host", format!("localhost:{port}")),
                ("Authorization", server.auth()),
            ],
            "{}",
        )
        .await;
    assert_eq!(localhost.status, 200);
    assert_eq!(backend.calls(), vec![Call::State]);
}

#[tokio::test]
async fn browser_requests_are_refused_even_with_the_token() {
    let backend = FakeBackend::new(true);
    let server = serve(backend.clone()).await;
    for (name, value) in [
        ("Origin", "http://127.0.0.1".to_string()),
        ("Origin", "null".to_string()),
        ("Sec-Fetch-Mode", "cors".to_string()),
        ("Sec-Fetch-Site", "cross-site".to_string()),
    ] {
        let response = server
            .send(
                "POST",
                "/v1/host/gateway_tunnel_state",
                &[
                    ("Host", server.host()),
                    ("Authorization", server.auth()),
                    (name, value),
                ],
                "{}",
            )
            .await;
        assert_eq!(response.status, 403, "{name} must be refused");
    }
    assert!(backend.calls().is_empty());
}

#[tokio::test]
async fn only_post_is_accepted() {
    let backend = FakeBackend::new(true);
    let server = serve(backend.clone()).await;
    let response = server
        .send(
            "GET",
            "/v1/host/gateway_tunnel_state",
            &[("Host", server.host()), ("Authorization", server.auth())],
            "",
        )
        .await;
    assert_eq!(response.status, 405);
    assert!(backend.calls().is_empty());
}

#[tokio::test]
async fn oversized_bodies_are_rejected() {
    let backend = FakeBackend::new(true);
    let server = serve(backend.clone()).await;
    let padding = "x".repeat(MAX_BODY_BYTES + 1);
    let body = format!(r#"{{"tunnel_id":"{padding}"}}"#);
    let declared = server.post("gateway_tunnel_close", &body).await;
    assert_eq!(declared.status, 413);
    assert_eq!(declared.body["error"]["code"], "payload_too_large");

    // Chunked: no Content-Length, the streaming limit applies.
    let chunk = body.as_bytes();
    let mut chunked = format!("{:x}\r\n", chunk.len()).into_bytes();
    chunked.extend_from_slice(chunk);
    chunked.extend_from_slice(b"\r\n0\r\n\r\n");
    let head = format!(
        "POST /v1/host/gateway_tunnel_close HTTP/1.1\r\nConnection: close\r\nHost: {}\r\nAuthorization: {}\r\nTransfer-Encoding: chunked\r\n\r\n",
        server.host(),
        server.auth()
    );
    let streamed = raw_request(server.addr, &head, &chunked).await;
    assert_eq!(streamed.status, 413);
    assert!(backend.calls().is_empty());

    // Just under the cap is fine.
    let fits = format!(
        r#"{{"tunnel_id":"{}"}}"#,
        "y".repeat(MAX_BODY_BYTES - r#"{"tunnel_id":""}"#.len())
    );
    assert_eq!(fits.len(), MAX_BODY_BYTES);
    let accepted = server.post("gateway_tunnel_close", &fits).await;
    assert_eq!(accepted.status, 200);
    assert_eq!(accepted.body["ok"], true);
}

// ---------------------------------------------------------------------------
// Dispatch

#[tokio::test]
async fn unknown_commands_and_malformed_bodies() {
    let backend = FakeBackend::new(true);
    let server = serve(backend.clone()).await;
    let unknown = server.post("shell_exec", "{}").await;
    assert_eq!(unknown.status, 200);
    assert_eq!(unknown.body["ok"], false);
    assert_eq!(unknown.body["error"]["code"], "unknown_command");

    for body in ["not json", "[]", "\"x\"", r#"{"tunnel_id": 5}"#, "{}"] {
        let response = server.post("gateway_tunnel_close", body).await;
        assert_eq!(response.status, 200, "{body}");
        assert_eq!(response.body["ok"], false, "{body}");
        assert_eq!(
            response.body["error"]["code"], "invalid_arguments",
            "{body}"
        );
    }
    let missing_input = server
        .post(
            "gateway_tunnel_create",
            r#"{"targetUrl":"http://localhost:3000"}"#,
        )
        .await;
    assert_eq!(missing_input.body["error"]["code"], "invalid_arguments");
    let missing_key = server
        .post("terminal_read_tail", r#"{"session_id":"a"}"#)
        .await;
    assert_eq!(missing_key.body["error"]["code"], "invalid_arguments");
    assert!(backend.calls().is_empty());
}

#[tokio::test]
async fn tunnel_commands_dispatch_to_the_backend() {
    let backend = FakeBackend::new(true);
    let server = serve(backend.clone()).await;

    // Empty body means no arguments.
    let state = server.post("gateway_tunnel_state", "").await;
    assert_eq!(state.body["ok"], true);
    assert_eq!(state.body["result"]["agentOnline"], false);
    assert_eq!(state.body["result"]["tunnels"], json!([]));
    assert_eq!(
        state.body["result"]["publicBaseUrl"],
        "https://gw.example.test:8443"
    );

    let created = server
        .post(
            "gateway_tunnel_create",
            r#"{"input":{"targetUrl":"http://localhost:5173","name":"vite","ttlSeconds":600}}"#,
        )
        .await;
    assert_eq!(created.body, json!({"ok": true, "result": null}));

    let closed = server
        .post("gateway_tunnel_close", r#"{"tunnel_id":"t1"}"#)
        .await;
    assert_eq!(closed.body, json!({"ok": true, "result": null}));
    let failed_close = server
        .post("gateway_tunnel_close", r#"{"tunnel_id":"missing"}"#)
        .await;
    assert_eq!(failed_close.body["ok"], false);
    assert_eq!(failed_close.body["error"]["code"], "command_failed");
    assert_eq!(failed_close.body["error"]["message"], "tunnel not found");

    let checked_all = server.post("gateway_tunnel_check", "{}").await;
    assert_eq!(checked_all.body["ok"], true);
    let checked_one = server
        .post("gateway_tunnel_check", r#"{"tunnel_id":"t1"}"#)
        .await;
    assert_eq!(checked_one.body["ok"], true);

    assert_eq!(
        backend.calls(),
        vec![
            Call::State,
            // Read before the create, to tell the new tunnel apart (link offline: no wait).
            Call::State,
            Call::Create(
                "http://localhost:5173".to_string(),
                Some("vite".to_string()),
                Some(600)
            ),
            Call::Close("t1".to_string()),
            Call::Close("missing".to_string()),
            Call::Check(None),
            Call::Check(Some("t1".to_string())),
        ]
    );
}

#[tokio::test]
async fn tunnel_create_keeps_target_validation_and_never_exposes_the_bridge() {
    let backend = FakeBackend::new(true);
    let server = serve(backend.clone()).await;
    let public = server
        .post(
            "gateway_tunnel_create",
            r#"{"input":{"targetUrl":"http://example.com"}}"#,
        )
        .await;
    assert_eq!(public.body["ok"], false);
    assert_eq!(public.body["error"]["code"], "command_failed");

    let port = server.endpoint.port;
    for target in [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}/v1/host/terminal_read_tail"),
        format!("http://[::1]:{port}"),
        format!("http://0.0.0.0:{port}"),
    ] {
        let body = json!({"input": {"targetUrl": target}}).to_string();
        let response = server.post("gateway_tunnel_create", &body).await;
        assert_eq!(response.body["ok"], false, "{target}");
        assert_eq!(
            response.body["error"]["code"], "invalid_arguments",
            "{target}"
        );
    }
    // Only the example.com attempt reached the backend.
    assert_eq!(
        backend.calls(),
        vec![
            Call::State,
            Call::Create("http://example.com".to_string(), None, None)
        ]
    );
}

const CREATE_BODY: &[u8] = br#"{"input":{"targetUrl":"http://localhost:5173"}}"#;

#[tokio::test]
async fn tunnel_create_returns_once_the_new_tunnel_is_listed() {
    // K-brain reads the state right after create to report the new tunnel.
    let backend = FakeBackend::online(Some(Duration::from_millis(300)), &["tun-old"]);
    let started = tokio::time::Instant::now();
    let result = dispatch(&*backend, 1, "gateway_tunnel_create", CREATE_BODY)
        .await
        .expect("create");
    assert_eq!(result, Value::Null);
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(300), "{waited:?}");
    assert!(waited < TUNNEL_CREATE_SETTLE, "{waited:?}");
    let listed: Vec<String> = backend
        .tunnel_state()
        .unwrap()
        .tunnels
        .into_iter()
        .map(|tunnel| tunnel.id)
        .collect();
    assert_eq!(listed, ["tun-old", "tun-2"]);
}

#[tokio::test]
async fn tunnel_create_wait_is_bounded() {
    let backend = FakeBackend::online(None, &["tun-old"]);
    let before = backend.tunnel_state().unwrap();
    let settle = Duration::from_millis(250);
    let started = tokio::time::Instant::now();
    wait_for_new_tunnel(&*backend, &before, settle).await;
    let waited = started.elapsed();
    assert!(waited >= settle, "{waited:?}");
    assert!(waited < settle + Duration::from_secs(1), "{waited:?}");
    assert!(backend.state_reads() > 2);
}

#[tokio::test]
async fn tunnel_create_does_not_wait_when_offline_or_failed() {
    let offline = FakeBackend::new(true);
    let started = tokio::time::Instant::now();
    dispatch(&*offline, 1, "gateway_tunnel_create", CREATE_BODY)
        .await
        .expect("create");
    assert_eq!(offline.state_reads(), 1);

    // Online, but the gateway would never list it: a failed create returns at once.
    let online = FakeBackend::online(None, &[]);
    let error = dispatch(
        &*online,
        1,
        "gateway_tunnel_create",
        br#"{"input":{"targetUrl":"http://example.com"}}"#,
    )
    .await
    .expect_err("public target");
    assert_eq!(error.code, "command_failed");
    assert_eq!(online.state_reads(), 1);
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn tunnel_commands_are_refused_while_tunnels_are_disabled() {
    let backend = FakeBackend::new(false);
    let server = serve(backend.clone()).await;
    for (command, body) in [
        ("gateway_tunnel_state", "{}"),
        (
            "gateway_tunnel_create",
            r#"{"input":{"targetUrl":"http://localhost:3000"}}"#,
        ),
        ("gateway_tunnel_close", r#"{"tunnel_id":"t1"}"#),
        ("gateway_tunnel_check", "{}"),
    ] {
        let response = server.post(command, body).await;
        assert_eq!(response.body["ok"], false, "{command}");
        assert_eq!(response.body["error"]["code"], "tool_disabled", "{command}");
    }
    assert!(backend.calls().is_empty());
}

#[tokio::test]
async fn terminal_read_tail_uses_the_registry_project_scoping() {
    let backend = FakeBackend::new(false);
    let server = serve(backend.clone()).await;
    let project = tempfile::tempdir().expect("project dir");
    let other = tempfile::tempdir().expect("other project dir");
    let project_key = project.path().display().to_string();
    let other_key = other.path().display().to_string();

    let empty = server
        .post(
            "terminal_read_tail",
            &json!({"project_path_key": project_key}).to_string(),
        )
        .await;
    assert_eq!(empty.body["ok"], true);
    assert_eq!(empty.body["result"]["sessions"], json!([]));
    assert_eq!(empty.body["result"]["selectedSession"], Value::Null);

    let session = backend
        .terminals
        .create(
            other_key.clone(),
            Some(other_key.clone()),
            None,
            Some("Other".to_string()),
            Some(80),
            Some(24),
        )
        .expect("create terminal");
    let session_id = session.session.id.clone();

    let own = server
        .post(
            "terminal_read_tail",
            &json!({"project_path_key": other_key, "session_id": session_id, "max_bytes": 512})
                .to_string(),
        )
        .await;
    assert_eq!(own.body["ok"], true, "{}", own.body);
    assert_eq!(own.body["result"]["selectedSession"]["id"], session_id);
    assert!(own.body["result"]["output"].is_string());

    // Another project's terminal is never read: with no own sessions the
    // result is empty...
    let foreign_empty = server
        .post(
            "terminal_read_tail",
            &json!({"project_path_key": project_key, "session_id": session_id}).to_string(),
        )
        .await;
    assert_eq!(foreign_empty.body["ok"], true);
    assert_eq!(foreign_empty.body["result"]["sessions"], json!([]));
    assert_eq!(foreign_empty.body["result"]["output"], "");

    // ...and with own sessions an explicit foreign id is refused.
    backend
        .terminals
        .create(
            project_key.clone(),
            Some(project_key.clone()),
            None,
            Some("Own".to_string()),
            Some(80),
            Some(24),
        )
        .expect("create own terminal");
    let foreign = server
        .post(
            "terminal_read_tail",
            &json!({"project_path_key": project_key, "session_id": session_id}).to_string(),
        )
        .await;
    assert_eq!(foreign.body["ok"], false);
    assert_eq!(foreign.body["error"]["code"], "command_failed");
    assert_eq!(
        foreign.body["error"]["message"],
        "terminal session is outside the current project"
    );

    let blank = server
        .post("terminal_read_tail", r#"{"project_path_key":"  "}"#)
        .await;
    assert_eq!(blank.body["error"]["code"], "command_failed");

    assert_eq!(
        backend.calls()[1],
        Call::ReadTail(other_key, Some(session_id), Some(512))
    );
    backend.terminals.close_all().expect("close terminals");
}

#[test]
fn public_base_url_matches_the_frontend_helper() {
    assert_eq!(
        gateway_public_base_url("wss://gw.example.com/", 443),
        "https://gw.example.com"
    );
    assert_eq!(
        gateway_public_base_url("ws://gw.example.com/base?x=1#y", 8080),
        "http://gw.example.com:8080/base"
    );
    assert_eq!(
        gateway_public_base_url("https://gw.example.com", 9443),
        "https://gw.example.com:9443"
    );
    assert_eq!(gateway_public_base_url("", 443), "");
    assert_eq!(gateway_public_base_url("not a url", 443), "");
    assert_eq!(gateway_public_base_url("ftp://gw.example.com", 21), "");
}

// ---------------------------------------------------------------------------
// Registration against a stub K-brain

const KBRAIN_TOKEN: &str = "kbrain-test-token";

#[derive(Default)]
struct StubKBrain {
    host_bridge_capability: Mutex<Option<Value>>,
    put_status: Mutex<u16>,
    puts: Mutex<Vec<Value>>,
    deletes: Mutex<u32>,
    health_checks: Mutex<u32>,
}

fn stub_authorized(headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some(&format!("Bearer {KBRAIN_TOKEN}"))
}

async fn stub_health(
    State(stub): State<Arc<StubKBrain>>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    if !stub_authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({})));
    }
    *stub.health_checks.lock().unwrap() += 1;
    let mut capabilities = json!({"runs": 1});
    if let Some(value) = stub.host_bridge_capability.lock().unwrap().clone() {
        capabilities["host_bridge"] = value;
    }
    (
        StatusCode::OK,
        Json(json!({"status": "ok", "capabilities": capabilities})),
    )
}

async fn stub_put(
    State(stub): State<Arc<StubKBrain>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> StatusCode {
    if !stub_authorized(&headers) {
        return StatusCode::UNAUTHORIZED;
    }
    let status = *stub.put_status.lock().unwrap();
    if status != 200 {
        return StatusCode::from_u16(status).unwrap();
    }
    stub.puts.lock().unwrap().push(body);
    StatusCode::NO_CONTENT
}

async fn stub_delete(State(stub): State<Arc<StubKBrain>>, headers: HeaderMap) -> StatusCode {
    if !stub_authorized(&headers) {
        return StatusCode::UNAUTHORIZED;
    }
    *stub.deletes.lock().unwrap() += 1;
    StatusCode::NO_CONTENT
}

async fn start_stub(capability: Option<Value>) -> (Arc<StubKBrain>, KBrainBackendConnection) {
    let stub = Arc::new(StubKBrain::default());
    *stub.host_bridge_capability.lock().unwrap() = capability;
    *stub.put_status.lock().unwrap() = 200;
    let app = Router::new()
        .route("/v1/health", get(stub_health))
        .route("/v1/host-bridge", put(stub_put).delete(stub_delete))
        .with_state(Arc::clone(&stub));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let connection = KBrainBackendConnection {
        base_url: format!("http://{addr}"),
        token: KBRAIN_TOKEN.to_string(),
        protocol_version: "kbrain.agent.v1".to_string(),
        storage_id: "test".to_string(),
    };
    (stub, connection)
}

fn registrar() -> (
    Arc<HostBridgeRegistrar>,
    HostBridgeEndpoint,
    Arc<Mutex<Vec<HostBridgeStatus>>>,
) {
    let (_listener, endpoint) = bind_loopback().expect("bind");
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let registrar = HostBridgeRegistrar::new(
        endpoint.clone(),
        Box::new(move |status: &HostBridgeStatus| sink.lock().unwrap().push(status.clone())),
    )
    .expect("registrar");
    (Arc::new(registrar), endpoint, events)
}

fn tools(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| name.to_string()).collect()
}

async fn wait_until(mut condition: impl FnMut() -> bool) {
    for _ in 0..200 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("condition not reached in time");
}

#[tokio::test]
async fn registers_when_kbrain_reports_the_capability() {
    let (stub, connection) = start_stub(Some(json!(1))).await;
    let (registrar, endpoint, events) = registrar();
    let status = registrar
        .sync(
            Some(connection.clone()),
            tools(&["ReadTerminal", "TunnelManager"]),
            false,
        )
        .await;
    assert_eq!(status.state, HostBridgeState::Registered);
    assert_eq!(status.tools, tools(&["ReadTerminal", "TunnelManager"]));
    let puts = stub.puts.lock().unwrap().clone();
    assert_eq!(
        puts,
        vec![json!({
            "url": endpoint.url(),
            "token": endpoint.token(),
            "host": "liveagent-desktop",
            "tools": ["ReadTerminal", "TunnelManager"],
        })]
    );
    assert!(endpoint.url().starts_with("http://127.0.0.1:"));

    // The frontend-visible status never carries the URL or the token.
    let visible = serde_json::to_string(&registrar.status()).unwrap();
    assert!(!visible.contains(endpoint.token()));
    assert!(!visible.contains(endpoint.url()));
    assert_eq!(
        serde_json::from_str::<Value>(&visible).unwrap(),
        json!({"state": "registered", "tools": ["ReadTerminal", "TunnelManager"]})
    );

    // Unchanged registration is not re-sent; a forced refresh is.
    registrar
        .sync(
            Some(connection.clone()),
            tools(&["ReadTerminal", "TunnelManager"]),
            false,
        )
        .await;
    assert_eq!(stub.puts.lock().unwrap().len(), 1);
    registrar
        .sync(
            Some(connection),
            tools(&["ReadTerminal", "TunnelManager"]),
            true,
        )
        .await;
    assert_eq!(stub.puts.lock().unwrap().len(), 2);
    assert_eq!(
        events.lock().unwrap().len(),
        1,
        "status only emitted on change"
    );
}

#[tokio::test]
async fn older_kbrain_without_the_capability_is_skipped_silently() {
    for capability in [None, Some(json!(0)), Some(json!(2)), Some(json!("1"))] {
        let (stub, connection) = start_stub(capability.clone()).await;
        let (registrar, _endpoint, _events) = registrar();
        let status = registrar
            .sync(Some(connection), tools(&["ReadTerminal"]), false)
            .await;
        assert_eq!(status.state, HostBridgeState::Unsupported, "{capability:?}");
        assert!(status.tools.is_empty());
        assert!(stub.puts.lock().unwrap().is_empty(), "{capability:?}");
    }
}

#[tokio::test]
async fn failed_registration_reports_failed_without_leaking_secrets() {
    let (stub, connection) = start_stub(Some(json!(1))).await;
    *stub.put_status.lock().unwrap() = 500;
    let (registrar, _endpoint, _events) = registrar();
    let status = registrar
        .sync(Some(connection.clone()), tools(&["ReadTerminal"]), false)
        .await;
    assert_eq!(status.state, HostBridgeState::Failed);
    assert!(status.tools.is_empty());

    // Unreachable backend.
    let mut gone = connection;
    gone.base_url = "http://127.0.0.1:9".to_string();
    let status = registrar
        .sync(Some(gone), tools(&["ReadTerminal"]), false)
        .await;
    assert_eq!(status.state, HostBridgeState::Failed);

    let status = registrar.sync(None, tools(&["ReadTerminal"]), false).await;
    assert_eq!(status.state, HostBridgeState::Disconnected);
}

#[tokio::test]
async fn follower_reregisters_on_restart_and_tunnel_setting_changes() {
    let (first_stub, first) = start_stub(Some(json!(1))).await;
    let (second_stub, second) = start_stub(Some(json!(1))).await;
    let (registrar, endpoint, _events) = registrar();
    let (kbrain_tx, kbrain_rx) = watch::channel(None::<KBrainBackendConnection>);
    let (settings_tx, settings_rx) = watch::channel(RemoteSettingsPayload::default());
    let follower = tokio::spawn(Arc::clone(&registrar).follow(kbrain_rx, settings_rx));

    kbrain_tx.send_replace(Some(first.clone()));
    wait_until(|| first_stub.puts.lock().unwrap().len() == 1).await;
    assert_eq!(
        first_stub.puts.lock().unwrap()[0]["tools"],
        json!(["ReadTerminal"])
    );

    // Enabling Remote tunnels advertises TunnelManager.
    settings_tx.send_modify(|settings| settings.enable_web_tunnels = true);
    wait_until(|| first_stub.puts.lock().unwrap().len() == 2).await;
    assert_eq!(
        first_stub.puts.lock().unwrap()[1]["tools"],
        json!(["ReadTerminal", "TunnelManager"])
    );

    // An unrelated settings change does not re-register.
    settings_tx.send_modify(|settings| settings.enable_web_git = true);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(first_stub.puts.lock().unwrap().len(), 2);

    // K-brain restart (new port/token): register again with the same bridge.
    kbrain_tx.send_replace(Some(second));
    wait_until(|| second_stub.puts.lock().unwrap().len() == 1).await;
    assert_eq!(second_stub.puts.lock().unwrap()[0]["url"], endpoint.url());
    assert_eq!(
        second_stub.puts.lock().unwrap()[0]["token"],
        endpoint.token()
    );

    // Backend stopped.
    kbrain_tx.send_replace(None);
    wait_until(|| registrar.status().state == HostBridgeState::Disconnected).await;

    // Same K-brain back again (e.g. restarted on the same port) re-registers.
    kbrain_tx.send_replace(Some(first));
    wait_until(|| first_stub.puts.lock().unwrap().len() == 3).await;
    follower.abort();
}

#[tokio::test]
async fn follower_retries_after_a_failed_registration() {
    let (stub, connection) = start_stub(Some(json!(1))).await;
    *stub.put_status.lock().unwrap() = 503;
    let (registrar, _endpoint, _events) = registrar();
    let (_kbrain_tx, kbrain_rx) = watch::channel(Some(connection));
    let (_settings_tx, settings_rx) = watch::channel(RemoteSettingsPayload::default());
    let follower = tokio::spawn(Arc::clone(&registrar).follow(kbrain_rx, settings_rx));
    wait_until(|| registrar.status().state == HostBridgeState::Failed).await;
    *stub.put_status.lock().unwrap() = 200;
    wait_until(|| registrar.status().state == HostBridgeState::Registered).await;
    assert_eq!(stub.puts.lock().unwrap().len(), 1);
    follower.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exit_deletes_the_registration_once() {
    let (stub, connection) = start_stub(Some(json!(1))).await;
    let (registrar, _endpoint, events) = registrar();
    registrar
        .sync(Some(connection.clone()), tools(&["ReadTerminal"]), false)
        .await;
    assert_eq!(registrar.status().state, HostBridgeState::Registered);

    let exiting = Arc::clone(&registrar);
    tokio::task::spawn_blocking(move || {
        exiting.unregister_for_exit();
        // ExitRequested and Exit both call it; the second is a no-op.
        exiting.unregister_for_exit();
    })
    .await
    .unwrap();
    assert_eq!(*stub.deletes.lock().unwrap(), 1);
    assert_eq!(registrar.status().state, HostBridgeState::Disconnected);
    assert_eq!(
        events.lock().unwrap().last().map(|status| status.state),
        Some(HostBridgeState::Disconnected)
    );

    // No re-registration once exiting.
    let status = registrar
        .sync(Some(connection), tools(&["ReadTerminal"]), true)
        .await;
    assert_eq!(status.state, HostBridgeState::Disconnected);
    assert_eq!(stub.puts.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exit_without_registration_sends_nothing() {
    let (stub, connection) = start_stub(None).await;
    let (registrar, _endpoint, _events) = registrar();
    registrar
        .sync(Some(connection), tools(&["ReadTerminal"]), false)
        .await;
    let exiting = Arc::clone(&registrar);
    tokio::task::spawn_blocking(move || exiting.unregister_for_exit())
        .await
        .unwrap();
    assert_eq!(*stub.deletes.lock().unwrap(), 0);
}

#[test]
fn advertised_tools_follow_the_tunnel_opt_in() {
    let mut settings = RemoteSettingsPayload::default();
    assert_eq!(advertised_tools(&settings), tools(&["ReadTerminal"]));
    settings.enable_web_tunnels = true;
    assert_eq!(
        advertised_tools(&settings),
        tools(&["ReadTerminal", "TunnelManager"])
    );
}
