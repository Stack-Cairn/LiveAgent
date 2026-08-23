import type { VirtualItem } from "@tanstack/react-virtual";

// Per-conversation snapshots of the transcript virtualizer's measured rows,
// taken on unmount (virtualizer.takeSnapshot()) and fed back through
// initialMeasurementsCache when the conversation reopens — switching back to
// a conversation then lays out with exact row heights instead of estimates.
// Layout-gated: measured heights depend on both the scroll viewport and the
// centered transcript width, so callers provide a composite layout key.
// With `persistNamespace` set, snapshots also round-trip through
// localStorage, so revisited conversations skip the estimate→measure
// correction churn (the fuel for scroll-compensation work) across restarts.

export type TranscriptMeasurementsLru = {
  save: (conversationId: string, layoutKey: string, measurements: VirtualItem[]) => void;
  restore: (conversationId: string, layoutKey: string) => VirtualItem[] | null;
};

export type TranscriptMeasurementsLruOptions = {
  capacity?: number;
  // Persist snapshots under this namespace in localStorage. Omit for the
  // previous in-memory-only behavior. Failures (quota, disabled storage,
  // malformed payloads) silently degrade to memory-only.
  persistNamespace?: string;
};

// The composite key both callers must use. Owning the shape here keeps the two
// frontends from drifting, and returning "" for an unmeasured viewport or
// column re-establishes the guard the plain-number key used to carry: save()
// and restore() both reject blank keys, so a zero-width layout is never stored.
export function buildTranscriptLayoutKey(viewportWidth: number, contentWidth: number): string {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return "";
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return "";
  return `${Math.round(viewportWidth)}:${Math.round(contentWidth)}`;
}

const DEFAULT_CAPACITY = 12;
// Giant transcripts are cheap to re-measure relative to their storage cost;
// exclude them from the persisted payload rather than risk quota churn. The
// write itself still runs so a previously persisted (now stale) snapshot of
// the same conversation is pruned instead of surviving into the next restart.
const PERSIST_MAX_ROWS_PER_ENTRY = 5000;
const PERSIST_VERSION = 1;

type StoredEntry = { layoutKey: string; measurements: VirtualItem[] };

// The virtualizer only consumes `key` and `size` from a restored snapshot
// (positions are always recomputed from sizes), so the persisted form keeps
// just those two per row — roughly 4x the quota headroom of full items.
type PersistedRow = [key: string | number, size: number];

function persistKeyFor(namespace: string) {
  return `liveagent.transcript-measurements.v${PERSIST_VERSION}.${namespace}`;
}

function isPersistedRow(value: unknown): value is PersistedRow {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (typeof value[0] === "string" || typeof value[0] === "number") &&
    Number.isFinite(value[1])
  );
}

function toVirtualItems(rows: PersistedRow[]): VirtualItem[] {
  return rows.map(([key, size], index) => ({
    index,
    key,
    start: 0,
    size,
    end: size,
    lane: 0,
  }));
}

function readPersistedEntries(namespace: string): Map<string, StoredEntry> {
  const entries = new Map<string, StoredEntry>();
  try {
    if (typeof localStorage === "undefined") return entries;
    const raw = localStorage.getItem(persistKeyFor(namespace));
    if (!raw) return entries;
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return entries;
    for (const pair of parsed.entries) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [conversationId, entry] = pair as [
        unknown,
        { layoutKey?: unknown; rows?: unknown } | null,
      ];
      if (typeof conversationId !== "string" || !entry) continue;
      if (typeof entry.layoutKey !== "string" || !Array.isArray(entry.rows)) continue;
      if (!entry.rows.every(isPersistedRow)) continue;
      entries.set(conversationId, {
        layoutKey: entry.layoutKey,
        measurements: toVirtualItems(entry.rows),
      });
    }
  } catch {
    entries.clear();
  }
  return entries;
}

function writePersistedEntries(namespace: string, entries: Map<string, StoredEntry>) {
  try {
    if (typeof localStorage === "undefined") return;
    const persisted = [...entries.entries()]
      .filter(([, entry]) => entry.measurements.length <= PERSIST_MAX_ROWS_PER_ENTRY)
      .map(([conversationId, entry]) => [
        conversationId,
        {
          layoutKey: entry.layoutKey,
          rows: entry.measurements.map(
            (item): PersistedRow => [item.key as string | number, item.size],
          ),
        },
      ]);
    localStorage.setItem(persistKeyFor(namespace), JSON.stringify({ entries: persisted }));
  } catch {
    // Quota or serialization failure: memory-only from here on is fine.
  }
}

export function createTranscriptMeasurementsLru(
  options: TranscriptMeasurementsLruOptions = {},
): TranscriptMeasurementsLru {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const persistNamespace = options.persistNamespace;
  let entries: Map<string, StoredEntry> | null = null;

  // Lazy so module-level singletons don't pay the localStorage read until a
  // transcript actually mounts.
  const getEntries = () => {
    if (entries === null) {
      entries = persistNamespace ? readPersistedEntries(persistNamespace) : new Map();
      while (entries.size > capacity) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    }
    return entries;
  };

  return {
    save: (conversationId, layoutKey, measurements) => {
      if (!conversationId || !layoutKey || measurements.length === 0) {
        return;
      }
      const map = getEntries();
      map.delete(conversationId);
      map.set(conversationId, { layoutKey, measurements });
      while (map.size > capacity) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
      if (persistNamespace) {
        writePersistedEntries(persistNamespace, map);
      }
    },
    restore: (conversationId, layoutKey) => {
      const map = getEntries();
      const hit = map.get(conversationId);
      if (!hit || hit.layoutKey !== layoutKey) {
        return null;
      }
      map.delete(conversationId);
      map.set(conversationId, hit);
      return hit.measurements;
    },
  };
}
