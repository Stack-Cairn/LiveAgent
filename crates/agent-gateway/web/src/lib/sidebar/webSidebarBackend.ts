import { listPinnedSidebarConversations } from "@liveagent/ui/lib/sidebar/pinnedHistory";
// Web-only SidebarBackend adapter over the gateway WebSocket client. NOT
// byte-mirrored: everything gateway-specific (snake_case summaries, epoch
// units, the activity-store bridge) is normalized here so the mirrored store
// never sees a wire shape.
//
// Timestamp units (verified against the Go handler + desktop writers):
// `history.list` / `history.event` / `history.workdirs` pass the desktop
// SQLite `updated_at` values through untouched (Go
// websocket_history_handlers.go + websocket_payloads.go do no conversion;
// the Rust bridge in gateway_bridge.rs is a pass-through of `MAX(updated_at)`
// et al.), and the desktop writes epoch **milliseconds** (`Date.now()` in the
// GUI history layer, `now_ms()` fallbacks in Rust). Legacy rows and any
// second-based producer are still normalized defensively: values below the
// seconds ceiling are multiplied to ms, everything else passes through.
// `chat.activity` / `running_conversations` use `UnixMilli()` explicitly.

import type { SidebarBackend, SidebarListPage } from "@liveagent/ui/lib/sidebar/backend";
import type {
  SidebarBackendEvent,
  SidebarConversation,
  SidebarScope,
} from "@liveagent/ui/lib/sidebar/types";
import type { ActivityStore } from "@/lib/chat/stream/activityStore";
import { formatConversationTitle } from "@/lib/chatUi";
import type {
  AgentStatus,
  ConversationSummary,
  GatewayHistoryEvent,
  GatewayHistorySyncSnapshot,
  GatewayHistorySyncStatus,
  HistoryList,
  HistoryListFilter,
  HistoryWorkdirsResponse,
} from "@/lib/gatewayTypes";

// Epoch values below this are seconds (up to year 2286); at or above, they
// are already milliseconds.
const SECONDS_EPOCH_CEILING = 10_000_000_000;

export function normalizeGatewayEpochMs(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value < SECONDS_EPOCH_CEILING ? value * 1000 : value;
}

// snake_case gateway ConversationSummary → SidebarConversation (all ms).
// provider/model intentionally fall back to "" instead of the selected model:
// sidebar rows must not rebuild when the user switches models.
export function normalizeGatewayConversationSummary(
  summary: ConversationSummary,
): SidebarConversation {
  const pinnedAt = normalizeGatewayEpochMs(summary.pinned_at);
  return {
    id: summary.id,
    title: formatConversationTitle(summary, summary.id),
    providerId: summary.provider_id ?? "",
    model: summary.model ?? "",
    sessionId: summary.session_id?.trim() ? summary.session_id : undefined,
    cwd: summary.cwd?.trim() ? summary.cwd : undefined,
    selectedModelJson: summary.selected_model_json?.trim()
      ? summary.selected_model_json
      : undefined,
    messageCount: summary.message_count,
    createdAt: normalizeGatewayEpochMs(summary.created_at),
    updatedAt: normalizeGatewayEpochMs(summary.updated_at),
    isPinned: summary.is_pinned === true,
    pinnedAt: summary.is_pinned === true && pinnedAt > 0 ? pinnedAt : null,
    isShared: summary.is_shared === true,
  };
}

// history.list `running_conversations` items → activity-store hydration shape.
export function normalizeRunningConversationItems(items: readonly unknown[] | undefined) {
  const normalized: Array<{
    conversationId: string;
    runId: string;
    state?: string;
    workdir?: string | null;
    updatedAt?: number;
  }> = [];
  for (const value of items ?? []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const source = value as Record<string, unknown>;
    const conversationId =
      typeof source.conversation_id === "string" ? source.conversation_id.trim() : "";
    const runId = typeof source.run_id === "string" ? source.run_id.trim() : "";
    if (!conversationId || !runId) {
      continue;
    }
    normalized.push({
      conversationId,
      runId,
      state: typeof source.state === "string" ? source.state : undefined,
      workdir: typeof source.cwd === "string" ? source.cwd : null,
      updatedAt:
        typeof source.updated_at === "number" && Number.isFinite(source.updated_at)
          ? source.updated_at
          : undefined,
    });
  }
  return normalized;
}

