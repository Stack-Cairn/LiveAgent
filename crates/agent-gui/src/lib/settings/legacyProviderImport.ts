import type { CustomProvider } from "@liveagent/ui/lib/settings/types";
import { kBrainStorageScope } from "../kbrain/mapping";
import { getConfiguredKBrainConnection } from "../kbrain/runtimeConnection";

/**
 * Remembers legacy providers K-brain rejected during import, so a provider that can never be
 * imported as-is is not re-submitted on every launch (each attempt costs a 400 and a warning).
 *
 * A record is keyed by provider id and stores a fingerprint of the provider config. When the
 * user edits that provider (different fingerprint) it becomes eligible for import again.
 */
export const LEGACY_PROVIDER_IMPORT_STORAGE_KEY = "liveagent.kbrain-legacy-provider-import.v2";
/**
 * Rejections the user chose to ignore from the settings banner. Dismissal is permanent: a
 * dismissed record (same provider id and config fingerprint) is never shown again, and the
 * "retry import" action does not resurrect it.
 */
export const LEGACY_PROVIDER_IMPORT_DISMISSED_STORAGE_KEY =
  "liveagent.kbrain-legacy-provider-import-dismissed.v1";

/**
 * Legacy provider ids that already reached K-brain once. The legacy store (config.sqlite
 * `provider_settings`) is never pruned when the user deletes a provider in K-brain, so without
 * this record every launch saw a deleted provider as "not migrated yet" and imported it again.
 * An id in this set that is missing from K-brain was removed by the user and stays removed.
 */
export const LEGACY_PROVIDER_IMPORTED_STORAGE_KEY = "liveagent.kbrain-legacy-provider-imported.v1";

function scopedStorageKey(key: string): string {
  return `${key}:${kBrainStorageScope(getConfiguredKBrainConnection()?.baseUrl)}`;
}

export function isPermanentLegacyProviderRejection(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 400 || status === 409 || status === 413 || status === 422;
}

export type RejectedLegacyProvider = {
  id: string;
  name: string;
  fingerprint: string;
  reason: string;
  rejectedAt: number;
};

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Stable fingerprint of the parts of a provider that decide whether K-brain accepts it. */
export function legacyProviderFingerprint(provider: CustomProvider): string {
  const models = [...(provider.models ?? [])]
    .map((model) => JSON.stringify(model))
    .sort()
    .join("|");
  const source = [provider.type, provider.baseUrl, provider.isFullUrl ? "1" : "0", models].join(
    "\u0000",
  );
  // FNV-1a 32-bit: enough to detect edits, no crypto requirement.
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function readRejectedLegacyProviders(
  storage: Storage | null = defaultStorage(),
): RejectedLegacyProvider[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(scopedStorageKey(LEGACY_PROVIDER_IMPORT_STORAGE_KEY));
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RejectedLegacyProvider =>
        !!entry &&
        typeof entry.id === "string" &&
        typeof entry.fingerprint === "string" &&
        typeof entry.reason === "string",
    );
  } catch {
    return [];
  }
}

export function writeRejectedLegacyProviders(
  entries: readonly RejectedLegacyProvider[],
  storage: Storage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(scopedStorageKey(LEGACY_PROVIDER_IMPORT_STORAGE_KEY), JSON.stringify(entries));
  } catch {
    // Storage is a best-effort cache; failing to persist only means one more retry next launch.
  }
}

/** Legacy providers still worth submitting: not previously rejected with the same config. */
export function legacyProvidersToImport(
  missing: readonly CustomProvider[],
  rejected: readonly RejectedLegacyProvider[],
): CustomProvider[] {
  const known = new Map(rejected.map((entry) => [entry.id, entry.fingerprint]));
  return missing.filter(
    (provider) => known.get(provider.id) !== legacyProviderFingerprint(provider),
  );
}

/**
 * Next rejection list: keep records still relevant (provider still missing from K-brain),
 * add/refresh the ones rejected in this attempt, drop the ones that were imported or removed.
 */
