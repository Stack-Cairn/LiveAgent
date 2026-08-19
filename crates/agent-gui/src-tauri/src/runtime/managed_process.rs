use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::Emitter;

use crate::runtime::managed_process_journal as journal;
use crate::runtime::platform::{expand_tilde_path, strip_windows_verbatim_prefix};
use crate::runtime::process::{
    kill_child_process_tree_best_effort, probe_process_start_time, process_start_time_ms,
    signal_process_tree_by_pid, terminate_child_process_tree, terminate_process_tree_by_pid,
    ProcessProbe,
};
use crate::runtime::sandbox::{SandboxOptions, SandboxSpec};
use crate::runtime::shell_runner::spawn_platform_shell_command;
use crate::services::gateway::GatewayController;

const PROCESS_LOG_DIR: &str = "process-logs";
const DEFAULT_LOG_BYTES: u64 = 64 * 1024;
const MAX_LOG_BYTES: u64 = 512 * 1024;
const STOP_GRACE_MS: u64 = 500;
const SHUTDOWN_GRACE_MS: u64 = 1200;
const MONITOR_INTERVAL_MS: u64 = 2000;
const DEFAULT_WAIT_MS: u64 = 30_000;
const MAX_WAIT_MS: u64 = 300_000;
const WAIT_POLL_MS: u64 = 50;
/// Rate limit for pid-probing restored entries (no Child handle to poll).
const RESTORED_PROBE_INTERVAL_MS: u128 = 2000;
/// `ps -o etime` has second granularity; a restored pid whose probed start
/// time drifts beyond this from the journaled one is a reused pid, not ours.
const START_TIME_TOLERANCE_MS: i64 = 60_000;

pub const MANAGED_PROCESS_CHANGED_EVENT: &str = "managed-process:changed";

/// Fan-out target for registry mutations: every change emits the same full
/// snapshot to the local webview and (when connected) to the gateway.
pub struct ManagedProcessNotifier {
    pub app_handle: tauri::AppHandle,
    pub gateway: Weak<GatewayController>,
}

impl ManagedProcessNotifier {
    fn changed(&self, snapshot: &ManagedProcessSnapshot) {
        if let Err(error) = self
            .app_handle
            .emit(MANAGED_PROCESS_CHANGED_EVENT, snapshot)
        {
            eprintln!("emit {MANAGED_PROCESS_CHANGED_EVENT} failed: {error}");
        }
        if let Some(gateway) = self.gateway.upgrade() {
            let snapshot = snapshot.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = gateway.publish_managed_process_snapshot(snapshot).await {
                    eprintln!("publish managed process snapshot failed: {error}");
                }
            });
        }
    }
}

pub(crate) struct ManagedProcessRegistry {
    processes: Mutex<HashMap<String, ManagedProcessEntry>>,
    journal: Mutex<Option<Connection>>,
    revision: AtomicU64,
    notifier: Mutex<Option<ManagedProcessNotifier>>,
    /// This LiveAgent instance's identity, stamped onto journal rows so a
    /// concurrently running sibling instance never reaps our live children.
    owner_pid: u32,
    owner_started_at: i64,
}

impl Default for ManagedProcessRegistry {
    fn default() -> Self {
        Self::with_parts(None, 0)
    }
}

impl Drop for ManagedProcessRegistry {
    fn drop(&mut self) {
        let Ok(processes) = self.processes.get_mut() else {
            return;
        };
        for entry in processes.values_mut() {
            if entry.isolated {
                continue;
            }
            if let Some(child) = entry.child.as_mut() {
                kill_child_process_tree_best_effort(child);
            }
            entry.child = None;
        }
    }
}

