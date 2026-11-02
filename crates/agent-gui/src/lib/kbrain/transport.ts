import { isTauriHost } from "../host";
import { connectKBrainBackend } from "./bootstrap";
import { getConfiguredKBrainConnection, resolveKBrainClientOptions } from "./runtimeConnection";
import type { KBrainClientOptions } from "./types";

let reconnect: ReturnType<typeof connectKBrainBackend> | undefined;

export class KBrainTransportError extends Error {
  readonly code = "KBRAIN_TRANSPORT_UNAVAILABLE";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "K-brain connection unavailable", { cause });
    this.name = "KBrainTransportError";
  }
}

function waitForConnection<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function refreshConnection() {
  reconnect ??= connectKBrainBackend().finally(() => {
    reconnect = undefined;
  });
  return reconnect;
}

export async function fetchKBrain(
  path: string,
  init: RequestInit = {},
  input: KBrainClientOptions = {},
  retryRead = false,
): Promise<Response> {
  init.signal?.throwIfAborted();
  const managed = input.baseUrl === undefined && input.token === undefined && !input.fetch;
  const options = resolveKBrainClientOptions(input);
  const baseUrl = options.baseUrl?.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("K-brain backend connection is not ready");
  const send = (url: string, token?: string) => {
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (typeof init.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (token?.trim()) headers.set("Authorization", `Bearer ${token.trim()}`);
    return (input.fetch ?? globalThis.fetch)(`${url}${path}`, { ...init, headers });
  };
  let response: Response | undefined;
  let failure: unknown;
  try {
    response = await send(baseUrl, options.token);
    if (response.status !== 401) return response;
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason;
    failure = new KBrainTransportError(error);
  }
  if (!managed || !isTauriHost() || init.signal?.aborted) {
    if (response) return response;
    throw failure;
  }
  let connection = getConfiguredKBrainConnection();
  if (connection?.baseUrl === baseUrl && connection.token === options.token) {
    try {
      connection = await waitForConnection(refreshConnection(), init.signal);
    } catch {
      if (init.signal?.aborted) throw init.signal.reason;
      if (response) return response;
      throw failure;
    }
  }
  if (init.signal?.aborted) throw init.signal.reason;
  const safeToRetry = retryRead || ["GET", "HEAD"].includes(init.method ?? "GET");
  // A failed write may already have committed. Refresh its connection without replaying it.
  if (!safeToRetry || !connection) {
    if (response) return response;
    throw failure;
  }
  await response?.body?.cancel();
  try {
    return await send(connection.baseUrl, connection.token);
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason;
    throw new KBrainTransportError(error);
  }
}
