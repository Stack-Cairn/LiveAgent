use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{self, Read};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex, Weak,
};
use std::time::{Duration, Instant};

use crate::runtime::platform::shell_basename;
use crate::runtime::process::{terminate_child_process_tree, terminate_process_tree_by_pid};
use crate::runtime::sandbox::{SandboxOptions, SandboxSpec};
use crate::runtime::shell_runner::{
    canonical_workdir, resolve_shell_cwd, spawn_platform_shell_command, ShellExecutionProfile,
    MAX_SHELL_TIMEOUT_MS, MIN_SHELL_TIMEOUT_MS,
};

const DEFAULT_START_YIELD_MS: u64 = 10_000;
const MIN_START_YIELD_MS: u64 = 250;
const MAX_START_YIELD_MS: u64 = 30_000;
const DEFAULT_WAIT_YIELD_MS: u64 = 30_000;
const MIN_WAIT_YIELD_MS: u64 = 5_000;
const MAX_WAIT_YIELD_MS: u64 = 300_000;
const OUTPUT_CAPACITY_BYTES: usize = 1024 * 1024;
const RESPONSE_CAPACITY_BYTES: usize = 64 * 1024;
const MAX_SESSIONS: usize = 64;
const TERMINAL_RETENTION: Duration = Duration::from_secs(10 * 60);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);
const TERMINATION_GRACE: Duration = Duration::from_millis(300);
const STREAM_EOF_GRACE: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellSessionStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
}

