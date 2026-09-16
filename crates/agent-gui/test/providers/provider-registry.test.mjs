import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const registry = loader.loadModule("@liveagent/ui/lib/providers/registry/index.ts");
const probe = loader.loadModule("@liveagent/ui/pages/settings/providerProbe.ts");
const catalogModule = loader.loadModule("@liveagent/ui/lib/models/modelCatalog.ts");

test("registry exposes exactly four chat protocols with families and labels", () => {
  assert.deepEqual(registry.PROVIDER_CHAT_PROTOCOLS, [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "google-generative-ai",
  ]);
  assert.equal(registry.PROVIDER_PROTOCOL_FAMILY["openai-responses"], "openai");
  assert.equal(registry.PROVIDER_PROTOCOL_FAMILY["openai-completions"], "openai");
  assert.equal(registry.isProviderChatProtocol("deepseek-responses"), false);
  for (const protocol of registry.PROVIDER_CHAT_PROTOCOLS) {
    assert.ok(registry.PROVIDER_CHAT_PROTOCOL_LABELS[protocol]);
  }
});

test("dialects are coerced per protocol and inferred from official hosts", () => {
  assert.equal(registry.coerceDialectForProtocol("anthropic-messages", "xai"), "generic");
  assert.equal(registry.coerceDialectForProtocol("openai-responses", "xai"), "xai");
  assert.equal(registry.inferDialectFromBaseUrl("openai-responses", "https://api.x.ai/v1"), "xai");
  assert.equal(
    registry.inferDialectFromBaseUrl("openai-completions", "https://api.deepseek.com"),
    "deepseek",
  );
  assert.equal(
    registry.inferDialectFromBaseUrl("anthropic-messages", "https://api.openai.com/v1"),
    undefined,
  );
  assert.equal(registry.inferDialectFromBaseUrl("openai-completions", "not a url"), undefined);
});

test("protocol auth headers follow the protocol profile and endpoint overrides", () => {
  assert.deepEqual(registry.buildProtocolAuthHeaders("anthropic-messages", "sk"), {
    "x-api-key": "sk",
    "anthropic-version": "2023-06-01",
  });
  assert.deepEqual(registry.buildProtocolAuthHeaders("openai-completions", "sk"), {
    Authorization: "Bearer sk",
  });
  assert.deepEqual(
    registry.buildProtocolAuthHeaders("openai-completions", "sk", { headerName: "api-key", prefix: "" }),
    { "api-key": "sk" },
  );
});

test("endpoint host helpers share one parsing rule and tolerate scheme-less input", () => {
  assert.equal(registry.endpointHostOf("https://API.OpenAI.com/v1"), "api.openai.com");
  assert.equal(registry.endpointHostOf("relay.example/v1"), "relay.example");
  assert.equal(registry.endpointHostOf("http://localhost:11434/v1"), "localhost");
  assert.equal(registry.endpointHostWithPort("http://localhost:11434/v1"), "localhost:11434");
  assert.equal(registry.endpointHostWithPort("https://relay.example:8443/v1"), "relay.example:8443");
  // 归属键：公网主机忽略端口，本地回环保留端口区分服务。
  assert.equal(registry.endpointHostKey("https://relay.example:8443/v1"), "relay.example");
  assert.equal(registry.endpointHostKey("http://127.0.0.1:1234/v1"), "127.0.0.1:1234");
  assert.equal(registry.endpointHostOf("   "), "");
  assert.equal(registry.endpointHostOf("not a url"), "");
  assert.equal(registry.endpointHostOf(undefined), "");

  // 三处消费方都走同一条规则：预设归属、方言推导、quirks 推导都接受无 scheme 输入。
  assert.equal(registry.findPresetForBaseUrl("api.openai.com/v1")?.id, "openai");
  assert.equal(registry.findPresetForBaseUrl("https://api.openai.com:443/v1")?.id, "openai");
  assert.equal(registry.inferDialectFromBaseUrl("openai-responses", "api.x.ai/v1"), "xai");
  assert.equal(
    registry.inferEndpointQuirksFromBaseUrl("openai-completions", "openrouter.ai/api/v1")?.thinkingFormat,
    "openrouter",
  );
});

