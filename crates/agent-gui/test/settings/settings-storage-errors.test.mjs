import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const HOST_MODULE = new URL("../../src/lib/host.ts", import.meta.url).pathname;

async function startSettingsFixture({ getStatus = 200, putStatus = 200 } = {}) {
  const requests = [];
  const document = {
    version: "kbrain.agent.v1",
    mode: "kbrain",
    defaultProvider: "fixture-provider",
    defaultModel: "fixture-model",
    providers: [{ id: "fixture-provider", name: "Fixture provider", type: "codex", api: "openai-responses", apiKeyConfigured: true, models: [{ id: "fixture-model" }] }],
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, path: request.url, body: Buffer.concat(chunks).toString("utf8") });
    const status = request.method === "GET" ? getStatus : putStatus;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(status === 200 ? document : { error: status === getStatus ? "backend storage diagnostic" : "backend save diagnostic" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function withFixture(options, task) {
  const fixture = await startSettingsFixture(options);
  const loader = createTsModuleLoader({
    mocks: {
      [HOST_MODULE]: {
        isKBrainBrowserHost: () => true,
        isKBrainBackendEnabled: () => false,
        isTauriHost: () => false,
      },
      "@tauri-apps/api/core": { invoke: async () => assert.fail("native storage must not be used") },
    },
  });
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({ baseUrl: fixture.baseUrl, token: "fixture-token", protocolVersion: "kbrain.agent.v1" });
  try {
    return await task({
      fixture,
      loader,
      errors: loader.loadModule("src/lib/settings/errors.ts"),
      i18n: loader.loadModule("src/i18n/config.ts"),
      storage: loader.loadModule("src/lib/settings/storage.ts"),
    });
  } finally {
    runtime.clearKBrainRuntimeConnection();
    await fixture.close();
  }
}

test("settings load failures prefer diagnostics and localize empty fallbacks", async () => {
  let errors;
  let i18n;
  await withFixture({ getStatus: 503 }, async ({ storage, fixture, errors: storageErrors, i18n: storageI18n }) => {
    errors = storageErrors;
    i18n = storageI18n;
    let error;
    await assert.rejects(() => storage.loadPersistedSettingsWithDefaults(), (caught) => {
      error = caught;
      return true;
    });
    assert.ok(error instanceof storageErrors.SettingsStorageError);
    assert.equal(error.code, "load_failed");
    assert.equal(error.message, "backend storage diagnostic");
    assert.equal(error.originalError.message, "backend storage diagnostic");
    assert.equal(fixture.requests[0].path, "/v1/settings");
  });

  const detailed = new errors.SettingsStorageError("load_failed", new Error("backend storage diagnostic"));
  assert.equal(errors.getSettingsErrorMessage(detailed, i18n.t("app.settingsLoadFailed", "en-US"), "en-US", i18n.t), "backend storage diagnostic");
  const fallback = new errors.SettingsStorageError("load_failed");
  assert.equal(errors.getSettingsErrorMessage(fallback, i18n.t("app.settingsLoadFailed", "en-US"), "en-US", i18n.t), "Failed to load settings. Default settings have been restored.");
  assert.equal(errors.getSettingsErrorMessage(fallback, i18n.t("app.settingsLoadFailed", "zh-CN"), "zh-CN", i18n.t), i18n.t("app.settingsLoadFailed", "zh-CN"));
});

test("settings save failures preserve the backend diagnostic", async () => {
  await withFixture({ putStatus: 503 }, async ({ storage, loader, errors, fixture }) => {
    const settings = loader.loadModule("src/lib/settings/index.ts");
    const defaults = settings.getDefaultSettings();
    const next = { ...defaults, customProviders: [{ ...defaults.customProviders[0], apiKey: "new-key" }] };
    let error;
    await assert.rejects(() => storage.persistSettings(defaults, next), (caught) => {
      error = caught;
      return true;
    });
    assert.ok(error instanceof errors.SettingsStorageError);
    assert.equal(error.code, "save_failed");
    assert.equal(error.message, "backend save diagnostic");
    assert.equal(fixture.requests.at(-1).method, "PUT");
  });
});

test("SSH settings conflict is a stable code with localized UI copy", () => {
  const loader = createTsModuleLoader();
  const errors = loader.loadModule("src/lib/settings/errors.ts");
  const i18n = loader.loadModule("src/i18n/config.ts");
  const error = new errors.SettingsStorageError("ssh_settings_changed");
  assert.equal(errors.getSettingsErrorMessage(error, "unused", "en-US", i18n.t), "SSH settings were updated elsewhere. The latest settings have been loaded; submit your changes again.");
  assert.equal(errors.getSettingsErrorMessage(error, "unused", "zh-CN", i18n.t), i18n.t("app.settingsSshSettingsChanged", "zh-CN"));
});

test("gateway settings sync failures use their dedicated localized copy", () => {
  const loader = createTsModuleLoader();
  const errors = loader.loadModule("src/lib/settings/errors.ts");
  const i18n = loader.loadModule("src/i18n/config.ts");
  const error = new errors.SettingsStorageError("gateway_sync_failed");
  const detailedError = new errors.SettingsStorageError("gateway_sync_failed", new Error("gateway offline"));
  assert.equal(errors.getSettingsErrorMessage(detailedError, "unused", "en-US", i18n.t), "gateway offline");
  assert.equal(errors.getSettingsErrorMessage(error, "unused", "en-US", i18n.t), "Failed to sync WebUI settings.");
  assert.equal(errors.getSettingsErrorMessage(error, "unused", "zh-CN", i18n.t), i18n.t("app.gatewaySettingsSyncFailed", "zh-CN"));
});
