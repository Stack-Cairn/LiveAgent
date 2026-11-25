/**
 * Per-session completion state of the Pi session source, stored with its completion marker.
 *
 * The marker covers the whole session directory (a signature over every file's path, size and
 * mtime), and other clients may keep writing that directory. When the signature differs, this
 * state says which files are already settled: a file whose size and mtime still match its entry
 * is skipped without being read. A file whose size or mtime changed is read again, and the
 * conversation's fingerprint decides whether it needs a new import, so a file that was only
 * touched is settled by the cached result without a request.
 */

/**
 * A session file modified within this window is left for later. The other client appends a
 * line per message and tool result, so an active session is written every few seconds and an
 * agent turn waiting on a slow tool call rarely stays silent for more than a minute. Two
 * minutes of quiet means the session is very likely between turns, which keeps a half-written
 * conversation out of K-brain, while a session that was just closed is picked up by the
 * in-app retry a couple of minutes later instead of on the next launch.
 */
export const PI_HISTORY_DEFER_MS = 2 * 60_000;

/**
 * At most this many files keep an entry (about 100 bytes each, so roughly 1 MB of storage).
 * Files past the bound are read whenever the directory changes, as every file was before.
 */
const MAX_SESSION_STATE_ENTRIES = 10_000;

/** Bump when the meaning of an entry changes; older state is then ignored once. */
const SESSION_STATE_FORMAT = 1;

export type PiSourceFile = {
  sourceId: string;
  size: number;
  mtimeMs: number;
  status?: "read" | "skipped" | "changed" | "missing";
};

export type PiMigrationManifest = { signature: string; files: PiSourceFile[] };

/**
 * How a file settled: i = imported (the cached result holds its fingerprint), f = a recorded
 * deterministic failure, d = deleted in K-brain (410), n = no conversation to import (not a
 * session, unreadable, or rejected before any request).
 */
export type SessionSettlement = "i" | "f" | "d" | "n";
export type SessionEntry = [
  size: number,
  mtimeMs: number,
  kind: SessionSettlement,
  fingerprint: string,
];
export type SessionStateFiles = Record<string, SessionEntry>;
export type StoredSessionState = { format: number; files: SessionStateFiles };

const SETTLEMENTS = new Set<string>(["i", "f", "d", "n"]);

function isEntry(value: unknown): value is SessionEntry {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    SETTLEMENTS.has(value[2]) &&
    typeof value[3] === "string"
  );
}

/** Stored state, or null when it is missing, from another format or malformed. */
export function parseSessionState(value: unknown): SessionStateFiles | null {
  if (!value || typeof value !== "object") return null;
  const { format, files } = value as Partial<StoredSessionState>;
  if (format !== SESSION_STATE_FORMAT || !files || typeof files !== "object") return null;
  const out: SessionStateFiles = {};
  for (const [id, entry] of Object.entries(files)) if (isEntry(entry)) out[id] = entry;
  return out;
}

/** Keeps the entries of the files modified longest ago: they are the ones that stay unchanged. */
export function storedSessionState(files: SessionStateFiles): StoredSessionState {
  const entries = Object.entries(files);
  const kept =
    entries.length <= MAX_SESSION_STATE_ENTRIES
      ? entries
      : entries.sort((left, right) => left[1][1] - right[1][1]).slice(0, MAX_SESSION_STATE_ENTRIES);
  return { format: SESSION_STATE_FORMAT, files: Object.fromEntries(kept) };
}

/**
 * Written within the deferral window. A future mtime (clock skew, a copied file) counts only
 * within the same window, so a file stamped far ahead is not deferred forever.
 */
export function isRecentlyModified(mtimeMs: number, now: number) {
  return Math.abs(now - mtimeMs) < PI_HISTORY_DEFER_MS;
}

export type PiFileSelection = {
  /** Files to read: new, changed, or whose entry no longer holds. */
  candidates: PiSourceFile[];
  /** Files still being written; neither read nor marked settled. */
  deferred: PiSourceFile[];
  /** Imported files skipped without reading, pending the check that K-brain still has them. */
  unchangedImported: PiSourceFile[];
};

/**
 * Splits the manifest by the stored state. `entryHolds` confirms an entry against the current
 * cache and failure records (a lost cache entry or an invalidated failure makes it a candidate).
 */
export function selectPiFiles(
  files: readonly PiSourceFile[],
  state: SessionStateFiles,
  now: number,
  entryHolds: (sourceId: string, entry: SessionEntry) => boolean,
  readEverything = false,
): PiFileSelection {
  const selection: PiFileSelection = { candidates: [], deferred: [], unchangedImported: [] };
  for (const file of files) {
    if (isRecentlyModified(file.mtimeMs, now)) {
      selection.deferred.push(file);
      continue;
    }
    const entry = state[file.sourceId];
    if (
      readEverything ||
      !entry ||
      entry[0] !== file.size ||
      entry[1] !== file.mtimeMs ||
      !entryHolds(file.sourceId, entry)
    ) {
      selection.candidates.push(file);
    } else if (entry[2] === "i") {
      selection.unchangedImported.push(file);
    }
  }
  return selection;
}

/** The directory signature a completion marker (`format|appVersion|signature`) was written for. */
export function markerSignature(marker: string, format: number) {
  const prefix = `${format}|`;
  if (!marker.startsWith(prefix)) return null;
  const rest = marker.slice(prefix.length);
  const separator = rest.indexOf("|");
  return separator < 0 ? null : rest.slice(separator + 1);
}
