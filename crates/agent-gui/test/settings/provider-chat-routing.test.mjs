import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");

test("provider routing normalization keeps valid routes and drops unknown protocols", () => {
  const provider = settings.normalizeCustomProvider({
    id: "gateway",
    type: "codex",
    baseUrl: " https://gateway.example/v1 ",
    requestFormat: "openai-completions",
    defaultChatProtocol: "google-generative-ai",
    endpointConfigs: {
      "anthropic-messages": { baseUrl: " https://gateway.example/anthropic/v1/ " },
      "unknown-wire": { baseUrl: "https://bad.example/v1" },
      "openai-responses": { baseUrl: "   " },
    },
    models: [
      { id: "claude-proxy", chatProtocol: "anthropic-messages" },
      { id: "unknown", chatProtocol: "invented-wire" },
    ],
  });

  assert.equal(provider.defaultChatProtocol, "google-generative-ai");
  assert.deepEqual(provider.endpointConfigs, {
    "anthropic-messages": { baseUrl: "https://gateway.example/anthropic/v1" },
  });
  assert.equal(provider.models[0].chatProtocol, "anthropic-messages");
  // 旧有序列表只取首项，输出不再带 chatProtocols。
  assert.equal("chatProtocols" in provider.models[0], false);
  assert.equal(provider.models[1].chatProtocol, undefined);
  // 新实例默认凭据与旧字段同步。
  assert.equal(provider.credentials.length, 1);
  assert.equal(provider.credentials[0].apiKey, provider.apiKey);
  // 中转地址不属于任何官方主机 → 自定义渠道，而不是 OpenAI 官方预设。
  assert.equal(provider.presetId, "custom");
  const official = settings.normalizeCustomProvider({
    id: "oa",
    type: "codex",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5"],
  });
  assert.equal(official.presetId, "openai");
  const mislabeled = settings.normalizeCustomProvider({
    id: "relay",
    type: "codex",
    presetId: "openai",
    baseUrl: "https://www.packyapi.com/v1",
    models: ["gpt-5"],
  });
  assert.equal(mislabeled.presetId, "custom");
});

test("legacy deepseek-responses protocol rewrites to Responses + deepseek dialect", () => {
  const provider = settings.normalizeCustomProvider({
    id: "ds",
    type: "codex",
    baseUrl: "https://relay.example/v1",
    defaultChatProtocol: "deepseek-responses",
    endpointConfigs: { "deepseek-responses": { baseUrl: "https://relay.example/ds" } },
    models: [{ id: "deepseek-v4-pro", chatProtocol: "deepseek-responses" }],
  });
  assert.equal(provider.defaultChatProtocol, "openai-responses");
  assert.equal(provider.dialect, "deepseek");
  assert.equal(provider.endpointConfigs["openai-responses"].baseUrl, "https://relay.example/ds");
  assert.equal(provider.endpointConfigs["openai-responses"].dialect, "deepseek");
  assert.equal(provider.models[0].chatProtocol, "openai-responses");
  const route = settings.resolveProviderChatRoute(provider, "deepseek-v4-pro");
  assert.equal(route.protocol, "openai-responses");
  assert.equal(route.dialect, "deepseek");
  assert.equal(route.adapterProviderId, "deepseek");
});