impl ShellSessionStatus {
    fn is_terminal(self) -> bool {
        self != Self::Running
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellOutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShellSessionOutput {
    pub stream: ShellOutputStream,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShellSessionResponse {
    pub status: ShellSessionStatus,
    pub session_id: String,
    pub cursor: u64,
    pub output: Vec<ShellSessionOutput>,
    pub output_truncated: bool,
    pub has_more: bool,
    pub exit_code: Option<i32>,
    pub duration_ms: u128,
    pub shell: String,
    pub platform: String,
    pub profile: String,
    pub shell_family: String,
    /// 生效的沙箱机制;None 表示未启用沙箱。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone)]
struct ShellSessionConfig {
    output_capacity_bytes: usize,
    response_capacity_bytes: usize,
    max_sessions: usize,
    terminal_retention: Duration,
    process_poll_interval: Duration,
    termination_grace: Duration,
    stream_eof_grace: Duration,
}

impl Default for ShellSessionConfig {
    fn default() -> Self {
        Self {
            output_capacity_bytes: OUTPUT_CAPACITY_BYTES,
            response_capacity_bytes: RESPONSE_CAPACITY_BYTES,
            max_sessions: MAX_SESSIONS,
            terminal_retention: TERMINAL_RETENTION,
            process_poll_interval: PROCESS_POLL_INTERVAL,
            termination_grace: TERMINATION_GRACE,
            stream_eof_grace: STREAM_EOF_GRACE,
        }
    }
}

#[derive(Debug, Clone)]
struct BufferedOutput {
    start: u64,
    end: u64,
    stream: ShellOutputStream,
    text: String,
}

struct ShellSessionState {
    status: ShellSessionStatus,
    exit_code: Option<i32>,
    output: VecDeque<BufferedOutput>,
    output_bytes: usize,
    next_cursor: u64,
    readers_done: usize,
    accepting_output: bool,
    terminal_at: Option<Instant>,
}

impl Default for ShellSessionState {
    fn default() -> Self {
        Self {
            status: ShellSessionStatus::Running,
            exit_code: None,
            output: VecDeque::new(),
            output_bytes: 0,
            next_cursor: 0,
            readers_done: 0,
            accepting_output: true,
            terminal_at: None,
        }
    }
}

struct ShellSession {
    id: String,
    pid: u32,
    started_at: Instant,
    profile: ShellExecutionProfile,
    sandbox: Option<String>,
    timeout_ms: Option<u64>,
    output_capacity_bytes: usize,
    response_capacity_bytes: usize,
    stop_requested: AtomicBool,
    state: Mutex<ShellSessionState>,
    changed: Condvar,
}

impl ShellSession {
    fn new(
        id: String,
        pid: u32,
        profile: ShellExecutionProfile,
        sandbox: Option<String>,
        timeout_ms: Option<u64>,
        config: &ShellSessionConfig,
    ) -> Self {
        Self {
            id,
            pid,
            started_at: Instant::now(),
            profile,
            sandbox,
            timeout_ms,
            output_capacity_bytes: config.output_capacity_bytes.max(1),
            response_capacity_bytes: config.response_capacity_bytes.max(4),
            stop_requested: AtomicBool::new(false),
            state: Mutex::new(ShellSessionState::default()),
            changed: Condvar::new(),
        }
    }

    fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
        self.changed.notify_all();
    }

    fn append_output(&self, stream: ShellOutputStream, mut text: String) {
        if text.is_empty() {
            return;
        }
        let mut state = self.state.lock().expect("shell session state poisoned");
        if !state.accepting_output {
            return;
        }

        let original_len = text.len();
        let start = state.next_cursor;
        state.next_cursor = state.next_cursor.saturating_add(original_len as u64);

        let mut omitted = 0usize;
        if text.len() > self.output_capacity_bytes {
            omitted = text.len() - self.output_capacity_bytes;
            while omitted < text.len() && !text.is_char_boundary(omitted) {
                omitted += 1;
            }
            text = text[omitted..].to_string();
        }

        while state.output_bytes.saturating_add(text.len()) > self.output_capacity_bytes {
            let Some(removed) = state.output.pop_front() else {
                break;
            };
            state.output_bytes = state.output_bytes.saturating_sub(removed.text.len());
        }

        if !text.is_empty() {
            state.output_bytes += text.len();
            state.output.push_back(BufferedOutput {
                start: start.saturating_add(omitted as u64),
                end: start.saturating_add(original_len as u64),
                stream,
                text,
            });
        }
        self.changed.notify_all();
    }

    fn mark_reader_done(&self) {
        let mut state = self.state.lock().expect("shell session state poisoned");
        state.readers_done += 1;
        self.changed.notify_all();
    }

    fn finish(&self, status: ShellSessionStatus, exit_code: Option<i32>) {
        let mut state = self.state.lock().expect("shell session state poisoned");
        state.accepting_output = false;
        state.status = status;
        state.exit_code = exit_code;
        state.terminal_at = Some(Instant::now());
        self.changed.notify_all();
    }

    fn wait_for_readers(&self, grace: Duration) {
        let deadline = Instant::now() + grace;
        let mut state = self.state.lock().expect("shell session state poisoned");
        while state.readers_done < 2 {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let remaining = deadline.saturating_duration_since(now);
            let (next_state, timeout) = self
                .changed
                .wait_timeout(state, remaining)
                .expect("shell session state poisoned while waiting for readers");
            state = next_state;
            if timeout.timed_out() {
                break;
            }
        }
    }

    fn wait(&self, cursor: Option<u64>, duration: Duration) -> ShellSessionResponse {
        let deadline = Instant::now() + duration;
        let mut state = self.state.lock().expect("shell session state poisoned");
        loop {
            let base_cursor = state
                .output
                .front()
                .map(|chunk| chunk.start)
                .unwrap_or(state.next_cursor);
            let requested = cursor.unwrap_or(base_cursor).min(state.next_cursor);
            let unread = state.next_cursor.saturating_sub(requested.max(base_cursor)) as usize;
            if state.status.is_terminal() || unread >= self.response_capacity_bytes {
                break;
            }

            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let remaining = deadline.saturating_duration_since(now);
            let (next_state, timeout) = self
                .changed
                .wait_timeout(state, remaining)
                .expect("shell session state poisoned while waiting");
            state = next_state;
            if timeout.timed_out() {
                break;
            }
        }
        self.response_from_state(&state, cursor)
    }

    fn wait_until_terminal(&self, cursor: Option<u64>, duration: Duration) -> ShellSessionResponse {
        let deadline = Instant::now() + duration;
        let mut state = self.state.lock().expect("shell session state poisoned");
        while !state.status.is_terminal() {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let remaining = deadline.saturating_duration_since(now);
            let (next_state, timeout) = self
                .changed
                .wait_timeout(state, remaining)
                .expect("shell session state poisoned while stopping");
            state = next_state;
            if timeout.timed_out() {
                break;
            }
        }
        self.response_from_state(&state, cursor)
    }

    fn response_from_state(
        &self,
        state: &ShellSessionState,
        cursor: Option<u64>,
    ) -> ShellSessionResponse {
        let base_cursor = state
            .output
            .front()
            .map(|chunk| chunk.start)
            .unwrap_or(state.next_cursor);
        let requested = cursor.unwrap_or(base_cursor).min(state.next_cursor);
        let output_truncated = requested < base_cursor;
        let mut response_cursor = requested.max(base_cursor);
        let mut remaining = self.response_capacity_bytes;
        let mut output: Vec<ShellSessionOutput> = Vec::new();

        for chunk in &state.output {
            if remaining == 0 {
                break;
            }
            if chunk.end <= response_cursor {
                continue;
            }
            let absolute_start = response_cursor.max(chunk.start);
            let mut relative_start = absolute_start.saturating_sub(chunk.start) as usize;
            while relative_start < chunk.text.len() && !chunk.text.is_char_boundary(relative_start)
            {
                relative_start += 1;
            }
            if relative_start >= chunk.text.len() {
                response_cursor = chunk.end;
                continue;
            }

            let available = chunk.text.len() - relative_start;
            let mut take = available.min(remaining);
            while take > 0 && !chunk.text.is_char_boundary(relative_start + take) {
                take -= 1;
            }
            if take == 0 {
                // 剩余配额容不下下一个完整字符：必须就地停止分页。继续扫描
                // 后续 chunk 会把 cursor 推过本 chunk 未读的尾部，造成乱序输
                // 出且这些字节永远无法被再次读取。
                break;
            }
            let fragment = &chunk.text[relative_start..relative_start + take];
            if let Some(previous) = output.last_mut().filter(|item| item.stream == chunk.stream) {
                previous.text.push_str(fragment);
            } else {
                output.push(ShellSessionOutput {
                    stream: chunk.stream,
                    text: fragment.to_string(),
                });
            }
            remaining -= take;
            response_cursor = chunk.start + (relative_start + take) as u64;
        }

        ShellSessionResponse {
            status: state.status,
            session_id: self.id.clone(),
            cursor: response_cursor,
            output,
            output_truncated,
            has_more: response_cursor < state.next_cursor,
            exit_code: state.exit_code,
            duration_ms: state
                .terminal_at
                .unwrap_or_else(Instant::now)
                .saturating_duration_since(self.started_at)
                .as_millis(),
            shell: shell_basename(self.profile.display_shell),
            platform: self.profile.platform.to_string(),
            profile: self.profile.profile.to_string(),
            shell_family: self.profile.shell_family.to_string(),
            sandbox: self.sandbox.clone(),
            timeout_ms: self.timeout_ms,
        }
    }

    fn terminal_at(&self) -> Option<Instant> {
        self.state
            .lock()
            .expect("shell session state poisoned")
            .terminal_at
    }

    fn is_running(&self) -> bool {
        !self
            .state
            .lock()
            .expect("shell session state poisoned")
            .status
            .is_terminal()
    }
}

#[derive(Default)]
pub struct ShellSessionManager {
    sessions: Mutex<HashMap<String, Arc<ShellSession>>>,
    config: ShellSessionConfig,
}

impl ShellSessionManager {
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        session_id: String,
        workdir: String,
        command: String,
        cwd: Option<String>,
        yield_time_ms: Option<u64>,
        timeout_ms: Option<u64>,
        max_timeout_ms: Option<u64>,
        sandbox_options: Option<SandboxOptions>,
    ) -> Result<ShellSessionResponse, String> {
        let session_id = normalize_session_id(&session_id)?;
        let command = command.trim();
        if command.is_empty() {
            return Err("command cannot be empty".to_string());
        }
        let actual_cwd = resolve_shell_cwd(&workdir, cwd.as_deref())?;
        let effective_timeout_ms = normalize_explicit_timeout(timeout_ms, max_timeout_ms);
        // 沙箱写围栏始终锚定 workdir(工作区根),即使 cwd 指向工作区子目录。
        // 与一次性 shell_run 使用同一 canonicalize/构造逻辑,避免两个执行入口
        // 的围栏语义漂移。
        let sandbox_spec = match sandbox_options {
            Some(options) => Some(SandboxSpec::from_options(
                canonical_workdir(&workdir)?,
                options,
            )),
            None => None,
        };

        let session = {
            let mut sessions = self
                .sessions
                .lock()
                .expect("shell session manager poisoned");
            self.cleanup_locked(&mut sessions, Instant::now());
            if sessions.contains_key(&session_id) {
                return Err(format!("shell session already exists: {session_id}"));
            }
            self.make_room_locked(&mut sessions)?;

            let spawned = spawn_platform_shell_command(
                command,
                &actual_cwd,
                &[],
                sandbox_spec.as_ref(),
                || Ok((Stdio::piped(), Stdio::piped())),
            )?;
            let mut child = spawned.child;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| "Failed to capture stdout".to_string())?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| "Failed to capture stderr".to_string())?;
            let session = Arc::new(ShellSession::new(
                session_id.clone(),
                child.id(),
                spawned.profile,
                spawned.sandbox.map(str::to_string),
                effective_timeout_ms,
                &self.config,
            ));
            sessions.insert(session_id, Arc::clone(&session));

            spawn_stream_reader(stdout, ShellOutputStream::Stdout, Arc::downgrade(&session));
            spawn_stream_reader(stderr, ShellOutputStream::Stderr, Arc::downgrade(&session));
            spawn_process_monitor(child, Arc::clone(&session), self.config.clone());
            session
        };

        let yield_time = Duration::from_millis(
            yield_time_ms
                .unwrap_or(DEFAULT_START_YIELD_MS)
                .clamp(MIN_START_YIELD_MS, MAX_START_YIELD_MS),
        );
        // 初始读取显式从 0 开始：初始等待窗口内若环形缓冲已淘汰头部输出，
        // 响应必须置 output_truncated（cursor=None 只会“从现存缓冲起点读”，
        // 掩盖丢失）。
        Ok(session.wait(Some(0), yield_time))
    }