function scopeToHistoryListFilter(scope: SidebarScope): HistoryListFilter | null {
  switch (scope.kind) {
    case "workdir": {
      const cwd = scope.cwd.trim();
      return cwd ? { cwd } : null;
    }
    case "unscoped":
      return { cwdEmpty: true };
    case "all":
      // Gateway history is remote and may retain conversations whose local
      // project path is unavailable after a reload. The all scope must remain
      // unfiltered so those rows survive a reload.
      return null;
    case "none":
      return null;
  }
}

function agentConnectionIdentity(status: AgentStatus | null) {
  if (status?.online !== true) {
    return "";
  }
  const sessionId = status.session_id?.trim() ?? "";
  if (sessionId) {
    return `session:${sessionId}`;
  }
  const connectedSince = status.connected_since;
  return typeof connectedSince === "number" && Number.isFinite(connectedSince)
    ? `connected:${connectedSince}`
    : "";
}

type WebSidebarApi = {
  listHistory(page: number, pageSize: number, filter?: HistoryListFilter): Promise<HistoryList>;
  listHistoryWorkdirs(): Promise<HistoryWorkdirsResponse>;
  renameHistory(conversationId: string, title: string): Promise<ConversationSummary>;
  pinHistory(conversationId: string, isPinned: boolean): Promise<ConversationSummary>;
  setHistoryCwd(conversationId: string, cwd: string): Promise<ConversationSummary>;
  deleteHistory(conversationId: string): Promise<void>;
  subscribeHistory(listener: (event: GatewayHistoryEvent) => void): () => void;
  subscribeHistorySync?(
    listener: (
      update:
        | { kind: "status"; status: GatewayHistorySyncStatus }
        | { kind: "snapshot"; snapshot: GatewayHistorySyncSnapshot },
    ) => void,
  ): () => void;
  requestHistoryResync?(resyncToken: string): Promise<GatewayHistorySyncSnapshot>;
  acknowledgeHistoryResync?(
    snapshot: GatewayHistorySyncSnapshot,
    appliedDeliverySeq?: number,
  ): Promise<void>;
  subscribeConnection(listener: (connected: boolean) => void): () => void;
  subscribeStatus(listener: (status: AgentStatus | null, error: string | null) => void): () => void;
};

export type WebSidebarBackendDeps = {
  api: WebSidebarApi;
  // App-wide running authority (the dots). The adapter hydrates it from
  // history.list responses and bridges its diffs into store events.
  activityStore: ActivityStore;
  getProtectedConversationIds: () => Iterable<string>;
  getActivityKeepConversationIds?: () => ReadonlySet<string>;
  historySyncFreshnessMs?: number;
  historySyncRetryBaseMs?: number;
  historySyncRetryMaxMs?: number;
  historySyncMaxBufferedEvents?: number;
  historyMutationConfirmMs?: number;
};

