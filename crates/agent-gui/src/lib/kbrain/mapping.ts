import { createUuid } from "@liveagent/ui/lib/shared/id";
import { getKBrainRuntimeConnection } from "./runtimeConnection";

const mappingKey = "kbrain-session-map:v1";
const legacyKeyPrefix = "kbrain-session:";

type MappingRecord = Record<string, string>;

type MappingState = {
  localToBackend: MappingRecord;
  backendToLocal: MappingRecord;
  legacyManagedStorageScope?: string;
};

let cachedStorage: Storage | undefined;
let cachedState: MappingState | undefined;
let cachedRaw: string | null = null;
let pendingWrite = false;
let batchDepth = 0;
const recentDeletedAliases = new Map<string, { id: string; expiresAt: number }>();
const MAX_DELETED_ALIASES = 10_000;

function pruneDeletedAliases() {
  const now = Date.now();
  for (const [key, value] of recentDeletedAliases) {
    if (value.expiresAt > now && recentDeletedAliases.size <= MAX_DELETED_ALIASES) break;
    recentDeletedAliases.delete(key);
  }
}

export function withKBrainMappingBatch<T>(operation: () => T): T {
  if (batchDepth === 0) readState();
  batchDepth += 1;
  try {
    return operation();
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0 && pendingWrite && cachedState) writeState(cachedState);
  }
}

export function kBrainStorageScope(baseUrl?: string) {
  const managed = getKBrainRuntimeConnection();
  const normalized = (baseUrl ?? managed?.baseUrl ?? "http://127.0.0.1:47321")
    .trim()
    .replace(/\/+$/, "");
  // The managed backend retains its storage identity across ephemeral ports.
  return managed && normalized === managed.baseUrl
    ? managed.storageId
      ? `liveagent-managed-kbrain:${managed.storageId}`
      : "liveagent-managed-kbrain"
    : normalized;
}

const normalizeBaseUrl = kBrainStorageScope;

function scopedKey(baseUrl: string, conversationId: string) {
  return `${normalizeBaseUrl(baseUrl)}\u0000${conversationId.trim()}`;
}

function readState(): MappingState {
  try {
    const storage = globalThis.localStorage;
    if (storage !== cachedStorage) {
      cachedStorage = storage;
      cachedState = undefined;
      pendingWrite = false;
      cachedRaw = null;
      recentDeletedAliases.clear();
    }
    if (batchDepth > 0 && cachedState) return cachedState;
    if (cachedState && pendingWrite) return cachedState;
    const raw = storage?.getItem(mappingKey) ?? null;
    if (cachedState && raw === cachedRaw) return cachedState;
    const parsed = raw ? (JSON.parse(raw) as Partial<MappingState>) : {};
    cachedRaw = raw;
    cachedState = {
      localToBackend:
        parsed.localToBackend && typeof parsed.localToBackend === "object"
          ? parsed.localToBackend
          : {},
      backendToLocal:
        parsed.backendToLocal && typeof parsed.backendToLocal === "object"
          ? parsed.backendToLocal
          : {},
      ...(typeof parsed.legacyManagedStorageScope === "string"
        ? { legacyManagedStorageScope: parsed.legacyManagedStorageScope }
        : {}),
    };
    return cachedState;
  } catch {
    cachedState ??= { localToBackend: {}, backendToLocal: {} };
    return cachedState;
  }
}

function writeState(state: MappingState) {
  cachedState = state;
  pendingWrite = true;
  if (batchDepth > 0) return;
  try {
    const raw = JSON.stringify(state);
    if (globalThis.localStorage) {
      globalThis.localStorage.setItem(mappingKey, raw);
      cachedRaw = raw;
      pendingWrite = false;
    }
  } catch {
    // Mapping is recoverable from the remote list; storage is optional.
  }
}

function readLegacyMapping(conversationId: string, baseUrl?: string) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const encodedBaseUrl = encodeURIComponent(normalizedBaseUrl);
  const encodedConversationId = encodeURIComponent(conversationId.trim());
  const prefix = `${legacyKeyPrefix}${encodedBaseUrl}:`;
  const suffix = `:${encodedConversationId}`;
  try {
    const storage = globalThis.localStorage;
    if (!storage) return undefined;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix) || !key.endsWith(suffix)) continue;
      const value = storage.getItem(key)?.trim();
      if (value) return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function getKBrainSessionId(conversationId: string, baseUrl?: string): string | undefined {
  const localId = conversationId.trim();
  if (!localId) return undefined;
  const state = readState();
  const scope = normalizeBaseUrl(baseUrl);
  const mapped = state.localToBackend[scopedKey(scope, localId)];
  if (mapped) return mapped;
  if (
    scope.startsWith("liveagent-managed-kbrain:") &&
    (!state.legacyManagedStorageScope || state.legacyManagedStorageScope === scope)
  ) {
    const previous = state.localToBackend[scopedKey("liveagent-managed-kbrain", localId)];
    if (previous) {
      state.legacyManagedStorageScope = scope;
      setKBrainSessionId(localId, previous, baseUrl);
      return previous;
    }
  }
  const legacy = readLegacyMapping(localId, baseUrl);
  if (legacy) {
    setKBrainSessionId(localId, legacy, baseUrl);
    return legacy;
  }
  return undefined;
}

