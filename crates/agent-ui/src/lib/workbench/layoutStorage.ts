import { isWorkbenchLayoutValid } from "./invariants";
import type { WorkbenchLayout } from "./types";

export type WorkbenchLayoutStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const WORKBENCH_LAYOUT_STORAGE_KEY = "liveagent.sessionWorkbench.layout.v1";
export const WORKBENCH_LAYOUT_MAX_BYTES = 96 * 1024;

export function resolveWorkbenchLayoutStorage(): WorkbenchLayoutStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredWorkbenchLayout(
  storage: WorkbenchLayoutStorage | null = resolveWorkbenchLayoutStorage(),
  storageKey = WORKBENCH_LAYOUT_STORAGE_KEY,
): WorkbenchLayout | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey);
    if (!raw || raw.length > WORKBENCH_LAYOUT_MAX_BYTES) return null;
    const parsed = JSON.parse(raw) as WorkbenchLayout;
    return isWorkbenchLayoutValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoredWorkbenchLayout(
  layout: WorkbenchLayout,
  storage: WorkbenchLayoutStorage | null = resolveWorkbenchLayoutStorage(),
  storageKey = WORKBENCH_LAYOUT_STORAGE_KEY,
): boolean {
  if (!storage || !isWorkbenchLayoutValid(layout)) return false;
  try {
    const raw = JSON.stringify(layout);
    if (raw.length > WORKBENCH_LAYOUT_MAX_BYTES) return false;
    storage.setItem(storageKey, raw);
    return true;
  } catch {
    return false;
  }
}

export function clearStoredWorkbenchLayout(
  storage: WorkbenchLayoutStorage | null = resolveWorkbenchLayoutStorage(),
  storageKey = WORKBENCH_LAYOUT_STORAGE_KEY,
): void {
  try {
    storage?.removeItem(storageKey);
  } catch {
    // Storage is an optional recovery optimization; failures stay in memory.
  }
}
