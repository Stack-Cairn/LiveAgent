import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  clampOpenAIReasoningEffort,
  mapReasoningToAnthropicEffort,
  resolveAnthropicThinkingRuntime,
  resolveGeminiThinkingRuntime,
  supportsAdaptiveAnthropicThinking,
} = loader.loadModule("src/lib/providers/runtime/thinkingLevels.ts");

function createAnthropicModel(id, overrides = {}) {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    ...overrides,
  };
}

function createOpenAIModel(id, overrides = {}) {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    ...overrides,
  };
}

function createGoogleModel(id, overrides = {}) {
  return {
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    ...overrides,
  };
}

test("anthropic: supportsAdaptiveAnthropicThinking reads catalog compat.forceAdaptiveThinking only", () => {
  assert.equal(
    supportsAdaptiveAnthropicThinking(
      createAnthropicModel("claude-fable-5", { compat: { forceAdaptiveThinking: true } }),
    ),
    true,
  );
  assert.equal(
    supportsAdaptiveAnthropicThinking(
      createAnthropicModel("claude-opus-4-6", { compat: { forceAdaptiveThinking: false } }),
    ),
    false,
  );
  // 没有 compat 的自定义模型一律按 budget 处理，不做 id 猜测。
  assert.equal(supportsAdaptiveAnthropicThinking(createAnthropicModel("claude-custom-x")), false);
});

test("anthropic: mapReasoningToAnthropicEffort honors catalog thinkingLevelMap override first", () => {
  const opus46 = createAnthropicModel("claude-opus-4-6", {
    compat: { forceAdaptiveThinking: true },
    thinkingLevelMap: { xhigh: "max" },
  });
  assert.equal(mapReasoningToAnthropicEffort("xhigh", opus46), "max");
  assert.equal(mapReasoningToAnthropicEffort("medium", opus46), "medium");

  // 没有目录覆盖时走标准档位直通。
  const fable = createAnthropicModel("claude-fable-5", {
    compat: { forceAdaptiveThinking: true },
  });
  assert.equal(mapReasoningToAnthropicEffort("minimal", fable), "low");
  assert.equal(mapReasoningToAnthropicEffort("low", fable), "low");
  assert.equal(mapReasoningToAnthropicEffort("medium", fable), "medium");
  assert.equal(mapReasoningToAnthropicEffort("high", fable), "high");
  assert.equal(mapReasoningToAnthropicEffort("xhigh", fable), "xhigh");
  assert.equal(mapReasoningToAnthropicEffort("max", fable), "max");
});

test("anthropic: resolveAnthropicThinkingRuntime disabled when no reasoning requested", () => {
  const model = createAnthropicModel("claude-opus-4-5");
  const runtime = resolveAnthropicThinkingRuntime(model, { reasoning: undefined });
  assert.deepEqual(runtime, { thinkingEnabled: false, mode: "disabled", maxTokens: 64_000 });
});

test("anthropic: resolveAnthropicThinkingRuntime adaptive mode maps effort and summarized display", () => {
  const fable = createAnthropicModel("claude-fable-5", {
    compat: { forceAdaptiveThinking: true },
    thinkingLevelMap: { xhigh: "xhigh" },
  });
  const runtime = resolveAnthropicThinkingRuntime(fable, { reasoning: "xhigh" });
  assert.equal(runtime.mode, "adaptive");
  assert.equal(runtime.thinkingEnabled, true);
  assert.equal(runtime.effort, "xhigh");
  assert.equal(runtime.display, "summarized");
  assert.equal(runtime.thinkingBudgetTokens, undefined);
});

test("anthropic: resolveAnthropicThinkingRuntime budget mode uses the fixed budgets table", () => {
  const opus45 = createAnthropicModel("claude-opus-4-5");
  const runtime = resolveAnthropicThinkingRuntime(opus45, { reasoning: "high" });
  assert.equal(runtime.mode, "budget");
  assert.equal(runtime.maxTokens, 64_000);
  assert.equal(runtime.thinkingBudgetTokens, 16_384);
  assert.equal(runtime.effort, undefined);
});

test("anthropic: resolveAnthropicThinkingRuntime shrinks the budget for small maxTokens models", () => {
  const small = createAnthropicModel("claude-custom-small", { maxTokens: 4_000 });
  const runtime = resolveAnthropicThinkingRuntime(small, { reasoning: "max" });
  assert.equal(runtime.mode, "budget");
  assert.equal(runtime.maxTokens, 4_000);
  // budget(max)=32768 > adjustedMaxTokens(4000) 触发安全降档：4000-1024=2976。
  assert.equal(runtime.thinkingBudgetTokens, 2_976);
});

