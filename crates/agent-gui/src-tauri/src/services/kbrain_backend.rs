#[cfg(test)]
use std::fs;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use sha2::{Digest, Sha256};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use reqwest::header::AUTHORIZATION;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::runtime::process::terminate_child_process_tree;
use crate::services::kbrain_health::parse_health;
use crate::services::system_proxy;

const BACKEND_DIR: &str = "kbrain";
#[cfg(test)]
const CONFIG_FILE: &str = "config.json";
const TOKEN_ENV: &str = "K_BRAIN_BACKEND_TOKEN";
/// 应用代理取值（见 `system_proxy::kbrain_proxy_value`）；必须总是设置，
/// 否则 K-brain 会回退到继承的 HTTP(S)_PROXY。
const PROXY_ENV: &str = "LIVEAGENT_KBRAIN_PROXY";
const DEBUG_BINARY_ENV: &str = "LIVEAGENT_KBRAIN_BINARY";
#[cfg(test)]
const TEST_BINARY_ENV: &str = "LIVEAGENT_KBRAIN_TEST_BINARY";
const PROTOCOL_VERSION: &str = "kbrain.agent.v1";
const READY_PREFIX: &str = "k-brain backend listening on ";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_GRACE: Duration = Duration::from_secs(2);
const MAX_STDOUT_LINE: usize = 16 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KBrainBackendConnection {
    pub base_url: String,
    pub token: String,
    pub protocol_version: String,
    pub storage_id: String,
}

struct BackendProcess {
    child: Child,
    // Keeping stdin open enables the backend's parent-stdio watchdog.
    stdin: Option<ChildStdin>,
}

impl Drop for BackendProcess {
    fn drop(&mut self) {
        drop(self.stdin.take());
        match self.child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => {
                let _ = terminate_child_process_tree(&mut self.child, STOP_GRACE);
            }
        }
    }
}

enum StartupEvent {
    Ready(String),
    Eof,
    Error(String),
}

pub struct KBrainBackendManager {
    process: Mutex<Option<BackendProcess>>,
    connection: KBrainBackendConnection,
}

pub struct KBrainBackendState {
    manager: Mutex<Option<Arc<KBrainBackendManager>>>,
    start_lock: Mutex<()>,
    shutdown_epoch: AtomicU64,
    exiting: AtomicBool,
    /// Every listener/token change (start, restart on a new port, shutdown), so
    /// dependents such as the managed Gateway never keep a stale backend.
    connection_tx: tokio::sync::watch::Sender<Option<KBrainBackendConnection>>,
}

impl Default for KBrainBackendState {
    fn default() -> Self {
        Self {
            manager: Mutex::new(None),
            start_lock: Mutex::new(()),
            shutdown_epoch: AtomicU64::new(0),
            exiting: AtomicBool::new(false),
            connection_tx: tokio::sync::watch::channel(None).0,
        }
    }
}

// Storage identity follows the canonical data root, never the ephemeral listener or token.
fn backend_storage_id(root: &Path) -> Result<String, String> {
    let canonical = root.canonicalize().map_err(|_| "Unable to identify K-brain data root".to_string())?;
    let digest = Sha256::digest(canonical.as_os_str().as_encoded_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("local-{hex}"))
}

impl KBrainBackendManager {
    #[cfg(test)]
    fn start_with_binary_and_timeout(
        binary: PathBuf,
        backend_dir: PathBuf,
        startup_timeout: Duration,
    ) -> Result<Arc<Self>, String> {
        Self::start(binary, backend_dir, None, startup_timeout, &|| false)
    }

