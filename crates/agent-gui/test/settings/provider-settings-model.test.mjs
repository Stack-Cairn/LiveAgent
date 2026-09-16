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
  // 隐式端点物化后是用户手填的地址：来源 user，探测并入时不会被当成自动值。
  assert.equal(view.config.source, "user");
  assert.equal(model.materializedEndpointConfigs(provider)["anthropic-messages"].source, "user");
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

test("clearing an endpoint address keeps the endpoint instead of wiping it", () => {
  const provider = legacyAnthropicProvider({
    endpointConfigs: {
      "openai-completions": {
        baseUrl: "https://relay.example.com/v1",
        dialect: "deepseek",
        auth: { headerName: "api-key" },
        quirks: { supportsStore: false },
        headers: [{ key: "X-Team", value: "a" }],
      },
    },
  });
  const cleared = model.writeEndpoint(provider, "openai-completions", { baseUrl: "   " });
  assert.equal(cleared, provider, "empty address is a no-op");
  const endpoint = cleared.endpointConfigs["openai-completions"];
  assert.equal(endpoint.baseUrl, "https://relay.example.com/v1");
  assert.equal(endpoint.dialect, "deepseek");
  assert.deepEqual(endpoint.auth, { headerName: "api-key" });
  assert.deepEqual(endpoint.quirks, { supportsStore: false });
  assert.deepEqual(endpoint.headers, [{ key: "X-Team", value: "a" }]);
  // 主连接同理。
  assert.equal(model.writeEndpoint(provider, "anthropic-messages", { baseUrl: "" }), provider);
  // 其它字段照常可写。
  const dialect = model.writeEndpoint(provider, "openai-completions", { dialect: "xai" });
  assert.equal(dialect.endpointConfigs["openai-completions"].dialect, "xai");
  assert.equal(dialect.endpointConfigs["openai-completions"].baseUrl, "https://relay.example.com/v1");
});

test("configure keeps a failing legacy main connection as the default endpoint", () => {
  const probe = loader.loadModule("@liveagent/ui/pages/settings/providerProbe.ts");
  // 旧存档：只有主连接（Anthropic Messages），用户手填的中转地址。
  const provider = legacyAnthropicProvider();
  const candidates = model.providerProbeCandidates(provider);
  const messages = candidates.find((c) => c.protocol === "anthropic-messages");
  assert.equal(messages.origin, "existing");
  const completions = candidates.find((c) => c.protocol === "openai-completions");
  assert.ok(completions, "custom preset probes all four protocols");
  const probeResult = {
    at: 42,
    credentials: [
      {
        credentialId: provider.credentials[0].id,
        endpoints: candidates.map((candidate) =>
          candidate.protocol === "openai-completions"
            ? { protocol: candidate.protocol, baseUrl: candidate.baseUrl, status: "ok", latencyMs: 8, models: [{ id: "gpt-5", contextWindow: 128000, maxOutputToken: 8192 }] }
            : { protocol: candidate.protocol, baseUrl: candidate.baseUrl, status: "unknown", error: "boom", models: [] },
        ),
      },
    ],
  };
  const auto = probe.buildAutoConfiguration({
    preset: undefined,
    candidates,
    probe: probeResult,
    credentials: provider.credentials,
  });
  const next = model.applyProbeToProvider(provider, { candidates, probe: probeResult, auto, mode: "configure" });
  // 默认接口不被切走，主连接不被停用，只记下观测。
  assert.equal(model.providerDefaultProtocol(next), "anthropic-messages");
  assert.equal(next.baseUrl, "https://relay.example.com/v1");
  assert.equal(next.endpointConfigs["anthropic-messages"].enabled, undefined);
  assert.equal(next.endpointConfigs["anthropic-messages"].source, "user");
  assert.equal(next.endpointConfigs["anthropic-messages"].lastProbe.status, "unknown");
  assert.deepEqual(model.providerEnabledProtocols(next), ["anthropic-messages", "openai-completions"]);
  assert.equal(next.endpointConfigs["openai-completions"].source, "auto");
  assert.ok(next.models.some((item) => item.id === "gpt-5"));

  // refresh 模式同样只记观测。
  const refreshed = model.applyProbeToProvider(provider, { candidates, probe: probeResult, auto, mode: "refresh" });
  assert.equal(model.providerDefaultProtocol(refreshed), "anthropic-messages");
  assert.equal(refreshed.endpointConfigs["anthropic-messages"].enabled, undefined);
});

