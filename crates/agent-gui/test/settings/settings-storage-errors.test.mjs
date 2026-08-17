import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function loadStorage(invoke) {
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": { invoke },
    },
  });
  return {
    errors: loader.loadModule("src/lib/settings/errors.ts"),
    i18n: loader.loadModule("src/i18n/config.ts"),
    storage: loader.loadModule("src/lib/settings/storage.ts"),
  };
}

test("settings load failures prefer diagnostics and localize empty fallbacks", async () => {
  const backendError = new Error("backend storage diagnostic");
  const { errors, i18n, storage } = loadStorage(async (command) => {
    assert.equal(command, "settings_load_all");
    throw backendError;
  });

  await assert.rejects(
    () => storage.loadPersistedSettingsWithDefaults(),
    (error) => {
      assert.ok(error instanceof errors.SettingsStorageError);
      assert.equal(error.code, "load_failed");
      assert.equal(error.message, "backend storage diagnostic");
      assert.strictEqual(error.originalError, backendError);
      return true;
    },
  );

  const error = new errors.SettingsStorageError("load_failed", backendError);
  assert.equal(
    errors.getSettingsErrorMessage(
      error,
      i18n.t("app.settingsLoadFailed", "en-US"),
      "en-US",
      i18n.t,
    ),
    "backend storage diagnostic",
  );

  const fallbackError = new errors.SettingsStorageError("load_failed");
  assert.equal(
    errors.getSettingsErrorMessage(
      fallbackError,
      i18n.t("app.settingsLoadFailed", "en-US"),
      "en-US",
      i18n.t,
    ),
    "Failed to load settings. Default settings have been restored.",
  );
  assert.equal(
    errors.getSettingsErrorMessage(
      fallbackError,
      i18n.t("app.settingsLoadFailed", "zh-CN"),
      "zh-CN",
      i18n.t,
    ),
    i18n.t("app.settingsLoadFailed", "zh-CN"),
  );
});

test("SSH settings conflict is a stable code with localized UI copy", () => {
  const { errors, i18n } = loadStorage(async () => undefined);
  const error = new errors.SettingsStorageError("ssh_settings_changed");

  assert.equal(
    errors.getSettingsErrorMessage(error, "unused", "en-US", i18n.t),
    "SSH settings were updated elsewhere. The latest settings have been loaded; submit your changes again.",
  );
  assert.equal(
    errors.getSettingsErrorMessage(error, "unused", "zh-CN", i18n.t),
    i18n.t("app.settingsSshSettingsChanged", "zh-CN"),
  );
});

test("gateway settings sync failures use their dedicated localized copy", () => {
  const { errors, i18n } = loadStorage(async () => undefined);
  const error = new errors.SettingsStorageError("gateway_sync_failed");
  const detailedError = new errors.SettingsStorageError(
    "gateway_sync_failed",
    new Error("gateway offline"),
  );

  assert.equal(
    errors.getSettingsErrorMessage(detailedError, "unused", "en-US", i18n.t),
    "gateway offline",
  );

  assert.equal(
    errors.getSettingsErrorMessage(error, "unused", "en-US", i18n.t),
    "Failed to sync WebUI settings.",
  );
  assert.equal(
    errors.getSettingsErrorMessage(error, "unused", "zh-CN", i18n.t),
    i18n.t("app.gatewaySettingsSyncFailed", "zh-CN"),
  );
});
