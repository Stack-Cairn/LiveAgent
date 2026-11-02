//! Own the desktop's Go Gateway process independently of the remote connection.
//!
//! These methods perform blocking process/network IO. Call them on a blocking
//! worker, never on the desktop event loop. Dropping/closing a window does not
//! stop the service; the application calls `shutdown` on actual exit.

use std::io::Write as _;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

const INSTANCE_HEADER: &str = "X-LiveAgent-Instance";
const INSTANCE_PROBE_HEADER: &str = "X-LiveAgent-Instance-Probe";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
const HEALTH_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Clone, PartialEq, Eq)]
pub struct LocalGatewayOptions {
    pub binary: PathBuf,
    pub data_dir: PathBuf,
    pub port: u16,
    pub token: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct LocalImageBackend {
    pub url: String,
    pub token: String,
}

impl LocalImageBackend {
    /// Mirrors the Gateway's rule (image_single_user.go): http(s) on a numeric
    /// loopback host with no userinfo/query/fragment, plus a usable bearer token.
    pub fn is_authenticated_loopback(&self) -> bool {
        let Ok(url) = tauri::Url::parse(&self.url) else {
            return false;
        };
        // Numeric hosts only, like Go's net.ParseIP: "localhost" is rejected.
        let host = url
            .host_str()
            .unwrap_or_default()
            .trim_start_matches('[')
            .trim_end_matches(']');
        let loopback = host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
        matches!(url.scheme(), "http" | "https")
            && loopback
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && !self.token.trim().is_empty()
            && !self.token.bytes().any(|byte| byte.is_ascii_control())
    }
}

/// Reads the live K-Brain for the WebUI Image Studio; called under the operation lock.
/// The backend is not part of `LocalGatewayOptions`: it is passed at spawn and then
/// rebound over the stdin control pipe, so K-Brain restarts never restart the Gateway.
pub type ImageBackendSource = Arc<dyn Fn() -> Option<LocalImageBackend> + Send + Sync>;

/// One stdin control line understood by the Gateway (server.WatchDesktopParent).
/// `None` disables image routes, e.g. while K-Brain is stopped.
fn image_backend_control_line(backend: Option<&LocalImageBackend>) -> String {
    let message = match backend {
        Some(backend) => {
            serde_json::json!({ "type": "image_backend", "url": backend.url, "token": backend.token })
        }
        None => serde_json::json!({ "type": "image_backend" }),
    };
    format!("{message}\n")
}

// Never derive Debug for options: bearer credentials must not reach logs.
impl std::fmt::Debug for LocalGatewayOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalGatewayOptions")
            .field("binary", &self.binary)
            .field("data_dir", &self.data_dir)
            .field("port", &self.port)
            .field("token", &"[redacted]")
            .finish()
    }
}

const IMAGE_ENV_URL: &str = "LIVEAGENT_GATEWAY_IMAGE_KBRAIN_URL";
const IMAGE_ENV_TOKEN: &str = "LIVEAGENT_GATEWAY_IMAGE_KBRAIN_TOKEN";
/// Inherited shell settings must not turn on the legacy chat-backend image path
/// or the direct K-Brain chat relay in a desktop-owned Gateway.
const INHERITED_IMAGE_ENV: [&str; 3] = [
    "LIVEAGENT_GATEWAY_IMAGE_SINGLE_USER",
    "LIVEAGENT_GATEWAY_KBRAIN_URL",
    "LIVEAGENT_GATEWAY_KBRAIN_TOKEN",
];