test("reordering inside a group rewrites modelOrder without touching other groups", () => {
  const provider = legacyAnthropicProvider({
    models: [{ id: "gpt-5" }, { id: "claude-opus-4" }, { id: "claude-sonnet-4" }, { id: "gpt-4.1" }],
    modelOrder: ["claude-sonnet-4", "gpt-5", "claude-opus-4", "gpt-4.1"],
    activeModels: [],
  });
  const next = model.reorderProviderModels(provider, "claude", ["claude-opus-4", "claude-sonnet-4"]);
  assert.deepEqual(next.modelOrder, ["claude-opus-4", "claude-sonnet-4", "gpt-5", "gpt-4.1"]);
  assert.deepEqual(
    model.groupProviderModels(next).map((group) => [group.key, group.models.map((item) => item.id)]),
    [
      ["claude", ["claude-opus-4", "claude-sonnet-4"]],
      ["gpt", ["gpt-5", "gpt-4.1"]],
    ],
  );
  // 非法顺序（缺项 / 多项 / 分组不存在）不写入。
  assert.equal(model.reorderProviderModels(provider, "claude", ["claude-opus-4"]), provider);
  assert.equal(model.reorderProviderModels(provider, "claude", ["claude-opus-4", "claude-sonnet-4", "gpt-5"]), provider);
  assert.equal(model.reorderProviderModels(provider, "nope", []), provider);
});

test("failover candidates mirror the runtime plan across the three layers", () => {
  const provider = settings.normalizeCustomProvider({
    id: "p-main",
    name: "Main",
    type: "codex",
    baseUrl: "https://relay.example.com/v1",
    apiKey: "sk-a",
    credentials: [
      { id: "a", label: "A", apiKey: "sk-a", enabled: true, modelScope: { mode: "all" } },
      { id: "b", label: "B", apiKey: "sk-b", enabled: true, modelScope: { mode: "manual", models: ["gpt-*"] } },
      { id: "c", label: "C", apiKey: "sk-c", enabled: false, modelScope: { mode: "all" } },
      { id: "d", label: "D", apiKey: "", enabled: true, modelScope: { mode: "all" } },
      { id: "e", label: "E", apiKey: "sk-e", enabled: true, modelScope: { mode: "manual", models: ["claude-*"] } },
    ],
    models: [{ id: "gpt-5", chatProtocol: "openai-responses" }],
    activeModels: ["gpt-5"],
    defaultChatProtocol: "openai-responses",
    endpointConfigs: {
      "openai-responses": { baseUrl: "https://relay.example.com/v1" },
      "openai-completions": { baseUrl: "https://relay.example.com/v1" },
      "anthropic-messages": { baseUrl: "https://relay.example.com" },
    },
  });
  const other = settings.normalizeCustomProvider({
    id: "p-other",
    name: "Other",
    type: "codex",
    baseUrl: "https://other.example.com/v1",
    apiKey: "sk-o",
    models: [{ id: "gpt-5" }],
    activeModels: ["gpt-5"],
  });
  const wrongFamily = settings.normalizeCustomProvider({
    id: "p-anthropic",
    name: "Anthropic relay",
    type: "claude_code",
    baseUrl: "https://claude.example.com",
    apiKey: "sk-c",
    models: [{ id: "gpt-5" }],
    activeModels: ["gpt-5"],
  });
  const noModel = settings.normalizeCustomProvider({
    id: "p-nomodel",
    name: "No model",
    type: "codex",
    baseUrl: "https://nomodel.example.com/v1",
    apiKey: "sk-n",
    models: [{ id: "gpt-4.1" }],
    activeModels: ["gpt-4.1"],
  });
  const disabledProvider = settings.normalizeCustomProvider({
    id: "p-disabled",
    name: "Disabled",
    type: "codex",
    enabled: false,
    baseUrl: "https://disabled.example.com/v1",
    apiKey: "sk-d",
    models: [{ id: "gpt-5" }],
    activeModels: ["gpt-5"],
  });
  const app = settings.normalizeSettings({
    customProviders: [provider, other, wrongFamily, noModel, disabledProvider],
    modelFailover: {
      openai: { enabled: true, queue: ["p-main", "p-other", "p-anthropic", "p-nomodel", "p-disabled"], maxSwitches: 2, failureThreshold: 2, cooldownSeconds: 30 },
    },
  });
  const route = settings.resolveProviderChatRoute(provider, "gpt-5");
  assert.equal(route.protocol, "openai-responses");
  assert.equal(route.credentialId, "a");
  const candidates = model.modelFailoverCandidates(app, provider, "gpt-5", route);
  assert.equal(candidates.family, "openai");
  assert.equal(candidates.providerLayerEnabled, true);
  // 凭据层：跳过当前 Key（a）、停用（c）、未配置（d）、范围不含（e）。
  assert.deepEqual(candidates.credentials.map((item) => item.id), ["b"]);
  // 端点层：供应商已启用的同家族其它接口；Messages 跨家族被排除。
  assert.deepEqual(candidates.endpoints, ["openai-completions"]);
  // 供应商层：排除自己、跨家族、未启用同名模型、已停用的供应商。
  assert.deepEqual(candidates.providers.map((item) => item.id), ["p-other"]);

  const off = model.modelFailoverCandidates(
    { ...app, modelFailover: { ...app.modelFailover, openai: { ...app.modelFailover.openai, enabled: false } } },
    provider,
    "gpt-5",
    route,
  );
  assert.equal(off.providerLayerEnabled, false);
  assert.deepEqual(off.providers, []);
  assert.deepEqual(off.credentials.map((item) => item.id), ["b"], "credential layer is not gated by the switch");
});

