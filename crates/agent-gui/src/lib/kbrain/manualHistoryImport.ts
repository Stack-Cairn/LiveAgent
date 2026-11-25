import { isTauriHost } from "../host";
import { migrateAllHistoryOnce } from "./historyMigration";
import { PI_HISTORY_DEFER_MS } from "./historyMigrationState";

export type HistoryImportState = {
  running: boolean;
  result?: Awaited<ReturnType<typeof migrateAllHistoryOnce>>;
  error?: string;
};

let state: HistoryImportState = { running: false };
let pending: Promise<void> | undefined;
const listeners = new Set<() => void>();
const importedListeners = new Set<() => void>();
export const getHistoryImportState = () => state;
export function subscribeHistoryImport(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function subscribeHistoryImported(listener: () => void) {
  importedListeners.add(listener);
  return () => {
    importedListeners.delete(listener);
  };
}
function update(next: HistoryImportState) {
  state = next;
  for (const listener of listeners) listener();
}

export function importOldConversations(): Promise<void> {
  if (pending) return pending;
  if (!isTauriHost())
    return Promise.reject(new Error("Legacy history import requires the desktop app"));
  update({ running: true });
  pending = (async () => {
    try {
      // An explicit user action retries everything, including known oversized/conflicting ones.
      const result = await migrateAllHistoryOnce({ retryKnownFailures: true });
      update({ running: false, result });
      if (result.results.length) for (const listener of importedListeners) listener();
      if (result.deferred > 0) scheduleDeferredHistoryImport();
    } catch (error) {
      update({ running: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}

/** Longest wait between checks while a session keeps being written. */
const MAX_DEFERRED_RETRY_MS = 30 * 60_000;
let deferredTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Picks up session files that were still being written when a pass ran, without a file
 * watcher: one timer re-runs the ordinary startup pass, which only reads files that changed
 * (unchanged ones are skipped by their recorded state). While some are still being written it
 * checks again, waiting longer each time.
 */
export function scheduleDeferredHistoryImport(delayMs = PI_HISTORY_DEFER_MS) {
  if (deferredTimer !== undefined || !isTauriHost()) return;
  deferredTimer = setTimeout(() => {
    deferredTimer = undefined;
    const next = Math.min(delayMs * 2, MAX_DEFERRED_RETRY_MS);
    // The manual import covers everything; check again once it is done.
    if (pending) {
      void pending.finally(() => scheduleDeferredHistoryImport(delayMs));
      return;
    }
    void migrateAllHistoryOnce()
      .then((result) => {
        if (result.results.length) for (const listener of importedListeners) listener();
        if (result.deferred > 0) scheduleDeferredHistoryImport(next);
      })
      .catch(() => scheduleDeferredHistoryImport(next));
  }, delayMs);
}
