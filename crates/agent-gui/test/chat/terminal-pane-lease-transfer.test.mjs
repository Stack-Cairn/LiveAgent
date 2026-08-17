import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createTerminalPaneLeaseStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneLeaseStore.ts",
);
const { createTerminalPaneBindingStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneBindingStore.ts",
);
const { createTerminalPaneAutoLaunchRegistry } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneRuntime.ts",
);

// 集成级时序:dock ↔ Pane 的租约转移链路(绑定先行 → 挂载取租 → dock 互斥集)。

test("dock drag-in sequence: bind, open, acquire — dock hidden set tracks the lease", () => {
  const lease = createTerminalPaneLeaseStore();
  const bindings = createTerminalPaneBindingStore({ storage: null });

  // drop 事务:先写绑定再开 Pane(宿主挂载即复用会话)。
  bindings.set("surface-1", "session-1");
  assert.equal(lease.paneIdFor("session-1"), null);
  assert.deepEqual([...lease.leasedSessionIds()], []);

  // 宿主挂载:解析绑定 → acquire。
  const release = lease.acquire(bindings.get("surface-1"), "pane-1");
  assert.equal(lease.paneIdFor("session-1"), "pane-1");
  assert.deepEqual([...lease.leasedSessionIds()], ["session-1"]);

  release();
  assert.deepEqual([...lease.leasedSessionIds()], []);
});

test("rapid re-acquire: a stale release token never revokes the successor lease", () => {
  const lease = createTerminalPaneLeaseStore();
  // effect 重跑序列:acquire → release → 立即 re-acquire(同 pane 新 effect)。
  const first = lease.acquire("session-1", "pane-1");
  first();
  const second = lease.acquire("session-1", "pane-1");
  // 旧 release 迟到重放(cleanup 乱序):不得误释放新租约。
  first();
  assert.equal(lease.paneIdFor("session-1"), "pane-1");
  assert.deepEqual([...lease.leasedSessionIds()], ["session-1"]);
  second();
  assert.equal(lease.paneIdFor("session-1"), null);
});

test("detach returns the session to the dock and allows a fresh drag-in", () => {
  const lease = createTerminalPaneLeaseStore();
  const bindings = createTerminalPaneBindingStore({ storage: null });

  bindings.set("surface-1", "session-1");
  const release = lease.acquire("session-1", "pane-1");
  assert.deepEqual([...lease.leasedSessionIds()], ["session-1"]);

  // Detach:Pane 关闭释放租约;绑定语义上随 Pane 消失回收。
  release();
  bindings.delete("surface-1");
  assert.deepEqual([...lease.leasedSessionIds()], []);

  // 再次拖入:新 surfaceId + 新 paneId,acquire 必须成功。
  bindings.set("surface-2", "session-1");
  lease.acquire("session-1", "pane-2");
  assert.equal(lease.paneIdFor("session-1"), "pane-2");
});

test("conflicting acquire throws and leaves the holder's lease intact", () => {
  const lease = createTerminalPaneLeaseStore();
  lease.acquire("session-1", "pane-a");
  assert.throws(() => lease.acquire("session-1", "pane-b"));
  assert.equal(lease.paneIdFor("session-1"), "pane-a");
  assert.deepEqual([...lease.leasedSessionIds()], ["session-1"]);
});

test("subscription fires across the transfer sequence for dock recomputation", () => {
  const lease = createTerminalPaneLeaseStore();
  let notifications = 0;
  const unsubscribe = lease.subscribe(() => {
    notifications += 1;
  });
  const release = lease.acquire("session-1", "pane-1");
  release();
  assert.equal(notifications, 2);
  unsubscribe();
});

// 休眠占位与显式创建的区分:auto-launch 授权集。

test("auto-launch registry authorizes explicitly created surfaces only", () => {
  const registry = createTerminalPaneAutoLaunchRegistry();
  assert.equal(registry.isAuthorized("surface-restored"), false);
  registry.authorize("surface-new");
  assert.equal(registry.isAuthorized("surface-new"), true);
  // 非消费式:StrictMode 双挂载重复查询仍返回 true。
  assert.equal(registry.isAuthorized("surface-new"), true);
  // 空白输入忽略。
  registry.authorize("   ");
  assert.equal(registry.isAuthorized(""), false);
});