test("route precedence is model > provider > legacy and resolves adapter families", () => {
  const provider = settings.normalizeCustomProvider({
    id: "gateway",
    type: "codex",
    baseUrl: "https://gateway.example/v1",
    isFullUrl: true,
    requestFormat: "openai-completions",
    defaultChatProtocol: "google-generative-ai",
    endpointConfigs: {
      "anthropic-messages": { baseUrl: "https://gateway.example/anthropic/v1" },
    },
    models: [
      { id: "claude-proxy", chatProtocol: "anthropic-messages" },
      { id: "gemini-proxy" },
    ],
  });

  const claudeRoute = settings.resolveProviderChatRoute(provider, "claude-proxy");
  assert.equal(claudeRoute.protocol, "anthropic-messages");
  assert.equal(claudeRoute.protocolSource, "model");
  assert.equal(claudeRoute.family, "anthropic");
  assert.equal(claudeRoute.dialect, "generic");
  assert.equal(claudeRoute.adapterProviderId, "claude_code");
  assert.equal(claudeRoute.baseUrl, "https://gateway.example/anthropic/v1");
  assert.equal(claudeRoute.isFullUrl, false);
  assert.equal(claudeRoute.wireModelId, "claude-proxy");
  assert.equal(claudeRoute.credentialId, provider.credentials[0].id);

  // gemini-proxy has no explicit protocol: the family table prefers Gemini,
  // and the provider default endpoint serves it.
  const geminiRoute = settings.resolveProviderChatRoute(provider, "gemini-proxy");
  assert.equal(geminiRoute.protocol, "google-generative-ai");
  assert.equal(geminiRoute.protocolSource, "family");
  assert.equal(geminiRoute.adapterProviderId, "gemini");
  assert.equal(geminiRoute.baseUrl, "https://gateway.example/v1");
  // 主连接充当的是 defaultChatProtocol（Gemini）的隐式端点：它的完整 URL 开关随主连接，
  // 与界面 readEndpoint 的口径一致，而不是只对旧推导协议生效。
  assert.equal(geminiRoute.isFullUrl, true);

  const legacy = settings.normalizeCustomProvider({
    id: "legacy",
    type: "codex",
    baseUrl: "https://gateway.example/v1",
    requestFormat: "openai-completions",
    models: ["chat-model"],
  });
  const legacyRoute = settings.resolveProviderChatRoute(legacy, "chat-model");
  assert.equal(legacyRoute.protocol, "openai-completions");
  // 未知家族偏好 Completions，且它正是该供应商唯一可用的接口。
  assert.equal(legacyRoute.protocolSource, "family");
  assert.equal(legacyRoute.dialect, "openai");
  assert.equal(legacyRoute.adapterProviderId, "codex");
  assert.equal(legacyRoute.baseUrl, "https://gateway.example/v1");
  assert.equal(legacyRoute.isFullUrl, false);
  assert.equal(legacyRoute.requestFormat, "openai-completions");
});

test("implicit endpoint is materialized from the main connection with one decision key", () => {
  // 存档：默认接口 Completions、主连接是完整 URL、没有 endpointConfigs。旧实现里
  // 界面显示"完整 URL 开"，路由却按 requestFormat 推导的旧协议算出 false。
  const provider = settings.normalizeCustomProvider({
    id: "full-url",
    type: "codex",
    baseUrl: "https://relay.example/v1/custom-path",
    isFullUrl: true,
    modelsUrl: "https://relay.example/models",
    defaultChatProtocol: "openai-completions",
    models: ["my-model"],
  });
  assert.equal(provider.isFullUrl, true);
  const endpoint = settings.resolveProviderEndpoint(provider, "openai-completions");
  assert.equal(endpoint.explicit, false);
  assert.deepEqual(endpoint.config, {
    baseUrl: "https://relay.example/v1/custom-path",
    isFullUrl: true,
    modelsUrl: "https://relay.example/models",
    source: "user",
  });
  assert.equal(settings.resolveProviderEndpoint(provider, "openai-responses"), undefined);
  assert.deepEqual(settings.getProviderEnabledProtocols(provider), ["openai-completions"]);

  const route = settings.resolveProviderChatRoute(provider, "my-model");
  assert.equal(route.protocol, "openai-completions");
  assert.equal(route.baseUrl, "https://relay.example/v1/custom-path");
  assert.equal(route.isFullUrl, true);
  assert.equal(route.modelsUrl, "https://relay.example/models");
  assert.equal(route.requestFormat, "openai-completions");

  // 显式端点存在时主连接不再参与：完整 URL 与模型列表地址都以端点为准。
  const explicit = settings.normalizeCustomProvider({
    ...provider,
    endpointConfigs: { "openai-completions": { baseUrl: "https://relay.example/v1" } },
  });
  const explicitRoute = settings.resolveProviderChatRoute(explicit, "my-model");
  assert.equal(explicitRoute.baseUrl, "https://relay.example/v1");
  assert.equal(explicitRoute.isFullUrl, false);
  assert.equal(explicitRoute.modelsUrl, undefined);
  assert.equal(settings.resolveProviderEndpoint(explicit, "openai-completions").explicit, true);

  // 旧存档没有 defaultChatProtocol：隐式接口就是旧推导（type + requestFormat）。
  const legacy = settings.normalizeCustomProvider({
    id: "legacy-full-url",
    type: "codex",
    baseUrl: "https://relay.example/v1/chat/completions",
    isFullUrl: true,
    models: ["my-model"],
  });
  assert.equal(legacy.requestFormat, "openai-completions");
  assert.equal(settings.getProviderImplicitChatProtocol(legacy), "openai-completions");
  const legacyRoute = settings.resolveProviderChatRoute(legacy, "my-model");
  assert.equal(legacyRoute.protocol, "openai-completions");
  assert.equal(legacyRoute.isFullUrl, true);
});