struct ManagedProcessEntry {
    id: String,
    label: Option<String>,
    command: String,
    cwd: PathBuf,
    shell: String,
    pid: u32,
    log_path: PathBuf,
    started_at: u128,
    finished_at: Option<u128>,
    exit_code: Option<i32>,
    isolated: bool,
    restored: bool,
    last_probe_at: u128,
    child: Option<Child>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedProcessRecord {
    pub id: String,
    pub label: Option<String>,
    pub command: String,
    pub cwd: String,
    pub shell: String,
    pub pid: u32,
    pub log_path: String,
    pub started_at: u128,
    pub finished_at: Option<u128>,
    pub exit_code: Option<i32>,
    pub running: bool,
    #[serde(default)]
    pub isolated: bool,
    #[serde(default)]
    pub restored: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagedProcessSnapshot {
    pub revision: u64,
    pub processes: Vec<ManagedProcessRecord>,
}

#[derive(Debug, Serialize)]
pub struct ManagedProcessStartResponse {
    pub process: ManagedProcessRecord,
}

#[derive(Debug, Serialize)]
pub struct ManagedProcessStatusResponse {
    pub processes: Vec<ManagedProcessRecord>,
}

#[derive(Debug, Serialize)]
pub struct ManagedProcessStopResponse {
    pub stopped: bool,
    pub process: Option<ManagedProcessRecord>,
}

#[derive(Debug, Serialize)]
pub struct ManagedProcessLogResponse {
    pub id: String,
    pub log_path: String,
    pub content: String,
    pub truncated: bool,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct ManagedProcessWaitResponse {
    pub process: ManagedProcessRecord,
    pub log_path: String,
    pub content: String,
    pub truncated: bool,
    pub bytes: u64,
    pub cursor: u64,
    pub timed_out: bool,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn app_storage_dir() -> Result<PathBuf, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Failed to locate the user home directory".to_string())?;
    let dir = home.join(format!(".{}", env!("CARGO_PKG_NAME")));
    fs::create_dir_all(&dir).map_err(|err| format!("Failed to create app storage dir: {err}"))?;
    Ok(dir)
}

fn process_log_dir() -> Result<PathBuf, String> {
    let dir = app_storage_dir()?.join(PROCESS_LOG_DIR);
    fs::create_dir_all(&dir).map_err(|err| format!("Failed to create process log dir: {err}"))?;
    Ok(dir)
}

fn canonicalize_workdir(workdir: &str) -> Result<PathBuf, String> {
    let raw = workdir.trim();
    if raw.is_empty() {
        return Err("workdir must be an existing absolute directory".to_string());
    }
    let path = expand_tilde_path(raw);
    if !path.is_absolute() {
        return Err(format!("workdir must be absolute: {workdir}"));
    }
    let metadata = fs::metadata(&path).map_err(|_| format!("workdir does not exist: {workdir}"))?;
    if !metadata.is_dir() {
        return Err(format!("workdir must be a directory: {workdir}"));
    }
    // Strip the Windows `\\?\` verbatim prefix: the result becomes the child
    // process cwd (cmd.exe rejects verbatim paths) and the record's display cwd.
    fs::canonicalize(&path)
        .map(strip_windows_verbatim_prefix)
        .map_err(|err| format!("Failed to canonicalize workdir: {err}"))
}

fn sanitize_rel_cwd(input: Option<String>, workdir: &Path) -> Result<PathBuf, String> {
    let Some(raw) = input else {
        return Ok(workdir.to_path_buf());
    };
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() || normalized == "." || normalized == "./" {
        return Ok(workdir.to_path_buf());
    }
    let path = Path::new(&normalized);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                return Err(format!(
                    "cwd must be relative and stay inside workdir: {raw}"
                ));
            }
            Component::CurDir => {}
            Component::Normal(segment) => {
                if segment.to_string_lossy().contains(':') {
                    return Err(format!(
                        "cwd must not contain drive letters or streams: {raw}"
                    ));
                }
                out.push(segment);
            }
        }
    }
    let target = workdir.join(out);
    // Same verbatim-stripped shape as the workdir so starts_with compares
    // like forms on Windows.
    let canonical = strip_windows_verbatim_prefix(
        fs::canonicalize(&target).map_err(|_| format!("cwd does not exist: {raw}"))?,
    );
    if !canonical.starts_with(workdir) {
        return Err(format!("cwd is outside workdir: {raw}"));
    }
    if !fs::metadata(&canonical)
        .map_err(|err| err.to_string())?
        .is_dir()
    {
        return Err(format!("cwd must be a directory: {raw}"));
    }
    Ok(canonical)
}

fn spawn_shell_command(
    command: &str,
    cwd: &Path,
    log: File,
    log_path: &Path,
    sandbox_spec: Option<&SandboxSpec>,
) -> Result<(Child, String), String> {
    let stderr = log
        .try_clone()
        .map_err(|err| format!("Failed to clone process log: {err}"))?;

    // POSIX(Git Bash) 不会把继承的 Win32 文件句柄接到 fd 1/2,所以把日志路径
    // 交给脚本用 POSIX 路径自己打开,并用 stdbuf 按行刷盘。PowerShell/cmd 仍走
    // 继承句柄。映像仍是平台 shell,Windows 沙箱对 Git Bash 的 SID 判定不变。
    let spawned = spawn_platform_shell_command(
        command,
        cwd,
        &[],
        sandbox_spec,
        true,
        Some(log_path),
        || {
            Ok((
                Stdio::from(log.try_clone()?),
                Stdio::from(stderr.try_clone()?),
            ))
        },
    )?;
    Ok((spawned.child, spawned.profile.display_shell.to_string()))
}

fn entry_running(entry: &ManagedProcessEntry) -> bool {
    entry.finished_at.is_none()
}

fn read_log_from_cursor(
    log_path: &Path,
    cursor: u64,
    max_bytes: u64,
) -> Result<(String, u64, u64, bool), String> {
    let mut file =
        File::open(log_path).map_err(|err| format!("Failed to open process log: {err}"))?;
    let len = file.metadata().map_err(|err| err.to_string())?.len();
    let start = cursor.min(len);
    let remaining = len.saturating_sub(start);
    let truncated = remaining > max_bytes;
    let read_len = remaining.min(max_bytes);
    file.seek(SeekFrom::Start(start))
        .map_err(|err| format!("Failed to seek process log: {err}"))?;
    let mut bytes = vec![0_u8; read_len as usize];
    if read_len > 0 {
        file.read_exact(&mut bytes)
            .map_err(|err| format!("Failed to read process log: {err}"))?;
    }
    Ok((
        String::from_utf8_lossy(&bytes).to_string(),
        start.saturating_add(read_len),
        read_len,
        truncated,
    ))
}

enum RecordProbe {
    AliveMatching,
    Gone,
    Unknown,
}