    fn start(
        binary: PathBuf,
        backend_dir: PathBuf,
        legacy_desktop_dir: Option<PathBuf>,
        startup_timeout: Duration,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Arc<Self>, String> {
        if cancelled() {
            return Err("K-brain backend startup cancelled".into());
        }
        std::fs::create_dir_all(&backend_dir).map_err(|_| "Unable to create K-brain data root".to_string())?;
        let storage_id = backend_storage_id(&backend_dir)?;
        let token = uuid::Uuid::new_v4().to_string();

        let mut command = Command::new(&binary);
        command
            .arg("backend")
            .arg("-listen")
            .arg("127.0.0.1:0")
            .arg("-data-dir")
            .arg(&backend_dir)
            .arg("-parent-stdio")
            .env(TOKEN_ENV, &token)
            .env("LIVEAGENT_HOME", &backend_dir)
            .env(PROXY_ENV, system_proxy::kbrain_proxy_value())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(legacy) = legacy_desktop_dir {
            command.arg("-legacy-desktop-dir").arg(legacy);
        }
        crate::runtime::process::configure_child_process_group(&mut command);

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start K-brain backend: {error}"))?;
        let stdin = child.stdin.take();
        let mut process = BackendProcess { child, stdin };
        let stdout = match process.child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                return Err("K-brain backend stdout was not piped".to_string());
            }
        };
        if let Some(stderr) = process.child.stderr.take() {
            spawn_stderr_drain(stderr, token.clone())?;
        }
        // Only READY and the terminal stream event enter this bounded channel.
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(2);
        thread::Builder::new()
            .name("kbrain-stdout".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    match read_bounded_line(&mut reader, MAX_STDOUT_LINE) {
                        Ok(Some(line)) => {
                            if let Some(url) = parse_ready_url(&line) {
                                let _ = ready_tx.send(StartupEvent::Ready(url));
                                match io::copy(&mut reader, &mut io::sink()) {
                                    Ok(_) => {
                                        let _ = ready_tx.send(StartupEvent::Eof);
                                    }
                                    Err(error) => {
                                        let _ =
                                            ready_tx.send(StartupEvent::Error(error.to_string()));
                                    }
                                }
                                return;
                            }
                        }
                        Ok(None) => {
                            let _ = ready_tx.send(StartupEvent::Eof);
                            return;
                        }
                        Err(error) => {
                            let _ = ready_tx.send(StartupEvent::Error(error.to_string()));
                            return;
                        }
                    }
                }
            })
            .map_err(|error| format!("failed to start K-brain stdout reader: {error}"))?;

        let deadline = Instant::now() + startup_timeout;
        let base_url = loop {
            if cancelled() {
                return Err("K-brain backend startup cancelled".into());
            }
            let wait = deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(100));
            match ready_rx.recv_timeout(wait) {
                Ok(StartupEvent::Ready(url)) => break url,
                Ok(StartupEvent::Eof) => {
                    let status = child_status_after_eof(&mut process.child)?;
                    return Err(match status {
                        Some(status) => format!(
                            "K-brain backend exited before becoming ready (code {})",
                            status.code().unwrap_or(-1)
                        ),
                        None => "K-brain backend stdout closed before becoming ready".to_string(),
                    });
                }
                Ok(StartupEvent::Error(error)) => {
                    return Err(format!(
                        "failed to read K-brain backend startup output: {error}"
                    ));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("K-brain backend startup output reader disconnected".to_string());
                }
            }
            if let Some(status) = process
                .child
                .try_wait()
                .map_err(|error| format!("failed to inspect K-brain backend: {error}"))?
            {
                return Err(format!(
                    "K-brain backend exited before becoming ready (code {})",
                    status.code().unwrap_or(-1)
                ));
            }
            if Instant::now() >= deadline {
                return Err(
                    "K-brain backend did not become ready before the startup timeout".into(),
                );
            }
        };

        let connection = KBrainBackendConnection {
            base_url,
            token,
            protocol_version: PROTOCOL_VERSION.to_string(),
            storage_id,
        };
        wait_for_health(
            &connection,
            deadline,
            &mut process.child,
            &ready_rx,
            cancelled,
        )?;

        Ok(Arc::new(Self {
            process: Mutex::new(Some(process)),
            connection,
        }))
    }

    pub fn connection(&self) -> KBrainBackendConnection {
        self.connection.clone()
    }

    pub fn is_running(&self) -> bool {
        let Ok(mut guard) = self.process.lock() else {
            return false;
        };
        let Some(process) = guard.as_mut() else {
            return false;
        };
        match process.child.try_wait() {
            Ok(None) => true,
            Ok(Some(_)) | Err(_) => {
                guard.take();
                false
            }
        }
    }

    pub fn shutdown(&self) {
        // Release the process mutex before waiting for the child tree.
        let process = self.process.lock().ok().and_then(|mut guard| guard.take());
        if let Some(process) = process {
            drop(process);
        }
    }
}