test("route context is computed once and can be supplied by the caller", () => {
  const provider = settings.normalizeCustomProvider({
    id: "ds",
    type: "codex",
    baseUrl: "https://api.deepseek.com",
    defaultChatProtocol: "openai-completions",
    models: ["deepseek-chat"],
  });
  const context = settings.buildProviderRouteContext(provider, "deepseek-chat");
  assert.equal(context.preset.id, "deepseek");
  assert.deepEqual(context.rule.chatProtocols, ["openai-completions"]);
  assert.equal(context.legacyProtocol, "openai-completions");
  assert.equal(context.implicitProtocol, "openai-completions");
  assert.deepEqual(settings.resolveModelRouteProtocol(provider, "deepseek-chat", undefined, context), {
    protocol: "openai-completions",
    source: "preset",
  });
  // 旧签名仍然可用，结果一致。
  assert.deepEqual(
    settings.resolveModelRouteProtocol(provider, "deepseek-chat"),
    settings.resolveModelRouteProtocol(provider, "deepseek-chat", undefined, context),
  );
  assert.equal(settings.resolveProviderDialect(provider, "openai-completions"), "deepseek");
  assert.equal(
    settings.resolveProviderDialect(provider, "openai-completions", { context }),
    "deepseek",
  );
  // 调用方明确给出"无预设"的上下文时不再回查 presetId：没有 deepseek 预设的方言，
  // 旧 codex 分组的 openai 缺省不被 api.deepseek.com 域名推翻。
  assert.equal(
    settings.resolveProviderDialect(provider, "openai-completions", {
      context: { preset: undefined },
    }),
    "openai",
  );
  assert.equal(
    settings.resolveProviderDialect(
      { ...provider, baseUrl: "https://relay.example/v1" },
      "openai-completions",
      { context: { preset: undefined } },
    ),
    "openai",
  );
});

test("credential scope checks use exact lookup for auto mode and patterns for manual mode", () => {
  const auto = {
    id: "k1",
    label: "",
    apiKey: "sk",
    enabled: true,
    lastModels: { at: 1, models: ["claude-sonnet-4", "gpt-5"] },
  };
  assert.equal(settings.credentialCoversModel(auto, "claude-sonnet-4"), true);
  assert.equal(settings.credentialCoversModel(auto, " gpt-5 "), true);
  // 网关前缀剥掉后命中。
  assert.equal(settings.credentialCoversModel(auto, "anthropic/claude-sonnet-4"), true);
  assert.equal(settings.credentialCoversModel(auto, "claude-sonnet-4*"), false);
  assert.equal(settings.credentialCoversModel(auto, "gpt-4o"), false);
  // 没有探测记录 → 视为覆盖全部。
  assert.equal(settings.credentialCoversModel({ ...auto, lastModels: undefined }, "anything"), true);
  assert.equal(
    settings.credentialCoversModel({ ...auto, lastModels: { at: 1, models: [] } }, "anything"),
    true,
  );
  const manual = { ...auto, modelScope: { mode: "manual", models: ["claude-*", "gpt-5"] } };
  assert.equal(settings.credentialCoversModel(manual, "claude-opus-4"), true);
  assert.equal(settings.credentialCoversModel(manual, "anthropic/claude-opus-4"), true);
  assert.equal(settings.credentialCoversModel(manual, "gpt-5"), true);
  assert.equal(settings.credentialCoversModel(manual, "gpt-5-mini"), false);
  assert.equal(settings.credentialCoversModel({ ...auto, modelScope: { mode: "all" } }, "x"), true);
});