test("known gateway quirks include groq and only apply to completions", () => {
  assert.deepEqual(
    registry.inferEndpointQuirksFromBaseUrl("openai-completions", "https://api.groq.com/openai/v1"),
    { supportsStore: false },
  );
  assert.equal(
    registry.inferEndpointQuirksFromBaseUrl("openai-responses", "https://api.groq.com/openai/v1"),
    undefined,
  );
  assert.equal(registry.inferEndpointQuirksFromBaseUrl("openai-completions", "https://api.openai.com/v1"), undefined);
});

test("preset lookups by id and host are stable and native-first", () => {
  assert.equal(registry.findProviderPreset(undefined), undefined);
  assert.equal(registry.findProviderPreset(""), undefined);
  assert.equal(registry.findProviderPreset("openai"), registry.findProviderPreset("openai"));
  // 原生渠道优先：官方地址命中原生预设而不是恰好也声明了该主机的其它预设。
  assert.equal(registry.findPresetForBaseUrl("https://api.anthropic.com")?.id, "anthropic");
  assert.equal(registry.findPresetForBaseUrl("https://api.deepseek.com/anthropic")?.id, "deepseek");
  assert.equal(registry.findPresetForBaseUrl(""), undefined);
  assert.deepEqual([...registry.presetHosts(registry.findProviderPreset("new-api"))], []);
  assert.ok(registry.presetHosts(registry.findProviderPreset("openai")).includes("api.openai.com"));
  // 已删除的导出不再存在。
  assert.equal(registry.mergeHeaderLayers, undefined);
  assert.equal(registry.isProviderProtocolFamily, undefined);
});

test("model families drive grouping and protocol preference", () => {
  assert.equal(registry.resolveModelGroup("claude-sonnet-4"), "claude");
  assert.equal(registry.resolveModelGroup("anthropic/claude-sonnet-4"), "claude");
  assert.equal(registry.resolveModelGroup("gpt-5-mini"), "gpt");
  assert.equal(registry.resolveModelGroup("o4-mini"), "gpt");
  assert.equal(registry.resolveModelGroup("grok-4"), "grok");
  assert.equal(registry.resolveModelGroup("deepseek-v4-pro"), "deepseek");
  assert.equal(registry.resolveModelGroup("glm-5"), "glm");
  assert.equal(registry.resolveModelGroup("my-finetune"), "other");
  assert.deepEqual(registry.resolveModelFamily("claude-opus-4").prefer, [
    "anthropic-messages",
    "openai-completions",
  ]);
  assert.equal(registry.resolveModelFamily("grok-4").dialect, "xai");
});

