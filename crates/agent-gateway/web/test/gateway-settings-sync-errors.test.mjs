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
const settingsModule = loader.loadModule("src/lib/settings");
const syncModule = loader.loadModule("@liveagent/ui/lib/settings/sync.ts");

test("project prompts round-trip without swallowing unrelated system changes", () => {
  const prev = settingsModule.normalizeSettings({});
  const next = settingsModule.normalizeSettings({
    ...prev,
    system: {
      ...prev.system,
      workspaceResourceSettings: {
        "/project": { projectPrompt: "project instruction", projectPromptStrategy: "replace" },
      },
    },
  });
  const update = { system: next.system };
  settingsSync.projectPromptSettingsUpdate(update, prev, next);
  assert.equal(update.system, undefined);
  assert.deepEqual(update.projectPrompts, {
    "/project": { prompt: "project instruction", strategy: "replace" },
  });
  const hydrated = syncModule.applyGatewaySettingsSyncPayload(prev, update);
  assert.equal(hydrated.system.workspaceResourceSettings["/project"].projectPrompt, "project instruction");
  assert.equal(hydrated.system.workspaceResourceSettings["/project"].projectPromptStrategy, "replace");
  const cleared = syncModule.applyGatewaySettingsSyncPayload(hydrated, { projectPrompts: {} });
  assert.equal(cleared.system.workspaceResourceSettings["/project"].projectPrompt, "");
  const mixed = structuredClone(next);
  mixed.system.executionMode = "unrecognized-test-mode";
  const mixedUpdate = { system: mixed.system };
  settingsSync.projectPromptSettingsUpdate(mixedUpdate, prev, mixed);
  assert.ok(mixedUpdate.system, "unsupported system changes must reach backend validation");
  const resourceChange = structuredClone(next);
  resourceChange.system.workspaceResourceSettings["/project"].mode = "off";
  const resourceUpdate = { system: resourceChange.system };
  settingsSync.projectPromptSettingsUpdate(resourceUpdate, prev, resourceChange);
  assert.ok(resourceUpdate.system, "unsupported project resource selection must be validated");
  const clear = { system: prev.system };
  settingsSync.projectPromptSettingsUpdate(clear, next, prev);
  assert.deepEqual(clear.projectPrompts, { "/project": { prompt: "", strategy: "append" } });
});

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
