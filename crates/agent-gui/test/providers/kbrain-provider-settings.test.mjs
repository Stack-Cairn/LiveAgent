import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function jsonResponse(value, status = 200) {
  return JSON.stringify(value);
}

function fixtureDocument(providers = []) {
  return {
    version: "kbrain.agent.v1",
    mode: "kbrain",
    defaultProvider: providers[0]?.id ?? "",
    defaultModel: providers[0]?.models[0]?.id ?? "",
    providers,
    models: providers.flatMap((provider) => provider.models),
  };
}

async function startFixture() {
  let document = fixtureDocument([
    {
      id: "opaque-route",
      name: "Fixture provider",
      type: "gemini",
      api: "google-generative-ai",
      baseUrl: "https://upstream.invalid/v1",
      apiKeyConfigured: true,
      models: [
        {
          provider: "opaque-route",
          id: "fixture-model",
          name: "Fixture model",
          contextWindow: 32768,
          maxOutputTokens: 512,
        },
      ],
    },
  ]);
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const raw = Buffer.concat(body).toString("utf8");
    requests.push({ method: request.method, path: request.url, body: raw ? JSON.parse(raw) : null });
    if (request.url?.startsWith("/v1/prompts") && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(jsonResponse({ revision: 1, globalTemplates: [], projectPrompt: "", projectPromptStrategy: "append" }));
      return;
    }
    if (request.url === "/v1/mcp" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(jsonResponse({ servers: [], selected: [] }));
      return;
    }
    if (request.url === "/v1/settings" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(jsonResponse(document));
      return;
    }
    if (request.url === "/v1/settings" && request.method === "PUT") {
      const update = raw ? JSON.parse(raw) : {};
      if (update.providers) {
        document = {
          ...fixtureDocument(
            update.providers.map((provider) => ({
              ...provider,
              apiKeyConfigured: provider.apiKey ? true : provider.clearApiKey ? false : true,
              models: provider.models.map((model) => ({ provider: provider.id, ...model })),
            })),
          ),
          defaultProvider: update.defaultProvider || document.defaultProvider,
          defaultModel: update.defaultModel || document.defaultModel,
        };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(jsonResponse(document));
      return;
    }
    response.writeHead(500, { "content-type": "application/json" });
    response.end(jsonResponse({ error: "unexpected fixture request" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    document: () => document,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

test("provider settings use real HTTP for load, batch save, reload, and explicit key clearing", async () => {
  const fixture = await startFixture();
  const localStorage = new Map();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => localStorage.get(key) ?? null,
    setItem: (key, value) => localStorage.set(key, String(value)),
  };
  const loader = createTsModuleLoader({
    mocks: {
      [new URL("../../src/lib/host.ts", import.meta.url).pathname]: {
        isKBrainBrowserHost: () => true,
        isKBrainBackendEnabled: () => true,
      },
      "@tauri-apps/api/core": { invoke: async () => assert.fail("native storage must not be used") },
    },
  });
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({
    baseUrl: fixture.baseUrl,
    token: "fixture-token",
    protocolVersion: "kbrain.agent.v1",
  });
  try {
    const settingsStorage = loader.loadModule("src/lib/settings/storage.ts");
    const loaded = await settingsStorage.loadPersistedSettings();
    assert.equal(loaded.customProviders[0].id, "opaque-route");
    assert.equal(loaded.customProviders[0].type, "gemini");
    assert.equal(loaded.customProviders[0].apiKey, "");
    assert.equal(loaded.customProviders[0].apiKeyConfigured, true);
    assert.equal(JSON.stringify(localStorage), "{}");

    const settings = loader.loadModule("src/lib/settings/index.ts");
    const next = settings.normalizeSettings({
      ...loaded,
      customProviders: loaded.customProviders.map((provider) => ({
        ...provider,
        name: "Imported provider",
        models: [
          ...provider.models,
          { id: "imported-model", contextWindow: 65536, maxOutputToken: 1024 },
        ],
        activeModels: [...provider.activeModels, "imported-model"],
      })),
      selectedModel: { customProviderId: "opaque-route", model: "imported-model" },
    });
    await settingsStorage.persistSettings(loaded, next);
    const put = fixture.requests.find((request) => request.method === "PUT");
    assert.ok(put);
    assert.equal(put.body.providers[0].name, "Imported provider");
    assert.equal(put.body.providers[0].api, "google-generative-ai");
    assert.equal(Object.hasOwn(put.body.providers[0], "apiKey"), false);
    assert.deepEqual(put.body.providers[0].models.at(-1), {
      id: "imported-model",
      contextWindow: 65536,
      maxOutputToken: 1024,
      limitsSource: "user",
    });

    const reloaded = await settingsStorage.loadPersistedSettings();
    assert.equal(reloaded.customProviders[0].name, "Imported provider");
    assert.equal(reloaded.selectedModel.model, "imported-model");

    await settingsStorage.persistSettings(reloaded, {
      ...reloaded,
      customProviders: reloaded.customProviders.map((provider) => ({
        ...provider,
        apiKeyConfigured: false,
      })),
    });
    const clearPut = fixture.requests.at(-1);
    assert.equal(clearPut.body.providers[0].clearApiKey, true);
    assert.equal(Object.hasOwn(clearPut.body.providers[0], "apiKey"), false);
  } finally {
    runtime.clearKBrainRuntimeConnection();
    globalThis.localStorage = previousStorage;
    await fixture.close();
  }
});

test("provider reorder saves the complete list in display order and keeps the backend order", async () => {
  const fixture = await startFixture();
  const loader = createTsModuleLoader({
    mocks: {
      [new URL("../../src/lib/host.ts", import.meta.url).pathname]: {
        isKBrainBrowserHost: () => true,
        isKBrainBackendEnabled: () => true,
      },
      "@tauri-apps/api/core": { invoke: async () => assert.fail("native storage must not be used") },
    },
  });
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({ baseUrl: fixture.baseUrl, token: "fixture-token", protocolVersion: "kbrain.agent.v1" });
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  try {
    const settingsStorage = loader.loadModule("src/lib/settings/storage.ts");
    const settings = loader.loadModule("src/lib/settings/index.ts");
    const loaded = await settingsStorage.loadPersistedSettings();
    const [base] = loaded.customProviders;
    const provider = (id) => ({ ...base, id, name: id });
    const initial = settings.updateCustomProviders(loaded, [provider("a"), provider("b"), provider("c")]);
    await settingsStorage.persistSettings(loaded, initial);

    // K-brain treats a list naming every provider as the display order (Stack-Cairn/K-brain#43),
    // so a reorder must send all providers, in the new order.
    const reordered = settings.updateCustomProviders(initial, [provider("c"), provider("a"), provider("b")]);
    const result = await settingsStorage.persistSettings(initial, reordered);
    const put = fixture.requests.at(-1);
    assert.deepEqual(put.body.providers.map((item) => item.id), ["c", "a", "b"]);
    assert.deepEqual(result.customProviders.map((item) => item.id), ["c", "a", "b"]);
  } finally {
    runtime.clearKBrainRuntimeConnection();
    globalThis.localStorage = previousStorage;
    await fixture.close();
  }
});

test("provider settings expose real HTTP failures", async () => {
  const fixture = await startFixture();
  await fixture.close();
  const loader = createTsModuleLoader();
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({ baseUrl: fixture.baseUrl, token: "fixture-token", protocolVersion: "kbrain.agent.v1" });
  try {
    const providerSettings = loader.loadModule("src/lib/kbrain/providerSettings.ts");
    await assert.rejects(() => providerSettings.loadKBrainProviderSettings(), /fetch failed|ECONNREFUSED/);
  } finally {
    runtime.clearKBrainRuntimeConnection();
  }
});
