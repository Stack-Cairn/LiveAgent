import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function settingsDocument(providers = [], defaultProvider = "", defaultModel = "") {
  return {
    version: "kbrain.agent.v1",
    mode: "kbrain",
    defaultProvider,
    defaultModel,
    providers,
    models: providers.flatMap((provider) => provider.models),
  };
}

test("startup imports legacy providers only after backend acknowledgement and retries nondestructively", async () => {
  let document = settingsDocument();
  let failNextPut = true;
  const requests = [];
  const server = createServer(async (request, reply) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: request.method, path: request.url, body });
    if (request.url?.startsWith("/v1/prompts") && request.method === "GET") {
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify({ revision: 1, globalTemplates: [], projectPrompt: "", projectPromptStrategy: "append" }));
      return;
    }
    if (request.url === "/v1/mcp" && request.method === "GET") {
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify({ servers: [], selected: [] }));
      return;
    }
    if (request.url === "/v1/settings" && request.method === "GET") {
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify(document));
      return;
    }
    if (request.url === "/v1/settings" && request.method === "PUT") {
      if (failNextPut) {
        failNextPut = false;
        reply.writeHead(503, { "content-type": "application/json" });
        reply.end(JSON.stringify({ error: "fixture write unavailable" }));
        return;
      }
      document = settingsDocument(
        body.providers.map((provider) => ({
          ...provider,
          apiKeyConfigured: Boolean(provider.apiKey) && !provider.clearApiKey,
          models: provider.models.map((model) => ({ provider: provider.id, ...model })),
        })),
        body.defaultProvider,
        body.defaultModel,
      );
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify(document));
      return;
    }
    reply.writeHead(500, { "content-type": "application/json" });
    reply.end(JSON.stringify({ error: "unexpected fixture request" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const legacyKey = "liveagent.ui-settings.v1";
  const local = new Map([
    [legacyKey, JSON.stringify({
      theme: "dark",
      selectedModel: { customProviderId: "legacy-provider", model: "legacy-model" },
      providers: [{
        id: "legacy-provider",
        name: "Legacy provider",
        type: "codex",
        requestFormat: "openai-completions",
        baseUrl: "https://legacy.invalid/v1",
        apiKey: "legacy-secret",
        models: [{ id: "legacy-model", contextWindow: 32768, maxOutputToken: 512 }],
        activeModels: ["legacy-model"],
      }],
    })],
  ]);
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => local.get(key) ?? null,
    setItem: (key, value) => local.set(key, String(value)),
  };
  const loader = createTsModuleLoader({
    mocks: {
      [new URL("../../src/lib/host.ts", import.meta.url).pathname]: { isKBrainBrowserHost: () => true, isKBrainBackendEnabled: () => true },
      "@tauri-apps/api/core": { invoke: async () => assert.fail("native storage must not be called") },
    },
  });
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: "fixture-token",
    protocolVersion: "kbrain.agent.v1",
  });
  try {
    const storage = loader.loadModule("src/lib/settings/storage.ts");
    await assert.rejects(() => storage.loadPersistedSettings(), /fixture write unavailable/);
    assert.match(local.get(legacyKey), /legacy-secret/, "legacy data survives a failed backend write");
    assert.equal(requests.filter((request) => request.method === "PUT").length, 1);

    const loaded = await storage.loadPersistedSettings();
    assert.equal(loaded.customProviders[0].id, "legacy-provider");
    assert.equal(loaded.customProviders[0].apiKey, "");
    assert.equal(loaded.customProviders[0].apiKeyConfigured, true);
    assert.deepEqual(loaded.selectedModel, { customProviderId: "legacy-provider", model: "legacy-model" });
    assert.equal(requests.filter((request) => request.method === "PUT").length, 2);
    assert.ok(!local.get("liveagent.kbrain-browser-settings.v1")?.includes("legacy-secret"));

    const reloaded = await storage.loadPersistedSettings();
    assert.equal(reloaded.customProviders[0].id, "legacy-provider");
    assert.equal(requests.filter((request) => request.method === "PUT").length, 2, "migration is idempotent");

    const prev = reloaded;
    const next = { ...prev, selectedModel: { customProviderId: "legacy-provider", model: "legacy-model" } };
    await storage.persistSettings(prev, next);
    assert.equal(requests.filter((request) => request.method === "PUT").length, 2, "identical selected model is not rewritten");
  } finally {
    runtime.clearKBrainRuntimeConnection();
    globalThis.localStorage = previousStorage;
    await new Promise((resolve) => server.close(resolve));
  }
});
