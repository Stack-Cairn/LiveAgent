/**
 * WebUI-side live trajectory convergence.
 *
 * Persisted events come from `trajectory.fetch`; live events are split from ChatEvent before
 * the transcript seq gate. Exact replay duplicates are removed here and once more by the shared
 * ledger, so reconnect remains idempotent without letting the browser buffer grow unbounded.
 */

import type { TrajectoryEvent } from "@liveagent/ui/lib/trajectory/types";

type TrajectoryBearingEvent = {
  type: string;
  event?: unknown;
  conversation_id?: string | undefined;
};

const MAX_LIVE_EVENTS_PER_CONVERSATION = 20_000;
const MAX_LIVE_CONVERSATIONS = 32;
const NOTIFY_COALESCE_MS = 250;

type Listener = () => void;
type Bucket = {
  events: TrajectoryEvent[];
  identities: string[];
  identitySet: Set<string>;
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

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") return "null";
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function flushNotify() {
  notifyTimer = null;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn("[trajectory] live listener threw", error);
    }
  }
}

function notify() {
  if (notifyTimer !== null) return;
  notifyTimer = setTimeout(flushNotify, NOTIFY_COALESCE_MS);
  (notifyTimer as { unref?: () => void }).unref?.();
}

function evictLeastRecentlyUsedBuckets() {
  while (buckets.size > MAX_LIVE_CONVERSATIONS) {
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

  const identity = canonicalJson(payload);
  let bucket = buckets.get(conversationId);
  if (bucket === undefined) {
    bucket = {
      events: [],
      identities: [],
      identitySet: new Set(),
      version: 0,
      snapshot: EMPTY,
      snapshotVersion: -1,
      touchedAt: Date.now(),
    };
    buckets.set(conversationId, bucket);
  }
  bucket.touchedAt = Date.now();
  if (bucket.identitySet.has(identity)) return true;

  bucket.events.push(payload as TrajectoryEvent);
  bucket.identities.push(identity);
  bucket.identitySet.add(identity);
  if (bucket.events.length > MAX_LIVE_EVENTS_PER_CONVERSATION) {
    const removeCount = bucket.events.length - MAX_LIVE_EVENTS_PER_CONVERSATION;
    bucket.events.splice(0, removeCount);
    for (const removed of bucket.identities.splice(0, removeCount))
      bucket.identitySet.delete(removed);
  }
  bucket.version += 1;
  evictLeastRecentlyUsedBuckets();
  notify();
  return true;
}

export function liveTrajectoryEvents(conversationId: string): readonly TrajectoryEvent[] {
  const bucket = buckets.get(conversationId.trim());
  if (bucket === undefined) return EMPTY;
  if (bucket.snapshotVersion !== bucket.version) {
    bucket.snapshot = [...bucket.events];
    bucket.snapshotVersion = bucket.version;
  }
  return bucket.snapshot;
}

export function subscribeLiveTrajectory(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function liveTrajectoryRefreshRevision(conversationId: string): number {
  return resetRevisions.get(conversationId.trim()) ?? 0;
}

/** Backward-compatible name used by the view model for authoritative-tail invalidations. */
export const liveTrajectoryAuthoritativeRevision = liveTrajectoryRefreshRevision;

function resetLiveTrajectoryForRebase(conversationId: string): void {
  const key = conversationId.trim();
  if (key === "") return;
  buckets.delete(key);
  resetRevisions.set(key, (resetRevisions.get(key) ?? 0) + 1);
  notify();
}

/** Conversation deletion/cache cleanup: release memory without requesting a fetch of deleted data. */
export function clearLiveTrajectory(conversationId: string): void {
  if (buckets.delete(conversationId.trim())) notify();
}
