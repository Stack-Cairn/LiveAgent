import { invoke } from "@liveagent/app/shims/tauriCore";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { sortSidebarConversations } from "@liveagent/ui/lib/sidebar/reconcile";
import { conversationMatchesScope } from "@liveagent/ui/lib/sidebar/scope";
import type {
  SidebarBackendEvent,
  SidebarConversation,
  SidebarScope,
  SidebarWorkdirSummary,
} from "@liveagent/ui/lib/sidebar/types";
import { createKBrainClient } from "./client";
import { summaryForSession } from "./history";
import {
  clearKBrainSessionId,
  ensureKBrainConversationId,
  getKBrainConversationId,
  kBrainStorageScope,
  withKBrainMappingBatch,
} from "./mapping";
import {
  getConfiguredKBrainConnection,
  subscribeKBrainRuntimeConnection,
} from "./runtimeConnection";
import { createKBrainSessionSync, type KBrainSessionSyncSnapshot } from "./sessionSync";
import { setKBrainMutationSync } from "./sessionSyncState";
import type { KBrainSessionChange } from "./types";

const events = new Set<(event: SidebarBackendEvent) => void>();
const healthListeners = new Set<() => void>();
const connections = new Set<(healthy: boolean) => void>();
let items: SidebarConversation[] = [];
let workdirs: SidebarWorkdirSummary[] = [];
let owners = 0;
let release: (() => void) | undefined;
let unsubscribeConnection: (() => void) | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let focusTimer: ReturnType<typeof setTimeout> | undefined;
let identity = "";
let sourceId = "";
let generation = "";
let backendEpoch = "";
let deliverySeq = 0;
let desired = new Map<string, SidebarConversation>();
let delivered = new Map<string, SidebarConversation>();
let needsSnapshot = true;
let publication: Promise<void> | undefined;
let publishAgain = false;
let lastFailure: string | undefined;
let gatewayIdentity = "";

export function getKBrainSidebarSyncError(): string | undefined {
  return lastFailure;
}

// Debug automation reads the coordinator actually owned by the application,
// rather than importing a second Vite module instance. No tokens or paths.
if (import.meta.env?.DEV && typeof window !== "undefined") {
  Object.defineProperty(window, "__LIVEAGENT_SESSION_SYNC_DIAGNOSTICS__", {
    configurable: true,
    value: () => ({
      healthy: sync.isHealthy(),
      error: lastFailure ? "Session synchronization unavailable" : undefined,
      sessionCount: items.length,
      workdirsCount: workdirs.length,
      subscriberCount: owners,
      revision: sync.getSnapshot()?.revision,
      epoch: sync.getSnapshot()?.epoch,
      generation,
      needsGatewaySnapshot: needsSnapshot,
      deliverySeq,
    }),
  });
}

function updateHealth(healthy: boolean, error?: unknown) {
  lastFailure = error ? (error instanceof Error ? error.message : String(error)) : undefined;
  for (const listener of healthListeners) listener();
  for (const listener of connections) listener(healthy);
  if (!healthy) needsSnapshot = true;
  queuePublication();
}

function sameConversation(a: SidebarConversation | undefined, b: SidebarConversation): boolean {
  return (
    !!a &&
    a.title === b.title &&
    a.updatedAt === b.updatedAt &&
    a.cwd === b.cwd &&
    a.model === b.model &&
    a.providerId === b.providerId &&
    a.messageCount === b.messageCount &&
    a.isPinned === b.isPinned &&
    a.pinnedAt === b.pinnedAt &&
    a.isShared === b.isShared &&
    a.sessionId === b.sessionId &&
    a.selectedModelJson === b.selectedModelJson &&
    a.createdAt === b.createdAt &&
    a.forkedFromSessionId === b.forkedFromSessionId
  );
}

async function publish(input: Record<string, unknown>): Promise<boolean> {
  const nativeSummary = (value: SidebarConversation) => ({
    ...value,
    messageCount: value.messageCount ?? 0,
    isPinned: value.isPinned === true,
    isShared: value.isShared === true,
  });
  if (Array.isArray(input.conversations)) {
    input = { ...input, conversations: input.conversations.map(nativeSummary) };
  }
  const event = input.event as { conversation?: SidebarConversation } | undefined;
  if (event?.conversation) {
    input = { ...input, event: { ...event, conversation: nativeSummary(event.conversation) } };
  }
  const result = await invoke<{ accepted: boolean; needsResync: boolean }>(
    "gateway_publish_history_sync_v2",
    { input },
  );
  return result.accepted && !result.needsResync;
}

