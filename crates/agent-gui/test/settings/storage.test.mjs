import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const LOCAL_UI_SETTINGS_STORAGE_KEY = "liveagent.ui-settings.v1";

function createMemoryLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
}

async function withGlobal(name, value, task) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    value,
  });
  try {
    return await task();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, name, previous);
    } else {
      delete globalThis[name];
    }
  }
}

test("legacy local storage treats a null locale as an invalid saved preference", async () => {
  const localStorage = createMemoryLocalStorage({
    [LOCAL_UI_SETTINGS_STORAGE_KEY]: JSON.stringify({ locale: null }),
  });

  await withGlobal("navigator", { languages: ["en-GB"], language: "en-GB" }, async () => {
    await withGlobal("localStorage", localStorage, async () => {
      const loader = createTsModuleLoader({
        mocks: {
          "@tauri-apps/api/core": {
            invoke: async () => ({}),
          },
        },
      });
      const storage = loader.loadModule("src/lib/settings/storage.ts");

      assert.equal((await storage.loadPersistedSettings()).locale, "zh-CN");
    });
  });
});
