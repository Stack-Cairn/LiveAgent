import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

import path from "node:path";
import { fileURLToPath } from "node:url";

// Battle 2: this suite now drives crates/core, the engine that actually ships.
// The frontend copy under src/lib was a duplicate and has been removed.
// crates/core modules that talk to the Rust backend read this at import time.
process.env.LIVEAGENT_BACKEND_PORT ??= "0";
const coreRootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "../core");
const coreSrc = (rel) => path.join(coreRootDir, "src", rel);


// 走真实 pi-ai anthropic stream()，用 onPayload 截获请求体后中断，
// 断言的是最终线格式（thinking/output_config），不是中间结构。
const realAnthropic = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js",
    import.meta.url,
  ).href
);

const loader = createTsModuleLoader({
  mocks: {
    "@earendil-works/pi-ai/api/anthropic-messages": { stream: realAnthropic.stream },
  },
});

const { createModelFromConfig } = loader.loadModule(coreSrc("models/modelFactory.ts"));
const { resolveModelThinking } = loader.loadModule(coreSrc("models/modelThinking.ts"));
const { streamSimpleByApi } = loader.loadModule(coreSrc("providers/runtime/streamByApi.ts"));

const RELAY_BASE_URL = "https://relay.example.com/v1";

function levelsFor(modelId) {
  return resolveModelThinking("claude_code", modelId).levels;
}

async function captureWirePayload(modelId, reasoning, baseUrl = RELAY_BASE_URL) {
  const model = createModelFromConfig("claude_code", modelId, baseUrl, undefined, undefined, baseUrl);
  let captured;
  const stream = streamSimpleByApi(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    {
      apiKey: "sk-test",
      reasoning,
      onPayload: (payload) => {
        captured = payload;
        throw new Error("__capture_stop__");
      },
    },
  );
  try {
    await stream.result();
  } catch {
    // onPayload 抛错中断请求属预期。
  }
  assert.ok(captured, `expected payload capture for ${modelId}`);
  return captured;
}

test("anthropic: 装饰过的目录模型 id（日期后缀/大小写/@版本）继承目录 adaptive 元数据", () => {
  for (const [modelId, baseId] of [
    ["claude-opus-4-8-20260213", "claude-opus-4-8"],
    ["Claude-Fable-5", "claude-fable-5"],
    ["claude-sonnet-4-6-20251114", "claude-sonnet-4-6"],
    ["claude-opus-4-5@20251101", "claude-opus-4-5"],
    ["claude-sonnet-4-6[1m]", "claude-sonnet-4-6"],
  ]) {
    const model = createModelFromConfig("claude_code", modelId, RELAY_BASE_URL);
    const base = createModelFromConfig("claude_code", baseId, "https://api.anthropic.com");
    // 兼容中转保留用户配置的原始 id，供其识别日期/@版本/[1m] 装饰。
    assert.equal(model.id, modelId);
    assert.equal(model.baseUrl, RELAY_BASE_URL);
    assert.equal(
      model.compat?.forceAdaptiveThinking,
      base.compat?.forceAdaptiveThinking,
      `${modelId} should inherit adaptive flag from ${baseId}`,
    );
    assert.deepEqual(model.thinkingLevelMap, base.thinkingLevelMap);
  }
});

test("anthropic: 装饰 id 的可选档位与目录基础模型一致（xhigh/max 不丢失）", () => {
  // 档位来自生成目录（models.dev）：adaptive 世代无 minimal 档。
  assert.deepEqual(levelsFor("claude-opus-4-8-20260213"), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(levelsFor("claude-sonnet-4-6-20251114"), ["low", "medium", "high", "max"]);
});

test("anthropic: 目录未命中的三方改名 id 走启发式识别 adaptive 家族", () => {
  // Opus 4.7+/Claude 5 家族：xhigh 直通；adaptive 世代无 minimal 档（目录同形）。
  for (const modelId of ["claude-4.7-opus", "claude-5-sonnet", "custom-fable-5-relay"]) {
    const model = createModelFromConfig("claude_code", modelId, RELAY_BASE_URL);
    assert.equal(model.compat?.forceAdaptiveThinking, true, `${modelId} should be adaptive`);
    assert.equal(model.contextWindow, 1_000_000, `${modelId} should expose the 1M window`);
    assert.deepEqual(model.thinkingLevelMap, { minimal: null, xhigh: "xhigh", max: "max" });
  }
  // Opus 4.6/Sonnet 4.6/Mythos Preview：只到 max。
  for (const modelId of ["claude-4.6-sonnet", "claude-mythos-preview"]) {
    const model = createModelFromConfig("claude_code", modelId, RELAY_BASE_URL);
    assert.equal(model.compat?.forceAdaptiveThinking, true, `${modelId} should be adaptive`);
    assert.equal(model.contextWindow, 1_000_000, `${modelId} should expose the 1M window`);
    assert.deepEqual(model.thinkingLevelMap, { minimal: null, max: "max" });
  }
});

test("anthropic: 旧世代/歧义 id 不误判为 adaptive，保持 budget 语义", () => {
  for (const modelId of [
    "claude-3-5-sonnet-20241022",
    "claude-3-7-sonnet-20250219",
    "claude-4-5-sonnet",
    "claude-sonnet-4-5-x",
    "claude-3-haiku-20240307",
  ]) {
    const model = createModelFromConfig("claude_code", modelId, RELAY_BASE_URL);
    assert.notEqual(
      model.compat?.forceAdaptiveThinking,
      true,
      `${modelId} must stay budget-mode`,
    );
  }
});

test("anthropic wire: 装饰 id 发送 adaptive + output_config.effort，档位随选择变化", async () => {
  const high = await captureWirePayload("claude-opus-4-8-20260213", "high");
  assert.equal(high.thinking?.type, "adaptive");
  assert.equal(high.output_config?.effort, "high");
  assert.equal(high.model, "claude-opus-4-8-20260213");

  const max = await captureWirePayload("claude-opus-4-8-20260213", "max");
  assert.equal(max.output_config?.effort, "max");

  const low = await captureWirePayload("claude-4.7-opus", "low");
  assert.equal(low.thinking?.type, "adaptive");
  assert.equal(low.output_config?.effort, "low");
});

test("anthropic wire: 旧世代 id 仍发送 budget_tokens 且不带 output_config", async () => {
  const payload = await captureWirePayload("claude-3-7-sonnet-20250219", "high");
  assert.equal(payload.thinking?.type, "enabled");
  assert.equal(payload.thinking?.budget_tokens, 16_384);
  assert.equal(payload.output_config, undefined);
});

test("anthropic wire: [1m] suffix 按端点策略生成真实 request model id", async () => {
  const relayPayload = await captureWirePayload("claude-sonnet-4-5[1m]", undefined);
  assert.equal(relayPayload.model, "claude-sonnet-4-5[1m]");

  const officialPayload = await captureWirePayload(
    "claude-sonnet-4-6[1m]",
    undefined,
    "https://api.anthropic.com/v1",
  );
  assert.equal(officialPayload.model, "claude-sonnet-4-6");
});