    pub fn wait(
        &self,
        session_id: &str,
        cursor: Option<u64>,
        yield_time_ms: Option<u64>,
    ) -> Result<ShellSessionResponse, String> {
        let session = self.get_session(session_id)?;
        let yield_time = Duration::from_millis(
            yield_time_ms
                .unwrap_or(DEFAULT_WAIT_YIELD_MS)
                .clamp(MIN_WAIT_YIELD_MS, MAX_WAIT_YIELD_MS),
        );
        Ok(session.wait(cursor, yield_time))
    }

    pub fn stop(
        &self,
        session_id: &str,
        cursor: Option<u64>,
    ) -> Result<ShellSessionResponse, String> {
        let session = self.get_session(session_id)?;
        session.request_stop();
        Ok(session.wait_until_terminal(cursor, Duration::from_secs(5)))
    }

    pub fn cleanup_expired(&self) {
        let mut sessions = self
            .sessions
            .lock()
            .expect("shell session manager poisoned");
        self.cleanup_locked(&mut sessions, Instant::now());
    }

    pub fn start_cleaner(manager: &Arc<Self>) {
        let manager = Arc::downgrade(manager);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(60));
            let Some(manager) = manager.upgrade() else {
                return;
            };
            manager.cleanup_expired();
        });
    }

    pub fn shutdown_cleanup(&self) {
        let sessions: Vec<Arc<ShellSession>> = self
            .sessions
            .lock()
            .expect("shell session manager poisoned")
            .values()
            .filter(|session| session.is_running())
            .cloned()
            .collect();
        for session in &sessions {
            session.request_stop();
            terminate_process_tree_by_pid(session.pid, self.config.termination_grace);
        }
        for session in sessions {
            let _ = session.wait_until_terminal(None, Duration::from_secs(1));
        }
    }

    fn get_session(&self, session_id: &str) -> Result<Arc<ShellSession>, String> {
        let session_id = normalize_session_id(session_id)?;
        let mut sessions = self
            .sessions
            .lock()
            .expect("shell session manager poisoned");
        self.cleanup_locked(&mut sessions, Instant::now());
        sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| format!("shell session not found or expired: {session_id}"))
    }

    fn cleanup_locked(&self, sessions: &mut HashMap<String, Arc<ShellSession>>, now: Instant) {
        sessions.retain(|_, session| {
            session
                .terminal_at()
                .map(|terminal_at| {
                    now.saturating_duration_since(terminal_at) < self.config.terminal_retention
                })
                .unwrap_or(true)
        });
    }

    fn make_room_locked(
        &self,
        sessions: &mut HashMap<String, Arc<ShellSession>>,
    ) -> Result<(), String> {
        while sessions.len() >= self.config.max_sessions {
            let oldest_terminal = sessions
                .iter()
                .filter_map(|(id, session)| session.terminal_at().map(|at| (id.clone(), at)))
                .min_by_key(|(_, at)| *at)
                .map(|(id, _)| id);
            let Some(id) = oldest_terminal else {
                return Err(format!(
                    "shell session limit reached ({}); stop or wait for a running session before starting another",
                    self.config.max_sessions
                ));
            };
            sessions.remove(&id);
        }
        Ok(())
    }

    #[cfg(test)]
    fn with_config(config: ShellSessionConfig) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            config,
        }
    }
}

