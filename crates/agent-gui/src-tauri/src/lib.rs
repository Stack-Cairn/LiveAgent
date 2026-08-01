// Headless build (`--no-default-features`) currently has only a stub entry
// point, so business code is not yet reachable from it. PR-E (axum server +
// WS command router) wires these up; until then allow dead code in the
// headless build only.
#![cfg_attr(not(feature = "desktop"), allow(dead_code))]

mod app_context;
mod commands;
mod compat;
mod events;
mod runtime;
mod services;
// Desktop-only Tauri runtime. Compiled only when the `desktop` feature is on
// (the default). The headless build (`--no-default-features`) skips it and
// uses the stub `run()` below.
#[cfg(feature = "desktop")]
mod desktop;

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
/// code as the desktop build, but served over an axum HTTP/WebSocket bridge
/// instead of a Tauri window. The server lands in P1.2 PR-E; until then the
/// headless runtime has nothing to run, so this is a no-op stub.
#[cfg(not(feature = "desktop"))]
pub fn run() {
    eprintln!("LiveAgent headless runtime is not implemented yet (lands in PR-E).");
}
