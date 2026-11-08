import { useEffect, useSyncExternalStore } from "react";

/**
 * Desktop host bridge status (`host_bridge_status` command, `host-bridge:status` event).
 *
 * The desktop process serves `ReadTerminal` and `TunnelManager` to K-brain over a loopback
 * bridge it registers with `PUT /v1/host-bridge`. The webview only learns whether that
 * registration is live and which tools it carries; the bridge URL and token stay in Rust.
 */
export const HOST_BRIDGE_STATUS_COMMAND = "host_bridge_status";
export const HOST_BRIDGE_STATUS_EVENT = "host-bridge:status";
export const HOST_BRIDGE_TOOL_NAMES = ["ReadTerminal", "TunnelManager"] as const;

export type HostBridgeState = "disconnected" | "unsupported" | "registered" | "failed";

export type HostBridgeStatus = {
  state: HostBridgeState;
  /** Tools K-brain accepted from this desktop; empty unless registered. */
  tools: readonly string[];
};

/** How a bridge tool is doing, for the settings tool list. */
export type HostBridgeToolAvailability =
  | "available"
  /** Registered, but TunnelManager follows the Remote tunnels switch, which is off. */
  | "tunnels_off"
  /** The running K-brain predates the host bridge. */
  | "unsupported"
  | "unavailable";

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type ListenFn = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

const HOST_BRIDGE_STATES: ReadonlySet<string> = new Set([
  "disconnected",
  "unsupported",
  "registered",
  "failed",
]);

const DEFAULT_TIMEOUT_MS = 5_000;

export function parseHostBridgeStatus(value: unknown): HostBridgeStatus | null {
  if (!value || typeof value !== "object") return null;
  const { state, tools } = value as { state?: unknown; tools?: unknown };
  if (typeof state !== "string" || !HOST_BRIDGE_STATES.has(state)) return null;
  const toolNames =
    state === "registered" && Array.isArray(tools)
      ? tools.filter((tool): tool is string => typeof tool === "string" && tool.length > 0)
      : [];
  return { state: state as HostBridgeState, tools: toolNames };
}

export function isHostBridgeToolName(name: string): boolean {
  return (HOST_BRIDGE_TOOL_NAMES as readonly string[]).includes(name);
}

export function hostBridgeToolAvailability(
  status: HostBridgeStatus | null,
  toolName: string,
): HostBridgeToolAvailability | null {
  if (!status || !isHostBridgeToolName(toolName)) return null;
  if (status.state === "registered") {
    if (status.tools.includes(toolName)) return "available";
    return toolName === "TunnelManager" ? "tunnels_off" : "unavailable";
  }
  return status.state === "unsupported" ? "unsupported" : "unavailable";
}

// ---------------------------------------------------------------------------
// Store. `null` means the host has no bridge (WebUI, browser dev host) or it was never read.

let current: HostBridgeStatus | null = null;
const subscribers = new Set<() => void>();

function publish(next: HostBridgeStatus | null) {
  const same =
    next === current ||
    (next !== null &&
      current !== null &&
      next.state === current.state &&
      next.tools.length === current.tools.length &&
      next.tools.every((tool, index) => tool === current?.tools[index]));
  if (same) return;
  current = next;
  for (const subscriber of subscribers) subscriber();
}

export function getHostBridgeStatus(): HostBridgeStatus | null {
  return current;
}

export function subscribeHostBridgeStatus(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

/** Tools the desktop bridge currently provides to K-brain (empty when not registered). */
export function getHostBridgeTools(): ReadonlySet<string> {
  return new Set(current?.state === "registered" ? current.tools : []);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("host bridge status timed out")),
      Math.max(0, timeoutMs),
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Reads the bridge status from the desktop. With `refresh`, the desktop first re-sends its
 * registration to the running K-brain (after a connect or reconnect). Never throws: a host
 * without the command keeps `null`.
 */
export async function loadHostBridgeStatus(
  invokeFn: InvokeFn,
  options: { refresh?: boolean; timeoutMs?: number } = {},
): Promise<HostBridgeStatus | null> {
  try {
    const value = await withTimeout(
      invokeFn<unknown>(HOST_BRIDGE_STATUS_COMMAND, { refresh: options.refresh === true }),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const status = parseHostBridgeStatus(value);
    if (status) publish(status);
    return status ?? current;
  } catch {
    return current;
  }
}

let watching: Promise<void> | undefined;

/** Follows `host-bridge:status` events for the life of the page (idempotent). */
export function watchHostBridgeStatus(listenFn: ListenFn): Promise<void> {
  watching ??= listenFn<unknown>(HOST_BRIDGE_STATUS_EVENT, (event) => {
    const status = parseHostBridgeStatus(event.payload);
    if (status) publish(status);
  }).then(
    () => undefined,
    () => {
      watching = undefined;
    },
  );
  return watching;
}

/** Test hook. */
export function resetHostBridgeStatusForTests() {
  current = null;
  watching = undefined;
  subscribers.clear();
}

/** Current bridge status for UI; reads it once and follows its updates. */
export function useHostBridgeStatus(invokeFn: InvokeFn, listenFn: ListenFn) {
  useEffect(() => {
    void watchHostBridgeStatus(listenFn);
    void loadHostBridgeStatus(invokeFn);
  }, [invokeFn, listenFn]);
  return useSyncExternalStore(subscribeHostBridgeStatus, getHostBridgeStatus, () => null);
}
