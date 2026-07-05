import assert from "node:assert/strict";
import test from "node:test";

import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const { createSidebarStore } = loader.loadModule("src/lib/sidebar/store.ts");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function conversation(id, overrides = {}) {
  return {
    id,
    title: overrides.title ?? id,
    providerId: "provider",
    model: "model",
    cwd: overrides.cwd,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    isPinned: overrides.isPinned,
    pinnedAt: overrides.pinnedAt,
    isPending: overrides.isPending,
  };
}

function createFakeBackend() {
  const state = {
    pages: new Map(), // scopeKey -> items
    totalCount: 0,
    listError: null,
    workdirs: [],
    workdirsError: null,
    calls: { list: [], workdirs: 0, rename: [], pin: [], delete: [], subscribes: 0, unsubscribes: 0 },
    listeners: new Set(),
    connectionListeners: new Set(),
    protectedIds: [],
    renameImpl: null,
    deleteImpl: null,
  };

  const scopeKeyOf = (scope) =>
    scope.kind === "workdir" ? `cwd:${scope.cwd}` : scope.kind === "unscoped" ? "cwd-empty" : "none";

  const backend = {
    listConversations: async (page, pageSize, scope) => {
      state.calls.list.push({ page, pageSize, scope });
      if (state.listError) {
        throw new Error(state.listError);
      }
      const all = state.pages.get(scopeKeyOf(scope)) ?? [];
      const start = (page - 1) * pageSize;
      return {
        items: all.slice(start, start + pageSize),
        totalCount: state.totalCount || all.length,
      };
    },
    listWorkdirs: async () => {
      state.calls.workdirs += 1;
      if (state.workdirsError) {
        throw new Error(state.workdirsError);
      }
      return state.workdirs;
    },
    renameConversation: async (id, title) => {
      state.calls.rename.push({ id, title });
      if (state.renameImpl) {
        return state.renameImpl(id, title);
      }
      return conversation(id, { title, updatedAt: 999 });
    },
    setConversationPinned: async (id, isPinned) => {
      state.calls.pin.push({ id, isPinned });
      return conversation(id, { isPinned, pinnedAt: isPinned ? 500 : null });
    },
    deleteConversation: async (id) => {
      state.calls.delete.push(id);
      if (state.deleteImpl) {
        return state.deleteImpl(id);
      }
    },
    subscribeEvents: (listener) => {
      state.calls.subscribes += 1;
      state.listeners.add(listener);
      return () => {
        state.calls.unsubscribes += 1;
        state.listeners.delete(listener);
      };
    },
    subscribeConnection: (listener) => {
      state.connectionListeners.add(listener);
      return () => {
        state.connectionListeners.delete(listener);
      };
    },
    getProtectedConversationIds: () => state.protectedIds,
  };

  return {
    state,
    backend,
    emit: (event) => {
      for (const listener of state.listeners) listener(event);
    },
    setConnected: (connected) => {
      for (const listener of state.connectionListeners) listener(connected);
    },
  };
}

const SCOPE_A = { kind: "workdir", cwd: "/tmp/a" };
const SCOPE_B = { kind: "workdir", cwd: "/tmp/b" };

test("initial load fills the list and fetches workdirs exactly once", async () => {
  const fake = createFakeBackend();
  fake.state.pages.set("cwd:/tmp/a", [
    conversation("one", { cwd: "/tmp/a", updatedAt: 20 }),
    conversation("two", { cwd: "/tmp/a", updatedAt: 10 }),
  ]);
  const store = createSidebarStore(fake.backend);
  store.setScope(SCOPE_A);
  store.start();
  await tick();

  const snapshot = store.getSnapshot();
  assert.deepEqual(
    snapshot.conversations.map((item) => item.id),
    ["one", "two"],
  );
  assert.equal(snapshot.listStatus, "ready");
  assert.equal(snapshot.totalCount, 2);
  assert.equal(snapshot.hasMore, false);
  assert.equal(fake.state.calls.workdirs, 1);
  store.stop();
});

test("a failed refresh keeps the visible list and sets an error code", async () => {
  const fake = createFakeBackend();
  fake.state.pages.set("cwd:/tmp/a", [conversation("one", { cwd: "/tmp/a" })]);
  const store = createSidebarStore(fake.backend);
  store.setScope(SCOPE_A);
  store.start();
  await tick();
  assert.equal(store.getSnapshot().conversations.length, 1);

  fake.state.listError = "boom";
  await store.refresh();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.conversations.length, 1);
  assert.equal(snapshot.listError, "listFailed");
  assert.equal(snapshot.listErrorDetail, "boom");
  assert.equal(snapshot.listStatus, "ready");
  store.stop();
});