impl KBrainBackendState {
    pub fn ensure_started(&self, app: &AppHandle) -> Result<KBrainBackendConnection, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("failed to resolve LiveAgent app data directory: {error}"))?;
        let binary = resolve_binary()?;
        let home =
            crate::runtime::data_home::home_dir().ok_or_else(|| "failed to resolve LiveAgent home".to_string())?;
        let preferred = std::env::var_os("LIVEAGENT_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let legacy_override = std::env::var_os("K_BRAIN_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let overridden = preferred.is_some() || legacy_override.is_some();
        let root = preferred
            .or(legacy_override)
            .unwrap_or_else(|| home.join(".liveagent"));
        let legacy = (!overridden).then(|| data_dir.join(BACKEND_DIR));
        self.ensure_started_with_paths(binary, root, legacy)
    }

    #[cfg(test)]
    fn ensure_started_with_binary(
        &self,
        binary: PathBuf,
        app_data_dir: PathBuf,
    ) -> Result<KBrainBackendConnection, String> {
        self.ensure_started_with_paths(binary, app_data_dir, None)
    }

    fn ensure_started_with_paths(
        &self,
        binary: PathBuf,
        app_data_dir: PathBuf,
        legacy_desktop_dir: Option<PathBuf>,
    ) -> Result<KBrainBackendConnection, String> {
        let epoch = self.shutdown_epoch.load(Ordering::SeqCst);
        let cancelled = || {
            self.exiting.load(Ordering::SeqCst)
                || self.shutdown_epoch.load(Ordering::SeqCst) != epoch
        };
        let _start_guard = self
            .start_lock
            .lock()
            .map_err(|_| "K-brain backend start lock is poisoned".to_string())?;

        if cancelled() {
            return Err("K-brain backend startup cancelled".into());
        }
        let existing = {
            let guard = self
                .manager
                .lock()
                .map_err(|_| "K-brain backend state is poisoned".to_string())?;
            guard.as_ref().cloned()
        };
        if let Some(manager) = existing {
            if manager.is_running() {
                return Ok(manager.connection());
            }
            // The snapshot above deliberately drops the state mutex before
            // probing/removing a dead process; do not nest manager locks.
            let stale = self
                .manager
                .lock()
                .map_err(|_| "K-brain backend state is poisoned".to_string())?
                .take();
            if let Some(stale) = stale {
                stale.shutdown();
                self.connection_tx.send_replace(None);
            }
        }

        // Convert startup panics before unwinding through the serialization lock.
        let manager = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            KBrainBackendManager::start(
                binary,
                app_data_dir,
                legacy_desktop_dir,
                STARTUP_TIMEOUT,
                &cancelled,
            )
        }))
        .map_err(|_| "K-brain backend startup panicked".to_string())??;
        if cancelled() {
            return Err("K-brain backend startup cancelled".into());
        }
        let connection = manager.connection();
        self.manager
            .lock()
            .map_err(|_| "K-brain backend state is poisoned".to_string())?
            .replace(manager);
        self.connection_tx.send_replace(Some(connection.clone()));
        Ok(connection)
    }

    /// The live backend, without starting one: callers that merely follow
    /// K-Brain (the managed Gateway) must never launch it, e.g. during an update.
    pub fn running_connection(&self) -> Option<KBrainBackendConnection> {
        let manager = self.manager.lock().ok()?.as_ref().cloned()?;
        manager.is_running().then(|| manager.connection())
    }

    pub fn subscribe_connection(
        &self,
    ) -> tokio::sync::watch::Receiver<Option<KBrainBackendConnection>> {
        self.connection_tx.subscribe()
    }

    pub fn shutdown(&self) {
        // Wake the startup/health loops before waiting for serialization.
        self.shutdown_epoch.fetch_add(1, Ordering::SeqCst);
        let Ok(_start_guard) = self.start_lock.lock() else {
            return;
        };
        let manager = self.manager.lock().ok().and_then(|mut guard| guard.take());
        if let Some(manager) = manager {
            manager.shutdown();
            self.connection_tx.send_replace(None);
        }
    }

    pub fn shutdown_for_exit(&self) {
        self.exiting.store(true, Ordering::SeqCst);
        self.shutdown();
    }

    /// 把当前应用代理推给运行中的 K-brain（best effort）。持有 start_lock，
    /// 避免与并发启动竞争：启动中的进程要么已用新值 spawn，要么在此之后收到推送。
    /// 未运行时无需推送，下次 spawn 会经 env 读取最新值。
    pub fn push_proxy_setting(&self) {
        let Ok(_start_guard) = self.start_lock.lock() else {
            return;
        };
        let manager = self
            .manager
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().cloned());
        let Some(manager) = manager.filter(|manager| manager.is_running()) else {
            return;
        };
        let proxy = system_proxy::kbrain_proxy_value();
        if let Err(error) = put_proxy_setting(&manager.connection(), &proxy) {
            eprintln!("failed to push proxy setting to K-brain backend: {error}");
        }
    }
}

fn put_proxy_setting(connection: &KBrainBackendConnection, proxy: &str) -> Result<(), String> {
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("failed to create K-brain client: {error}"))?;
    // 错误信息只带状态码，不带代理 URL/凭据。
    client
        .put(format!("{}/v1/network/proxy", connection.base_url))
        .header(AUTHORIZATION, format!("Bearer {}", connection.token))
        .json(&serde_json::json!({ "proxy": proxy }))
        .send()
        .map_err(|error| format!("request failed: {}", error.without_url()))?
        .error_for_status()
        .map(|_| ())
        .map_err(|error| format!("unexpected status {:?}", error.status()))
}

impl Drop for KBrainBackendManager {
    fn drop(&mut self) {
        if let Ok(process) = self.process.get_mut() {
            if let Some(process) = process.take() {
                drop(process);
            }
        }
    }
}

#[tauri::command]
pub async fn kbrain_backend_connection(
    app: AppHandle,
    state: State<'_, Arc<KBrainBackendState>>,
) -> Result<KBrainBackendConnection, String> {
    let state = Arc::clone(state.inner());
    let handle = app.clone();
    let connection = tauri::async_runtime::spawn_blocking(move || state.ensure_started(&handle))
        .await
        .map_err(|error| format!("K-brain backend startup task failed: {error}"))??;
    Ok(connection)
}