test("an endpoint with an empty address is dropped and the default protocol moves on", () => {
  const provider = settings.normalizeCustomProvider({
    id: "relay",
    type: "codex",
    baseUrl: "https://relay.example/v1",
    defaultChatProtocol: "openai-responses",
    endpointConfigs: {
      "openai-responses": { baseUrl: "   ", credentialId: "default" },
      "anthropic-messages": { baseUrl: "https://relay.example" },
      "openai-completions": { baseUrl: "https://relay.example/v1", enabled: false },
    },
    models: ["claude-sonnet-4"],
  });
  assert.deepEqual(Object.keys(provider.endpointConfigs).sort(), [
    "anthropic-messages",
    "openai-completions",
  ]);
  assert.equal(provider.defaultChatProtocol, "anthropic-messages");
  // 旧字段跟着默认接口走：非 OpenAI 家族时沿用地址后缀推导。
  assert.equal(provider.requestFormat, "openai-responses");
  assert.deepEqual(settings.getProviderEnabledProtocols(provider), ["anthropic-messages"]);

  // 没有其它可用显式端点时保留原默认接口，由主连接充当隐式端点。
  const solo = settings.normalizeCustomProvider({
    id: "solo",
    type: "codex",
    baseUrl: "https://relay.example/v1",
    defaultChatProtocol: "openai-responses",
    endpointConfigs: { "openai-responses": { baseUrl: "" } },
    models: ["gpt-5"],
  });
  assert.equal(solo.endpointConfigs, undefined);
  assert.equal(solo.defaultChatProtocol, "openai-responses");
  assert.equal(settings.resolveProviderChatRoute(solo, "gpt-5").baseUrl, "https://relay.example/v1");
});

test("route baseUrl follows the endpoint version rule while the stored value is kept", () => {
  const provider = settings.normalizeCustomProvider({
    id: "relay",
    type: "codex",
    baseUrl: "https://relay.example",
    models: ["gpt-5", "claude-sonnet-4", "gemini-2.5-pro"],
    endpointConfigs: {
      "openai-completions": { baseUrl: "https://relay.example" },
      "anthropic-messages": { baseUrl: "https://relay.example" },
      "google-generative-ai": { baseUrl: "https://relay.example" },
    },
  });
  assert.equal(provider.endpointConfigs["openai-completions"].baseUrl, "https://relay.example");
  assert.equal(
    settings.resolveProviderChatRoute(provider, "gpt-5", { protocol: "openai-completions" }).baseUrl,
    "https://relay.example/v1",
  );
  assert.equal(
    settings.resolveProviderChatRoute(provider, "claude-sonnet-4", { protocol: "anthropic-messages" })
      .baseUrl,
    "https://relay.example",
  );
  assert.equal(
    settings.resolveProviderChatRoute(provider, "gemini-2.5-pro", {
      protocol: "google-generative-ai",
    }).baseUrl,
    "https://relay.example/v1beta",
  );

  const zhipu = settings.normalizeCustomProvider({
    id: "zhipu",
    type: "codex",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-5"],
  });
  assert.equal(
    settings.resolveProviderChatRoute(zhipu, "glm-5").baseUrl,
    "https://open.bigmodel.cn/api/paas/v4",
  );

  const verbatim = settings.normalizeCustomProvider({
    id: "verbatim",
    type: "codex",
    baseUrl: "https://relay.example#",
    models: ["gpt-5"],
  });
  assert.equal(verbatim.baseUrl, "https://relay.example#");
  assert.equal(settings.resolveProviderChatRoute(verbatim, "gpt-5").baseUrl, "https://relay.example");

  const full = settings.normalizeCustomProvider({
    id: "full",
    type: "codex",
    baseUrl: "https://relay.example/custom/final?region=cn",
    isFullUrl: true,
    models: ["gpt-5"],
  });
  assert.equal(
    settings.resolveProviderChatRoute(full, "gpt-5").baseUrl,
    "https://relay.example/custom/final?region=cn",
  );
});

