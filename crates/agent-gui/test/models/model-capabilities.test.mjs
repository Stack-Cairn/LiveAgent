import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("@liveagent/ui/lib/settings/index.ts");
const capabilities = loader.loadModule("@liveagent/ui/lib/models/modelCapabilities.ts");

const ALL = [
  "reasoning",
  "tools",
  "parallelTools",
  "structuredOutput",
  "nativeWebSearch",
  "promptCaching",
  "fileInput",
  "imageUnderstanding",
  // --- image generation ---
  "imageGeneration",
];

function makeProvider(overrides = {}) {
  return settings.normalizeCustomProvider({
    id: "oa",
    type: "codex",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    models: [{ id: "gpt-5.2" }, { id: "my-finetune" }],
    ...overrides,
  });
}

test("catalog hit resolves capabilities from models.dev flags and modalities", () => {
  const provider = makeProvider();
  assert.equal(provider.presetId, "openai");
  const resolved = capabilities.resolveModelCapabilities(provider, "gpt-5.2");
  assert.deepEqual(Object.keys(resolved).sort(), [...ALL].sort());
  assert.deepEqual(resolved.tools, { state: "supported", source: "catalog" });
  assert.deepEqual(resolved.structuredOutput, { state: "supported", source: "catalog" });
  assert.deepEqual(resolved.reasoning, { state: "supported", source: "catalog" });
  assert.deepEqual(resolved.imageUnderstanding, { state: "supported", source: "catalog" });
  // gpt-5.2 输入模态只有 text/image，fileInput 由 attachment:true 决定。
  assert.deepEqual(resolved.fileInput, { state: "supported", source: "catalog" });
  // 官方 OpenAI Responses 支持原生搜索；供应商开关默认开。
  assert.deepEqual(resolved.nativeWebSearch, { state: "supported", source: "provider" });
  assert.deepEqual(resolved.parallelTools, { state: "unknown", source: "unknown" });
  assert.deepEqual(resolved.promptCaching, { state: "unknown", source: "unknown" });

  // 目录命中但布尔字段缺失 = unsupported（models.dev 缺省即 false）。
  const gemini = settings.normalizeCustomProvider({
    id: "g",
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "k",
    models: [{ id: "gemini-2.5-flash-image" }],
  });
  const image = capabilities.resolveModelCapabilities(gemini, "gemini-2.5-flash-image");
  assert.deepEqual(image.tools, { state: "unsupported", source: "catalog" });
  assert.deepEqual(image.structuredOutput, { state: "unsupported", source: "catalog" });
  assert.equal(image.imageUnderstanding.state, "supported");
  // attachment:true → fileInput 即使输入模态无 pdf 也算支持。
  assert.deepEqual(image.fileInput, { state: "supported", source: "catalog" });
  // --- image generation ---：outputModalities 含 image → 支持出图。
  assert.deepEqual(image.imageGeneration, { state: "supported", source: "catalog" });
  assert.deepEqual(
    capabilities.resolveModelCapabilities(provider, "gpt-5.2").imageGeneration,
    { state: "unsupported", source: "catalog" },
  );
});

test("catalog miss leaves everything unknown except heuristic reasoning and provider search", () => {
  const provider = makeProvider();
  const resolved = capabilities.resolveModelCapabilities(provider, "my-finetune");
  for (const name of ["tools", "structuredOutput", "fileInput", "imageUnderstanding", "parallelTools", "promptCaching"]) {
    assert.deepEqual(resolved[name], { state: "unknown", source: "unknown" }, name);
  }
  assert.deepEqual(resolved.reasoning, { state: "supported", source: "heuristic" });
  assert.equal(resolved.nativeWebSearch.source, "provider");
  assert.equal(capabilities.resolveModelCatalogInfo(provider, "my-finetune"), undefined);
  // 未在 provider.models 里的模型同样可解析（只影响用户覆盖的读取）。
  assert.equal(
    capabilities.resolveModelCapabilities(provider, "not-configured").tools.state,
    "unknown",
  );
});

test("user overrides win over catalog, provider rule and heuristics", () => {
  const provider = makeProvider({
    nativeWebSearchEnabled: false,
    models: [
      {
        id: "gpt-5.2",
        capabilities: { tools: "unsupported", promptCaching: "supported" },
        inputModalities: ["text"],
      },
      { id: "my-finetune", capabilities: { reasoning: "unsupported" }, nativeWebSearch: true },
    ],
  });
  const gpt = capabilities.resolveModelCapabilities(provider, "gpt-5.2");
  assert.deepEqual(gpt.tools, { state: "unsupported", source: "user" });
  assert.deepEqual(gpt.promptCaching, { state: "supported", source: "user" });
  assert.deepEqual(gpt.structuredOutput, { state: "supported", source: "catalog" });
  // 供应商开关关闭 → 原生搜索 unsupported（来源仍是供应商规则）。
  assert.deepEqual(gpt.nativeWebSearch, { state: "unsupported", source: "provider" });

  const custom = capabilities.resolveModelCapabilities(provider, "my-finetune");
  assert.deepEqual(custom.reasoning, { state: "unsupported", source: "user" });
  // 模型级 nativeWebSearch 布尔覆盖也是用户来源。
  assert.deepEqual(custom.nativeWebSearch, { state: "supported", source: "user" });

  // 输入模态：用户覆盖 > 目录 > 能力反推 > 启发式。
  assert.deepEqual(capabilities.resolveModelInputModalitiesResolved(provider, "gpt-5.2"), {
    modalities: ["text"],
    source: "user",
  });
  assert.deepEqual(capabilities.resolveModelInputModalitiesResolved(makeProvider(), "gpt-5.2"), {
    modalities: ["text", "image"],
    source: "catalog",
  });
  assert.deepEqual(capabilities.resolveModelInputModalitiesResolved(provider, "my-finetune"), {
    modalities: ["text"],
    source: "heuristic",
  });
  const inferred = makeProvider({
    models: [{ id: "my-finetune", capabilities: { imageUnderstanding: "supported" } }],
  });
  assert.deepEqual(capabilities.resolveModelInputModalitiesResolved(inferred, "my-finetune"), {
    modalities: ["text", "image"],
    source: "user",
  });
});