fn resolve_binary() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var(DEBUG_BINARY_ENV) {
        let path = PathBuf::from(value.trim());
        if !path.is_absolute() {
            return Err(format!("{DEBUG_BINARY_ENV} must be an absolute path"));
        }
        return Ok(path);
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("failed to locate LiveAgent executable: {error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "LiveAgent executable has no parent directory".to_string())?;
    let name = if cfg!(windows) {
        "k-brain.exe"
    } else {
        "k-brain"
    };
    Ok(directory.join(name))
}

fn child_status_after_eof(child: &mut Child) -> Result<Option<std::process::ExitStatus>, String> {
    let deadline = Instant::now() + Duration::from_millis(100);
    loop {
        if let Some(status) = child.try_wait().map_err(|error| {
            format!("failed to inspect K-brain backend after stdout EOF: {error}")
        })? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn check_startup_process(
    child: &mut Child,
    events: &std::sync::mpsc::Receiver<StartupEvent>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    if cancelled() {
        return Err("K-brain backend startup cancelled".into());
    }
    if let Some(status) = child
        .try_wait()
        .map_err(|error| format!("failed to inspect K-brain backend: {error}"))?
    {
        return Err(format!(
            "K-brain backend exited during health check ({status})"
        ));
    }
    match events.try_recv() {
        Ok(StartupEvent::Eof) => Err("K-brain backend stdout closed during health check".into()),
        Ok(StartupEvent::Error(error)) => {
            Err(format!("failed to read K-brain backend output: {error}"))
        }
        Err(std::sync::mpsc::TryRecvError::Disconnected) => {
            Err("K-brain backend output reader disconnected during health check".into())
        }
        Ok(StartupEvent::Ready(_)) | Err(std::sync::mpsc::TryRecvError::Empty) => Ok(()),
    }
}

fn wait_for_health(
    connection: &KBrainBackendConnection,
    deadline: Instant,
    child: &mut Child,
    events: &std::sync::mpsc::Receiver<StartupEvent>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|error| format!("failed to create K-brain health client: {error}"))?;
    let url = format!("{}/v1/health", connection.base_url);
    loop {
        check_startup_process(child, events, cancelled)?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("K-brain backend health check timed out".into());
        }
        let result = client
            .get(&url)
            .timeout(remaining.min(Duration::from_millis(500)))
            .header(AUTHORIZATION, format!("Bearer {}", connection.token))
            .send()
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.json::<serde_json::Value>());
        check_startup_process(child, events, cancelled)?;
        if Instant::now() >= deadline {
            return Err("K-brain backend health check timed out".into());
        }
        // 传输或 JSON 错误继续等待；拿到 JSON 后按契约判定，矛盾或类型错误立即失败。
        if let Ok(body) = result {
            return parse_health(&body).map(|_| ());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        thread::sleep(remaining.min(Duration::from_millis(100)));
    }
}

fn spawn_stderr_drain(stderr: impl Read + Send + 'static, token: String) -> Result<(), String> {
    thread::Builder::new()
        .name("kbrain-stderr".into())
        .spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut retained = Vec::with_capacity(MAX_STDERR_BYTES);
            let mut buffer = [0u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(bytes) => {
                        let keep = bytes.min(MAX_STDERR_BYTES);
                        if retained.len() < MAX_STDERR_BYTES {
                            let available = MAX_STDERR_BYTES - retained.len();
                            retained.extend_from_slice(&buffer[..keep.min(available)]);
                        }
                    }
                }
            }
            let _diagnostic = String::from_utf8_lossy(&retained).replace(&token, "<redacted>");
        })
        .map_err(|error| format!("failed to start K-brain stderr reader: {error}"))?;
    Ok(())
}

fn read_bounded_line<R: BufRead>(reader: &mut R, max_bytes: usize) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(String::from_utf8_lossy(&line).into_owned()))
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let consume = newline.map(|index| index + 1).unwrap_or(buffer.len());
        let remaining = max_bytes.saturating_sub(line.len());
        if consume > remaining {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "K-brain stdout line exceeds limit",
            ));
        }
        line.extend_from_slice(&buffer[..consume]);
        reader.consume(consume);
        if newline.is_some() {
            return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
        }
    }
}

