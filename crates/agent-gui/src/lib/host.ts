export type LiveAgentHost = "tauri" | "browser";

type TauriWindow = Window & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

export function isTauriHost(): boolean {
  if (typeof window === "undefined") return false;
  const runtimeWindow = window as TauriWindow;
  return runtimeWindow.__TAURI__ !== undefined || runtimeWindow.__TAURI_INTERNALS__ !== undefined;
}

export function isKBrainBackendEnabled(): boolean {
  return true;
}

export function isKBrainBrowserHost(): boolean {
  return isKBrainBackendEnabled() && !isTauriHost();
}

export function liveAgentRuntimeCapabilities() {
  const desktopRuntime = !isKBrainBackendEnabled();
  return {
    frontendContext: desktopRuntime,
    // The desktop mirrors its own runs (K-brain ones included) to a paired Gateway so a
    // WebUI can watch them and answer their approvals; whether a Gateway is paired is
    // decided per run from the remote settings.
    gatewayMirror: isTauriHost(),
    checkpoints: desktopRuntime,
    trajectory: desktopRuntime,
  };
}

export function currentLiveAgentHost(): LiveAgentHost {
  return isTauriHost() ? "tauri" : "browser";
}

export function kBrainOwnedDesktopCommand(command: string): boolean {
  return (
    /^(memory_|checkpoint_|gateway_|hook_|chat_history_|subagent_|trajectory_|cua_driver_|browser_)/.test(
      command,
    ) || /^system_(ensure_builtin_skills|read_skill_|manage_skill)/.test(command)
  );
}