test("presets merge models.dev facts with the overlay", () => {
  const deepseek = registry.findProviderPreset("deepseek");
  assert.ok(deepseek);
  assert.equal(deepseek.native, true);
  assert.equal(deepseek.defaultChatProtocol, "openai-completions");
  assert.equal(deepseek.endpoints["openai-completions"].baseUrl, "https://api.deepseek.com");
  assert.equal(
    deepseek.endpoints["anthropic-messages"].baseUrl,
    "https://api.deepseek.com/anthropic",
  );
  assert.ok(deepseek.catalogModels.length > 0);
  // 渠道模型列表就是目录分区本身（单一目录），按预设分区查找走同一候选链。
  assert.equal(deepseek.catalogProviderId, "deepseek");
  assert.equal(deepseek.catalogModels, catalogModule.MODEL_CATALOG.deepseek);
  assert.equal(registry.findPresetCatalogModel(deepseek, "DeepSeek-V4-Pro").id, "deepseek-v4-pro");
  assert.equal(registry.findPresetCatalogModel(deepseek, "deepseek-chat"), undefined);
  const gpt = registry.findPresetCatalogModel(registry.findProviderPreset("openai"), "gpt-5.2");
  assert.equal(gpt.toolCall, true);
  assert.equal(gpt.maxInputTokens, 272_000);
  for (const presetId of ["moonshot-cn", "dashscope-cn", "stepfun-cn", "tencent", "xiaomi", "longcat", "sensenova", "modelscope", "siliconflow", "groq", "openrouter", "lmstudio", "zhipu-coding-plan", "minimax-cn-token-plan", "kimi-for-coding", "dashscope-cn-coding-plan", "dashscope-token-plan", "volcengine-coding-plan", "stepfun-cn-step-plan", "tencent-coding-plan", "tencent-token-plan", "xiaomi-token-plan-cn"]) {
    const preset = registry.findProviderPreset(presetId);
    assert.ok(preset?.catalogModels.length > 0, `${presetId} lists its channel models`);
  }
  // 套餐渠道：地址与模型列表独立于主渠道，Anthropic 类套餐默认走 Messages。
  const zhipuPlan = registry.findProviderPreset("zhipu-coding-plan");
  assert.equal(zhipuPlan.catalogProviderId, "zhipuai-coding-plan");
  assert.equal(zhipuPlan.endpoints["openai-completions"].baseUrl, "https://open.bigmodel.cn/api/coding/paas/v4");
  assert.equal(zhipuPlan.endpoints["anthropic-messages"].baseUrl, "https://open.bigmodel.cn/api/anthropic");
  const minimaxPlan = registry.findProviderPreset("minimax-cn-token-plan");
  assert.equal(minimaxPlan.defaultChatProtocol, "anthropic-messages");
  assert.equal(minimaxPlan.endpoints["anthropic-messages"].baseUrl, "https://api.minimaxi.com/anthropic/v1");
  assert.equal(minimaxPlan.endpoints["openai-completions"].baseUrl, "https://api.minimaxi.com/v1");
  assert.equal(registry.findProviderPreset("kimi-for-coding").defaultChatProtocol, "anthropic-messages");
  // 主渠道分区不再并入套餐模型。
  assert.equal(registry.findProviderPreset("tencent").catalogProviderId, "tencent");
  assert.ok(!catalogModule.MODEL_CATALOG.tencent.some((entry) => entry.id === "tc-code-latest"));
  assert.equal(registry.findProviderPreset("custom").catalogProviderId, undefined);
  assert.equal(registry.MODEL_CATALOG_SNAPSHOT_DATE, catalogModule.MODEL_CATALOG_SNAPSHOT_DATE);
  assert.deepEqual(registry.matchPresetModelRule(deepseek, "deepseek-chat").chatProtocols, [
    "openai-completions",
  ]);
  assert.equal(registry.matchPresetModelRule(deepseek, "deepseek-v4-pro"), undefined);

  const openrouter = registry.findProviderPreset("openrouter");
  assert.equal(
    registry.matchPresetModelRule(openrouter, "anthropic/claude-sonnet-4").chatProtocols[0],
    "anthropic-messages",
  );

  const relay = registry.findProviderPreset("new-api");
  assert.equal(
    registry.expandPresetBaseUrl(relay.endpoints["google-generative-ai"].baseUrl, "https://relay.example/v1"),
    "https://relay.example/v1beta",
  );
  assert.equal(registry.expandPresetBaseUrl("{origin}", ""), "");

  const ollama = registry.findProviderPreset("ollama");
  assert.equal(ollama.authOptional, true);
  assert.equal(ollama.endpoints["openai-completions"].quirks.supportsDeveloperRole, false);

  // 自定义渠道不在目录里展示，但可以按 id 找到。
  assert.equal(registry.listProviderPresets().some((preset) => preset.id === "custom"), false);
  assert.ok(registry.findProviderPreset("custom"));
});

