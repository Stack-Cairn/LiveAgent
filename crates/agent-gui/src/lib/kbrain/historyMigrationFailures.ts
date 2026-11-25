/**
 * Records legacy conversations that failed to migrate into K-brain, so that:
 *
 * - the user can see which conversations are missing and why (settings + app notice),
 * - startup does not re-send a conversation that will deterministically fail again
 *   (oversized bodies are 5–30 MB each and used to be re-uploaded on every launch),
 * - the manual "Import old conversations" action still retries everything.
 *
 * A record is keyed by conversation id and the migration source fingerprint: once the
 * legacy conversation changes, the record no longer matches and startup retries it. It also
 * names the K-brain store it was recorded against; a record from another store (or from a
 * release that did not record one) never blocks a retry.
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
  /** For too_large: the import cap the failure was recorded under. */
  limitBytes?: number;
  message: string;
  failedAt: number;
  /** K-brain store identity (storage scope) the failure was recorded against. */
  store?: string;
  /** For conflicts: the backend build and its prefix-update support when recorded. */
  backend?: string;
  /** For conflicts on newer backends: why K-brain refused (e.g. "diverged"). */
  reason?: string;
};

/** What decides whether a recorded conflict is still worth skipping, read once per pass. */
export type ConflictRetryContext = {
  /** Backend build plus its prefix-update support, as recorded in `backend`. */
  backend: string;
  /** The backend can extend an earlier import whose messages are a prefix of the new ones. */
  prefixUpdate: boolean;
  /** Conversations whose conflicting K-brain session is known to be gone. */
  missing: ReadonlySet<string>;
};

/** Capability of backends that update an imported prefix in place instead of refusing it. */
export const HISTORY_IMPORT_PREFIX_UPDATE = "history_import_prefix_update";

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
  /** Machine-readable code of newer backends (e.g. "import_conflict", "session_busy"). */
  errorCode?: string;
}): HistoryMigrationFailureKind {
  const { status } = input;
  if (status === 413) return "too_large";
  // The session is being written in K-brain right now; the same import succeeds later.
  if (status === 409 && input.errorCode === "session_busy") return "transient";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "rejected";
  // Network errors and authentication/rate-limit failures can recover without payload changes.
  return "transient";
}

/**
 * Import cap of the bundled K-brain (maxLegacyHistoryBodyBytes). Size failures recorded
 * under an older, smaller cap are retried once at startup after the backend upgrade.
 */
export const LEGACY_IMPORT_MAX_BODY_BYTES = 512 << 20;

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

/**
 * Record lookup used by migration to skip known deterministic failures at startup. Only a
 * record of the same content against the same K-brain store counts.
 */
export function knownDeterministicFailure(
  records: readonly HistoryMigrationFailureRecord[],
  sourceId: string,
  fingerprint: string,
  store: string,
): HistoryMigrationFailureRecord | undefined {
  return records.find(
    (record) =>
      record.sourceId === sourceId &&
      record.fingerprint === fingerprint &&
      record.store === store &&
      isDeterministicHistoryMigrationFailure(record.kind) &&
      (record.kind !== "too_large" || record.limitBytes === LEGACY_IMPORT_MAX_BODY_BYTES),
  );
}

/**
 * A recorded conflict is retried when the session it conflicted with is gone, or once per
 * backend build that can update an imported prefix in place (a conversation that was still
 * being written when it was first imported then completes instead of conflicting forever).
 */
export function conflictRetryable(
  record: Pick<HistoryMigrationFailureRecord, "sourceId" | "kind" | "backend">,
  context: ConflictRetryContext,
) {
  return (
    record.kind === "conflict" &&
    (context.missing.has(record.sourceId) ||
      (context.prefixUpdate && record.backend !== context.backend))
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
