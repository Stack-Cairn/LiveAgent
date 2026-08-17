import { invoke, isTauri } from "@tauri-apps/api/core";
import { readWorkbenchLayoutCrashShadow, WORKBENCH_LAYOUT_STORAGE_KEY } from "./layoutStorage";

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
  /** Synchronous last-known-good copy used when the process is force-killed. */
  saveCrashShadow(payloadJson: string): void;
  save(input: { payloadJson: string; schemaVersion: number; revision: number }): void;
  /** Keep a diagnostic copy of a corrupted payload, then drop the original. */
  saveCorrupted(raw: string): void;
};

function readLocalStorage(): string | null {
  return readWorkbenchLayoutCrashShadow();
}

function writeLocalStorage(payloadJson: string): void {
  try {
    window.localStorage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, payloadJson);
  } catch {
    // Quota failures must never break the workbench.
  }
}

function payloadRevision(payloadJson: string | null): number {
  if (!payloadJson) return -1;
  try {
    const parsed = JSON.parse(payloadJson) as { revision?: unknown };
    return typeof parsed.revision === "number" && Number.isInteger(parsed.revision)
      ? parsed.revision
      : -1;
  } catch {
    return -1;
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
      const localPayload = readLocalStorage();
      try {
        const record = await invoke<PersistedWorkbenchLayoutRecord | null>(
          "workbench_layout_load",
          { scopeId: WORKBENCH_LAYOUT_SCOPE_ID },
        );
        if (record?.payloadJson) {
          return payloadRevision(localPayload) > record.revision
            ? localPayload
            : record.payloadJson;
        }
      } catch (error) {
        console.warn("failed to load workbench layout from sqlite", error);
        return localPayload;
      }
      // Migrate the pre-SQLite localStorage payload once, then keep SQLite
      // authoritative (the local copy stays as a harmless shadow).
      return localPayload;
    },
    saveCrashShadow(payloadJson) {
      writeLocalStorage(payloadJson);
    },
    save(input) {
      if (!native) {
        writeLocalStorage(input.payloadJson);
        return;
      }
      // Synchronous crash shadow: a force-quit can kill the process before the
      // async SQLite invoke commits. Startup compares revisions and chooses the
      // newer shadow, which the normal post-restore save migrates back to SQLite.
      writeLocalStorage(input.payloadJson);
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
