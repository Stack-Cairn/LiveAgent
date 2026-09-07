// Reasoning blocks carry no timing metadata from providers, so "思考了 Xs" is
// measured client-side while a segment streams. State lives at module scope,
// keyed by the transcript entry key, so it survives virtualization unmounts
// mid-run; after an app reload the header simply falls back to the untimed
// "思考过程" label. Both maps are idempotent per key, which lets renderers
// call resolveThinkingDurationMs during render (StrictMode double-render safe).

const MAX_TRACKED_SEGMENTS = 512;

const startedAt = new Map<string, number>();
const settledDurations = new Map<string, number>();

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
 * that was never observed streaming (history reload) always reports null.
 */
export function resolveThinkingDurationMs(
  key: string,
  active: boolean,
  now = Date.now(),
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
    settledDurations.set(key, Math.max(0, now - start));
    trimOldest(settledDurations);
  }
  return settledDurations.get(key) ?? null;
}
