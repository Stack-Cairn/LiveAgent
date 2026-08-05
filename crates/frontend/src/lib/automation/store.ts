// Client mirror of the desktop-authoritative automation store. State only
// ever changes by feeding authoritative snapshots (initial fetch, change
// events, apply responses); there is no whole-list write-back path.

import { useSyncExternalStore } from "react";

import { backend } from "./backend";
import type { AutomationOp, AutomationSnapshot, CronSnapshot, HooksSnapshot } from "./types";

export type AutomationState = {
  ready: boolean;
  cron: CronSnapshot;
  hooks: HooksSnapshot;
};

const EMPTY_STATE: AutomationState = {
  ready: false,
  cron: { revision: 0, tasks: [] },
  hooks: { revision: 0, hooks: [] },
};

const MAX_APPLY_ATTEMPTS = 3;

let state: AutomationState = EMPTY_STATE;
const listeners = new Set<() => void>();
let initPromise: Promise<void> | null = null;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function getAutomationState(): AutomationState {
  return state;
}

export function subscribeAutomation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function feedCronSnapshot(snapshot: CronSnapshot) {
  if (state.ready && snapshot.revision < state.cron.revision) return;
  state = { ...state, ready: true, cron: snapshot };
  emit();
}

export function feedHooksSnapshot(snapshot: HooksSnapshot) {
  if (state.ready && snapshot.revision < state.hooks.revision) return;
  state = { ...state, ready: true, hooks: snapshot };
  emit();
}

export function feedAutomationSnapshot(snapshot: AutomationSnapshot) {
  feedCronSnapshot(snapshot.cron);
  feedHooksSnapshot(snapshot.hooks);
}

/** Idempotent: subscribes to backend change events and loads the initial snapshot. */
export function initAutomation(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      backend.subscribe({
        onCron: feedCronSnapshot,
        onHooks: feedHooksSnapshot,
      });
      feedAutomationSnapshot(await backend.fetchSnapshot());
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

export async function refreshAutomationSnapshot(): Promise<void> {
  feedAutomationSnapshot(await backend.fetchSnapshot());
}

export class AutomationConflictError extends Error {
  constructor() {
    super("Automation state changed concurrently; retry with the refreshed snapshot.");
    this.name = "AutomationConflictError";
  }
}

/**
 * Apply ops with optimistic concurrency: on a revision conflict the local
 * mirror is refreshed from the returned snapshot and the ops are rebased
 * (they are field-level patches, so a plain retry is safe).
 */
export async function applyCronOps(ops: AutomationOp[]): Promise<CronSnapshot> {
  await initAutomation();
  for (let attempt = 0; attempt < MAX_APPLY_ATTEMPTS; attempt += 1) {
    const response = await backend.cronApply({
      baseRevision: state.cron.revision,
      ops,
    });
    feedCronSnapshot(response.cron);
    if (response.status === "ok") {
      return response.cron;
    }
  }
  throw new AutomationConflictError();
}

export async function applyHookOps(ops: AutomationOp[]): Promise<HooksSnapshot> {
  await initAutomation();
  for (let attempt = 0; attempt < MAX_APPLY_ATTEMPTS; attempt += 1) {
    const response = await backend.hooksApply({
      baseRevision: state.hooks.revision,
      ops,
    });
    feedHooksSnapshot(response.hooks);
    if (response.status === "ok") {
      return response.hooks;
    }
  }
  throw new AutomationConflictError();
}

export function useAutomation(): AutomationState {
  return useSyncExternalStore(subscribeAutomation, getAutomationState, getAutomationState);
}

export const listCronRuns = backend.listRuns;
export const clearCronRuns = backend.clearRuns;
export const runCronNow = backend.runNow;
export const validateCronExpression = backend.validateCronExpression;