test("scope switch paints the cached slice immediately without a wipe", async () => {
  const fake = createFakeBackend();
  fake.state.pages.set("cwd:/tmp/a", [conversation("a1", { cwd: "/tmp/a", updatedAt: 5 })]);
  fake.state.pages.set("cwd:/tmp/b", [conversation("b1", { cwd: "/tmp/b", updatedAt: 7 })]);
  const store = createSidebarStore(fake.backend);
  store.setScope(SCOPE_A);
  store.start();
  await tick();

  // An event for scope B lands in the byId cache without touching scope A.
  fake.emit({
    kind: "upsert",
    conversationId: "b1",
    conversation: conversation("b1", { cwd: "/tmp/b", updatedAt: 7 }),
  });
  assert.deepEqual(
    store.getSnapshot().conversations.map((item) => item.id),
    ["a1"],
  );

  store.setScope(SCOPE_B);
  const switched = store.getSnapshot();
  assert.deepEqual(
    switched.conversations.map((item) => item.id),
    ["b1"],
  );
  assert.equal(switched.listStatus, "syncing");

  await tick();
  assert.equal(store.getSnapshot().listStatus, "ready");
  store.stop();
});

test("scope none resolves empty locally without a backend call", async () => {
  const fake = createFakeBackend();
  const store = createSidebarStore(fake.backend);
  store.setScope({ kind: "none" });
  store.start();
  await tick();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.listStatus, "ready");
  assert.equal(snapshot.conversations.length, 0);
  assert.equal(fake.state.calls.list.length, 0);
  store.stop();
});

test("reconnect reconciles ghosts away but keeps pending drafts", async () => {
  const fake = createFakeBackend();
  fake.state.pages.set("cwd:/tmp/a", [
    conversation("stays", { cwd: "/tmp/a", updatedAt: 30 }),
    conversation("ghost", { cwd: "/tmp/a", updatedAt: 20 }),
  ]);
  const store = createSidebarStore(fake.backend);
  store.setScope(SCOPE_A);
  store.start();
  await tick();
  store.upsertLocal(conversation("draft", { cwd: "/tmp/a", updatedAt: 40, isPending: true }));
  assert.equal(store.getSnapshot().conversations.length, 3);

  // The other client deletes "ghost" while this one is offline.
  fake.state.pages.set("cwd:/tmp/a", [conversation("stays", { cwd: "/tmp/a", updatedAt: 30 })]);
  const workdirCallsBefore = fake.state.calls.workdirs;
  fake.setConnected(false);
  fake.setConnected(true);
  await tick();

  const snapshot = store.getSnapshot();
  assert.deepEqual(
    snapshot.conversations.map((item) => item.id),
    ["draft", "stays"],
  );
  assert.equal(fake.state.calls.workdirs, workdirCallsBefore + 1);
  store.stop();
});

test("optimistic rename rolls back and records a mutation error on failure", async () => {
  const fake = createFakeBackend();
  fake.state.pages.set("cwd:/tmp/a", [
    conversation("one", { cwd: "/tmp/a", title: "before", updatedAt: 10 }),
  ]);
  fake.state.renameImpl = () => {
    throw new Error("rename failed");
  };
  const store = createSidebarStore(fake.backend);
  store.setScope(SCOPE_A);
  store.start();
  await tick();

  const renamed = await store.rename("one", "after");
  assert.equal(renamed, false);
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.conversations[0].title, "before");
  assert.equal(snapshot.mutationErrors.get("one"), "renameFailed");
  assert.equal(snapshot.mutations.size, 0);
  store.stop();
});

test("rename is blocked for a running conversation without a backend call", async () => {
  const fake = createFakeBackend();
  fake.state.pages.set("cwd:/tmp/a", [conversation("one", { cwd: "/tmp/a" })]);
  const store = createSidebarStore(fake.backend);
  store.setScope(SCOPE_A);
  store.start();
  await tick();

  store.applyRunningPatch({ conversationId: "one", running: true, workdir: "/tmp/a" });
  const renamed = await store.rename("one", "nope");
  assert.equal(renamed, false);
  assert.equal(store.getSnapshot().mutationErrors.get("one"), "renameBlockedRunning");
  assert.equal(fake.state.calls.rename.length, 0);

  store.applyRunningPatch({ conversationId: "one", running: false });
  assert.equal(store.getSnapshot().runningConversationIds.size, 0);
  store.stop();
});

test("mutations are tracked per row, not globally", async () => {
  const fake = createFakeBackend();
  fake.state.pages.set("cwd:/tmp/a", [
    conversation("one", { cwd: "/tmp/a" }),
    conversation("two", { cwd: "/tmp/a" }),
  ]);
  let resolveRename;
  fake.state.renameImpl = () =>
    new Promise((resolve) => {
      resolveRename = () => resolve(conversation("one", { title: "renamed", cwd: "/tmp/a" }));
    });
  const store = createSidebarStore(fake.backend);
  store.setScope(SCOPE_A);
  store.start();
  await tick();

  const renamePromise = store.rename("one", "renamed");
  await tick();
  assert.equal(store.getSnapshot().mutations.get("one"), "rename");
  assert.equal(store.getSnapshot().mutations.has("two"), false);
  resolveRename();
  await renamePromise;
  assert.equal(store.getSnapshot().mutations.size, 0);
  store.stop();
});