test("legacy type mapping is symmetric for native channels", () => {
  assert.equal(registry.presetIdForLegacyType("claude_code"), "anthropic");
  assert.equal(registry.presetIdForLegacyType("codex"), "openai");
  assert.equal(registry.presetIdForLegacyType("weird"), "custom");
  assert.equal(
    registry.legacyTypeForPreset(registry.findProviderPreset("zhipu"), "openai-completions"),
    "codex",
  );
  assert.equal(
    registry.legacyTypeForPreset(registry.findProviderPreset("zhipu"), "anthropic-messages"),
    "claude_code",
  );
  assert.equal(
    registry.legacyTypeForPreset(registry.findProviderPreset("xai"), "openai-responses"),
    "xai",
  );
});

test("endpoint candidates expand preset templates and custom roots", () => {
  const relay = registry.findProviderPreset("new-api");
  const candidates = probe.buildEndpointCandidates({ preset: relay, origin: "https://relay.example" });
  assert.deepEqual(
    candidates.map((candidate) => [candidate.protocol, candidate.baseUrl]),
    [
      ["anthropic-messages", "https://relay.example"],
      ["openai-completions", "https://relay.example/v1"],
      ["openai-responses", "https://relay.example/v1"],
      ["google-generative-ai", "https://relay.example/v1beta"],
    ],
  );

  const custom = probe.buildEndpointCandidates({
    preset: registry.findProviderPreset("custom"),
    baseUrl: "https://mine.example/v1",
  });
  assert.equal(custom.length, 4);
  assert.equal(custom.find((c) => c.protocol === "anthropic-messages").baseUrl, "https://mine.example");
  assert.equal(custom.find((c) => c.protocol === "openai-completions").baseUrl, "https://mine.example/v1");
  assert.equal(custom.find((c) => c.protocol === "google-generative-ai").baseUrl, "https://mine.example/v1beta");

  // 自定义根地址与 normalizeOrigin 同一口径：补 scheme、去 query、去尾部 v1 / v1beta。
  assert.equal(probe.customEndpointBaseUrl("openai-completions", "relay.example/v1?x=1"), "https://relay.example/v1");
  assert.equal(probe.customEndpointBaseUrl("openai-responses", "https://relay.example/api/v1beta/"), "https://relay.example/api/v1");
  assert.equal(probe.customEndpointBaseUrl("anthropic-messages", "https://relay.example/v1"), "https://relay.example");
  assert.equal(probe.customEndpointBaseUrl("google-generative-ai", "relay.example"), "https://relay.example/v1beta");
  assert.equal(probe.customEndpointBaseUrl("openai-completions", "   "), "");
});

