import { useCallback, useEffect, useSyncExternalStore } from "react";

type LazyModuleState<T> = { value: T | null; failed: boolean };

/**
 * A code-split dependency that loads on first use, for code that runs during
 * render and cannot suspend (a plugin, a parser). `get()` stays null until the
 * load finishes; subscribers re-render then. A failed load can be retried.
 */
export type LazyModule<T> = {
  get(): T | null;
  /** Starts the load; after a failure, starts it again. */
  load(): Promise<T>;
  snapshot(): LazyModuleState<T>;
  subscribe(listener: () => void): () => void;
};

export function lazyModule<T>(load: () => Promise<T>): LazyModule<T> {
  let state: LazyModuleState<T> = { value: null, failed: false };
  let pending: Promise<T> | null = null;
  const listeners = new Set<() => void>();
  const update = (next: LazyModuleState<T>) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state.value,
    load() {
      if (state.value !== null) return Promise.resolve(state.value);
      if (!pending) {
        if (state.failed) update({ value: null, failed: false });
        pending = load().then(
          (value) => {
            pending = null;
            update({ value, failed: false });
            return value;
          },
          (error: unknown) => {
            pending = null;
            update({ value: null, failed: true });
            throw error;
          },
        );
      }
      return pending;
    },
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The module's value once loaded. While `wanted`, a mount starts the load; a
 * failure is reported as `failed` and `retry` starts it again.
 */
export function useLazyModule<T>(module: LazyModule<T>, wanted: boolean) {
  const state = useSyncExternalStore(module.subscribe, module.snapshot, module.snapshot);
  useEffect(() => {
    if (wanted && state.value === null && !state.failed) {
      module.load().catch(() => {
        // Reported through `failed`.
      });
    }
  }, [module, wanted, state]);
  const retry = useCallback(() => {
    // A Retry that fails again reloads the page, as in OnDemand: the browser
    // keeps a failed import cached, so only a reload fetches the chunk afresh.
    module.load().catch(() => window.location.reload());
  }, [module]);
  return { value: state.value, failed: state.failed, retry };
}