/// Probes a pid and matches its start time against a journaled record so a
/// reused pid is never mistaken for our process. `Unknown` means the probe
/// itself failed transiently — callers must neither kill nor forget.
fn probe_record(pid: u32, started_at: u128) -> RecordProbe {
    match probe_process_start_time(pid) {
        ProcessProbe::Alive { started_at_ms } => {
            if (started_at_ms - started_at as i64).abs() <= START_TIME_TOLERANCE_MS {
                RecordProbe::AliveMatching
            } else {
                RecordProbe::Gone
            }
        }
        ProcessProbe::Dead => RecordProbe::Gone,
        ProcessProbe::Unknown => RecordProbe::Unknown,
    }
}

/// Polls one entry: reaps an exited child, or pid-probes a restored entry
/// (rate limited). Returns true when the entry just transitioned to
/// finished. On the reap transition of a non-isolated entry the whole
/// process group is force-swept so group members that outlived the shell
/// leader (the express-behind-npm case) are reclaimed too.
fn refresh_entry(entry: &mut ManagedProcessEntry) -> Result<bool, String> {
    if entry.finished_at.is_some() {
        return Ok(false);
    }
    if let Some(child) = entry.child.as_mut() {
        let Some(status) = child
            .try_wait()
            .map_err(|err| format!("Failed to poll process: {err}"))?
        else {
            return Ok(false);
        };
        entry.exit_code = Some(status.code().unwrap_or(-1));
        entry.finished_at = Some(now_ms());
        entry.child = None;
        if !entry.isolated {
            signal_process_tree_by_pid(entry.pid, true);
        }
        return Ok(true);
    }
    if !entry.restored {
        // A live-tracked entry without a child handle is already finished;
        // finished_at.is_some() above covers it. Nothing to poll here.
        return Ok(false);
    }
    let now = now_ms();
    if now.saturating_sub(entry.last_probe_at) < RESTORED_PROBE_INTERVAL_MS {
        return Ok(false);
    }
    entry.last_probe_at = now;
    match probe_record(entry.pid, entry.started_at) {
        // Transient probe failure: keep the entry and retry next interval.
        RecordProbe::AliveMatching | RecordProbe::Unknown => Ok(false),
        RecordProbe::Gone => {
            entry.finished_at = Some(now);
            Ok(true)
        }
    }
}

fn refresh_all_locked(
    processes: &mut HashMap<String, ManagedProcessEntry>,
) -> Result<Vec<String>, String> {
    let mut finished = Vec::new();
    for entry in processes.values_mut() {
        if refresh_entry(entry)? {
            finished.push(entry.id.clone());
        }
    }
    Ok(finished)
}

fn to_record(entry: &ManagedProcessEntry) -> ManagedProcessRecord {
    ManagedProcessRecord {
        id: entry.id.clone(),
        label: entry.label.clone(),
        command: entry.command.clone(),
        cwd: entry.cwd.display().to_string(),
        shell: entry.shell.clone(),
        pid: entry.pid,
        log_path: entry.log_path.display().to_string(),
        started_at: entry.started_at,
        finished_at: entry.finished_at,
        exit_code: entry.exit_code,
        running: entry_running(entry),
        isolated: entry.isolated,
        restored: entry.restored,
    }
}

fn entry_from_record(record: ManagedProcessRecord) -> ManagedProcessEntry {
    ManagedProcessEntry {
        id: record.id,
        label: record.label,
        command: record.command,
        cwd: PathBuf::from(record.cwd),
        shell: record.shell,
        pid: record.pid,
        log_path: PathBuf::from(record.log_path),
        started_at: record.started_at,
        finished_at: None,
        exit_code: None,
        isolated: record.isolated,
        restored: true,
        last_probe_at: now_ms(),
        child: None,
    }
}

impl ManagedProcessRegistry {
    fn with_parts(conn: Option<Connection>, revision: u64) -> Self {
        let owner_pid = std::process::id();
        let owner_started_at = process_start_time_ms(owner_pid).unwrap_or(0);
        Self {
            processes: Mutex::new(HashMap::new()),
            journal: Mutex::new(conn),
            revision: AtomicU64::new(revision),
            notifier: Mutex::new(None),
            owner_pid,
            owner_started_at,
        }
    }

    /// Opens the registry with its SQLite journal. Journal failures degrade
    /// to in-memory-only management (no crash reaping, no isolated restore).
    pub fn open() -> Self {
        let (conn, revision) = match journal::open_journal() {
            Ok(conn) => {
                let revision = journal::read_journal_revision(&conn).unwrap_or(0);
                (Some(conn), revision)
            }
            Err(error) => {
                eprintln!("managed process journal unavailable: {error}");
                (None, 0)
            }
        };
        Self::with_parts(conn, revision)
    }

    #[cfg(test)]
    fn with_journal_conn(conn: Connection) -> Self {
        journal::ensure_journal_schema(&conn).expect("journal schema");
        let revision = journal::read_journal_revision(&conn).unwrap_or(0);
        Self::with_parts(Some(conn), revision)
    }

    pub fn set_notifier(&self, notifier: ManagedProcessNotifier) {
        if let Ok(mut guard) = self.notifier.lock() {
            *guard = Some(notifier);
        }
    }