test("disabled endpoints are skipped and the provider default takes over", () => {
  const provider = settings.normalizeCustomProvider({
    id: "relay",
    type: "codex",
    baseUrl: "https://relay.example/v1",
    defaultChatProtocol: "openai-completions",
    endpointConfigs: {
      "anthropic-messages": { baseUrl: "https://relay.example", enabled: false },
    },
    models: [{ id: "claude-sonnet-4" }],
  });
  const route = settings.resolveProviderChatRoute(provider, "claude-sonnet-4");
  assert.equal(route.protocol, "openai-completions");
  assert.equal(route.protocolSource, "family");
  assert.deepEqual(settings.getProviderEnabledProtocols(provider), ["openai-completions"]);
});

test("multi-key providers pick credentials by model scope", () => {
  const provider = settings.normalizeCustomProvider({
    id: "relay",
    type: "claude_code",
    baseUrl: "https://relay.example",
    credentials: [
      { id: "k1", label: "main", apiKey: "sk-1", enabled: true, lastModels: { at: 1, models: ["claude-sonnet-4"] } },
      { id: "k2", label: "backup", apiKey: "sk-2", enabled: true, lastModels: { at: 1, models: ["gpt-5"] } },
    ],
    endpointConfigs: { "openai-responses": { baseUrl: "https://relay.example/v1", credentialId: "k2" } },
    models: [{ id: "claude-sonnet-4" }, { id: "gpt-5" }, { id: "unknown-model" }],
  });
  assert.equal(provider.apiKey, "sk-1");
  const claude = settings.resolveProviderChatRoute(provider, "claude-sonnet-4");
  assert.equal(claude.credentialId, "k1");
  assert.equal(claude.credentialSource, "scope");
  const gpt = settings.resolveProviderChatRoute(provider, "gpt-5");
  assert.equal(gpt.protocol, "openai-responses");
  assert.equal(gpt.credentialId, "k2");
  assert.equal(gpt.credentialSource, "endpoint");
  const unknown = settings.resolveProviderChatRoute(provider, "unknown-model");
  assert.equal(unknown.credentialId, "k1");
  assert.equal(unknown.credentialSource, "fallback");
});

test("xAI keeps its transport identity on the Responses protocol", () => {
  const provider = settings.normalizeCustomProvider({
    id: "grok",
    type: "xai",
    baseUrl: "https://api.x.ai/v1",
    defaultChatProtocol: "openai-responses",
  });
  assert.equal(settings.resolveProviderChatRoute(provider, "grok-4").adapterProviderId, "xai");
});

test("route resolution tolerates a legacy pre-normalization provider snapshot", () => {
  const route = settings.resolveProviderChatRoute(
    {
      type: "claude_code",
      baseUrl: "https://api.anthropic.com",
      isFullUrl: false,
    },
    "claude-sonnet",
  );
  assert.equal(route.protocol, "anthropic-messages");
  assert.equal(route.adapterProviderId, "claude_code");
  assert.equal(route.baseUrl, "https://api.anthropic.com");
  assert.equal(route.isFullUrl, false);
  assert.equal(route.credentialId, "default");
});

