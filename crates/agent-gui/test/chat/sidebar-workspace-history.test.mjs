import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { createSidebarStore } = createTsModuleLoader().loadModule("@liveagent/ui/lib/sidebar/store.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const row = (id, cwd = "/alpha") => ({ id, title: id, cwd, providerId: "test", model: "test", createdAt: 1, updatedAt: 1 });
function setup() {
  const rows = new Map(Array.from({ length: 235 }, (_, i) => [String(i), row(String(i))]));
  rows.set("beta", row("beta", "/beta"));
  const calls = [];
  let listener;
  let connectionListener;
  let override;
  const backend = {
    async listConversations(page, pageSize, scope) {
      calls.push({ page, pageSize, scope });
      if (override) return override(page, pageSize, scope);
      const matching = [...rows.values()].filter((item) => item.cwd === scope.cwd)
        .sort((a, b) => Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned)));
      const size = Math.min(pageSize, 200);
      return { items: matching.slice((page - 1) * size, page * size), totalCount: matching.length };
    },
    async listWorkdirs() { return []; },
    subscribeEvents(fn) { listener = fn; return () => { listener = null; }; },
    subscribeConnection(fn) { connectionListener = fn; return () => { connectionListener = null; }; },
    async renameConversation(id, title) { const next = { ...rows.get(id), title }; rows.set(id, next); return next; },
    async setConversationPinned(id, isPinned) { const next = { ...rows.get(id), isPinned }; rows.set(id, next); return next; },
    async setConversationCwd(id, cwd) { const next = { ...rows.get(id), cwd }; rows.set(id, next); return next; },
    async deleteConversation(id) { rows.delete(id); },
  };
  const store = createSidebarStore(backend);
  store.start();
  return { store, rows, calls, connect: (connected) => connectionListener?.(connected), emit: (event) => listener?.(event), setOverride: (fn) => { override = fn; } };
}

test("projects load lazily and retain independent 10-row limits without changing active scope", async (t) => {
  const { store, calls } = setup(); t.after(() => store.stop());
  await tick();
  assert.equal(calls.length, 0);
  await store.loadWorkspaceHistory("/alpha");
  await store.loadWorkspaceHistory("/beta");
  await store.loadWorkspaceHistory("/alpha", true);
  assert.equal(store.getSnapshot().scopeKey, "none");
  assert.equal(store.getSnapshot().workspaceHistory.get("/alpha").limit, 20);
  assert.equal(store.getSnapshot().workspaceHistory.get("/beta").limit, 10);
  assert.equal(store.peek("19").cwd, "/alpha");
  assert.equal(store.peek("20"), undefined);
});

test("load more continues past the gateway's 200-row cap and reaches the end", async (t) => {
  const { store, calls } = setup(); t.after(() => store.stop());
  await store.loadWorkspaceHistory("/alpha");
  for (let i = 0; i < 23; i++) await store.loadWorkspaceHistory("/alpha", true);
  assert.equal(store.getSnapshot().workspaceHistory.get("/alpha").totalCount, 235);
  assert.equal([...store.getSnapshot().byId.values()].length, 235);
  assert.ok(calls.some(({ page }) => page === 2));
  assert.ok(calls.every(({ pageSize }) => pageSize <= 200));
});

test("off-scope rows can be pinned, renamed and moved through the shared store", async (t) => {
  const { store } = setup(); t.after(() => store.stop());
  await store.loadWorkspaceHistory("/alpha");
  assert.equal(await store.setPinned("4", true), true);
  assert.equal(await store.rename("4", "Renamed"), true);
  assert.equal(await store.setCwd("4", "/beta"), true);
  assert.equal(store.peek("4").isPinned, true);
  assert.equal(store.peek("4").title, "Renamed");
  assert.equal(store.peek("4").cwd, "/beta");
  assert.equal(store.getSnapshot().scopeKey, "none");
});

