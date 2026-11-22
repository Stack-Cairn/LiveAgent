/**
 * The floor (user message row) the transcript is currently reading. It
 * changes many times during a scroll, so it lives in a store the floor rail
 * subscribes to instead of in the transcript host's state: a change
 * re-renders the rail alone, not the transcript or the app around it.
 */
export type ActiveFloorStore = {
  get: () => string | null;
  set: (rowKey: string | null) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createActiveFloorStore(): ActiveFloorStore {
  let current: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(rowKey) {
      if (rowKey === current) return;
      current = rowKey;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