    fn lock_processes(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, ManagedProcessEntry>>, String> {
        self.processes
            .lock()
            .map_err(|_| "managed process registry poisoned".to_string())
    }

    fn with_journal(&self, f: impl FnOnce(&Connection)) {
        if let Ok(guard) = self.journal.lock() {
            if let Some(conn) = guard.as_ref() {
                f(conn);
            }
        }
    }

    fn delete_journal_rows(&self, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        self.with_journal(|conn| {
            for id in ids {
                if let Err(error) = journal::delete_row(conn, id) {
                    eprintln!("{error}");
                }
            }
        });
    }

    fn collect_records(&self) -> Result<Vec<ManagedProcessRecord>, String> {
        let processes = self.lock_processes()?;
        let mut records: Vec<ManagedProcessRecord> = processes.values().map(to_record).collect();
        records.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(records)
    }

    fn bump_and_notify(&self) {
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        self.with_journal(|conn| {
            if let Err(error) = journal::persist_journal_revision(conn, revision) {
                eprintln!("{error}");
            }
        });
        let processes = match self.collect_records() {
            Ok(records) => records,
            Err(error) => {
                eprintln!("managed process snapshot failed: {error}");
                return;
            }
        };
        let snapshot = ManagedProcessSnapshot {
            revision,
            processes,
        };
        if let Ok(guard) = self.notifier.lock() {
            if let Some(notifier) = guard.as_ref() {
                notifier.changed(&snapshot);
            }
        }
    }

    /// Settles natural exits (reap/probe), deletes their journal rows and
    /// broadcasts when anything changed. Returns whether a change happened.
    fn sync(&self) -> Result<bool, String> {
        let finished = {
            let mut processes = self.lock_processes()?;
            refresh_all_locked(&mut processes)?
        };
        if finished.is_empty() {
            return Ok(false);
        }
        self.delete_journal_rows(&finished);
        self.bump_and_notify();
        Ok(true)
    }

    pub fn snapshot(&self) -> Result<ManagedProcessSnapshot, String> {
        self.sync()?;
        Ok(ManagedProcessSnapshot {
            revision: self.revision.load(Ordering::SeqCst),
            processes: self.collect_records()?,
        })
    }

    pub fn start(
        &self,
        workdir: String,
        command: String,
        cwd: Option<String>,
        label: Option<String>,
        isolated: bool,
        sandbox_options: Option<SandboxOptions>,
    ) -> Result<ManagedProcessStartResponse, String> {
        let command = command.trim().to_string();
        if command.is_empty() {
            return Err("command cannot be empty".to_string());
        }
        let workdir = canonicalize_workdir(&workdir)?;
        let cwd = sanitize_rel_cwd(cwd, &workdir)?;
        let id = uuid::Uuid::new_v4().to_string();
        let log_path = process_log_dir()?.join(format!("{id}.log"));
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|err| format!("Failed to open process log: {err}"))?;
        // 写围栏锚定工作区根;dev server 等常驻进程通常要监听端口,是否放网络
        // 由调用方经 SandboxOptions 决定。isolated 常驻进程须在 LiveAgent 退出后
        // 存活,透传给沙箱规格以省略 Linux 的 --die-with-parent 死亡耦合。
        let sandbox_spec = sandbox_options.map(|options| {
            let mut spec = SandboxSpec::from_options(workdir.clone(), options);
            spec.isolated = isolated;
            spec
        });
        let (child, shell) =
            spawn_shell_command(&command, &cwd, log, &log_path, sandbox_spec.as_ref())?;
        let pid = child.id();
        let entry = ManagedProcessEntry {
            id: id.clone(),
            label: label
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            command,
            cwd,
            shell,
            pid,
            log_path,
            started_at: now_ms(),
            finished_at: None,
            exit_code: None,
            isolated,
            restored: false,
            last_probe_at: 0,
            child: Some(child),
        };
        let record = to_record(&entry);
        // Journal before the entry becomes observable: once it is in the map
        // the monitor may reap an instant exit and delete the row — an insert
        // reordered after that delete would strand a row for a dead process.
        self.with_journal(|conn| {
            if let Err(error) =
                journal::insert_row(conn, &record, self.owner_pid, self.owner_started_at)
            {
                eprintln!("{error}");
            }
        });
        self.lock_processes()?.insert(id, entry);
        self.bump_and_notify();
        Ok(ManagedProcessStartResponse { process: record })
    }

    pub fn status(&self, id: Option<String>) -> Result<ManagedProcessStatusResponse, String> {
        let id = id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        self.sync()?;
        let mut records = self.collect_records()?;
        if let Some(wanted) = id {
            records.retain(|record| record.id == wanted);
        }
        Ok(ManagedProcessStatusResponse { processes: records })
    }

