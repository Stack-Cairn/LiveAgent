/**
 * Same-interface transport bridge between the Tauri desktop runtime and the
 * headless server.
 *
 * The frontend imports invoke/listen/openUrl/etc. from this module instead of
 * `@tauri-apps/*` directly. At runtime it detects whether it is inside the
 * Tauri webview:
 *
 *   - Tauri runtime  -> delegates to the real `@tauri-apps` implementation
 *                      (dynamic import so the headless browser bundle never
 *                      touches Tauri code paths).
 *   - Plain browser  -> talks to the headless server over HTTP
 *                      (POST /api/invoke) and WebSocket (GET /ws), so the same
 *                      WebUI build can drive LiveAgent headless.
 *
 * The headless server URL is resolved from (in order):
 *   `import.meta.env.VITE_LIVEAGENT_HEADLESS_URL`
 *   `window.__LIVEAGENT_HEADLESS_URL__`
 *   `window.location.origin` (same-origin: WebUI served by the headless
 *   server itself on a single port)
 *   `http://127.0.0.1:17890`
 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow as tauriGetCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview as tauriGetCurrentWebview } from "@tauri-apps/api/webview";
import { homeDir as tauriHomeDir } from "@tauri-apps/api/path";

export { isTauri };

declare global {
  interface Window {
    __LIVEAGENT_HEADLESS_URL__?: string;
  }
}

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const runtimeWindow = window as Window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };
  return runtimeWindow.__TAURI__ !== undefined || runtimeWindow.__TAURI_INTERNALS__ !== undefined;
}

function isTauri(): boolean {
  return isTauriRuntime();
}

function resolveHeadlessBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_LIVEAGENT_HEADLESS_URL as string | undefined;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  if (typeof window !== "undefined" && window.__LIVEAGENT_HEADLESS_URL__) {
    return window.__LIVEAGENT_HEADLESS_URL__.replace(/\/+$/, "");
  }
  // Same-origin fallback: when the WebUI is served by the headless server
  // itself (single-port deployment), talk to the origin we were loaded from.
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "http://127.0.0.1:17890";
}

/**
 * invoke() with the same signature as `@tauri-apps/api/core` invoke().
 * In a headless browser it POSTs to the headless server and normalizes the
 * {ok, value|error} envelope back to Tauri-style promise semantics.
 */
export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauriRuntime()) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(cmd, args as never);
  }

  const response = await fetch(`${resolveHeadlessBaseUrl()}/api/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd, args: args ?? {} }),
  });
  if (!response.ok) {
    throw new Error(`headless invoke failed (HTTP ${response.status}) for command: ${cmd}`);
  }
  const body = (await response.json()) as { ok: boolean; value?: unknown; error?: string };
  if (!body.ok) {
    throw new Error(body.error ?? `command failed: ${cmd}`);
  }
  return body.value as T;
}

// ---------------------------------------------------------------------------
// Event transport: Tauri `listen` vs. headless WebSocket fan-out.
// The headless server emits WS text frames shaped { event, payload }.
// ---------------------------------------------------------------------------

type EventHandler = (event: { payload: unknown }) => void;

const wsListeners = new Map<string, Set<EventHandler>>();
let wsPromise: Promise<WebSocket> | null = null;

function connectHeadlessWebSocket(): Promise<WebSocket> {
  if (!wsPromise) {
    wsPromise = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`${resolveHeadlessBaseUrl().replace(/^http/, "ws")}/ws`);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => {
        wsPromise = null;
        reject(new Error("headless WebSocket connection failed"));
      };
      ws.onclose = () => {
        wsPromise = null;
        // Rejecting pending listeners is not possible after the fact; a later
        // listen() call will open a fresh socket.
      };
      ws.onmessage = (message) => {
        try {
          const frame = JSON.parse(message.data as string) as { event?: string; payload?: unknown };
          if (typeof frame.event !== "string") return;
          const handlers = wsListeners.get(frame.event);
          if (!handlers) return;
          for (const handler of [...handlers]) {
            handler({ payload: frame.payload });
          }
        } catch (error) {
          console.error("[headless] failed to parse WS event frame", error);
        }
      };
    });
  }
  return wsPromise;
}

/**
 * listen() with the same signature as `@tauri-apps/api/event` listen():
 * returns a promise of an unlisten function.
 */
export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    const { listen: tauriListen } = await import("@tauri-apps/api/event");
    return tauriListen<T>(event, handler);
  }

  await connectHeadlessWebSocket();
  let handlers = wsListeners.get(event);
  if (!handlers) {
    handlers = new Set<EventHandler>();
    wsListeners.set(event, handlers);
  }
  const wrapped = handler as EventHandler;
  handlers.add(wrapped);
  return () => {
    handlers?.delete(wrapped);
  };
}

// ---------------------------------------------------------------------------
// plugin-opener shim
// ---------------------------------------------------------------------------

export async function openUrl(url: string): Promise<void> {
  if (isTauriRuntime()) {
    const { openUrl: tauriOpenUrl } = await import("@tauri-apps/plugin-opener");
    return tauriOpenUrl(url);
  }
  // Browsers can open a new tab directly; no OS-level opener needed.
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function revealItemInDir(path: string): Promise<void> {
  if (isTauriRuntime()) {
    const { revealItemInDir: tauriReveal } = await import("@tauri-apps/plugin-opener");
    return tauriReveal(path);
  }
  console.warn("[headless] revealItemInDir is not supported; path:", path);
}

// ---------------------------------------------------------------------------
// Desktop-only API passthrough. Callers already guard with isTauri() before
// use (e.g. WindowsTitleBar, useTauriFileDrop), so these only touch the real
// implementation under the Tauri runtime. The static import is side-effect
// free; the modules expose plain functions and never read Tauri internals at
// import time, so shipping them in a headless browser bundle is safe.
// ---------------------------------------------------------------------------

export function getCurrentWindow(): ReturnType<typeof tauriGetCurrentWindow> {
  if (!isTauriRuntime()) {
    throw new Error("[headless] getCurrentWindow is only available in the Tauri runtime");
  }
  return tauriGetCurrentWindow();
}

export function getCurrentWebview(): ReturnType<typeof tauriGetCurrentWebview> {
  if (!isTauriRuntime()) {
    throw new Error("[headless] getCurrentWebview is only available in the Tauri runtime");
  }
  return tauriGetCurrentWebview();
}

export function homeDir(): Promise<string> {
  if (!isTauriRuntime()) {
    // The headless server resolves `~` itself inside the Rust fs commands, so the
    // browser-side home dir is only used for pre-expansion. Return empty.
    return Promise.resolve("");
  }
  return tauriHomeDir();
}