test("copying an instance prefills endpoints, dialects and auth from the source", () => {
  const source = settings.normalizeCustomProvider({
    id: "p-src",
    name: "Packy",
    type: "codex",
    baseUrl: "https://www.packyapi.com/v1",
    apiKey: "sk-src",
    dialect: "xai",
    useSystemProxy: true,
    models: [{ id: "gpt-5" }],
    activeModels: ["gpt-5"],
    defaultChatProtocol: "openai-completions",
    endpointConfigs: {
      "openai-completions": { baseUrl: "https://www.packyapi.com/v1", quirks: { supportsStore: false } },
      "anthropic-messages": { baseUrl: "https://www.packyapi.com", auth: { headerName: "x-api-key" }, dialect: "generic" },
    },
  });
  assert.equal(model.instanceNameForCopy(source, [source]), "Packy · 2");
  assert.equal(model.instanceNameForCopy(source, [source, { name: "Packy · 2" }]), "Packy · 3");
  assert.equal(model.instanceNameForCopy({ ...source, name: "Packy · 2" }, [source, { name: "Packy · 2" }]), "Packy · 3");

  const copy = model.createProviderFromEndpoints({
    name: "Packy · 2",
    preset: undefined,
    apiKey: "sk-copy",
    endpoints: {
      "openai-completions": "https://www.packyapi.com/v1",
      "anthropic-messages": "https://www.packyapi.com",
    },
    template: source,
  });
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.dialect, "xai");
  assert.equal(copy.useSystemProxy, true);
  assert.equal(copy.apiKey, "sk-copy");
  assert.deepEqual(copy.models, [], "models are re-probed, not copied");
  assert.deepEqual(copy.endpointConfigs["openai-completions"].quirks, { supportsStore: false });
  assert.deepEqual(copy.endpointConfigs["anthropic-messages"].auth, { headerName: "x-api-key" });
  assert.equal(copy.endpointConfigs["anthropic-messages"].source, "user");
});

