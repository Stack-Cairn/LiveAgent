import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 模型列表来源分流的反漂移锁：厂商自营渠道（modelListSource: "catalog"）探测不发
// 任何请求、模型来自内置目录、端点记目录态；聚合站 / 中转（"api"）行为不变，并且
// 同一次探测里请求签名相同的接口只发一次。
const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      invoke(command) {
        if (command === "proxy_get_server_info") {
          return Promise.resolve({ baseUrl: "http://proxy.local:9999", token: "proxy-token" });
        }
        throw new Error(`unexpected invoke(${command})`);
      },
    },
  },
});
const registry = loader.loadModule("@liveagent/ui/lib/providers/registry/index.ts");
const probe = loader.loadModule("@liveagent/ui/pages/settings/providerProbe.ts");
const model = loader.loadModule("@liveagent/ui/pages/settings/providers/providerSettingsModel.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

function credential(id = "default") {
  return {
    id,
    label: "",
    apiKey: `sk-${id}`,
    apiKeyConfigured: true,
    enabled: true,
    modelScope: { mode: "auto" },
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

/** 换掉 globalThis.fetch，记录每次调用；返回调用列表。 */
async function withFetchStub(responder, run) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    calls.push({ url: String(url), options });
    return Promise.resolve(responder(String(url), calls.length));
  };
  try {
    return await run(calls);
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
}

test("catalog channels are probed without touching /models", async () => {
  const preset = registry.findProviderPreset("anthropic");
  assert.equal(preset.modelListSource, "catalog");
  const candidates = probe.buildEndpointCandidates({ preset });
  assert.ok(candidates.length > 0);

  const result = await withFetchStub(
    () => {
      throw new Error("catalog channels must not request the model list");
    },
    (calls) =>
      probe
        .probeProvider({ candidates, credentials: [credential()], preset })
        .then((probed) => ({ probed, calls })),
  );

  assert.equal(result.calls.length, 0);
  const endpoints = result.probed.credentials[0].endpoints;
  assert.equal(endpoints.length, candidates.length);
  for (const endpoint of endpoints) {
    assert.equal(endpoint.status, "catalog");
    assert.equal(endpoint.latencyMs, undefined);
    assert.equal(endpoint.models.length, preset.catalogModels.length);
  }
  // 目录态与 ok 同样算可用，只是没有延迟可报。
  const summary = probe.summarizeEndpointStatus(result.probed, "anthropic-messages");
  assert.equal(summary.status, "catalog");
  assert.equal(summary.latencyMs, undefined);
});

test("catalog probes yield an adoptable draft whose models come from the catalog", async () => {
  const preset = registry.findProviderPreset("anthropic");
  const candidates = probe.buildEndpointCandidates({ preset });
  const credentials = [credential()];
  const probed = await probe.probeProvider({ candidates, credentials, preset });
  const auto = probe.buildAutoConfiguration({ preset, candidates, probe: probed, credentials });

  assert.equal(auto.usable, true);
  // 端点照常按预设声明启用，只是观测记的是目录态。
  const endpoint = auto.endpointConfigs["anthropic-messages"];
  assert.equal(endpoint.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(endpoint.lastProbe.status, "catalog");
  assert.equal(endpoint.lastProbe.latencyMs, undefined);
  assert.equal(auto.defaultChatProtocol, "anthropic-messages");

  assert.equal(auto.models.length, preset.catalogModels.length);
  const catalogEntry = preset.catalogModels[0];
  const drafted = auto.models.find((item) => item.id === catalogEntry.id);
  assert.ok(drafted, `catalog model ${catalogEntry.id} missing from the draft`);
  assert.equal(drafted.source, "auto");
  assert.equal(drafted.limitsSource, "catalog");
  assert.equal(drafted.contextWindow, catalogEntry.contextWindow);
  assert.ok(drafted.group);
  // 每把 Key 的模型范围观测也来自目录。
  assert.equal(auto.credentials[0].lastModels.models.length, preset.catalogModels.length);
});

test("probed models are never auto-enabled", async () => {
  const preset = registry.findProviderPreset("anthropic");
  const candidates = probe.buildEndpointCandidates({ preset });
  const credentials = [credential()];
  const probed = await probe.probeProvider({ candidates, credentials, preset });
  const auto = probe.buildAutoConfiguration({ preset, candidates, probe: probed, credentials });
  assert.ok(auto.models.length > 0);
  assert.deepEqual(auto.activeModels, []);
  // 新实例也一样：模型全部写入，但一个都不启用。
  const created = model.createProviderFromAutoConfiguration({
    preset,
    name: "Anthropic",
    apiKey: "sk-test",
    auto,
  });
  assert.equal(created.models.length, auto.models.length);
  assert.deepEqual(created.activeModels, []);
});

test("api channels still fetch the model list", async () => {
  const preset = registry.findProviderPreset("siliconflow");
  assert.equal(preset.modelListSource, "api");
  const candidates = probe.buildEndpointCandidates({ preset });
  const { probed, calls } = await withFetchStub(
    () => jsonResponse(200, { data: [{ id: "Qwen/Qwen3-8B" }] }),
    (calls) =>
      probe
        .probeProvider({ candidates, credentials: [credential()], preset })
        .then((probed) => ({ probed, calls })),
  );
  assert.equal(calls.length, candidates.length);
  const endpoints = probed.credentials[0].endpoints;
  assert.equal(endpoints[0].status, "ok");
  assert.deepEqual(
    endpoints[0].models.map((item) => item.id),
    ["Qwen/Qwen3-8B"],
  );
});

/** 中转典型形态：三条接口最终算出同一个 …/v1/models。 */
function relayCandidates() {
  return [
    { protocol: "anthropic-messages", baseUrl: "https://relay.example.com", origin: "preset" },
    { protocol: "openai-completions", baseUrl: "https://relay.example.com/v1", origin: "preset" },
    { protocol: "openai-responses", baseUrl: "https://relay.example.com/v1", origin: "preset" },
  ];
}

test("endpoints sharing one request signature are fetched once and reuse the result", async () => {
  const candidates = relayCandidates();
  // 三条接口的模型列表地址完全相同，这正是重复请求的来源。
  const urls = new Set(candidates.map((candidate) => probe.probeModelsUrl(candidate)));
  assert.deepEqual([...urls], ["https://relay.example.com/v1/models"]);

  const { probed, calls } = await withFetchStub(
    () => jsonResponse(200, { data: [{ id: "gpt-4o" }] }),
    (calls) =>
      probe
        .probeProvider({ candidates, credentials: [credential()] })
        .then((probed) => ({ probed, calls })),
  );

  // Completions 与 Responses 共用一次请求；Messages 的鉴权头档不同，仍单独发一次。
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.url).sort(),
    [
      "http://proxy.local:9999/proxy/claude_code/v1/models",
      "http://proxy.local:9999/proxy/codex/v1/models",
    ],
  );
  const endpoints = probed.credentials[0].endpoints;
  assert.equal(endpoints.length, 3);
  // 摘要仍按接口逐行：复用的观测挂回各自的协议与地址。
  assert.deepEqual(
    endpoints.map((item) => [item.protocol, item.baseUrl, item.status]),
    [
      ["anthropic-messages", "https://relay.example.com", "ok"],
      ["openai-completions", "https://relay.example.com/v1", "ok"],
      ["openai-responses", "https://relay.example.com/v1", "ok"],
    ],
  );
  for (const endpoint of endpoints) {
    assert.deepEqual(
      endpoint.models.map((item) => item.id),
      ["gpt-4o"],
    );
  }
});

test("request dedup never crosses credentials", async () => {
  const { calls } = await withFetchStub(
    () => jsonResponse(200, { data: [{ id: "gpt-4o" }] }),
    (calls) =>
      probe
        .probeProvider({
          candidates: relayCandidates(),
          credentials: [credential("k1"), credential("k2")],
        })
        .then(() => ({ calls })),
  );
  // 每把 Key 各自去重：2 把 Key × 2 个签名。
  assert.equal(calls.length, 4);
});

test("refreshing keeps the models the user already enabled and leaves new ones off", async () => {
  const provider = settings.normalizeCustomProvider({
    id: "p1",
    name: "Relay",
    type: "codex",
    baseUrl: "https://relay.example.com/v1",
    apiKey: "sk-primary",
    models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
    activeModels: ["gpt-4o"],
  });
  const candidates = model.providerExistingCandidates(provider);
  const { probed } = await withFetchStub(
    () => jsonResponse(200, { data: [{ id: "gpt-4o" }, { id: "gpt-5" }] }),
    (calls) =>
      probe
        .probeProvider({ candidates, credentials: model.enabledCredentials(provider) })
        .then((probed) => ({ probed, calls })),
  );
  const auto = probe.buildAutoConfiguration({
    preset: undefined,
    candidates,
    probe: probed,
    credentials: model.enabledCredentials(provider),
  });
  const next = model.applyProbeToProvider(provider, {
    candidates,
    probe: probed,
    auto,
    mode: "refresh",
  });
  assert.ok(next.models.some((item) => item.id === "gpt-5"));
  // 新模型默认关闭；用户已启用的保持启用，已关闭的保持关闭。
  assert.deepEqual(next.activeModels, ["gpt-4o"]);
});
