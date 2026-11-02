import { readKBrainHealthResponse } from "@liveagent/ui/lib/kbrain/health";
import { invoke } from "@tauri-apps/api/core";
import { isTauriHost } from "../host";
import {
  clearKBrainRuntimeConnection,
  getConfiguredKBrainConnection,
  type KBrainRuntimeConnection,
  setKBrainRuntimeConnection,
} from "./runtimeConnection";

export type KBrainBootstrapState =
  | { status: "ready"; connection: KBrainRuntimeConnection }
  | { status: "error"; error: Error };

export type KBrainBootstrapOptions = {
  retries?: number;
  delayMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
};

type BootstrapInvoke = typeof invoke;

const DEFAULT_BROWSER_BOOTSTRAP_TIMEOUT_MS = 5_000;
const DEFAULT_DESKTOP_BOOTSTRAP_TIMEOUT_MS = 20_000;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("K-brain bootstrap cancelled");
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  onTimeout?: (error: Error) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const settle = (settlePromise: typeof resolve | typeof reject, value: T | unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      settlePromise(value as never);
    };
    const abort = () => {
      settle(
        reject,
        signal?.reason instanceof Error ? signal.reason : new Error("K-brain bootstrap cancelled"),
      );
    };

    promise.then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
    if (signal?.aborted) {
      abort();
      return;
    }

    timer = setTimeout(
      () => {
        const error = new Error("K-brain backend health check timed out");
        settle(reject, error);
        onTimeout?.(error);
      },
      Math.max(0, timeoutMs),
    );
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function verifyBrowserHealth(
  connection: KBrainRuntimeConnection,
  options: KBrainBootstrapOptions,
): Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  throwIfAborted(options.signal);
  const requestController = new AbortController();
  const abortRequest = () => {
    requestController.abort(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("K-brain bootstrap cancelled"),
    );
  };
  options.signal?.addEventListener("abort", abortRequest, { once: true });
  const healthRequest = (async () => {
    const response = await fetchImpl(`${connection.baseUrl}/v1/health`, {
      headers: {
        Accept: "application/json",
        ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}),
      },
      signal: requestController.signal,
    });
    if (!response.ok) throw new Error(`K-brain backend health check failed (${response.status})`);
    return readKBrainHealthResponse(response);
  })();
  try {
    await withTimeout(
      healthRequest,
      options.timeoutMs ?? DEFAULT_BROWSER_BOOTSTRAP_TIMEOUT_MS,
      options.signal,
      (error) => requestController.abort(error),
    );
  } finally {
    options.signal?.removeEventListener("abort", abortRequest);
  }
}

export function createKBrainBootstrapRunner(start: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | undefined;
  return () => {
    if (!active) {
      active = Promise.resolve()
        .then(start)
        .finally(() => {
          active = undefined;
        });
    }
    return active;
  };
}

export function shouldBootstrapKBrain(): boolean {
  return true;
}

export async function connectKBrainBackend(
  invokeFn: BootstrapInvoke = invoke,
  options: KBrainBootstrapOptions = {},
): Promise<KBrainRuntimeConnection> {
  throwIfAborted(options.signal);
  if (!isTauriHost()) {
    const connection: KBrainRuntimeConnection = getConfiguredKBrainConnection() ?? {
      baseUrl: (import.meta.env?.VITE_KBRAIN_URL?.trim() || "http://127.0.0.1:47321").replace(
        /\/+$/,
        "",
      ),
      token: import.meta.env?.VITE_KBRAIN_TOKEN?.trim() ?? "",
      protocolVersion: "kbrain.agent.v1",
    };
    await verifyBrowserHealth(connection, options);
    setKBrainRuntimeConnection(connection);
    return getConfiguredKBrainConnection() as KBrainRuntimeConnection;
  }
  const connection = await withTimeout(
    invokeFn<KBrainRuntimeConnection>("kbrain_backend_connection"),
    options.timeoutMs ?? DEFAULT_DESKTOP_BOOTSTRAP_TIMEOUT_MS,
    options.signal,
  );
  setKBrainRuntimeConnection({ ...connection, managedLocal: true });
  return getConfiguredKBrainConnection() as KBrainRuntimeConnection;
}

export async function notifyFrontendReady(invokeFn: BootstrapInvoke = invoke): Promise<void> {
  if (!isTauriHost()) return;
  await invokeFn("app_frontend_ready");
}

export function resetKBrainBackendConnection(): void {
  clearKBrainRuntimeConnection();
}

export async function connectKBrainBackendWithRetry(
  invokeFn: BootstrapInvoke = invoke,
  options: KBrainBootstrapOptions = {},
): Promise<KBrainRuntimeConnection> {
  const retries = Math.max(0, options.retries ?? 2);
  const delayMs = Math.max(0, options.delayMs ?? 250);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await connectKBrainBackend(invokeFn, options);
    } catch (error) {
      lastError = error;
      resetKBrainBackendConnection();
      if (options.signal?.aborted) throw asError(error);
      if (attempt < retries && delayMs > 0) {
        await withTimeout(
          new Promise((resolve) => setTimeout(resolve, delayMs)),
          delayMs + 1,
          options.signal,
        );
      }
    }
  }
  throw asError(lastError);
}
