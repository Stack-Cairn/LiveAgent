import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const catalog = loader.loadModule("src/lib/models/modelCatalog.ts");

// 与 scripts/generate-model-catalog.mjs 的 SECTIONS 同值（键、序、质量门）：
// 上游被截断时刷新会硬错，这里锁住已入库快照的完整性。前四家是应用供应商
// 类型的原生目录；其余为国内厂商分区，只经跨供应商回查消费。
const MIN_MODELS_PER_PROVIDER = {
  anthropic: 8,
  google: 15,
  openai: 20,
  xai: 3,
  deepseek: 3,
  zhipuai: 10,
  moonshotai: 8,
  minimax: 5,
  stepfun: 4,
  xiaomi: 4,
  longcat: 1,
  alibaba: 40,
  tencent: 4,
};
const PROVIDERS = Object.keys(MIN_MODELS_PER_PROVIDER);

test("generated catalog upholds the data invariants", () => {
  assert.deepEqual(
    Object.keys(catalog.MODEL_CATALOG),
    PROVIDERS,
    "catalog sections must match the generator's SECTIONS (keys and order)",
  );
  // 跨供应商回查（findCatalogModelAcrossProviders）与索引的小写别名依赖
  // id 全目录按小写唯一，否则同名模型在不同分区下会产生歧义命中。
  const allIds = PROVIDERS.flatMap((providerId) =>
    catalog.MODEL_CATALOG[providerId].map((entry) => entry.id.toLowerCase()),
  );
  assert.equal(new Set(allIds).size, allIds.length, "ids must be lowercase-unique across sections");
  for (const providerId of PROVIDERS) {
    const entries = catalog.MODEL_CATALOG[providerId];
    assert.ok(
      entries.length >= MIN_MODELS_PER_PROVIDER[providerId],
      `${providerId}: expected >= ${MIN_MODELS_PER_PROVIDER[providerId]} models, got ${entries.length}`,
    );
    const ids = entries.map((entry) => entry.id);
    assert.deepEqual(ids, [...ids].sort(), `${providerId}: ids must be sorted`);
    assert.equal(new Set(ids).size, ids.length, `${providerId}: ids must be unique`);
    for (const entry of entries) {
      const label = `${providerId}/${entry.id}`;
      assert.ok(Number.isInteger(entry.contextWindow) && entry.contextWindow > 0, label);
      assert.ok(Number.isInteger(entry.maxOutputToken) && entry.maxOutputToken > 0, label);
      // 生成期已应用统一语义规则：输出永远小于窗口，且运行时规则视其为不动点。
      assert.ok(entry.maxOutputToken < entry.contextWindow, `${label}: output must be < context`);
      const limits = { contextWindow: entry.contextWindow, maxOutputToken: entry.maxOutputToken };
      assert.deepEqual(catalog.normalizeModelLimits(limits), limits, label);
      // 计费功能已移除：目录条目只承载限额。
      assert.deepEqual(Object.keys(entry).sort(), ["contextWindow", "id", "maxOutputToken"], label);
    }
  }
});

test("normalizeModelLimits repairs degenerate pairs uniformly and leaves valid pairs alone", () => {
  // 退化（输出吃满窗口）：钳到 min(32K, ⌊窗口/4⌋)。
  assert.deepEqual(
    catalog.normalizeModelLimits({ contextWindow: 500_000, maxOutputToken: 500_000 }),
    { contextWindow: 500_000, maxOutputToken: 32_000 },
  );
  assert.deepEqual(
    catalog.normalizeModelLimits({ contextWindow: 8_192, maxOutputToken: 8_192 }),
    { contextWindow: 8_192, maxOutputToken: 2_048 },
  );
  assert.deepEqual(
    catalog.normalizeModelLimits({ contextWindow: 100_000, maxOutputToken: 200_000 }),
    { contextWindow: 100_000, maxOutputToken: 25_000 },
  );
  // 合法值原样透传（含大输出模型，不做无条件钳制）。
  assert.deepEqual(
    catalog.normalizeModelLimits({ contextWindow: 200_000, maxOutputToken: 128_000 }),
    { contextWindow: 200_000, maxOutputToken: 128_000 },
  );
  // 非正窗口不做修复（由上层兜底逻辑处理）。
  assert.deepEqual(
    catalog.normalizeModelLimits({ contextWindow: 0, maxOutputToken: 0 }),
    { contextWindow: 0, maxOutputToken: 0 },
  );
});

test("normalizeModelIdCandidates yields the decorated-id chain in order without duplicates", () => {
  assert.deepEqual(catalog.normalizeModelIdCandidates("Claude-Sonnet-4-6-20260115[1m]@v2"), [
    "Claude-Sonnet-4-6-20260115[1m]@v2",
    "claude-sonnet-4-6-20260115[1m]@v2",
    "claude-sonnet-4-6-20260115[1m]",
    "claude-sonnet-4-6-20260115",
    "claude-sonnet-4-6",
  ]);
  assert.deepEqual(catalog.normalizeModelIdCandidates("grok-4.5"), ["grok-4.5"]);
});

