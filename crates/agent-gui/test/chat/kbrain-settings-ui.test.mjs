import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const mocks = {
  "../../src-tauri/icons/custom/ccswitch.png": { default: "ccswitch.png" },
  "../../src-tauri/icons/custom/cherrystudio.png": { default: "cherrystudio.png" },
};

test("GUI discovery uses the real runtime HTTP adapter, including draft imports and saved credentials", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader("Content-Type", "application/json");
    if (requests.length === 3) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: "discovery unavailable" }));
      return;
    }
    res.end(JSON.stringify({ models: [{ id: "custom-model", contextWindow: 64000, maxOutputToken: 4000, limitsSource: "provider" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const loader = createTsModuleLoader({ mocks });
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({ baseUrl, token: "runtime-token", protocolVersion: "kbrain.agent.v1" });
  const { discoverProviderModels } = loader.loadModule("src/agent-ui-adapters/providerSettings.tsx");
  const oldStorage = globalThis.localStorage;
  globalThis.localStorage = { setItem() { assert.fail("discovery must not persist credentials"); }, getItem() { return null; } };
  try {
    const input = { type: "codex", requestFormat: "openai-responses", baseUrl: "https://vendor.invalid/v1", apiKey: "draft-secret", modelsUrl: "https://vendor.invalid/models", customHeaders: [{ key: "X-Client", value: "client" }] };
    const models = await discoverProviderModels(input);
    assert.equal(models[0].id, "custom-model");
    assert.equal(models[0].contextWindow, 64000);
    assert.equal(models[0].maxOutputToken, 4000);
    await discoverProviderModels({ ...input, providerId: "saved/provider", apiKey: "" });
    assert.deepEqual(requests.map(({ path, method, authorization }) => ({ path, method, authorization })), [
      { path: "/v1/settings/providers/draft/models", method: "POST", authorization: "Bearer runtime-token" },
      { path: "/v1/settings/providers/saved%2Fprovider/models", method: "POST", authorization: "Bearer runtime-token" },
    ]);
    assert.equal(requests[0].body.apiKey, "draft-secret");
    assert.equal(requests[1].body.apiKey, "");
    assert.equal(requests[0].body.modelsUrl, input.modelsUrl);
    await assert.rejects(discoverProviderModels(input), /discovery unavailable/);
    assert.equal(requests.length, 3, "backend failure must not fall back to the vendor");
  } finally {
    runtime.clearKBrainRuntimeConnection();
    globalThis.localStorage = oldStorage;
    await new Promise((resolve) => server.close(resolve));
  }
});