export function setKBrainSessionId(
  conversationId: string,
  backendId: string,
  baseUrl?: string,
): string {
  const localId = conversationId.trim();
  const remoteId = backendId.trim();
  if (!localId || !remoteId)
    throw new Error("K-brain session mapping requires both local and backend IDs");
  const scope = normalizeBaseUrl(baseUrl);
  const state = readState();
  const localKey = scopedKey(scope, localId);
  const previousRemoteId = state.localToBackend[localKey];
  if (
    previousRemoteId === remoteId &&
    state.backendToLocal[scopedKey(scope, remoteId)] === localId
  ) {
    return remoteId;
  }
  if (previousRemoteId && state.backendToLocal[scopedKey(scope, previousRemoteId)] === localId) {
    delete state.backendToLocal[scopedKey(scope, previousRemoteId)];
  }
  const previousLocalId = state.backendToLocal[scopedKey(scope, remoteId)];
  if (previousLocalId && previousLocalId !== localId) {
    delete state.localToBackend[scopedKey(scope, previousLocalId)];
  }
  state.localToBackend[localKey] = remoteId;
  state.backendToLocal[scopedKey(scope, remoteId)] = localId;
  writeState(state);
  return remoteId;
}

export function getKBrainConversationId(backendId: string, baseUrl?: string): string | undefined {
  const remoteId = backendId.trim();
  if (!remoteId) return undefined;
  const state = readState();
  const scope = normalizeBaseUrl(baseUrl);
  const existing = state.backendToLocal[scopedKey(scope, remoteId)];
  if (existing) return existing;
  // The previous managed namespace had no data-root identity. Bind its
  // aliases to the first identified managed root, never to every later root.
  if (
    scope.startsWith("liveagent-managed-kbrain:") &&
    (!state.legacyManagedStorageScope || state.legacyManagedStorageScope === scope)
  ) {
    const legacy = state.backendToLocal[scopedKey("liveagent-managed-kbrain", remoteId)];
    if (legacy) {
      state.legacyManagedStorageScope = scope;
      setKBrainSessionId(legacy, remoteId, baseUrl);
      return legacy;
    }
  }
  return undefined;
}

export function ensureKBrainConversationId(backendId: string, baseUrl?: string): string {
  const existing = getKBrainConversationId(backendId, baseUrl);
  if (existing) return existing;
  pruneDeletedAliases();
  const key = scopedKey(normalizeBaseUrl(baseUrl), backendId);
  const id = recentDeletedAliases.get(key)?.id ?? createUuid();
  recentDeletedAliases.delete(key);
  setKBrainSessionId(id, backendId, baseUrl);
  return id;
}

export function clearKBrainSessionId(conversationId: string, baseUrl?: string): void {
  const localId = conversationId.trim();
  if (!localId) return;
  const scope = normalizeBaseUrl(baseUrl);
  const state = readState();
  const localKey = scopedKey(scope, localId);
  const remoteId = state.localToBackend[localKey];
  if (remoteId) {
    const key = scopedKey(scope, remoteId);
    recentDeletedAliases.delete(key);
    recentDeletedAliases.set(key, { id: localId, expiresAt: Date.now() + 86_400_000 });
    pruneDeletedAliases();
  }
  delete state.localToBackend[localKey];
  if (remoteId && state.backendToLocal[scopedKey(scope, remoteId)] === localId) {
    delete state.backendToLocal[scopedKey(scope, remoteId)];
  }
  if (remoteId && state.legacyManagedStorageScope === scope) {
    const legacyLocalKey = scopedKey("liveagent-managed-kbrain", localId);
    const legacyRemoteKey = scopedKey("liveagent-managed-kbrain", remoteId);
    if (state.localToBackend[legacyLocalKey] === remoteId)
      delete state.localToBackend[legacyLocalKey];
    if (state.backendToLocal[legacyRemoteKey] === localId)
      delete state.backendToLocal[legacyRemoteKey];
  }
  writeState(state);
}

export function listKBrainSessionMappings(
  baseUrl?: string,
): Array<{ conversationId: string; sessionId: string }> {
  const scope = normalizeBaseUrl(baseUrl);
  const prefix = `${scope}\u0000`;
  return Object.entries(readState().localToBackend)
    .filter(([key, sessionId]) => key.startsWith(prefix) && Boolean(sessionId))
    .map(([key, sessionId]) => ({ conversationId: key.slice(prefix.length), sessionId }));
}
