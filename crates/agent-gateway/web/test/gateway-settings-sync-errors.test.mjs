import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const rpc = loader.loadModule("src/lib/gatewaySocketRpc.ts");
const i18n = loader.loadModule("src/i18n/config.ts");
const settingsSync = loader.loadModule("src/app/hooks/useGatewaySettingsSync.ts");

function clientWithSettingsUpdateResponse(response) {
  const client = Object.create(rpc.GatewayWebSocketRpcClient.prototype);
  client.request = async (method, payload) => {
    assert.equal(method, "settings.update");
    assert.deepEqual(payload, {});
    return response;
  };
  return client;
}

test("current and legacy settings conflicts use a stable error code", async () => {
  for (const message of [
    "settings_changed",
    "SSH 设置已在另一端更新，已刷新为最新状态，请重新提交。",
  ]) {
    const client = clientWithSettingsUpdateResponse({ accepted: false, message });

    await assert.rejects(
      () => client.updateSettings({}),
      (error) => {
        assert.ok(error instanceof rpc.GatewaySettingsUpdateError);
        assert.equal(error.code, "settings_changed");
        assert.equal(error.responseMessage, message);
        assert.equal(
          settingsSync.getGatewaySettingsErrorMessage(error, "fallback", "en-US"),
          "SSH settings were updated elsewhere. The latest settings have been loaded; submit your changes again.",
        );
        return true;
      },
    );
  }
});

test("WebUI localizes settings conflict errors without hiding unknown responses", async () => {
  const conflict = new rpc.GatewaySettingsUpdateError("settings_changed", "settings_changed");

  assert.equal(
    settingsSync.getGatewaySettingsErrorMessage(conflict, "fallback", "en-US"),
    "SSH settings were updated elsewhere. The latest settings have been loaded; submit your changes again.",
  );
  assert.equal(
    settingsSync.getGatewaySettingsErrorMessage(conflict, "fallback", "zh-CN"),
    i18n.t("app.settingsSshSettingsChanged", "zh-CN"),
  );
  assert.notEqual(
    settingsSync.getGatewaySettingsErrorMessage(conflict, "fallback", "zh-CN"),
    "settings_changed",
  );

  const client = clientWithSettingsUpdateResponse({ accepted: false, message: "gateway rejected" });
  await assert.rejects(() => client.updateSettings({}), /gateway rejected/);
});

test("WebUI settings fallbacks are localized", () => {
  assert.equal(
    i18n.t("app.desktopSettingsSyncFailed", "en-US"),
    "Failed to sync desktop settings.",
  );
  assert.equal(
    i18n.t("app.webSettingsSaveFailed", "en-US"), "Failed to save WebUI settings.");
  assert.notEqual(
    i18n.t("app.desktopSettingsSyncFailed", "zh-CN"),
    i18n.t("app.desktopSettingsSyncFailed", "en-US"),
  );
  assert.notEqual(
    i18n.t("app.webSettingsSaveFailed", "zh-CN"), i18n.t("app.webSettingsSaveFailed", "en-US"));
});
