import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const appSource = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const confirmDialogSource = readFileSync(
  new URL("../../../agent-ui/src/components/ui/confirm-dialog.tsx", import.meta.url),
  "utf8",
);
const tauriBridgeModulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/lib/tauriBridge.ts",
);
const {
  APP_UPDATE_CHECK_INTERVAL_MS,
  requestAppRestart,
  shouldRunAutomaticAppUpdateCheck,
  shouldShowAppUpdateButton,
  shouldShowRestartRequiredNotice,
} = loader.loadModule("src/lib/appUpdates.ts");

function createAppUpdateControllerHarness(options = {}) {
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
  let resolveCheck;
  const pendingCheck = options.deferCheckAfterFirst
    ? new Promise((resolve) => {
        resolveCheck = () => resolve(checkResult);
      })
    : null;
  let resolveInstall;
  const pendingInstall = options.deferInstall
    ? new Promise((resolve) => {
        resolveInstall = () => resolve(installedResult);
      })
    : null;
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
  // appUpdates imports invoke from tauriBridge (not @tauri-apps/api/core).
  // Mock the resolved bridge module so deferred install/check promises stay
  // synchronous with the harness call log under the CommonJS test loader.
  const controllerLoader = createTsModuleLoader({
    mocks: {
      react,
      [tauriBridgeModulePath]: {
        async invoke(command) {
          invokeCalls.push(command);
          if (command === "app_update_check") {
            const checkCount = invokeCalls.filter((call) => call === "app_update_check").length;
            return pendingCheck && checkCount > 1 ? pendingCheck : checkResult;
          }
          if (command === "app_update_install") return pendingInstall || installedResult;
          if (command === "app_restart") return undefined;
          throw new Error(`Unexpected invoke: ${command}`);
        },
      },
    },
  });
  const { useAppUpdateController } = controllerLoader.loadModule("src/lib/appUpdates.ts");

  return {
    checkResult,
    invokeCalls,
    installedResult,
    resolveCheck,
    resolveInstall,
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

test("tray checks cannot interrupt an update installation", async () => {
  const harness = createAppUpdateControllerHarness({ deferInstall: true });
  let controller = harness.render();

  await controller.runCheck();
  controller = harness.render();
  const installPromise = controller.installOnly();
  controller = harness.render();
  assert.equal(controller.status, "installing");

  const result = await controller.runCheck();
  controller = harness.render();
  assert.equal(result, harness.checkResult);
  assert.equal(controller.status, "installing");
  assert.deepEqual(harness.invokeCalls, ["app_update_check", "app_update_install"]);

  harness.resolveInstall();
  await installPromise;
  controller = harness.render();
  assert.equal(controller.status, "installed");
  assert.equal(controller.result, harness.installedResult);
});

test("install requests cannot interrupt an update check", async () => {
  const harness = createAppUpdateControllerHarness({ deferCheckAfterFirst: true });
  let controller = harness.render();

  await controller.runCheck();
  controller = harness.render();
  const checkingResult = controller.runCheck();
  controller = harness.render();
  assert.equal(controller.status, "checking");

  const installResult = await controller.installOnly();
  controller = harness.render();
  assert.equal(installResult, undefined);
  assert.equal(controller.status, "checking");
  assert.deepEqual(harness.invokeCalls, ["app_update_check", "app_update_check"]);

  harness.resolveCheck();
  await checkingResult;
  controller = harness.render();
  assert.equal(controller.status, "ready");
});

test("restart-required feedback is visible only while an update is installed", () => {
  const notice = { id: 1, kind: "restart-required" };
  assert.equal(shouldShowRestartRequiredNotice({ status: "installed", result: {} }, notice), true);
  assert.equal(shouldShowRestartRequiredNotice({ status: "restarting", result: {} }, notice), false);
  assert.equal(
    shouldShowRestartRequiredNotice({ status: "error", message: "failed" }, notice),
    false,
  );
});

test("restart-required feedback is cleared when the app leaves the installed state", async () => {
  const harness = createAppUpdateControllerHarness();
  let controller = harness.render();

  await controller.runCheck();
  controller = harness.render();
  await controller.installOnly();
  controller = harness.render();
  await controller.runCheck();
  controller = harness.render();
  assert.equal(controller.notice?.kind, "restart-required");

  await controller.restart();
  controller = harness.render();
  assert.equal(controller.status, "restarting");
  assert.equal(controller.notice, undefined);
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
  assert.deepEqual(controller.notice, { id: 1, kind: "restart-required" });
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
