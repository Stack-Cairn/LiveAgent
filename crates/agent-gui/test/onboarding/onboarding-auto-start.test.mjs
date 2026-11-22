import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function load({ tauri, invoke }) {
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": { invoke },
      [new URL("../../src/lib/host.ts", import.meta.url).pathname]: {
        isTauriHost: () => tauri,
        isKBrainBrowserHost: () => !tauri,
        isKBrainBackendEnabled: () => true,
        kBrainOwnedDesktopCommand: () => false,
      },
    },
  });
  return loader.loadModule("src/lib/onboardingAutoStart.ts");
}

test("the desktop asks the app whether the guide may open on its own", async () => {
  const calls = [];
  const answers = [true, false];
  const mod = load({
    tauri: true,
    invoke: async (command) => {
      calls.push(command);
      return answers.shift();
    },
  });
  // The browser flag does not apply to the desktop.
  assert.equal(await mod.resolveOnboardingAutoStart("1"), true);
  assert.equal(await mod.resolveOnboardingAutoStart(undefined), false);
  assert.deepEqual(calls, ["app_onboarding_auto_start", "app_onboarding_auto_start"]);
});

test("a failing command keeps the guide on", async () => {
  const mod = load({
    tauri: true,
    invoke: async () => {
      throw new Error("unknown command");
    },
  });
  assert.equal(await mod.resolveOnboardingAutoStart(undefined), true);
});

test("the browser host only honours the exact build-time flag", async () => {
  const mod = load({
    tauri: false,
    invoke: async () => assert.fail("no desktop command in the browser host"),
  });
  assert.equal(await mod.resolveOnboardingAutoStart("1"), false);
  assert.equal(await mod.resolveOnboardingAutoStart(undefined), true);
  assert.equal(await mod.resolveOnboardingAutoStart("true"), true);
});
