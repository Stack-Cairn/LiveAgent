/**
 * Records legacy conversations that failed to migrate into K-brain, so that:
 *
 * - the user can see which conversations are missing and why (settings + app notice),
 * - startup does not re-send a conversation that will deterministically fail again
 *   (oversized bodies are 5–30 MB each and used to be re-uploaded on every launch),
 * - the manual "Import old conversations" action still retries everything.
 *
 * A record is keyed by conversation id and the migration source fingerprint: once the
 * legacy conversation changes, the record no longer matches and startup retries it.
 */

export type HistoryMigrationFailureKind =
  /** Request body exceeds K-brain's limit; needs K-brain to accept larger imports. */
  | "too_large"
  /** K-brain already holds this conversation with different content (HTTP 409). */
  | "conflict"
  /** K-brain rejected the payload as invalid (other 4xx). */
  | "rejected"
  /** Transport / server failure that may succeed on a later attempt. */
  | "transient";

export type HistoryMigrationFailureRecord = {
  sourceId: string;
  title: string;
  fingerprint: string;
  kind: HistoryMigrationFailureKind;
  /** Serialized request body size when known. */
  bytes?: number;
  message: string;
  failedAt: number;
};

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function classifyHistoryMigrationFailure(input: {
  status?: number;
  message: string;
  bytes?: number;
}): HistoryMigrationFailureKind {
  const { status } = input;
  if (status === 413) return "too_large";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "rejected";
  // Network errors and authentication/rate-limit failures can recover without payload changes.
  return "transient";
}

/** Failures that will fail identically until the conversation or K-brain changes. */
export function isDeterministicHistoryMigrationFailure(kind: HistoryMigrationFailureKind) {
  return kind !== "transient";
}

function recordsKey(scope: string) {
  return `liveagent.kbrain-history-migration-failures.v2:${scope}`;
}

function dismissedKey(scope: string) {
  return `liveagent.kbrain-history-migration-failures-dismissed.v1:${scope}`;
}

function recordKey(record: Pick<HistoryMigrationFailureRecord, "sourceId" | "fingerprint">) {
  return `${record.sourceId}:${record.fingerprint}`;
}

export function readHistoryMigrationFailures(
  scope: string,
  storage: Storage | null = defaultStorage(),
): HistoryMigrationFailureRecord[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(recordsKey(scope));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is HistoryMigrationFailureRecord =>
        !!entry &&
        typeof entry.sourceId === "string" &&
        typeof entry.fingerprint === "string" &&
        typeof entry.kind === "string" &&
        typeof entry.message === "string",
    );
  } catch {
    return [];
  }
}

export function writeHistoryMigrationFailures(
  scope: string,
  records: readonly HistoryMigrationFailureRecord[],
  storage: Storage | null = defaultStorage(),
): void {
  if (storage) {
    try {
      storage.setItem(recordsKey(scope), JSON.stringify(records));
    } catch {
      // Best effort: losing the record only costs one more attempt next launch.
    }
  }
  publish(scope, storage);
}

/** Record lookup used by migration to skip known deterministic failures at startup. */
export function knownDeterministicFailure(
  records: readonly HistoryMigrationFailureRecord[],
  sourceId: string,
  fingerprint: string,
): HistoryMigrationFailureRecord | undefined {
  return records.find(
    (record) =>
      record.sourceId === sourceId &&
      record.fingerprint === fingerprint &&
      isDeterministicHistoryMigrationFailure(record.kind),
  );
}

/**
 * Merges one migration pass into the stored records: successes drop their record,
 * new failures replace any older record for the same conversation.
 */
export function mergeHistoryMigrationFailures(
  previous: readonly HistoryMigrationFailureRecord[],
  pass: {
    succeeded: Iterable<string>;
    failed: readonly HistoryMigrationFailureRecord[];
  },
): HistoryMigrationFailureRecord[] {
  const succeeded = new Set(pass.succeeded);
  const byId = new Map<string, HistoryMigrationFailureRecord>();
  for (const record of previous) {
    if (!succeeded.has(record.sourceId)) byId.set(record.sourceId, record);
  }
  for (const record of pass.failed) byId.set(record.sourceId, record);
  return [...byId.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

export function readDismissedHistoryMigrationFailures(
  scope: string,
  storage: Storage | null = defaultStorage(),
): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(dismissedKey(scope));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Permanently hides the app-level notice for these records. Irreversible by design; the
 * settings page keeps listing them, and a changed conversation produces a new record.
 */
export function dismissHistoryMigrationFailures(
  scope: string,
  records: readonly Pick<HistoryMigrationFailureRecord, "sourceId" | "fingerprint">[],
  storage: Storage | null = defaultStorage(),
): void {
  const keys = readDismissedHistoryMigrationFailures(scope, storage);
  for (const record of records) keys.add(recordKey(record));
  if (storage) {
    try {
      storage.setItem(dismissedKey(scope), JSON.stringify([...keys]));
    } catch {
      // Best effort; the in-memory snapshot below still hides the notice this session.
    }
  }
  publish(scope, storage);
}

export type HistoryMigrationFailureSnapshot = {
  /** Every recorded failure, for the settings page. */
  all: HistoryMigrationFailureRecord[];
  /** Failures the user has not dismissed, for the app-level notice. */
  undismissed: HistoryMigrationFailureRecord[];
};

const EMPTY: HistoryMigrationFailureSnapshot = { all: [], undismissed: [] };
const snapshots = new Map<string, HistoryMigrationFailureSnapshot>();
const listeners = new Set<() => void>();

function publish(scope: string, storage: Storage | null) {
  const all = readHistoryMigrationFailures(scope, storage);
  const dismissed = readDismissedHistoryMigrationFailures(scope, storage);
  snapshots.set(scope, {
    all,
    undismissed: all.filter((record) => !dismissed.has(recordKey(record))),
  });
  for (const listener of listeners) listener();
}

export function getHistoryMigrationFailures(scope: string): HistoryMigrationFailureSnapshot {
  let snapshot = snapshots.get(scope);
  if (!snapshot) {
    publish(scope, defaultStorage());
    snapshot = snapshots.get(scope) ?? EMPTY;
  }
  return snapshot;
}

export function subscribeHistoryMigrationFailures(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
