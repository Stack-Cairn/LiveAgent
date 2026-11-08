/**
 * WebUI-side live trajectory convergence.
 *
 * Persisted events come from `trajectory.fetch`; live events are split from ChatEvent before
 * the transcript seq gate. Exact replay duplicates are removed here and once more by the shared
 * ledger, so reconnect remains idempotent without letting the browser buffer grow unbounded.
 */

import { createTrajectoryLiveStore } from "@liveagent/ui/lib/trajectory/liveStore";
import type { TrajectoryEvent } from "@liveagent/ui/lib/trajectory/types";

type TrajectoryBearingEvent = {
  type: string;
  event?: unknown;
  conversation_id?: string | undefined;
};

const NOTIFY_COALESCE_MS = 250;

/** Minimum spacing between stats reloads driven by live usage reports. */
export const LIVE_USAGE_REFRESH_MS = 2_000;

const liveStore = createTrajectoryLiveStore({ notifyDelayMs: NOTIFY_COALESCE_MS });
const resetRevisions = new Map<string, number>();
const usageRevisions = new Map<string, number>();
const usageRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const usageRefreshPending = new Set<string>();

function bumpUsageRevision(key: string): void {
  usageRevisions.set(key, (usageRevisions.get(key) ?? 0) + 1);
  liveStore.invalidate();
}

/**
 * A K-brain run reports usage after each model call but does not stream trajectory events, so
 * the stats bar would otherwise stay frozen until the run ends. Each report schedules a stats
 * reload, at most one per LIVE_USAGE_REFRESH_MS per conversation.
 */
export function noteLiveUsageReport(conversationId: string | undefined): void {
  const key = typeof conversationId === "string" ? conversationId.trim() : "";
  if (key === "") return;
  if (usageRefreshTimers.has(key)) {
    usageRefreshPending.add(key);
    return;
  }
  bumpUsageRevision(key);
  const settle = () => {
    usageRefreshTimers.delete(key);
    if (!usageRefreshPending.delete(key)) return;
    bumpUsageRevision(key);
    usageRefreshTimers.set(key, setTimeout(settle, LIVE_USAGE_REFRESH_MS));
  };
  usageRefreshTimers.set(key, setTimeout(settle, LIVE_USAGE_REFRESH_MS));
}

/** Revision that advances when live usage reports arrive; the stats bar reloads on change. */
export function liveUsageRefreshRevision(conversationId: string): number {
  return usageRevisions.get(conversationId.trim()) ?? 0;
}

export function absorbTrajectoryChatEvent(event: TrajectoryBearingEvent): boolean {
  const conversationId =
    typeof event.conversation_id === "string" ? event.conversation_id.trim() : "";
  if (event.type !== "trajectory") return false;
  const payload = event.event;
  if (
    conversationId === "" ||
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return true;
  }

  liveStore.append(conversationId, [payload as TrajectoryEvent]);
  return true;
}

export function liveTrajectoryEvents(conversationId: string): readonly TrajectoryEvent[] {
  return liveStore.getSnapshot(conversationId);
}

export const subscribeLiveTrajectory = liveStore.subscribe;

export function liveTrajectoryRefreshRevision(conversationId: string): number {
  return resetRevisions.get(conversationId.trim()) ?? 0;
}

/** Backward-compatible name used by the view model for authoritative-tail invalidations. */
export const liveTrajectoryAuthoritativeRevision = liveTrajectoryRefreshRevision;

export function resetLiveTrajectoryForRebase(conversationId: string): void {
  const key = conversationId.trim();
  if (key === "") return;
  liveStore.clear(key);
  resetRevisions.set(key, (resetRevisions.get(key) ?? 0) + 1);
  liveStore.invalidate();
}

/** Conversation deletion/cache cleanup: release memory without requesting a fetch of deleted data. */
export function clearLiveTrajectory(conversationId: string): void {
  liveStore.clear(conversationId);
  const key = conversationId.trim();
  const timer = usageRefreshTimers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  usageRefreshTimers.delete(key);
  usageRefreshPending.delete(key);
}