test("credential helpers count configured keys and compare scopes only when both were fetched", () => {
  const provider = legacyAnthropicProvider({
    credentials: [
      { id: "a", label: "", apiKey: "sk-a", enabled: true },
      { id: "b", label: "B", apiKey: "", apiKeyConfigured: true, enabled: true },
      { id: "c", label: "C", apiKey: "", enabled: true },
      { id: "d", label: "D", apiKey: "sk-d", enabled: false },
    ],
  });
  assert.deepEqual(model.configuredCredentials(provider).map((item) => item.id), ["a", "b", "d"]);
  assert.equal(model.providerKeyReady(provider), true);
  assert.equal(
    model.providerKeyReady(legacyAnthropicProvider({ apiKey: "", credentials: [{ id: "a", label: "", apiKey: "", enabled: true }] })),
    false,
  );
  const primary = { id: "a", label: "", apiKey: "sk", enabled: true };
  const backup = { id: "b", label: "", apiKey: "sk", enabled: true, lastModels: { at: 1, models: ["x"] } };
  assert.equal(model.credentialModelDiff(backup, primary), null, "primary not fetched → nothing to compare");
  assert.equal(model.credentialModelDiff(primary, backup), null);
  assert.deepEqual(
    model.credentialModelDiff(backup, { ...primary, lastModels: { at: 1, models: ["x", "y"] } }),
    { more: 0, less: 1 },
  );
});

// ---------------------------------------------------------------------------
// 能力芯片来源 / 目录信息 / 限额来源 / 列表行图标（设计文档 6.1 / 6.6）
// ---------------------------------------------------------------------------
const capabilities = loader.loadModule("@liveagent/ui/lib/models/modelCapabilities.ts");

function openaiProvider(extra = {}) {
  return settings.normalizeCustomProvider({
    id: "oa",
    name: "OpenAI",
    type: "codex",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    models: [{ id: "gpt-5.2" }, { id: "my-finetune" }],
    activeModels: ["gpt-5.2", "my-finetune"],
    ...extra,
  });
}

test("capability chips take their state from the effective value and only mark user overrides", () => {
  // 三态用形状区分（实心点 / 空心圆 / 问号），来源只体现为"用户覆盖加描边"。
  assert.deepEqual(model.capabilityChipView({ state: "supported", source: "user" }), {
    state: "supported",
    overridden: true,
    muted: false,
  });
  assert.deepEqual(model.capabilityChipView({ state: "unsupported", source: "user" }), {
    state: "unsupported",
    overridden: true,
    muted: false,
  });
  assert.deepEqual(model.capabilityChipView({ state: "supported", source: "catalog" }), {
    state: "supported",
    overridden: false,
    muted: false,
  });
  assert.deepEqual(model.capabilityChipView({ state: "unsupported", source: "catalog" }), {
    state: "unsupported",
    overridden: false,
    muted: false,
  });
  // 供应商规则 / 启发式：只在 tooltip 里说明来源；未知：问号图标。
  assert.equal(model.capabilityChipView({ state: "supported", source: "provider" }).muted, true);
  assert.equal(model.capabilityChipView({ state: "supported", source: "heuristic" }).muted, true);
  assert.deepEqual(model.capabilityChipView({ state: "unknown", source: "unknown" }), {
    state: "unknown",
    overridden: false,
    muted: false,
  });
});

test("catalog hits render chips as catalog values instead of the old always-unknown default", () => {
  const provider = openaiProvider();
  const resolved = capabilities.resolveModelCapabilities(provider, "gpt-5.2");
  // 用户反馈"能力芯片默认都是关闭的"：目录命中的模型工具 / 结构化输出 / 视觉
  // 必须直接是目录值，而不是全部未知。
  assert.equal(model.capabilityChipView(resolved.tools).state, "supported");
  assert.equal(model.capabilityChipView(resolved.structuredOutput).state, "supported");
  assert.equal(model.capabilityChipView(resolved.imageUnderstanding).state, "supported");
  // 目录未收录：工具 / 结构化输出未知，推理按启发式弱化。
  const miss = capabilities.resolveModelCapabilities(provider, "my-finetune");
  assert.equal(model.capabilityChipView(miss.tools).state, "unknown");
  assert.equal(model.capabilityChipView(miss.reasoning).muted, true);
});