test("known gateway hosts infer completions quirks and legacy codex direct xAI keeps its dialect", () => {
  const zai = settings.normalizeCustomProvider({
    id: "zai",
    type: "codex",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    requestFormat: "openai-completions",
    models: ["glm-5"],
  });
  const route = settings.resolveProviderChatRoute(zai, "glm-5");
  assert.equal(route.quirks.thinkingFormat, "zai");
  assert.equal(route.quirks.supportsReasoningEffort, false);

  const explicit = settings.normalizeCustomProvider({
    id: "zai2",
    type: "codex",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    requestFormat: "openai-completions",
    endpointConfigs: {
      "openai-completions": { baseUrl: "https://open.bigmodel.cn/api/paas/v4", quirks: { supportsReasoningEffort: true } },
    },
    models: ["glm-5"],
  });
  assert.equal(settings.resolveProviderChatRoute(explicit, "glm-5").quirks.supportsReasoningEffort, true);

  const grokViaCodex = settings.normalizeCustomProvider({
    id: "grok-codex",
    type: "codex",
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-4"],
  });
  const grokRoute = settings.resolveProviderChatRoute(grokViaCodex, "grok-4");
  assert.equal(grokRoute.dialect, "xai");
  assert.equal(grokRoute.adapterProviderId, "xai");
});

test("a disabled default endpoint falls back to the first enabled explicit endpoint", () => {
  const provider = settings.normalizeCustomProvider({
    id: "relay",
    type: "codex",
    baseUrl: "https://relay.example/v1",
    defaultChatProtocol: "openai-responses",
    endpointConfigs: {
      "openai-responses": { baseUrl: "https://relay.example/v1", enabled: false },
      "anthropic-messages": { baseUrl: "https://relay.example" },
    },
    models: ["claude-sonnet-4"],
  });
  assert.equal(provider.defaultChatProtocol, "anthropic-messages");
});

test("disabling every credential yields an empty key instead of a disabled one", () => {
  const provider = settings.normalizeCustomProvider({
    id: "solo",
    type: "codex",
    baseUrl: "https://relay.example/v1",
    credentials: [{ id: "k1", label: "only", apiKey: "sk-1", enabled: false }],
    models: ["gpt-5"],
  });
  const picked = settings.selectProviderCredential(provider, "gpt-5");
  assert.equal(picked.credential.apiKey, "");
  assert.equal(picked.source, "fallback");
});

test("legacy codex pointing at api.deepseek.com keeps the standard OpenAI chain", () => {
  const provider = settings.normalizeCustomProvider({
    id: "ds-via-codex",
    type: "codex",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat"],
  });
  // 预设按主机归属 deepseek，是预设自身的方言决定链路；这里断言旧 codex 分组的
  // 域名推导只对 xAI 覆盖 openai 缺省。
  const relay = settings.normalizeCustomProvider({
    id: "openai-preset-relay",
    type: "codex",
    presetId: "openai",
    baseUrl: "https://api.openai.com/v1",
    endpointConfigs: { "openai-responses": { baseUrl: "https://api.deepseek.com/v1" } },
    models: ["deepseek-chat"],
  });
  assert.equal(settings.resolveProviderChatRoute(relay, "deepseek-chat").dialect, "openai");
  // 直连官方地址的旧实例按主机归属 deepseek 预设：接口仍是旧推导的 Responses，
  // 方言随预设变为 deepseek（走 DeepSeek 原生 Responses 适配器）。
  const direct = settings.resolveProviderChatRoute(provider, "deepseek-chat");
  assert.equal(provider.presetId, "deepseek");
  assert.equal(direct.protocol, "openai-responses");
  assert.equal(direct.dialect, "deepseek");
});

test("modelSelectableProtocols follows the channel: native = declared, others = 3 (+Gemini for Gemini models)", () => {
  const pick = (presetId, modelId) => settings.modelSelectableProtocols({ presetId }, modelId);
  assert.deepEqual(pick("anthropic", "claude-opus-4-6"), ["anthropic-messages"]);
  assert.deepEqual(pick("openai", "gpt-5.2"), ["openai-completions", "openai-responses"]);
  assert.deepEqual(pick("gemini", "gemini-2.5-pro"), ["google-generative-ai"]);
  // xAI 原生渠道只提供 Responses。
  assert.deepEqual(pick("xai", "grok-4"), ["openai-responses"]);
  // 自定义 / 中转 / 厂商：OpenAI 两类 + Messages；Gemini 系列模型再加 v1beta。
  assert.deepEqual(pick("custom", "gpt-5.2"), [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
  ]);
  assert.deepEqual(pick("zhipu", "glm-5"), ["anthropic-messages", "openai-completions", "openai-responses"]);
  assert.deepEqual(pick("custom", "gemini-2.5-flash"), [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "google-generative-ai",
  ]);
  assert.deepEqual(pick("new-api", "google/gemini-2.5-pro"), [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "google-generative-ai",
  ]);
});