/// Sets the Image Studio pair (or clears it) and strips inherited chat-backend settings.
fn apply_image_backend_env(command: &mut Command, backend: Option<&LocalImageBackend>) {
    for name in INHERITED_IMAGE_ENV {
        command.env_remove(name);
    }
    match backend {
        Some(backend) => {
            command.env(IMAGE_ENV_URL, &backend.url);
            command.env(IMAGE_ENV_TOKEN, &backend.token);
        }
        None => {
            command.env_remove(IMAGE_ENV_URL);
            command.env_remove(IMAGE_ENV_TOKEN);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalGatewayReady {
    pub url: String,
    pub pid: u32,
    pub port: u16,
}

struct OwnedGateway {
    child: Child,
    options: LocalGatewayOptions,
    nonce: String,
    ready: bool,
    /// What this child currently serves for Image Studio (spawn env or last rebind).
    image_backend: Option<LocalImageBackend>,
}

impl OwnedGateway {
    fn terminate(&mut self) -> Result<(), String> {
        match self.child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {}
            Err(_) => return Err("Unable to inspect the local Gateway process".into()),
        }
        // A child may exit between try_wait and kill. Recheck before reporting
        // failure; no process-name/port-based termination is ever performed.
        if self.child.kill().is_err() && !matches!(self.child.try_wait(), Ok(Some(_))) {
            return Err("Unable to stop the local Gateway process".into());
        }
        self.child
            .wait()
            .map(|_| ())
            .map_err(|_| "Unable to collect the local Gateway process".into())
    }
}

impl Drop for OwnedGateway {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

/// Serialized, retryable process ownership. The state mutex is only held for
/// short process operations; readiness polling never blocks `cancel_start`.
pub struct LocalGatewayManager {
    operation: Mutex<()>,
    child: Mutex<Option<OwnedGateway>>,
    image_backend_source: Mutex<Option<ImageBackendSource>>,
    cancellation: AtomicU64,
    shutting_down: AtomicBool,
    startup_timeout: Duration,
}

impl Default for LocalGatewayManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalGatewayManager {
    pub fn new() -> Self {
        Self::with_startup_timeout(STARTUP_TIMEOUT)
    }

    pub fn with_startup_timeout(startup_timeout: Duration) -> Self {
        Self {
            operation: Mutex::new(()),
            child: Mutex::new(None),
            image_backend_source: Mutex::new(None),
            cancellation: AtomicU64::new(0),
            shutting_down: AtomicBool::new(false),
            startup_timeout,
        }
    }

    fn lock_child(&self) -> MutexGuard<'_, Option<OwnedGateway>> {
        // Poisoning must not orphan a process during desktop shutdown.
        self.child.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn cancelled(&self, epoch: u64) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
            || self.cancellation.load(Ordering::SeqCst) != epoch
    }

    /// May be called directly on the UI/event thread before scheduling stop.
    pub fn cancel_start(&self) {
        self.cancellation.fetch_add(1, Ordering::SeqCst);
    }

    /// Capture before queueing work on a blocking executor. Passing this epoch
    /// into `start_with_epoch` also cancels work which has not begun executing
    /// when the configuration changes.
    pub fn start_epoch(&self) -> u64 {
        self.cancellation.load(Ordering::SeqCst)
    }

    /// Start exactly one owned process and wait for its private launch identity.
    /// Concurrent equivalent requests share the running child; changed settings
    /// replace only the owned child. Failed starts collect the child and leave
    /// the manager available for a later retry.
    pub fn start_with_epoch(
        &self,
        options: LocalGatewayOptions,
        epoch: u64,
    ) -> Result<LocalGatewayReady, String> {
        let _operation = self.operation.lock().unwrap_or_else(|e| e.into_inner());
        self.start_locked(options, epoch)
    }

    /// Follow K-Brain from now on: every start reads the live backend under the
    /// operation lock, so the last start always carries the newest URL/token.
    pub fn set_image_backend_source(&self, source: ImageBackendSource) {
        *self
            .image_backend_source
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(source);
    }

    fn current_image_backend(&self) -> Option<LocalImageBackend> {
        let source = self
            .image_backend_source
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        source.and_then(|source| source())
    }

    /// Rebind a running Gateway to the current K-Brain (first start, restart on a
    /// new port/token, or stop) by writing one stdin control line. The process, its
    /// agent connection and browser sessions are untouched. Serialized with start,
    /// so a change during startup is delivered once the child is ready.
    pub fn refresh_image_backend(&self) -> Result<(), String> {
        let _operation = self.operation.lock().unwrap_or_else(|e| e.into_inner());
        if self.shutting_down.load(Ordering::SeqCst) {
            return Ok(());
        }
        let latest = self.current_image_backend();
        let mut slot = self.lock_child();
        let Some(owned) = slot.as_mut() else {
            return Ok(());
        };
        if !owned.ready || !matches!(owned.child.try_wait(), Ok(None)) {
            // A dead child is replaced by the supervisor, which spawns with `latest`.
            return Ok(());
        }
        if owned.image_backend == latest {
            return Ok(());
        }
        let line = image_backend_control_line(latest.as_ref());
        let stdin = owned
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| "Local Gateway control pipe is unavailable".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|_| "Unable to update the local Gateway image backend".to_string())?;
        owned.image_backend = latest;
        Ok(())
    }

    /// Caller holds `operation`.
    fn start_locked(
        &self,
        options: LocalGatewayOptions,
        epoch: u64,
    ) -> Result<LocalGatewayReady, String> {
        if self.cancelled(epoch) {
            return Err("Local Gateway startup was cancelled".into());
        }

        {
            let mut slot = self.lock_child();
            if let Some(owned) = slot.as_mut() {
                match owned.child.try_wait() {
                    Ok(Some(_)) => {
                        slot.take();
                    }
                    Ok(None) if owned.options == options && owned.ready => {
                        return Ok(ready_info(owned));
                    }
                    Ok(None) => {
                        validate_options(&options)?;
                        owned.terminate()?;
                        slot.take();
                    }
                    Err(_) => {
                        return Err("Unable to inspect the local Gateway process".into());
                    }
                }
            }
        }

        validate_options(&options)?;
        // Check before spawning, so an existing listener is neither contacted
        // using the managed token nor mistaken for the service we just started.
        let reservation =
            TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, options.port))
                .map_err(|_| format!("Local Gateway port {} is already in use", options.port))?;
        std::fs::create_dir_all(&options.data_dir)
            .map_err(|_| "Unable to prepare the local Gateway data directory".to_string())?;
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(HEALTH_TIMEOUT.min(self.startup_timeout))
            .connect_timeout(HEALTH_TIMEOUT.min(self.startup_timeout))
            .build()
            .map_err(|_| "Unable to prepare the local Gateway health check".to_string())?;
        if self.cancelled(epoch) {
            return Err("Local Gateway startup was cancelled".into());
        }

        let nonce = uuid::Uuid::new_v4().to_string();
        let mut command = Command::new(&options.binary);
        command
            // Desktop ownership uses its dedicated data directory and plain
            // loopback HTTP. Shell/developer settings for an external Gateway
            // must not redirect its database or enable unexpected TLS.
            .env_remove("LIVEAGENT_GATEWAY_AGENT_DB")
            .env_remove("LIVEAGENT_GATEWAY_TLS_CERT")
            .env_remove("LIVEAGENT_GATEWAY_TLS_KEY")
            .env(
                "LIVEAGENT_GATEWAY_HTTP_ADDR",
                format!("127.0.0.1:{}", options.port),
            )
            .env("LIVEAGENT_GATEWAY_DATA_DIR", &options.data_dir)
            .env("LIVEAGENT_GATEWAY_TOKEN", &options.token)
            .env("LIVEAGENT_GATEWAY_INSTANCE_NONCE", &nonce)
            .env("LIVEAGENT_GATEWAY_DESKTOP_PARENT", "1")
            // Keep Child.stdin's writer owned for the complete desktop process
            // lifetime. OS handle closure on abrupt desktop termination gives
            // Go EOF too, including Tauri dev watcher restarts which skip Drop.
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let image_backend = self.current_image_backend();
        apply_image_backend_env(&mut command, image_backend.as_ref());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        // There is inevitably a bind race between releasing this socket and Go
        // binding. The per-spawn nonce prevents adopting the winner of that race.
        drop(reservation);
        let child = command.spawn().map_err(|err| match err.kind() {
            std::io::ErrorKind::NotFound => "Local Gateway executable was not found".to_string(),
            std::io::ErrorKind::PermissionDenied => {
                "Permission denied starting the local Gateway executable".to_string()
            }
            _ => "Unable to start the local Gateway executable".to_string(),
        })?;
        *self.lock_child() = Some(OwnedGateway {
            child,
            options,
            nonce,
            ready: false,
            image_backend,
        });

        let result = self.wait_until_ready(&client, epoch);
        if result.is_err() {
            // Keep ownership if collection fails, so stop/drop can retry.
            self.collect_child()?;
        }
        result
    }

    fn wait_until_ready(
        &self,
        client: &reqwest::blocking::Client,
        epoch: u64,
    ) -> Result<LocalGatewayReady, String> {
        let started = Instant::now();
        loop {
            if self.cancelled(epoch) {
                return Err("Local Gateway startup was cancelled".into());
            }
            let (url, nonce) = {
                let mut slot = self.lock_child();
                let owned = slot.as_mut().ok_or("Local Gateway startup was cancelled")?;
                match owned.child.try_wait() {
                    Ok(Some(status)) => {
                        return Err(format!(
                            "Local Gateway exited before becoming ready ({status})"
                        ));
                    }
                    Ok(None) => {}
                    Err(_) => return Err("Unable to inspect the local Gateway process".into()),
                }
                (
                    format!("http://127.0.0.1:{}/healthz", owned.options.port),
                    owned.nonce.clone(),
                )
            };
            // Only inspect status and a single bounded header. Do not buffer an
            // untrusted response body or propagate reqwest errors/credentials.
            let healthy = client
                .get(url)
                // Sending a credential here could expose it to a listener that
                // wins the unavoidable bind race. Prove nonce knowledge using a
                // one-way challenge; only our child can return the raw nonce.
                .header(INSTANCE_PROBE_HEADER, instance_probe(&nonce))
                .send()
                .is_ok_and(|response| {
                    response.status().is_success()
                        && response
                            .headers()
                            .get(INSTANCE_HEADER)
                            .is_some_and(|value| value.as_bytes() == nonce.as_bytes())
                });
            if self.cancelled(epoch) {
                return Err("Local Gateway startup was cancelled".into());
            }
            if healthy {
                let mut slot = self.lock_child();
                let owned = slot.as_mut().ok_or("Local Gateway startup was cancelled")?;
                if !matches!(owned.child.try_wait(), Ok(None)) {
                    return Err("Local Gateway exited during its health check".into());
                }
                owned.ready = true;
                return Ok(ready_info(owned));
            }
            if started.elapsed() >= self.startup_timeout {
                return Err("Local Gateway startup timed out waiting for its health check".into());
            }
            std::thread::sleep(
                POLL_INTERVAL
                    .min(self.startup_timeout - started.elapsed().min(self.startup_timeout)),
            );
        }
    }

    fn collect_child(&self) -> Result<(), String> {
        let mut slot = self.lock_child();
        if let Some(owned) = slot.as_mut() {
            owned.terminate()?;
        }
        slot.take();
        Ok(())
    }

    /// Cancel a pending start and collect only this manager's child. Retry is
    /// allowed after stop; `shutdown` additionally prevents any later start.
    pub fn stop(&self) -> Result<(), String> {
        self.cancel_start();
        let _operation = self.operation.lock().unwrap_or_else(|e| e.into_inner());
        self.collect_child()
    }

    pub fn shutdown(&self) -> Result<(), String> {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.stop()
    }
}

