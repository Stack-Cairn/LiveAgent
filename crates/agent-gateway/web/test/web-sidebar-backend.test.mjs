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
  };
}

function createFakeApi() {
  const state = {
    listResponse: { conversations: [], total_count: 0, running_conversations: [] },
    workdirs: [],
    historyListeners: new Set(),
    connectionListeners: new Set(),
    calls: { list: [], workdirs: 0, rename: [], pin: [], delete: [] },
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
    deleteHistory: async (id) => {
      state.calls.delete.push(id);
    },
    subscribeHistory: (listener) => {
      state.historyListeners.add(listener);
      return () => state.historyListeners.delete(listener);
    },
    subscribeConnection: (listener) => {
      state.connectionListeners.add(listener);
      return () => state.connectionListeners.delete(listener);
    },
  };
  return {
    api,
    state,
    emitHistory: (event) => {
      for (const listener of state.historyListeners) listener(event);
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

  // Unscoped scope maps to cwdEmpty; none never hits the wire.
  await backend.listConversations(1, 80, { kind: "unscoped" });
  assert.deepEqual(state.calls.list[1].filter, { cwdEmpty: true });
  const emptyPage = await backend.listConversations(1, 80, { kind: "none" });
  assert.deepEqual(emptyPage, { items: [], totalCount: 0 });
  assert.equal(state.calls.list.length, 2);

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

test("mutations delegate to the gateway api and normalize returned summaries", async () => {
  const { api, state } = createFakeApi();
  const activityStore = createActivityStore();
  const backend = createWebSidebarBackend({
    api,
    activityStore,
    getProtectedConversationIds: () => ["protected-1", " "],
  });

  const renamed = await backend.renameConversation("c1", "Next");
  assert.deepEqual(state.calls.rename, [{ id: "c1", title: "Next" }]);
  assert.equal(renamed.title, "Next");
  assert.equal(renamed.updatedAt, (SECONDS + 5) * 1000);

  const pinned = await backend.setConversationPinned("c1", true);
  assert.equal(pinned.isPinned, true);
  assert.equal(pinned.pinnedAt, MILLIS);

  await backend.deleteConversation("c1");
  assert.deepEqual(state.calls.delete, ["c1"]);

  assert.deepEqual([...backend.getProtectedConversationIds()], ["protected-1", " "]);
});
