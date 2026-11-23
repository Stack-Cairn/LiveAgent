// Reasoning blocks carry no timing metadata from providers, so "Thought for Xs"
// is measured client-side while a segment streams. State lives at module
// scope, keyed by the transcript entry key, so it survives virtualization
// unmounts mid-run. A settled duration is also filed under the segment's text:
// when the finished turn is replaced by its saved history (new entry keys, same
// reasoning text) the measurement carries over instead of reverting to the
// untimed label. After an app reload the label falls back to untimed. All maps
// are idempotent per key, which lets renderers call resolveThinkingDurationMs
// during render (StrictMode double-render safe).

const MAX_TRACKED_SEGMENTS = 512;

const startedAt = new Map<string, number>();
const settledDurations = new Map<string, number>();
const settledByText = new Map<string, number>();

/**
 * Whitespace-insensitive identity of a reasoning text (history may trim or
 * re-join it): length plus a 53-bit hash, so long reasoning is not retained.
 */
function textFingerprint(text: string | undefined): string | null {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${normalized.length}:${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

function trimOldest(map: Map<string, number>) {
  while (map.size > MAX_TRACKED_SEGMENTS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

/**
 * Reads the settled duration for a reasoning segment, advancing the tracker
 * as a side effect: an active segment starts (or keeps) its clock and reports
 * null; an inactive segment settles a pending clock exactly once. A segment
 * that was never observed streaming reports the duration measured for the
 * same reasoning text, if any, else null (a reload).
 */
export function resolveThinkingDurationMs(
  key: string,
  active: boolean,
  now = Date.now(),
  text?: string,
): number | null {
  if (active) {
    if (!settledDurations.has(key) && !startedAt.has(key)) {
      startedAt.set(key, now);
      trimOldest(startedAt);
    }
    return null;
  }

  const start = startedAt.get(key);
  if (start !== undefined) {
    startedAt.delete(key);
    const duration = Math.max(0, now - start);
    settledDurations.set(key, duration);
    trimOldest(settledDurations);
    const fingerprint = textFingerprint(text);
    if (fingerprint) {
      settledByText.set(fingerprint, duration);
      trimOldest(settledByText);
    }
  }
  const settled = settledDurations.get(key);
  if (settled !== undefined) return settled;
  const fingerprint = textFingerprint(text);
  return fingerprint ? (settledByText.get(fingerprint) ?? null) : null;
}