test("explicit chatProtocol wins only when that interface is enabled; failover expands automatically", () => {
  const provider = settings.normalizeCustomProvider({
    id: "relay",
    name: "relay",
    type: "codex",
    presetId: "custom",
    baseUrl: "https://relay.example/v1",
    apiKey: "sk",
    defaultChatProtocol: "openai-completions",
    endpointConfigs: {
      "openai-completions": { baseUrl: "https://relay.example/v1" },
      "openai-responses": { baseUrl: "https://relay.example/v1", enabled: false },
    },
    models: [{ id: "gpt-5.2", chatProtocol: "openai-responses" }],
    activeModels: ["gpt-5.2"],
  });
  // 显式选了停用的 Responses → 退回自动推断（Completions 是唯一已启用的同系列接口）。
  const route = settings.resolveProviderChatRoute(provider, "gpt-5.2");
  assert.equal(route.protocol, "openai-completions");
  assert.notEqual(route.protocolSource, "model");
});

test("endpoint identity is normalized per endpoint and surfaces on the resolved route", () => {
  const provider = settings.normalizeCustomProvider({
    id: "relay",
    name: "relay",
    type: "codex",
    presetId: "custom",
    baseUrl: "https://relay.example/v1",
    apiKey: "sk",
    defaultChatProtocol: "openai-responses",
    endpointConfigs: {
      "openai-responses": { baseUrl: "https://relay.example/v1", identity: "codex" },
      "anthropic-messages": { baseUrl: "https://relay.example", identity: "claude_code" },
      "openai-completions": { baseUrl: "https://relay.example/v1", identity: "bogus" },
    },
    models: [
      { id: "gpt-5.2" },
      { id: "claude-opus-4-6" },
      { id: "glm-5", chatProtocol: "openai-completions" },
    ],
    activeModels: ["gpt-5.2", "claude-opus-4-6", "glm-5"],
  });
  assert.equal(provider.endpointConfigs["openai-responses"].identity, "codex");
  assert.equal(provider.endpointConfigs["anthropic-messages"].identity, "claude_code");
  assert.equal("identity" in provider.endpointConfigs["openai-completions"], false);
  // 同一供应商的三个接口各带各的身份。
  assert.equal(settings.resolveProviderChatRoute(provider, "gpt-5.2").identity, "codex");
  assert.equal(settings.resolveProviderChatRoute(provider, "claude-opus-4-6").identity, "claude_code");
  assert.equal(settings.resolveProviderChatRoute(provider, "glm-5").identity, undefined);
});

test("origins are normalized: invalid dropped, duplicates collapsed, enabled defaults to true", () => {
  const provider = settings.normalizeCustomProvider({
    id: "relay",
    name: "relay",
    type: "codex",
    presetId: "custom",
    baseUrl: "{origin}/v1",
    apiKey: "sk",
    origins: [
      { id: "o1", url: "https://packyapi.com/" },
      { id: "o2", url: "not a url" },
      { id: "o3", url: "" },
      // 规范化后与 o1 同值 → 去重保留先出现的。
      { id: "o4", url: "https://packyapi.com/v1" },
      { id: "o5", url: "https://packy.ai", enabled: false },
    ],
  });
  assert.deepEqual(
    provider.origins.map((origin) => [origin.id, origin.url, origin.enabled]),
    [
      ["o1", "https://packyapi.com", undefined],
      ["o5", "https://packy.ai", false],
    ],
  );
});