test("auto configuration keeps only usable endpoints and merges models per key", () => {
  const preset = registry.findProviderPreset("new-api");
  const candidates = probe.buildEndpointCandidates({ preset, origin: "https://relay.example" });
  const probeResult = {
    at: 1000,
    credentials: [
      {
        credentialId: "k1",
        endpoints: [
          { protocol: "anthropic-messages", baseUrl: "https://relay.example", status: "ok", latencyMs: 10, models: [{ id: "claude-sonnet-4", contextWindow: 200000, maxOutputToken: 8192 }] },
          { protocol: "openai-completions", baseUrl: "https://relay.example/v1", status: "ok", latencyMs: 12, models: [{ id: "gpt-5", contextWindow: 128000, maxOutputToken: 8192 }, { id: "glm-5", contextWindow: 128000, maxOutputToken: 8192 }] },
          { protocol: "openai-responses", baseUrl: "https://relay.example/v1", status: "ok", latencyMs: 12, models: [{ id: "gpt-5", contextWindow: 128000, maxOutputToken: 8192 }] },
          { protocol: "google-generative-ai", baseUrl: "https://relay.example/v1beta", status: "missing", error: "404", models: [] },
        ],
      },
      {
        credentialId: "k2",
        endpoints: [
          { protocol: "anthropic-messages", baseUrl: "https://relay.example", status: "unauthorized", error: "401", models: [] },
          { protocol: "openai-completions", baseUrl: "https://relay.example/v1", status: "ok", latencyMs: 9, models: [{ id: "deepseek-v4-pro", contextWindow: 128000, maxOutputToken: 8192 }] },
          { protocol: "openai-responses", baseUrl: "https://relay.example/v1", status: "ok", latencyMs: 9, models: [] },
          { protocol: "google-generative-ai", baseUrl: "https://relay.example/v1beta", status: "missing", error: "404", models: [] },
        ],
      },
    ],
  };
  const credentials = [
    { id: "k1", label: "main", apiKey: "a", enabled: true },
    { id: "k2", label: "backup", apiKey: "b", enabled: true },
  ];
  const auto = probe.buildAutoConfiguration({ preset, candidates, probe: probeResult, credentials });
  assert.equal(auto.usable, true);
  assert.deepEqual(Object.keys(auto.endpointConfigs).sort(), [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
  ]);
  assert.equal(auto.endpointConfigs["anthropic-messages"].lastProbe.status, "ok");
  assert.equal(auto.defaultChatProtocol, "openai-completions");
  assert.deepEqual(
    auto.models.map((model) => model.id),
    ["claude-sonnet-4", "deepseek-v4-pro", "glm-5", "gpt-5"],
  );
  assert.equal(auto.models.find((m) => m.id === "gpt-5").group, "gpt");
  assert.equal(auto.models.every((m) => m.source === "auto"), true);
  assert.deepEqual(auto.credentials[0].lastModels.models, ["claude-sonnet-4", "glm-5", "gpt-5"]);
  assert.deepEqual(auto.credentials[1].lastModels.models, ["deepseek-v4-pro"]);
  assert.equal(auto.credentials[0].modelScope.mode, "auto");

  // 摘要分组：按家族，附推荐接口。
  const groups = probe.groupProbeModels(auto.models, ["anthropic-messages", "openai-completions", "openai-responses"], preset);
  assert.deepEqual(groups.map((g) => [g.key, g.protocol]), [
    ["claude", "anthropic-messages"],
    ["deepseek", "openai-completions"],
    ["glm", "openai-completions"],
    ["gpt", "openai-responses"],
  ]);

  // 拒绝一个接口与一个分组。
  const trimmed = probe.buildAutoConfiguration({
    preset,
    candidates,
    probe: probeResult,
    credentials,
    rejectedProtocols: new Set(["openai-responses"]),
    rejectedGroups: new Set(["glm"]),
  });
  assert.equal(trimmed.endpointConfigs["openai-responses"].enabled, false);
  assert.equal(trimmed.models.some((m) => m.id === "glm-5"), false);
});

test("probe errors classify by HTTP status", () => {
  const utils = loader.loadModule("@liveagent/ui/pages/settings/providerUtils.ts");
  assert.equal(probe.classifyProbeError(new utils.ProviderModelsFetchError("nope", 404)).status, "missing");
  assert.equal(probe.classifyProbeError(new utils.ProviderModelsFetchError("nope", 401)).status, "unauthorized");
  assert.equal(probe.classifyProbeError(new utils.ProviderModelsFetchError("boom", 500)).status, "unknown");
  assert.equal(probe.classifyProbeError(new Error("network")).status, "unknown");
  assert.equal(utils.extractHttpStatusFromMessage("HTTP 401 Unauthorized"), 401);
  assert.equal(utils.extractHttpStatusFromMessage("upstream said 404 not found"), 404);
  assert.equal(utils.extractHttpStatusFromMessage("timeout"), null);
});

