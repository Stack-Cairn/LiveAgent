//! Registers the host bridge with the desktop's K-brain backend.
//!
//! Every K-brain (re)start publishes a new connection (see
//! `KBrainBackendState::subscribe_connection`); the follower then checks
//! `GET /v1/health` for `capabilities.host_bridge == 1` and sends
//! `PUT /v1/host-bridge`. Older backends are skipped silently. On app exit the
//! registration is withdrawn best-effort with `DELETE /v1/host-bridge` before
//! the backend is stopped.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::header::AUTHORIZATION;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::watch;

use super::{HostBridgeEndpoint, HOST_BRIDGE_HOST, READ_TERMINAL_TOOL, TUNNEL_MANAGER_TOOL};
use crate::commands::settings::RemoteSettingsPayload;
use crate::services::gateway::GatewayController;
use crate::services::kbrain_backend::{KBrainBackendConnection, KBrainBackendState};

/// Emitted with a [`HostBridgeStatus`] whenever the registration changes.
pub const HOST_BRIDGE_STATUS_EVENT: &str = "host-bridge:status";
const REGISTRATION_PATH: &str = "/v1/host-bridge";
const HEALTH_PATH: &str = "/v1/health";
const HOST_BRIDGE_CAPABILITY: &str = "host_bridge";
const HOST_BRIDGE_CAPABILITY_VERSION: u64 = 1;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const EXIT_TIMEOUT: Duration = Duration::from_millis(1500);
const RETRY_BASE: Duration = Duration::from_millis(500);
const RETRY_MAX: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostBridgeState {
    /// No running K-brain backend (or the app is exiting).
    Disconnected,
    /// The backend does not report `capabilities.host_bridge: 1`.
    Unsupported,
    Registered,
    /// The last registration attempt failed; the follower retries.
    Failed,
}

/// What the frontend may know about the bridge: never the URL or the token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBridgeStatus {
    pub state: HostBridgeState,
    /// Tools K-brain accepted from this host; empty unless registered.
    pub tools: Vec<String>,
}

impl HostBridgeStatus {
    fn disconnected() -> Self {
        Self {
            state: HostBridgeState::Disconnected,
            tools: Vec::new(),
        }
    }

    fn without_tools(state: HostBridgeState) -> Self {
        Self {
            state,
            tools: Vec::new(),
        }
    }
}

/// Tools this desktop offers. `TunnelManager` follows the Remote tunnels
/// opt-in, as the frontend tool did.
pub fn advertised_tools(remote: &RemoteSettingsPayload) -> Vec<String> {
    let mut tools = vec![READ_TERMINAL_TOOL.to_string()];
    if remote.enable_web_tunnels {
        tools.push(TUNNEL_MANAGER_TOOL.to_string());
    }
    tools
}

/// One accepted registration. Holds K-brain's own token, so no `Debug`.
#[derive(Clone, PartialEq, Eq)]
struct Registration {
    base_url: String,
    kbrain_token: String,
    tools: Vec<String>,
}

struct Inner {
    status: HostBridgeStatus,
    registered: Option<Registration>,
}

type StatusListener = Box<dyn Fn(&HostBridgeStatus) + Send + Sync>;

pub struct HostBridgeRegistrar {
    endpoint: HostBridgeEndpoint,
    http: reqwest::Client,
    inner: Mutex<Inner>,
    /// Serializes health/PUT sequences so a refresh never races the follower.
    sync_lock: tokio::sync::Mutex<()>,
    exiting: AtomicBool,
    on_status: StatusListener,
}

fn kbrain_error(error: reqwest::Error) -> String {
    // Never echo URLs: they would not leak the token, but keep logs minimal.
    error.without_url().to_string()
}

