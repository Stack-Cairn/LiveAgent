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
import { homeDir as tauriHomeDir } from "@tauri-apps/api/path";
import { getCurrentWebview as tauriGetCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow as tauriGetCurrentWindow } from "@tauri-apps/api/window";

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

export function resolveHeadlessBaseUrl(): string {
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
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime()) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(cmd, args as never);
  }

  // Headless browser has no native folder picker. `system_pick_folder` is used
  // both by "打开本地文件夹" (open workspace folder) and the clone modal's
  // "选择文件夹" (choose parent dir). Instead of silently returning the
  // initial workdir (the previous headless behavior, which made the modal just
  // close with no visible result), open the HeadlessFolderPicker directory
  // browser (breadcrumbs + listing + quick locations) so the user can navigate
  // the server's filesystem instead of typing an absolute path by hand.
  // Dynamically imported to avoid a static import cycle (HeadlessFolderPicker
  // → fsBackend → shims/tauriCore → this module).
  if (cmd === "system_pick_folder") {
    const initial = typeof args?.initial_workdir === "string" ? args.initial_workdir : "";
    const { openFolderPicker } = await import("../pages/chat/workspace/HeadlessFolderPicker");
    return (await openFolderPicker({ initialPath: initial })) as T;
  }

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(`${resolveHeadlessBaseUrl()}/api/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd, args: args ?? {} }),
    });
    if (response.status === 429) {
      if (attempt < maxRetries) {
        // Exponential backoff: 500ms, 1500ms
        const delay = 500 * (attempt + 1);
        console.warn(
          `[headless] invoke ${cmd} got 429, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
    if (!response.ok) {
      throw new Error(`headless invoke failed (HTTP ${response.status}) for command: ${cmd}`);
    }
    const body = (await response.json()) as { ok: boolean; value?: unknown; error?: string };
    if (!body.ok) {
      throw new Error(body.error ?? `command failed: ${cmd}`);
    }
    return body.value as T;
  }
  throw new Error(`headless invoke failed after retries for command: ${cmd}`);
}

// ---------------------------------------------------------------------------
// Event transport: Tauri `listen` vs. headless WebSocket fan-out.
// The headless server emits WS text frames shaped { event, payload }.
// ---------------------------------------------------------------------------

type EventHandler = (event: { payload: unknown }) => void;

const wsListeners = new Map<string, Set<EventHandler>>();

// Exponential-backoff reconnect for the headless WebSocket fan-out. When the
// connection drops (server restart, network hiccup, or the server closing a
// slow client due to backpressure), the socket is re-established automatically
// so already-registered listeners keep receiving events without re-subscribing.
const RECONNECT_INITIAL_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10_000;

let ws: WebSocket | null = null;
let wsConnectionPromise: Promise<WebSocket> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
let reconnectAttempts = 0;

function hasListeners(): boolean {
  for (const handlers of wsListeners.values()) {
    if (handlers.size > 0) return true;
  }
  return false;
}

/** Drop the socket and any pending reconnect. Called when the last listener unsubscribes. */
function teardownHeadlessSocket(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws !== null) {
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // already closing/closed
    }
    ws = null;
  }
  wsConnectionPromise = null;
  reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
  reconnectAttempts = 0;
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
  reconnectAttempts += 1;
  console.warn(
    `[headless] WebSocket lost; reconnecting in ${delay}ms (attempt ${reconnectAttempts})`,
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Fire-and-forget: on failure onclose schedules the next attempt.
    void connectHeadlessWebSocket().catch(() => {
      /* handled by scheduleReconnect */
    });
  }, delay);
}

function connectHeadlessWebSocket(): Promise<WebSocket> {
  if (ws !== null && ws.readyState === WebSocket.OPEN) {
    return Promise.resolve(ws);
  }
  if (wsConnectionPromise) {
    return wsConnectionPromise;
  }

  wsConnectionPromise = new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`${resolveHeadlessBaseUrl().replace(/^http/, "ws")}/ws`);
    ws = socket;

    socket.onopen = () => {
      reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
      reconnectAttempts = 0;
      console.info("[headless] WebSocket connected");
      resolve(socket);
    };

    socket.onerror = () => {
      console.warn("[headless] WebSocket error (close will follow)");
    };

    socket.onclose = (event) => {
      if (ws === socket) ws = null;
      wsConnectionPromise = null;
      // Rejecting a promise that already resolved (connected then dropped) is a
      // no-op; for a failed first connect it surfaces the error to listen().
      reject(
        new Error(
          `headless WebSocket closed (code ${event.code}${event.reason ? `: ${event.reason}` : ""})`,
        ),
      );
      scheduleReconnect();
    };

    socket.onmessage = (message) => {
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

  return wsConnectionPromise;
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
    if (!hasListeners()) teardownHeadlessSocket();
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
