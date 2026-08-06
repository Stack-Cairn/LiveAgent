/**
 * Web-side implementation of the tauriBridge interface.
 *
 * Mirrored GUI components import invoke/listen/openUrl/etc. from `lib/tauriBridge`
 * (instead of `@tauri-apps/*` directly). On the desktop side that module lives at
 * crates/agent-gui/src/lib/tauriBridge.ts and dispatches to the real Tauri runtime
 * or the headless HTTP transport. On the gateway WebUI side this module delegates
 * to the existing shims (shims/tauriCore, shims/tauriEvent, shims/tauriOpener),
 * which speak the gateway WebSocket protocol — preserving the exact runtime
 * behaviour the mirrored components had before (they previously imported
 * `@tauri-apps/api/core`, which vite aliases to those shims).
 *
 * isTauri() always returns false here: the gateway WebUI never runs inside a
 * Tauri webview.
 */

import { invoke as gatewayInvoke } from "../shims/tauriCore";
import { listen as gatewayListen } from "../shims/tauriEvent";
import { openUrl as gatewayOpenUrl } from "../shims/tauriOpener";

export function isTauri(): boolean {
  return false;
}

export type UnlistenFn = () => void;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return gatewayInvoke<T>(cmd, args);
}

export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  return gatewayListen<T>(event, handler);
}

export async function openUrl(url: string): Promise<void> {
  return gatewayOpenUrl(url);
}

export async function revealItemInDir(path: string): Promise<void> {
  console.warn("[web] revealItemInDir is not supported; path:", path);
}

// Desktop-only API passthrough. Mirrored callers guard with isTauri() before
// use, so these never execute in the browser build; the return types only need
// to keep TypeScript happy for code that is unreachable here.
export function getCurrentWindow(): Window {
  throw new Error("[web] getCurrentWindow is only available in the Tauri runtime");
}

export function getCurrentWebview(): Window {
  throw new Error("[web] getCurrentWebview is only available in the Tauri runtime");
}

export function homeDir(): Promise<string> {
  // The gateway resolves `~` itself on the backend; browsers have no home dir.
  return Promise.resolve("");
}