    pub fn stop(&self, id: String) -> Result<ManagedProcessStopResponse, String> {
        let id = id.trim().to_string();
        if id.is_empty() {
            return Err("process_id is required".to_string());
        }
        self.sync()?;
        let (stopped, record) = {
            let mut processes = self.lock_processes()?;
            let Some(entry) = processes.get_mut(&id) else {
                return Ok(ManagedProcessStopResponse {
                    stopped: false,
                    process: None,
                });
            };
            if entry.finished_at.is_some() {
                (false, to_record(entry))
            } else {
                if let Some(child) = entry.child.as_mut() {
                    let status =
                        terminate_child_process_tree(child, Duration::from_millis(STOP_GRACE_MS))
                            .map_err(|err| format!("Failed to stop process: {err}"))?;
                    entry.exit_code = Some(status.code().unwrap_or(-1));
                    entry.child = None;
                    // The graceful path returns as soon as the leader dies;
                    // sweep the group so a member that traps TERM (a dev
                    // server behind a shell) cannot outlive its stop.
                    signal_process_tree_by_pid(entry.pid, true);
                } else {
                    // Restored entry: no handle, terminate the group by pid.
                    terminate_process_tree_by_pid(entry.pid, Duration::from_millis(STOP_GRACE_MS));
                    entry.exit_code = None;
                }
                entry.finished_at = Some(now_ms());
                (true, to_record(entry))
            }
        };
        if stopped {
            self.delete_journal_rows(std::slice::from_ref(&id));
            self.bump_and_notify();
        }
        Ok(ManagedProcessStopResponse {
            stopped,
            process: Some(record),
        })
    }

    /// Drops finished records from the panel. `None` clears every finished
    /// record; a specific id errors if the process is still running.
    pub fn clear(&self, id: Option<String>) -> Result<ManagedProcessSnapshot, String> {
        self.sync()?;
        let removed = {
            let mut processes = self.lock_processes()?;
            match id {
                Some(id) => {
                    let id = id.trim().to_string();
                    match processes.get(&id) {
                        None => false,
                        Some(entry) if entry_running(entry) => {
                            return Err(format!("process is still running: {id}"));
                        }
                        Some(_) => {
                            processes.remove(&id);
                            true
                        }
                    }
                }
                None => {
                    let before = processes.len();
                    processes.retain(|_, entry| entry_running(entry));
                    processes.len() != before
                }
            }
        };
        if removed {
            self.bump_and_notify();
        }
        self.snapshot()
    }

