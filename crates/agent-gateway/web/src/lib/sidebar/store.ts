// The sidebar state store: one external store per app instance holding the
// workspace/conversation sidebar domain — conversation list, workdir
// summaries, running set, and per-row mutations. Consumed from React through
// useSidebarSelector so a store commit re-renders selector subscribers only,
// never the page-level components. Byte-mirrored between agent-gui and
// agent-gateway/web; everything platform-specific arrives via SidebarBackend.
//
// Consistency policy (stale-while-revalidate):
// - a fetch failure never clears the visible list;
// - a scope switch first shows the cached slice of the new scope (syncing),
//   the skeleton appears only when nothing is cached (loading);
// - authoritative pages drop server-absent rows except pending drafts,
//   in-flight mutations, and adapter-protected ids — reconnects therefore
//   remove conversations deleted elsewhere instead of resurrecting them.

import { workspaceProjectPathKey } from "../settings";
import type { SidebarBackend } from "./backend";
import {
  applySidebarBackendEvent,
  mergeSidebarConversation,
  reconcileSidebarConversations,
  sortSidebarConversations,
} from "./reconcile";
import { conversationMatchesScope, filterConversationsForScope, sidebarScopeKey } from "./scope";
import type {
  SidebarBackendEvent,
  SidebarConversation,
  SidebarErrorCode,
  SidebarListStatus,
  SidebarMutationKind,
  SidebarRunningItem,
  SidebarScope,
  SidebarWorkdirSummary,
} from "./types";

const DEFAULT_PAGE_SIZE = 80;
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_WORKDIRS_FALLBACK_MS = 300_000;
const DEFAULT_WORKDIRS_DEBOUNCE_MS = 2_000;
const DEFAULT_POSITION_LOCK_MS = 1_200;

export type SidebarSnapshot = {
  revision: number;
  scopeKey: string;
  conversations: readonly SidebarConversation[];
  byId: ReadonlyMap<string, SidebarConversation>;
  totalCount: number;
  hasMore: boolean;
  listStatus: SidebarListStatus;
  isLoadingMore: boolean;
  listError: SidebarErrorCode | null;
  listErrorDetail: string | null;
  workdirs: readonly SidebarWorkdirSummary[];
  workdirActivity: ReadonlyMap<string, number>;
  runningConversationIds: ReadonlySet<string>;
  runningWorkdirPathKeys: ReadonlySet<string>;
  mutations: ReadonlyMap<string, SidebarMutationKind>;
  mutationErrors: ReadonlyMap<string, SidebarErrorCode>;
};

export type SidebarRefreshReason = "reconnect" | "interval" | "manual";
export type SidebarWorkdirsRefreshReason =
  | "initial"
  | "reconnect"
  | "delete"
  | "new-workdir"
  | "fallback";

export type SidebarStore = {
  getSnapshot(): SidebarSnapshot;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  setScope(scope: SidebarScope): void;
  refresh(options?: { reason?: SidebarRefreshReason }): Promise<void>;
  loadMore(): Promise<void>;
  refreshWorkdirs(reason: SidebarWorkdirsRefreshReason): Promise<void>;
  rename(id: string, title: string): Promise<boolean>;
  setPinned(id: string, isPinned: boolean): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  clearMutationError(id: string): void;
  upsertLocal(conversation: SidebarConversation): void;
  removeLocal(conversationId: string): void;
  applyRunningPatch(patch: {
    conversationId: string;
    running: boolean;
    workdir?: string | null;
    updatedAt?: number;
  }): void;
  hydrateRunning(items: readonly SidebarRunningItem[]): void;
  peek(conversationId: string): SidebarConversation | undefined;
  peekConversations(): readonly SidebarConversation[];
};

export type SidebarStoreOptions = {
  now?: () => number;
  pageSize?: number;
  reconcileIntervalMs?: number;
  workdirsFallbackMs?: number;
  workdirsDebounceMs?: number;
  positionLockMs?: number;
};

