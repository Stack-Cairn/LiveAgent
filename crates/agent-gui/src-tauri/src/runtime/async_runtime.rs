//! Tokio runtime shared with Tauri through `tauri::async_runtime`.

use std::sync::OnceLock;

/// Stack reserved for every async worker and blocking-pool thread.
///
/// Unoptimized builds give every temporary of an `async fn` its own stack slot
/// across all branches, so the poll frame of
/// `GatewayController::handle_gateway_envelope` alone is about 1.5 MiB in a
/// debug build (about 23 KiB in release). With Tokio's 2 MiB default, a WebUI
/// `chat.submit` that descends into the chat handlers overflows the worker.
/// The size is a reservation; pages are committed only when touched.
pub(crate) const ASYNC_WORKER_STACK_BYTES: usize = 8 * 1024 * 1024;

static ASYNC_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

pub(crate) fn build_async_runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(ASYNC_WORKER_STACK_BYTES)
        .build()
}

/// Must run before anything touches `tauri::async_runtime`; otherwise Tauri
/// lazily builds its own runtime with the 2 MiB default stack.
pub(crate) fn install_tauri_async_runtime() {
    let runtime = ASYNC_RUNTIME.get_or_init(|| {
        build_async_runtime().expect("failed to initialize LiveAgent async runtime")
    });
    tauri::async_runtime::set(runtime.handle().clone());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::hint::black_box;

    const FRAME_BYTES: usize = 64 * 1024;
    // 4 MiB: past Tokio's 2 MiB default, well inside the configured size.
    const DEPTH: usize = 64;

    #[inline(never)]
    fn consume_stack(depth: usize) -> u8 {
        let mut frame = [0_u8; FRAME_BYTES];
        frame[depth % FRAME_BYTES] = depth as u8;
        black_box(&mut frame);
        if depth == 0 {
            return frame[0];
        }
        consume_stack(depth - 1).wrapping_add(frame[depth % FRAME_BYTES])
    }

    #[test]
    fn async_workers_run_deeper_than_tokio_default_stack() {
        assert!(ASYNC_WORKER_STACK_BYTES >= DEPTH * FRAME_BYTES * 2);
        let runtime = build_async_runtime().expect("build async runtime");
        let value = runtime
            .block_on(async { tokio::spawn(async { consume_stack(DEPTH) }).await })
            .expect("deep task should finish on a worker thread");
        assert_eq!(value, consume_stack_expected());
    }

    #[test]
    fn blocking_pool_runs_deeper_than_tokio_default_stack() {
        let runtime = build_async_runtime().expect("build async runtime");
        let value = runtime
            .block_on(async { tokio::task::spawn_blocking(|| consume_stack(DEPTH)).await })
            .expect("deep blocking task should finish");
        assert_eq!(value, consume_stack_expected());
    }

    fn consume_stack_expected() -> u8 {
        (0..=DEPTH).fold(0_u8, |sum, depth| sum.wrapping_add(depth as u8))
    }
}
