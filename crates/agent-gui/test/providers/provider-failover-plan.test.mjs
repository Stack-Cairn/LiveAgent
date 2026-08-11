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
      claude_code: {
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
    "claude_code",
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
