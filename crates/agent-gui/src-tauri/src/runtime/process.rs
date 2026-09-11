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

/// 启动时间比对的容差：超出即认为这个 pid 已被别的进程复用，不能再对它发信号。
///
/// unix 侧 `ps -o etime=` 只有秒级精度，换算出来的启动时间必然有抖动，所以这里必须
/// 留出宽容度；windows 侧 `GetProcessTimes` 直接给出创建时间，精确到 100ns，同样的
/// 宽容度只是稍宽一点，不会漏判 pid 复用。**这个常量必须在所有平台都可见**——它被
/// 非 `cfg` 门控的 `terminate_process_tree_by_pid_if_same` 使用，只在 unix 下定义会让
/// windows 构建直接报 E0425（CI 的 Rust 检查只跑 Linux，发现不了）。
const PID_START_TIME_TOLERANCE_MS: i64 = 2_000;

/// 按 pid 终止进程树，但先确认这个 pid 仍是当初启动的那个进程。
///
/// 收尸线程会在子进程退出后立刻 `wait()` 掉它，此后 pid 可以被内核复用——
/// 对一个"已经不是我们子进程"的 pid 发 TERM/KILL 会误伤无辜。所以调用方在启动时
/// 记下 `started_at_ms`，这里先比对启动时间：进程已消失（被判 Dead）或启动时间
/// 对不上（pid 复用）时直接返回。
pub(crate) fn terminate_process_tree_by_pid_if_same(
    pid: u32,
    started_at_ms: Option<i64>,
    grace: Duration,
) {
    let Some(expected_started_at_ms) = started_at_ms else {
        // 启动时没探测到启动时间（`ps` 失败等）：退回旧的 pid-only 语义，
        // 与 managed_process 的既有取舍一致。
        terminate_process_tree_by_pid(pid, grace);
        return;
    };
    match probe_process_start_time(pid) {
        ProcessProbe::Dead => return,
        ProcessProbe::Alive {
            started_at_ms: actual,
        } if (actual - expected_started_at_ms).abs() > PID_START_TIME_TOLERANCE_MS => return,
        // Unknown（探测失败）沿用旧行为：保守发信号，宁可多杀一次进程组。
        ProcessProbe::Alive { .. } | ProcessProbe::Unknown => {}
    }
    terminate_process_tree_by_pid(pid, grace);
}

/// Spawn a fire-and-forget child and reap it on a detached thread.
///
/// `std::process::Child` 不实现 drop-reap：`spawn()` 之后把 Child 丢掉，子进程退出
/// 时没有人 `wait()`，它就会在本进程下挂成 `<defunct>`，直到本进程退出为止。
/// 系统启动器（`open` / `explorer.exe` / `xdg-open`）必须"不等它、但要收尸"——
/// 否则每次在 Finder/资源管理器中显示文件都漏一个僵尸，长会话里 PID 表持续增长。
///
/// 返回子进程 pid，供调用方记录与测试观察。
pub(crate) fn spawn_and_reap(command: &mut Command) -> io::Result<u32> {
    let child = command.spawn()?;
    let pid = child.id();
    spawn_child_reaper(child);
    Ok(pid)
}

/// 在分离线程里 `wait()` 掉一个不再需要句柄的子进程。
///
/// 线程创建失败（极端资源耗尽）时这个子进程会退化成未收尸——比在这里 panic
/// 或阻塞调用方都更可接受，且这是可观测的：它会在进程表里显示为 `<defunct>`。
pub(crate) fn spawn_child_reaper(mut child: Child) {
    let spawned = std::thread::Builder::new()
        .name("child-reaper".to_string())
        .spawn(move || {
            let _ = child.wait();
        });
    if let Err(error) = spawned {
        eprintln!("spawn child reaper failed (child may stay defunct): {error}");
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// `ps -o stat=` 的首字符（`Z` 即僵尸）；进程已消失时返回 None。
    #[cfg(test)]
    fn process_state_flag(pid: u32) -> Option<String> {
        let output = Command::new("ps")
            .arg("-p")
            .arg(pid.to_string())
            .arg("-o")
            .arg("stat=")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() { None } else { Some(text) }
    }

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

    #[test]
    fn detached_child_is_reaped_instead_of_left_defunct() {
        // 回归锁：`spawn()` 之后丢掉 Child 的写法会让子进程退出后一直挂在父进程下
        // 当 `<defunct>`（系统启动器每次调用漏一个）；收尸线程必须把它从进程表里清掉。
        // 旧实现下这个循环会一直读到 "Z"，最终 panic。
        let mut command = Command::new("true");
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let pid = spawn_and_reap(&mut command).expect("true should spawn");

        let mut zombies = Vec::new();
        for _ in 0..150 {
            match process_state_flag(pid) {
                // 已收尸：进程表里不再有这一项。
                None => return,
                Some(state) if !state.starts_with('Z') => return,
                Some(state) => zombies.push(state),
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("detached child stayed defunct for 3s: {zombies:?}");
    }
}