test("{origin} endpoints expand through the primary origin, or a caller-picked one", () => {
  const provider = settings.normalizeCustomProvider({
    id: "relay",
    name: "relay",
    type: "codex",
    presetId: "custom",
    baseUrl: "{origin}/v1",
    apiKey: "sk",
    defaultChatProtocol: "openai-completions",
    origins: [
      { id: "main", url: "https://packyapi.com" },
      { id: "alt", url: "https://packy.ai" },
    ],
    endpointConfigs: {
      "openai-completions": { baseUrl: "{origin}/v1" },
      "anthropic-messages": { baseUrl: "{origin}" },
    },
    models: [{ id: "gpt-5.2" }, { id: "claude-opus-4-6" }],
    activeModels: ["gpt-5.2", "claude-opus-4-6"],
  });
  // 主源展开：主连接与各端点一致。
  const primary = settings.resolveProviderChatRoute(provider, "gpt-5.2");
  assert.equal(primary.baseUrl, "https://packyapi.com/v1");
  assert.equal(primary.originId, "main");
  assert.equal(primary.originUrl, "https://packyapi.com");
  assert.equal(provider.baseUrl, "https://packyapi.com/v1");
  // 指定备用源：同一模板换主机。
  const alt = settings.resolveProviderChatRoute(provider, "gpt-5.2", { originId: "alt" });
  assert.equal(alt.baseUrl, "https://packy.ai/v1");
  assert.equal(alt.originId, "alt");
  // 另一接口同样跟随源。
  assert.equal(
    settings.resolveProviderChatRoute(provider, "claude-opus-4-6", { originId: "alt" }).baseUrl,
    "https://packy.ai",
  );
  // 未知 / 停用的源 id 退回主源，不静默打到错误主机。
  assert.equal(settings.resolveProviderChatRoute(provider, "gpt-5.2", { originId: "nope" }).originId, "main");
});

test("without origins a {origin} endpoint is not routable and absolute endpoints still are", () => {
  const provider = settings.normalizeCustomProvider({
    id: "relay",
    name: "relay",
    type: "codex",
    presetId: "custom",
    baseUrl: "https://absolute.example/v1",
    apiKey: "sk",
    defaultChatProtocol: "openai-completions",
    endpointConfigs: {
      "openai-completions": { baseUrl: "https://absolute.example/v1" },
      "anthropic-messages": { baseUrl: "{origin}" },
    },
    models: [{ id: "gpt-5.2" }, { id: "claude-opus-4-6" }],
    activeModels: ["gpt-5.2", "claude-opus-4-6"],
  });
  assert.equal(provider.origins, undefined);
  // 模板端点没有源可展开 → 不参与路由；claude 退回已启用的 Completions。
  assert.equal(
    settings.getProviderEnabledProtocols(provider).includes("anthropic-messages"),
    false,
  );
  assert.equal(
    settings.resolveProviderChatRoute(provider, "claude-opus-4-6").protocol,
    "openai-completions",
  );
  assert.equal(settings.resolveProviderChatRoute(provider, "gpt-5.2").baseUrl, "https://absolute.example/v1");
});

test("probe error text is truncated before it reaches the store", () => {
  // 上游失败常回整页 HTML（Cloudflare 拦截页）；观测值只用于界面提示。
  const html = `<!DOCTYPE html>${"<div>blocked</div>".repeat(200)}`;
  assert.ok(html.length > 1000);
  const provider = settings.normalizeCustomProvider({
    id: "relay",
    name: "relay",
    type: "codex",
    presetId: "custom",
    baseUrl: "https://relay.example/v1",
    apiKey: "sk",
    origins: [{ id: "o1", url: "https://relay.example", lastProbe: { at: 1, status: "unauthorized", error: html } }],
    endpointConfigs: {
      "openai-completions": {
        baseUrl: "https://relay.example/v1",
        lastProbe: { at: 1, status: "unknown", error: html },
      },
    },
  });
  for (const probe of [
    provider.origins[0].lastProbe,
    provider.endpointConfigs["openai-completions"].lastProbe,
  ]) {
    assert.ok(probe.error.length < 500, "错误文本应截断");
    assert.ok(probe.error.endsWith("…"), "截断处应有省略号");
    assert.ok(probe.error.startsWith("<!DOCTYPE html>"));
  }
  // 正常长度的错误原样保留。
  assert.equal(settings.truncateProbeError("HTTP 401 Unauthorized"), "HTTP 401 Unauthorized");
});
