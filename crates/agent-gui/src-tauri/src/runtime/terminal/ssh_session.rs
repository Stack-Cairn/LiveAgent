use russh::client;
use russh::MethodKind;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::time::timeout;

use crate::commands::settings::{
    load_runtime_ssh_host, trust_runtime_ssh_known_host, RuntimeSshHostConfig,
    RuntimeSshKnownHostStatus,
};
use crate::runtime::project_path::project_path_key as normalize_project_path_key;
use crate::runtime::shell_runner::ShellCancelToken;

use super::*;

impl TerminalSessionRegistry {
    pub async fn create_ssh(
        self: &Arc<Self>,
        cwd: String,
        project_path_key: Option<String>,
        ssh_host_id: String,
        title: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
        sftp_enabled: bool,
    ) -> Result<TerminalSshCreateResponse, String> {
        let cwd = canonicalize_workdir(&cwd)?;
        let project_key = project_path_key
            .map(|value| normalize_project_path_key(&value))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| normalize_project_path_key(&cwd.display().to_string()));
        if project_key.is_empty() {
            return Err("project_path_key is required".to_string());
        }
        let request = PendingSshConnectRequest {
            cwd: cwd.display().to_string(),
            project_path_key: project_key,
            ssh_host_id,
            title,
            cols,
            rows,
            sftp_enabled,
        };
        self.create_ssh_from_request(request).await
    }

    pub async fn answer_ssh_prompt(
        self: &Arc<Self>,
        prompt_id: String,
        answer: Option<String>,
        trust_host_key: bool,
    ) -> Result<TerminalSshCreateResponse, String> {
        let prompt_id = prompt_id.trim().to_string();
        if prompt_id.is_empty() {
            return Err("prompt_id is required".to_string());
        }
        let pending = self
            .pending_ssh_prompts
            .lock()
            .map_err(|_| "ssh prompt registry poisoned".to_string())?
            .remove(&prompt_id)
            .ok_or_else(|| format!("ssh prompt not found: {prompt_id}"))?;
        match pending {
            PendingSshPrompt::HostKey { request, host_key } => {
                if !trust_host_key {
                    return Err("SSH host key trust was cancelled".to_string());
                }
                trust_runtime_ssh_known_host(&host_key)?;
                self.create_ssh_from_request(request).await
            }
            PendingSshPrompt::KeyboardInteractive {
                request,
                host_config,
                title,
                size,
                mut handle,
                answer_mode,
            } => match answer_mode {
                SshPromptAnswerMode::KeyboardInteractive => {
                    let response = handle
                        .authenticate_keyboard_interactive_respond(vec![answer.unwrap_or_default()])
                        .await
                        .map_err(|error| {
                            format!("SSH keyboard-interactive response failed: {error}")
                        })?;
                    self.continue_ssh_keyboard_interactive(
                        request,
                        host_config,
                        title,
                        size,
                        handle,
                        response,
                        None,
                    )
                    .await
                }
                SshPromptAnswerMode::Password => {
                    self.continue_ssh_password_fallback(
                        request,
                        host_config,
                        title,
                        size,
                        handle,
                        answer.unwrap_or_default(),
                    )
                    .await
                }
            },
        }
    }

    pub fn cancel_ssh_prompt(&self, prompt_id: String) -> Result<(), String> {
        let prompt_id = prompt_id.trim().to_string();
        if prompt_id.is_empty() {
            return Err("prompt_id is required".to_string());
        }
        let pending = self
            .pending_ssh_prompts
            .lock()
            .map_err(|_| "ssh prompt registry poisoned".to_string())?
            .remove(&prompt_id);
        if let Some(PendingSshPrompt::KeyboardInteractive { handle, .. }) = pending {
            tokio::spawn(async move {
                let _ = handle
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "Authentication cancelled",
                        "en",
                    )
                    .await;
            });
        }
        Ok(())
    }

    pub(crate) async fn create_ssh_from_request(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
    ) -> Result<TerminalSshCreateResponse, String> {
        let host_config = load_runtime_ssh_host(&request.ssh_host_id)?
            .ok_or_else(|| format!("SSH host not found: {}", request.ssh_host_id.trim()))?;
        if host_config.host.trim().is_empty() {
            return Err("SSH host is required".to_string());
        }
        if host_config.username.trim().is_empty() {
            return Err("SSH username is required".to_string());
        }

        let size = TerminalSize {
            cols: request.cols.unwrap_or(DEFAULT_COLS).clamp(20, 400),
            rows: request.rows.unwrap_or(DEFAULT_ROWS).clamp(6, 200),
        };
        let title = request
            .title
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| self.next_ssh_title(&request.project_path_key, &host_config.name));

        let auth = resolve_ssh_auth_material(&host_config)?;
        let captured_host_key = Arc::new(tokio::sync::Mutex::new(None::<CapturedHostKey>));
        let mut handle =
            match connect_ssh_handle(&host_config, Arc::clone(&captured_host_key)).await {
                Ok(handle) => handle,
                Err(error) => {
                    if let Some(captured) = captured_host_key.lock().await.clone() {
                        return self.ssh_host_key_response(request, &host_config, captured);
                    }
                    return Err(error);
                }
            };

        match authenticate_ssh_handle(&mut handle, &host_config, auth).await? {
            SshAuthOutcome::Authenticated => {
                self.finish_create_ssh_session(request, host_config, title, size, handle)
                    .await
            }
            SshAuthOutcome::KeyboardInteractivePrompt(prompt_data) => self
                .ssh_keyboard_interactive_response(
                    request,
                    host_config,
                    title,
                    size,
                    handle,
                    prompt_data,
                ),
        }
    }

    pub(crate) async fn finish_create_ssh_session(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
        host_config: RuntimeSshHostConfig,
        title: String,
        size: TerminalSize,
        handle: client::Handle<LiveAgentSshClient>,
    ) -> Result<TerminalSshCreateResponse, String> {
        let channel = open_ssh_shell_channel(&handle, size).await?;

        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let ssh = TerminalSshMetadata {
            host_id: host_config.id.clone(),
            host_name: host_config.name.clone(),
            username: host_config.username.clone(),
            host: host_config.host.clone(),
            port: host_config.port,
            auth_type: host_config.auth_type.clone(),
            status: SSH_STATUS_CONNECTED.to_string(),
            reconnect_attempt: 0,
            reconnect_max_attempts: SSH_RECONNECT_MAX_ATTEMPTS,
            sftp_enabled: request.sftp_enabled,
        };
        let record = TerminalSessionRecord {
            id: id.clone(),
            project_path_key: request.project_path_key.clone(),
            cwd: request.cwd.clone(),
            shell: "ssh".to_string(),
            title,
            kind: "ssh".to_string(),
            ssh: Some(ssh),
            pid: None,
            cols: size.cols,
            rows: size.rows,
            created_at: now,
            updated_at: now,
            finished_at: None,
            exit_code: None,
            running: true,
        };

        let runtime = Arc::new(SshSessionRuntime::new());
        let (input_tx, input_rx) = tokio::sync::mpsc::channel::<SshSessionInput>(256);
        let (shutdown_tx, shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
        let connection_id = runtime
            .install_connection(handle, input_tx, shutdown_tx)
            .await;
        let entry = Arc::new(TerminalSessionEntry {
            backend: TerminalSessionBackend::Ssh {
                runtime: Arc::clone(&runtime),
            },
            record: Mutex::new(record),
            output: Mutex::new(TerminalOutputBuffer::default()),
        });
        self.sessions
            .lock()
            .expect("terminal session registry poisoned")
            .insert(id.clone(), Arc::clone(&entry));
        self.broadcast("created", &entry, None, None, None);

        let registry = Arc::clone(self);
        tokio::spawn(run_ssh_session_io(
            registry,
            id.clone(),
            Arc::clone(&runtime),
            connection_id,
            channel,
            input_rx,
            shutdown_rx,
        ));

        self.snapshot(id, Some(MAX_TAIL_BYTES))
            .map(terminal_ssh_create_response_from_snapshot)
    }

    pub(crate) async fn reconnect_ssh_session(
        self: &Arc<Self>,
        entry: Arc<TerminalSessionEntry>,
        attempt: u8,
    ) -> Result<(), String> {
        let record = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        let ssh = record
            .ssh
            .clone()
            .ok_or_else(|| "SSH session metadata is missing".to_string())?;
        let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
            return Err("terminal session is not an SSH connection".to_string());
        };
        if runtime.is_closing() {
            return Err("SSH session is closing".to_string());
        }
        let host_config = load_runtime_ssh_host(&ssh.host_id)?
            .ok_or_else(|| format!("SSH host not found: {}", ssh.host_id.trim()))?;

        let auth = resolve_ssh_auth_material(&host_config)?;
        let captured_host_key = Arc::new(tokio::sync::Mutex::new(None::<CapturedHostKey>));
        let mut handle =
            match connect_ssh_handle(&host_config, Arc::clone(&captured_host_key)).await {
                Ok(handle) => handle,
                Err(error) => {
                    if captured_host_key.lock().await.is_some() {
                        return Err(
                            "SSH host key requires confirmation before reconnecting".to_string()
                        );
                    }
                    return Err(error);
                }
            };

        match authenticate_ssh_handle(&mut handle, &host_config, auth).await? {
            SshAuthOutcome::Authenticated => {}
            SshAuthOutcome::KeyboardInteractivePrompt(_) => {
                let _ = handle
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "Keyboard-interactive reconnect requires user input",
                        "en",
                    )
                    .await;
                return Err(
                    "SSH reconnect requires keyboard-interactive input from the user".to_string(),
                );
            }
        }

        let size = TerminalSize {
            cols: record.cols,
            rows: record.rows,
        };
        let channel = open_ssh_shell_channel(&handle, size).await?;
        let (input_tx, input_rx) = tokio::sync::mpsc::channel::<SshSessionInput>(256);
        let (shutdown_tx, shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
        let connection_id = runtime
            .install_connection(handle, input_tx, shutdown_tx)
            .await;
        // A close() that ran while this attempt was connecting may have missed
        // the new handle (the shutdown sender slot was empty at that point), so
        // re-check and tear the fresh connection down instead of resurrecting a
        // session that is already gone.
        if runtime.is_closing() {
            if let Some(handle) = runtime.handle.lock().await.as_ref() {
                let _ = handle
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "Session closed during reconnect",
                        "en",
                    )
                    .await;
            }
            runtime.clear_connection_if_current(connection_id).await;
            return Err("SSH session is closing".to_string());
        }
        {
            let mut record = entry
                .record
                .lock()
                .map_err(|_| "terminal session lock poisoned".to_string())?;
            record.running = true;
            record.finished_at = None;
            record.exit_code = None;
            record.updated_at = now_ms();
            if let Some(ssh) = record.ssh.as_mut() {
                ssh.status = SSH_STATUS_CONNECTED.to_string();
                ssh.reconnect_attempt = 0;
                ssh.reconnect_max_attempts = SSH_RECONNECT_MAX_ATTEMPTS;
            }
        }
        self.append_output(
            &record.id,
            format!("\r\n[SSH] Reconnected after attempt {attempt}.\r\n"),
        );
        self.broadcast("reconnected", &entry, None, None, None);

        let registry = Arc::clone(self);
        tokio::spawn(run_ssh_session_io(
            registry,
            record.id,
            Arc::clone(runtime),
            connection_id,
            channel,
            input_rx,
            shutdown_rx,
        ));
        Ok(())
    }

    pub(crate) async fn handle_ssh_unexpected_disconnect(
        self: Arc<Self>,
        session_id: String,
        runtime: Arc<SshSessionRuntime>,
        connection_id: usize,
    ) {
        if !runtime.begin_reconnect_runner() {
            return;
        }
        if runtime.current_connection_id() != connection_id {
            runtime.finish_reconnect_runner();
            return;
        }
        runtime.clear_connection_if_current(connection_id).await;
        if runtime.is_closing() {
            runtime.finish_reconnect_runner();
            return;
        }
        let Ok(entry) = self.entry(&session_id) else {
            runtime.finish_reconnect_runner();
            return;
        };
        for attempt in 1..=SSH_RECONNECT_MAX_ATTEMPTS {
            if runtime.is_closing() {
                runtime.finish_reconnect_runner();
                return;
            }
            self.mark_ssh_reconnecting(&entry, attempt);
            self.append_output(
                &session_id,
                format!(
                    "\r\n[SSH] Connection lost. Reconnecting ({attempt}/{SSH_RECONNECT_MAX_ATTEMPTS})...\r\n"
                ),
            );
            let delay = SSH_RECONNECT_DELAYS
                .get(usize::from(attempt.saturating_sub(1)))
                .copied()
                .unwrap_or_else(|| Duration::from_secs(10));
            tokio::time::sleep(delay).await;
            if runtime.is_closing() {
                runtime.finish_reconnect_runner();
                return;
            }
            let reconnect_result = match timeout(
                SSH_RECONNECT_ATTEMPT_TIMEOUT,
                self.reconnect_ssh_session(Arc::clone(&entry), attempt),
            )
            .await
            {
                Ok(result) => result,
                Err(_) => Err(format!(
                    "SSH reconnect timed out after {} seconds",
                    SSH_RECONNECT_ATTEMPT_TIMEOUT.as_secs()
                )),
            };
            match reconnect_result {
                Ok(()) => {
                    runtime.finish_reconnect_runner();
                    return;
                }
                Err(error) => {
                    self.append_output(
                        &session_id,
                        format!(
                            "[SSH] Reconnect attempt {attempt}/{SSH_RECONNECT_MAX_ATTEMPTS} failed: {error}\r\n"
                        ),
                    );
                }
            }
        }
        self.mark_ssh_disconnected(&entry);
        self.append_output(
            &session_id,
            format!("[SSH] Reconnect failed after {SSH_RECONNECT_MAX_ATTEMPTS} attempts.\r\n"),
        );
        runtime.finish_reconnect_runner();
    }

    /// User-initiated reconnect: tears down the current connection (if any)
    /// and immediately re-establishes it with the latest host configuration
    /// from the settings store. Also revives sessions whose automatic
    /// reconnect attempts were exhausted.
    pub async fn ssh_reconnect(
        self: &Arc<Self>,
        session_id: String,
    ) -> Result<TerminalSessionRecord, String> {
        let entry = self.entry(&session_id)?;
        let record = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        if record.kind.trim() != "ssh" {
            return Err("terminal session is not an SSH connection".to_string());
        }
        let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
            return Err("terminal session is not an SSH connection".to_string());
        };
        if runtime.is_closing() {
            return Err("SSH session is closing".to_string());
        }
        if !runtime.begin_reconnect_runner() {
            return Err("SSH reconnect already in progress".to_string());
        }

        // Tear the old connection down directly rather than via the shutdown
        // channel: the writer task disconnects whatever handle occupies the
        // shared slot at that moment, which would kill the replacement once
        // installed. The orphaned IO pump observes ConnectionLost and its
        // reconnect runner exits immediately because we hold the runner flag
        // (or, later, because the connection generation no longer matches).
        let old_connection_id = runtime.current_connection_id();
        {
            let handle = runtime.handle.lock().await;
            if let Some(handle) = handle.as_ref() {
                let _ = handle
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "Reconnecting with updated settings",
                        "en",
                    )
                    .await;
            }
        }
        runtime.clear_connection_if_current(old_connection_id).await;

        self.mark_ssh_reconnecting(&entry, 1);
        let result = match timeout(
            SSH_RECONNECT_ATTEMPT_TIMEOUT,
            self.reconnect_ssh_session(Arc::clone(&entry), 1),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(format!(
                "SSH reconnect timed out after {} seconds",
                SSH_RECONNECT_ATTEMPT_TIMEOUT.as_secs()
            )),
        };
        match result {
            Ok(()) => {
                runtime.finish_reconnect_runner();
                self.record(session_id)
            }
            Err(error) => {
                self.append_output(
                    &session_id,
                    format!("\r\n[SSH] Manual reconnect failed: {error}\r\n"),
                );
                self.mark_ssh_disconnected(&entry);
                runtime.finish_reconnect_runner();
                Err(error)
            }
        }
    }

    pub(crate) async fn continue_ssh_keyboard_interactive(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
        host_config: RuntimeSshHostConfig,
        title: String,
        size: TerminalSize,
        mut handle: client::Handle<LiveAgentSshClient>,
        response: client::KeyboardInteractiveAuthResponse,
        auto_password: Option<String>,
    ) -> Result<TerminalSshCreateResponse, String> {
        match continue_keyboard_interactive_auth(&mut handle, response, auto_password).await? {
            SshAuthOutcome::Authenticated => {
                self.finish_create_ssh_session(request, host_config, title, size, handle)
                    .await
            }
            SshAuthOutcome::KeyboardInteractivePrompt(prompt_data) => self
                .ssh_keyboard_interactive_response(
                    request,
                    host_config,
                    title,
                    size,
                    handle,
                    prompt_data,
                ),
        }
    }

    /// Interactive password fallback: the server rejected the
    /// keyboard-interactive method itself, so the prompt answer is submitted
    /// as a regular password auth request instead of an INFO_RESPONSE.
    pub(crate) async fn continue_ssh_password_fallback(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
        host_config: RuntimeSshHostConfig,
        title: String,
        size: TerminalSize,
        mut handle: client::Handle<LiveAgentSshClient>,
        password: String,
    ) -> Result<TerminalSshCreateResponse, String> {
        let result = handle
            .authenticate_password(host_config.username.as_str(), password)
            .await
            .map_err(|error| format!("SSH password authentication failed: {error}"))?;
        if result.success() {
            return self
                .finish_create_ssh_session(request, host_config, title, size, handle)
                .await;
        }
        // A second factor may still be requested via keyboard-interactive
        // (partial success), otherwise re-prompt while the server keeps
        // password auth open; the server enforces its own attempt limit.
        if auth_result_can_continue_with_kbi(&result) {
            let response = handle
                .authenticate_keyboard_interactive_start(
                    host_config.username.as_str(),
                    None::<String>,
                )
                .await
                .map_err(|error| {
                    format!("SSH keyboard-interactive authentication failed: {error}")
                })?;
            return self
                .continue_ssh_keyboard_interactive(
                    request,
                    host_config,
                    title,
                    size,
                    handle,
                    response,
                    None,
                )
                .await;
        }
        if let client::AuthResult::Failure {
            remaining_methods, ..
        } = &result
        {
            if remaining_methods.contains(&MethodKind::Password) {
                let prompt_data = password_fallback_prompt_data(&host_config, true);
                return self.ssh_keyboard_interactive_response(
                    request,
                    host_config,
                    title,
                    size,
                    handle,
                    prompt_data,
                );
            }
        }
        Err("SSH password authentication failed".to_string())
    }

    pub(crate) fn ssh_keyboard_interactive_response(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
        host_config: RuntimeSshHostConfig,
        title: String,
        size: TerminalSize,
        handle: client::Handle<LiveAgentSshClient>,
        prompt_data: KeyboardInteractivePromptData,
    ) -> Result<TerminalSshCreateResponse, String> {
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let message = ssh_keyboard_interactive_message(&prompt_data);
        let prompt = TerminalSshPrompt {
            id: prompt_id.clone(),
            kind: "keyboardInteractive".to_string(),
            host_id: host_config.id.clone(),
            host_name: host_config.name.clone(),
            host: host_config.host.clone(),
            port: host_config.port,
            message,
            fingerprint_sha256: String::new(),
            key_type: String::new(),
            answer_echo: prompt_data.echo,
        };
        self.pending_ssh_prompts
            .lock()
            .map_err(|_| "ssh prompt registry poisoned".to_string())?
            .insert(
                prompt_id.clone(),
                PendingSshPrompt::KeyboardInteractive {
                    request,
                    host_config,
                    title,
                    size,
                    handle,
                    answer_mode: prompt_data.answer_mode,
                },
            );
        self.schedule_ssh_prompt_timeout(prompt_id);
        Ok(TerminalSshCreateResponse {
            session: None,
            output: String::new(),
            output_bytes: Vec::new(),
            truncated: false,
            output_start_offset: 0,
            output_end_offset: 0,
            ssh_prompt: Some(prompt),
        })
    }

    pub(crate) fn ssh_host_key_response(
        self: &Arc<Self>,
        request: PendingSshConnectRequest,
        host_config: &RuntimeSshHostConfig,
        captured: CapturedHostKey,
    ) -> Result<TerminalSshCreateResponse, String> {
        match captured.status {
            RuntimeSshKnownHostStatus::Known => {
                Err("SSH host key check failed unexpectedly".to_string())
            }
            RuntimeSshKnownHostStatus::Changed { stored_fingerprint } => Err(format!(
                "SSH host key changed for {}:{}. Stored fingerprint: {}. Received fingerprint: {}.",
                host_config.host,
                host_config.port,
                stored_fingerprint,
                captured.key.fingerprint_sha256
            )),
            RuntimeSshKnownHostStatus::Unknown => {
                let prompt_id = uuid::Uuid::new_v4().to_string();
                let prompt = TerminalSshPrompt {
                    id: prompt_id.clone(),
                    kind: "hostKey".to_string(),
                    host_id: host_config.id.clone(),
                    host_name: host_config.name.clone(),
                    host: host_config.host.clone(),
                    port: host_config.port,
                    message: format!(
                        "Trust SSH host key for {}:{}?",
                        host_config.host, host_config.port
                    ),
                    fingerprint_sha256: captured.key.fingerprint_sha256.clone(),
                    key_type: captured.key.key_type.clone(),
                    answer_echo: false,
                };
                self.pending_ssh_prompts
                    .lock()
                    .map_err(|_| "ssh prompt registry poisoned".to_string())?
                    .insert(
                        prompt_id.clone(),
                        PendingSshPrompt::HostKey {
                            request,
                            host_key: captured.key,
                        },
                    );
                self.schedule_ssh_prompt_timeout(prompt_id);
                Ok(TerminalSshCreateResponse {
                    session: None,
                    output: String::new(),
                    output_bytes: Vec::new(),
                    truncated: false,
                    output_start_offset: 0,
                    output_end_offset: 0,
                    ssh_prompt: Some(prompt),
                })
            }
        }
    }

    pub(crate) fn schedule_ssh_prompt_timeout(self: &Arc<Self>, prompt_id: String) {
        let registry = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(SSH_PROMPT_TIMEOUT).await;
            let pending = registry
                .pending_ssh_prompts
                .lock()
                .ok()
                .and_then(|mut prompts| prompts.remove(&prompt_id));
            if let Some(PendingSshPrompt::KeyboardInteractive { handle, .. }) = pending {
                let _ = handle
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "Authentication prompt timed out",
                        "en",
                    )
                    .await;
            }
        });
    }

    pub fn ssh_session_info(&self, session_id: &str) -> Result<TerminalSshSessionInfo, String> {
        let record = self.record(session_id.to_string())?;
        if record.kind.trim() != "ssh" {
            return Err("terminal session is not an SSH connection".to_string());
        }
        let ssh = record
            .ssh
            .ok_or_else(|| "SSH session metadata is missing".to_string())?;
        Ok(TerminalSshSessionInfo {
            project_path_key: record.project_path_key,
            cwd: record.cwd,
            running: record.running,
            sftp_enabled: ssh.sftp_enabled,
        })
    }

    pub async fn ssh_latency(
        self: &Arc<Self>,
        session_id: String,
    ) -> Result<TerminalSshLatencyResponse, String> {
        let entry = self.entry(&session_id)?;
        let record = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        if record.kind.trim() != "ssh" {
            return Err("terminal session is not an SSH connection".to_string());
        }
        if !record.running {
            return Err("SSH connection is not running".to_string());
        }
        let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
            return Err("terminal session is not an SSH connection".to_string());
        };
        let start = Instant::now();
        let ping = timeout(Duration::from_secs(3), async {
            let handle = runtime.handle.lock().await;
            let Some(handle) = handle.as_ref() else {
                return Err(russh::Error::Disconnect);
            };
            handle.send_ping().await
        })
        .await;
        match ping {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(format!("SSH latency check failed: {error}")),
            Err(_) => return Err("SSH latency check timed out".to_string()),
        }
        let elapsed = start.elapsed().as_millis().clamp(1, u128::from(u32::MAX)) as u32;
        Ok(TerminalSshLatencyResponse {
            session_id: record.id,
            latency_ms: elapsed,
        })
    }

    pub async fn ssh_exec(
        self: &Arc<Self>,
        session_id: String,
        command: String,
        cwd: Option<String>,
        timeout_ms: Option<u64>,
        max_bytes: Option<usize>,
        cancel_token: Option<ShellCancelToken>,
    ) -> Result<TerminalSshExecResponse, String> {
        let command = command.trim().to_string();
        if command.is_empty() {
            return Err("command is required".to_string());
        }
        let entry = self.entry(&session_id)?;
        let record = entry
            .record
            .lock()
            .map_err(|_| "terminal session lock poisoned".to_string())?
            .clone();
        if record.kind.trim() != "ssh" {
            return Err("terminal session is not an SSH connection".to_string());
        }
        if !record.running {
            return Err("SSH connection is not running".to_string());
        }
        let TerminalSessionBackend::Ssh { runtime } = &entry.backend else {
            return Err("terminal session is not an SSH connection".to_string());
        };

        let cwd = cwd
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let wrapped_command = wrap_ssh_exec_command(&command, cwd.as_deref());
        let timeout_duration = normalize_ssh_exec_timeout(timeout_ms);
        let capture_limit = normalize_ssh_exec_max_bytes(max_bytes);
        let start = Instant::now();
        let execution = timeout(
            timeout_duration,
            run_ssh_exec_channel(runtime, wrapped_command, capture_limit),
        );
        tokio::pin!(execution);
        let result = if let Some(cancel_token) = cancel_token {
            tokio::select! {
                result = &mut execution => result,
                _ = cancel_token.cancelled() => {
                    return Err("Cancelled".to_string());
                }
            }
        } else {
            execution.await
        };
        let duration_ms = start.elapsed().as_millis();

        match result {
            Ok(Ok(mut response)) => {
                response.session_id = record.id;
                response.command = command;
                response.cwd = cwd;
                response.duration_ms = duration_ms;
                Ok(response)
            }
            Ok(Err(error)) => {
                spawn_ssh_reconnect_runner(
                    Arc::clone(self),
                    record.id,
                    Arc::clone(runtime),
                    runtime.current_connection_id(),
                );
                Err(format!("SSH exec failed: {error}"))
            }
            Err(_) => Ok(TerminalSshExecResponse {
                session_id: record.id,
                command,
                cwd,
                exit_code: None,
                exit_signal: None,
                stdout: String::new(),
                stderr: String::new(),
                stdout_truncated: false,
                stderr_truncated: false,
                timed_out: true,
                duration_ms,
            }),
        }
    }

    pub(crate) fn mark_ssh_reconnecting(&self, entry: &Arc<TerminalSessionEntry>, attempt: u8) {
        {
            let mut record = match entry.record.lock() {
                Ok(record) => record,
                Err(_) => return,
            };
            record.running = false;
            record.finished_at = None;
            record.exit_code = None;
            record.updated_at = now_ms();
            if let Some(ssh) = record.ssh.as_mut() {
                ssh.status = SSH_STATUS_RECONNECTING.to_string();
                ssh.reconnect_attempt = attempt;
                ssh.reconnect_max_attempts = SSH_RECONNECT_MAX_ATTEMPTS;
            }
        }
        self.broadcast("reconnecting", entry, None, None, None);
    }

    pub(crate) fn mark_ssh_disconnected(&self, entry: &Arc<TerminalSessionEntry>) {
        let tab_snapshots = {
            let Ok(_tabs_tx) = self.lock_ssh_terminal_tabs_tx() else {
                return;
            };
            let session_id = {
                let mut record = match entry.record.lock() {
                    Ok(record) => record,
                    Err(_) => return,
                };
                let session_id = record.id.clone();
                record.running = false;
                record.finished_at = Some(now_ms());
                record.exit_code = None;
                record.updated_at = now_ms();
                if let Some(ssh) = record.ssh.as_mut() {
                    ssh.status = SSH_STATUS_DISCONNECTED.to_string();
                    ssh.reconnect_attempt = SSH_RECONNECT_MAX_ATTEMPTS;
                    ssh.reconnect_max_attempts = SSH_RECONNECT_MAX_ATTEMPTS;
                }
                session_id
            };
            self.prune_ssh_terminal_tabs_for_session_locked(&session_id)
        };
        self.broadcast("exit", entry, None, None, None);
        for snapshot in tab_snapshots {
            self.broadcast_ssh_tabs_snapshot(snapshot);
        }
    }

    pub(crate) async fn mark_ssh_shell_ended(
        self: Arc<Self>,
        session_id: String,
        runtime: Arc<SshSessionRuntime>,
        connection_id: usize,
        message: String,
    ) {
        if runtime.current_connection_id() != connection_id || runtime.is_closing() {
            return;
        }
        runtime.clear_connection_if_current(connection_id).await;
        if message.trim().len() > 0 {
            self.append_output(&session_id, message);
        }
        if let Ok(entry) = self.entry(&session_id) {
            self.mark_ssh_disconnected(&entry);
        }
    }
}
