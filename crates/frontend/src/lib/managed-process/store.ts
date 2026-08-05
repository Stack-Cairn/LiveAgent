// Client mirror of the desktop-authoritative ManagedProcess registry. State
// only ever changes by feeding authoritative snapshots (initial fetch,
// change events, operation responses); there is no write-back path. The
// background-tasks dock tab derives its existence from this store and never
// touches persisted right-dock settings.

import { useSyncExternalStore } from "react";

import { backend } from "./backend";
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
