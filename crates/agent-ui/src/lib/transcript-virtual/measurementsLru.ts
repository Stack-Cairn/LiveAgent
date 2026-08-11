import type { VirtualItem } from "@tanstack/react-virtual";

// Per-conversation snapshots of the transcript virtualizer's measured rows,
// taken on unmount (virtualizer.takeSnapshot()) and fed back through
// initialMeasurementsCache when the conversation reopens — switching back to
// a conversation then lays out with exact row heights instead of estimates.
// In-memory only and layout-gated: measured heights depend on both the scroll
// viewport and the centered transcript width, so callers provide a composite
// layout key. Snapshots are never persisted.

export type TranscriptMeasurementsLru = {
  save: (conversationId: string, layoutKey: string, measurements: VirtualItem[]) => void;
  restore: (conversationId: string, layoutKey: string) => VirtualItem[] | null;
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

export function createTranscriptMeasurementsLru(
  capacity = DEFAULT_CAPACITY,
): TranscriptMeasurementsLru {
  const entries = new Map<string, { layoutKey: string; measurements: VirtualItem[] }>();

  return {
    save: (conversationId, layoutKey, measurements) => {
      if (!conversationId || !layoutKey || measurements.length === 0) {
        return;
      }
      entries.delete(conversationId);
      entries.set(conversationId, { layoutKey, measurements });
      while (entries.size > capacity) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    restore: (conversationId, layoutKey) => {
      const hit = entries.get(conversationId);
      if (!hit || hit.layoutKey !== layoutKey) {
        return null;
      }
      entries.delete(conversationId);
      entries.set(conversationId, hit);
      return hit.measurements;
    },
  };
}
