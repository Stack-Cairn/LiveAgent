import { invoke, isTauri } from "@tauri-apps/api/core";
import { WORKBENCH_LAYOUT_STORAGE_KEY } from "./useWindowWorkbench";

const WORKBENCH_LAYOUT_SCOPE_ID = "main-window";

type PersistedWorkbenchLayoutRecord = {
  scopeId: string;
  schemaVersion: number;
  revision: number;
  payloadJson: string;
  updatedAt: number;
};

export type WorkbenchLayoutPersistence = {
  load(): Promise<string | null>;
  save(input: { payloadJson: string; schemaVersion: number; revision: number }): void;
  /** Keep a diagnostic copy of a corrupted payload, then drop the original. */
  saveCorrupted(raw: string): void;
};

function readLocalStorage(): string | null {
  try {
    return window.localStorage.getItem(WORKBENCH_LAYOUT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLocalStorage(payloadJson: string): void {
  try {
    window.localStorage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, payloadJson);
  } catch {
    // Quota failures must never break the workbench.
  }
}

/**
 * Native persistence for the window workbench layout: the SQLite
 * `workbench_layout` table on desktop (never synced through the Gateway),
 * with a one-shot migration from the earlier localStorage payload and a
 * localStorage fallback for browser dev sessions.
 */
export function createWorkbenchLayoutPersistence(): WorkbenchLayoutPersistence {
  const native = isTauri();
  return {
    async load() {
      if (!native) return readLocalStorage();
      try {
        const record = await invoke<PersistedWorkbenchLayoutRecord | null>(
          "workbench_layout_load",
          { scopeId: WORKBENCH_LAYOUT_SCOPE_ID },
        );
        if (record?.payloadJson) return record.payloadJson;
      } catch (error) {
        console.warn("failed to load workbench layout from sqlite", error);
        return readLocalStorage();
      }
      // Migrate the pre-SQLite localStorage payload once, then keep SQLite
      // authoritative (the local copy stays as a harmless shadow).
      return readLocalStorage();
    },
    save(input) {
      if (!native) {
        writeLocalStorage(input.payloadJson);
        return;
      }
      void invoke("workbench_layout_save", {
        scopeId: WORKBENCH_LAYOUT_SCOPE_ID,
        schemaVersion: input.schemaVersion,
        revision: input.revision,
        payloadJson: input.payloadJson,
      }).catch((error) => {
        console.warn("failed to persist workbench layout", error);
        writeLocalStorage(input.payloadJson);
      });
    },
    saveCorrupted(raw) {
      try {
        window.localStorage.setItem(`${WORKBENCH_LAYOUT_STORAGE_KEY}.corrupted`, raw);
        window.localStorage.removeItem(WORKBENCH_LAYOUT_STORAGE_KEY);
      } catch {
        // Diagnostics only.
      }
      if (!native) return;
      // Drop the SQLite row too, otherwise the next launch reloads the same
      // corrupted payload.
      void invoke("workbench_layout_delete", {
        scopeId: WORKBENCH_LAYOUT_SCOPE_ID,
      }).catch((error) => {
        console.warn("failed to drop corrupted workbench layout", error);
      });
    },
  };
}
