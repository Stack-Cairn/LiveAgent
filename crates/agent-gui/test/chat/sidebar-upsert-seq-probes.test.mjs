// Probes for the sidebar store's local-upsert sequencing
// (localUpsertSeq / localUpsertSeqById). Each test drives the real shared
// store through a race the edit-resend branch flow can hit and asserts the
// branch row is never transiently dropped, while rows genuinely removed
// elsewhere still disappear once a post-upsert response lands.
import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createSidebarStore } = loader.loadModule("@liveagent/ui/lib/sidebar/store.ts");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const CWD_A = "/tmp/a";
const CWD_B = "/tmp/b";
const SCOPE_A = { kind: "workdir", cwd: CWD_A };
const SCOPE_B = { kind: "workdir", cwd: CWD_B };

function row(id, overrides = {}) {
  return {
    id,
    title: id,
    providerId: "p",
    model: "m",
    cwd: overrides.cwd ?? CWD_A,
    createdAt: 1,
    updatedAt: overrides.updatedAt ?? 1,
    isPending: overrides.isPending,
  };
}

function createBackend() {
  const state = {
    pages: new Map(),
    // FIFO of manual gates; when non-empty the next list call is held.
    gates: [],
    listeners: new Set(),
    connection: new Set(),
  };
  const keyOf = (scope) => (scope.kind === "workdir" ? `cwd:${scope.cwd}` : "none");
  const answer = (scope) => {
    const items = state.pages.get(keyOf(scope)) ?? [];
    return { items: items.slice(), totalCount: items.length };
  };
  const backend = {
    listConversations: async (_page, _size, scope) => {
      const gate = state.gates.shift();
      if (gate) {
        // Snapshot the server answer at request time, deliver it later.
        const snapshot = answer(scope);
        return new Promise((resolve, reject) => {
          gate.release = () => resolve(snapshot);
          gate.fail = (error) => reject(error);
        });
      }
      return answer(scope);
    },
    listWorkdirs: async () => [],
    renameConversation: async () => null,
    setConversationPinned: async () => null,
    setConversationCwd: async () => null,
    deleteConversation: async () => undefined,
    subscribeEvents: (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    subscribeConnection: (listener) => {
      state.connection.add(listener);
      return () => state.connection.delete(listener);
    },
    getProtectedConversationIds: () => [],
  };
  const hold = () => {
    const gate = {};
    state.gates.push(gate);
    return gate;
  };
  return {
    state,
    backend,
    hold,
    emit: (event) => {
      for (const listener of state.listeners) listener(event);
    },
    setConnected: (connected) => {
      for (const listener of state.connection) listener(connected);
    },
  };
}

const ids = (store) => store.getSnapshot().conversations.map((item) => item.id);

function record(store) {
  const seen = [];
  const unsubscribe = store.subscribe(() => seen.push(ids(store)));
  return { seen, unsubscribe };
}

async function startedStore(fake, items = [row("source", { updatedAt: 10 })]) {
  fake.state.pages.set(`cwd:${CWD_A}`, items);
  const store = createSidebarStore(fake.backend, { reconcileIntervalMs: 1e9, workdirsFallbackMs: 1e9 });
  store.setScope(SCOPE_A);
  store.start();
  await tick();
  return store;
}

test("a refresh queued behind the stale request keeps the branch visible throughout", async () => {
  const fake = createBackend();
  const store = await startedStore(fake);
  const stale = fake.hold();
  const first = store.refresh();
  await tick();
  store.upsertLocal(row("branch", { updatedAt: 20 }));
  fake.state.pages.set(`cwd:${CWD_A}`, [row("branch", { updatedAt: 20 }), row("source", { updatedAt: 10 })]);
  // Queued: runs after the stale request inside the same fetch loop.
  const queued = store.refresh();
  const { seen, unsubscribe } = record(store);
  stale.release();
  await first;
  await queued;
  await tick();
  unsubscribe();
  assert.ok(seen.length > 0);
  assert.ok(
    seen.every((list) => list.includes("branch")),
    `branch dropped transiently: ${JSON.stringify(seen)}`,
  );
  assert.deepEqual(ids(store), ["branch", "source"]);
  store.stop();
});

test("a queued post-upsert refresh that omits the row removes it (no residue)", async () => {
  const fake = createBackend();
  const store = await startedStore(fake);
  const stale = fake.hold();
  const first = store.refresh();
  await tick();
  store.upsertLocal(row("ghost", { updatedAt: 20 }));
  const queued = store.refresh();
  stale.release();
  await first;
  await queued;
  await tick();
  assert.deepEqual(ids(store), ["source"]);
  store.stop();
});

test("stale first page plus scope round trip keeps the branch in the cached slice", async () => {
  const fake = createBackend();
  fake.state.pages.set(`cwd:${CWD_B}`, [row("other", { cwd: CWD_B })]);
  const store = await startedStore(fake);
  const stale = fake.hold();
  void store.refresh();
  await tick();
  store.upsertLocal(row("branch", { updatedAt: 20 }));
  fake.state.pages.set(`cwd:${CWD_A}`, [row("branch", { updatedAt: 20 }), row("source", { updatedAt: 10 })]);
  stale.release();
  await tick();
  assert.ok(ids(store).includes("branch"));
  store.setScope(SCOPE_B);
  await tick();
  store.setScope(SCOPE_A);
  assert.ok(ids(store).includes("branch"), "cached slice after scope return lost the branch");
  await tick();
  assert.deepEqual(ids(store), ["branch", "source"]);
  store.stop();
});

test("a workspace-history load issued before the upsert does not evict the branch from byId", async () => {
  const fake = createBackend();
  const store = await startedStore(fake);
  const stale = fake.hold();
  const workspace = store.loadWorkspaceHistory(CWD_A);
  await tick();
  store.upsertLocal(row("branch", { updatedAt: 20 }));
  stale.release();
  await workspace;
  assert.ok(store.peek("branch"), "workspace history evicted the branch from byId");
  assert.ok(ids(store).includes("branch"));
  store.stop();
});

test("a delete event during the window is not undone by the stale response", async () => {
  const fake = createBackend();
  const store = await startedStore(fake);
  const stale = fake.hold();
  const first = store.refresh();
  await tick();
  store.upsertLocal(row("x", { updatedAt: 20 }));
  fake.emit({ kind: "delete", conversationId: "x" });
  stale.release();
  await first;
  assert.deepEqual(ids(store), ["source"]);
  store.stop();
});

test("a failed stale request leaves the record; the next omitting refresh still removes the row", async () => {
  const fake = createBackend();
  const store = await startedStore(fake);
  const stale = fake.hold();
  const first = store.refresh();
  await tick();
  store.upsertLocal(row("ghost", { updatedAt: 20 }));
  stale.fail(new Error("boom"));
  await first;
  assert.ok(ids(store).includes("ghost"));
  await store.refresh();
  assert.deepEqual(ids(store), ["source"]);
  store.stop();
});

test("stop/start during the window: restart load is authoritative", async () => {
  const fake = createBackend();
  const store = await startedStore(fake);
  const stale = fake.hold();
  void store.refresh();
  await tick();
  store.upsertLocal(row("ghost", { updatedAt: 20 }));
  store.stop();
  stale.release();
  await tick();
  store.start();
  await tick();
  await tick();
  assert.deepEqual(ids(store), ["source"]);
  store.stop();
});

test("reconnect after the upsert is authoritative and drops a server-absent row", async () => {
  const fake = createBackend();
  const store = await startedStore(fake);
  fake.setConnected(false);
  store.upsertLocal(row("ghost", { updatedAt: 20 }));
  fake.setConnected(true);
  await tick();
  await tick();
  assert.deepEqual(ids(store), ["source"]);
  store.stop();
});

test("repeated upserts only retain a server-absent row while they keep racing a request", async () => {
  const fake = createBackend();
  const store = await startedStore(fake);
  for (let round = 0; round < 3; round += 1) {
    const stale = fake.hold();
    const pending = store.refresh();
    await tick();
    store.upsertLocal(row("ghost", { updatedAt: 20 + round }));
    stale.release();
    await pending;
    assert.ok(ids(store).includes("ghost"), `round ${round}`);
  }
  await store.refresh();
  assert.deepEqual(ids(store), ["source"]);
  store.stop();
});
