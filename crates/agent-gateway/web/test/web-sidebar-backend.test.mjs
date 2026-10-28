import assert from "node:assert/strict";
import test from "node:test";

import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const {
  createWebSidebarBackend,
  normalizeGatewayConversationSummary,
  normalizeGatewayEpochMs,
} = loader.loadModule("src/lib/sidebar/webSidebarBackend.ts");
const { createActivityStore } = loader.loadModule("src/lib/chat/stream/activityStore.ts");

const SECONDS = 1_700_000_000; // 2023 in seconds
const MILLIS = 1_700_000_000_000; // the same instant in ms

function summary(id, overrides = {}) {
  return {
    id,
    title: overrides.title ?? `Title ${id}`,
    created_at: overrides.created_at ?? SECONDS,
    updated_at: overrides.updated_at ?? SECONDS + 5,
    message_count: overrides.message_count ?? 3,
    provider_id: overrides.provider_id,
    model: overrides.model,
    session_id: overrides.session_id,
    cwd: overrides.cwd,
    is_pinned: overrides.is_pinned,
    pinned_at: overrides.pinned_at,
    is_shared: overrides.is_shared,
    selected_model_json: overrides.selected_model_json,
  };
}

function createFakeApi() {
  const state = {
    listResponse: { conversations: [], total_count: 0, running_conversations: [] },
    workdirs: [],
    historyListeners: new Set(),
    historySyncListeners: new Set(),
    connectionListeners: new Set(),
    statusListeners: new Set(),
    resyncCalls: 0,
    resyncHandler: null,
    acknowledgeHandler: null,
    calls: { list: [], workdirs: 0, rename: [], pin: [], move: [], delete: [] },
  };
  const api = {
    listHistory: async (page, pageSize, filter) => {
      state.calls.list.push({ page, pageSize, filter });
      return state.listResponse;
    },
    listHistoryWorkdirs: async () => {
      state.calls.workdirs += 1;
      return { workdirs: state.workdirs };
    },
    renameHistory: async (id, title) => {
      state.calls.rename.push({ id, title });
      return summary(id, { title });
    },
    pinHistory: async (id, isPinned) => {
      state.calls.pin.push({ id, isPinned });
      return summary(id, { is_pinned: isPinned, pinned_at: isPinned ? SECONDS : 0 });
    },
    setHistoryCwd: async (id, cwd) => {
      state.calls.move.push({ id, cwd });
      return summary(id, { cwd });
    },
    deleteHistory: async (id) => {
      state.calls.delete.push(id);
    },
    subscribeHistory: (listener) => {
      state.historyListeners.add(listener);
      return () => state.historyListeners.delete(listener);
    },
    subscribeHistorySync: (listener) => {
      state.historySyncListeners.add(listener);
      return () => state.historySyncListeners.delete(listener);
    },
    requestHistoryResync: async (resyncToken) => {
      state.resyncCalls += 1;
      if (state.resyncHandler) return state.resyncHandler(resyncToken);
      return {
        source_id: "source",
        generation: "generation",
        cut_delivery_seq: 2,
        resync_token: resyncToken || "generated",
        conversations: [summary("sync-1", { cwd: "/sync" })],
        workdirs: [{ path: "/sync", conversationCount: 1, updatedAt: MILLIS }],
      };
    },
    acknowledgeHistoryResync: async (snapshot, appliedDeliverySeq) => {
      state.acknowledged = snapshot;
      state.acknowledgedSeq = appliedDeliverySeq;
      if (state.acknowledgeHandler) return state.acknowledgeHandler(snapshot, appliedDeliverySeq);
    },
    subscribeConnection: (listener) => {
      state.connectionListeners.add(listener);
      return () => state.connectionListeners.delete(listener);
    },
    subscribeStatus: (listener) => {
      state.statusListeners.add(listener);
      return () => state.statusListeners.delete(listener);
    },
  };
  return {
    api,
    state,
    emitHistory: (event) => {
      for (const listener of state.historyListeners) listener(event);
    },
    emitHistorySync: (update) => {
      for (const listener of state.historySyncListeners) listener(update);
    },
    emitConnection: (connected) => {
      for (const listener of state.connectionListeners) listener(connected);
    },
    emitStatus: (status, error = null) => {
      for (const listener of state.statusListeners) listener(status, error);
    },
  };
}