test("legacy providers map to presets by host, relays fall back to custom", () => {
  assert.equal(registry.presetIdForLegacyProvider("codex", "https://api.openai.com/v1"), "openai");
  assert.equal(registry.presetIdForLegacyProvider("codex", "https://www.packyapi.com/v1"), "custom");
  assert.equal(registry.presetIdForLegacyProvider("claude_code", "https://api.deepseek.com/anthropic"), "deepseek");
  assert.equal(registry.presetIdForLegacyProvider("codex", "https://open.bigmodel.cn/api/paas/v4"), "zhipu");
  assert.equal(registry.presetMatchesBaseUrl(registry.findProviderPreset("new-api"), "https://relay.x/v1"), true);
  assert.equal(registry.presetMatchesBaseUrl(registry.findProviderPreset("openai"), "https://relay.x/v1"), false);

  // 挂着官方预设的中转实例：候选接口从自己的地址派生，不碰官方地址。
  const candidates = probe.buildEndpointCandidates({
    preset: registry.findProviderPreset("openai"),
    baseUrl: "https://www.packyapi.com/v1",
  });
  assert.ok(candidates.every((c) => c.baseUrl.includes("packyapi.com")));
  const official = probe.buildEndpointCandidates({
    preset: registry.findProviderPreset("openai"),
    baseUrl: "https://api.openai.com/v1",
  });
  assert.ok(official.every((c) => c.baseUrl.startsWith("https://api.openai.com")));
});

test("renamed auth headers drop the protocol prefix unless one is given", () => {
  assert.deepEqual(
    registry.buildProtocolAuthHeaders("openai-completions", "sk", { headerName: "X-Api-Key" }),
    { "X-Api-Key": "sk" },
  );
  assert.deepEqual(
    registry.buildProtocolAuthHeaders("openai-completions", "sk", { headerName: "authorization" }),
    { authorization: "Bearer sk" },
  );
  assert.deepEqual(
    registry.buildProtocolAuthHeaders("openai-completions", "sk", { headerName: "X-Token", prefix: "Token " }),
    { "X-Token": "Token sk" },
  );
});

test("models URL keeps non-v1 version segments and only rewrites v1/v1beta", () => {
  const utils = loader.loadModule("@liveagent/ui/pages/settings/providerUtils.ts");
  const url = (type, base, kind = "official") =>
    utils.buildProviderModelsUrl(type, utils.normalizeProviderModelsBaseUrl(type, base, false), kind);
  assert.equal(url("codex", "https://open.bigmodel.cn/api/paas/v4"), "https://open.bigmodel.cn/api/paas/v4/models");
  assert.equal(url("codex", "https://ark.cn-beijing.volces.com/api/v3"), "https://ark.cn-beijing.volces.com/api/v3/models");
  assert.equal(url("codex", "https://relay.example/v1"), "https://relay.example/v1/models");
  assert.equal(url("claude_code", "https://api.anthropic.com/v1"), "https://api.anthropic.com/v1/models");
  assert.equal(url("gemini", "https://generativelanguage.googleapis.com/v1beta"), "https://generativelanguage.googleapis.com/v1beta/models");
});

