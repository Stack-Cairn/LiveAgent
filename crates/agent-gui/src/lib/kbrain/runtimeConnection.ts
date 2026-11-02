import type { KBrainClientOptions } from "./types";

export type KBrainRuntimeConnection = {
  baseUrl: string;
  token: string;
  protocolVersion: "kbrain.agent.v1";
  /** Set only by the native manager bootstrap, never inferred from the URL. */
  managedLocal?: boolean;
  /** Native-manager identity of the persistent data root, independent of port/token. */
  storageId?: string;
};

let runtimeConnection: KBrainRuntimeConnection | null = null;
const connectionListeners = new Set<() => void>();

export function subscribeKBrainRuntimeConnection(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

function trim(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function getKBrainRuntimeConnection(): KBrainRuntimeConnection | null {
  return runtimeConnection;
}

export function setKBrainRuntimeConnection(connection: KBrainRuntimeConnection): void {
  if (connection.protocolVersion !== "kbrain.agent.v1" || !trim(connection.baseUrl)) {
    throw new Error("Malformed K-brain backend connection");
  }
  runtimeConnection = {
    baseUrl: connection.baseUrl.trim().replace(/\/+$/, ""),
    token: connection.token.trim(),
    protocolVersion: connection.protocolVersion,
    ...(connection.managedLocal ? { managedLocal: true } : {}),
    ...(connection.managedLocal && connection.storageId?.trim()
      ? { storageId: connection.storageId.trim() }
      : {}),
  };
  for (const listener of connectionListeners) listener();
}

export function clearKBrainRuntimeConnection(): void {
  runtimeConnection = null;
  for (const listener of connectionListeners) listener();
}

export function getConfiguredKBrainConnection(): KBrainRuntimeConnection | null {
  if (runtimeConnection) return runtimeConnection;
  const baseUrl = trim(import.meta.env?.VITE_KBRAIN_URL) ?? "http://127.0.0.1:47321";
  return {
    baseUrl,
    token: import.meta.env?.VITE_KBRAIN_TOKEN?.trim() ?? "",
    protocolVersion: "kbrain.agent.v1",
  };
}

export function resolveKBrainClientOptions(options: KBrainClientOptions = {}): KBrainClientOptions {
  const connection = getConfiguredKBrainConnection();
  const baseUrl = options.baseUrl ?? connection?.baseUrl;
  const sameEndpoint =
    baseUrl?.trim().replace(/\/+$/, "") === connection?.baseUrl.trim().replace(/\/+$/, "");
  return {
    ...options,
    baseUrl,
    token: options.token ?? (sameEndpoint ? connection?.token : undefined),
  };
}
