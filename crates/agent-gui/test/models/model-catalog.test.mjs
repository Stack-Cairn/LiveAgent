import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const catalog = loader.loadModule("src/lib/models/modelCatalog.ts");

const PROVIDERS = ["anthropic", "google", "openai", "xai"];
// 与 scripts/generate-model-catalog.mjs 的质量门同值：上游被截断时刷新会硬错，
// 这里锁住已入库快照的完整性。
const MIN_MODELS_PER_PROVIDER = { anthropic: 8, google: 15, openai: 20, xai: 3 };

test("generated catalog upholds the data invariants", () => {
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