test("delete refreshes workdirs; unseen cwd upserts trigger a debounced refresh", async () => {
  const fake = createFakeBackend();
  fake.state.pages.set("cwd:/tmp/a", [conversation("one", { cwd: "/tmp/a" })]);
  fake.state.workdirs = [{ path: "/tmp/a", conversationCount: 1, updatedAt: 10 }];
  const store = createSidebarStore(fake.backend, { workdirsDebounceMs: 5 });
  store.setScope(SCOPE_A);
  store.start();
  await tick();
  assert.equal(fake.state.calls.workdirs, 1);

  // Upsert for a known cwd: no workdirs refresh.
  fake.emit({
    kind: "upsert",
    conversationId: "one",
    conversation: conversation("one", { cwd: "/tmp/a", updatedAt: 50 }),
  });
  await sleep(15);
  assert.equal(fake.state.calls.workdirs, 1);

  // Upsert for an unseen cwd: debounced refresh.
  fake.emit({
    kind: "upsert",
    conversationId: "fresh",
    conversation: conversation("fresh", { cwd: "/tmp/new", updatedAt: 60 }),
  });
  await sleep(15);
  assert.equal(fake.state.calls.workdirs, 2);

  await store.remove("one");
  assert.equal(fake.state.calls.workdirs, 3);
  store.stop();
});

test("workdir activity is maintained incrementally from events", async () => {
  const fake = createFakeBackend();
  fake.state.pages.set("cwd:/tmp/a", []);
  const store = createSidebarStore(fake.backend, { workdirsDebounceMs: 1_000 });
  store.setScope(SCOPE_A);
  store.start();
  await tick();

  fake.emit({
    kind: "upsert",
    conversationId: "one",
    conversation: conversation("one", { cwd: "/tmp/a", updatedAt: 123 }),
  });
  const activity = store.getSnapshot().workdirActivity;
  const key = Array.from(activity.keys())[0];
  assert.equal(activity.get(key), 123);

  fake.emit({ kind: "running", conversationId: "one", workdir: "/tmp/a", updatedAt: 456 });
  const after = store.getSnapshot();
  assert.equal(after.workdirActivity.get(key), 456);
  assert.equal(after.runningConversationIds.has("one"), true);
  assert.equal(after.runningWorkdirPathKeys.size, 1);
  store.stop();
});

test("StrictMode start/stop/start keeps exactly one live subscription", async () => {
  const fake = createFakeBackend();
  fake.state.pages.set("cwd:/tmp/a", [conversation("one", { cwd: "/tmp/a" })]);
  const store = createSidebarStore(fake.backend);
  store.setScope(SCOPE_A);
  store.start();
  store.stop();
  store.start();
  await tick();

  assert.equal(fake.state.listeners.size, 1);
  assert.equal(fake.state.calls.subscribes, 2);
  assert.equal(fake.state.calls.unsubscribes, 1);

  fake.emit({
    kind: "upsert",
    conversationId: "two",
    conversation: conversation("two", { cwd: "/tmp/a", updatedAt: 99 }),
  });
  assert.deepEqual(
    store.getSnapshot().conversations.map((item) => item.id),
    ["two", "one"],
  );
  store.stop();
  assert.equal(fake.state.listeners.size, 0);
});

test("loadMore appends the next page and updates hasMore", async () => {
  const fake = createFakeBackend();
  const items = [];
  for (let index = 0; index < 5; index += 1) {
    items.push(conversation(`c${index}`, { cwd: "/tmp/a", updatedAt: 100 - index }));
  }
  fake.state.pages.set("cwd:/tmp/a", items);
  const store = createSidebarStore(fake.backend, { pageSize: 2 });
  store.setScope(SCOPE_A);
  store.start();
  await tick();
  assert.equal(store.getSnapshot().conversations.length, 2);
  assert.equal(store.getSnapshot().hasMore, true);

  await store.loadMore();
  assert.equal(store.getSnapshot().conversations.length, 4);
  assert.equal(store.getSnapshot().hasMore, true);

  await store.loadMore();
  assert.equal(store.getSnapshot().conversations.length, 5);
  assert.equal(store.getSnapshot().hasMore, false);
  store.stop();
});

test("upsertLocal and removeLocal manage pending drafts", async () => {
  const fake = createFakeBackend();
  fake.state.pages.set("cwd:/tmp/a", []);
  const store = createSidebarStore(fake.backend);
  store.setScope(SCOPE_A);
  store.start();
  await tick();

  store.upsertLocal(conversation("draft", { cwd: "/tmp/a", isPending: true, updatedAt: 10 }));
  assert.equal(store.getSnapshot().conversations.length, 1);
  assert.equal(store.getSnapshot().totalCount, 0);
  assert.equal(store.peek("draft").isPending, true);

  store.removeLocal("draft");
  assert.equal(store.getSnapshot().conversations.length, 0);
  assert.equal(store.peek("draft"), undefined);
  store.stop();
});
