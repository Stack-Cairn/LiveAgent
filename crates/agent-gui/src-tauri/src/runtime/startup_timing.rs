//! Startup milestones on stderr (`[startup] ...`), measured from the start of `run()`, so the
//! launch sequence (setup, webview load, K-brain ready, frontend asks for K-brain, window
//! shown) can be read from the app log without a profiler.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

static LAUNCHED_AT: OnceLock<Instant> = OnceLock::new();

/// Marks the launch; the first call wins.
pub(crate) fn mark_launch() {
    LAUNCHED_AT.get_or_init(Instant::now);
}

pub(crate) fn since_launch_ms() -> u128 {
    LAUNCHED_AT.get_or_init(Instant::now).elapsed().as_millis()
}

/// Logs `milestone` once per process (later calls for the same flag are ignored).
pub(crate) fn log_once(flag: &AtomicBool, milestone: &str) {
    if !flag.swap(true, Ordering::SeqCst) {
        eprintln!("[startup] {milestone} at {} ms", since_launch_ms());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_once_only_logs_the_first_time() {
        let flag = AtomicBool::new(false);
        log_once(&flag, "test milestone");
        assert!(flag.load(Ordering::SeqCst));
        log_once(&flag, "test milestone");
        assert!(since_launch_ms() < 60_000);
    }
}
