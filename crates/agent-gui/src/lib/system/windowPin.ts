import { invoke } from "@liveagent/app/shims/tauriCore";

/** Toggles always-on-top; Rust owns the state and broadcasts `global-shortcut:pin-changed`. */
export function toggleDesktopWindowPin() {
  void invoke("app_toggle_window_pin").catch(() => {
    // Not running inside the desktop shell: nothing to toggle.
  });
}