export function nextRejectedLegacyProviders(
  previous: readonly RejectedLegacyProvider[],
  stillMissing: readonly CustomProvider[],
  rejectedNow: readonly { provider: CustomProvider; reason: string }[],
  now: number = Date.now(),
): RejectedLegacyProvider[] {
  const missingIds = new Set(stillMissing.map((provider) => provider.id));
  const byId = new Map<string, RejectedLegacyProvider>();
  for (const entry of previous) {
    if (missingIds.has(entry.id)) byId.set(entry.id, entry);
  }
  for (const { provider, reason } of rejectedNow) {
    byId.set(provider.id, {
      id: provider.id,
      name: provider.name || provider.id,
      fingerprint: legacyProviderFingerprint(provider),
      reason,
      rejectedAt: now,
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function dismissalKey(entry: Pick<RejectedLegacyProvider, "id" | "fingerprint">): string {
  return `${entry.id}:${entry.fingerprint}`;
}

export function readDismissedLegacyProviderKeys(
  storage: Storage | null = defaultStorage(),
): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(scopedStorageKey(LEGACY_PROVIDER_IMPORT_DISMISSED_STORAGE_KEY));
    const parsed = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

/** Rejections still worth showing: everything the user has not dismissed. */
export function visibleRejectedLegacyProviders(
  entries: readonly RejectedLegacyProvider[],
  dismissed: ReadonlySet<string>,
): RejectedLegacyProvider[] {
  return entries.filter((entry) => !dismissed.has(dismissalKey(entry)));
}

type Listener = (entries: RejectedLegacyProvider[]) => void;

let cached: RejectedLegacyProvider[] = [];
const listeners = new Set<Listener>();

/** Latest snapshot for the settings UI (dismissed entries excluded). */
export function rejectedLegacyProviders(): RejectedLegacyProvider[] {
  return cached;
}

function publish(entries: RejectedLegacyProvider[]): void {
  cached = visibleRejectedLegacyProviders(entries, readDismissedLegacyProviderKeys());
  for (const listener of listeners) listener(cached);
}

/**
 * Permanently ignores the given rejections. Irreversible by design: there is no API to undo it,
 * and the banner never shows these records again (a later config edit yields a new fingerprint
 * and therefore a new, visible record).
 */
export function dismissRejectedLegacyProviders(
  entries: readonly Pick<RejectedLegacyProvider, "id" | "fingerprint">[],
  storage: Storage | null = defaultStorage(),
): void {
  const keys = readDismissedLegacyProviderKeys(storage);
  for (const entry of entries) keys.add(dismissalKey(entry));
  if (storage) {
    try {
      storage.setItem(
        scopedStorageKey(LEGACY_PROVIDER_IMPORT_DISMISSED_STORAGE_KEY),
        JSON.stringify([...keys]),
      );
    } catch {
      // Best effort; the in-memory snapshot below still hides the banner for this session.
    }
  }
  const dismissed = new Set(keys);
  cached = cached.filter((entry) => !dismissed.has(dismissalKey(entry)));
  for (const listener of listeners) listener(cached);
}

export function subscribeRejectedLegacyProviders(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reads storage and refreshes the snapshot listeners (and the UI) read from. */
export function refreshRejectedLegacyProviders(): RejectedLegacyProvider[] {
  publish(readRejectedLegacyProviders());
  return cached;
}

/** Forgets every rejection so the next settings load retries them all. */
export function clearRejectedLegacyProviders(): void {
  writeRejectedLegacyProviders([]);
  publish([]);
}

export function readImportedLegacyProviderIds(
  storage: Storage | null = defaultStorage(),
): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(scopedStorageKey(LEGACY_PROVIDER_IMPORTED_STORAGE_KEY));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function writeImportedLegacyProviderIds(
  ids: Iterable<string>,
  storage: Storage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      scopedStorageKey(LEGACY_PROVIDER_IMPORTED_STORAGE_KEY),
      JSON.stringify([...new Set(ids)].sort()),
    );
  } catch {
    // Best effort: losing the record only means a deleted provider may be imported once more.
  }
}

/**
 * Splits the legacy providers K-brain does not have into ones still waiting for their first
 * import and ones the user deleted after they were imported. Legacy ids K-brain already holds
 * are added to the record, so installs migrated before this record existed are covered too.
 */
export function partitionMissingLegacyProviders(
  legacy: readonly CustomProvider[],
  backendIds: ReadonlySet<string>,
  importedIds: ReadonlySet<string>,
): { notYetImported: CustomProvider[]; deleted: CustomProvider[]; importedIds: Set<string> } {
  const nextImported = new Set(importedIds);
  const notYetImported: CustomProvider[] = [];
  const deleted: CustomProvider[] = [];
  for (const provider of legacy) {
    if (backendIds.has(provider.id)) nextImported.add(provider.id);
    else if (importedIds.has(provider.id)) deleted.push(provider);
    else notYetImported.push(provider);
  }
  return { notYetImported, deleted, importedIds: nextImported };
}