impl HostBridgeRegistrar {
    pub fn new(endpoint: HostBridgeEndpoint, on_status: StatusListener) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .no_proxy()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| format!("failed to create host bridge client: {error}"))?;
        Ok(Self {
            endpoint,
            http,
            inner: Mutex::new(Inner {
                status: HostBridgeStatus::disconnected(),
                registered: None,
            }),
            sync_lock: tokio::sync::Mutex::new(()),
            exiting: AtomicBool::new(false),
            on_status,
        })
    }

    pub fn status(&self) -> HostBridgeStatus {
        self.inner
            .lock()
            .map(|inner| inner.status.clone())
            .unwrap_or_else(|_| HostBridgeStatus::disconnected())
    }

    fn publish(
        &self,
        status: HostBridgeStatus,
        registered: Option<Registration>,
    ) -> HostBridgeStatus {
        let changed = match self.inner.lock() {
            Ok(mut inner) => {
                inner.registered = registered;
                let changed = inner.status != status;
                inner.status = status.clone();
                changed
            }
            Err(_) => false,
        };
        if changed {
            (self.on_status)(&status);
        }
        status
    }

    async fn supports_host_bridge(
        &self,
        connection: &KBrainBackendConnection,
    ) -> Result<bool, String> {
        let body: Value = self
            .http
            .get(format!("{}{HEALTH_PATH}", connection.base_url))
            .header(AUTHORIZATION, format!("Bearer {}", connection.token))
            .send()
            .await
            .map_err(kbrain_error)?
            .error_for_status()
            .map_err(kbrain_error)?
            .json()
            .await
            .map_err(kbrain_error)?;
        let version = body
            .get("capabilities")
            .and_then(|capabilities| capabilities.get(HOST_BRIDGE_CAPABILITY))
            .and_then(Value::as_f64);
        Ok(version == Some(HOST_BRIDGE_CAPABILITY_VERSION as f64))
    }

    async fn put_registration(
        &self,
        connection: &KBrainBackendConnection,
        tools: &[String],
    ) -> Result<(), String> {
        self.http
            .put(format!("{}{REGISTRATION_PATH}", connection.base_url))
            .header(AUTHORIZATION, format!("Bearer {}", connection.token))
            .json(&json!({
                "url": self.endpoint.url(),
                "token": self.endpoint.token(),
                "host": HOST_BRIDGE_HOST,
                "tools": tools,
            }))
            .send()
            .await
            .map_err(kbrain_error)?
            .error_for_status()
            .map(|_| ())
            .map_err(|error| format!("unexpected status {:?}", error.status()))
    }

    /// Brings K-brain's registration in line with `connection` and `tools`.
    /// Without `force`, an identical accepted registration is not re-sent.
    pub async fn sync(
        &self,
        connection: Option<KBrainBackendConnection>,
        tools: Vec<String>,
        force: bool,
    ) -> HostBridgeStatus {
        let _guard = self.sync_lock.lock().await;
        if self.exiting.load(Ordering::SeqCst) {
            return self.publish(HostBridgeStatus::disconnected(), None);
        }
        let Some(connection) = connection else {
            return self.publish(HostBridgeStatus::disconnected(), None);
        };
        let desired = Registration {
            base_url: connection.base_url.clone(),
            kbrain_token: connection.token.clone(),
            tools,
        };
        if !force {
            if let Ok(inner) = self.inner.lock() {
                if inner.status.state == HostBridgeState::Registered
                    && inner.registered.as_ref() == Some(&desired)
                {
                    return inner.status.clone();
                }
            }
        }
        match self.supports_host_bridge(&connection).await {
            Ok(false) => self.publish(
                HostBridgeStatus::without_tools(HostBridgeState::Unsupported),
                None,
            ),
            Err(error) => {
                eprintln!("host bridge: K-brain health check failed: {error}");
                self.publish(
                    HostBridgeStatus::without_tools(HostBridgeState::Failed),
                    None,
                )
            }
            Ok(true) => match self.put_registration(&connection, &desired.tools).await {
                Ok(()) => self.publish(
                    HostBridgeStatus {
                        state: HostBridgeState::Registered,
                        tools: desired.tools.clone(),
                    },
                    Some(desired),
                ),
                Err(error) => {
                    eprintln!("host bridge: K-brain registration failed: {error}");
                    self.publish(
                        HostBridgeStatus::without_tools(HostBridgeState::Failed),
                        None,
                    )
                }
            },
        }
    }

    /// Follows K-brain restarts and the tunnel opt-in until the app exits.
    pub async fn follow(
        self: Arc<Self>,
        mut kbrain: watch::Receiver<Option<KBrainBackendConnection>>,
        mut settings: watch::Receiver<RemoteSettingsPayload>,
    ) {
        let mut settings_open = true;
        let mut failures: u32 = 0;
        loop {
            let connection = kbrain.borrow_and_update().clone();
            let tools = advertised_tools(&settings.borrow_and_update());
            let status = self.sync(connection, tools, false).await;
            let retry = if status.state == HostBridgeState::Failed {
                failures = failures.saturating_add(1);
                Some(retry_delay(failures))
            } else {
                failures = 0;
                None
            };
            tokio::select! {
                changed = kbrain.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
                changed = settings.changed(), if settings_open => {
                    if changed.is_err() {
                        settings_open = false;
                    }
                }
                _ = tokio::time::sleep(retry.unwrap_or(RETRY_MAX)), if retry.is_some() => {}
            }
        }
    }

    /// Withdraws the registration before the backend stops; bounded and
    /// best-effort. Later syncs report `disconnected`.
    pub fn unregister_for_exit(&self) {
        self.exiting.store(true, Ordering::SeqCst);
        let registration = match self.inner.lock() {
            Ok(mut inner) => inner.registered.take(),
            Err(_) => None,
        };
        self.publish(HostBridgeStatus::disconnected(), None);
        let Some(registration) = registration else {
            return;
        };
        // A plain thread: the exit hook may run inside or outside a Tokio
        // context, and the blocking client must not run on a runtime worker.
        let worker = std::thread::Builder::new()
            .name("host-bridge-unregister".into())
            .spawn(move || {
                let client = reqwest::blocking::Client::builder()
                    .no_proxy()
                    .timeout(EXIT_TIMEOUT)
                    .build()
                    .map_err(|error| error.to_string())?;
                client
                    .delete(format!("{}{REGISTRATION_PATH}", registration.base_url))
                    .header(
                        AUTHORIZATION,
                        format!("Bearer {}", registration.kbrain_token),
                    )
                    .send()
                    .map(|_| ())
                    .map_err(|error| error.without_url().to_string())
            });
        if let Ok(worker) = worker {
            if let Ok(Err(error)) = worker.join() {
                eprintln!("host bridge: unregister on exit failed: {error}");
            }
        }
    }
}