test("aggregator-prefixed ids strip down to the vendor catalog entry", () => {
  const relay = settings.normalizeCustomProvider({
    id: "relay",
    type: "codex",
    baseUrl: "https://relay.example/v1",
    apiKey: "k",
    models: [{ id: "openrouter/anthropic/claude-sonnet-4-6" }],
  });
  assert.equal(relay.presetId, "custom");
  const info = capabilities.resolveModelCatalogInfo(relay, "openrouter/anthropic/claude-sonnet-4-6");
  assert.equal(info.catalogProviderId, "anthropic");
  assert.equal(info.matchedId, "claude-sonnet-4-6");
  assert.equal(info.entry.id, "claude-sonnet-4-6");
  const resolved = capabilities.resolveModelCapabilities(relay, "openrouter/anthropic/claude-sonnet-4-6");
  assert.deepEqual(resolved.tools, { state: "supported", source: "catalog" });
  assert.deepEqual(resolved.fileInput, { state: "supported", source: "catalog" });
  assert.deepEqual(resolved.imageUnderstanding, { state: "supported", source: "catalog" });
  assert.deepEqual(resolved.reasoning, { state: "supported", source: "catalog" });
  // 中转 Completions（非官方地址）可用原生搜索。
  assert.deepEqual(resolved.nativeWebSearch, { state: "supported", source: "provider" });

  // 预设分区优先：OpenRouter 渠道里的 vendor/model id 命中 openrouter 分区。
  const openrouter = settings.normalizeCustomProvider({
    id: "or",
    type: "codex",
    presetId: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "k",
    models: [{ id: "anthropic/claude-sonnet-4.5" }],
  });
  const viaPreset = capabilities.resolveModelCatalogInfo(openrouter, "anthropic/claude-sonnet-4.5");
  assert.equal(viaPreset.catalogProviderId, "openrouter");
  assert.equal(viaPreset.entry.id, "anthropic/claude-sonnet-4.5");
});

test("protocol-level native web search rule mirrors the runtime", () => {
  const rule = capabilities.protocolSupportsNativeWebSearch;
  assert.equal(rule("codex", "openai-responses"), true);
  assert.equal(rule("codex", "openai-completions", { baseUrl: "" }), false);
  assert.equal(
    rule("codex", "openai-completions", { baseUrl: "https://api.openai.com/v1", modelId: "gpt-5.2" }),
    false,
  );
  assert.equal(
    rule("codex", "openai-completions", {
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-search-preview",
    }),
    true,
  );
  assert.equal(rule("codex", "openai-completions", { baseUrl: "https://relay.example/v1" }), true);
  assert.equal(rule("claude_code", "anthropic-messages"), true);
  assert.equal(rule("claude_code", "openai-completions", { baseUrl: "https://x/v1" }), false);
  assert.equal(rule("gemini", "google-generative-ai"), true);
  assert.equal(rule("xai", "openai-responses"), true);
  assert.equal(rule("deepseek", "openai-responses"), true);
  assert.equal(rule("deepseek", "openai-completions", { baseUrl: "https://api.deepseek.com" }), false);
});

test("provider model defaults carry the catalog input budget without fabricating it", () => {
  const gpt = settings.getProviderModelDefaults("codex", "gpt-5.2");
  assert.deepEqual(gpt, {
    contextWindow: 400_000,
    maxInputTokens: 272_000,
    maxOutputToken: 128_000,
    source: "catalog",
  });
  const sonnet = settings.getProviderModelDefaults("claude_code", "claude-sonnet-4-6");
  assert.equal(sonnet.source, "catalog");
  assert.equal("maxInputTokens" in sonnet, false);
  // 跨分区回查同样带输入预算。
  const relayed = settings.getProviderModelDefaults("claude_code", "gpt-5.2");
  assert.equal(relayed.maxInputTokens, 272_000);
  assert.equal(settings.getProviderModelDefaults("codex", "my-finetune").source, "fallback");

  const provider = makeProvider({ models: [{ id: "gpt-5.2" }, { id: "gpt-5.2-user", maxInputTokens: 1000 }] });
  assert.equal(provider.models[0].maxInputTokens, 272_000);
  assert.equal(provider.models[0].limitsSource, "catalog");
  // 落库值优先，不被目录覆盖。
  assert.equal(provider.models[1].maxInputTokens, 1000);
  assert.equal(settings.createProviderModelConfig("codex", "gpt-5.2").maxInputTokens, 272_000);
  assert.equal(settings.findProviderModelConfig(provider, "gpt-5.4").maxInputTokens, 272_000);
});
