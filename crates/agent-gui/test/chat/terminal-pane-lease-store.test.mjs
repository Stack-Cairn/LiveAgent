import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createTerminalPaneLeaseStore, releaseOrphanTerminalPaneLeases } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneLeaseStore.ts",
);

test("acquire establishes a bidirectional lease", () => {
  const store = createTerminalPaneLeaseStore();
  store.acquire("session-a", "pane-1");
  assert.equal(store.paneIdFor("session-a"), "pane-1");
  assert.equal(store.sessionIdFor("pane-1"), "session-a");
  assert.equal(store.paneIdFor("session-unknown"), null);
  assert.equal(store.sessionIdFor("pane-unknown"), null);
});

test("acquire rejects a session already leased by another pane", () => {
  const store = createTerminalPaneLeaseStore();
  store.acquire("session-a", "pane-1");
  assert.throws(() => store.acquire("session-a", "pane-2"), /already leased by pane 'pane-1'/);
  assert.equal(store.paneIdFor("session-a"), "pane-1");
});

test("acquire is idempotent for the same pane and session", () => {
  const store = createTerminalPaneLeaseStore();
  const releaseFirst = store.acquire("session-a", "pane-1");
  const releaseSecond = store.acquire("session-a", "pane-1");
  assert.equal(releaseFirst, releaseSecond);
  releaseSecond();
  assert.equal(store.paneIdFor("session-a"), null);
  assert.equal(store.sessionIdFor("pane-1"), null);
});

test("acquire rejects blank identifiers", () => {
  const store = createTerminalPaneLeaseStore();
  assert.throws(() => store.acquire("  ", "pane-1"));
  assert.throws(() => store.acquire("session-a", ""));
  assert.equal(store.paneIdFor("  "), null);
  assert.equal(store.sessionIdFor(""), null);
});

test("acquire trims identifiers", () => {
  const store = createTerminalPaneLeaseStore();
  store.acquire(" session-a ", " pane-1 ");
  assert.equal(store.paneIdFor("session-a"), "pane-1");
  assert.equal(store.sessionIdFor("pane-1"), "session-a");
});

test("re-acquiring with a new session rebinds the pane and frees the old session", () => {
  const store = createTerminalPaneLeaseStore();
  store.acquire("session-a", "pane-1");
  store.acquire("session-b", "pane-1");
  assert.equal(store.sessionIdFor("pane-1"), "session-b");
  assert.equal(store.paneIdFor("session-a"), null);
  assert.equal(store.paneIdFor("session-b"), "pane-1");
});

test("release is idempotent and never frees a newer lease", () => {
  const store = createTerminalPaneLeaseStore();
  const staleRelease = store.acquire("session-a", "pane-1");
  staleRelease();
  store.acquire("session-a", "pane-2");
  staleRelease();
  assert.equal(store.paneIdFor("session-a"), "pane-2");
  assert.equal(store.sessionIdFor("pane-2"), "session-a");
});

test("subscribe notifies on acquire and release, and unsubscribe stops notifications", () => {
  const store = createTerminalPaneLeaseStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });
  const release = store.acquire("session-a", "pane-1");
  assert.equal(notifications, 1);
  store.acquire("session-a", "pane-1");
  assert.equal(notifications, 1, "idempotent acquire must not notify");
  release();
  assert.equal(notifications, 2);
  release();
  assert.equal(notifications, 2, "idempotent release must not notify");
  unsubscribe();
  store.acquire("session-b", "pane-2");
  assert.equal(notifications, 2);
});

test("releaseForPane releases only the lease held by that pane and is idempotent", () => {
  const store = createTerminalPaneLeaseStore();
  store.acquire("session-a", "pane-1");
  store.acquire("session-b", "pane-2");
  store.releaseForPane("pane-unknown");
  assert.equal(store.paneIdFor("session-a"), "pane-1");
  store.releaseForPane("pane-1");
  assert.equal(store.paneIdFor("session-a"), null);
  assert.equal(store.sessionIdFor("pane-1"), null);
  assert.equal(store.paneIdFor("session-b"), "pane-2", "other leases stay intact");
  store.releaseForPane("pane-1");
  assert.equal(store.paneIdFor("session-b"), "pane-2");
});

test("releaseOrphanTerminalPaneLeases reclaims leases whose pane left the layout", () => {
  const store = createTerminalPaneLeaseStore();
  // drop 事务同步占约后 Pane 在宿主挂载前被关闭:租约无人持有 release。
  store.acquire("session-orphan", "pane-closed");
  store.acquire("session-live", "pane-live");
  releaseOrphanTerminalPaneLeases(store, {
    panes: { "pane-live": { paneId: "pane-live" } },
  });
  assert.equal(store.paneIdFor("session-orphan"), null, "orphan lease must be reclaimed");
  assert.equal(store.paneIdFor("session-live"), "pane-live", "held lease must survive");
  // 布局未变时对账是无副作用的幂等操作。
  const snapshot = store.leasedSessionIds();
  releaseOrphanTerminalPaneLeases(store, {
    panes: { "pane-live": { paneId: "pane-live" } },
  });
  assert.equal(store.leasedSessionIds(), snapshot);
});

test("leasedSessionIds exposes a stable snapshot of held sessions", () => {
  const store = createTerminalPaneLeaseStore();
  assert.deepEqual(store.leasedSessionIds(), []);
  const releaseA = store.acquire("session-a", "pane-1");
  store.acquire("session-b", "pane-2");
  assert.deepEqual([...store.leasedSessionIds()].sort(), ["session-a", "session-b"]);
  const snapshot = store.leasedSessionIds();
  assert.equal(store.leasedSessionIds(), snapshot, "unchanged leases keep the same reference");
  releaseA();
  assert.notEqual(store.leasedSessionIds(), snapshot, "a release produces a fresh snapshot");
  assert.deepEqual(store.leasedSessionIds(), ["session-b"]);
});