fn parse_ready_url(line: &str) -> Option<String> {
    let candidate = line.trim().strip_prefix(READY_PREFIX)?.trim();
    let url = tauri::Url::parse(candidate).ok()?;
    if url.scheme() != "http"
        || url.host_str()? != "127.0.0.1"
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return None;
    }
    let port = url.port()?;
    if port == 0 {
        return None;
    }
    Some(format!("http://127.0.0.1:{port}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    static CHILD_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn test_dir() -> TempDir {
        let root = std::env::var_os("LIVEAGENT_KBRAIN_TEST_SCRATCH")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        tempfile::Builder::new()
            .prefix("kbrain-native-")
            .tempdir_in(root)
            .expect("test directory")
    }

    /// 单请求 HTTP 桩：返回给定状态码，并把收到的原始请求交回。
    fn proxy_endpoint_stub(status: &'static str) -> (String, thread::JoinHandle<String>) {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind stub");
        let base_url = format!("http://{}", listener.local_addr().expect("stub addr"));
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let read = stream.read(&mut chunk).expect("read request");
                request.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&request);
                if read == 0
                    || text
                        .split_once("\r\n\r\n")
                        .is_some_and(|(_, b)| b.ends_with('}'))
                {
                    break;
                }
            }
            let response =
                format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            stream
                .write_all(response.as_bytes())
                .expect("write response");
            String::from_utf8_lossy(&request).into_owned()
        });
        (base_url, handle)
    }

    #[test]
    fn storage_identity_is_stable_and_data_root_scoped() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let id = backend_storage_id(root.path()).unwrap();
        assert_eq!(id, backend_storage_id(&root.path().join(".")).unwrap());
        assert_ne!(id, backend_storage_id(other.path()).unwrap());
        assert!(!id.contains(root.path().to_string_lossy().as_ref()));
        #[cfg(unix)] {
            let link_parent = tempfile::tempdir().unwrap();
            let link = link_parent.path().join("alias");
            std::os::unix::fs::symlink(root.path(), &link).unwrap();
            assert_eq!(id, backend_storage_id(&link).unwrap());
        }
    }

    #[test]
    fn put_proxy_setting_sends_authorized_json_and_hides_value_on_failure() {
        let proxy = "socks5h://user:secret@proxy.local:1080";
        let connection = |base_url: String| KBrainBackendConnection {
            base_url,
            token: "test-token".into(),
            protocol_version: PROTOCOL_VERSION.into(),
            storage_id: "test-storage".into(),
        };

        let (base_url, handle) = proxy_endpoint_stub("200 OK");
        put_proxy_setting(&connection(base_url), proxy).expect("push accepted");
        let request = handle.join().expect("stub thread");
        assert!(request.starts_with("PUT /v1/network/proxy HTTP/1.1\r\n"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-token\r\n"));
        assert!(request.ends_with(r#"{"proxy":"socks5h://user:secret@proxy.local:1080"}"#));

        let (base_url, handle) = proxy_endpoint_stub("400 Bad Request");
        let error = put_proxy_setting(&connection(base_url), proxy).expect_err("push rejected");
        handle.join().expect("stub thread");
        assert!(error.contains("400"), "{error}");
        assert!(!error.contains("secret") && !error.contains("proxy.local"));
    }

    #[test]
    fn push_proxy_setting_is_a_noop_without_a_running_backend() {
        KBrainBackendState::default().push_proxy_setting();
    }

    #[test]
    fn parses_only_strict_loopback_ready_urls() {
        assert_eq!(
            parse_ready_url("k-brain backend listening on http://127.0.0.1:41234"),
            Some("http://127.0.0.1:41234".to_string())
        );
        for line in [
            "ready http://127.0.0.1:41234",
            "k-brain backend listening on http://localhost:41234",
            "k-brain backend listening on http://127.0.0.1:41234/path",
            "k-brain backend listening on http://user:pass@127.0.0.1:41234/",
            "k-brain backend listening on http://127.0.0.1:41234/?x=1",
            "k-brain backend listening on http://192.168.1.2:41234/",
        ] {
            assert_eq!(
                parse_ready_url(line),
                None,
                "accepted invalid ready line: {line}"
            );
        }
    }

    #[cfg(unix)]
    fn fixture_binary(temp: &TempDir, mode: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = temp.path().join(format!("kbrain-fixture-{mode}"));
        let script = r##"#!/usr/bin/env python3
import json
import os
from pathlib import Path
import select
import signal
import socket
import sys
import threading
import time

mode = os.path.basename(sys.argv[0]).split("kbrain-fixture-", 1)[-1]
data = Path(sys.argv[sys.argv.index("-data-dir") + 1])
data.mkdir(parents=True, exist_ok=True)
(data / "fixture.pid").write_text(str(os.getpid()))
if mode == "oversized":
    print("x" * 20000, flush=True)
    time.sleep(30)
if mode == "error":
    print("fixture startup failure", file=sys.stderr, flush=True)
    sys.exit(23)
if mode == "timeout":
    time.sleep(30)
    sys.exit(0)
if mode == "stdout-close":
    os.close(1)
    time.sleep(30)
    sys.exit(0)

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 0))
server.listen(8)
port = server.getsockname()[1]
if mode == "pre-ready":
    for index in range(12):
        print(f"fixture pre-ready {index}", flush=True)
print(f"k-brain backend listening on http://127.0.0.1:{port}", flush=True)
if mode == "health-close":
    os.close(1)
    time.sleep(30)

def parent_watch():
    sys.stdin.buffer.read()
    if mode == "parent-loss":
        os._exit(0)

threading.Thread(target=parent_watch, daemon=True).start()
if mode == "stubborn":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
token = os.environ["K_BRAIN_BACKEND_TOKEN"]
while True:
    ready, _, _ = select.select([server], [], [], 0.1)
    if not ready:
        continue
    conn, _ = server.accept()
    try:
        request = conn.recv(4096)
        if mode == "health-hang":
            (data / "health-started").touch()
            time.sleep(30)
        authorized = (f"authorization: bearer {token}".encode() in request.lower())
        if b"/v1/health" in request and authorized:
            body = json.dumps({"status": "ok", "version": "kbrain.agent.v1"}).encode()
            response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body
        else:
            body = b"unauthorized"
            response = b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\nConnection: close\r\n\r\n" + body
        conn.sendall(response)
    finally:
        conn.close()
"##;
        fs::write(&path, script).expect("fixture script");
        let mut permissions = fs::metadata(&path).expect("fixture metadata").permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).expect("fixture executable");
        path
    }

    #[cfg(unix)]
    fn assert_fixture_reaped(data: &std::path::Path) {
        let pid_path = data.join("fixture.pid");
        let deadline = Instant::now() + Duration::from_secs(1);
        let pid = loop {
            if let Ok(pid) = fs::read_to_string(&pid_path) {
                break pid;
            }
            assert!(Instant::now() < deadline, "fixture pid was not recorded");
            thread::sleep(Duration::from_millis(10));
        };
        assert_fixture_pid_absent(&pid, deadline);
    }

    #[cfg(unix)]
    fn assert_fixture_pid_absent(pid: &str, deadline: Instant) {
        loop {
            let output = Command::new("ps")
                .args(["-p", pid.trim(), "-o", "pid="])
                .output()
                .expect("ps");
            if output.stdout.is_empty() {
                return;
            }
            assert!(Instant::now() < deadline, "fixture still exists: {pid}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn assert_fixture_reaped_if_recorded(data: &std::path::Path) {
        if let Ok(pid) = fs::read_to_string(data.join("fixture.pid")) {
            assert_fixture_pid_absent(&pid, Instant::now() + Duration::from_secs(1));
        }
    }

    #[cfg(unix)]
    #[test]
    fn fixture_read_errors_and_health_eof_are_propagated_and_reaped() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for (mode, expected) in [
            ("oversized", "stdout line exceeds limit"),
            ("health-close", "stdout closed during health check"),
        ] {
            let temp = test_dir();
            let data = temp.path().join("data");
            let started = Instant::now();
            let error = KBrainBackendManager::start_with_binary_and_timeout(
                fixture_binary(&temp, mode),
                data.clone(),
                Duration::from_secs(5),
            )
            .err()
            .expect("startup should fail");
            assert!(error.contains(expected), "{mode}: {error}");
            assert!(started.elapsed() < Duration::from_secs(5));
            assert_fixture_reaped(&data);
        }
    }

    #[cfg(unix)]
    #[test]
    fn fixture_health_timeout_is_bounded_and_reaped() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let data = temp.path().join("data");
        let started = Instant::now();
        let error = KBrainBackendManager::start_with_binary_and_timeout(
            fixture_binary(&temp, "health-hang"),
            data.clone(),
            Duration::from_secs(3),
        )
        .err()
        .expect("health should time out");
        assert!(error.contains("health check timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_fixture_reaped(&data);
    }

    #[cfg(unix)]
    #[test]
    fn fixture_shutdown_cancels_startup_and_health_and_allows_retry() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for (mode, marker) in [
            ("timeout", "fixture.pid"),
            ("health-hang", "health-started"),
        ] {
            let temp = test_dir();
            let data = temp.path().join("data");
            let binary = fixture_binary(&temp, mode);
            let state = Arc::new(KBrainBackendState::default());
            let worker_state = Arc::clone(&state);
            let worker_data = data.clone();
            let (tx, rx) = std::sync::mpsc::channel();
            let worker = thread::spawn(move || {
                let _ = tx.send(worker_state.ensure_started_with_binary(binary, worker_data));
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            while !data.join(marker).exists() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            assert!(data.join(marker).exists(), "fixture never entered {mode}");
            let started = Instant::now();
            state.shutdown();
            assert!(
                started.elapsed() < Duration::from_secs(3),
                "shutdown took too long"
            );
            let error = rx
                .recv_timeout(Duration::from_secs(1))
                .expect("startup result")
                .expect_err("startup should be cancelled");
            assert!(error.contains("cancelled"), "{error}");
            worker.join().expect("startup worker");
            assert_fixture_reaped(&data);
            assert!(state.manager.lock().expect("manager lock").is_none());
            state
                .ensure_started_with_binary(fixture_binary(&temp, "parent-loss"), data.clone())
                .expect("start after cancellation");
            state.shutdown();
            assert_fixture_reaped(&data);
        }
    }

    #[test]
    fn running_connection_without_a_backend_is_none_and_never_starts_one() {
        let state = KBrainBackendState::default();
        assert!(state.running_connection().is_none());
        assert!(state.manager.lock().unwrap().is_none(), "reading must not launch K-Brain");
        assert!(state.subscribe_connection().borrow().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn connection_changes_are_published_for_followers_like_the_gateway() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "parent-loss");
        let data = temp.path().join("data");
        let state = KBrainBackendState::default();
        let mut changes = state.subscribe_connection();
        let started = state
            .ensure_started_with_binary(binary, data.clone())
            .expect("backend");
        assert!(changes.has_changed().unwrap(), "start must notify");
        assert_eq!(
            changes.borrow_and_update().as_ref().map(|c| c.base_url.clone()),
            Some(started.base_url.clone())
        );
        assert_eq!(
            state.running_connection().map(|c| c.token),
            Some(started.token.clone())
        );
        state.shutdown();
        assert!(changes.has_changed().unwrap(), "shutdown must notify");
        assert!(changes.borrow_and_update().is_none());
        assert!(state.running_connection().is_none());
        assert_fixture_reaped(&data);
    }

    #[cfg(unix)]
    #[test]
    fn exit_stops_only_owned_backend_and_prevents_restart() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "parent-loss");
        let state = KBrainBackendState::default();
        let other = KBrainBackendState::default();
        let own_data = temp.path().join("owned");
        let other_data = temp.path().join("other");
        state
            .ensure_started_with_binary(binary.clone(), own_data.clone())
            .expect("owned backend");
        other
            .ensure_started_with_binary(binary.clone(), other_data.clone())
            .expect("other backend");
        let started = Instant::now();
        state.shutdown_for_exit();
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_fixture_reaped(&own_data);
        assert!(other.manager.lock().unwrap().as_ref().unwrap().is_running());
        assert!(state
            .ensure_started_with_binary(binary, own_data)
            .unwrap_err()
            .contains("cancelled"));
        state.shutdown_for_exit();
        other.shutdown_for_exit();
        assert_fixture_reaped(&other_data);
    }

    #[cfg(unix)]
    #[test]
    fn exit_force_stops_unresponsive_owned_backend() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let state = KBrainBackendState::default();
        let data = temp.path().join("data");
        state
            .ensure_started_with_binary(fixture_binary(&temp, "stubborn"), data.clone())
            .expect("backend");
        let started = Instant::now();
        state.shutdown_for_exit();
        assert!(started.elapsed() < STOP_GRACE + Duration::from_secs(1));
        assert_fixture_reaped(&data);
    }

    #[cfg(unix)]
    #[test]
    fn exit_cancels_inflight_startup_and_stays_closed() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "health-hang");
        let data = temp.path().join("data");
        let state = Arc::new(KBrainBackendState::default());
        let worker_state = Arc::clone(&state);
        let worker_data = data.clone();
        let worker_binary = binary.clone();
        let worker = thread::spawn(move || {
            worker_state.ensure_started_with_binary(worker_binary, worker_data)
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !data.join("health-started").exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(data.join("health-started").exists());
        state.shutdown_for_exit();
        assert!(worker.join().unwrap().unwrap_err().contains("cancelled"));
        assert_fixture_reaped(&data);
        assert!(state
            .ensure_started_with_binary(binary, data)
            .unwrap_err()
            .contains("cancelled"));
    }

    #[cfg(unix)]
    #[test]
    fn fixture_ready_survives_more_than_eight_pre_ready_lines() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "pre-ready");
        let manager = KBrainBackendManager::start_with_binary_and_timeout(
            binary,
            temp.path().join("data"),
            Duration::from_secs(5),
        )
        .expect("ready line must not be dropped");
        assert!(manager
            .connection()
            .base_url
            .starts_with("http://127.0.0.1:"));
        manager.shutdown();
    }

    #[cfg(unix)]
    #[test]
    fn fixture_stdout_eof_while_child_is_alive_fails_without_startup_timeout() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "stdout-close");
        let started = Instant::now();
        let result = KBrainBackendManager::start_with_binary_and_timeout(
            binary,
            temp.path().join("data"),
            Duration::from_secs(5),
        );
        assert!(result
            .err()
            .expect("EOF error")
            .contains("stdout closed before becoming ready"));
        assert_fixture_reaped(&temp.path().join("data"));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "EOF was not propagated"
        );
    }

    #[cfg(unix)]
    #[test]
    fn fixture_child_error_and_startup_timeout_are_reported_and_bounded() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "error");
        let error = match KBrainBackendManager::start_with_binary_and_timeout(
            binary,
            temp.path().join("error-data"),
            Duration::from_secs(5),
        ) {
            Ok(_) => panic!("child error must fail startup"),
            Err(error) => error,
        };
        assert!(
            error.contains("code 23") || error.contains("stdout closed before becoming ready"),
            "{error}"
        );

        let binary = fixture_binary(&temp, "timeout");
        let started = Instant::now();
        let error = match KBrainBackendManager::start_with_binary_and_timeout(
            binary,
            temp.path().join("timeout-data"),
            Duration::from_secs(2),
        ) {
            Ok(_) => panic!("startup timeout must fail"),
            Err(error) => error,
        };
        assert!(error.contains("startup timeout"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_fixture_reaped(&temp.path().join("error-data"));
        // The deadline can expire before the interpreter records its PID.
        assert_fixture_reaped_if_recorded(&temp.path().join("timeout-data"));
    }

    #[cfg(unix)]
    #[test]
    fn fixture_exits_after_manager_parent_stdin_is_lost() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "parent-loss");
        let manager = KBrainBackendManager::start_with_binary_and_timeout(
            binary,
            temp.path().join("data"),
            Duration::from_secs(5),
        )
        .expect("parent-loss fixture should become ready");
        {
            let mut process = manager.process.lock().expect("process lock");
            process.as_mut().expect("backend process").stdin.take();
        }
        for _ in 0..40 {
            if !manager.is_running() {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("backend did not exit after parent stdin loss");
    }

    #[cfg(unix)]
    #[test]
    fn host_does_not_mutate_user_config() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        use std::os::unix::fs::PermissionsExt;

        let temp = test_dir();
        let data = temp.path().join("data");
        fs::create_dir_all(&data).expect("data directory");
        let config = data.join(CONFIG_FILE);
        let content = b"{\"language\":\"en\",\"provider\":\"fixture\"}\n";
        fs::write(&config, content).expect("config");
        let mut permissions = fs::metadata(&config)
            .expect("config metadata")
            .permissions();
        permissions.set_mode(0o644);
        fs::set_permissions(&config, permissions).expect("insecure config mode");

        let binary = fixture_binary(&temp, "parent-loss");
        let manager = KBrainBackendManager::start_with_binary_and_timeout(
            binary,
            data.clone(),
            Duration::from_secs(5),
        )
        .expect("fixture should start with existing config");
        manager.shutdown();
        assert_eq!(fs::read(&config).expect("config content"), content);
        assert_eq!(
            fs::metadata(&config)
                .expect("config metadata")
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "requires an explicit prepared Go backend artifact"]
    fn starts_real_go_backend_checks_auth_stop_restart_and_preserves_config() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let binary = std::env::var(TEST_BINARY_ENV)
            .expect("set LIVEAGENT_KBRAIN_TEST_BINARY to the built real Go binary");
        let binary = PathBuf::from(binary);
        assert!(binary.is_absolute(), "test binary path must be absolute");
        assert!(
            binary.is_file(),
            "test binary does not exist: {}",
            binary.display()
        );

        let temp = test_dir();
        let config = temp.path().join(CONFIG_FILE);
        fs::create_dir_all(config.parent().unwrap()).expect("config directory");
        fs::write(&config, b"{\"language\":\"en\"}\n").expect("config");
        let original_config = fs::read(&config).expect("read config");

        let state = Arc::new(KBrainBackendState::default());
        assert!(
            state
                .ensure_started_with_binary(
                    temp.path().join("missing-k-brain"),
                    temp.path().to_path_buf()
                )
                .is_err(),
            "initial missing binary must fail without preventing retry"
        );

        let first = state
            .ensure_started_with_binary(binary.clone(), temp.path().to_path_buf())
            .expect("real Go backend should start");
        assert_ne!(first.token, "");
        let client = Client::builder().no_proxy().build().expect("client");
        let health_url = format!("{}/v1/health", first.base_url);
        assert_eq!(
            client
                .get(&health_url)
                .header(AUTHORIZATION, "Bearer wrong-token")
                .send()
                .expect("unauthorized health response")
                .status(),
            reqwest::StatusCode::UNAUTHORIZED
        );
        assert!(client
            .get(&health_url)
            .header(AUTHORIZATION, format!("Bearer {}", first.token))
            .send()
            .expect("authorized health response")
            .status()
            .is_success());
        let first_manager = {
            let guard = state.manager.lock().expect("state lock");
            guard.as_ref().cloned().expect("manager")
        };
        let first_pid = {
            let guard = first_manager.process.lock().expect("process lock");
            guard.as_ref().expect("child process").child.id()
        };
        crate::runtime::process::signal_process_tree_by_pid(first_pid, true);
        let mut dead = false;
        for _ in 0..100 {
            if !first_manager.is_running() {
                dead = true;
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert!(dead, "real backend child did not die within the test bound");

        let (restart_tx, restart_rx) = std::sync::mpsc::sync_channel(1);
        let restart_state = Arc::clone(&state);
        let restart_binary = binary.clone();
        let restart_dir = temp.path().to_path_buf();
        std::thread::spawn(move || {
            let result = restart_state.ensure_started_with_binary(restart_binary, restart_dir);
            let _ = restart_tx.send(result);
        });
        let second = restart_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("dead backend restart timed out")
            .expect("dead backend should restart");
        assert_ne!(first.token, second.token);

        state.shutdown();
        let third = state
            .ensure_started_with_binary(binary, temp.path().to_path_buf())
            .expect("stopped backend should restart");
        assert_ne!(second.token, third.token);
        assert_eq!(
            fs::read(&config).expect("read preserved config"),
            original_config
        );
        state.shutdown();
    }
}