function queuePublication() {
  publishAgain = true;
  if (!owners || publication) return;
  const requestGeneration = generation;
  publication = (async () => {
    while (owners && publishAgain && requestGeneration === generation) {
      publishAgain = false;
      const current = new Map(desired);
      const currentWorkdirs = workdirs;
      if (deliverySeq > Number.MAX_SAFE_INTEGER - current.size - delivered.size - 1) {
        generation = createUuid();
        deliverySeq = 0;
        needsSnapshot = true;
        publishAgain = true;
        return;
      }
      const base = { sourceId, generation, deliverySeq };
      try {
        const status = await invoke<{
          online: boolean;
          agentId: string;
          sessionId?: string;
          connectedSince?: number;
        }>("gateway_status");
        if (requestGeneration !== generation) return;
        if (!status.online) {
          gatewayIdentity = "";
          needsSnapshot = true;
          return;
        }
        const connection = `${status.agentId}\0${status.sessionId ?? status.connectedSince ?? ""}`;
        if (connection !== gatewayIdentity) {
          gatewayIdentity = connection;
          needsSnapshot = true;
        }
        if (!sync.isHealthy()) {
          await publish({ ...base, kind: "status", available: false });
          return;
        }
        if (needsSnapshot) {
          const accepted = await publish({
            ...base,
            kind: "snapshot",
            conversations: [...current.values()],
            workdirs: currentWorkdirs,
          });
          if (requestGeneration !== generation) return;
          if (!accepted) {
            needsSnapshot = true;
            return;
          }
          needsSnapshot = false;
        } else {
          for (const id of delivered.keys()) {
            if (current.has(id)) continue;
            deliverySeq += 1;
            if (
              !(await publish({
                sourceId,
                generation,
                deliverySeq,
                kind: "event",
                event: { kind: "delete", conversationId: id },
              }))
            ) {
              needsSnapshot = true;
              return;
            }
            if (requestGeneration !== generation) return;
          }
          for (const [id, conversation] of current) {
            if (sameConversation(delivered.get(id), conversation)) continue;
            deliverySeq += 1;
            if (
              !(await publish({
                sourceId,
                generation,
                deliverySeq,
                kind: "event",
                event: { kind: "upsert", conversationId: id, conversation },
              }))
            ) {
              needsSnapshot = true;
              return;
            }
            if (requestGeneration !== generation) return;
          }
        }
        if (requestGeneration !== generation) return;
        delivered = current;
        if (
          !(await publish({ sourceId, generation, deliverySeq, kind: "status", available: true }))
        )
          needsSnapshot = true;
      } catch {
        // The desktop still consumes K-brain. Recovery uses one coalesced full
        // state, rather than an unbounded queue of failed native invocations.
        needsSnapshot = true;
      }
    }
  })().finally(() => {
    publication = undefined;
    if (publishAgain && owners) queuePublication();
  });
}

function onSnapshot(snapshot: KBrainSessionSyncSnapshot) {
  if (backendEpoch && backendEpoch !== snapshot.epoch) {
    generation = createUuid();
    deliverySeq = 0;
    needsSnapshot = true;
    delivered = new Map();
  }
  backendEpoch = snapshot.epoch;
  items = withKBrainMappingBatch(() =>
    [...snapshot.sessions.values()].map((session) => {
      const id = ensureKBrainConversationId(session.id);
      const next = summaryForSession(session, id);
      const previous = desired.get(id);
      return previous && sameConversation(previous, next) ? previous : next;
    }),
  );
  workdirs = snapshot.workdirs.map((item) => ({
    path: item.cwd,
    conversationCount: item.count,
    updatedAt: Date.parse(item.updated_at) || 0,
  }));
  desired = new Map(items.map((item) => [item.id, item]));
  const event: SidebarBackendEvent = {
    kind: "reset",
    conversations: items,
    workdirs,
    sourceIdentity: `${sourceId}\0${snapshot.epoch}`,
  };
  for (const listener of events) listener(event);
  withKBrainMappingBatch(() => {
    for (const backendId of snapshot.deletedSessionIds ?? []) {
      const id = getKBrainConversationId(backendId);
      if (id) clearKBrainSessionId(id);
    }
  });
  // A bounded authoritative state can remove old browser aliases even if the
  // Gateway is disabled for the entire lifetime of the local deletion.
  if (snapshot.deletedSessionIds?.length) needsSnapshot = true;
  queuePublication();
}