fn retry_delay(failures: u32) -> Duration {
    let factor = 1_u32 << failures.saturating_sub(1).min(6);
    (RETRY_BASE * factor).min(RETRY_MAX)
}

/// Starts the follower on the Tauri runtime.
pub(crate) fn spawn_follower(
    registrar: &Arc<HostBridgeRegistrar>,
    kbrain: &KBrainBackendState,
    gateway: &GatewayController,
) {
    let follower = Arc::clone(registrar).follow(
        kbrain.subscribe_connection(),
        gateway.subscribe_remote_settings(),
    );
    tauri::async_runtime::spawn(follower);
}

pub(crate) fn emit_status_listener(app: tauri::AppHandle) -> StatusListener {
    Box::new(move |status| {
        if let Err(error) = app.emit(HOST_BRIDGE_STATUS_EVENT, status) {
            eprintln!("failed to emit host bridge status: {error}");
        }
    })
}

/// Bridge status for the settings/tool UI. `refresh` re-sends the registration
/// to the running backend (the frontend calls it after each K-brain connect).
#[tauri::command]
pub async fn host_bridge_status(
    app: tauri::AppHandle,
    refresh: Option<bool>,
) -> Result<HostBridgeStatus, String> {
    let Some(registrar) = app
        .try_state::<Arc<HostBridgeRegistrar>>()
        .map(|state| Arc::clone(state.inner()))
    else {
        return Ok(HostBridgeStatus::disconnected());
    };
    if refresh != Some(true) {
        return Ok(registrar.status());
    }
    let connection = match app.try_state::<Arc<KBrainBackendState>>() {
        Some(state) => {
            let state = Arc::clone(state.inner());
            tauri::async_runtime::spawn_blocking(move || state.running_connection())
                .await
                .map_err(|error| format!("host bridge status join failed: {error}"))?
        }
        None => None,
    };
    let tools = app
        .try_state::<Arc<GatewayController>>()
        .map(|gateway| advertised_tools(&gateway.remote_settings()))
        .unwrap_or_else(|| advertised_tools(&RemoteSettingsPayload::default()));
    Ok(registrar.sync(connection, tools, true).await)
}
