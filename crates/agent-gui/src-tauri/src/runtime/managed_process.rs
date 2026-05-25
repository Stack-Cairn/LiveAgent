use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::runtime::platform::{expand_tilde_path, maybe_augment_macos_path, shell_basename};
use crate::runtime::process::{
    configure_child_process_group, kill_child_process_tree_best_effort,
    terminate_child_process_tree,
};

const PROCESS_LOG_DIR: &str = "process-logs";
const DEFAULT_LOG_BYTES: u64 = 64 * 1024;
const MAX_LOG_BYTES: u64 = 512 * 1024;
const STOP_GRACE_MS: u64 = 500;

#[derive(Default)]
pub(crate) struct ManagedProcessRegistry {
    processes: Mutex<HashMap<String, ManagedProcessEntry>>,
}

impl Drop for ManagedProcessRegistry {
    fn drop(&mut self) {
        let Ok(processes) = self.processes.get_mut() else {
            return;
        };
        for entry in processes.values_mut() {
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
    child: Option<Child>,
}

#[derive(Debug, Serialize)]
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
    fs::canonicalize(&path).map_err(|err| format!("Failed to canonicalize workdir: {err}"))
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
    let canonical = fs::canonicalize(&target).map_err(|_| format!("cwd does not exist: {raw}"))?;
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

fn spawn_shell_command(command: &str, cwd: &Path, log: File) -> Result<(Child, String), String> {
    let stderr = log
        .try_clone()
        .map_err(|err| format!("Failed to clone process log: {err}"))?;

    let spawn = |program: &str,
                 args: &[&str],
                 shell_name: &str|
     -> Result<(Child, String), std::io::Error> {
        let mut cmd = Command::new(program);
        cmd.args(args);
        configure_child_process_group(&mut cmd);
        maybe_augment_macos_path(&mut cmd);
        let child = cmd
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(stderr.try_clone()?))
            .spawn()?;
        Ok((child, shell_basename(shell_name)))
    };

    if cfg!(windows) {
        let pwsh_args = [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
        ];
        if let Ok(result) = spawn("pwsh", &pwsh_args, "pwsh") {
            return Ok(result);
        }
        let powershell_args = [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ];
        if let Ok(result) = spawn("powershell.exe", &powershell_args, "powershell") {
            return Ok(result);
        }
        let cmd_args = ["/D", "/S", "/C", command];
        spawn("cmd.exe", &cmd_args, "cmd").map_err(|err| format!("Failed to start process: {err}"))
    } else if cfg!(target_os = "macos") {
        let zsh_args = ["-lc", command];
        if let Ok(result) = spawn("zsh", &zsh_args, "zsh") {
            return Ok(result);
        }
        let bash_args = ["-lc", command];
        if let Ok(result) = spawn("bash", &bash_args, "bash") {
            return Ok(result);
        }
        let sh_args = ["-c", command];
        spawn("sh", &sh_args, "sh").map_err(|err| format!("Failed to start process: {err}"))
    } else {
        let bash_args = ["-lc", command];
        if let Ok(result) = spawn("bash", &bash_args, "bash") {
            return Ok(result);
        }
        let zsh_args = ["-lc", command];
        if let Ok(result) = spawn("zsh", &zsh_args, "zsh") {
            return Ok(result);
        }
        let sh_args = ["-c", command];
        spawn("sh", &sh_args, "sh").map_err(|err| format!("Failed to start process: {err}"))
    }
}

fn refresh_entry(entry: &mut ManagedProcessEntry) -> Result<(), String> {
    let Some(child) = entry.child.as_mut() else {
        return Ok(());
    };
    let Some(status) = child
        .try_wait()
        .map_err(|err| format!("Failed to poll process: {err}"))?
    else {
        return Ok(());
    };
    entry.exit_code = Some(status.code().unwrap_or(-1));
    entry.finished_at = Some(now_ms());
    entry.child = None;
    Ok(())
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
        running: entry.child.is_some(),
    }
}