test("normalizeGatewayEpochMs converts seconds and passes milliseconds through", () => {
  assert.equal(normalizeGatewayEpochMs(SECONDS), MILLIS);
  assert.equal(normalizeGatewayEpochMs(MILLIS), MILLIS);
  assert.equal(normalizeGatewayEpochMs(0), 0);
  assert.equal(normalizeGatewayEpochMs(-5), 0);
  assert.equal(normalizeGatewayEpochMs(undefined), 0);
});

test("history sync status replaces the remote projection and acknowledges the cut", async () => {
  const { api, state, emitHistorySync } = createFakeApi();
  const backend = createWebSidebarBackend({
    api,
    activityStore: createActivityStore(),
    getProtectedConversationIds: () => [],
  });
  const events = [];
  const syncChanges = [];
  const unsubscribeState = backend.subscribeSyncState(() => syncChanges.push(true));
  const unsubscribe = backend.subscribeEvents((event) => events.push(event));

  emitHistorySync({
    kind: "status",
    status: {
      source_id: "source",
      generation: "generation",
      latest_delivery_seq: 2,
      available: true,
      needs_resync: true,
      resync_token: "token-1",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(events[0].kind, "reset");
  assert.equal(events[0].conversations[0].id, "sync-1");
  assert.equal(events[0].workdirs[0].path, "/sync");
  assert.equal(state.acknowledged.resync_token, "token-1");
  assert.equal(backend.getReconcileIntervalMs(), 300_000);
  assert.ok(syncChanges.length > 0);

  unsubscribe();
  unsubscribeState();
});

test("failed and overflowing history recovery is bounded and never commits a partial reset", async () => {
  const { api, state, emitHistory, emitHistorySync } = createFakeApi();
  let releaseSnapshot;
  state.resyncHandler = () =>
    new Promise((resolve) => {
      releaseSnapshot = resolve;
    });
  const backend = createWebSidebarBackend({
    api,
    activityStore: createActivityStore(),
    getProtectedConversationIds: () => [],
    historySyncMaxBufferedEvents: 3,
    historySyncRetryBaseMs: 100,
  });
  const events = [];
  const unsubscribe = backend.subscribeEvents((event) => events.push(event));
  emitHistorySync({
    kind: "status",
    status: {
      source_id: "source",
      generation: "generation",
      latest_delivery_seq: 0,
      available: true,
      needs_resync: true,
      resync_token: "overflow-token",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 1; index <= 4; index += 1) {
    emitHistory({
      kind: "delete",
      conversation_id: `overflow-${index}`,
      source_id: "source",
      generation: "generation",
      delivery_seq: index,
    });
  }
  releaseSnapshot({
    source_id: "source",
    generation: "generation",
    cut_delivery_seq: 0,
    resync_token: "overflow-token",
    conversations: [],
    workdirs: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.some((event) => event.kind === "reset"), false);
  assert.equal(state.resyncCalls, 1, "recovery errors must back off instead of busy-looping");
  assert.equal(backend.getReconcileIntervalMs(), 60_000);
  unsubscribe();
});

test("history recovery replays a buffered tail atomically and acknowledges the applied sequence", async () => {
  const { api, state, emitHistory, emitHistorySync } = createFakeApi();
  let releaseSnapshot;
  state.resyncHandler = () =>
    new Promise((resolve) => {
      releaseSnapshot = resolve;
    });
  const backend = createWebSidebarBackend({
    api,
    activityStore: createActivityStore(),
    getProtectedConversationIds: () => [],
  });
  const events = [];
  const unsubscribe = backend.subscribeEvents((event) => events.push(event));
  emitHistorySync({
    kind: "status",
    status: {
      source_id: "source",
      generation: "generation",
      latest_delivery_seq: 2,
      available: true,
      needs_resync: true,
      resync_token: "tail-token",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  emitHistory({
    kind: "upsert",
    conversation_id: "tail",
    conversation: summary("tail"),
    source_id: "source",
    generation: "generation",
    delivery_seq: 3,
  });
  releaseSnapshot({
    source_id: "source",
    generation: "generation",
    cut_delivery_seq: 2,
    resync_token: "tail-token",
    conversations: [summary("base")],
    workdirs: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "reset");
  assert.deepEqual(
    events[0].conversations.map((item) => item.id).sort(),
    ["base", "tail"],
  );
  assert.equal(state.acknowledgedSeq, 3);
  unsubscribe();
});

test("a buffered sequence gap never commits a partial snapshot and retries with backoff", async () => {
  const { api, state, emitHistory, emitHistorySync } = createFakeApi();
  let releaseSnapshot;
  state.resyncHandler = () =>
    new Promise((resolve) => {
      releaseSnapshot = resolve;
    });
  const backend = createWebSidebarBackend({
    api,
    activityStore: createActivityStore(),
    getProtectedConversationIds: () => [],
    historySyncRetryBaseMs: 100,
  });
  const events = [];
  const unsubscribe = backend.subscribeEvents((event) => events.push(event));
  emitHistorySync({
    kind: "status",
    status: {
      source_id: "source",
      generation: "generation",
      latest_delivery_seq: 2,
      available: true,
      needs_resync: true,
      resync_token: "gap-token",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  emitHistory({
    kind: "delete",
    conversation_id: "missing-three",
    source_id: "source",
    generation: "generation",
    delivery_seq: 4,
  });
  releaseSnapshot({
    source_id: "source",
    generation: "generation",
    cut_delivery_seq: 2,
    resync_token: "gap-token",
    conversations: [summary("base")],
    workdirs: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.some((event) => event.kind === "reset"), false);
  assert.equal(state.resyncCalls, 1);
  unsubscribe();
});

test("history sync freshness expires and legacy clients retain the 60 second reconcile", async () => {
  const fixture = createFakeApi();
  const backend = createWebSidebarBackend({
    api: fixture.api,
    activityStore: createActivityStore(),
    getProtectedConversationIds: () => [],
    historySyncFreshnessMs: 10,
  });
  const unsubscribe = backend.subscribeEvents(() => undefined);
  fixture.emitHistorySync({
    kind: "status",
    status: {
      source_id: "source",
      generation: "generation",
      latest_delivery_seq: 2,
      available: true,
      needs_resync: true,
      resync_token: "fresh-token",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(backend.getReconcileIntervalMs(), 300_000);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(backend.getReconcileIntervalMs(), 60_000);
  unsubscribe();

  const oldFixture = createFakeApi();
  delete oldFixture.api.subscribeHistorySync;
  delete oldFixture.api.requestHistoryResync;
  delete oldFixture.api.acknowledgeHistoryResync;
  const legacy = createWebSidebarBackend({
    api: oldFixture.api,
    activityStore: createActivityStore(),
    getProtectedConversationIds: () => [],
  });
  const legacyEvents = [];
  const unsubscribeLegacy = legacy.subscribeEvents((event) => legacyEvents.push(event));
  oldFixture.emitHistory({ kind: "delete", conversation_id: "legacy" });
  assert.equal(legacy.getReconcileIntervalMs(), 60_000);
  assert.deepEqual(legacyEvents[0], { kind: "delete", conversationId: "legacy" });
  unsubscribeLegacy();
});

test("unsubscribing cancels pending history recovery retries", async () => {
  const { api, state, emitHistorySync } = createFakeApi();
  state.resyncHandler = async () => {
    throw new Error("offline");
  };
  const backend = createWebSidebarBackend({
    api,
    activityStore: createActivityStore(),
    getProtectedConversationIds: () => [],
    historySyncRetryBaseMs: 20,
  });
  const unsubscribe = backend.subscribeEvents(() => undefined);
  emitHistorySync({
    kind: "status",
    status: {
      source_id: "source",
      generation: "generation",
      latest_delivery_seq: 0,
      available: false,
      needs_resync: true,
      resync_token: "offline-token",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.resyncCalls, 1);
});

test("normalize maps snake_case summaries with second→ms timestamps and empty fallbacks", () => {
  const normalized = normalizeGatewayConversationSummary(
    summary("c1", {
      created_at: SECONDS,
      updated_at: SECONDS + 5,
      is_pinned: true,
      pinned_at: SECONDS + 2,
      session_id: "",
      cwd: "  ",
      is_shared: true,
    }),
  );
  assert.equal(normalized.id, "c1");
  assert.equal(normalized.title, "Title c1");
  assert.equal(normalized.providerId, "");
  assert.equal(normalized.model, "");
  assert.equal(normalized.sessionId, undefined);
  assert.equal(normalized.cwd, undefined);
  assert.equal(normalized.selectedModelJson, undefined);
  assert.equal(normalized.createdAt, MILLIS);
  assert.equal(normalized.updatedAt, (SECONDS + 5) * 1000);
  assert.equal(normalized.isPinned, true);
  assert.equal(normalized.pinnedAt, (SECONDS + 2) * 1000);
  assert.equal(normalized.isShared, true);

  // Already-ms values (the desktop store writes Date.now()) pass through.
  const passthrough = normalizeGatewayConversationSummary(
    summary("c2", { created_at: MILLIS, updated_at: MILLIS + 5000 }),
  );
  assert.equal(passthrough.createdAt, MILLIS);
  assert.equal(passthrough.updatedAt, MILLIS + 5000);

  // Blank titles fall back through formatConversationTitle.
  const untitled = normalizeGatewayConversationSummary(summary("c3", { title: "  " }));
  assert.notEqual(untitled.title.trim(), "");

  // Non-empty selected_model_json passes through; blank normalizes to undefined.
  const withSelection = normalizeGatewayConversationSummary(
    summary("c4", { selected_model_json: '{"customProviderId":"p1","model":"m1"}' }),
  );
  assert.equal(withSelection.selectedModelJson, '{"customProviderId":"p1","model":"m1"}');
  const blankSelection = normalizeGatewayConversationSummary(
    summary("c5", { selected_model_json: "  " }),
  );
  assert.equal(blankSelection.selectedModelJson, undefined);
});

test("listConversations normalizes items/workdirs and hydrates the activity store", async () => {
  const { api, state } = createFakeApi();
  const activityStore = createActivityStore();
  const backend = createWebSidebarBackend({
    api,
    activityStore,
    getProtectedConversationIds: () => [],
    getActivityKeepConversationIds: () => new Set(["kept-1"]),
  });

  state.listResponse = {
    conversations: [summary("c1"), summary("c2", { cwd: "/tmp/p" })],
    total_count: 7,
    running_conversations: [
      { conversation_id: "c2", run_id: "run-2", state: "running", cwd: "/tmp/p", updated_at: 10 },
      { conversation_id: "", run_id: "run-x" },
    ],
  };

  const page = await backend.listConversations(1, 80, { kind: "workdir", cwd: "/tmp/p" });
  assert.deepEqual(state.calls.list, [{ page: 1, pageSize: 80, filter: { cwd: "/tmp/p" } }]);
  assert.equal(page.totalCount, 7);
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].updatedAt, (SECONDS + 5) * 1000);
  // Activity store hydrated from running_conversations.
  assert.equal(activityStore.isRunning("c2"), true);
  assert.equal(activityStore.isRunning("c1"), false);

  // Remote all scope is unfiltered; none never hits the wire.
  await backend.listConversations(1, 80, { kind: "all" });
  assert.equal(state.calls.list[1].filter, undefined);
  await backend.listConversations(1, 80, { kind: "unscoped" });
  assert.deepEqual(state.calls.list[2].filter, { cwdEmpty: true });
  const emptyPage = await backend.listConversations(1, 80, { kind: "none" });
  assert.deepEqual(emptyPage, { items: [], totalCount: 0 });
  assert.equal(state.calls.list.length, 3);

  state.workdirs = [
    { path: "/tmp/p", conversationCount: 2, updatedAt: SECONDS },
    { path: "/tmp/q", conversationCount: 1, updatedAt: MILLIS },
  ];
  const workdirs = await backend.listWorkdirs();
  assert.equal(workdirs[0].updatedAt, MILLIS);
  assert.equal(workdirs[1].updatedAt, MILLIS);
});

test("subscribeEvents forwards history events normalized and bridges activity diffs", async () => {
  const { api, state, emitHistory } = createFakeApi();
  const activityStore = createActivityStore();
  const backend = createWebSidebarBackend({
    api,
    activityStore,
    getProtectedConversationIds: () => [],
  });

  const events = [];
  const unsubscribe = backend.subscribeEvents((event) => events.push(event));

  emitHistory({
    kind: "upsert",
    conversation_id: "c1",
    conversation: summary("c1", { updated_at: SECONDS + 9 }),
  });
  emitHistory({ kind: "delete", conversation_id: "c2" });
  emitHistory({ kind: "delete", conversation_id: "   " });

  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "upsert");
  assert.equal(events[0].conversationId, "c1");
  assert.equal(events[0].conversation.updatedAt, (SECONDS + 9) * 1000);
  assert.deepEqual(events[1], { kind: "delete", conversationId: "c2" });

  // Diff bridge: running set changes emit running/idle events with workdir.
  activityStore.applyActivityEvent({
    conversationId: "r1",
    runId: "run-1",
    running: true,
    state: "running",
    workdir: "/tmp/p",
    updatedAt: MILLIS,
  });
  assert.equal(events.length, 3);
  assert.equal(events[2].kind, "running");
  assert.equal(events[2].conversationId, "r1");
  assert.equal(events[2].workdir, "/tmp/p");
  assert.equal(events[2].updatedAt, MILLIS);

  activityStore.applyActivityEvent({
    conversationId: "r1",
    runId: "run-1",
    running: false,
    workdir: "/tmp/p",
    updatedAt: MILLIS + 1,
  });
  assert.equal(events.length, 4);
  assert.deepEqual(events[3], { kind: "idle", conversationId: "r1" });

  // Unsubscribe detaches both sources.
  unsubscribe();
  emitHistory({ kind: "delete", conversation_id: "c9" });
  activityStore.applyActivityEvent({
    conversationId: "r2",
    runId: "run-2",
    running: true,
    state: "running",
    workdir: null,
    updatedAt: MILLIS + 2,
  });
  assert.equal(events.length, 4);
  assert.equal(state.historyListeners.size, 0);
});

test("subscribeEvents seeds the already-running set on attach", () => {
  const { api } = createFakeApi();
  const activityStore = createActivityStore();
  activityStore.applyActivityEvent({
    conversationId: "pre-running",
    runId: "run-0",
    running: true,
    state: "running",
    workdir: "/tmp/p",
    updatedAt: MILLIS,
  });

  const backend = createWebSidebarBackend({
    api,
    activityStore,
    getProtectedConversationIds: () => [],
  });
  const events = [];
  const unsubscribe = backend.subscribeEvents((event) => events.push(event));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "running");
  assert.equal(events[0].conversationId, "pre-running");
  unsubscribe();
});

test("subscribeConnection waits for fresh status and detects online session replacement", () => {
  const { api, state, emitConnection, emitStatus } = createFakeApi();
  const activityStore = createActivityStore();
  const backend = createWebSidebarBackend({
    api,
    activityStore,
    getProtectedConversationIds: () => [],
  });
  const events = [];
  const unsubscribe = backend.subscribeConnection((connected) => events.push(connected));

  // Socket auth alone is insufficient; readiness belongs to the fresh status
  // snapshot replayed on that socket.
  emitConnection(true);
  assert.deepEqual(events, [false]);
  emitStatus({ online: true, session_id: "session-1" });
  assert.deepEqual(events, [false, true]);

  emitConnection(false);
  emitConnection(true);
  assert.deepEqual(events, [false, true, false]);
  emitStatus({ online: true, session_id: "session-1" });
  assert.deepEqual(events, [false, true, false, true]);

  // A seamless AgentSession replacement stays online at the gateway level,
  // yet every old pending history stream is closed. Surface a synthetic
  // reconnect edge so the sidebar re-fetches against the new session.
  emitStatus({ online: true, session_id: "session-2" });
  assert.deepEqual(events, [false, true, false, true, false, true]);

  emitStatus({ online: true, session_id: "session-2" });
  assert.deepEqual(events, [false, true, false, true, false, true]);

  unsubscribe();
  assert.equal(state.connectionListeners.size, 0);
  assert.equal(state.statusListeners.size, 0);
});

test("mutations delegate to the gateway api and normalize returned summaries", async () => {
  const { api, state } = createFakeApi();
  state.resyncHandler = (token) => {
    let conversations = [];
    if (!state.calls.delete.includes("c1")) {
      const latestMove = state.calls.move.at(-1);
      const latestPin = state.calls.pin.at(-1);
      const latestRename = state.calls.rename.at(-1);
      conversations = [
        summary("c1", {
          title: latestRename?.title,
          cwd: latestMove?.cwd,
          is_pinned: latestPin?.isPinned,
          pinned_at: latestPin?.isPinned ? SECONDS : 0,
        }),
      ];
    }
    return {
      source_id: "source",
      generation: "generation",
      cut_delivery_seq: state.resyncCalls,
      resync_token: token || `mutation-${state.resyncCalls}`,
      conversations,
      workdirs: [],
    };
  };
  const activityStore = createActivityStore();
  const backend = createWebSidebarBackend({
    api,
    activityStore,
    getProtectedConversationIds: () => ["protected-1", " "],
    historyMutationConfirmMs: 1,
  });

  const renamed = await backend.renameConversation("c1", "Next");
  assert.deepEqual(state.calls.rename, [{ id: "c1", title: "Next" }]);
  assert.equal(renamed.title, "Next");
  assert.equal(renamed.updatedAt, (SECONDS + 5) * 1000);

  const pinned = await backend.setConversationPinned("c1", true);
  assert.equal(pinned.isPinned, true);
  assert.equal(pinned.pinnedAt, MILLIS);

  const moved = await backend.setConversationCwd("c1", "/tmp/b");
  assert.deepEqual(state.calls.move, [{ id: "c1", cwd: "/tmp/b" }]);
  assert.equal(moved.cwd, "/tmp/b");

  await backend.deleteConversation("c1");
  assert.deepEqual(state.calls.delete, ["c1"]);
  assert.equal(state.resyncCalls, 0, "legacy mode must not call unsupported resync methods");

  assert.deepEqual([...backend.getProtectedConversationIds()], ["protected-1", " "]);
});

test("mutation completion returns the synchronized authority instead of a stale unary response", async () => {
  const { api, state, emitHistorySync } = createFakeApi();
  api.renameHistory = async () => summary("c1", { title: "stale response" });
  state.resyncHandler = (token) => ({
    source_id: "source",
    generation: "generation",
    cut_delivery_seq: 9,
    resync_token: token || "mutation-token",
    conversations: [summary("c1", { title: "requested", updated_at: SECONDS + 20 })],
    workdirs: [],
  });
  const backend = createWebSidebarBackend({
    api,
    activityStore: createActivityStore(),
    getProtectedConversationIds: () => [],
    historyMutationConfirmMs: 1,
  });
  const unsubscribe = backend.subscribeEvents(() => undefined);
  emitHistorySync({
    kind: "status",
    status: {
      source_id: "source",
      generation: "generation",
      latest_delivery_seq: 9,
      available: true,
      needs_resync: true,
      resync_token: "initial-token",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const confirmed = await backend.renameConversation("c1", "requested");
  assert.equal(confirmed.title, "requested");
  assert.equal(confirmed.updatedAt, (SECONDS + 20) * 1000);
  assert.equal(state.acknowledgedSeq, 9);
  unsubscribe();
});
