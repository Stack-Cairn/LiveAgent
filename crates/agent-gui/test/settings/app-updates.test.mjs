import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const appSource = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const confirmDialogSource = readFileSync(
  new URL("../../../agent-ui/src/components/ui/confirm-dialog.tsx", import.meta.url),
  "utf8",
);
const {
  APP_UPDATE_CHECK_INTERVAL_MS,
  requestAppRestart,
  shouldRunAutomaticAppUpdateCheck,
  shouldShowAppUpdateButton,
} = loader.loadModule("src/lib/appUpdates.ts");

function createAppUpdateControllerHarness() {
  const states = [];
  const refs = [];
  let stateIndex = 0;
  let refIndex = 0;
  const invokeCalls = [];
  const checkResult = {
    configured: true,
    available: true,
    currentVersion: "1.3.0",
    version: "1.3.1",
    channel: "stable",
    repository: "Stack-Cairn/LiveAgent",
  };
  const installedResult = { ...checkResult, available: false };
  const react = {
    useState(initialValue) {
      const index = stateIndex++;
      if (!(index in states)) {
        states[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      return [
        states[index],
        (next) => {
          states[index] = typeof next === "function" ? next(states[index]) : next;
        },
      ];
    },
    useRef(initialValue) {
      const index = refIndex++;
      refs[index] ??= { current: initialValue };
      return refs[index];
    },
    useCallback(callback) {
      return callback;
    },
    useEffect() {},
    useMemo(factory) {
      return factory();
    },
  };
  const controllerLoader = createTsModuleLoader({
    mocks: {
      react,
      "@tauri-apps/api/core": {
        async invoke(command) {
          invokeCalls.push(command);
          if (command === "app_update_check") return checkResult;
          if (command === "app_update_install") return installedResult;
          throw new Error(`Unexpected invoke: ${command}`);
        },
      },
    },
  });
  const { useAppUpdateController } = controllerLoader.loadModule("src/lib/appUpdates.ts");

  return {
    invokeCalls,
    installedResult,
    render() {
      stateIndex = 0;
      refIndex = 0;
      return useAppUpdateController({ enabled: true, includePrereleases: false });
    },
  };
}

test("checks for application updates every 20 minutes", () => {
  assert.equal(APP_UPDATE_CHECK_INTERVAL_MS, 20 * 60 * 1000);
});

test("automatic checks do not interrupt active update states", () => {
  for (const status of ["checking", "installing", "installed", "restarting"]) {
    assert.equal(shouldRunAutomaticAppUpdateCheck({ status }), false, status);
  }

  for (const status of ["idle", "ready", "error"]) {
    assert.equal(shouldRunAutomaticAppUpdateCheck({ status }), true, status);
  }
});

test("the update button remains available after an update is installed", () => {
  assert.equal(
    shouldShowAppUpdateButton({ status: "ready", result: { available: true } }),
    true,
  );
  assert.equal(
    shouldShowAppUpdateButton({ status: "ready", result: { available: false } }),
    false,
  );
  assert.equal(shouldShowAppUpdateButton({ status: "installed", result: {} }), true);
});

test("manual checks preserve the pending restart after an update is installed", async () => {
  const harness = createAppUpdateControllerHarness();
  let controller = harness.render();

  await controller.runCheck();
  controller = harness.render();
  await controller.installOnly();
  controller = harness.render();
  assert.equal(controller.status, "installed");

  const result = await controller.runCheck();
  controller = harness.render();

  assert.equal(result, harness.installedResult);
  assert.equal(controller.status, "installed");
  assert.equal(controller.result, harness.installedResult);
  assert.deepEqual(harness.invokeCalls, ["app_update_check", "app_update_install"]);
});

test("restart is skipped when the pre-restart guard declines", async () => {
  let restartCount = 0;
  const restarted = await requestAppRestart({
    beforeRestart: async () => false,
    restart: async () => {
      restartCount += 1;
    },
  });

  assert.equal(restarted, false);
  assert.equal(restartCount, 0);
});

test("restart proceeds once when the guard confirms or is absent", async () => {
  let restartCount = 0;
  const restart = async () => {
    restartCount += 1;
  };

  assert.equal(await requestAppRestart({ beforeRestart: () => true, restart }), true);
  assert.equal(await requestAppRestart({ restart }), true);
  assert.equal(restartCount, 2);
});

test("restart guard visually prioritizes the safe action", () => {
  assert.match(appSource, /preferCancel:\s*true/);
  assert.match(
    confirmDialogSource,
    /variant=\{preferCancel \? "default" : "outline"\}/,
  );
  assert.match(
    confirmDialogSource,
    /variant=\{preferCancel \? "ghost" : "destructive"\}/,
  );
  assert.match(
    confirmDialogSource,
    /text-destructive hover:bg-destructive\/10 hover:text-destructive/,
  );
});