impl ManagedProcessRegistry {
    pub fn start(
        &self,
        workdir: String,
        command: String,
        cwd: Option<String>,
        label: Option<String>,
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
        let (child, shell) = spawn_shell_command(&command, &cwd, log)?;
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
            child: Some(child),
        };
        let record = to_record(&entry);
        self.processes
            .lock()
            .expect("managed process registry poisoned")
            .insert(id, entry);
        Ok(ManagedProcessStartResponse { process: record })
    }

    pub fn status(&self, id: Option<String>) -> Result<ManagedProcessStatusResponse, String> {
        let id = id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let mut processes = self
            .processes
            .lock()
            .expect("managed process registry poisoned");
        let mut records = Vec::new();
        for entry in processes.values_mut() {
            refresh_entry(entry)?;
            if id.as_ref().is_some_and(|wanted| wanted != &entry.id) {
                continue;
            }
            records.push(to_record(entry));
        }
        records.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(ManagedProcessStatusResponse { processes: records })
    }

    pub fn stop(&self, id: String) -> Result<ManagedProcessStopResponse, String> {
        let id = id.trim();
        if id.is_empty() {
            return Err("process_id is required".to_string());
        }
        let mut processes = self
            .processes
            .lock()
            .expect("managed process registry poisoned");
        let Some(entry) = processes.get_mut(id) else {
            return Ok(ManagedProcessStopResponse {
                stopped: false,
                process: None,
            });
        };
        refresh_entry(entry)?;
        let mut stopped = false;
        if let Some(child) = entry.child.as_mut() {
            let status = terminate_child_process_tree(child, Duration::from_millis(STOP_GRACE_MS))
                .map_err(|err| format!("Failed to stop process: {err}"))?;
            entry.exit_code = Some(status.code().unwrap_or(-1));
            entry.finished_at = Some(now_ms());
            entry.child = None;
            stopped = true;
        }
        Ok(ManagedProcessStopResponse {
            stopped,
            process: Some(to_record(entry)),
        })
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
            let processes = self
                .processes
                .lock()
                .expect("managed process registry poisoned");
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

    fn wait_for_log_content(
        registry: &ManagedProcessRegistry,
        process_id: &str,
        expected: &str,
    ) -> ManagedProcessLogResponse {
        let mut last_log = registry
            .read_log(process_id.to_string(), Some(1024))
            .expect("log should be readable");
        for _ in 0..50 {
            if last_log.content.contains(expected) {
                return last_log;
            }
            std::thread::sleep(Duration::from_millis(20));
            last_log = registry
                .read_log(process_id.to_string(), Some(1024))
                .expect("log should be readable");
        }
        last_log
    }

    #[cfg(unix)]
    #[test]
    fn managed_process_runs_logs_and_stops() {
        let temp_dir = std::env::temp_dir().join(format!(
            "liveagent-managed-process-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&temp_dir).expect("temp dir should be created");

        let registry = ManagedProcessRegistry::default();
        let started = registry
            .start(
                temp_dir.display().to_string(),
                "printf 'ready\\n'; sleep 30".to_string(),
                None,
                Some("test process".to_string()),
            )
            .expect("process should start");
        let process_id = started.process.id.clone();

        let status = registry
            .status(Some(process_id.clone()))
            .expect("status should work");
        assert_eq!(status.processes.len(), 1);
        assert!(status.processes[0].running);

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
        let temp_dir = std::env::temp_dir().join(format!(
            "liveagent-managed-process-drop-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&temp_dir).expect("temp dir should be created");

        let pid = {
            let registry = ManagedProcessRegistry::default();
            let started = registry
                .start(
                    temp_dir.display().to_string(),
                    "sleep 30".to_string(),
                    None,
                    Some("drop test process".to_string()),
                )
                .expect("process should start");
            let pid = started.process.pid;
            assert!(process_exists(pid));
            pid
        };

        std::thread::sleep(Duration::from_millis(100));
        assert!(!process_exists(pid));

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
