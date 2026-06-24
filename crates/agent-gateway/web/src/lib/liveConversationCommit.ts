import type { ChatEntry } from "./chatUi";
import { normalizeUploadedFileForDisplayComparison } from "./chat/uploadedFiles";

function cloneValue<T>(value: T): T {
  if (value == null) {
    return value;
  }
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildComparableEntry(entry: ChatEntry) {
  const clone = cloneValue(entry);
  const { id: _id, ...rest } = clone;
  return rest;
}

function areEntriesEquivalent(left: ChatEntry, right: ChatEntry) {
  return JSON.stringify(buildComparableEntry(left)) === JSON.stringify(buildComparableEntry(right));
}

function buildVisualComparableEntry(entry: ChatEntry) {
  const comparable = buildComparableEntry(entry) as Record<string, unknown>;
  if (entry.kind === "assistant") {
    const { meta: _meta, ...rest } = comparable;
    return rest;
  }
  if (entry.kind === "user") {
    // `messageRef` is the server-assigned edit handle; locally created user
    // entries do not have it yet. The field is invisible to the rendered
    // bubble, so it must not cause visual equivalence to fail (otherwise the
    // post-stream history refresh would replace every user entry with a fresh
    // id, all article keys would change, and the `chat-bubble-enter`
    // animation would re-run for every user bubble at once).
    const { messageRef: _messageRef, attachments, ...rest } = comparable;
    return {
      ...rest,
      attachments: Array.isArray(attachments)
        ? attachments.map(normalizeUploadedFileForDisplayComparison)
        : [],
    };
  }
  return comparable;
}

function areEntriesVisuallyEquivalent(left: ChatEntry, right: ChatEntry) {
  return (
    JSON.stringify(buildVisualComparableEntry(left)) ===
    JSON.stringify(buildVisualComparableEntry(right))
  );
}

function assistantRoundKey(entry: ChatEntry) {
  return entry.kind === "assistant" ? String(entry.round ?? "__default__") : "";
}

function mergeDefinedRecordValues<T extends object>(left: T, right: T) {
  let changed = false;
  const next: Record<string, unknown> = { ...(left as Record<string, unknown>) };
  for (const [key, value] of Object.entries(right as Record<string, unknown>)) {
    if (value === undefined) {
      continue;
    }
    if (JSON.stringify(next[key]) !== JSON.stringify(value)) {
      next[key] = value;
      changed = true;
    }
  }
  return changed ? next as T : left;
}

function mergeAssistantMetadataIntoExisting(existing: ChatEntry[], incoming: ChatEntry[]) {
  const existingMetaIndexByRound = new Map<string, number>();
  existing.forEach((entry, index) => {
    if (entry.kind === "assistant" && entry.meta && !existingMetaIndexByRound.has(assistantRoundKey(entry))) {
      existingMetaIndexByRound.set(assistantRoundKey(entry), index);
    }
  });

  let next: ChatEntry[] | null = null;
  const ensureNext = () => {
    next ??= existing.slice();
    return next;
  };

  incoming.forEach((incomingEntry, index) => {
    if (incomingEntry.kind !== "assistant" || !incomingEntry.meta) {
      return;
    }
    const existingEntry = existing[index];
    const roundKey = assistantRoundKey(incomingEntry);
    const targetIndex =
      existingEntry?.kind === "assistant" && existingEntry.meta
        ? index
        : existingMetaIndexByRound.get(roundKey) ?? index;
    const targetEntry = existing[targetIndex];
    if (!targetEntry || targetEntry.kind !== "assistant") {
      return;
    }
    const mergedMeta = targetEntry.meta
      ? mergeDefinedRecordValues(targetEntry.meta, incomingEntry.meta)
      : incomingEntry.meta;
    if (mergedMeta === targetEntry.meta) {
      return;
    }
    ensureNext()[targetIndex] = {
      ...targetEntry,
      meta: cloneValue(mergedMeta),
    };
    existingMetaIndexByRound.set(roundKey, targetIndex);
  });

  return next ?? existing;
}

function mergeUserMessageRefIntoExisting(existing: ChatEntry[], incoming: ChatEntry[]) {
  let next: ChatEntry[] | null = null;
  const ensureNext = () => {
    next ??= existing.slice();
    return next;
  };

  incoming.forEach((incomingEntry, index) => {
    if (incomingEntry.kind !== "user" || !incomingEntry.messageRef) {
      return;
    }
    const existingEntry = existing[index];
    if (!existingEntry || existingEntry.kind !== "user") {
      return;
    }
    if (
      existingEntry.messageRef &&
      JSON.stringify(existingEntry.messageRef) === JSON.stringify(incomingEntry.messageRef)
    ) {
      return;
    }
    ensureNext()[index] = {
      ...existingEntry,
      messageRef: cloneValue(incomingEntry.messageRef),
    };
  });

  return next ?? existing;
}

function mergeReconciledMetadataIntoExisting(existing: ChatEntry[], incoming: ChatEntry[]) {
  const withAssistantMeta = mergeAssistantMetadataIntoExisting(existing, incoming);
  return mergeUserMessageRefIntoExisting(withAssistantMeta, incoming);
}

function areEntryArraysVisuallyEquivalent(existing: ChatEntry[], incoming: ChatEntry[]) {
  if (existing.length !== incoming.length) {
    return false;
  }
  for (let index = 0; index < existing.length; index += 1) {
    const existingEntry = existing[index];
    const incomingEntry = incoming[index];
    if (!existingEntry || !incomingEntry || !areEntriesVisuallyEquivalent(existingEntry, incomingEntry)) {
      return false;
    }
  }
  return true;
}

function hasTailEntries(
  existing: ChatEntry[],
  liveEntries: ChatEntry[],
  areEquivalent: (left: ChatEntry, right: ChatEntry) => boolean,
) {
  if (liveEntries.length === 0 || existing.length < liveEntries.length) {
    return false;
  }

  const offset = existing.length - liveEntries.length;
  for (let index = 0; index < liveEntries.length; index += 1) {
    const existingEntry = existing[offset + index];
    const liveEntry = liveEntries[index];
    if (!existingEntry || !liveEntry || !areEquivalent(existingEntry, liveEntry)) {
      return false;
    }
  }

  return true;
}

export function hasEquivalentTailEntries(existing: ChatEntry[], liveEntries: ChatEntry[]) {
  return hasTailEntries(existing, liveEntries, areEntriesEquivalent);
}

function hasVisuallyEquivalentTailEntries(existing: ChatEntry[], liveEntries: ChatEntry[]) {
  return hasTailEntries(existing, liveEntries, areEntriesVisuallyEquivalent);
}

export function omitEquivalentTailEntries(existing: ChatEntry[], liveEntries: ChatEntry[]) {
  if (!hasVisuallyEquivalentTailEntries(existing, liveEntries)) {
    const overlap = findLargestOverlap(existing, liveEntries, areEntriesVisuallyEquivalent);
    return overlap > 0 ? existing.slice(0, existing.length - overlap) : existing;
  }
  return existing.slice(0, existing.length - liveEntries.length);
}

function findLargestOverlap(
  existing: ChatEntry[],
  incoming: ChatEntry[],
  areEquivalent: (left: ChatEntry, right: ChatEntry) => boolean = areEntriesEquivalent,
) {
  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;
    const existingStart = existing.length - overlap;
    for (let index = 0; index < overlap; index += 1) {
      const existingEntry = existing[existingStart + index];
      const incomingEntry = incoming[index];
      if (!existingEntry || !incomingEntry || !areEquivalent(existingEntry, incomingEntry)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return overlap;
    }
  }
  return 0;
}

function buildCommittedEntryId(entry: ChatEntry, ordinal: number) {
  const payloadHash = hashText(JSON.stringify(buildComparableEntry(entry)));
  return `committed-live-${entry.kind}-${ordinal}-${payloadHash}`;
}

export type MergeHistorySnapshotOptions = {
  // Hint that `incoming` represents the full server-side conversation rather
  // than a paginated tail. When true, a shorter incoming list without an
  // overlap match is treated as a server-side truncation (e.g. another client
  // edited and resent an earlier message) and replaces the existing entries
  // instead of being preserved as stale state.
  isFullSnapshot?: boolean;
};

export function mergeHistorySnapshotEntries(
  existing: ChatEntry[],
  incoming: ChatEntry[],
  options?: MergeHistorySnapshotOptions,
) {
  const isFullSnapshot = options?.isFullSnapshot === true;

  if (incoming.length === 0) {
    return isFullSnapshot ? [] : existing;
  }
  if (hasEquivalentTailEntries(existing, incoming)) {
    return existing;
  }
  if (areEntryArraysVisuallyEquivalent(existing, incoming)) {
    return mergeReconciledMetadataIntoExisting(existing, incoming);
  }
  if (existing.length === 0) {
    return incoming.map((entry) => cloneValue(entry));
  }

  const overlap = findLargestOverlap(existing, incoming);
  if (overlap > 0) {
    return [
      ...existing.slice(0, existing.length - overlap),
      ...incoming.map((entry) => cloneValue(entry)),
    ];
  }

  const visualOverlap = findLargestOverlap(existing, incoming, areEntriesVisuallyEquivalent);
  if (visualOverlap > 0) {
    const existingPrefix = existing.slice(0, existing.length - visualOverlap);
    const existingOverlap = existing.slice(existing.length - visualOverlap);
    const incomingOverlap = incoming.slice(0, visualOverlap);
    const incomingSuffix = incoming.slice(visualOverlap);
    return [
      ...existingPrefix,
      ...mergeReconciledMetadataIntoExisting(existingOverlap, incomingOverlap),
      ...incomingSuffix.map((entry) => cloneValue(entry)),
    ];
  }

  if (incoming.length >= existing.length || isFullSnapshot) {
    return incoming.map((entry) => cloneValue(entry));
  }
  return existing;
}

export function appendCommittedLiveEntries(existing: ChatEntry[], liveEntries: ChatEntry[]) {
  if (liveEntries.length === 0 || hasEquivalentTailEntries(existing, liveEntries)) {
    return existing;
  }

  const visualOverlap = findLargestOverlap(existing, liveEntries, areEntriesVisuallyEquivalent);
  const baseEntries =
    visualOverlap > 0
      ? [
          ...existing.slice(0, existing.length - visualOverlap),
          ...mergeReconciledMetadataIntoExisting(
            existing.slice(existing.length - visualOverlap),
            liveEntries.slice(0, visualOverlap),
          ),
        ]
      : existing;
  const entriesToCommit = visualOverlap > 0 ? liveEntries.slice(visualOverlap) : liveEntries;
  if (entriesToCommit.length === 0) {
    return baseEntries;
  }

  const baseIndex = baseEntries.length;
  const committedEntries = entriesToCommit.map((entry, index) => ({
    ...cloneValue(entry),
    id: buildCommittedEntryId(entry, baseIndex + index),
  }));

  return [...baseEntries, ...committedEntries];
}
