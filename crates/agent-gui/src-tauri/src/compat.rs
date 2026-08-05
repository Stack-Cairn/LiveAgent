#![cfg_attr(not(feature = "desktop"), allow(dead_code))]
//! Compatibility layer for code that previously called into
//! `tauri::async_runtime`. Tauri 2.x's async runtime is a thin wrapper
//! around tokio, so the headless (non-desktop) build can call tokio
//! directly with identical semantics.
//!
//! This module exists so business code never has to reference `tauri::`
//! (or tokio-specific runtime plumbing) directly, keeping the desktop and
//! headless builds on the same code path.

/// Drop-in replacement for `tauri::async_runtime`.
pub mod async_runtime {
    /// The handle returned by [`spawn`]. Equivalent to `tauri::async_runtime::JoinHandle`.
    pub use tokio::task::JoinHandle;

    /// Spawns a new async task. Equivalent to `crate::compat::async_runtime::spawn`
    /// (and `tokio::spawn`).
    pub use tokio::task::spawn;

    /// Spawns a blocking task on the blocking pool. Equivalent to
    /// `crate::compat::async_runtime::spawn_blocking` (and `tokio::task::spawn_blocking`).
    pub use tokio::task::spawn_blocking;

    /// Runs a future to completion on the current tokio runtime.
    /// Equivalent to `crate::compat::async_runtime::block_on`. Must be called from
    /// within a tokio runtime context (same constraint as tauri's version).
    pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Handle::current().block_on(future)
    }
}
