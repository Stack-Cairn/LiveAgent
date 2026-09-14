import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 供应商设置页纯函数层（三栏结构的读写地基）的反漂移锁：隐式端点物化、默认接口
// 切换、主连接同步、探测结果并入、添加渠道对话框的实例创建。
const loader = createTsModuleLoader({
  mocks: { "@tauri-apps/api/core": { invoke: async () => ({}) } },
});
const model = loader.loadModule("@liveagent/ui/pages/settings/providers/providerSettingsModel.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

function legacyAnthropicProvider(extra = {}) {
  return settings.normalizeCustomProvider({
    id: "p1",
    name: "Relay",
    type: "claude_code",
    baseUrl: "https://relay.example.com/v1",
    apiKey: "sk-primary",
    models: [{ id: "claude-sonnet-4" }],
    activeModels: ["claude-sonnet-4"],
    ...extra,
  });
}

test("legacy single-address providers expose the main connection as the implicit default endpoint", () => {
  const provider = legacyAnthropicProvider();
  const view = model.readEndpoint(provider, "anthropic-messages");
  assert.equal(view.explicit, false);
  assert.equal(view.config.baseUrl, "https://relay.example.com/v1");
  assert.equal(model.readEndpoint(provider, "openai-completions"), undefined);
  assert.deepEqual(model.providerConfiguredProtocols(provider), ["anthropic-messages"]);
  assert.equal(model.providerDefaultProtocol(provider), "anthropic-messages");
});

test("writing the implicit default endpoint materializes it and keeps the main connection in sync", () => {
  const provider = legacyAnthropicProvider();
  const next = model.writeEndpoint(provider, "anthropic-messages", {
    baseUrl: "https://other.example.com",
  });
  assert.equal(next.baseUrl, "https://other.example.com");
  assert.equal(next.endpointConfigs["anthropic-messages"].baseUrl, "https://other.example.com");
  assert.equal(next.endpointConfigs["anthropic-messages"].source, "user");
  assert.equal(model.readEndpoint(next, "anthropic-messages").explicit, true);
});

test("switching the default endpoint materializes the old one", () => {
  const provider = legacyAnthropicProvider({
    endpointConfigs: { "openai-completions": { baseUrl: "https://relay.example.com/v1" } },
  });
  const next = model.setDefaultProtocol(provider, "openai-completions");
  assert.equal(next.defaultChatProtocol, "openai-completions");
  // requestFormat 只对 codex / xai 旧类型保留；claude_code 类型的实例由归一化丢弃。
  assert.equal(next.requestFormat, undefined);
  assert.equal(next.endpointConfigs["anthropic-messages"].baseUrl, "https://relay.example.com/v1");
  assert.deepEqual(model.providerConfiguredProtocols(next), [
    "openai-completions",
    "anthropic-messages",
  ]);
  assert.equal(model.removeEndpoint(next, "openai-completions"), next);
  const disabled = model.setEndpointEnabled(next, "anthropic-messages", false);
  assert.deepEqual(model.providerEnabledProtocols(disabled), ["openai-completions"]);
});

test("the primary key is mirrored between apiKey and credentials[0]", () => {
  const provider = legacyAnthropicProvider();
  const next = model.setPrimaryApiKey(provider, "sk-new");
  assert.equal(next.apiKey, "sk-new");
  assert.equal(next.credentials[0].apiKey, "sk-new");
  assert.equal(next.apiKeyConfigured, true);
  const cleared = model.setPrimaryApiKey(next, "", { keepConfigured: true });
  assert.equal(cleared.apiKey, "");
  assert.equal(cleared.apiKeyConfigured, true);
});

test("applyProbeToProvider appends new models, keeps existing ones and records observations", () => {
  const provider = legacyAnthropicProvider({
    models: [
      { id: "claude-sonnet-4", contextWindow: 123, maxOutputToken: 45, limitsSource: "user" },
    ],
  });
  const candidates = model.providerExistingCandidates(provider);
  assert.equal(candidates.length, 1);
  const probe = {
    at: 1000,
    credentials: [
      {
        credentialId: provider.credentials[0].id,
        endpoints: [
          {
            protocol: "anthropic-messages",
            baseUrl: candidates[0].baseUrl,
            status: "ok",
            latencyMs: 42,
            models: [
              { id: "claude-sonnet-4", contextWindow: 200000, maxOutputToken: 8192 },
              { id: "claude-opus-4", contextWindow: 200000, maxOutputToken: 8192 },
            ],
          },
        ],
      },
    ],
  };
  const auto = {
    endpointConfigs: {
      "anthropic-messages": { baseUrl: candidates[0].baseUrl, source: "user" },
    },
    defaultChatProtocol: "anthropic-messages",
    models: [
      { id: "claude-sonnet-4", contextWindow: 200000, maxOutputToken: 8192, group: "claude" },
      { id: "claude-opus-4", contextWindow: 200000, maxOutputToken: 8192, group: "claude" },
    ],
    activeModels: ["claude-sonnet-4", "claude-opus-4"],
    credentials: [
      {
        ...provider.credentials[0],
        lastModels: { at: 1000, models: ["claude-opus-4", "claude-sonnet-4"] },
      },
    ],
    usable: true,
  };
  const next = model.applyProbeToProvider(provider, { candidates, probe, auto, mode: "refresh" });
  const sonnet = next.models.find((item) => item.id === "claude-sonnet-4");
  assert.equal(sonnet.contextWindow, 123, "user limits survive a refresh");
  assert.ok(next.models.some((item) => item.id === "claude-opus-4"));
  assert.deepEqual(next.activeModels, ["claude-sonnet-4", "claude-opus-4"]);
  assert.equal(next.endpointConfigs["anthropic-messages"].lastProbe.status, "ok");
  assert.equal(next.endpointConfigs["anthropic-messages"].lastProbe.latencyMs, 42);
  assert.deepEqual(next.credentials[0].lastModels.models, ["claude-opus-4", "claude-sonnet-4"]);
  assert.equal(next.defaultChatProtocol, "anthropic-messages");
});

test("createProviderFromEndpoints derives the default endpoint and legacy type", () => {
  const provider = model.createProviderFromEndpoints({
    name: "My relay",
    preset: undefined,
    category: "relay",
    apiKey: "sk-relay",
    endpoints: {
      "anthropic-messages": "https://relay.example.com",
      "openai-completions": "https://relay.example.com/v1",
    },
  });
  assert.equal(provider.presetId, "custom");
  assert.equal(provider.defaultChatProtocol, "openai-completions");
  assert.equal(provider.type, "codex");
  assert.equal(provider.baseUrl, "https://relay.example.com/v1");
  assert.equal(provider.endpointConfigs["anthropic-messages"].baseUrl, "https://relay.example.com");
  assert.equal(provider.endpointConfigs["openai-completions"].source, "user");
  assert.equal(provider.credentials[0].apiKey, "sk-relay");
  assert.deepEqual(provider.models, []);
});

test("instance names disambiguate repeated presets and origin hosts", () => {
  const registry = loader.loadModule("@liveagent/ui/lib/providers/registry/index.ts");
  const anthropic = registry.findProviderPreset("anthropic");
  const newApi = registry.findProviderPreset("new-api");
  assert.equal(model.instanceNameForPreset(anthropic, []), "Anthropic");
  assert.equal(
    model.instanceNameForPreset(anthropic, [{ name: "Anthropic" }]),
    "Anthropic · 2",
  );
  assert.equal(
    model.instanceNameForPreset(newApi, [], "https://relay.example.com"),
    "New API / One API · relay.example.com",
  );
});

test("models are grouped by family in modelOrder order", () => {
  const provider = legacyAnthropicProvider({
    models: [{ id: "gpt-5" }, { id: "claude-opus-4" }, { id: "claude-sonnet-4" }],
    modelOrder: ["claude-sonnet-4", "gpt-5", "claude-opus-4"],
    activeModels: [],
  });
  const groups = model.groupProviderModels(provider);
  assert.deepEqual(
    groups.map((group) => [group.key, group.models.map((item) => item.id)]),
    [
      ["claude", ["claude-sonnet-4", "claude-opus-4"]],
      ["gpt", ["gpt-5"]],
    ],
  );
});
