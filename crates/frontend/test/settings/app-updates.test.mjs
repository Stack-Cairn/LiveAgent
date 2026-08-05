import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  APP_UPDATE_CHECK_INTERVAL_MS,
  shouldRunAutomaticAppUpdateCheck,
  shouldShowAppUpdateButton,
} = loader.loadModule("src/lib/appUpdates.ts");

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

test("the update button appears only after an available update is detected", () => {
  assert.equal(
    shouldShowAppUpdateButton({ status: "ready", result: { available: true } }),
    true,
  );
  assert.equal(
    shouldShowAppUpdateButton({ status: "ready", result: { available: false } }),
    false,
  );
});
