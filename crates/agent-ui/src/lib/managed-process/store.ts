// Client mirror of the desktop-authoritative ManagedProcess registry. State
// only ever changes by feeding authoritative snapshots (initial fetch,
// change events, operation responses, reconcile refreshes); there is no
// write-back path. The background-tasks dock tab derives its existence from
// this store combined with the synced right-dock visibility intent
// (RightDockProjectState.backgroundTasks).
//
// Change pushes are lossy in both transports (gateway drops broadcast frames
// under backpressure; a stalled desktop webview can miss Tauri events), so a
// missed push must never strand the mirror: refreshManagedProcessState pulls
// a fresh snapshot, and the store re-runs it whenever the page becomes
// visible again.

import { backend } from "@liveagent/app/lib/managed-process/backend";
import { useSyncExternalStore } from "react";
import type { ManagedProcessLog, ManagedProcessState } from "./types";

const EMPTY_STATE: ManagedProcessState = {
  ready: false,
  agentOnline: true,
  revision: 0,
  processes: [],
};

let state: ManagedProcessState = EMPTY_STATE;
const listeners = new Set<() => void>();
let initPromise: Promise<void> | null = null;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function getManagedProcessState(): ManagedProcessState {
  return state;
}

export function subscribeManagedProcesses(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function feedManagedProcessState(next: ManagedProcessState) {
  // Agent revisions are persisted and restart-safe; equal revisions are
  // accepted because the agent-online flag can flip without a bump.
  if (state.ready && next.revision < state.revision) {
    // Stale snapshot (e.g. a restarted gateway replaying its empty cache):
    // the process list is untrusted, but agentOnline is stamped by the
    // transport at write time — adopt it so the offline banner still shows.
    if (next.agentOnline !== state.agentOnline) {
      state = { ...state, agentOnline: next.agentOnline };
      emit();
    }
    return;
  }
  state = { ...next, ready: true };
  emit();
}

/** Idempotent: subscribes to backend change events and loads the initial snapshot. */
export function ensureManagedProcessInit(): Promise<void> {
  hookVisibilityRefresh();
  if (!initPromise) {
    initPromise = (async () => {
      const unsubscribe = backend.subscribe(feedManagedProcessState);
      try {
        feedManagedProcessState(await backend.fetchState());
      } catch (error) {
        // Failed init resets initPromise for a later retry; drop this
        // attempt's subscription so retries never stack duplicates.
        unsubscribe();
        throw error;
      }
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

/**
 * Pulls a fresh authoritative snapshot into the store. Also retries a failed
 * init (initPromise resets on failure), so callers can use it as a blanket
 * "make the mirror current" reconcile.
 */
export async function refreshManagedProcessState(): Promise<void> {
  await ensureManagedProcessInit();
  feedManagedProcessState(await backend.fetchState());
}

let visibilityHooked = false;

// A hidden webview/tab can miss change pushes (throttled webview, dropped
// broadcast frames); reconcile as soon as the page is visible again so the
// dock tab derives from current data even before the panel is opened.
function hookVisibilityRefresh() {
  if (visibilityHooked || typeof document === "undefined") {
    return;
  }
  visibilityHooked = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      return;
    }
    refreshManagedProcessState().catch(() => {
      // Offline agent or transport gap: keep the cached mirror; the next
      // visibility flip or panel reconcile retries.
    });
  });
}

export async function stopManagedProcess(id: string): Promise<void> {
  const next = await backend.stop(id);
  if (next) feedManagedProcessState(next);
}

export async function clearManagedProcesses(id?: string): Promise<void> {
  const next = await backend.clear(id);
  if (next) feedManagedProcessState(next);
}

export function readManagedProcessLog(id: string, maxBytes?: number): Promise<ManagedProcessLog> {
  return backend.readLog(id, maxBytes);
}

export function useManagedProcesses(): ManagedProcessState {
  return useSyncExternalStore(
    subscribeManagedProcesses,
    getManagedProcessState,
    getManagedProcessState,
  );
}
