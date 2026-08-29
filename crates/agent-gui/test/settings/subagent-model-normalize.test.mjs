import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");

function provider(overrides) {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    type: overrides.type,
    baseUrl: `https://${overrides.id}.example.com`,
    apiKey: "key",
    models: overrides.activeModels.map((id) => ({
      id,
      contextWindow: 200000,
      maxOutputToken: 8192,
    })),
    activeModels: overrides.activeModels,
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
    useSystemProxy: false,
    ...(overrides.requestFormat ? { requestFormat: overrides.requestFormat } : {}),
  };
}

// gpt-5 系列在生成目录里有完整档位；xai 的思考恒开（wire 上表达不出 off）。
const PROVIDERS = [
  provider({ id: "codex-main", type: "codex", activeModels: ["gpt-5", "gpt-5-mini", "gpt-5.1"] }),
  provider({ id: "claude-main", type: "claude_code", activeModels: ["claude-sonnet-4-5"] }),
  provider({ id: "xai-main", type: "xai", activeModels: ["grok-4"] }),
];

function normalize(customSettings, providers = PROVIDERS) {
  return settings.normalizeCustomSettings(customSettings, providers);
}

test("an unset subagent model stays unset", () => {
  const result = normalize({});
  assert.equal(result.subagentModel, undefined);
  assert.equal(result.subagentReasoning, undefined);
});

test("a valid pin survives normalization", () => {
  const result = normalize({
    subagentModel: { customProviderId: "codex-main", model: "gpt-5-mini" },
  });
  assert.deepEqual(result.subagentModel, {
    customProviderId: "codex-main",
    model: "gpt-5-mini",
  });
});

test("a pin on a deleted provider is dropped", () => {
  const result = normalize({
    subagentModel: { customProviderId: "gone", model: "gpt-5-mini" },
    subagentReasoning: "low",
  });
  assert.equal(result.subagentModel, undefined);
  // 模型没了就不能留下孤立档位:它会在用户下次钉模型时悄悄套到新模型上。
  assert.equal(result.subagentReasoning, undefined);
});

test("a pin on a model the user deactivated is dropped", () => {
  const result = normalize({
    subagentModel: { customProviderId: "codex-main", model: "gpt-5-turbo-retired" },
    subagentReasoning: "high",
  });
  assert.equal(result.subagentModel, undefined);
  assert.equal(result.subagentReasoning, undefined);
});

test("a reasoning level the model supports is kept", () => {
  const levels = settings.getKnownModelThinkingLevels("codex", "gpt-5");
  assert.ok(levels.length > 0, "expected the catalog to expose gpt-5 thinking levels");
  const result = normalize({
    subagentModel: { customProviderId: "codex-main", model: "gpt-5" },
    subagentReasoning: levels[0],
  });
  assert.equal(result.subagentReasoning, levels[0]);
});

test("a reasoning level outside the model's table is dropped, not clamped silently", () => {
  const result = normalize({
    subagentModel: { customProviderId: "codex-main", model: "gpt-5" },
    subagentReasoning: "definitely-not-a-level",
  });
  assert.deepEqual(result.subagentModel, { customProviderId: "codex-main", model: "gpt-5" });
  // 落回 undefined = 「用模型默认档位」，比钳到一个用户没选过的档位更诚实。
  assert.equal(result.subagentReasoning, undefined);
});

test("off is kept for models that can disable thinking", () => {
  // gpt-5 目录里是「思考不可关」，gpt-5.1 才可关——这个区分正是要测的。
  assert.equal(settings.isThinkingAlwaysOnForModel("codex", "gpt-5.1"), false);
  const result = normalize({
    subagentModel: { customProviderId: "codex-main", model: "gpt-5.1" },
    subagentReasoning: "off",
  });
  assert.equal(result.subagentReasoning, "off");
});

test("off is rejected for models whose thinking cannot be disabled", () => {
  assert.equal(settings.isThinkingAlwaysOnForModel("codex", "gpt-5"), true);
  const result = normalize({
    subagentModel: { customProviderId: "codex-main", model: "gpt-5" },
    subagentReasoning: "off",
  });
  assert.deepEqual(result.subagentModel, { customProviderId: "codex-main", model: "gpt-5" });
  assert.equal(result.subagentReasoning, undefined);
});

test("off is rejected for always-on thinking models", () => {
  // xAI:省略 reasoning_effort 不等于关闭，wire 上无法表达 off。
  assert.equal(settings.isThinkingAlwaysOnForModel("xai", "grok-4"), true);
  const result = normalize({
    subagentModel: { customProviderId: "xai-main", model: "grok-4" },
    subagentReasoning: "off",
  });
  assert.deepEqual(result.subagentModel, { customProviderId: "xai-main", model: "grok-4" });
  assert.equal(result.subagentReasoning, undefined);
});

test("the pin may point at a provider other than the conversation's", () => {
  // 主会话跑贵模型、子代理跑别家便宜模型是一等用例，归一化不该按供应商设限。
  const result = normalize({
    subagentModel: { customProviderId: "claude-main", model: "claude-sonnet-4-5" },
  });
  assert.deepEqual(result.subagentModel, {
    customProviderId: "claude-main",
    model: "claude-sonnet-4-5",
  });
});

test("the pin round-trips through full settings normalization", () => {
  const normalized = settings.normalizeSettings({
    customProviders: PROVIDERS,
    customSettings: {
      subagentModel: { customProviderId: "codex-main", model: "gpt-5-mini" },
      subagentReasoning: "low",
    },
  });
  assert.deepEqual(normalized.customSettings.subagentModel, {
    customProviderId: "codex-main",
    model: "gpt-5-mini",
  });
  assert.equal(normalized.customSettings.subagentReasoning, "low");
});