test("findCatalogModel resolves exact and decorated ids across providers", () => {
  assert.equal(catalog.findCatalogModel("xai", "grok-4.5")?.id, "grok-4.5");
  // 候选链对全部供应商生效：大小写、[1m]、日期后缀、@版本。
  assert.equal(catalog.findCatalogModel("xai", "GROK-4.5")?.id, "grok-4.5");
  assert.equal(catalog.findCatalogModel("claude_code", "claude-sonnet-4-6[1m]")?.id, "claude-sonnet-4-6");
  assert.equal(catalog.findCatalogModel("claude_code", "claude-sonnet-4-6@v1")?.id, "claude-sonnet-4-6");
  assert.equal(catalog.findCatalogModel("codex", "gpt-5")?.id, "gpt-5");
  assert.equal(catalog.findCatalogModel("codex", "model-not-in-catalog"), undefined);
  assert.equal(catalog.findCatalogModel("gemini", ""), undefined);
  assert.equal(catalog.findCatalogModel("gemini", undefined), undefined);
});

test("cross-provider lookup resolves models configured under a foreign provider", () => {
  // 中转聚合场景：别家模型挂在本供应商类型下时按 id 全目录回查。
  assert.equal(catalog.findCatalogModelAcrossProviders("grok-4.5")?.id, "grok-4.5");
  // 候选链（大小写、@版本、[1m]、日期后缀）对跨供应商回查同样生效。
  assert.equal(catalog.findCatalogModelAcrossProviders("GROK-4.5@prod")?.id, "grok-4.5");
  assert.equal(catalog.findCatalogModelAcrossProviders("model-not-in-catalog"), undefined);
  assert.equal(catalog.findCatalogModelAcrossProviders(""), undefined);
  assert.equal(catalog.findCatalogModelAcrossProviders(undefined), undefined);
  assert.deepEqual(catalog.resolveModelLimitsAcrossProviders("grok-4.5"), {
    contextWindow: 500_000,
    maxOutputToken: 32_000,
  });
  assert.equal(catalog.resolveModelLimitsAcrossProviders("model-not-in-catalog"), undefined);
  // 国内厂商分区（无对应应用供应商类型）经跨供应商回查可命中。
  assert.equal(catalog.findCatalogModelAcrossProviders("deepseek-chat")?.id, "deepseek-chat");
  assert.equal(catalog.findCatalogModelAcrossProviders("glm-4.6")?.id, "glm-4.6");
  assert.equal(catalog.findCatalogModelAcrossProviders("qwen-max")?.id, "qwen-max");
  assert.equal(catalog.findCatalogModelAcrossProviders("kimi-k2.5")?.id, "kimi-k2.5");
  // 混合大小写目录 id（MiniMax/LongCat）：小写配置经索引别名命中，返回原始 id。
  assert.equal(catalog.findCatalogModelAcrossProviders("minimax-m2.5")?.id, "MiniMax-M2.5");
  assert.equal(catalog.findCatalogModelAcrossProviders("longcat-2.0")?.id, "LongCat-2.0");
});

test("repairStaleCrossProviderLimits replaces only stale provider-fallback pairs", () => {
  // grok-4.5 挂在 anthropic 类型下、存量恰为 claude_code 兜底对：判为跨供应商
  // 回查上线前落库的坏默认值，替换为目录真实限额。
  assert.deepEqual(
    catalog.repairStaleCrossProviderLimits("claude_code", "grok-4.5", {
      contextWindow: 200_000,
      maxOutputToken: 32_000,
    }),
    { contextWindow: 500_000, maxOutputToken: 32_000 },
  );
  // 任一值偏离兜底对 = 用户显式配置，原样保留。
  assert.deepEqual(
    catalog.repairStaleCrossProviderLimits("claude_code", "grok-4.5", {
      contextWindow: 200_000,
      maxOutputToken: 31_000,
    }),
    { contextWindow: 200_000, maxOutputToken: 31_000 },
  );
  // 本供应商目录可命中的模型绝不跨供应商替换（claude-opus-4-1 真实限额恰为兜底对）。
  assert.deepEqual(
    catalog.repairStaleCrossProviderLimits("claude_code", "claude-opus-4-1", {
      contextWindow: 200_000,
      maxOutputToken: 32_000,
    }),
    { contextWindow: 200_000, maxOutputToken: 32_000 },
  );
  // 全目录未收录：兜底对本来就是正确默认值，保持不动。
  assert.deepEqual(
    catalog.repairStaleCrossProviderLimits("xai", "relay-custom-model", {
      contextWindow: 258_000,
      maxOutputToken: 142_000,
    }),
    { contextWindow: 258_000, maxOutputToken: 142_000 },
  );
});

test("resolveModelLimits returns repaired catalog limits and undefined on miss", () => {
  // grok-4.5 是本次重构的起因：上游记 500K/500K，快照里已修复为 500K/32K。
  assert.deepEqual(catalog.resolveModelLimits("xai", "grok-4.5"), {
    contextWindow: 500_000,
    maxOutputToken: 32_000,
  });
  assert.equal(catalog.resolveModelLimits("xai", "grok-unknown"), undefined);
});

test("provider fallback limits keep the historical defaults and return copies", () => {
  assert.deepEqual(catalog.getProviderFallbackLimits("claude_code"), {
    contextWindow: 200_000,
    maxOutputToken: 32_000,
  });
  assert.deepEqual(catalog.getProviderFallbackLimits("codex"), {
    contextWindow: 258_000,
    maxOutputToken: 142_000,
  });
  assert.deepEqual(catalog.getProviderFallbackLimits("gemini"), {
    contextWindow: 1_048_576,
    maxOutputToken: 65_536,
  });
  assert.deepEqual(catalog.getProviderFallbackLimits("xai"), {
    contextWindow: 258_000,
    maxOutputToken: 142_000,
  });
  const first = catalog.getProviderFallbackLimits("xai");
  first.maxOutputToken = 1;
  assert.equal(catalog.getProviderFallbackLimits("xai").maxOutputToken, 142_000);
});