test("catalog info reports the section, entry and the normalized id it matched on", () => {
  const provider = openaiProvider();
  const hit = capabilities.resolveModelCatalogInfo(provider, "gpt-5.2");
  assert.equal(hit.catalogProviderId, "openai");
  assert.equal(hit.entry.id, "gpt-5.2");
  assert.equal(hit.matchedId, "gpt-5.2");
  assert.ok(hit.entry.contextWindow > 0);
  assert.ok(Array.isArray(hit.entry.inputModalities));

  // 中转装饰过的 id：面板要提示"按 xxx 匹配"。
  const decorated = capabilities.resolveModelCatalogInfo(provider, "GPT-5.2@latest");
  assert.equal(decorated.entry.id, "gpt-5.2");
  assert.notEqual(decorated.matchedId, "GPT-5.2@latest");

  assert.equal(capabilities.resolveModelCatalogInfo(provider, "my-finetune"), undefined);
  assert.match(
    loader.loadModule("@liveagent/ui/lib/models/modelCatalog.ts").MODEL_CATALOG_SNAPSHOT_DATE,
    /^\d{4}-\d{2}-\d{2}$/,
  );
});

test("capability table rows pair catalog value, effective value and user override", () => {
  const provider = openaiProvider({
    models: [
      { id: "gpt-5.2", capabilities: { tools: "unsupported" }, inputModalities: ["text"] },
      { id: "my-finetune" },
    ],
  });
  const route = settings.resolveProviderChatRoute(provider, "gpt-5.2");
  const rows = model.modelCapabilityRows(provider, "gpt-5.2", route);
  assert.deepEqual(
    rows.map((row) => row.key),
    [
      "imageUnderstanding",
      "fileInput",
      "audioInput",
      "videoInput",
      "reasoning",
      "tools",
      "structuredOutput",
      "nativeWebSearch",
    ],
  );
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  // 目录值 = 条目原始值；有效值 = 用户覆盖优先；覆盖列读 capabilities / inputModalities。
  assert.equal(byKey.tools.catalog, "supported");
  assert.deepEqual(byKey.tools.effective, { state: "unsupported", source: "user" });
  assert.equal(byKey.tools.override, "unsupported");
  assert.equal(byKey.imageUnderstanding.catalog, "supported");
  assert.equal(byKey.imageUnderstanding.override, "unsupported");
  assert.equal(byKey.imageUnderstanding.editable, true);
  // 音频 / 视频：目录只给模态，运行时不支持覆盖。
  assert.equal(byKey.audioInput.catalog, "unsupported");
  assert.equal(byKey.audioInput.editable, false);
  assert.equal(byKey.audioInput.override, undefined);
  // 原生搜索目录不收录：目录值为空，有效值走供应商规则。
  assert.equal(byKey.nativeWebSearch.catalog, undefined);
  assert.equal(byKey.nativeWebSearch.effective.source, "provider");
  assert.equal(model.hasModelCapabilityOverrides(provider.models[0]), true);

  // 目录未收录：目录值整列为空，有效值按启发式 / 未知。
  const miss = model.modelCapabilityRows(
    provider,
    "my-finetune",
    settings.resolveProviderChatRoute(provider, "my-finetune"),
  );
  assert.ok(miss.every((row) => row.catalog === undefined));
  assert.equal(miss.find((row) => row.key === "tools").effective.state, "unknown");
  assert.equal(model.hasModelCapabilityOverrides(provider.models[1]), false);
});