impl Drop for LocalGatewayManager {
    fn drop(&mut self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        // OwnedGateway::drop is a final safeguard even if a prior operation
        // panicked. No worker holds a borrowed manager once drop is possible.
        self.child
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}

fn ready_info(owned: &OwnedGateway) -> LocalGatewayReady {
    LocalGatewayReady {
        url: format!("http://127.0.0.1:{}", owned.options.port),
        pid: owned.child.id(),
        port: owned.options.port,
    }
}

fn instance_probe(nonce: &str) -> String {
    Sha256::digest(nonce.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_options(options: &LocalGatewayOptions) -> Result<(), String> {
    if options.port == 0 {
        return Err("Local Gateway requires a nonzero loopback port".into());
    }
    if options.token.trim().is_empty() || options.token.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err("Local Gateway requires a valid authentication token".into());
    }
    if !options.binary.is_file() {
        return Err("Local Gateway executable was not found".into());
    }
    #[cfg(windows)]
    if !options
        .binary
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return Err("Local Gateway must be a Windows executable (.exe)".into());
    }
    Ok(())
}

#[cfg(test)]
mod image_backend_tests {
    use super::*;

    fn options() -> LocalGatewayOptions {
        LocalGatewayOptions {
            binary: std::env::current_exe().expect("test binary"),
            data_dir: std::env::temp_dir(),
            port: 1,
            token: "gateway-fixture".into(),
        }
    }

