// Headless build (`--no-default-features`) runs the same business code over
// an axum HTTP/WebSocket bridge instead of a Tauri window. A small amount of
// dead code allowance is kept while the headless surface stabilizes.
#![cfg_attr(not(feature = "desktop"), allow(dead_code))]

mod app_context;
mod commands;
mod compat;
mod events;
mod runtime;
mod services;
// Desktop-only Tauri runtime. Compiled only when the `desktop` feature is on
// (the default). The headless build (`--no-default-features`) skips it and
// uses the axum server in `headless`.
#[cfg(feature = "desktop")]
mod desktop;
// Headless-only axum HTTP/WebSocket runtime. Compiled only when the `desktop`
// feature is off.
#[cfg(not(feature = "desktop"))]
mod headless;

pub fn app_version() -> &'static str {
    env!("LIVEAGENT_APP_VERSION")
}

/// `WINDOW_STATE_FLAGS` lives in `desktop` (it references Tauri types); keep
/// the `crate::WINDOW_STATE_FLAGS` path used by `commands::app::update`.
#[cfg(feature = "desktop")]
pub(crate) use desktop::WINDOW_STATE_FLAGS;

/// Desktop entry point: full Tauri runtime (window, tray, shortcuts...).
#[cfg(feature = "desktop")]
pub use desktop::run;

/// Headless entry point (built with `--no-default-features`): same business
/// code as the desktop build, served over an axum HTTP/WebSocket bridge
/// (`/health`, `/api/invoke`, `/ws`) on `LIVEAGENT_HEADLESS_PORT` (default
/// 17890). See `src/headless.rs`.
#[cfg(not(feature = "desktop"))]
pub fn run() {
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(error) => {
            eprintln!("failed to start tokio runtime: {error}");
            std::process::exit(1);
        }
    };
    if let Err(error) = rt.block_on(crate::headless::serve()) {
        eprintln!("headless server error: {error}");
        std::process::exit(1);
    }
}
