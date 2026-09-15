import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const runtimeConfig = loader.loadModule("src/pages/chat/runtime/providerRuntimeConfig.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

const PROVIDERS = [
  {
    id: "provider-a",
    name: "Provider A",
    type: "claude_code",
    baseUrl: "https://a.example.com",
    apiKey: "key-a",
    models: [
      { id: "model-1", contextWindow: 200000, maxOutputToken: 8192 },
      { id: "model-2", contextWindow: 200000, maxOutputToken: 8192 },
    ],
    activeModels: ["model-1", "model-2"],
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
    useSystemProxy: false,
  },
  {
    id: "provider-a2",
    name: "Provider A2",
    type: "claude_code",
    baseUrl: "https://a2.example.com",
    apiKey: "key-a2",
    models: [{ id: "model-1", contextWindow: 200000, maxOutputToken: 8192 }],
    activeModels: ["model-1"],
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
    useSystemProxy: false,
  },
  {
    id: "provider-a3",
    name: "Provider A3",
    type: "claude_code",
    baseUrl: "https://a3.example.com",
    apiKey: "key-a3",
    models: [{ id: "model-2", contextWindow: 200000, maxOutputToken: 8192 }],
    activeModels: ["model-2"],
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
    useSystemProxy: false,
  },
];

function buildSettings(queue, overrides = {}) {
  return settings.normalizeSettings({
    customProviders: PROVIDERS,
    modelFailover: {
      anthropic: {
        enabled: true,
        queue,
        maxSwitches: 3,
        failureThreshold: 4,
        cooldownSeconds: 60,
        ...overrides,
      },
    },
  });
}

function primarySelection(providerId, model) {
  const provider = PROVIDERS.find((item) => item.id === providerId);
  return {
    selectedModel: { customProviderId: providerId, model },
    provider,
    providerId: provider.type,
    model,
  };
}

test("fallbacks reuse the conversation's model on the queued provider", () => {
  const appSettings = buildSettings(["provider-a2", "provider-a3"]);
  const plan = runtimeConfig.buildModelFailoverPlan(
    appSettings,
    primarySelection("provider-a", "model-1"),
  );
  // provider-a3 does not have model-1 active → skipped for this turn.
  assert.equal(plan.fallbacks.length, 1);
  assert.deepEqual(plan.fallbacks[0].selectedModel, {
    customProviderId: "provider-a2",
    model: "model-1",
  });
  assert.equal(plan.fallbacks[0].model, "model-1");
  assert.equal(plan.fallbacks[0].runtime.baseUrl, "https://a2.example.com");
});

test("the model id decides which queued providers qualify per turn", () => {
  const appSettings = buildSettings(["provider-a2", "provider-a3"]);
  const plan = runtimeConfig.buildModelFailoverPlan(
    appSettings,
    primarySelection("provider-a", "model-2"),
  );
  // With model-2 active it's provider-a3 that qualifies instead.
  assert.equal(plan.fallbacks.length, 1);
  assert.deepEqual(plan.fallbacks[0].selectedModel, {
    customProviderId: "provider-a3",
    model: "model-2",
  });
});

test("the active provider is dropped from its own fallback list", () => {
  const appSettings = buildSettings(["provider-a", "provider-a2"]);
  const plan = runtimeConfig.buildModelFailoverPlan(
    appSettings,
    primarySelection("provider-a", "model-1"),
  );
  assert.deepEqual(
    plan.fallbacks.map((f) => f.selectedModel.customProviderId),
    ["provider-a2"],
  );
});

test("no plan when failover is disabled or nothing qualifies", () => {
  const disabled = buildSettings(["provider-a2"], { enabled: false });
  assert.equal(
    runtimeConfig.buildModelFailoverPlan(disabled, primarySelection("provider-a", "model-1")),
    undefined,
  );

  // Queue only holds the primary itself → nothing left to fail over to.
  const selfOnly = buildSettings(["provider-a"]);
  assert.equal(
    runtimeConfig.buildModelFailoverPlan(selfOnly, primarySelection("provider-a", "model-1")),
    undefined,
  );
});

test("failover config applied from gateway sync feeds the plan builder", () => {
  const sync = loader.loadModule("@liveagent/ui/lib/settings/sync.ts");

  // WebUI edits the config and publishes it through the sync protocol...
  const webSide = settings.updateModelFailover(
    settings.normalizeSettings({ customProviders: PROVIDERS }),
    "anthropic",
    { enabled: true, queue: ["provider-a2"] },
  );
  const payload = sync.buildGatewaySettingsSyncPayload(webSide);

  // ...the desktop applies the payload and must build a live plan from it.
  const desktopSide = sync.applyGatewaySettingsSyncPayload(
    settings.normalizeSettings({ customProviders: PROVIDERS }),
    payload,
  );
  const plan = runtimeConfig.buildModelFailoverPlan(
    desktopSide,
    primarySelection("provider-a", "model-1"),
  );
  assert.ok(plan, "synced config should produce a failover plan");
  assert.deepEqual(plan.fallbacks.map((f) => f.selectedModel.customProviderId), ["provider-a2"]);
  assert.equal(plan.fallbacks[0].model, "model-1");
});

// ---------------------------------------------------------------------------
// 三层候选（设计文档 8.2）：凭据层 → 端点层 → 供应商层，共用一份切换预算；分组按
// 主选路由的接口家族，`enabled` 只控制供应商层。
// ---------------------------------------------------------------------------

const MULTI_KEY_PROVIDER = {
  id: "gateway",
  name: "Gateway",
  type: "codex",
  baseUrl: "https://gateway.example/v1",
  apiKey: "key-1",
  credentials: [
    { id: "k1", label: "main", apiKey: "key-1", enabled: true },
    {
      id: "k2",
      label: "backup",
      apiKey: "key-2",
      enabled: true,
      modelScope: { mode: "manual", models: ["gpt-*"] },
    },
    { id: "k3", label: "disabled", apiKey: "key-3", enabled: false },
    { id: "k4", label: "", apiKey: "key-4", enabled: true, modelScope: { mode: "all" } },
  ],
  endpointConfigs: {
    "openai-completions": { baseUrl: "https://gateway.example/compat/v1" },
    "anthropic-messages": { baseUrl: "https://gateway.example/anthropic/v1" },
  },
  models: [
    {
      id: "gpt-5.2",
      contextWindow: 400000,
      maxOutputToken: 128000,
      chatProtocol: "openai-responses",
    },
    { id: "claude-relay", contextWindow: 200000, maxOutputToken: 8192 },
  ],
  activeModels: ["gpt-5.2", "claude-relay"],
  reasoning: "high",
  promptCachingEnabled: false,
  nativeWebSearchEnabled: false,
  useSystemProxy: false,
};

const OPENAI_FAMILY_PROVIDERS = [
  MULTI_KEY_PROVIDER,
  {
    id: "xai-relay",
    name: "xAI Relay",
    type: "xai",
    baseUrl: "https://api.x.ai/v1",
    apiKey: "key-x",
    models: [{ id: "gpt-5.2", contextWindow: 400000, maxOutputToken: 128000 }],
    activeModels: ["gpt-5.2"],
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
    useSystemProxy: false,
  },
  {
    id: "claude-home",
    name: "Claude Home",
    type: "claude_code",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "key-c",
    models: [{ id: "gpt-5.2", contextWindow: 200000, maxOutputToken: 8192 }],
    activeModels: ["gpt-5.2"],
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
    useSystemProxy: false,
  },
];

function buildOpenAIFamilySettings(queue, overrides = {}) {
  return settings.normalizeSettings({
    customProviders: OPENAI_FAMILY_PROVIDERS,
    modelFailover: {
      openai: {
        enabled: true,
        queue,
        maxSwitches: 2,
        failureThreshold: 4,
        cooldownSeconds: 60,
        ...overrides,
      },
    },
  });
}

function selection(appSettings, providerId, model) {
  const provider = appSettings.customProviders.find((item) => item.id === providerId);
  return {
    selectedModel: { customProviderId: providerId, model },
    provider,
    providerId: provider.type,
    model,
  };
}

test("credential layer: other enabled keys covering the model become fallbacks even with the provider queue disabled", () => {
  const appSettings = buildOpenAIFamilySettings([], { enabled: false });
  const plan = runtimeConfig.buildModelFailoverPlan(
    appSettings,
    selection(appSettings, "gateway", "gpt-5.2"),
  );
  const credentialLayer = plan.fallbacks.filter((f) => f.layer === "credential");
  // k1 是当前 Key、k3 停用；k2（范围 gpt-*）与 k4（all）按顺序入选。
  assert.deepEqual(
    credentialLayer.map((f) => [f.runtime.credentialId, f.runtime.apiKey]),
    [
      ["k2", "key-2"],
      ["k4", "key-4"],
    ],
  );
  assert.equal(credentialLayer[0].label, "Gateway · gpt-5.2 · backup");
  assert.equal(credentialLayer[1].label, "Gateway · gpt-5.2 · Key 4");
  for (const fallback of credentialLayer) {
    assert.deepEqual(fallback.selectedModel, { customProviderId: "gateway", model: "gpt-5.2" });
    assert.equal(fallback.runtime.protocol, "openai-responses");
  }
  // 供应商层关闭：没有任何 provider 层候选。
  assert.equal(plan.fallbacks.some((f) => f.layer === "provider"), false);
  // 预算沿用家族设置（三层共用）。
  assert.equal(plan.config.maxSwitches, 2);
});

test("credential layer respects model scope: keys that do not cover the model are skipped", () => {
  const appSettings = buildOpenAIFamilySettings([], { enabled: false });
  const plan = runtimeConfig.buildModelFailoverPlan(
    appSettings,
    selection(appSettings, "gateway", "claude-relay"),
  );
  // claude-relay 只有 k4（all）覆盖；k2 的 gpt-* 范围不含它。
  assert.deepEqual(
    plan.fallbacks.filter((f) => f.layer === "credential").map((f) => f.runtime.credentialId),
    ["k4"],
  );
});

test("endpoint layer: same-family enabled channels after the routed one, resolved through their own endpoint config", () => {
  const appSettings = buildOpenAIFamilySettings([], { enabled: false });
  const plan = runtimeConfig.buildModelFailoverPlan(
    appSettings,
    selection(appSettings, "gateway", "gpt-5.2"),
  );
  const endpointLayer = plan.fallbacks.filter((f) => f.layer === "endpoint");
  // 模型显式选 Responses；已启用的 Completions 是同家族候选，Anthropic Messages 跨家族不入选。
  assert.equal(endpointLayer.length, 1);
  assert.equal(endpointLayer[0].runtime.protocol, "openai-completions");
  assert.equal(endpointLayer[0].runtime.baseUrl, "https://gateway.example/compat/v1");
  assert.equal(endpointLayer[0].runtime.family, "openai");
  assert.equal(endpointLayer[0].label, "Gateway · gpt-5.2 · OpenAI Chat Completions");
  // 顺序：凭据层在前，端点层在后。
  assert.deepEqual(
    plan.fallbacks.map((f) => f.layer),
    ["credential", "credential", "endpoint"],
  );
});

test("endpoint layer falls back to the provider's enabled same-family channels when the model declares none", () => {
  const appSettings = buildOpenAIFamilySettings([], { enabled: false });
  const plan = runtimeConfig.buildModelFailoverPlan(
    appSettings,
    selection(appSettings, "gateway", "claude-relay"),
  );
  // claude-relay 无显式列表 → 家族表把它路由到 anthropic-messages（已启用端点），
  // 家族为 anthropic：供应商内没有其它 anthropic 渠道，因此没有端点层候选。
  assert.equal(plan.fallbacks.some((f) => f.layer === "endpoint"), false);
  assert.equal(plan.fallbacks[0].runtime.family, "anthropic");
});

test("provider layer groups by protocol family: xai joins the OpenAI family queue, claude_code is skipped", () => {
  const appSettings = buildOpenAIFamilySettings(["xai-relay", "claude-home"]);
  const plan = runtimeConfig.buildModelFailoverPlan(
    appSettings,
    selection(appSettings, "gateway", "gpt-5.2"),
  );
  const providerLayer = plan.fallbacks.filter((f) => f.layer === "provider");
  assert.deepEqual(
    providerLayer.map((f) => [
      f.selectedModel.customProviderId,
      f.runtime.family,
      f.runtime.dialect,
    ]),
    [["xai-relay", "openai", "xai"]],
  );
  // 三层顺序：凭据 → 端点 → 供应商。
  assert.deepEqual(
    plan.fallbacks.map((f) => f.layer),
    ["credential", "credential", "endpoint", "provider"],
  );
});

test("legacy single-key providers still produce provider-layer-only plans", () => {
  const appSettings = buildSettings(["provider-a2"]);
  const plan = runtimeConfig.buildModelFailoverPlan(
    appSettings,
    primarySelection("provider-a", "model-1"),
  );
  assert.deepEqual(
    plan.fallbacks.map((f) => f.layer),
    ["provider"],
  );
  assert.equal(plan.fallbacks[0].runtime.family, "anthropic");
});
