import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const HOST_MODULE = new URL("../../src/lib/host.ts", import.meta.url).pathname;

const provider = (models) => ({
  id: "p1",
  name: "Relay",
  type: "codex",
  baseUrl: "https://relay.invalid/v1",
  isFullUrl: false,
  apiKey: "",
  apiKeyConfigured: true,
  models,
  activeModels: models.map((m) => m.id),
  reasoning: "off",
  promptCachingEnabled: false,
});

// K-brain stand-in: rejects provider payloads with duplicate model ids (400), or fails with 503.
async function startKBrain() {
  let stored = [{ id: "p1", name: "Relay", type: "codex", apiKeyConfigured: true, models: [{ id: "a" }] }];
  let puts = 0;
  let outage = false;
  let readOutage = false;
  const payloads = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "PUT") {
      puts++;
      if (outage) return reply(503, { error: "backend restarting" });
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      payloads.push(body);
      if (body.defaultModel === "invalid-default") return reply(400, { error: "invalid default" });
      const ids = (body.providers?.[0]?.models ?? []).map((m) => m.id);
      if (new Set(ids).size !== ids.length) return reply(400, { error: "models require unique IDs" });
      stored = body.providers.map((p) => ({ id: p.id, name: p.name, type: p.type, apiKeyConfigured: true, models: p.models }));
    }
    if (request.method === "GET" && readOutage) return reply(503, { error: "read unavailable" });
    reply(200, { version: "kbrain.agent.v1", mode: "kbrain", providers: stored });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    puts: () => puts,
    payloads,
    setReadOutage: (value) => { readOutage = value; },
    setOutage: (value) => {
      outage = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function setup() {
  const kbrain = await startKBrain();
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const loader = createTsModuleLoader({
    mocks: {
      [HOST_MODULE]: { isKBrainBrowserHost: () => true, isKBrainBackendEnabled: () => false, isTauriHost: () => false },
      "@tauri-apps/api/core": { invoke: async () => assert.fail("native storage must not be used") },
    },
  });
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({ baseUrl: kbrain.baseUrl, token: "t", protocolVersion: "kbrain.agent.v1" });
  const storage = loader.loadModule("src/lib/settings/storage.ts");
  const { getDefaultSettings } = loader.loadModule("src/lib/settings/index.ts");
  const base = { ...getDefaultSettings(), customProviders: [provider([{ id: "a" }])] };
  return { kbrain, runtime, storage, base };
}

test("a rejected provider save reverts to K-brain's records and does not poison later saves", async () => {
  const { kbrain, runtime, storage, base } = await setup();
  try {
    const bad = { ...base, customProviders: [provider([{ id: "dup" }, { id: "dup" }])] };
    const rejected = await storage.persistSettings(base, bad);
    assert.ok(rejected.providerError, "the rejection is reported");
    assert.deepEqual(
      rejected.customProviders.map((p) => p.models.map((m) => m.id)),
      [["a"]],
      "the UI is handed K-brain's records, not the rejected edit",
    );

    // An unrelated save right after must not re-send the rejected providers.
    const putsBefore = kbrain.puts();
    const themeOnly = { ...bad, theme: bad.theme === "dark" ? "light" : "dark" };
    const later = await storage.persistSettings(bad, themeOnly);
    assert.equal(later.providerError, undefined);
    assert.equal(kbrain.puts(), putsBefore, "no provider request for a theme change");
  } finally {
    runtime.clearKBrainRuntimeConnection();
    await kbrain.close();
  }
});

test("a transient provider save failure is still retried on the next save", async () => {
  const { kbrain, runtime, storage, base } = await setup();
  try {
    const edited = { ...base, customProviders: [provider([{ id: "a" }, { id: "b" }])] };
    kbrain.setOutage(true);
    await assert.rejects(() => storage.persistSettings(base, edited));
    kbrain.setOutage(false);
    const putsBefore = kbrain.puts();
    const themeOnly = { ...edited, theme: edited.theme === "dark" ? "light" : "dark" };
    const retried = await storage.persistSettings(edited, themeOnly);
    assert.equal(kbrain.puts(), putsBefore + 1, "the failed provider change is retried");
    assert.deepEqual(
      retried.customProviders.map((p) => p.models.map((m) => m.id)),
      [["a", "b"]],
    );
  } finally {
    runtime.clearKBrainRuntimeConnection();
    await kbrain.close();
  }
});

async function drainQueuedSaves(storage, base, snapshots) {
  let current = snapshots.at(-1);
  let previous = base;
  for (let index = 0; index < snapshots.length; index++) {
    const next = snapshots[index];
    const result = await storage.persistSettings(previous, next);
    // App only merges the newest sequence, even though older writes finish first.
    if (index === snapshots.length - 1 && result.customProviders) {
      current = { ...current, customProviders: result.customProviders };
    }
    previous = next;
  }
  return current;
}

test("queued theme changes consume provider rollback without another rejected PUT", async () => {
  const { kbrain, runtime, storage, base } = await setup();
  try {
    const bad = { ...base, customProviders: [provider([{ id: "dup" }, { id: "dup" }])] };
    const current = await drainQueuedSaves(storage, base, [bad, { ...bad, theme: "dark" }, { ...bad, theme: "light" }]);
    assert.deepEqual(current.customProviders[0].models.map(m => m.id), ["a"]);
    assert.equal(current.theme, "light");
    assert.equal(kbrain.puts(), 1);
  } finally { runtime.clearKBrainRuntimeConnection(); await kbrain.close(); }
});

test("queued valid provider edit supersedes rollback and remains authoritative", async () => {
  const { kbrain, runtime, storage, base } = await setup();
  try {
    const bad = { ...base, customProviders: [provider([{ id: "dup" }, { id: "dup" }])] };
    const fixed = { ...bad, customProviders: [provider([{ id: "a" }, { id: "new" }])], theme: "dark" };
    const current = await drainQueuedSaves(storage, base, [bad, fixed]);
    assert.deepEqual(current.customProviders[0].models.map(m => m.id), ["a", "new"]);
    assert.equal(kbrain.puts(), 2);
    const later = await storage.persistSettings(current, { ...current, theme: "light" });
    assert.equal(later.customProviders, undefined);
  } finally { runtime.clearKBrainRuntimeConnection(); await kbrain.close(); }
});

test("failed rollback GET is retried without repeating rejected providers", async () => {
  const { kbrain, runtime, storage, base } = await setup();
  try {
    const bad = { ...base, customProviders: [provider([{ id: "dup" }, { id: "dup" }])] };
    kbrain.setReadOutage(true);
    const failed = await storage.persistSettings(base, bad);
    assert.ok(failed.providerError);
    assert.equal(failed.customProviders, undefined);
    await assert.rejects(storage.persistSettings(bad, { ...bad, theme: "dark" }));
    kbrain.setReadOutage(false);
    const recovered = await storage.persistSettings(bad, { ...bad, theme: "light" });
    assert.deepEqual(recovered.customProviders[0].models.map(m => m.id), ["a"]);
    assert.equal(kbrain.puts(), 1);
  } finally { runtime.clearKBrainRuntimeConnection(); await kbrain.close(); }
});

test("a corrected edit uses the accepted baseline when clearing a stored key", async () => {
  const { kbrain, runtime, storage, base } = await setup();
  try {
    const bad = { ...base, customProviders: [{ ...provider([{ id: "dup" }, { id: "dup" }]), apiKeyConfigured: false }] };
    await storage.persistSettings(base, bad);
    const fixed = { ...bad, customProviders: [{ ...provider([{ id: "a" }]), apiKeyConfigured: false }] };
    await storage.persistSettings(bad, fixed);
    assert.equal(kbrain.payloads.at(-1).providers[0].clearApiKey, true);
  } finally { runtime.clearKBrainRuntimeConnection(); await kbrain.close(); }
});

test("changing backend connection discards rejected-save recovery", async () => {
  const { kbrain, runtime, storage, base } = await setup();
  const other = await startKBrain();
  try {
    const bad = { ...base, customProviders: [provider([{ id: "dup" }, { id: "dup" }])] };
    await storage.persistSettings(base, bad);
    runtime.setKBrainRuntimeConnection({ baseUrl: other.baseUrl, token: "t", protocolVersion: "kbrain.agent.v1" });
    const result = await storage.persistSettings(base, { ...base, theme: "dark" });
    assert.equal(result.customProviders, undefined);
    assert.equal(other.puts(), 0);
  } finally { runtime.clearKBrainRuntimeConnection(); await other.close(); await kbrain.close(); }
});

test("correcting only a rejected selected model remains saveable", async () => {
 const { kbrain, runtime, storage, base } = await setup();
 try {
  const bad={...base,selectedModel:{customProviderId:"p1",model:"invalid-default"}};
  assert.ok((await storage.persistSettings(base,bad)).providerError);
  const fixed={...base,selectedModel:{customProviderId:"p1",model:"a"}};
  const result=await storage.persistSettings(bad,fixed);
  assert.equal(result.providerError,undefined);
  assert.equal(kbrain.puts(),2);
  assert.equal(kbrain.payloads.at(-1).defaultModel,"a");
 } finally {runtime.clearKBrainRuntimeConnection();await kbrain.close();}
});