fn normalize_session_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    {
        return Err("session_id must be 1-128 ASCII letters, digits, '-', '_', or ':'".to_string());
    }
    Ok(value.to_string())
}

fn normalize_explicit_timeout(timeout_ms: Option<u64>, max_timeout_ms: Option<u64>) -> Option<u64> {
    let max_timeout_ms = max_timeout_ms
        .unwrap_or(MAX_SHELL_TIMEOUT_MS)
        .clamp(MIN_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS);
    timeout_ms.map(|value| value.clamp(MIN_SHELL_TIMEOUT_MS, max_timeout_ms))
}

fn spawn_stream_reader<R: Read + Send + 'static>(
    mut reader: R,
    stream: ShellOutputStream,
    session: Weak<ShellSession>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    pending.extend_from_slice(&buffer[..read]);
                    flush_utf8(&mut pending, false, |text| {
                        if let Some(session) = session.upgrade() {
                            session.append_output(stream, text);
                        }
                    });
                    if session.strong_count() == 0 {
                        return;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    if let Some(session) = session.upgrade() {
                        session.append_output(
                            ShellOutputStream::Stderr,
                            format!("LiveAgent failed to read shell output: {error}\n"),
                        );
                    }
                    break;
                }
            }
        }
        flush_utf8(&mut pending, true, |text| {
            if let Some(session) = session.upgrade() {
                session.append_output(stream, text);
            }
        });
        if let Some(session) = session.upgrade() {
            session.mark_reader_done();
        }
    });
}