export function createWebSidebarBackend(deps: WebSidebarBackendDeps): SidebarBackend {
  const { api, activityStore } = deps;
  const syncListeners = new Set<() => void>();
  let syncHealthy = false;
  let syncFreshnessTimer: ReturnType<typeof setTimeout> | null = null;
  let syncGeneration = "";
  let syncSeq = 0;
  const syncFreshnessMs = deps.historySyncFreshnessMs ?? 45_000;
  const syncRetryBaseMs = deps.historySyncRetryBaseMs ?? 1000;
  const syncRetryMaxMs = deps.historySyncRetryMaxMs ?? 30_000;
  const syncMaxBufferedEvents = deps.historySyncMaxBufferedEvents ?? 10_000;
  const mutationConfirmMs = deps.historyMutationConfirmMs ?? 2000;
  type MutationWaiter = {
    generation: string;
    matches(conversation: SidebarConversation | undefined): boolean;
    done(conversation: SidebarConversation | undefined | null): void;
  };
  const mutationWaiters = new Map<string, Set<MutationWaiter>>();
  let mutationResync: Promise<GatewayHistorySyncSnapshot> | null = null;

  const setSyncHealthy = (healthy: boolean) => {
    if (syncHealthy === healthy) return;
    syncHealthy = healthy;
    for (const listener of syncListeners) listener();
  };

  const armSyncFreshness = () => {
    if (syncFreshnessTimer !== null) clearTimeout(syncFreshnessTimer);
    syncFreshnessTimer = setTimeout(() => setSyncHealthy(false), syncFreshnessMs);
  };

  const settleMutationWaiters = (
    id: string,
    conversation: SidebarConversation | undefined,
    generation: string,
  ) => {
    const waiters = mutationWaiters.get(id);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      // Legacy mutation notifications do not carry the authoritative v2
      // generation. They may arrive just before the matching v2 projection;
      // keep the waiter alive instead of turning that harmless ordering into
      // an immediate stale-snapshot fallback and a false mutation failure.
      if (waiter.generation === generation && waiter.matches(conversation)) {
        waiter.done(conversation);
      }
    }
  };

  const beginMutationConfirmation = (
    id: string,
    matches: (conversation: SidebarConversation | undefined) => boolean,
  ) => {
    if (!syncHealthy || !api.requestHistoryResync || !api.acknowledgeHistoryResync) {
      return { promise: Promise.resolve(null), cancel: () => undefined, enabled: false };
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let waiter: MutationWaiter;
    const promise = new Promise<SidebarConversation | undefined | null>((resolve) => {
      const done = (conversation: SidebarConversation | undefined | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        mutationWaiters.get(id)?.delete(waiter);
        if (mutationWaiters.get(id)?.size === 0) mutationWaiters.delete(id);
        resolve(conversation);
      };
      waiter = { generation: syncGeneration, matches, done };
      mutationWaiters.set(id, (mutationWaiters.get(id) ?? new Set()).add(waiter));
      timer = setTimeout(() => done(null), mutationConfirmMs);
    });
    return { promise, cancel: () => waiter.done(null), enabled: true };
  };

  const confirmRemoteMutation = async (
    id: string,
    fallback: SidebarConversation | undefined,
    matches: (conversation: SidebarConversation | undefined) => boolean,
    observed: Promise<SidebarConversation | undefined | null>,
  ): Promise<SidebarConversation | undefined> => {
    if (!api.requestHistoryResync || !api.acknowledgeHistoryResync) return fallback;
    const eventResult = await observed;
    if (eventResult !== null) return eventResult;
    mutationResync ??= api
      .requestHistoryResync("")
      .then(async (snapshot) => {
        await api.acknowledgeHistoryResync?.(snapshot, snapshot.cut_delivery_seq);
        return snapshot;
      })
      .finally(() => {
        setTimeout(() => {
          mutationResync = null;
        }, 0);
      });
    const snapshot = await mutationResync;
    const raw = snapshot.conversations.find((item) => item.id === id);
    const conversation = raw ? normalizeGatewayConversationSummary(raw) : undefined;
    if (matches(conversation)) return conversation;
    throw new Error("Gateway history mutation result is awaiting synchronization");
  };

  const runConfirmedMutation = async (
    id: string,
    matches: (conversation: SidebarConversation | undefined) => boolean,
    mutate: () => Promise<ConversationSummary | undefined>,
  ): Promise<SidebarConversation | undefined> => {
    const confirmation = beginMutationConfirmation(id, matches);
    try {
      const response = await mutate();
      const fallback = response ? normalizeGatewayConversationSummary(response) : undefined;
      if (!confirmation.enabled) {
        confirmation.cancel();
        return fallback;
      }
      return await confirmRemoteMutation(id, fallback, matches, confirmation.promise);
    } catch (error) {
      confirmation.cancel();
      throw error;
    }
  };

  return {
    listPinnedConversations: () =>
      listPinnedSidebarConversations(async (page, pageSize) => {
        const response = await api.listHistory(page, pageSize);
        return {
          items: response.conversations.map(normalizeGatewayConversationSummary),
          totalCount: response.total_count,
        };
      }),
    async listConversations(page, pageSize, scope): Promise<SidebarListPage> {
      if (scope.kind === "none") {
        return { items: [], totalCount: 0 };
      }
      const filter = scopeToHistoryListFilter(scope);
      const response = await api.listHistory(page, pageSize, filter ?? undefined);
      // Authoritative running snapshot rides along with every page; keep the
      // activity store in sync exactly like the old reloadHistory did.
      activityStore.hydrate(normalizeRunningConversationItems(response.running_conversations), {
        keepConversationIds: deps.getActivityKeepConversationIds?.(),
      });
      return {
        items: response.conversations.map(normalizeGatewayConversationSummary),
        totalCount: Math.max(0, response.total_count),
      };
    },

    async listWorkdirs() {
      const response = await api.listHistoryWorkdirs();
      return response.workdirs.map((item) => ({
        path: item.path,
        conversationCount: item.conversationCount,
        updatedAt: normalizeGatewayEpochMs(item.updatedAt),
      }));
    },

    async renameConversation(id, title) {
      const result = await runConfirmedMutation(
        id,
        (item) => item?.title === title,
        () => api.renameHistory(id, title),
      );
      if (!result) throw new Error("Gateway history rename removed the conversation");
      return result;
    },

    async setConversationPinned(id, isPinned) {
      const result = await runConfirmedMutation(
        id,
        (item) => item?.isPinned === isPinned,
        () => api.pinHistory(id, isPinned),
      );
      if (!result) throw new Error("Gateway history pin removed the conversation");
      return result;
    },

    async setConversationCwd(id, cwd) {
      const result = await runConfirmedMutation(
        id,
        (item) => (item?.cwd ?? "") === cwd,
        () => api.setHistoryCwd(id, cwd),
      );
      if (!result) throw new Error("Gateway history move removed the conversation");
      return result;
    },

    async deleteConversation(id) {
      await runConfirmedMutation(
        id,
        (item) => item === undefined,
        async () => {
          await api.deleteHistory(id);
          return undefined;
        },
      );
    },

    // The single event subscription: gateway history.event upserts/deletes
    // plus a diff bridge over the activity store (running/idle transitions).
    subscribeEvents(listener: (event: SidebarBackendEvent) => void) {
      let recovering = false;
      let disposed = false;
      const buffered: GatewayHistoryEvent[] = [];
      let bufferOverflow = false;
      let retryAttempt = 0;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingToken = "";

      const bufferEvent = (event: GatewayHistoryEvent) => {
        if (buffered.length >= syncMaxBufferedEvents) {
          buffered.length = 0;
          bufferOverflow = true;
          setSyncHealthy(false);
          return;
        }
        buffered.push(event);
      };

      const scheduleRecover = (token: string, immediate = false) => {
        if (token) pendingToken = token;
        if (disposed || recovering || retryTimer !== null) return;
        const delay = immediate
          ? 0
          : Math.min(syncRetryMaxMs, syncRetryBaseMs * 2 ** Math.min(retryAttempt, 5));
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void recover(pendingToken);
        }, delay);
      };

      const validateEvents = (
        events: GatewayHistoryEvent[],
        generation: string,
        fromSeq: number,
      ) => {
        let nextSeq = fromSeq;
        const ordered = events
          .filter((event) => (event.delivery_seq ?? 0) > fromSeq)
          .sort((left, right) => (left.delivery_seq ?? 0) - (right.delivery_seq ?? 0));
        for (const event of ordered) {
          if (event.generation?.trim() !== generation || event.delivery_seq !== nextSeq + 1) {
            throw new Error("history synchronization replay has a sequence gap");
          }
          nextSeq = event.delivery_seq;
        }
        return { ordered, nextSeq };
      };

      const workdirsFor = (conversations: Iterable<SidebarConversation>) => {
        const workdirs = new Map<string, { conversationCount: number; updatedAt: number }>();
        for (const conversation of conversations) {
          const path = conversation.cwd?.trim();
          if (!path) continue;
          const current = workdirs.get(path) ?? { conversationCount: 0, updatedAt: 0 };
          current.conversationCount += 1;
          current.updatedAt = Math.max(current.updatedAt, conversation.updatedAt);
          workdirs.set(path, current);
        }
        return [...workdirs].map(([path, value]) => ({ path, ...value }));
      };

      const applyHistoryEvent = (event: GatewayHistoryEvent) => {
        const conversationId = event.conversation_id.trim();
        if (!conversationId) return;
        const generation = event.generation?.trim() ?? "";
        const seq = event.delivery_seq ?? 0;
        if (generation && syncGeneration && generation !== syncGeneration) {
          setSyncHealthy(false);
          bufferEvent(event);
          scheduleRecover("", true);
          return;
        }
        if (generation && seq > 0) {
          if (seq <= syncSeq) return;
          if (syncSeq > 0 && seq !== syncSeq + 1) {
            setSyncHealthy(false);
            bufferEvent(event);
            scheduleRecover("", true);
            return;
          }
          syncGeneration = generation;
          syncSeq = seq;
        }
        if (event.kind === "delete") {
          listener({
            kind: "delete",
            conversationId,
            ...(generation ? { authoritative: true } : {}),
          });
          if (generation) settleMutationWaiters(conversationId, undefined, generation);
          return;
        }
        const conversation = normalizeGatewayConversationSummary(event.conversation);
        listener({
          kind: "upsert",
          conversationId,
          conversation,
          ...(generation ? { authoritative: true } : {}),
        });
        if (generation) settleMutationWaiters(conversationId, conversation, generation);
      };

      const recover = async (token: string) => {
        if (recovering || !api.requestHistoryResync || !api.acknowledgeHistoryResync) return;
        recovering = true;
        setSyncHealthy(false);
        try {
          const snapshot = await api.requestHistoryResync(token);
          if (disposed) return;
          if (bufferOverflow) {
            bufferOverflow = false;
            buffered.length = 0;
            throw new Error("history synchronization event buffer overflowed");
          }
          const generation = snapshot.generation.trim();
          const projection = new Map(
            snapshot.conversations.map((item) => {
              const normalized = normalizeGatewayConversationSummary(item);
              return [normalized.id, normalized] as const;
            }),
          );
          const initial = buffered.splice(0);
          const replay = validateEvents(initial, generation, snapshot.cut_delivery_seq);
          for (const event of replay.ordered) {
            const id = event.conversation_id.trim();
            if (event.kind === "delete") projection.delete(id);
            else projection.set(id, normalizeGatewayConversationSummary(event.conversation));
          }
          syncGeneration = generation;
          syncSeq = replay.nextSeq;
          listener({
            kind: "reset",
            conversations: [...projection.values()],
            workdirs: workdirsFor(projection.values()),
            sourceIdentity: `${snapshot.source_id}\0${snapshot.generation}`,
          });
          for (const id of mutationWaiters.keys())
            settleMutationWaiters(id, projection.get(id), generation);
          await api.acknowledgeHistoryResync(snapshot, syncSeq);
          const afterAck = buffered.splice(0);
          const tail = validateEvents(afterAck, generation, syncSeq);
          for (const event of tail.ordered) applyHistoryEvent(event);
          if (!disposed) {
            retryAttempt = 0;
            pendingToken = "";
            setSyncHealthy(true);
            armSyncFreshness();
          }
        } catch {
          if (!disposed) {
            setSyncHealthy(false);
            retryAttempt += 1;
          }
        } finally {
          recovering = false;
          if (!disposed && (buffered.length > 0 || retryAttempt > 0)) scheduleRecover("");
        }
      };

      const unsubscribeHistory = api.subscribeHistory((event) => {
        if (recovering && event.generation?.trim()) {
          bufferEvent(event);
          return;
        }
        applyHistoryEvent(event);
      });
      const unsubscribeHistorySync = api.subscribeHistorySync?.((update) => {
        if (update.kind === "snapshot") return;
        armSyncFreshness();
        const { status } = update;
        if (!status.available || status.needs_resync) {
          setSyncHealthy(false);
          scheduleRecover(status.resync_token, true);
          return;
        }
        if (status.generation === syncGeneration && status.latest_delivery_seq === syncSeq) {
          setSyncHealthy(true);
        } else if (status.available) {
          scheduleRecover("", true);
        }
      });

      let runningIds = new Set<string>();
      const emitActivityDiff = () => {
        const snapshot = activityStore.getSnapshot();
        const next = new Set<string>();
        for (const [conversationId, activity] of snapshot.activities) {
          next.add(conversationId);
          if (!runningIds.has(conversationId)) {
            listener({
              kind: "running",
              conversationId,
              workdir: activity.workdir,
              updatedAt: normalizeGatewayEpochMs(activity.updatedAt) || undefined,
            });
          }
        }
        for (const conversationId of runningIds) {
          if (!next.has(conversationId)) {
            listener({ kind: "idle", conversationId });
          }
        }
        runningIds = next;
      };
      const unsubscribeActivity = activityStore.subscribe(emitActivityDiff);
      // Seed the current running set so a store (re)start sees active runs.
      emitActivityDiff();

      return () => {
        disposed = true;
        unsubscribeHistory();
        unsubscribeHistorySync?.();
        unsubscribeActivity();
        if (syncFreshnessTimer !== null) {
          clearTimeout(syncFreshnessTimer);
          syncFreshnessTimer = null;
        }
        if (retryTimer !== null) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      };
    },

    getReconcileIntervalMs() {
      return syncHealthy ? 300_000 : 60_000;
    },

    subscribeSyncState(listener) {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },

    subscribeConnection(listener) {
      // For the sidebar, "connected" means the whole read path works: the
      // browser⇄gateway socket is authenticated AND the desktop agent behind
      // it is online. The agent can drop and return while the socket never
      // blips (and after a gateway restart the socket recovers before the
      // agent has re-registered), so folding agent online-ness in here makes
      // the store's reconnect refetch fire the moment reads can actually
      // succeed — clearing any stale listError immediately instead of on the
      // next reconcile tick. Both sources replay their current state to late
      // subscribers; dedup keeps the store's disconnect latch edge-triggered.
      // Agent status is scoped to the socket epoch that delivered it. Keeping
      // an old `online=true` across browser-socket reconnect would announce
      // readiness as soon as auth succeeds, before the new socket's replayed
      // status arrives. Gateway deliberately sends auth response first and
      // status.event second, so freshness is an explicit part of the state.
      let socketConnected = false;
      let agentStatusFresh = false;
      let agentOnline = false;
      let agentIdentity = "";
      let lastEmitted: boolean | null = null;
      const emit = () => {
        const next = socketConnected && agentStatusFresh && agentOnline;
        if (next === lastEmitted) {
          return;
        }
        lastEmitted = next;
        listener(next);
      };
      const unsubscribeConnection = api.subscribeConnection((connected) => {
        socketConnected = connected === true;
        // A status snapshot from the previous socket cannot establish that
        // the freshly authenticated read path is ready.
        agentStatusFresh = false;
        agentOnline = false;
        emit();
      });
      const unsubscribeStatus = api.subscribeStatus((status) => {
        const nextOnline = status?.online === true;
        const nextIdentity = agentConnectionIdentity(status);
        const sessionReplaced =
          socketConnected &&
          agentStatusFresh &&
          agentOnline &&
          nextOnline &&
          agentIdentity !== "" &&
          nextIdentity !== "" &&
          agentIdentity !== nextIdentity;

        agentStatusFresh = socketConnected;
        agentOnline = nextOnline;
        if (nextOnline) {
          if (nextIdentity) {
            agentIdentity = nextIdentity;
          }
        } else {
          agentIdentity = "";
        }

        // Replacing the desktop AgentSession is an online→online transition,
        // but it closes every pending unary stream from the previous session.
        // Synthesize a reconnect edge so the sidebar invalidates that failed
        // generation and re-fetches against the new session.
        if (sessionReplaced && lastEmitted === true) {
          lastEmitted = false;
          listener(false);
        }
        emit();
      });
      return () => {
        unsubscribeConnection();
        unsubscribeStatus();
      };
    },

    getProtectedConversationIds: () => deps.getProtectedConversationIds(),
  };
}

// Inert backend for the pre-auth phase (no gateway client yet). The store is
// never started against it; it only has to satisfy the interface.
export function createIdleSidebarBackend(): SidebarBackend {
  const notReady = () => Promise.reject(new Error("Gateway client is not ready"));
  return {
    listConversations: () => Promise.resolve({ items: [], totalCount: 0 }),
    listWorkdirs: () => Promise.resolve([]),
    renameConversation: notReady,
    setConversationPinned: notReady,
    setConversationCwd: notReady,
    deleteConversation: notReady,
    subscribeEvents: () => () => {},
    getProtectedConversationIds: () => [],
  };
}