test("openai: clampOpenAIReasoningEffort clamps to nearest catalog-supported level", () => {
  const codexLike = createOpenAIModel("gpt-5.1-codex", { thinkingLevelMap: { minimal: null } });
  // minimal 被目录禁用，向上取最近档位 low。
  assert.equal(clampOpenAIReasoningEffort(codexLike, "minimal"), "low");
  // xhigh/max 未在目录中显式声明，属于 opt-in-only，向下取 high。
  assert.equal(clampOpenAIReasoningEffort(codexLike, "xhigh"), "high");
  assert.equal(clampOpenAIReasoningEffort(codexLike, "high"), "high");
});

test("openai: clampOpenAIReasoningEffort passes through explicit catalog xhigh/max entries", () => {
  const gpt52 = createOpenAIModel("gpt-5.2", {
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  });
  assert.equal(clampOpenAIReasoningEffort(gpt52, "xhigh"), "xhigh");
  assert.equal(clampOpenAIReasoningEffort(gpt52, "max"), "max");
  assert.equal(clampOpenAIReasoningEffort(gpt52, "minimal"), "minimal");
});

test("openai: clampOpenAIReasoningEffort returns undefined for non-reasoning models and empty input", () => {
  const nonReasoning = createOpenAIModel("gpt-4o", { reasoning: false });
  assert.equal(clampOpenAIReasoningEffort(nonReasoning, "high"), undefined);
  assert.equal(clampOpenAIReasoningEffort(createOpenAIModel("gpt-5.2"), undefined), undefined);
});

test("gemini: 3 pro stays two-tier LOW/HIGH regardless of minor version", () => {
  const pro3 = createGoogleModel("gemini-3-pro-preview");
  assert.deepEqual(resolveGeminiThinkingRuntime(pro3, "minimal"), { enabled: true, level: "LOW" });
  assert.deepEqual(resolveGeminiThinkingRuntime(pro3, "medium"), { enabled: true, level: "HIGH" });

  const pro31 = createGoogleModel("gemini-3.1-pro-preview");
  assert.deepEqual(resolveGeminiThinkingRuntime(pro31, "low"), { enabled: true, level: "LOW" });
  assert.deepEqual(resolveGeminiThinkingRuntime(pro31, "high"), { enabled: true, level: "HIGH" });
  // xhigh/max 未在任何 Gemini 目录条目中声明，一律降到 high。
  assert.deepEqual(resolveGeminiThinkingRuntime(pro31, "xhigh"), { enabled: true, level: "HIGH" });
});

test("gemini: 3 flash uses the level field with full four-tier range", () => {
  const flash3 = createGoogleModel("gemini-3-flash-preview");
  assert.deepEqual(resolveGeminiThinkingRuntime(flash3, "minimal"), {
    enabled: true,
    level: "MINIMAL",
  });
  assert.deepEqual(resolveGeminiThinkingRuntime(flash3, "medium"), {
    enabled: true,
    level: "MEDIUM",
  });
});

test("gemini: gemma 4 uses the level field with MINIMAL/HIGH only", () => {
  const gemma4 = createGoogleModel("gemma-4-27b");
  assert.deepEqual(resolveGeminiThinkingRuntime(gemma4, "low"), {
    enabled: true,
    level: "MINIMAL",
  });
  assert.deepEqual(resolveGeminiThinkingRuntime(gemma4, "medium"), {
    enabled: true,
    level: "HIGH",
  });
});

test("gemini: 2.5 models use the budget field, flash-lite does not fall through to flash's numbers", () => {
  const pro25 = createGoogleModel("gemini-2.5-pro");
  assert.deepEqual(resolveGeminiThinkingRuntime(pro25, "high"), {
    enabled: true,
    budgetTokens: 32_768,
  });

  const flash25 = createGoogleModel("gemini-2.5-flash");
  assert.deepEqual(resolveGeminiThinkingRuntime(flash25, "minimal"), {
    enabled: true,
    budgetTokens: 128,
  });

  const flashLite25 = createGoogleModel("gemini-2.5-flash-lite");
  assert.deepEqual(resolveGeminiThinkingRuntime(flashLite25, "minimal"), {
    enabled: true,
    budgetTokens: 512,
  });
  assert.deepEqual(resolveGeminiThinkingRuntime(flashLite25, "high"), {
    enabled: true,
    budgetTokens: 24_576,
  });
});

test("gemini: resolveGeminiThinkingRuntime disables thinking when no reasoning requested", () => {
  assert.deepEqual(resolveGeminiThinkingRuntime(createGoogleModel("gemini-2.5-pro"), undefined), {
    enabled: false,
  });
});
