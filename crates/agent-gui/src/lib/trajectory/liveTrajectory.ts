/**
 * Desktop-local trajectory event store.
 *
 * Recorder events are persisted asynchronously, so a mounted trajectory view cannot rely on
 * re-reading SQLite after every event. Keep a bounded in-memory tail and merge it with the
 * persisted window through the same idempotent ledger used by WebUI.
 */

import type { TrajectoryEvent } from "@liveagent/ui/lib/trajectory/types";

const MAX_EVENTS_PER_CONVERSATION = 20_000;
const MAX_CONVERSATIONS = 32;
const NOTIFY_COALESCE_MS = 100;

type Listener = () => void;
type Bucket = {
  events: TrajectoryEvent[];
  version: number;
  snapshot: readonly TrajectoryEvent[];
  snapshotVersion: number;
  touchedAt: number;
};

const EMPTY: readonly TrajectoryEvent[] = [];
const buckets = new Map<string, Bucket>();
const resetRevisions = new Map<string, number>();
const listeners = new Set<Listener>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function flushNotify() {
  notifyTimer = null;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn("[trajectory] desktop live listener threw", error);
    }
  }
}

function notify() {
  if (notifyTimer !== null) return;
  notifyTimer = setTimeout(flushNotify, NOTIFY_COALESCE_MS);
  (notifyTimer as { unref?: () => void }).unref?.();
}

function evictLeastRecentlyUsed() {
  while (buckets.size > MAX_CONVERSATIONS) {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of buckets) {
      if (bucket.touchedAt < oldestAt) {
        oldestAt = bucket.touchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return;
    buckets.delete(oldestKey);
  }
}

export function absorbLocalTrajectoryEvent(
  conversationId: string,
  eventOrEvents: TrajectoryEvent | readonly TrajectoryEvent[],
): void {
  const key = conversationId.trim();
  if (key === "") return;
  const events: readonly TrajectoryEvent[] = Array.isArray(eventOrEvents)
    ? (eventOrEvents as readonly TrajectoryEvent[])
    : [eventOrEvents as TrajectoryEvent];
  if (events.length === 0) return;

  let bucket = buckets.get(key);
  if (bucket === undefined) {
    bucket = {
      events: [],
      version: 0,
      snapshot: EMPTY,
      snapshotVersion: -1,
      touchedAt: Date.now(),
    };
    buckets.set(key, bucket);
  }
  bucket.events.push(...events);
  if (bucket.events.length > MAX_EVENTS_PER_CONVERSATION) {
    bucket.events.splice(0, bucket.events.length - MAX_EVENTS_PER_CONVERSATION);
  }
  bucket.version += 1;
  bucket.touchedAt = Date.now();
  evictLeastRecentlyUsed();
  notify();
}

export function localTrajectoryEvents(conversationId: string): readonly TrajectoryEvent[] {
  const bucket = buckets.get(conversationId.trim());
  if (bucket === undefined) return EMPTY;
  if (bucket.snapshotVersion !== bucket.version) {
    bucket.snapshot = [...bucket.events];
    bucket.snapshotVersion = bucket.version;
  }
  return bucket.snapshot;
}

export function subscribeLocalTrajectory(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function localTrajectoryRefreshRevision(conversationId: string): number {
  return resetRevisions.get(conversationId.trim()) ?? 0;
}

export function clearLocalTrajectory(conversationId: string): void {
  const key = conversationId.trim();
  if (key === "") return;
  buckets.delete(key);
  resetRevisions.set(key, (resetRevisions.get(key) ?? 0) + 1);
  notify();
}

// Desktop-facing compatibility names. Keeping these aliases at the store boundary lets the
// recorder, chat page and existing tests migrate independently while sharing one implementation.
export const appendDesktopLiveTrajectory = absorbLocalTrajectoryEvent;
export const desktopLiveTrajectoryEvents = localTrajectoryEvents;
export const subscribeDesktopLiveTrajectory = subscribeLocalTrajectory;
export const desktopTrajectoryReloadVersion = localTrajectoryRefreshRevision;
export const invalidateDesktopTrajectory = clearLocalTrajectory;
export const clearDesktopLiveTrajectory = clearLocalTrajectory;