fn flush_utf8<F>(pending: &mut Vec<u8>, eof: bool, mut emit: F)
where
    F: FnMut(String),
{
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                if !text.is_empty() {
                    emit(text.to_string());
                }
                pending.clear();
                return;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    let text = String::from_utf8(pending[..valid].to_vec())
                        .expect("validated UTF-8 prefix must decode");
                    emit(text);
                    pending.drain(..valid);
                    continue;
                }
                match error.error_len() {
                    Some(invalid_len) => {
                        emit(String::from_utf8_lossy(&pending[..invalid_len]).into_owned());
                        pending.drain(..invalid_len);
                    }
                    None if eof => {
                        emit(String::from_utf8_lossy(pending).into_owned());
                        pending.clear();
                        return;
                    }
                    None => return,
                }
            }
        }
    }
}

fn spawn_process_monitor(
    mut child: std::process::Child,
    session: Arc<ShellSession>,
    config: ShellSessionConfig,
) {
    std::thread::spawn(move || {
        let (status, exit_code) = loop {
            match child.try_wait() {
                Ok(Some(exit)) => {
                    let status = if exit.success() {
                        ShellSessionStatus::Completed
                    } else {
                        ShellSessionStatus::Failed
                    };
                    break (status, exit.code().or(Some(-1)));
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = terminate_child_process_tree(&mut child, config.termination_grace);
                    session.append_output(
                        ShellOutputStream::Stderr,
                        format!("LiveAgent failed to inspect shell process: {error}\n"),
                    );
                    break (ShellSessionStatus::Failed, Some(-1));
                }
            }

            if session.stop_requested.load(Ordering::SeqCst) {
                let exit_code = terminate_child_process_tree(&mut child, config.termination_grace)
                    .ok()
                    .and_then(|exit| exit.code())
                    .or(Some(-1));
                break (ShellSessionStatus::Cancelled, exit_code);
            }

            if session.timeout_ms.is_some_and(|timeout| {
                session.started_at.elapsed() >= Duration::from_millis(timeout)
            }) {
                let exit_code = terminate_child_process_tree(&mut child, config.termination_grace)
                    .ok()
                    .and_then(|exit| exit.code())
                    .or(Some(-1));
                break (ShellSessionStatus::TimedOut, exit_code);
            }

            std::thread::sleep(config.process_poll_interval);
        };

        session.wait_for_readers(config.stream_eof_grace);
        session.finish(status, exit_code);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn workdir() -> String {
        std::env::current_dir()
            .expect("current directory")
            .to_string_lossy()
            .into_owned()
    }

    fn collect_text(response: &ShellSessionResponse) -> String {
        response
            .output
            .iter()
            .map(|chunk| chunk.text.as_str())
            .collect()
    }

    #[test]
    fn short_command_completes_during_initial_yield() {
        let manager = ShellSessionManager::default();
        let response = manager
            .start(
                "short".to_string(),
                workdir(),
                "printf ready".to_string(),
                None,
                Some(2_000),
                None,
                Some(30_000),
                None,
            )
            .expect("short command should run");
        assert_eq!(response.status, ShellSessionStatus::Completed);
        assert_eq!(response.exit_code, Some(0));
        assert_eq!(collect_text(&response), "ready");
    }

    #[test]
    fn long_command_yields_and_waits_without_restarting() {
        let manager = ShellSessionManager::default();
        let first = manager
            .start(
                "long".to_string(),
                workdir(),
                "printf begin; sleep 0.6; printf end".to_string(),
                None,
                Some(20),
                None,
                Some(30_000),
                None,
            )
            .expect("long command should start");
        assert_eq!(first.status, ShellSessionStatus::Running);

        let second = manager
            .wait("long", Some(first.cursor), Some(5_000))
            .expect("long command should remain waitable");
        assert_eq!(second.status, ShellSessionStatus::Completed);
        assert_eq!(
            format!("{}{}", collect_text(&first), collect_text(&second)),
            "beginend"
        );
    }

    #[test]
    fn omitted_timeout_does_not_kill_running_command() {
        let manager = ShellSessionManager::default();
        let first = manager
            .start(
                "no-timeout".to_string(),
                workdir(),
                "sleep 0.6; printf survived".to_string(),
                None,
                Some(20),
                None,
                Some(30_000),
                None,
            )
            .expect("command should start without a hard timeout");
        assert_eq!(first.status, ShellSessionStatus::Running);
        assert_eq!(first.timeout_ms, None);
        let final_response = manager
            .wait("no-timeout", Some(first.cursor), Some(5_000))
            .expect("command should finish naturally");
        assert_eq!(final_response.status, ShellSessionStatus::Completed);
        assert_eq!(collect_text(&final_response), "survived");
    }

    #[test]
    fn stop_transitions_session_to_cancelled() {
        let manager = ShellSessionManager::default();
        let first = manager
            .start(
                "stop".to_string(),
                workdir(),
                "printf started; sleep 30".to_string(),
                None,
                Some(50),
                None,
                Some(30_000),
                None,
            )
            .expect("command should start");
        assert_eq!(first.status, ShellSessionStatus::Running);
        let stopped = manager
            .stop("stop", Some(first.cursor))
            .expect("command should stop");
        assert_eq!(stopped.status, ShellSessionStatus::Cancelled);
    }

    #[test]
    fn output_buffer_pages_without_utf8_splits_and_reports_eviction() {
        let config = ShellSessionConfig {
            output_capacity_bytes: 12,
            response_capacity_bytes: 5,
            ..ShellSessionConfig::default()
        };
        let session = ShellSession::new(
            "buffer".to_string(),
            1,
            ShellExecutionProfile {
                platform: "test",
                profile: "test",
                shell_family: "posix",
                display_shell: "sh",
            },
            None,
            None,
            &config,
        );
        session.append_output(ShellOutputStream::Stdout, "12345".to_string());
        session.append_output(ShellOutputStream::Stderr, "中文AB".to_string());

        let first = session.wait(Some(0), Duration::ZERO);
        assert!(first.output_truncated);
        assert!(first.has_more);
        assert!(std::str::from_utf8(collect_text(&first).as_bytes()).is_ok());
        let second = session.wait(Some(first.cursor), Duration::ZERO);
        assert!(std::str::from_utf8(collect_text(&second).as_bytes()).is_ok());
        assert!(second.cursor > first.cursor);
    }

    #[test]
    fn output_pages_are_capped_at_64_kib_without_duplicates() {
        let config = ShellSessionConfig::default();
        let session = ShellSession::new(
            "pages".to_string(),
            1,
            ShellExecutionProfile {
                platform: "test",
                profile: "test",
                shell_family: "posix",
                display_shell: "sh",
            },
            None,
            None,
            &config,
        );
        session.append_output(ShellOutputStream::Stdout, "a".repeat(70 * 1024));
        session.finish(ShellSessionStatus::Completed, Some(0));

        let first = session.wait(Some(0), Duration::ZERO);
        let second = session.wait(Some(first.cursor), Duration::ZERO);
        assert_eq!(collect_text(&first).len(), 64 * 1024);
        assert_eq!(collect_text(&second).len(), 6 * 1024);
        assert_eq!(first.cursor, 64 * 1024);
        assert_eq!(second.cursor, 70 * 1024);
        assert!(first.has_more);
        assert!(!second.has_more);
    }

    #[test]
    fn pagination_never_skips_a_chunk_tail_that_cannot_fit() {
        // 回归：response 配额在多字节字符前耗尽时必须就地停止分页；曾经的
        // continue 会跳到后续 chunk 继续取数，导致乱序输出且 cursor 越过
        // 未读字节（该数据从此不可再读）。
        let config = ShellSessionConfig {
            response_capacity_bytes: 3,
            ..ShellSessionConfig::default()
        };
        let session = ShellSession::new(
            "pagination-boundary".to_string(),
            1,
            ShellExecutionProfile {
                platform: "test",
                profile: "test",
                shell_family: "posix",
                display_shell: "sh",
            },
            None,
            None,
            &config,
        );
        session.append_output(ShellOutputStream::Stdout, "a".to_string());
        session.append_output(ShellOutputStream::Stdout, "中".to_string());
        session.append_output(ShellOutputStream::Stdout, "xyz".to_string());
        session.finish(ShellSessionStatus::Completed, Some(0));

        let mut cursor = 0u64;
        let mut collected = String::new();
        for _ in 0..8 {
            let response = session.wait(Some(cursor), Duration::ZERO);
            collected.push_str(&collect_text(&response));
            cursor = response.cursor;
            if !response.has_more {
                break;
            }
        }
        assert_eq!(collected, "a中xyz");
    }

    #[test]
    fn terminal_duration_stops_advancing_after_completion() {
        let config = ShellSessionConfig::default();
        let session = ShellSession::new(
            "duration".to_string(),
            1,
            ShellExecutionProfile {
                platform: "test",
                profile: "test",
                shell_family: "posix",
                display_shell: "sh",
            },
            None,
            None,
            &config,
        );
        session.finish(ShellSessionStatus::Completed, Some(0));
        let first = session.wait(None, Duration::ZERO);
        std::thread::sleep(Duration::from_millis(20));
        let second = session.wait(None, Duration::ZERO);

        assert_eq!(second.duration_ms, first.duration_ms);
    }

    #[test]
    fn response_preserves_the_effective_sandbox_mechanism() {
        let config = ShellSessionConfig::default();
        let session = ShellSession::new(
            "sandbox-response".to_string(),
            1,
            ShellExecutionProfile {
                platform: "test",
                profile: "test",
                shell_family: "posix",
                display_shell: "sh",
            },
            Some("restricted-token".to_string()),
            None,
            &config,
        );
        session.finish(ShellSessionStatus::Completed, Some(0));

        let response = session.wait(None, Duration::ZERO);
        assert_eq!(response.sandbox.as_deref(), Some("restricted-token"));
    }

    /// Exercise the production session manager with an explicit sandbox option.
    /// The sibling directory deliberately lives outside the workspace but outside
    /// the platform-approved temp roots as well, so a successful write there
    /// would prove that the session lost its fence.
    #[cfg(unix)]
    #[test]
    fn sandboxed_session_enforces_workspace_write_fence() {
        use crate::runtime::sandbox::{self, SandboxOptions};

        let capability = sandbox::capability();
        if !capability.supported {
            let error = ShellSessionManager::default()
                .start(
                    "sandbox-unavailable".to_string(),
                    workdir(),
                    "printf should-not-run".to_string(),
                    None,
                    Some(2_000),
                    None,
                    Some(30_000),
                    Some(SandboxOptions {
                        allow_network: true,
                    }),
                )
                .expect_err("sandbox startup must fail closed when the backend is unavailable");
            assert!(
                error.contains("Sandbox mode is enabled but unavailable")
                    || error.contains("sandbox")
                    || error.contains("bubblewrap"),
                "unexpected fail-closed error: {error}"
            );
            return;
        }

        let home = dirs::home_dir().expect("home directory");
        let outer = tempfile::Builder::new()
            .prefix(".liveagent-sandbox-session-")
            .tempdir_in(home)
            .expect("temporary sandbox parent");
        let workspace = outer.path().join("workspace");
        let sibling = outer.path().join("sibling");
        std::fs::create_dir(&workspace).expect("workspace directory");
        std::fs::create_dir(&sibling).expect("sibling directory");

        let manager = ShellSessionManager::default();
        let first = manager
            .start(
                "sandbox-fence".to_string(),
                workspace.display().to_string(),
                "set -e; printf inside > inside.txt; printf outside > ../sibling/outside.txt"
                    .to_string(),
                None,
                Some(2_000),
                None,
                Some(30_000),
                Some(SandboxOptions {
                    allow_network: true,
                }),
            )
            .expect("sandboxed session should start");
        let response = if first.status == ShellSessionStatus::Running {
            manager
                .wait("sandbox-fence", Some(first.cursor), Some(5_000))
                .expect("sandboxed session should remain waitable")
        } else {
            first
        };

        assert_eq!(response.sandbox.as_deref(), Some(capability.mechanism));
        assert_eq!(response.status, ShellSessionStatus::Failed);
        assert_ne!(response.exit_code, Some(0), "sibling write unexpectedly succeeded");
        assert_eq!(
            std::fs::read_to_string(workspace.join("inside.txt")).expect("workspace write"),
            "inside"
        );
        assert!(
            !sibling.join("outside.txt").exists(),
            "sandboxed session wrote outside its workspace"
        );
        manager.shutdown_cleanup();
    }

    #[test]
    fn explicit_timeout_terminates_the_session() {
        let manager = ShellSessionManager::default();
        let first = manager
            .start(
                "timeout".to_string(),
                workdir(),
                "sleep 30".to_string(),
                None,
                Some(250),
                Some(1_000),
                Some(30_000),
                None,
            )
            .expect("timed command should start");
        assert_eq!(first.status, ShellSessionStatus::Running);
        assert_eq!(first.timeout_ms, Some(1_000));
        let final_response = manager
            .wait("timeout", Some(first.cursor), Some(5_000))
            .expect("timed command should remain waitable");
        assert_eq!(final_response.status, ShellSessionStatus::TimedOut);
    }

    #[cfg(unix)]
    #[test]
    fn stop_terminates_descendants_in_the_process_group() {
        use crate::runtime::process::{probe_process_start_time, ProcessProbe};

        let manager = ShellSessionManager::default();
        let first = manager
            .start(
                "tree".to_string(),
                workdir(),
                "sleep 30 & child=$!; printf \"$child\"; wait".to_string(),
                None,
                Some(300),
                None,
                Some(30_000),
                None,
            )
            .expect("process tree should start");
        let child_pid = collect_text(&first)
            .trim()
            .parse::<u32>()
            .expect("command should report descendant pid");
        let stopped = manager
            .stop("tree", Some(first.cursor))
            .expect("process tree should stop");
        assert_eq!(stopped.status, ShellSessionStatus::Cancelled);

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if matches!(probe_process_start_time(child_pid), ProcessProbe::Dead) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("descendant process {child_pid} survived ProcessStop");
    }

    #[cfg(unix)]
    #[test]
    fn inherited_stdio_does_not_hold_the_session_open() {
        let config = ShellSessionConfig {
            stream_eof_grace: Duration::from_millis(100),
            ..ShellSessionConfig::default()
        };
        let manager = ShellSessionManager::with_config(config);
        let started = Instant::now();
        let response = manager
            .start(
                "inherited-stdio".to_string(),
                workdir(),
                "sleep 2 &".to_string(),
                None,
                Some(1_500),
                None,
                Some(30_000),
                None,
            )
            .expect("background child should not hold session response forever");
        assert_eq!(response.status, ShellSessionStatus::Completed);
        assert!(started.elapsed() < Duration::from_millis(1_500));
        manager.shutdown_cleanup();
    }

    #[test]
    fn expired_terminal_sessions_are_removed() {
        let config = ShellSessionConfig {
            terminal_retention: Duration::from_millis(1),
            ..ShellSessionConfig::default()
        };
        let manager = ShellSessionManager::with_config(config);
        let response = manager
            .start(
                "expired".to_string(),
                workdir(),
                "printf done".to_string(),
                None,
                Some(2_000),
                None,
                Some(30_000),
                None,
            )
            .expect("terminal session should start");
        assert_eq!(response.status, ShellSessionStatus::Completed);
        std::thread::sleep(Duration::from_millis(5));
        manager.cleanup_expired();
        assert!(manager.wait("expired", None, Some(5_000)).is_err());
    }

    #[test]
    fn production_limits_match_the_session_contract() {
        let config = ShellSessionConfig::default();
        assert_eq!(config.max_sessions, 64);
        assert_eq!(config.output_capacity_bytes, 1024 * 1024);
        assert_eq!(config.response_capacity_bytes, 64 * 1024);
        assert_eq!(config.terminal_retention, Duration::from_secs(10 * 60));
    }

    #[test]
    fn session_limit_evicts_terminal_before_rejecting_running_sessions() {
        let config = ShellSessionConfig {
            max_sessions: 1,
            stream_eof_grace: Duration::from_millis(20),
            ..ShellSessionConfig::default()
        };
        let manager = ShellSessionManager::with_config(config);
        let running = manager
            .start(
                "running".to_string(),
                workdir(),
                "sleep 30".to_string(),
                None,
                Some(20),
                None,
                Some(30_000),
                None,
            )
            .expect("first session should start");
        assert_eq!(running.status, ShellSessionStatus::Running);
        let error = manager
            .start(
                "rejected".to_string(),
                workdir(),
                "printf nope".to_string(),
                None,
                Some(20),
                None,
                Some(30_000),
                None,
            )
            .expect_err("all-running limit should reject a new session");
        assert!(error.contains("session limit reached"));
        let _ = manager.stop("running", Some(running.cursor));

        let replacement = manager
            .start(
                "replacement".to_string(),
                workdir(),
                "printf ok".to_string(),
                None,
                Some(2_000),
                None,
                Some(30_000),
                None,
            )
            .expect("terminal session should be evicted for replacement");
        assert_eq!(replacement.status, ShellSessionStatus::Completed);
    }

    #[test]
    fn cwd_helper_accepts_current_directory() {
        assert!(Path::new(&resolve_shell_cwd(&workdir(), None).expect("resolve cwd")).is_dir());
    }
}
