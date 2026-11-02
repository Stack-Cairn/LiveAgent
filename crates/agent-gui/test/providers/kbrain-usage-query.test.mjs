import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const calls = [];
const loader = createTsModuleLoader();
loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({baseUrl:"http://127.0.0.1:47321",token:"kbrain-token",protocolVersion:"kbrain.agent.v1"});
const usage = loader.loadModule("src/lib/providers/usageQuery.ts");
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

test("query adapter uses the canonical K-brain endpoint and never a vendor URL", async () => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [], queriedAt: null, error: null, isStale: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await usage.queryProviderUsage("provider/a", true);
  assert.equal(calls[0].url, "http://127.0.0.1:47321/v1/providers/provider%2Fa/usage");
  assert.equal(
    new Headers(calls[0].init.headers).get("Authorization"),
    "Bearer kbrain-token",
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), { refresh: true });
  assert.doesNotMatch(calls[0].url, /api\.deepseek|openrouter/);
});

test("draft test sends the full config and bypasses persisted-cache semantics", async () => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ remaining: 1 }], isStale: false }), { status: 200 });
  };
  const config = { enabled: false, mode: "custom", script: "return", apiKey: "", apiKeyConfigured: true };
  await usage.testProviderUsage("p", config);
  assert.equal(calls[0].url, "http://127.0.0.1:47321/v1/providers/p/usage/test");
  assert.deepEqual(JSON.parse(calls[0].init.body), { config });
});
