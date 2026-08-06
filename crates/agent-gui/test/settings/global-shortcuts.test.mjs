import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const STORAGE_KEY = "liveagent.globalShortcuts.v1";

function createMemoryLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    dump() {
      return Object.fromEntries(store);
    },
  };
}

async function withWindow(localStorage, task) {
  const previousWindow = globalThis.window;
  globalThis.window = { __TAURI__: {}, localStorage };
  try {
    return await task();
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
}

function loadGlobalShortcuts({ invoke } = {}) {
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        invoke: invoke ?? (async () => []),
      },
    },
  });
  return loader.loadModule("src/lib/shortcuts/globalShortcuts.ts");
}

test("readGlobalShortcutBindings returns empty bindings when storage is empty or corrupt", async () => {
  await withWindow(createMemoryLocalStorage(), async () => {
    const { readGlobalShortcutBindings } = loadGlobalShortcuts();
    assert.deepEqual(readGlobalShortcutBindings(), {});
  });

  await withWindow(createMemoryLocalStorage({ [STORAGE_KEY]: "not-json{" }), async () => {
    const { readGlobalShortcutBindings } = loadGlobalShortcuts();
    assert.deepEqual(readGlobalShortcutBindings(), {});
  });

  await withWindow(createMemoryLocalStorage({ [STORAGE_KEY]: JSON.stringify(42) }), async () => {
    const { readGlobalShortcutBindings } = loadGlobalShortcuts();
    assert.deepEqual(readGlobalShortcutBindings(), {});
  });
});

test("readGlobalShortcutBindings migrates legacy accelerator strings", async () => {
  const storage = createMemoryLocalStorage({
    [STORAGE_KEY]: JSON.stringify({
      summon: " Ctrl+Shift+KeyA ",
      toggle: "",
    }),
  });
  await withWindow(storage, async () => {
    const { readGlobalShortcutBindings } = loadGlobalShortcuts();
    assert.deepEqual(readGlobalShortcutBindings(), {
      summon: { accelerator: "Ctrl+Shift+KeyA", enabled: true },
    });
  });
});

test("readGlobalShortcutBindings keeps enabled flags and drops invalid entries", async () => {
  const storage = createMemoryLocalStorage({
    [STORAGE_KEY]: JSON.stringify({
      summon: { accelerator: "Ctrl+KeyA", enabled: false },
      toggle: { accelerator: "Alt+KeyT" },
      newChat: { accelerator: "   ", enabled: true },
      pin: { accelerator: 42, enabled: true },
      unknownAction: { accelerator: "Ctrl+KeyU", enabled: true },
    }),
  });
  await withWindow(storage, async () => {
    const { readGlobalShortcutBindings } = loadGlobalShortcuts();
    assert.deepEqual(readGlobalShortcutBindings(), {
      summon: { accelerator: "Ctrl+KeyA", enabled: false },
      // enabled 缺省视为启用（legacy 对象无该字段）。
      toggle: { accelerator: "Alt+KeyT", enabled: true },
    });
  });
});

test("writeGlobalShortcutBindings round-trips through readGlobalShortcutBindings", async () => {
  const storage = createMemoryLocalStorage();
  await withWindow(storage, async () => {
    const { readGlobalShortcutBindings, writeGlobalShortcutBindings } = loadGlobalShortcuts();
    const bindings = {
      summon: { accelerator: "Ctrl+Shift+KeyA", enabled: true },
      pin: { accelerator: "F9", enabled: false },
    };
    writeGlobalShortcutBindings(bindings);
    assert.deepEqual(readGlobalShortcutBindings(), bindings);
  });
});

test("applyGlobalShortcuts registers only enabled bindings with non-empty accelerators", async () => {
  const calls = [];
  const { applyGlobalShortcuts } = loadGlobalShortcuts({
    invoke: async (command, args) => {
      calls.push({ command, args });
      return [{ action: "summon", accelerator: "Ctrl+KeyA", error: "taken" }];
    },
  });
  const failures = await applyGlobalShortcuts({
    summon: { accelerator: "Ctrl+KeyA", enabled: true },
    toggle: { accelerator: "Alt+KeyT", enabled: false },
    newChat: { accelerator: "   ", enabled: true },
  });
  assert.deepEqual(calls, [
    {
      command: "app_set_global_shortcuts",
      args: { bindings: [{ action: "summon", accelerator: "Ctrl+KeyA" }] },
    },
  ]);
  assert.deepEqual(failures, [{ action: "summon", accelerator: "Ctrl+KeyA", error: "taken" }]);
});

test("applyGlobalShortcuts tolerates non-Tauri environments and bad responses", async () => {
  const { applyGlobalShortcuts: applyWithThrow } = loadGlobalShortcuts({
    invoke: async () => {
      throw new Error("not tauri");
    },
  });
  assert.deepEqual(
    await applyWithThrow({ summon: { accelerator: "Ctrl+KeyA", enabled: true } }),
    [],
  );

  const { applyGlobalShortcuts: applyWithBadResponse } = loadGlobalShortcuts({
    invoke: async () => null,
  });
  assert.deepEqual(
    await applyWithBadResponse({ summon: { accelerator: "Ctrl+KeyA", enabled: true } }),
    [],
  );
});

test("applyStoredGlobalShortcuts skips the backend when nothing is bound", async () => {
  const calls = [];
  await withWindow(createMemoryLocalStorage(), async () => {
    const { applyStoredGlobalShortcuts } = loadGlobalShortcuts({
      invoke: async (command, args) => {
        calls.push({ command, args });
        return [];
      },
    });
    await applyStoredGlobalShortcuts();
  });
  assert.deepEqual(calls, []);
});

test("applyStoredGlobalShortcuts still applies when every binding is disabled", async () => {
  // 有绑定但全部停用时仍要走一次全量替换，把上次会话的注册清掉。
  const calls = [];
  const storage = createMemoryLocalStorage({
    [STORAGE_KEY]: JSON.stringify({
      toggle: { accelerator: "Alt+KeyT", enabled: false },
    }),
  });
  await withWindow(storage, async () => {
    const { applyStoredGlobalShortcuts } = loadGlobalShortcuts({
      invoke: async (command, args) => {
        calls.push({ command, args });
        return [];
      },
    });
    await applyStoredGlobalShortcuts();
  });
  assert.deepEqual(calls, [{ command: "app_set_global_shortcuts", args: { bindings: [] } }]);
});
