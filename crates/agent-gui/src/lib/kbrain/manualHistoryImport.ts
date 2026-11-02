import { isTauriHost } from "../host";
import { migrateAllHistoryOnce } from "./historyMigration";

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
    } catch (error) {
      update({ running: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}
