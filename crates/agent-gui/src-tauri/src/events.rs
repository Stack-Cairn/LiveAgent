//! Event emission abstraction.
//!
//! Business services previously held a `tauri::AppHandle` solely to call
//! `app_handle.emit(...)`. That couples them to Tauri. This module defines a
//! minimal, object-safe `EventEmitter` trait so the same code can run in both
//! the desktop build (emits through the Tauri event system) and the headless
//! build (emits through a WebSocket broadcast, implemented in P1.2).
//!
//! The trait itself is generic-free (dyn-compatible); the ergonomic generic
//! [`EventEmitterExt::emit`] is provided as a blanket extension.

use std::sync::Arc;

use serde::Serialize;

/// A sink for frontend events. All events are one-way (fire-and-forget);
/// there is no listen side in Rust.
pub trait EventEmitter: Send + Sync {
    /// Emit a pre-serialized `event` payload to the frontend. Errors are
    /// surfaced as strings to keep the trait free of framework types.
    fn emit_json(&self, event: &str, payload: serde_json::Value) -> Result<(), String>;
}

/// Ergonomic generic wrapper over [`EventEmitter::emit_json`], mirroring the
/// `tauri::Emitter::emit` call sites (`emitter.emit(EVENT, payload)`).
pub trait EventEmitterExt {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String>;
}

impl<T: EventEmitter + ?Sized> EventEmitterExt for T {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String> {
        let value = serde_json::to_value(payload).map_err(|e| format!("serialize payload: {e}"))?;
        self.emit_json(event, value)
    }
}

/// Desktop implementation: forwards events to the Tauri event system.
#[cfg(feature = "desktop")]
pub struct TauriEventEmitter {
    app_handle: tauri::AppHandle,
}

#[cfg(feature = "desktop")]
impl TauriEventEmitter {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle }
    }
}

#[cfg(feature = "desktop")]
impl EventEmitter for TauriEventEmitter {
    fn emit_json(&self, event: &str, payload: serde_json::Value) -> Result<(), String> {
        use tauri::Emitter;
        self.app_handle
            .emit(event, payload)
            .map_err(|error| error.to_string())
    }
}

/// Headless implementation: emits through a WebSocket broadcast channel.
/// Wired up in P1.2 (`src/headless.rs`); until then it is a no-op stub so the
/// headless build compiles.
#[cfg(not(feature = "desktop"))]
#[derive(Clone, Default)]
pub struct WsEventEmitter {
    // TODO(P1.2): broadcast::Sender<EventPayload>
}

#[cfg(not(feature = "desktop"))]
impl EventEmitter for WsEventEmitter {
    fn emit_json(&self, _event: &str, _payload: serde_json::Value) -> Result<(), String> {
        Ok(())
    }
}

/// Helper to build the shared emitter used across services. On desktop it
/// wraps the app handle; on headless it wraps the WS broadcast.
#[cfg(feature = "desktop")]
pub fn shared_emitter(app_handle: tauri::AppHandle) -> Arc<dyn EventEmitter> {
    Arc::new(TauriEventEmitter::new(app_handle))
}

#[cfg(not(feature = "desktop"))]
pub fn shared_emitter() -> Arc<dyn EventEmitter> {
    Arc::new(WsEventEmitter::default())
}