test("a failed next page keeps existing rows and retries the same limit", async (t) => {
  const { store, setOverride } = setup(); t.after(() => store.stop());
  await store.loadWorkspaceHistory("/alpha");
  setOverride(async () => { throw new Error("offline"); });
  await store.loadWorkspaceHistory("/alpha", true);
  assert.equal(store.getSnapshot().workspaceHistory.get("/alpha").limit, 10);
  assert.equal(store.getSnapshot().workspaceHistory.get("/alpha").error, "offline");
  assert.ok(store.peek("0"));
  setOverride(null);
  await store.loadWorkspaceHistory("/alpha");
  assert.equal(store.getSnapshot().workspaceHistory.get("/alpha").limit, 20);
  assert.equal(store.getSnapshot().workspaceHistory.get("/alpha").error, null);
});

test("late project responses cannot overwrite rename events or resurrect deletions", async (t) => {
  const { store, setOverride, emit } = setup(); t.after(() => store.stop());
  await store.loadWorkspaceHistory("/alpha");
  let resolve;
  setOverride(() => new Promise((done) => { resolve = done; }));
  const pending = store.loadWorkspaceHistory("/alpha", true);
  emit({ kind: "delete", conversationId: "0" });
  emit({ kind: "upsert", conversationId: "1", conversation: { ...row("1"), title: "Fresh" } });
  resolve({ items: [row("0"), row("1")], totalCount: 2 });
  await pending;
  assert.equal(store.peek("0"), undefined);
  assert.equal(store.peek("1").title, "Fresh");
});

test("stopping invalidates pending requests and allows a fresh load after restarting", async () => {
  const { store, setOverride } = setup();
  let resolve;
  setOverride(() => new Promise((done) => { resolve = done; }));
  const pending = store.loadWorkspaceHistory("/alpha");
  store.stop();
  resolve({ items: [row("old")], totalCount: 1 });
  await pending;
  assert.equal(store.peek("old"), undefined);
  assert.equal(store.getSnapshot().workspaceHistory.get("/alpha").loading, false);
  setOverride(null);
  store.start();
  await store.loadWorkspaceHistory("/alpha");
  assert.ok(store.peek("0"));
  store.stop();
});


test("a project requested before start loads when its parent starts the store", async () => {
  const { store, calls } = setup();
  store.stop();
  await store.loadWorkspaceHistory("/beta");
  assert.equal(calls.length, 0);
  store.start();
  await tick();
  assert.equal(store.peek("beta").cwd, "/beta");
  store.stop();
});

test("deletion of an uncached row during the first request is not resurrected", async (t) => {
  const { store, setOverride, emit } = setup(); t.after(() => store.stop());
  let resolve;
  setOverride(() => new Promise((done) => { resolve = done; }));
  const pending = store.loadWorkspaceHistory("/alpha");
  emit({ kind: "delete", conversationId: "0" });
  resolve({ items: [row("0")], totalCount: 1 });
  await pending;
  assert.equal(store.peek("0"), undefined);
});


test("reconnect supersedes a pending project request and preserves the raw workspace path", async (t) => {
  const { store, rows, calls, setOverride, connect } = setup(); t.after(() => store.stop());
  const cwd = "C:\\Projects\\MixedCase";
  rows.set("windows", row("windows", cwd));
  await store.loadWorkspaceHistory(cwd);
  let resolve;
  setOverride(() => new Promise((done) => { resolve = done; }));
  const pending = store.loadWorkspaceHistory(cwd);
  connect(false);
  rows.set("windows", { ...row("windows", cwd), title: "Fresh reconnect" });
  setOverride(null);
  connect(true);
  await tick();
  resolve({ items: [{ ...row("windows", cwd), title: "Old response" }], totalCount: 1 });
  await pending;
  assert.equal(store.peek("windows").title, "Fresh reconnect");
  assert.ok(calls.every(({ scope }) => scope.cwd === cwd));
});

test("pinned rows do not consume a project's visible page", async (t) => {
  const { store, rows } = setup(); t.after(() => store.stop());
  for (let i = 0; i < 9; i++) rows.set(String(i), { ...rows.get(String(i)), isPinned: true });
  await store.loadWorkspaceHistory("/alpha");
  const visible = [...store.getSnapshot().byId.values()].filter((item) => !item.isPinned);
  assert.ok(visible.length >= 10);
  assert.equal(store.getSnapshot().workspaceHistory.get("/alpha").limit, 10);
});
