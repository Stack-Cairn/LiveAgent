/**
 * Desktop-local trajectory event store.
 *
 * Recorder events are persisted asynchronously, so a mounted trajectory view cannot rely on
 * re-reading SQLite after every event. Keep a bounded in-memory tail and merge it with the
 * persisted window through the same idempotent ledger used by WebUI.
 */

import { createTrajectoryLiveStore } from "@liveagent/ui/lib/trajectory/liveStore";
import type { TrajectoryEvent } from "@liveagent/ui/lib/trajectory/types";

const NOTIFY_COALESCE_MS = 100;

const liveStore = createTrajectoryLiveStore({ notifyDelayMs: NOTIFY_COALESCE_MS });
const resetRevisions = new Map<string, number>();

export function absorbLocalTrajectoryEvent(
  conversationId: string,
  eventOrEvents: TrajectoryEvent | readonly TrajectoryEvent[],
): void {
  const key = conversationId.trim();
  if (key === "") return;
  const events: readonly TrajectoryEvent[] = Array.isArray(eventOrEvents)
    ? (eventOrEvents as readonly TrajectoryEvent[])
    : [eventOrEvents as TrajectoryEvent];
  liveStore.append(key, events);
}

export function localTrajectoryEvents(conversationId: string): readonly TrajectoryEvent[] {
  return liveStore.getSnapshot(conversationId);
}

export const subscribeLocalTrajectory = liveStore.subscribe;

export function localTrajectoryRefreshRevision(conversationId: string): number {
  return resetRevisions.get(conversationId.trim()) ?? 0;
}

export function clearLocalTrajectory(conversationId: string): void {
  const key = conversationId.trim();
  if (key === "") return;
  liveStore.clear(key);
  resetRevisions.set(key, (resetRevisions.get(key) ?? 0) + 1);
  liveStore.invalidate();
}

// Desktop-facing compatibility names. Keeping these aliases at the store boundary lets the
// recorder, chat page and existing tests migrate independently while sharing one implementation.
export const appendDesktopLiveTrajectory = absorbLocalTrajectoryEvent;
export const desktopLiveTrajectoryEvents = localTrajectoryEvents;
export const subscribeDesktopLiveTrajectory = subscribeLocalTrajectory;
export const desktopTrajectoryReloadVersion = localTrajectoryRefreshRevision;
export const invalidateDesktopTrajectory = clearLocalTrajectory;
export const clearDesktopLiveTrajectory = clearLocalTrajectory;
