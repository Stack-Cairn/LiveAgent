import type { TrajectoryEvent } from "./types";

type Listener = () => void;

type StoredEvent = {
  identity: string;
  event: TrajectoryEvent;
};

type Bucket = {
  entries: StoredEvent[];
  identities: Set<string>;
  version: number;
  snapshotVersion: number;
  snapshot: readonly TrajectoryEvent[];
  lastAccess: number;
};

export type TrajectoryLiveStore = {
  append: (conversationId: string, events: readonly TrajectoryEvent[]) => boolean;
  getSnapshot: (conversationId: string) => readonly TrajectoryEvent[];
  subscribe: (listener: Listener) => () => void;
  clear: (conversationId: string) => void;
  clearAll: () => void;
  invalidate: () => void;
  stats: () => { conversations: number; events: number };
};

export type TrajectoryLiveStoreOptions = {
  maxEventsPerConversation?: number;
  maxTotalEvents?: number;
  maxConversations?: number;
  notifyDelayMs?: number;
};

const EMPTY: readonly TrajectoryEvent[] = [];

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") return "null";
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

/** Full semantic identity: reconnect replay of an already-seen event is a no-op. */
export function trajectoryLiveEventIdentity(event: TrajectoryEvent): string {
  return canonicalJson(event);
}

export function createTrajectoryLiveStore(
  options: TrajectoryLiveStoreOptions = {},
): TrajectoryLiveStore {
  const maxPerConversation = Math.max(1, options.maxEventsPerConversation ?? 20_000);
  const maxTotalEvents = Math.max(maxPerConversation, options.maxTotalEvents ?? 100_000);
  const maxConversations = Math.max(1, options.maxConversations ?? 64);
  const notifyDelayMs = Math.max(0, options.notifyDelayMs ?? 100);

  const buckets = new Map<string, Bucket>();
  const listeners = new Set<Listener>();
  let totalEvents = 0;
  let accessClock = 0;
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;

  const flushNotify = () => {
    notifyTimer = null;
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.warn("[trajectory] live listener threw", error);
      }
    }
  };

  const notify = () => {
    if (notifyTimer !== null) return;
    notifyTimer = setTimeout(flushNotify, notifyDelayMs);
    (notifyTimer as { unref?: () => void }).unref?.();
  };

  const removeBucket = (conversationId: string) => {
    const bucket = buckets.get(conversationId);
    if (bucket === undefined) return false;
    buckets.delete(conversationId);
    totalEvents -= bucket.entries.length;
    return true;
  };

  const trimBucket = (bucket: Bucket, count: number) => {
    if (count <= 0) return;
    const removed = bucket.entries.splice(0, Math.min(count, bucket.entries.length));
    for (const entry of removed) bucket.identities.delete(entry.identity);
    totalEvents -= removed.length;
    bucket.version += 1;
  };

  const enforceBounds = (protectedConversationId: string) => {
    const protectedBucket = buckets.get(protectedConversationId);
    if (protectedBucket !== undefined && protectedBucket.entries.length > maxPerConversation) {
      trimBucket(protectedBucket, protectedBucket.entries.length - maxPerConversation);
    }

    while (buckets.size > maxConversations || totalEvents > maxTotalEvents) {
      let oldestId: string | null = null;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [conversationId, bucket] of buckets) {
        if (conversationId === protectedConversationId && buckets.size > 1) continue;
        if (bucket.lastAccess < oldestAccess) {
          oldestId = conversationId;
          oldestAccess = bucket.lastAccess;
        }
      }
      if (oldestId === null) break;
      if (oldestId === protectedConversationId && buckets.size === 1) {
        const only = buckets.get(oldestId);
        if (only === undefined || totalEvents <= maxTotalEvents) break;
        trimBucket(only, totalEvents - maxTotalEvents);
        break;
      }
      removeBucket(oldestId);
    }
  };

  return {
    append(conversationId, events) {
      const key = conversationId.trim();
      if (key === "" || events.length === 0) return false;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = {
          entries: [],
          identities: new Set(),
          version: 0,
          snapshotVersion: -1,
          snapshot: EMPTY,
          lastAccess: ++accessClock,
        };
        buckets.set(key, bucket);
      }
      bucket.lastAccess = ++accessClock;
      let changed = false;
      for (const event of events) {
        if (event === null || typeof event !== "object") continue;
        const identity = trajectoryLiveEventIdentity(event);
        if (bucket.identities.has(identity)) continue;
        bucket.identities.add(identity);
        bucket.entries.push({ identity, event });
        totalEvents += 1;
        changed = true;
      }
      if (!changed) return false;
      bucket.version += 1;
      enforceBounds(key);
      notify();
      return true;
    },

    getSnapshot(conversationId) {
      const bucket = buckets.get(conversationId.trim());
      if (bucket === undefined) return EMPTY;
      bucket.lastAccess = ++accessClock;
      if (bucket.snapshotVersion !== bucket.version) {
        bucket.snapshot = bucket.entries.map((entry) => entry.event);
        bucket.snapshotVersion = bucket.version;
      }
      return bucket.snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    clear(conversationId) {
      if (removeBucket(conversationId.trim())) notify();
    },

    clearAll() {
      if (buckets.size === 0) return;
      buckets.clear();
      totalEvents = 0;
      notify();
    },

    invalidate: notify,

    stats() {
      return { conversations: buckets.size, events: totalEvents };
    },
  };
}