test("limit fields carry per-field sources and reset individually", () => {
  const defaults = {
    contextWindow: 400_000,
    maxInputTokens: 272_000,
    maxOutputToken: 128_000,
    source: "catalog",
  };
  const catalogModel = {
    id: "gpt-5.2",
    contextWindow: 400_000,
    maxInputTokens: 272_000,
    maxOutputToken: 128_000,
    limitsSource: "catalog",
  };
  assert.deepEqual(model.modelLimitFieldSources(catalogModel, defaults), {
    contextWindow: "catalog",
    maxInputTokens: "catalog",
    maxOutputToken: "catalog",
  });
  // 用户只改了输出上限：其它两项仍显示目录来源。
  const edited = { ...catalogModel, maxOutputToken: 64_000, limitsSource: "user" };
  assert.deepEqual(model.modelLimitFieldSources(edited, defaults), {
    contextWindow: "catalog",
    maxInputTokens: "catalog",
    maxOutputToken: "user",
  });
  const restored = model.resetModelLimitField(edited, defaults, "maxOutputToken");
  assert.equal(restored.maxOutputToken, 128_000);
  assert.equal(restored.limitsSource, "catalog");
  // 兜底限额且没有最大输入：该项不显示徽标。
  const fallbackDefaults = { contextWindow: 128_000, maxOutputToken: 32_000, source: "fallback" };
  assert.deepEqual(
    model.modelLimitFieldSources(
      { id: "x", contextWindow: 128_000, maxOutputToken: 32_000, limitsSource: "fallback" },
      fallbackDefaults,
    ),
    { contextWindow: "heuristic", maxInputTokens: undefined, maxOutputToken: "heuristic" },
  );
  const withInput = model.resetModelLimitField(
    { id: "x", contextWindow: 1, maxInputTokens: 5, maxOutputToken: 32_000, limitsSource: "user" },
    fallbackDefaults,
    "maxInputTokens",
  );
  assert.equal("maxInputTokens" in withInput, false);
  assert.equal(withInput.limitsSource, "user", "context window still differs");
});

test("model row flags follow effective capabilities and input modalities", () => {
  const provider = openaiProvider({
    models: [
      { id: "gpt-5.2" },
      { id: "my-finetune" },
      { id: "gpt-5.2-nano", capabilities: { imageUnderstanding: "unsupported", tools: "unsupported" } },
      { id: "my-vl", inputModalities: ["text", "image"], nativeWebSearch: true },
    ],
  });
  const route = settings.resolveProviderChatRoute(provider, "gpt-5.2");
  const catalogFlags = model.modelCapabilityFlags(provider, "gpt-5.2", route);
  assert.equal(catalogFlags.vision, true);
  assert.equal(catalogFlags.tools, true, "catalog toolCall lights the wrench without a user override");
  assert.equal(catalogFlags.search, false, "provider-rule search availability stays off the row");

  // 目录未收录：图片 / 文件 / 工具 / 搜索都不亮；推理按 OpenAI 世代启发式，不在此锁定。
  const miss = model.modelCapabilityFlags(provider, "my-finetune", route);
  assert.deepEqual(
    { vision: miss.vision, file: miss.file, tools: miss.tools, search: miss.search },
    { vision: false, file: false, tools: false, search: false },
  );

  const overridden = model.modelCapabilityFlags(provider, "gpt-5.2-nano", route);
  assert.equal(overridden.vision, false, "user unsupported beats catalog modalities");
  assert.equal(overridden.tools, false);

  const userModalities = model.modelCapabilityFlags(provider, "my-vl", route);
  assert.equal(userModalities.vision, true, "user inputModalities override lights the image icon");
  assert.equal(userModalities.search, true);

  // 文件图标：目录 attachment 位或 pdf 模态。
  const anthropic = settings.normalizeCustomProvider({
    id: "an",
    name: "Anthropic",
    type: "claude_code",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant",
    models: [{ id: "claude-sonnet-4-6" }],
    activeModels: ["claude-sonnet-4-6"],
  });
  const claude = model.modelCapabilityFlags(
    anthropic,
    "claude-sonnet-4-6",
    settings.resolveProviderChatRoute(anthropic, "claude-sonnet-4-6"),
  );
  assert.equal(claude.file, true);
  assert.equal(claude.vision, true);
});
