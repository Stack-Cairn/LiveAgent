import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createTerminalPaneBindingStore, TERMINAL_PANE_BINDING_STORAGE_KEY } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneBindingStore.ts",
);

function createMemoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

test("set and get roundtrip through the provided storage", () => {
  const storage = createMemoryStorage();
  const store = createTerminalPaneBindingStore({ storage });
  store.set("surface-a", "session-1");
  assert.equal(store.get("surface-a"), "session-1");
  assert.equal(
    storage.getItem(TERMINAL_PANE_BINDING_STORAGE_KEY),
    JSON.stringify({ "surface-a": "session-1" }),
  );

  const rehydrated = createTerminalPaneBindingStore({ storage });
  assert.equal(rehydrated.get("surface-a"), "session-1");
});

test("delete removes the binding and clears empty storage", () => {
  const storage = createMemoryStorage();
  const store = createTerminalPaneBindingStore({ storage });
  store.set("surface-a", "session-1");
  store.delete("surface-a");
  assert.equal(store.get("surface-a"), null);
  assert.equal(storage.getItem(TERMINAL_PANE_BINDING_STORAGE_KEY), null);
});

test("blank identifiers are ignored", () => {
  const store = createTerminalPaneBindingStore({ storage: createMemoryStorage() });
  store.set("  ", "session-1");
  store.set("surface-a", "  ");
  assert.equal(store.get("  "), null);
  assert.equal(store.get("surface-a"), null);
  store.delete("  ");
});

test("identifiers are trimmed on write and read", () => {
  const store = createTerminalPaneBindingStore({ storage: createMemoryStorage() });
  store.set(" surface-a ", " session-1 ");
  assert.equal(store.get("surface-a"), "session-1");
  assert.equal(store.get(" surface-a "), "session-1");
});

test("corrupted storage payloads are ignored and rebuilt on next write", () => {
  const storage = createMemoryStorage({ [TERMINAL_PANE_BINDING_STORAGE_KEY]: "{not json" });
  const store = createTerminalPaneBindingStore({ storage });
  assert.equal(store.get("surface-a"), null);
  store.set("surface-a", "session-1");
  assert.equal(
    storage.getItem(TERMINAL_PANE_BINDING_STORAGE_KEY),
    JSON.stringify({ "surface-a": "session-1" }),
  );
});

test("non-object and malformed persisted entries are dropped", () => {
  const storage = createMemoryStorage({
    [TERMINAL_PANE_BINDING_STORAGE_KEY]: JSON.stringify({
      "surface-a": "session-1",
      "surface-b": 42,
      "  ": "session-2",
      "surface-c": "  ",
    }),
  });
  const store = createTerminalPaneBindingStore({ storage });
  assert.equal(store.get("surface-a"), "session-1");
  assert.equal(store.get("surface-b"), null);
  assert.equal(store.get("surface-c"), null);
});

test("reconcile drops bindings for dead sessions and reports them", () => {
  const storage = createMemoryStorage();
  const store = createTerminalPaneBindingStore({ storage });
  store.set("surface-a", "session-live");
  store.set("surface-b", "session-dead");
  store.set("surface-c", "session-gone");
  const removed = store.reconcile(new Set(["session-live"]));
  assert.deepEqual(removed.sort(), ["surface-b", "surface-c"]);
  assert.equal(store.get("surface-a"), "session-live");
  assert.equal(store.get("surface-b"), null);
  assert.equal(
    storage.getItem(TERMINAL_PANE_BINDING_STORAGE_KEY),
    JSON.stringify({ "surface-a": "session-live" }),
  );
  assert.deepEqual(store.reconcile(new Set(["session-live"])), []);
});

test("subscribe notifies on effective changes only", () => {
  const store = createTerminalPaneBindingStore({ storage: createMemoryStorage() });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });
  store.set("surface-a", "session-1");
  assert.equal(notifications, 1);
  store.set("surface-a", "session-1");
  assert.equal(notifications, 1, "same-value set must not notify");
  store.delete("surface-a");
  assert.equal(notifications, 2);
  store.delete("surface-a");
  assert.equal(notifications, 2, "no-op delete must not notify");
  store.set("surface-b", "session-2");
  store.reconcile(new Set());
  assert.equal(notifications, 4);
  store.reconcile(new Set());
  assert.equal(notifications, 4, "no-op reconcile must not notify");
  unsubscribe();
  store.set("surface-c", "session-3");
  assert.equal(notifications, 4);
});

test("falls back to memory when storage is unavailable or throwing", () => {
  const store = createTerminalPaneBindingStore({ storage: undefined });
  store.set("surface-a", "session-1");
  assert.equal(store.get("surface-a"), "session-1");

  const throwingStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  const degraded = createTerminalPaneBindingStore({ storage: throwingStorage });
  degraded.set("surface-b", "session-2");
  assert.equal(degraded.get("surface-b"), "session-2");
  degraded.delete("surface-b");
  assert.equal(degraded.get("surface-b"), null);
});

test("surfaceIds exposes a stable snapshot including persisted bindings", () => {
  const backing = new Map([
    ["liveagent.terminalPaneBindings.v1", JSON.stringify({ "surface-a": "session-1" })],
  ]);
  const storage = {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => backing.set(key, value),
    removeItem: (key) => backing.delete(key),
  };
  const store = createTerminalPaneBindingStore({ storage });
  assert.deepEqual(store.surfaceIds(), ["surface-a"], "boot snapshot covers persisted bindings");
  const snapshot = store.surfaceIds();
  assert.equal(store.surfaceIds(), snapshot, "unchanged bindings keep the same reference");
  store.set("surface-b", "session-2");
  assert.deepEqual([...store.surfaceIds()].sort(), ["surface-a", "surface-b"]);
  store.reconcile(new Set(["session-2"]));
  assert.deepEqual(store.surfaceIds(), ["surface-b"]);
  store.delete("surface-b");
  assert.deepEqual(store.surfaceIds(), []);
});

test("get falls back to storage when the in-memory map misses (HMR split instances)", () => {
  // dev HMR 下写入方与读取方可能持有不同的模块实例;storage 是唯一共享层。
  // 写入方实例落盘后,读取方实例即便内存 miss 也必须能命中,否则宿主会误判
  // "无绑定"并按 launchSpec 新建 PTY(拖入后冷启动新 shell、原会话留在 dock)。
  const storage = createMemoryStorage();
  const writer = createTerminalPaneBindingStore({ storage });
  const reader = createTerminalPaneBindingStore({ storage });
  writer.set("surface-a", "session-1");
  assert.equal(reader.get("surface-a"), "session-1");
  // 采纳后进入内存表,后续 surfaceIds 快照包含它。
  assert.ok(reader.surfaceIds().includes("surface-a"));
});

test("the storage fallback stays silent: no listener fires during a render-phase get", () => {
  const storage = createMemoryStorage();
  const writer = createTerminalPaneBindingStore({ storage });
  const reader = createTerminalPaneBindingStore({ storage });
  writer.set("surface-a", "session-1");
  let notified = 0;
  reader.subscribe(() => {
    notified += 1;
  });
  // get 被 useSyncExternalStore 当 getSnapshot 在渲染期调用,不得触发订阅回调。
  assert.equal(reader.get("surface-a"), "session-1");
  assert.equal(notified, 0);
});

test("a storage miss still returns null without inventing bindings", () => {
  const storage = createMemoryStorage();
  const store = createTerminalPaneBindingStore({ storage });
  assert.equal(store.get("surface-missing"), null);
});