test("existing endpoints survive a failed probe: observation only, no drop, no disable", () => {
  const candidates = [
    { protocol: "anthropic-messages", baseUrl: "https://relay.example", origin: "existing", dialect: "generic", auth: { headerName: "x-api-key" } },
    { protocol: "openai-completions", baseUrl: "https://relay.example/v1", origin: "preset" },
    { protocol: "openai-responses", baseUrl: "https://relay.example/v1", origin: "preset" },
  ];
  const probeResult = {
    at: 5,
    credentials: [
      {
        credentialId: "k1",
        endpoints: [
          { protocol: "anthropic-messages", baseUrl: "https://relay.example", status: "unauthorized", error: "HTTP 401", models: [] },
          { protocol: "openai-completions", baseUrl: "https://relay.example/v1", status: "ok", latencyMs: 3, models: [{ id: "gpt-5", contextWindow: 128000, maxOutputToken: 8192 }] },
          { protocol: "openai-responses", baseUrl: "https://relay.example/v1", status: "unknown", error: "no model array", models: [] },
        ],
      },
    ],
  };
  const credentials = [{ id: "k1", label: "", apiKey: "a", enabled: true }];
  const auto = probe.buildAutoConfiguration({ preset: undefined, candidates, probe: probeResult, credentials });
  // 已配置的 Messages 端点：保留、不停用、只记观测，方言 / 鉴权头原样带回。
  const kept = auto.endpointConfigs["anthropic-messages"];
  assert.ok(kept);
  assert.equal(kept.enabled, undefined);
  assert.equal(kept.source, "user");
  assert.equal(kept.lastProbe.status, "unauthorized");
  assert.equal(kept.dialect, "generic");
  assert.deepEqual(kept.auth, { headerName: "x-api-key" });
  // 新候选只有探测通过才创建；"未知"的 Responses 不创建。
  assert.ok(auto.endpointConfigs["openai-completions"]);
  assert.equal(auto.endpointConfigs["openai-responses"], undefined);
  // 失败的既有端点不参与默认接口与模型合并。
  assert.equal(auto.defaultChatProtocol, "openai-completions");
  assert.deepEqual(auto.models.map((m) => m.id), ["gpt-5"]);

  // 用户在摘要页主动取消既有端点：这是配置动作，写 enabled:false。
  const rejected = probe.buildAutoConfiguration({
    preset: undefined,
    candidates,
    probe: probeResult,
    credentials,
    rejectedProtocols: new Set(["anthropic-messages"]),
  });
  assert.equal(rejected.endpointConfigs["anthropic-messages"].enabled, false);

  // 全部失败：既有端点仍在，usable=false 让对话框不能"采纳"。
  const allFailed = probe.buildAutoConfiguration({
    preset: undefined,
    candidates: [candidates[0]],
    probe: { at: 6, credentials: [{ credentialId: "k1", endpoints: [{ ...probeResult.credentials[0].endpoints[0] }] }] },
    credentials,
  });
  assert.equal(allFailed.usable, false);
  assert.equal(allFailed.endpointConfigs["anthropic-messages"].lastProbe.status, "unauthorized");
  assert.equal(probe.protocolsFamilies, undefined, "unused export removed");
});

test("probeEndpoint fetches in strict mode with the credential id and classifies a bare failure as unknown", async () => {
  const utils = loader.loadModule("@liveagent/ui/pages/settings/providerUtils.ts");
  const calls = [];
  const utilsPath = new URL("../../../agent-ui/src/pages/settings/providerUtils.ts", import.meta.url).pathname;
  const strictLoader = createTsModuleLoader({
    mocks: {
      [utilsPath]: {
        ...utils,
        fetchModelsFromApi: async (type, baseUrl, apiKey, options) => {
          calls.push({ type, baseUrl, apiKey, options });
          if (options?.strict) throw new utils.ProviderModelsFetchError("Model list response has no model array", null);
          return [];
        },
      },
    },
  });
  const strictProbe = strictLoader.loadModule("@liveagent/ui/pages/settings/providerProbe.ts");
  const result = await strictProbe.probeProvider({
    candidates: [{ protocol: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4", origin: "existing" }],
    credentials: [
      { id: "k-main", apiKey: "", enabled: true },
      { id: "k-off", apiKey: "sk-off", enabled: false },
    ],
    providerId: "p-zhipu",
  });
  assert.equal(calls.length, 1, "disabled keys are not probed");
  assert.equal(calls[0].options.strict, true);
  assert.equal(calls[0].options.credentialId, "k-main");
  assert.equal(calls[0].options.providerId, "p-zhipu");
  assert.equal(calls[0].apiKey, "", "a redacted key is sent empty, never as the placeholder text");
  // 200 但没有模型数组 → "未知"，不再被判"可用"。
  assert.equal(result.credentials[0].endpoints[0].status, "unknown");
  assert.equal(strictProbe.summarizeEndpointStatus(result, "openai-completions").status, "unknown");
});

test("groq has an overlay so it lands in the official channel catalog with a key page", () => {
  const groq = registry.findProviderPreset("groq");
  assert.ok(groq);
  assert.equal(groq.name, "Groq");
  assert.equal(groq.input, "key");
  assert.equal(groq.defaultChatProtocol, "openai-completions");
  assert.equal(groq.apiKeyUrl, "https://console.groq.com/keys");
  assert.ok(groq.order < 500, "ordered with the other vendors, not in the unranked tail");
  assert.equal(groq.endpoints["openai-completions"].baseUrl, "https://api.groq.com/openai/v1");
});