function onChanges(input: {
  epoch: string;
  revision: string;
  changes: ReadonlyArray<KBrainSessionChange>;
  workdirs: KBrainSessionSyncSnapshot["workdirs"];
}) {
  // A live batch is already validated by the coordinator. Apply only the
  // changed rows to the sidebar and keep the authoritative maps in sync. A
  // complete reset is reserved for initial load, epoch changes, and recovery.
  if (!backendEpoch || backendEpoch !== input.epoch) {
    needsSnapshot = true;
    queuePublication();
    return;
  }
  const nextDesired = new Map(desired);
  const nextItems = new Map(items.map((item) => [item.id, item]));
  const pendingEvents: SidebarBackendEvent[] = [];
  withKBrainMappingBatch(() => {
    for (const change of input.changes) {
      const backendId = change.id.trim();
      if (!backendId) continue;
      const conversationId = getKBrainConversationId(backendId);
      if (change.kind === "delete" || !change.listed) {
        if (!conversationId) continue;
        // K-brain keeps a new session unlisted until its first message is
        // persisted. Only rows that were listed have anything to delete; a
        // never-listed session must leave the local pending row in place.
        if (change.kind !== "delete" && !nextDesired.has(conversationId)) continue;
        nextDesired.delete(conversationId);
        nextItems.delete(conversationId);
        pendingEvents.push({ kind: "delete", conversationId, authoritative: true });
        if (change.kind === "delete") clearKBrainSessionId(conversationId);
        continue;
      }
      const id = ensureKBrainConversationId(backendId);
      const next = summaryForSession(change.session, id);
      const previous = nextDesired.get(id);
      if (previous && sameConversation(previous, next)) continue;
      nextDesired.set(id, next);
      nextItems.set(id, next);
      pendingEvents.push({
        kind: "upsert",
        conversationId: id,
        conversation: next,
        authoritative: true,
      });
    }
  });
  desired = nextDesired;
  items = [...nextItems.values()];
  workdirs = input.workdirs.map((item) => ({
    path: item.cwd,
    conversationCount: item.count,
    updatedAt: Date.parse(item.updated_at) || 0,
  }));
  for (const event of pendingEvents) for (const listener of events) listener(event);
  for (const listener of events) listener({ kind: "workdirs", workdirs });
  queuePublication();
}

const sync = createKBrainSessionSync({
  client: createKBrainClient(),
  onSnapshot,
  onChanges,
  onHealth: updateHealth,
});

function connectionIdentity() {
  const connection = getConfiguredKBrainConnection();
  return `${kBrainStorageScope()}\0${connection?.baseUrl ?? ""}\0${connection?.token ?? ""}`;
}

function changedConnection() {
  const next = connectionIdentity();
  if (next === identity) return;
  identity = next;
  sourceId = `kbrain:${kBrainStorageScope()}`;
  generation = createUuid();
  backendEpoch = "";
  deliverySeq = 0;
  needsSnapshot = true;
  delivered = new Map();
  desired = new Map();
  items = [];
  workdirs = [];
  sync.restart();
}

function rescan() {
  if (globalThis.document?.visibilityState === "hidden" || focusTimer) return;
  focusTimer = setTimeout(() => {
    focusTimer = undefined;
    if (owners) sync.requestRescan();
  }, 150);
}

export const kBrainSidebarSync = {
  isHealthy: sync.isHealthy,
  subscribe(listener: (event: SidebarBackendEvent) => void) {
    events.add(listener);
    owners += 1;
    if (owners === 1) {
      changedConnection();
      setKBrainMutationSync({
        isHealthy: sync.isHealthy,
        reconcile: sync.restart,
        async confirm(id, epoch, revision) {
          try {
            await sync.waitForRevision(epoch, revision);
          } catch (error) {
            sync.restart();
            throw error;
          }
          return sync.getSnapshot()?.sessions.get(id);
        },
      });
      release = sync.acquire();
      unsubscribeConnection = subscribeKBrainRuntimeConnection(changedConnection);
      globalThis.addEventListener?.("focus", rescan);
      globalThis.document?.addEventListener("visibilitychange", rescan);
      heartbeat = setInterval(queuePublication, 15_000);
    } else if (sync.isHealthy()) listener({ kind: "reset", conversations: items, workdirs });
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      events.delete(listener);
      owners -= 1;
      if (!owners) {
        release?.();
        release = undefined;
        unsubscribeConnection?.();
        unsubscribeConnection = undefined;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
        if (focusTimer) clearTimeout(focusTimer);
        focusTimer = undefined;
        globalThis.removeEventListener?.("focus", rescan);
        globalThis.document?.removeEventListener("visibilitychange", rescan);
        setKBrainMutationSync(undefined);
        items = [];
        workdirs = [];
        desired.clear();
        delivered.clear();
        generation = createUuid();
      }
    };
  },
  subscribeHealth(listener: () => void) {
    healthListeners.add(listener);
    return () => {
      healthListeners.delete(listener);
    };
  },
  subscribeConnection(listener: (healthy: boolean) => void) {
    connections.add(listener);
    listener(sync.isHealthy());
    return () => {
      connections.delete(listener);
    };
  },
  list(page: number, pageSize: number, scope: SidebarScope) {
    const all = sortSidebarConversations(
      items.filter((item) => conversationMatchesScope(item, scope)),
    );
    return { items: all.slice((page - 1) * pageSize, page * pageSize), totalCount: all.length };
  },
  pinned: () => sortSidebarConversations(items.filter((item) => item.isPinned === true)),
  workdirs: () => workdirs,
};
