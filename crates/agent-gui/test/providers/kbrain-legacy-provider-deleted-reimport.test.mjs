import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const HOST_MODULE = new URL("../../src/lib/host.ts", import.meta.url).pathname;

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const legacy = (id, name, type, baseUrl) => ({
  id,
  name,
  type,
  baseUrl,
  isFullUrl: false,
  apiKey: "",
  models: [],
  activeModels: [],
  reasoning: "off",
  promptCachingEnabled: false,
});

// A K-brain settings endpoint that keeps whatever providers the last PUT sent.
async function startKBrain() {
  let providers = [];
  let puts = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.method === "PUT" && request.url === "/v1/settings") {
      puts++;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (Array.isArray(body.providers)) {
        providers = body.providers.map((p) => ({ id: p.id, name: p.name, type: p.type, apiKeyConfigured: false, models: [] }));
      }
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: "kbrain.agent.v1", mode: "kbrain", providers }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    ids: () => providers.map((p) => p.id).sort(),
    deleteProvider: (id) => {
      providers = providers.filter((p) => p.id !== id);
    },
    puts: () => puts,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("a legacy provider deleted in K-brain is not imported again on the next launch", async () => {
  const kbrain = await startKBrain();
  globalThis.localStorage = memoryStorage();
  // Desktop host: the legacy store (config.sqlite provider_settings) keeps both built-ins
  // forever; deleting a provider in K-brain never prunes it.
  const legacyProviders = [
    legacy("builtin-gemini", "Gemini", "gemini", "https://generativelanguage.googleapis.com/v1beta"),
    legacy("builtin-xai", "Grok", "xai", "https://api.x.ai/v1"),
  ];
  const loader = createTsModuleLoader({
    mocks: {
      [HOST_MODULE]: {
        isKBrainBrowserHost: () => false,
        isKBrainBackendEnabled: () => true,
        isTauriHost: () => true,
      },
      "@liveagent/app/shims/tauriCore": {
        invoke: async (command) => (command === "settings_load_all" ? { providers: legacyProviders } : null),
      },
    },
  });
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({ baseUrl: kbrain.baseUrl, token: "t", protocolVersion: "kbrain.agent.v1" });
  const storageApi = loader.loadModule("src/lib/settings/storage.ts");
  try {
    // First launch after upgrade: both legacy providers are migrated.
    await storageApi.loadPersistedSettingsWithDefaults();
    assert.deepEqual(kbrain.ids(), ["builtin-gemini", "builtin-xai"]);

    // The user deletes Grok in K-brain, then restarts twice.
    kbrain.deleteProvider("builtin-xai");
    const putsBefore = kbrain.puts();
    await storageApi.loadPersistedSettingsWithDefaults();
    await storageApi.loadPersistedSettingsWithDefaults();
    assert.deepEqual(kbrain.ids(), ["builtin-gemini"]);
    assert.equal(kbrain.puts(), putsBefore, "no import was attempted for the deleted provider");
  } finally {
    runtime.clearKBrainRuntimeConnection();
    await kbrain.close();
  }
});

test("installs migrated before the record existed: providers already in K-brain are recorded, then honored", () => {
  const mod = createTsModuleLoader().loadModule("src/lib/settings/legacyProviderImport.ts");
  const a = legacy("a", "A", "codex", "https://a.invalid");
  const b = legacy("b", "B", "codex", "https://b.invalid");
  const c = legacy("c", "C", "codex", "https://c.invalid");
  // a is in K-brain, b was recorded earlier and is now gone, c never reached K-brain.
  const result = mod.partitionMissingLegacyProviders([a, b, c], new Set(["a"]), new Set(["b"]));
  assert.deepEqual(
    result.notYetImported.map((p) => p.id),
    ["c"],
  );
  assert.deepEqual(
    result.deleted.map((p) => p.id),
    ["b"],
  );
  assert.deepEqual([...result.importedIds].sort(), ["a", "b"]);
});

test("the imported-id record round-trips and tolerates corrupt data", () => {
  const mod = createTsModuleLoader().loadModule("src/lib/settings/legacyProviderImport.ts");
  const storage = memoryStorage();
  mod.writeImportedLegacyProviderIds(["x", "y", "x"], storage);
  assert.deepEqual([...mod.readImportedLegacyProviderIds(storage)].sort(), ["x", "y"]);
  const broken = memoryStorage();
  broken.getItem = () => "{not json";
  assert.equal(mod.readImportedLegacyProviderIds(broken).size, 0);
});
