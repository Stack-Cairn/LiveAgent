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

// retryErrorSettings is a local-only UI preference persisted in localStorage
// (not gateway-synced), so its read/write round-trip lives entirely in the
// local-ui settings path — no backend command is involved.

test("retryErrorSettings default to every Cloudflare preset when localStorage is empty", async () => {
  const localStorage = createMemoryLocalStorage();

  await withGlobal("navigator", { languages: ["en-US"], language: "en-US" }, async () => {
    await withGlobal("localStorage", localStorage, async () => {
      const loader = createTsModuleLoader({
        mocks: { "@tauri-apps/api/core": { invoke: async () => ({}) } },
      });
      const storage = loader.loadModule("src/lib/settings/storage.ts");

      const loaded = await storage.loadPersistedSettings();
      assert.deepEqual(
        [...loaded.retryErrorSettings.presetStatusCodes].sort((a, b) => a - b),
        [520, 521, 522, 523, 525, 526, 527],
      );
      assert.deepEqual(loaded.retryErrorSettings.customPatterns, []);
    });
  });
});

test("retryErrorSettings are read back from localStorage and normalized", async () => {
  const localStorage = createMemoryLocalStorage({
    [LOCAL_UI_SETTINGS_STORAGE_KEY]: JSON.stringify({
      retryErrorSettings: {
        // User disabled 520/521, kept 525; an unknown code (999) and a
        // duplicate must be dropped on read.
        presetStatusCodes: [525, 525, 999],
        customPatterns: ["SSL handshake failed", "  ssl handshake failed  ", ""],
      },
    }),
  });

  await withGlobal("navigator", { languages: ["en-US"], language: "en-US" }, async () => {
    await withGlobal("localStorage", localStorage, async () => {
      const loader = createTsModuleLoader({
        mocks: { "@tauri-apps/api/core": { invoke: async () => ({}) } },
      });
      const storage = loader.loadModule("src/lib/settings/storage.ts");

      const loaded = await storage.loadPersistedSettings();
      assert.deepEqual(loaded.retryErrorSettings.presetStatusCodes, [525]);
      // Case-insensitive de-dup + trim + empty-drop.
      assert.deepEqual(loaded.retryErrorSettings.customPatterns, ["SSL handshake failed"]);
    });
  });
});

test("a missing retryErrorSettings field falls back to all presets (legacy snapshot)", async () => {
  // A pre-feature localStorage blob has no retryErrorSettings key; it must
  // normalize to the all-presets-on default, not an empty config.
  const localStorage = createMemoryLocalStorage({
    [LOCAL_UI_SETTINGS_STORAGE_KEY]: JSON.stringify({ theme: "dark" }),
  });

  await withGlobal("navigator", { languages: ["en-US"], language: "en-US" }, async () => {
    await withGlobal("localStorage", localStorage, async () => {
      const loader = createTsModuleLoader({
        mocks: { "@tauri-apps/api/core": { invoke: async () => ({}) } },
      });
      const storage = loader.loadModule("src/lib/settings/storage.ts");

      const loaded = await storage.loadPersistedSettings();
      assert.deepEqual(
        [...loaded.retryErrorSettings.presetStatusCodes].sort((a, b) => a - b),
        [520, 521, 522, 523, 525, 526, 527],
      );
    });
  });
});
