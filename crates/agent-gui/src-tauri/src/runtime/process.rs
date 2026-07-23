use std::io;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

#[cfg(unix)]
pub(crate) fn configure_child_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
pub(crate) fn configure_child_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn configure_child_process_group(_command: &mut Command) {}

#[cfg(unix)]
pub(crate) fn signal_process_tree_by_pid(pid: u32, force: bool) {
    let signal = if force { "-KILL" } else { "-TERM" };
    let process_group = format!("-{pid}");
    let _ = Command::new("kill")
        .arg(signal)
        .arg("--")
        .arg(process_group)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(windows)]
pub(crate) fn signal_process_tree_by_pid(pid: u32, _force: bool) {
    let mut command = Command::new("taskkill");
    configure_child_process_group(&mut command);
    let _ = command
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn signal_process_tree_by_pid(_pid: u32, _force: bool) {}

fn signal_child_process_tree(child: &Child, force: bool) {
    signal_process_tree_by_pid(child.id(), force);
}

pub(crate) fn terminate_child_process_tree(
    child: &mut Child,
    grace: Duration,
) -> io::Result<ExitStatus> {
    signal_child_process_tree(child, false);
    let grace_started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if grace_started.elapsed() >= grace {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    signal_child_process_tree(child, true);
    let _ = child.kill();
    child.wait()
}

pub(crate) fn kill_child_process_tree_best_effort(child: &mut Child) {
    signal_child_process_tree(child, true);
    let _ = child.kill();
    let _ = child.wait();
}

/// Terminates a process tree identified only by its group-leader pid (no
/// Child handle): TERM to the group, bounded grace while probing the leader,
/// then an unconditional KILL sweep so group members that outlived the
/// leader are still reaped.
pub(crate) fn terminate_process_tree_by_pid(pid: u32, grace: Duration) {
    signal_process_tree_by_pid(pid, false);
    let grace_started = Instant::now();
    while matches!(probe_process_start_time(pid), ProcessProbe::Alive { .. }) {
        if grace_started.elapsed() >= grace {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    signal_process_tree_by_pid(pid, true);
}

#[cfg(unix)]
fn unix_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64
}

/// Liveness probe outcome. `Unknown` (transient probe failure) is distinct
/// from `Dead` so callers never mistake a hiccup for an exit and, worse,
/// kill or forget a live process based on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessProbe {
    Alive { started_at_ms: i64 },
    Dead,
    Unknown,
}

pub(crate) fn process_start_time_ms(pid: u32) -> Option<i64> {
    match probe_process_start_time(pid) {
        ProcessProbe::Alive { started_at_ms } => Some(started_at_ms),
        ProcessProbe::Dead | ProcessProbe::Unknown => None,
    }
}

#[cfg(unix)]
pub(crate) fn probe_process_start_time(pid: u32) -> ProcessProbe {
    let output = Command::new("ps")
        .arg("-p")
        .arg(pid.to_string())
        .arg("-o")
        .arg("etime=")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Ok(output) = output else {
        return ProcessProbe::Unknown;
    };
    // ps exits non-zero (with empty output) when the pid does not exist.
    if !output.status.success() {
        return ProcessProbe::Dead;
    }
    let etime = String::from_utf8_lossy(&output.stdout);
    let etime = etime.trim();
    if etime.is_empty() {
        return ProcessProbe::Dead;
    }
    match parse_ps_etime_ms(etime) {
        Some(elapsed_ms) => ProcessProbe::Alive {
            started_at_ms: unix_now_ms() - elapsed_ms,
        },
        None => ProcessProbe::Unknown,
    }
}

/// Parses `ps -o etime` output shaped `[[dd-]hh:]mm:ss` into milliseconds.
#[cfg(unix)]
fn parse_ps_etime_ms(raw: &str) -> Option<i64> {
    let (days, clock) = match raw.split_once('-') {
        Some((days, clock)) => (days.trim().parse::<i64>().ok()?, clock),
        None => (0, raw),
    };
    let mut seconds = 0i64;
    for part in clock.split(':') {
        seconds = seconds * 60 + part.trim().parse::<i64>().ok()?;
    }
    Some((days * 24 * 60 * 60 + seconds) * 1000)
}

#[cfg(windows)]
pub(crate) fn probe_process_start_time(pid: u32) -> ProcessProbe {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const FILETIME_UNIX_EPOCH_OFFSET_100NS: i64 = 116_444_736_000_000_000;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return ProcessProbe::Dead;
        }
        let mut exit_code: u32 = 0;
        if GetExitCodeProcess(handle, &mut exit_code) == 0 {
            CloseHandle(handle);
            return ProcessProbe::Unknown;
        }
        if exit_code != STILL_ACTIVE as u32 {
            CloseHandle(handle);
            return ProcessProbe::Dead;
        }
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = creation;
        let mut kernel = creation;
        let mut user = creation;
        let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
        CloseHandle(handle);
        if !ok {
            return ProcessProbe::Unknown;
        }
        let filetime_100ns =
            ((creation.dwHighDateTime as i64) << 32) | creation.dwLowDateTime as i64;
        ProcessProbe::Alive {
            started_at_ms: (filetime_100ns - FILETIME_UNIX_EPOCH_OFFSET_100NS) / 10_000,
        }
    }
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn probe_process_start_time(_pid: u32) -> ProcessProbe {
    ProcessProbe::Unknown
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn parse_ps_etime_handles_all_shapes() {
        assert_eq!(parse_ps_etime_ms("05"), Some(5_000));
        assert_eq!(parse_ps_etime_ms("01:05"), Some(65_000));
        assert_eq!(parse_ps_etime_ms("02:01:05"), Some(7_265_000));
        assert_eq!(
            parse_ps_etime_ms("3-02:01:05"),
            Some(3 * 24 * 60 * 60 * 1000 + 7_265_000)
        );
        assert_eq!(parse_ps_etime_ms(""), None);
        assert_eq!(parse_ps_etime_ms("abc"), None);
    }

    #[test]
    fn process_start_time_probes_liveness() {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("sleep should spawn");
        let pid = child.id();
        let started = process_start_time_ms(pid).expect("live process should report start time");
        let drift = (unix_now_ms() - started).abs();
        assert!(drift < 60_000, "start time drifted {drift}ms");
        let _ = child.kill();
        let _ = child.wait();
        // Reaped child must eventually read as gone.
        let mut gone = false;
        for _ in 0..50 {
            if process_start_time_ms(pid).is_none() {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(gone, "killed process still probes alive");
    }
}