    fn backend(url: &str, token: &str) -> LocalImageBackend {
        LocalImageBackend {
            url: url.into(),
            token: token.into(),
        }
    }

    fn envs(command: &Command) -> Vec<(String, Option<String>)> {
        command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect()
    }

    #[test]
    fn spawned_command_gets_the_image_pair_and_never_the_chat_backend() {
        let mut command = Command::new("gateway");
        command.env("LIVEAGENT_GATEWAY_KBRAIN_URL", "http://127.0.0.1:9");
        apply_image_backend_env(
            &mut command,
            Some(&backend("http://127.0.0.1:47321", "kb-fixture")),
        );
        let env = envs(&command);
        let get = |name: &str| {
            env.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        assert_eq!(
            get(IMAGE_ENV_URL),
            Some(Some("http://127.0.0.1:47321".into()))
        );
        assert_eq!(get(IMAGE_ENV_TOKEN), Some(Some("kb-fixture".into())));
        for name in INHERITED_IMAGE_ENV {
            // Removal overrides even a value set earlier on the same command.
            assert_eq!(
                get(name),
                Some(None),
                "{name} must be removed so the chat relay stays off"
            );
        }
        let mut disabled = Command::new("gateway");
        apply_image_backend_env(&mut disabled, None);
        assert!(envs(&disabled).iter().all(|(_, value)| value.is_none()));
    }

    #[test]
    fn control_line_is_one_json_line_the_gateway_understands() {
        let line = image_backend_control_line(Some(&backend("http://127.0.0.1:47321", "a\"b")));
        assert!(line.ends_with('\n') && line.matches('\n').count() == 1);
        let value: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(value["type"], "image_backend");
        assert_eq!(value["url"], "http://127.0.0.1:47321");
        assert_eq!(value["token"], "a\"b");
        let cleared: serde_json::Value =
            serde_json::from_str(image_backend_control_line(None).trim_end()).unwrap();
        assert_eq!(cleared, serde_json::json!({ "type": "image_backend" }));
    }

    #[test]
    fn loopback_rule_matches_the_gateway() {
        for good in [
            "http://127.0.0.1:47321",
            "http://[::1]:47321",
            "https://127.0.0.1:47321",
        ] {
            assert!(backend(good, "kb").is_authenticated_loopback(), "{good}");
        }
        for bad in [
            "http://example.com:47321",
            "http://localhost:47321",
            "http://127.0.0.1:1@evil.com",
            "http://user:pw@127.0.0.1:47321",
            "http://127.0.0.1:47321/?token=x",
            "http://127.0.0.1:47321/#x",
            "ftp://127.0.0.1:47321",
        ] {
            assert!(!backend(bad, "kb").is_authenticated_loopback(), "{bad}");
        }
        assert!(!backend("http://127.0.0.1:47321", " ").is_authenticated_loopback());
        assert!(!backend("http://127.0.0.1:47321", "kb\n").is_authenticated_loopback());
    }

    #[test]
    fn debug_output_redacts_the_token() {
        let printed = format!("{:?}", options());
        assert!(!printed.contains("gateway-fixture"));
    }

    #[test]
    fn source_is_read_live_and_refresh_never_spawns_or_revives() {
        let manager = LocalGatewayManager::new();
        assert!(
            manager.current_image_backend().is_none(),
            "no source: images off"
        );
        let live = Arc::new(Mutex::new(Some(backend("http://127.0.0.1:2", "live"))));
        let reader = Arc::clone(&live);
        manager.set_image_backend_source(Arc::new(move || reader.lock().unwrap().clone()));
        assert!(manager.current_image_backend() == Some(backend("http://127.0.0.1:2", "live")));
        *live.lock().unwrap() = None;
        assert!(
            manager.current_image_backend().is_none(),
            "K-Brain gone disables images"
        );
        assert!(
            manager.refresh_image_backend().is_ok(),
            "nothing running: nothing to rebind"
        );
        assert!(
            manager.lock_child().is_none(),
            "refresh never spawns a Gateway"
        );
        manager.shutdown().unwrap();
        assert!(manager.refresh_image_backend().is_ok());
        assert!(
            manager.lock_child().is_none(),
            "refresh never revives a shut-down Gateway"
        );
    }
}
