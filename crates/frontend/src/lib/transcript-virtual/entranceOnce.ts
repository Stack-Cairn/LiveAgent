// Entrance-animation registry: a row animates once, when it is genuinely new
// to the transcript — never when the virtualizer remounts it on scroll
// re-entry, and never for rows that were already present when a conversation
// opened.
//
// The row model reports key births as it discovers them (all rows on the
// first build, only newly created rows afterwards), so per-frame work is
// O(changed) instead of a full key-list walk. Keys born in the initial build
// are stamped 0 = never animate; later births are stamped with their birth
// time, and renders within the animation window play the entrance class.
// Decisions are pure reads afterwards, so StrictMode double-renders and
// double-mounts inside the window replay the same answer.

export const ENTRANCE_ANIMATION_WINDOW_MS = 600;

export type EntranceRegistry = {
  reset: () => void;
  observeBirths: (keys: readonly string[], isInitialBuild: boolean) => void;
  shouldAnimate: (key: string) => boolean;
};

export function createEntranceRegistry(now: () => number = Date.now): EntranceRegistry {
  // key -> birth timestamp; 0 marks initial-build rows that never animate.
  const bornAt = new Map<string, number>();

  return {
    reset: () => {
      bornAt.clear();
    },
    observeBirths: (keys, isInitialBuild) => {
      const stamp = isInitialBuild ? 0 : now();
      for (const key of keys) {
        if (!bornAt.has(key)) {
          bornAt.set(key, stamp);
        }
      }
    },
    shouldAnimate: (key) => {
      const stamp = bornAt.get(key);
      if (stamp === undefined || stamp === 0) {
        return false;
      }
      return now() - stamp < ENTRANCE_ANIMATION_WINDOW_MS;
    },
  };
}