    pub fn read_log(
        &self,
        id: String,
        max_bytes: Option<u64>,
    ) -> Result<ManagedProcessLogResponse, String> {
        let id = id.trim();
        if id.is_empty() {
            return Err("process_id is required".to_string());
        }
        let log_path = {
            let processes = self.lock_processes()?;
            let Some(entry) = processes.get(id) else {
                return Err(format!("Managed process not found: {id}"));
            };
            entry.log_path.clone()
        };
        let limit = max_bytes
            .unwrap_or(DEFAULT_LOG_BYTES)
            .clamp(1, MAX_LOG_BYTES);
        let mut file =
            File::open(&log_path).map_err(|err| format!("Failed to open process log: {err}"))?;
        let len = file.metadata().map_err(|err| err.to_string())?.len();
        let start = len.saturating_sub(limit);
        file.seek(SeekFrom::Start(start))
            .map_err(|err| format!("Failed to seek process log: {err}"))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|err| format!("Failed to read process log: {err}"))?;
        Ok(ManagedProcessLogResponse {
            id: id.to_string(),
            log_path: log_path.display().to_string(),
            content: String::from_utf8_lossy(&bytes).to_string(),
            truncated: start > 0,
            bytes: bytes.len() as u64,
        })
    }

    /// Blocks until the process exits, the log grows past `cursor`, or
    /// `yield_time_ms` elapses. `cursor` is the absolute byte offset already
    /// consumed (same idea as ProcessWait); omit it to start from 0.
    pub fn wait(
        &self,
        id: String,
        cursor: Option<u64>,
        yield_time_ms: Option<u64>,
        max_bytes: Option<u64>,
    ) -> Result<ManagedProcessWaitResponse, String> {
        let id = id.trim().to_string();
        if id.is_empty() {
            return Err("process_id is required".to_string());
        }
        let yield_for = Duration::from_millis(
            yield_time_ms
                .unwrap_or(DEFAULT_WAIT_MS)
                .clamp(1, MAX_WAIT_MS),
        );
        let limit = max_bytes
            .unwrap_or(DEFAULT_LOG_BYTES)
            .clamp(1, MAX_LOG_BYTES);
        let cursor = cursor.unwrap_or(0);
        let deadline = Instant::now() + yield_for;

        loop {
            let _ = self.sync();
            let (running, log_path) = {
                let processes = self.lock_processes()?;
                let Some(entry) = processes.get(&id) else {
                    return Err(format!("Managed process not found: {id}"));
                };
                (entry_running(entry), entry.log_path.clone())
            };
            let len = fs::metadata(&log_path).map(|meta| meta.len()).unwrap_or(0);
            if !running || len > cursor {
                let (content, new_cursor, bytes, truncated) =
                    read_log_from_cursor(&log_path, cursor, limit)?;
                let process = self
                    .status(Some(id))?
                    .processes
                    .into_iter()
                    .next()
                    .ok_or_else(|| "Managed process disappeared during wait".to_string())?;
                return Ok(ManagedProcessWaitResponse {
                    process,
                    log_path: log_path.display().to_string(),
                    content,
                    truncated,
                    bytes,
                    cursor: new_cursor,
                    timed_out: false,
                });
            }
            if Instant::now() >= deadline {
                let process = self
                    .status(Some(id))?
                    .processes
                    .into_iter()
                    .next()
                    .ok_or_else(|| "Managed process disappeared during wait".to_string())?;
                return Ok(ManagedProcessWaitResponse {
                    process,
                    log_path: log_path.display().to_string(),
                    content: String::new(),
                    truncated: false,
                    bytes: 0,
                    cursor,
                    timed_out: true,
                });
            }
            std::thread::sleep(Duration::from_millis(WAIT_POLL_MS));
        }
    }

    /// Reconciles journal rows left by the previous run: isolated rows whose
    /// pid still matches are restored into the panel; non-isolated leftovers
    /// are crash residue and get their trees reaped; everything else is
    /// pruned. Spawned on a background thread at startup.
    pub fn spawn_startup_reconcile(self: &Arc<Self>) {
        let registry = Arc::clone(self);
        std::thread::spawn(move || {
            if let Err(error) = registry.startup_reconcile() {
                eprintln!("managed process startup reconcile failed: {error}");
            }
        });
    }

    fn startup_reconcile(&self) -> Result<(), String> {
        let rows = {
            let guard = self
                .journal
                .lock()
                .map_err(|_| "managed process journal poisoned".to_string())?;
            let Some(conn) = guard.as_ref() else {
                return Ok(());
            };
            journal::read_rows(conn)?
        };
        if rows.is_empty() {
            return Ok(());
        }
        let mut drop_ids = Vec::new();
        let mut restored = Vec::new();
        for row in rows {
            // A row owned by a still-running sibling LiveAgent instance is
            // that instance's live child, not crash residue — leave it alone.
            let owner_alive = row.owner_pid != 0
                && row.owner_pid != self.owner_pid
                && !matches!(
                    probe_record(row.owner_pid, row.owner_started_at.max(0) as u128),
                    RecordProbe::Gone
                );
            if owner_alive {
                continue;
            }
            let record = row.record;
            match probe_record(record.pid, record.started_at) {
                // Probe hiccup: neither kill nor restore nor forget; the row
                // is reconsidered on the next launch.
                RecordProbe::Unknown => {}
                RecordProbe::AliveMatching if record.isolated => restored.push(record),
                RecordProbe::AliveMatching => {
                    terminate_process_tree_by_pid(record.pid, Duration::from_millis(STOP_GRACE_MS));
                    drop_ids.push(record.id);
                }
                RecordProbe::Gone => drop_ids.push(record.id),
            }
        }
        self.delete_journal_rows(&drop_ids);
        if !restored.is_empty() {
            // Take ownership of the restored rows so this instance's clean
            // shutdown bookkeeping applies to them from now on.
            self.with_journal(|conn| {
                for record in &restored {
                    if let Err(error) =
                        journal::insert_row(conn, record, self.owner_pid, self.owner_started_at)
                    {
                        eprintln!("{error}");
                    }
                }
            });
            let mut processes = self.lock_processes()?;
            for record in restored {
                processes
                    .entry(record.id.clone())
                    .or_insert_with(|| entry_from_record(record));
            }
        }
        self.bump_and_notify();
        Ok(())
    }

    /// Background poll so the panel observes exits nobody asked about.
    pub fn spawn_monitor(self: &Arc<Self>) {
        let registry = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(MONITOR_INTERVAL_MS));
            let Some(registry) = registry.upgrade() else {
                return;
            };
            if let Err(error) = registry.sync() {
                eprintln!("managed process monitor failed: {error}");
            }
        });
    }

    /// Terminates every non-isolated running process before the app exits:
    /// one TERM broadcast, a single bounded grace window, then a KILL sweep.
    /// Isolated processes and their journal rows are left untouched.
    pub fn shutdown_cleanup(&self) {
        let Ok(mut processes) = self.processes.lock() else {
            return;
        };
        let _ = refresh_all_locked(&mut processes);
        let targets: Vec<String> = processes
            .values()
            .filter(|entry| !entry.isolated && entry_running(entry))
            .map(|entry| entry.id.clone())
            .collect();
        if !targets.is_empty() {
            for id in &targets {
                if let Some(entry) = processes.get(id) {
                    signal_process_tree_by_pid(entry.pid, false);
                }
            }
            let deadline = Instant::now() + Duration::from_millis(SHUTDOWN_GRACE_MS);
            loop {
                let mut all_exited = true;
                for id in &targets {
                    let Some(entry) = processes.get_mut(id) else {
                        continue;
                    };
                    if let Some(child) = entry.child.as_mut() {
                        match child.try_wait() {
                            Ok(Some(_)) => entry.child = None,
                            _ => all_exited = false,
                        }
                    }
                }
                if all_exited || Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            for id in &targets {
                let Some(entry) = processes.get_mut(id) else {
                    continue;
                };
                signal_process_tree_by_pid(entry.pid, true);
                if let Some(child) = entry.child.as_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                    entry.child = None;
                }
                entry.finished_at = Some(now_ms());
            }
        }
        drop(processes);
        self.with_journal(|conn| {
            if let Err(error) =
                journal::delete_non_isolated_rows(conn, self.owner_pid, self.owner_started_at)
            {
                eprintln!("{error}");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        std::process::Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    /// `kill -0` treats zombies as alive. The crash-simulation test leaks
    /// its registry (`mem::forget`), so killed children are never reaped by
    /// their parent (this test process) and would read as alive forever —
    /// check the process state instead. Real crashes reparent children to
    /// init, which reaps them.
    #[cfg(unix)]
    fn process_alive(pid: u32) -> bool {
        let output = std::process::Command::new("ps")
            .arg("-p")
            .arg(pid.to_string())
            .arg("-o")
            .arg("state=")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        match output {
            Ok(output) if output.status.success() => {
                let state = String::from_utf8_lossy(&output.stdout).trim().to_string();
                !state.is_empty() && !state.starts_with('Z')
            }
            _ => false,
        }
    }

    /// True while ANY member of the process group is alive, even after the
    /// leader exited.
    #[cfg(unix)]
    fn process_group_exists(pgid: u32) -> bool {
        std::process::Command::new("kill")
            .arg("-0")
            .arg("--")
            .arg(format!("-{pgid}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(unix)]
    fn wait_until(mut check: impl FnMut() -> bool) -> bool {
        for _ in 0..100 {
            if check() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    fn temp_workdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "liveagent-managed-process-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    fn wait_for_log_content(
        registry: &ManagedProcessRegistry,
        process_id: &str,
        expected: &str,
    ) -> ManagedProcessLogResponse {
        let mut last_log = registry
            .read_log(process_id.to_string(), Some(1024))
            .expect("log should be readable");
        for _ in 0..150 {
            if last_log.content.contains(expected) {
                return last_log;
            }
            std::thread::sleep(Duration::from_millis(50));
            last_log = registry
                .read_log(process_id.to_string(), Some(1024))
                .expect("log should be readable");
        }
        last_log
    }

    #[test]
    fn managed_process_echo_is_visible_while_running() {
        let temp_dir = temp_workdir("echo-flush");
        let registry = ManagedProcessRegistry::default();
        let started = registry
            .start(
                temp_dir.display().to_string(),
                "echo liveagent-managed-process-ready; sleep 30".to_string(),
                None,
                Some("flush test".to_string()),
                false,
                None,
            )
            .expect("process should start");
        let process_id = started.process.id.clone();
        let log = wait_for_log_content(&registry, &process_id, "liveagent-managed-process-ready");
        let status = registry
            .status(Some(process_id.clone()))
            .expect("status should work");
        assert!(
            log.content.contains("liveagent-managed-process-ready"),
            "periodic/early echo must appear in the log before the process exits; \
             running={} exit={:?} shell={} pid={} content={:?}",
            status.processes[0].running,
            status.processes[0].exit_code,
            started.process.shell,
            started.process.pid,
            log.content
        );
        assert!(
            status.processes[0].running,
            "echo should be visible while the managed process is still running"
        );
        let waited = registry
            .wait(process_id.clone(), Some(0), Some(5_000), Some(4096))
            .expect("wait should work");
        assert!(waited.content.contains("liveagent-managed-process-ready"));
        assert!(!waited.timed_out);
        assert!(waited.cursor > 0);

        let _ = registry.stop(process_id);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn managed_process_runs_logs_and_stops() {
        let temp_dir = temp_workdir("basic");

        let registry = ManagedProcessRegistry::default();
        let started = registry
            .start(
                temp_dir.display().to_string(),
                "printf 'ready\\n'; sleep 30".to_string(),
                None,
                Some("test process".to_string()),
                false,
                None,
            )
            .expect("process should start");
        let process_id = started.process.id.clone();

        let status = registry
            .status(Some(process_id.clone()))
            .expect("status should work");
        assert_eq!(status.processes.len(), 1);
        assert!(status.processes[0].running);
        assert!(!status.processes[0].isolated);

        let log = wait_for_log_content(&registry, &process_id, "ready");
        assert!(log.content.contains("ready"));

        let stopped = registry
            .stop(process_id.clone())
            .expect("process should stop");
        assert!(stopped.stopped);
        assert!(!stopped.process.expect("record should exist").running);

        let status = registry
            .status(Some(process_id))
            .expect("status after stop should work");
        assert_eq!(status.processes.len(), 1);
        assert!(!status.processes[0].running);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn managed_process_registry_drop_stops_running_children() {
        let temp_dir = temp_workdir("drop");

        let pid = {
            let registry = ManagedProcessRegistry::default();
            let started = registry
                .start(
                    temp_dir.display().to_string(),
                    "sleep 30".to_string(),
                    None,
                    Some("drop test process".to_string()),
                    false,
                    None,
                )
                .expect("process should start");
            let pid = started.process.pid;
            assert!(process_exists(pid));
            pid
        };

        assert!(wait_until(|| !process_exists(pid)));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn stop_kills_backgrounded_group_members() {
        let temp_dir = temp_workdir("group-stop");

        let registry = ManagedProcessRegistry::default();
        let started = registry
            .start(
                temp_dir.display().to_string(),
                "sleep 40 & sleep 40".to_string(),
                None,
                None,
                false,
                None,
            )
            .expect("process should start");
        let pid = started.process.pid;
        assert!(process_group_exists(pid));

        let stopped = registry
            .stop(started.process.id.clone())
            .expect("stop should work");
        assert!(stopped.stopped);
        assert!(
            wait_until(|| !process_group_exists(pid)),
            "background group member survived stop"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn stop_kills_term_trapping_group_members() {
        let temp_dir = temp_workdir("term-trap");

        let registry = ManagedProcessRegistry::default();
        let started = registry
            .start(
                temp_dir.display().to_string(),
                // The backgrounded member ignores TERM while the foreground
                // leader dies to it quickly, exercising the graceful-return
                // stop path that must still sweep the group.
                "sh -c 'trap \"\" TERM; sleep 40' & sleep 40".to_string(),
                None,
                None,
                false,
                None,
            )
            .expect("process should start");
        let pid = started.process.pid;
        assert!(process_group_exists(pid));

        let stopped = registry
            .stop(started.process.id.clone())
            .expect("stop should work");
        assert!(stopped.stopped);
        assert!(
            wait_until(|| !process_group_exists(pid)),
            "TERM-trapping group member survived stop"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn leader_exit_sweeps_stray_group_members() {
        let temp_dir = temp_workdir("group-sweep");

        let registry = ManagedProcessRegistry::default();
        let started = registry
            .start(
                temp_dir.display().to_string(),
                // Shell leader exits immediately; the backgrounded sleep
                // stays behind in the same process group.
                "sleep 40 & true".to_string(),
                None,
                None,
                false,
                None,
            )
            .expect("process should start");
        let pid = started.process.pid;

        assert!(wait_until(|| {
            let status = registry.status(None).expect("status should work");
            !status.processes[0].running
        }));
        assert!(
            wait_until(|| !process_group_exists(pid)),
            "stray group member survived leader exit"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_cleanup_kills_non_isolated_and_spares_isolated() {
        let temp_dir = temp_workdir("shutdown");

        let registry = ManagedProcessRegistry::default();
        let plain = registry
            .start(
                temp_dir.display().to_string(),
                "sleep 40".to_string(),
                None,
                None,
                false,
                None,
            )
            .expect("plain process should start");
        let isolated = registry
            .start(
                temp_dir.display().to_string(),
                "sleep 40".to_string(),
                None,
                None,
                true,
                None,
            )
            .expect("isolated process should start");

        registry.shutdown_cleanup();

        assert!(wait_until(|| !process_exists(plain.process.pid)));
        assert!(process_exists(isolated.process.pid));

        // Clean up the intentionally surviving isolated process.
        signal_process_tree_by_pid(isolated.process.pid, true);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn crash_residue_is_reaped_and_isolated_processes_are_restored() {
        let temp_dir = temp_workdir("reconcile");
        let db_path = temp_dir.join("journal.sqlite");

        let open_conn = || Connection::open(&db_path).expect("journal db should open");

        // Simulate a crashed previous run: start both flavors, then leak the
        // registry so neither Drop nor shutdown cleanup runs.
        let (plain_pid, isolated_id, isolated_pid) = {
            let registry = ManagedProcessRegistry::with_journal_conn(open_conn());
            let plain = registry
                .start(
                    temp_dir.display().to_string(),
                    "sleep 40".to_string(),
                    None,
                    None,
                    false,
                    None,
                )
                .expect("plain process should start");
            let isolated = registry
                .start(
                    temp_dir.display().to_string(),
                    "sleep 40".to_string(),
                    None,
                    Some("isolated service".to_string()),
                    true,
                    None,
                )
                .expect("isolated process should start");
            let ids = (
                plain.process.pid,
                isolated.process.id.clone(),
                isolated.process.pid,
            );
            std::mem::forget(registry);
            ids
        };
        assert!(process_alive(plain_pid));
        assert!(process_alive(isolated_pid));

        // Next launch.
        let registry = ManagedProcessRegistry::with_journal_conn(open_conn());
        registry.startup_reconcile().expect("reconcile should work");

        assert!(
            wait_until(|| !process_alive(plain_pid)),
            "crash residue survived reconcile"
        );
        assert!(process_alive(isolated_pid), "isolated process was killed");

        let snapshot = registry.snapshot().expect("snapshot should work");
        assert_eq!(snapshot.processes.len(), 1);
        let record = &snapshot.processes[0];
        assert_eq!(record.id, isolated_id);
        assert!(record.running && record.isolated && record.restored);

        // The restored entry is manageable without a Child handle.
        let stopped = registry
            .stop(isolated_id)
            .expect("restored process should stop");
        assert!(stopped.stopped);
        assert!(wait_until(|| !process_alive(isolated_pid)));

        // Journal must be empty afterwards.
        let conn = open_conn();
        let rows = journal::read_rows(&conn).expect("rows should read");
        assert!(rows.is_empty());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn clear_drops_finished_records_only() {
        let temp_dir = temp_workdir("clear");

        let registry = ManagedProcessRegistry::default();
        let finished = registry
            .start(
                temp_dir.display().to_string(),
                "true".to_string(),
                None,
                None,
                false,
                None,
            )
            .expect("short process should start");
        let running = registry
            .start(
                temp_dir.display().to_string(),
                "sleep 40".to_string(),
                None,
                None,
                false,
                None,
            )
            .expect("long process should start");

        assert!(wait_until(|| {
            registry
                .status(Some(finished.process.id.clone()))
                .is_ok_and(|status| !status.processes[0].running)
        }));

        assert!(registry.clear(Some(running.process.id.clone())).is_err());

        let snapshot = registry.clear(None).expect("clear should work");
        assert_eq!(snapshot.processes.len(), 1);
        assert_eq!(snapshot.processes[0].id, running.process.id);

        let _ = registry.stop(running.process.id);
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
