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

const liveStore = createTrajectoryLiveStore({ notifyDelayMs: NOTIFY_COALESCE_MS });
const resetRevisions = new Map<string, number>();

export function absorbTrajectoryChatEvent(event: TrajectoryBearingEvent): boolean {
  const conversationId =
    typeof event.conversation_id === "string" ? event.conversation_id.trim() : "";
  if (event.type === "rebased") {
    if (conversationId !== "") resetLiveTrajectoryForRebase(conversationId);
    return false;
  }
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

function resetLiveTrajectoryForRebase(conversationId: string): void {
  const key = conversationId.trim();
  if (key === "") return;
  liveStore.clear(key);
  resetRevisions.set(key, (resetRevisions.get(key) ?? 0) + 1);
  liveStore.invalidate();
}

/** Conversation deletion/cache cleanup: release memory without requesting a fetch of deleted data. */
export function clearLiveTrajectory(conversationId: string): void {
  liveStore.clear(conversationId);
}
