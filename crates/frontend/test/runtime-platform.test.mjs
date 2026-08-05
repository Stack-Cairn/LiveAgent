import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "./helpers/load-ts-module.mjs";

async function withNavigator(value, task) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    enumerable: true,
    value,
  });
  try {
    return await task();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "navigator", previous);
    } else {
      delete globalThis.navigator;
    }
  }
}

test("resolveRuntimePlatform prefers the backend platform command", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command) {
          calls.push(command);
          assert.equal(command, "app_runtime_platform");
          return { platform: "windows" };
        },
      },
    },
  });

  const { resolveRuntimePlatform } = loader.loadModule("src/lib/runtimePlatform.ts");

  const platform = await withNavigator(
    { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel" },
    () => resolveRuntimePlatform(),
  );

  assert.equal(platform, "windows");
  assert.deepEqual(calls, ["app_runtime_platform"]);
});

test("resolveRuntimePlatform falls back to browser inference when backend command fails", async () => {
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command) {
          assert.equal(command, "app_runtime_platform");
          throw new Error("not running under Tauri");
        },
      },
    },
  });

  const { resolveRuntimePlatform } = loader.loadModule("src/lib/runtimePlatform.ts");

  const platform = await withNavigator(
    { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" },
    () => resolveRuntimePlatform(),
  );

  assert.equal(platform, "windows");
});