function persistedCount(conversations: readonly SidebarConversation[]) {
  let count = 0;
  for (const item of conversations) {
    if (item.isPending !== true) count += 1;
  }
  return count;
}

export function createSidebarStore(
  backend: SidebarBackend,
  options?: SidebarStoreOptions,
): SidebarStore {
  const now = options?.now ?? Date.now;
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  const reconcileIntervalMs = options?.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  const workdirsFallbackMs = options?.workdirsFallbackMs ?? DEFAULT_WORKDIRS_FALLBACK_MS;
  const workdirsDebounceMs = options?.workdirsDebounceMs ?? DEFAULT_WORKDIRS_DEBOUNCE_MS;
  const positionLockMs = options?.positionLockMs ?? DEFAULT_POSITION_LOCK_MS;

  let scope: SidebarScope = { kind: "none" };
  let byId = new Map<string, SidebarConversation>();
  let running = new Map<string, { workdir: string | null; updatedAt: number }>();
  const positionLocks = new Map<string, number>();
  let snapshot: SidebarSnapshot = {
    revision: 0,
    scopeKey: sidebarScopeKey(scope),
    conversations: [],
    byId,
    totalCount: 0,
    hasMore: false,
    listStatus: "initial",
    isLoadingMore: false,
    listError: null,
    listErrorDetail: null,
    workdirs: [],
    workdirActivity: new Map(),
    runningConversationIds: new Set(),
    runningWorkdirPathKeys: new Set(),
    mutations: new Map(),
    mutationErrors: new Map(),
  };
  const listeners = new Set<() => void>();

  let startCount = 0;
  let requestSeq = 0;
  // A first-page refresh supersedes every older pagination request for the
  // same scope. This is separate from requestSeq (scope/lifecycle invalidation):
  // reconnect refreshes do not change scope, but they must still prevent a
  // pre-disconnect loadMore failure from landing after the fresh page succeeds
  // and resurrecting a stale listError.
  let listGeneration = 0;
  let loadedPageCount = 0;
  let listRequestInFlight = false;
  let queuedListRequest: { authoritative: boolean } | null = null;
  let loadMoreRequestToken: symbol | null = null;
  let workdirsInFlight = false;
  let workdirsQueued = false;
  let wasDisconnected = false;
  let unsubscribeEvents: (() => void) | null = null;
  let unsubscribeConnection: (() => void) | null = null;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let workdirsFallbackTimer: ReturnType<typeof setInterval> | null = null;
  let workdirsDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  const commit = (patch: Partial<SidebarSnapshot>) => {
    snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 };
    for (const listener of listeners) {
      listener();
    }
  };

  const activePositionLockIds = () => {
    const nowMs = now();
    const ids: string[] = [];
    for (const [id, until] of positionLocks) {
      if (until > nowMs) {
        ids.push(id);
      } else {
        positionLocks.delete(id);
      }
    }
    return ids;
  };

  const retainedConversationIds = () => {
    const ids = new Set<string>(snapshot.mutations.keys());
    for (const id of backend.getProtectedConversationIds?.() ?? []) {
      const trimmed = id.trim();
      if (trimmed) ids.add(trimmed);
    }
    return ids;
  };

  const runningWorkdirPathKeysOf = (
    entries: ReadonlyMap<string, { workdir: string | null; updatedAt: number }>,
  ) => {
    const keys = new Set<string>();
    for (const entry of entries.values()) {
      const key = workspaceProjectPathKey(entry.workdir ?? "");
      if (key) keys.add(key);
    }
    return keys;
  };

  const bumpWorkdirActivity = (
    activity: ReadonlyMap<string, number>,
    workdir: string | null | undefined,
    updatedAt: number | undefined,
  ): ReadonlyMap<string, number> => {
    const key = workspaceProjectPathKey(workdir ?? "");
    const at = typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0;
    if (!key || at <= 0 || (activity.get(key) ?? 0) >= at) {
      return activity;
    }
    const next = new Map(activity);
    next.set(key, at);
    return next;
  };

  const knownWorkdirPathKeys = () => {
    const keys = new Set<string>();
    for (const workdir of snapshot.workdirs) {
      const key = workspaceProjectPathKey(workdir.path);
      if (key) keys.add(key);
    }
    return keys;
  };

  const scheduleWorkdirsDebounce = () => {
    if (workdirsDebounceTimer !== null || startCount === 0) {
      return;
    }
    workdirsDebounceTimer = setTimeout(() => {
      workdirsDebounceTimer = null;
      void refreshWorkdirs("new-workdir");
    }, workdirsDebounceMs);
  };

  const totalCountAfterListChange = (
    previous: readonly SidebarConversation[],
    next: readonly SidebarConversation[],
  ) => {
    const delta = persistedCount(next) - persistedCount(previous);
    return Math.max(persistedCount(next), snapshot.totalCount + delta);
  };

  const commitScopedList = (
    conversations: readonly SidebarConversation[],
    extra?: Partial<SidebarSnapshot>,
  ) => {
    const totalCount =
      extra?.totalCount ?? totalCountAfterListChange(snapshot.conversations, conversations);
    commit({
      ...extra,
      conversations,
      byId,
      totalCount,
      hasMore: persistedCount(conversations) < totalCount,
    });
  };

  const scopedFromCache = () =>
    sortSidebarConversations(filterConversationsForScope(Array.from(byId.values()), scope));

  const applyEvent = (event: SidebarBackendEvent) => {
    switch (event.kind) {
      case "upsert": {
        const incoming = event.conversation;
        const preserveUpdatedAtIds = activePositionLockIds();
        const merged = mergeSidebarConversation(byId.get(incoming.id), incoming, {
          preserveExistingUpdatedAt: preserveUpdatedAtIds.includes(incoming.id),
        });
        byId = new Map(byId);
        byId.set(merged.id, merged);
        const workdirActivity = bumpWorkdirActivity(
          snapshot.workdirActivity,
          merged.cwd,
          merged.updatedAt,
        );
        const cwdKey = workspaceProjectPathKey(merged.cwd ?? "");
        if (cwdKey && !knownWorkdirPathKeys().has(cwdKey)) {
          scheduleWorkdirsDebounce();
        }
        const inScope = conversationMatchesScope(merged, scope);
        const wasListed = snapshot.conversations.some((item) => item.id === merged.id);
        const next = inScope
          ? applySidebarBackendEvent(snapshot.conversations, event, {
              preserveUpdatedAtConversationIds: preserveUpdatedAtIds,
            })
          : wasListed
            ? snapshot.conversations.filter((item) => item.id !== merged.id)
            : snapshot.conversations;
        if (next === snapshot.conversations && workdirActivity === snapshot.workdirActivity) {
          commit({ byId });
          return;
        }
        commitScopedList(next, { workdirActivity, listError: null, listErrorDetail: null });
        return;
      }
      case "delete": {
        if (byId.has(event.conversationId)) {
          byId = new Map(byId);
          byId.delete(event.conversationId);
        }
        const next = snapshot.conversations.filter((item) => item.id !== event.conversationId);
        scheduleWorkdirsDebounce();
        if (next === snapshot.conversations || next.length === snapshot.conversations.length) {
          commit({ byId });
          return;
        }
        commitScopedList(next);
        return;
      }
      case "running": {
        const workdir =
          event.workdir?.trim() || byId.get(event.conversationId)?.cwd?.trim() || null;
        const updatedAt =
          typeof event.updatedAt === "number" && Number.isFinite(event.updatedAt)
            ? event.updatedAt
            : now();
        const current = running.get(event.conversationId);
        if (current && current.workdir === workdir && current.updatedAt >= updatedAt) {
          return;
        }
        running = new Map(running);
        running.set(event.conversationId, { workdir, updatedAt });
        commit({
          runningConversationIds: new Set(running.keys()),
          runningWorkdirPathKeys: runningWorkdirPathKeysOf(running),
          workdirActivity: bumpWorkdirActivity(snapshot.workdirActivity, workdir, updatedAt),
        });
        return;
      }
      case "idle": {
        if (!running.has(event.conversationId)) {
          return;
        }
        running = new Map(running);
        running.delete(event.conversationId);
        commit({
          runningConversationIds: new Set(running.keys()),
          runningWorkdirPathKeys: runningWorkdirPathKeysOf(running),
        });
        return;
      }
    }
  };

  // authoritative=false keeps the pagination cursor and stays silent about
  // status when rows are already visible; authoritative=true is the fresh
  // scope load path (cursor reset). Both reconcile with server-wins.
  const fetchFirstPage = async (authoritative: boolean) => {
    if (startCount === 0) {
      return;
    }
    if (listRequestInFlight) {
      queuedListRequest = {
        authoritative: (queuedListRequest?.authoritative ?? false) || authoritative,
      };
      return;
    }
    listRequestInFlight = true;
    try {
      let nextRequest: { authoritative: boolean } | null = { authoritative };
      while (nextRequest && startCount > 0) {
        queuedListRequest = null;
        await runFirstPageRequest(nextRequest.authoritative);
        nextRequest = queuedListRequest;
      }
    } finally {
      listRequestInFlight = false;
    }
  };

  const runFirstPageRequest = async (authoritative: boolean) => {
    const seq = requestSeq;
    const generation = ++listGeneration;
    // Release the current-generation pagination gate immediately. Its
    // transport promise may still settle later, but the generation checks
    // make that result inert and a fresh page-2 request need not wait for it.
    loadMoreRequestToken = null;
    const requestScope = scope;
    if (requestScope.kind === "none") {
      byId = new Map(byId);
      commit({
        conversations: [],
        byId,
        totalCount: 0,
        hasMore: false,
        listStatus: "ready",
        isLoadingMore: false,
        listError: null,
        listErrorDetail: null,
      });
      loadedPageCount = 0;
      return;
    }
    const hasRows = snapshot.conversations.length > 0;
    commit({
      listStatus: hasRows ? "syncing" : "loading",
      // The new first page owns pagination truth now. An older loadMore may
      // still settle at the transport layer, but its generation is stale and
      // its UI/result commits are ignored below.
      isLoadingMore: false,
    });
    try {
      const page = await backend.listConversations(1, pageSize, requestScope);
      if (seq !== requestSeq || generation !== listGeneration || startCount === 0) {
        return;
      }
      const authoritativeItems = filterConversationsForScope(page.items, requestScope);
      const reconciled = reconcileSidebarConversations(snapshot.conversations, authoritativeItems, {
        retainConversationIds: retainedConversationIds(),
        preserveUpdatedAtConversationIds: activePositionLockIds(),
        authoritativeComplete: page.items.length < pageSize,
      });
      byId = new Map(byId);
      const reconciledIds = new Set<string>();
      for (const item of reconciled) {
        byId.set(item.id, item);
        reconciledIds.add(item.id);
      }
      for (const item of snapshot.conversations) {
        if (!reconciledIds.has(item.id)) {
          byId.delete(item.id);
        }
      }
      const fetchedPageCount = page.items.length > 0 ? 1 : 0;
      loadedPageCount = authoritative
        ? fetchedPageCount
        : Math.max(loadedPageCount, fetchedPageCount);
      const totalCount = Math.max(0, page.totalCount);
      commit({
        conversations: reconciled,
        byId,
        totalCount,
        hasMore: page.items.length > 0 && persistedCount(reconciled) < totalCount,
        listStatus: "ready",
        listError: null,
        listErrorDetail: null,
      });
    } catch (error) {
      if (seq !== requestSeq || generation !== listGeneration || startCount === 0) {
        return;
      }
      commit({
        listStatus: "ready",
        listError: "listFailed",
        listErrorDetail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const refreshWorkdirs = async (reason: SidebarWorkdirsRefreshReason) => {
    void reason;
    if (startCount === 0) {
      return;
    }
    if (workdirsInFlight) {
      workdirsQueued = true;
      return;
    }
    workdirsInFlight = true;
    try {
      do {
        workdirsQueued = false;
        const seq = requestSeq;
        try {
          const workdirs = await backend.listWorkdirs();
          if (seq !== requestSeq || startCount === 0) {
            return;
          }
          let workdirActivity = snapshot.workdirActivity;
          for (const workdir of workdirs) {
            workdirActivity = bumpWorkdirActivity(workdirActivity, workdir.path, workdir.updatedAt);
          }
          commit({ workdirs, workdirActivity });
        } catch {
          // Workdir summaries are auxiliary (project ordering/activity); the
          // conversation list and the next scheduled refresh are unaffected.
          return;
        }
      } while (workdirsQueued && startCount > 0);
    } finally {
      workdirsInFlight = false;
    }
  };

  const runMutation = async (params: {
    id: string;
    kind: SidebarMutationKind;
    failureCode: SidebarErrorCode;
    blockedCode?: SidebarErrorCode;
    optimistic: (current: SidebarConversation) => SidebarConversation | null;
    execute: () => Promise<SidebarConversation | null>;
  }): Promise<boolean> => {
    const { id, kind, failureCode, blockedCode } = params;
    if (snapshot.mutations.has(id)) {
      return false;
    }
    if (blockedCode && running.has(id)) {
      const mutationErrors = new Map(snapshot.mutationErrors);
      mutationErrors.set(id, blockedCode);
      commit({ mutationErrors });
      return false;
    }
    const previous = byId.get(id);
    if (!previous) {
      return false;
    }
    const optimistic = params.optimistic(previous);
    const mutations = new Map(snapshot.mutations);
    mutations.set(id, kind);
    const mutationErrors = new Map(snapshot.mutationErrors);
    mutationErrors.delete(id);
    byId = new Map(byId);
    if (optimistic) {
      byId.set(id, optimistic);
      const rest = snapshot.conversations.filter((item) => item.id !== id);
      const next = conversationMatchesScope(optimistic, scope)
        ? sortSidebarConversations([optimistic, ...rest])
        : rest;
      commitScopedList(next, { mutations, mutationErrors });
    } else {
      byId.delete(id);
      commitScopedList(
        snapshot.conversations.filter((item) => item.id !== id),
        { mutations, mutationErrors },
      );
    }

    try {
      const confirmed = await params.execute();
      const nextMutations = new Map(snapshot.mutations);
      nextMutations.delete(id);
      if (confirmed) {
        positionLocks.set(id, now() + positionLockMs);
        const merged = mergeSidebarConversation(byId.get(id), confirmed, {
          preserveExistingUpdatedAt: true,
        });
        byId = new Map(byId);
        byId.set(id, merged);
        const rest = snapshot.conversations.filter((item) => item.id !== id);
        const next = conversationMatchesScope(merged, scope)
          ? sortSidebarConversations([merged, ...rest])
          : rest;
        commitScopedList(next, { mutations: nextMutations });
      } else {
        commit({ mutations: nextMutations, byId });
      }
      return true;
    } catch (error) {
      void error;
      const nextMutations = new Map(snapshot.mutations);
      nextMutations.delete(id);
      const nextErrors = new Map(snapshot.mutationErrors);
      nextErrors.set(id, failureCode);
      byId = new Map(byId);
      byId.set(id, previous);
      const rest = snapshot.conversations.filter((item) => item.id !== id);
      const next = conversationMatchesScope(previous, scope)
        ? sortSidebarConversations([previous, ...rest])
        : rest;
      commitScopedList(next, { mutations: nextMutations, mutationErrors: nextErrors });
      return false;
    }
  };

  const refresh = async (refreshOptions?: { reason?: SidebarRefreshReason }) => {
    void refreshOptions;
    await fetchFirstPage(false);
  };

  const loadMore = async () => {
    if (
      startCount === 0 ||
      loadMoreRequestToken !== null ||
      listRequestInFlight ||
      !snapshot.hasMore ||
      scope.kind === "none"
    ) {
      return;
    }
    const requestToken = Symbol("sidebar-load-more");
    loadMoreRequestToken = requestToken;
    const seq = requestSeq;
    const generation = listGeneration;
    const requestScope = scope;
    const pageNumber = loadedPageCount + 1;
    commit({ isLoadingMore: true });
    try {
      const page = await backend.listConversations(pageNumber, pageSize, requestScope);
      if (seq !== requestSeq || generation !== listGeneration || startCount === 0) {
        return;
      }
      let next = snapshot.conversations;
      for (const item of filterConversationsForScope(page.items, requestScope)) {
        next = reconcileMergePageItem(next, item);
      }
      byId = new Map(byId);
      for (const item of next) {
        byId.set(item.id, item);
      }
      if (page.items.length > 0) {
        loadedPageCount = pageNumber;
      }
      const totalCount = Math.max(0, page.totalCount);
      commit({
        conversations: next,
        byId,
        totalCount,
        hasMore: page.items.length > 0 && persistedCount(next) < totalCount,
        isLoadingMore: false,
        listError: null,
        listErrorDetail: null,
      });
    } catch (error) {
      if (seq !== requestSeq || generation !== listGeneration || startCount === 0) {
        return;
      }
      commit({
        isLoadingMore: false,
        listError: "loadMoreFailed",
        listErrorDetail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (loadMoreRequestToken === requestToken) {
        loadMoreRequestToken = null;
      }
    }
  };

  const reconcileMergePageItem = (
    conversations: readonly SidebarConversation[],
    item: SidebarConversation,
  ) => {
    const preserveUpdatedAtIds = activePositionLockIds();
    return applySidebarBackendEvent(
      conversations,
      { kind: "upsert", conversationId: item.id, conversation: item },
      { preserveUpdatedAtConversationIds: preserveUpdatedAtIds },
    );
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start: () => {
      startCount += 1;
      if (startCount > 1) {
        return;
      }
      unsubscribeEvents = backend.subscribeEvents(applyEvent);
      unsubscribeConnection =
        backend.subscribeConnection?.((connected) => {
          if (!connected) {
            wasDisconnected = true;
            return;
          }
          if (wasDisconnected) {
            wasDisconnected = false;
            void fetchFirstPage(false);
            void refreshWorkdirs("reconnect");
          }
        }) ?? null;
      reconcileTimer = setInterval(() => {
        void fetchFirstPage(false);
      }, reconcileIntervalMs);
      workdirsFallbackTimer = setInterval(() => {
        void refreshWorkdirs("fallback");
      }, workdirsFallbackMs);
      void refreshWorkdirs("initial");
      void fetchFirstPage(true);
    },

    stop: () => {
      if (startCount === 0) {
        return;
      }
      startCount -= 1;
      if (startCount > 0) {
        return;
      }
      requestSeq += 1;
      listGeneration += 1;
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      unsubscribeConnection?.();
      unsubscribeConnection = null;
      if (reconcileTimer !== null) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
      }
      if (workdirsFallbackTimer !== null) {
        clearInterval(workdirsFallbackTimer);
        workdirsFallbackTimer = null;
      }
      if (workdirsDebounceTimer !== null) {
        clearTimeout(workdirsDebounceTimer);
        workdirsDebounceTimer = null;
      }
      queuedListRequest = null;
      loadMoreRequestToken = null;
      workdirsQueued = false;
      wasDisconnected = false;
    },

    setScope: (nextScope) => {
      const nextKey = sidebarScopeKey(nextScope);
      if (nextKey === snapshot.scopeKey) {
        scope = nextScope;
        return;
      }
      scope = nextScope;
      requestSeq += 1;
      listGeneration += 1;
      loadMoreRequestToken = null;
      loadedPageCount = 0;
      const cached = scopedFromCache();
      commit({
        scopeKey: nextKey,
        conversations: cached,
        totalCount: persistedCount(cached),
        hasMore: false,
        listStatus: nextScope.kind === "none" ? "ready" : cached.length > 0 ? "syncing" : "loading",
        isLoadingMore: false,
        listError: null,
        listErrorDetail: null,
      });
      if (startCount > 0) {
        void fetchFirstPage(true);
      }
    },

    refresh,
    loadMore,
    refreshWorkdirs,

    rename: (id, title) =>
      runMutation({
        id,
        kind: "rename",
        failureCode: "renameFailed",
        blockedCode: "renameBlockedRunning",
        optimistic: (current) => ({ ...current, title }),
        execute: () => backend.renameConversation(id, title),
      }),

    setPinned: (id, isPinned) =>
      runMutation({
        id,
        kind: "pin",
        failureCode: "pinFailed",
        optimistic: (current) => ({
          ...current,
          isPinned,
          pinnedAt: isPinned ? now() : null,
        }),
        execute: () => backend.setConversationPinned(id, isPinned),
      }),

    remove: async (id) => {
      const removed = await runMutation({
        id,
        kind: "delete",
        failureCode: "deleteFailed",
        blockedCode: "deleteBlockedRunning",
        optimistic: () => null,
        execute: async () => {
          await backend.deleteConversation(id);
          return null;
        },
      });
      if (removed) {
        void refreshWorkdirs("delete");
      }
      return removed;
    },

    clearMutationError: (id) => {
      if (!snapshot.mutationErrors.has(id)) {
        return;
      }
      const mutationErrors = new Map(snapshot.mutationErrors);
      mutationErrors.delete(id);
      commit({ mutationErrors });
    },

    upsertLocal: (conversation) => {
      const merged = mergeSidebarConversation(byId.get(conversation.id), conversation);
      byId = new Map(byId);
      byId.set(merged.id, merged);
      const inScope = conversationMatchesScope(merged, scope);
      const wasVisible = snapshot.conversations.some((item) => item.id === merged.id);
      const workdirActivity = bumpWorkdirActivity(
        snapshot.workdirActivity,
        merged.cwd,
        merged.updatedAt,
      );
      if (!inScope && !wasVisible) {
        // 会话不属于当前作用域且原本不可见：保持 conversations 引用稳定。
        // 否则每次调用都会产生新列表引用，调用方若依据“列表里没有该会话”
        // 反复重插，会形成同步更新风暴（Maximum update depth exceeded）。
        commit({ byId, workdirActivity });
        return;
      }
      const rest = snapshot.conversations.filter((item) => item.id !== merged.id);
      const next = inScope ? sortSidebarConversations([merged, ...rest]) : rest;
      commitScopedList(next, { workdirActivity });
    },

    removeLocal: (conversationId) => {
      if (!byId.has(conversationId)) {
        return;
      }
      byId = new Map(byId);
      byId.delete(conversationId);
      commitScopedList(snapshot.conversations.filter((item) => item.id !== conversationId));
    },

    applyRunningPatch: (patch) => {
      applyEvent(
        patch.running
          ? {
              kind: "running",
              conversationId: patch.conversationId,
              workdir: patch.workdir,
              updatedAt: patch.updatedAt,
            }
          : { kind: "idle", conversationId: patch.conversationId },
      );
    },

    hydrateRunning: (items) => {
      const next = new Map<string, { workdir: string | null; updatedAt: number }>();
      for (const item of items) {
        const conversationId = item.conversationId.trim();
        if (!conversationId) continue;
        next.set(conversationId, {
          workdir: item.workdir?.trim() || null,
          updatedAt:
            typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
              ? item.updatedAt
              : now(),
        });
      }
      running = next;
      commit({
        runningConversationIds: new Set(running.keys()),
        runningWorkdirPathKeys: runningWorkdirPathKeysOf(running),
      });
    },

    peek: (conversationId) => byId.get(conversationId),
    peekConversations: () => snapshot.conversations,
  };
}
