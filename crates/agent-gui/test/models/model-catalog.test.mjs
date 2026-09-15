import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const catalog = loader.loadModule("@liveagent/ui/lib/models/modelCatalog.ts");

// 与 scripts/generate-model-catalog.mjs 的 SECTIONS 同值（键、序、质量门）：
// 上游被截断时刷新会硬错，这里锁住已入库快照的完整性。前四家是应用供应商
// 类型的原生目录；其余分区经预设 sourceId（渠道模型列表）与跨供应商回查消费。
// 分区顺序即跨供应商回查的裁决序：官方在前，平台/聚合站在后。
const MIN_MODELS_PER_PROVIDER = {
  anthropic: 8,
  google: 15,
  openai: 20,
  xai: 3,
  deepseek: 2,
  zhipuai: 10,
  "moonshotai-cn": 2,
  moonshotai: 2,
  "minimax-cn": 3,
  minimax: 3,
  stepfun: 4,
  xiaomi: 4,
  longcat: 1,
  volcengine: 6,
  "alibaba-cn": 40,
  alibaba: 20,
  tencent: 4,
  "siliconflow-cn": 20,
  siliconflow: 20,
  groq: 8,
  openrouter: 100,
  lmstudio: 1,
};
const PROVIDERS = Object.keys(MIN_MODELS_PER_PROVIDER);
const MODEL_CAP = 400;

// 与生成脚本 MODALITIES 同值：模态字段的合法值全集兼规范顺序。
const INPUT_MODALITIES = ["text", "image", "audio", "video", "pdf"];

// 与生成脚本 ENTRY_FIELD_ORDER 同值：目录条目允许的全部字段（不含价格）。
const ENTRY_FIELDS = new Set([
  "id",
  "name",
  "family",
  "contextWindow",
  "maxInputTokens",
  "maxOutputToken",
  "inputModalities",
  "outputModalities",
  "thinking",
  "toolCall",
  "structuredOutput",
  "attachment",
  "temperature",
  "knowledge",
  "releaseDate",
  "lastUpdated",
  "status",
  "openWeights",
  "interleaved",
]);
const FLAG_FIELDS = ["toolCall", "structuredOutput", "attachment", "temperature", "openWeights", "interleaved"];
const DATE_FIELDS = ["knowledge", "releaseDate", "lastUpdated"];

test("generated catalog upholds the data invariants", () => {
  assert.deepEqual(
    Object.keys(catalog.MODEL_CATALOG),
    PROVIDERS,
    "catalog sections must match the generator's SECTIONS (keys and order)",
  );
  for (const providerId of PROVIDERS) {
    const entries = catalog.MODEL_CATALOG[providerId];
    assert.ok(
      entries.length >= MIN_MODELS_PER_PROVIDER[providerId],
      `${providerId}: expected >= ${MIN_MODELS_PER_PROVIDER[providerId]} models, got ${entries.length}`,
    );
    assert.ok(entries.length <= MODEL_CAP, `${providerId}: section must respect MODEL_CAP`);
    const ids = entries.map((entry) => entry.id);
    assert.deepEqual(ids, [...ids].sort(), `${providerId}: ids must be sorted`);
    // 分区索引的小写别名依赖 id 在分区内按小写唯一（同一 id 允许出现在多个
    // 分区——CN/国际双渠道、聚合站转售——由分区顺序裁决）。
    const lowerIds = ids.map((id) => id.toLowerCase());
    assert.equal(
      new Set(lowerIds).size,
      lowerIds.length,
      `${providerId}: ids must be lowercase-unique within the section`,
    );
    for (const entry of entries) {
      const label = `${providerId}/${entry.id}`;
      assert.ok(Number.isInteger(entry.contextWindow) && entry.contextWindow > 0, label);
      assert.ok(Number.isInteger(entry.maxOutputToken) && entry.maxOutputToken > 0, label);
      // 生成期已应用统一语义规则：输出永远小于窗口，且运行时规则视其为不动点。
      assert.ok(entry.maxOutputToken < entry.contextWindow, `${label}: output must be < context`);
      const limits = { contextWindow: entry.contextWindow, maxOutputToken: entry.maxOutputToken };
      assert.deepEqual(catalog.normalizeModelLimits(limits), limits, label);
      if (entry.maxInputTokens !== undefined) {
        assert.ok(
          Number.isInteger(entry.maxInputTokens) &&
            entry.maxInputTokens > 0 &&
            entry.maxInputTokens <= entry.contextWindow,
          `${label}: maxInputTokens must be a positive integer within the window`,
        );
      }
      // 计费功能已移除：目录条目只承载限额、模态、思考能力与描述性事实。
      for (const key of Object.keys(entry)) {
        assert.ok(ENTRY_FIELDS.has(key), `${label}: unexpected field ${key}`);
      }
      // 布尔能力字段只在 true 时写出（models.dev 缺省即 false）。
      for (const key of FLAG_FIELDS) {
        if (key in entry) assert.equal(entry[key], true, `${label}: ${key} must be true when present`);
      }
      for (const key of DATE_FIELDS) {
        if (key in entry) {
          assert.match(entry[key], /^\d{4}(-\d{2}){1,2}$/, `${label}: ${key} must be YYYY-MM[-DD]`);
        }
      }
      if (entry.name !== undefined) assert.notEqual(entry.name, entry.id, `${label}: name == id`);
      if (entry.status !== undefined) {
        assert.ok(["beta", "deprecated"].includes(entry.status), `${label}: status ${entry.status}`);
      }
      for (const field of ["inputModalities", "outputModalities"]) {
        if (!entry[field]) continue;
        assert.ok(entry[field].length > 0, `${label}: ${field} must be non-empty`);
        // 同一断言覆盖三个不变量：值都在合法全集内、无重复、按规范顺序排列。
        assert.deepEqual(
          entry[field],
          INPUT_MODALITIES.filter((modality) => entry[field].includes(modality)),
          `${label}: ${field} must be known values in canonical order`,
        );
      }
      if (entry.outputModalities) {
        assert.notDeepEqual(entry.outputModalities, ["text"], `${label}: text-only output is implicit`);
      }
      if (entry.thinking) {
        assert.deepEqual(Object.keys(entry.thinking).sort(), ["levels", "off"], label);
      }
    }
  }
});

test("catalog carries the capability, limit and lifecycle facts models.dev publishes", () => {
  const gpt52 = catalog.findCatalogModel("codex", "gpt-5.2");
  assert.equal(gpt52.toolCall, true);
  assert.equal(gpt52.structuredOutput, true);
  assert.equal(gpt52.attachment, true);
  assert.equal(gpt52.temperature, true);
  assert.equal(gpt52.maxInputTokens, 272_000);
  assert.equal(gpt52.name, "GPT-5.2");
  assert.equal(gpt52.family, "gpt");
  assert.match(gpt52.releaseDate, /^2025-12/);
  assert.match(gpt52.knowledge, /^2025-/);
  assert.deepEqual(catalog.catalogEntryLimits(gpt52), {
    contextWindow: 400_000,
    maxInputTokens: 272_000,
    maxOutputToken: 128_000,
  });
  // limit.input 未发布时不伪造。
  const sonnet = catalog.findCatalogModel("claude_code", "claude-sonnet-4-6");
  assert.equal(sonnet.maxInputTokens, undefined);
  assert.equal("maxInputTokens" in catalog.catalogEntryLimits(sonnet), false);
  // 聚合站分区保留 vendor/model 形态的 id；命中结果带分区与命中形态。
  const viaOpenRouter = catalog.findCatalogModelInSection("openrouter", "anthropic/claude-sonnet-4.5");
  assert.equal(viaOpenRouter.catalogProviderId, "openrouter");
  assert.equal(viaOpenRouter.matchedId, "anthropic/claude-sonnet-4.5");
  // 跨分区回查：官方分区先于聚合站；剥聚合商前缀后命中官方条目。
  const match = catalog.findCatalogModelMatchAcrossProviders("openrouter/anthropic/claude-sonnet-4-6");
  assert.equal(match.catalogProviderId, "anthropic");
  assert.equal(match.matchedId, "claude-sonnet-4-6");
  // 双渠道同 id：CN 分区在前。
  assert.equal(catalog.findCatalogModelMatchAcrossProviders("qwen-max").catalogProviderId, "alibaba-cn");
  assert.equal(catalog.findCatalogModelInSection("alibaba", "qwen-max").catalogProviderId, "alibaba");
});

test("openai catalog prefers Codex metadata and keeps models.dev supplements", () => {
  // Codex models.json 的 context_window 是输入侧预算（272K），生成期换算成
  // 与目录其余分区一致的总窗口语义：272K + 128K（models.dev 输出补充）= 400K。
  for (const modelId of [
    "gpt-5.2",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ]) {
    assert.equal(
      catalog.findCatalogModel("codex", modelId)?.contextWindow,
      400_000,
      `${modelId}: context window must come from openai/codex models.json (input budget + output)`,
    );
  }

  const sol = catalog.findCatalogModel("codex", "gpt-5.6-sol");
  assert.equal(sol?.maxOutputToken, 128_000, "models.dev must supplement missing output limits");
  assert.deepEqual(sol?.thinking, {
    levels: ["low", "medium", "high", "xhigh", "max"],
    off: true,
  });

  // gpt-5.6 is not a same-id Codex catalog entry; models.dev-only entries stay
  // available as supplements instead of inheriting another model's metadata.
  assert.equal(catalog.findCatalogModel("codex", "gpt-5.6")?.contextWindow, 1_050_000);
});

test("formal DeepSeek catalog only exposes models documented for Responses", () => {
  assert.deepEqual(
    catalog.MODEL_CATALOG.deepseek.map((entry) => entry.id),
    ["deepseek-v4-flash", "deepseek-v4-pro"],
  );
  assert.equal(catalog.findCatalogModel("deepseek", "deepseek-chat"), undefined);
  assert.equal(catalog.findCatalogModel("deepseek", "deepseek-reasoner"), undefined);
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
  assert.equal(catalog.findCatalogModelAcrossProviders("deepseek-v4-pro")?.id, "deepseek-v4-pro");
  assert.equal(catalog.findCatalogModelAcrossProviders("glm-4.6")?.id, "glm-4.6");
  assert.equal(catalog.findCatalogModelAcrossProviders("qwen-max")?.id, "qwen-max");
  assert.equal(catalog.findCatalogModelAcrossProviders("kimi-k2.5")?.id, "kimi-k2.5");
  // 混合大小写目录 id（MiniMax/LongCat）：小写配置经索引别名命中，返回原始 id。
  assert.equal(catalog.findCatalogModelAcrossProviders("minimax-m2.5")?.id, "MiniMax-M2.5");
  assert.equal(catalog.findCatalogModelAcrossProviders("longcat-2.0")?.id, "LongCat-2.0");
});

test("resolveModelInputModalities resolves scoped, decorated, and cross-provider ids", () => {
  // 供应商作用域命中（含候选链装饰形态）。
  assert.deepEqual(catalog.resolveModelInputModalities("claude_code", "claude-sonnet-4-6"), [
    "text",
    "image",
    "pdf",
  ]);
  assert.deepEqual(catalog.resolveModelInputModalities("claude_code", "claude-sonnet-4-6[1m]"), [
    "text",
    "image",
    "pdf",
  ]);
  // Codex 主源合并路径也带模态（models.json 的 input_modalities）。
  assert.deepEqual(catalog.resolveModelInputModalities("codex", "gpt-5.6-sol"), ["text", "image"]);
  // 纯文本模型如实返回 ["text"]，与"目录未命中"（undefined）可区分。
  assert.deepEqual(catalog.resolveModelInputModalities("deepseek", "deepseek-v4-pro"), ["text"]);
  // 供应商作用域未命中时跨供应商回查（国内厂商分区只经此路径消费）。
  assert.deepEqual(catalog.resolveModelInputModalities("codex", "glm-4.6"), ["text"]);
  assert.deepEqual(catalog.resolveModelInputModalities("codex", "qwen3-omni-flash"), [
    "text",
    "image",
    "audio",
    "video",
  ]);
  assert.equal(catalog.resolveModelInputModalities("codex", "model-not-in-catalog"), undefined);
  assert.equal(catalog.resolveModelInputModalities("codex", undefined), undefined);
});

// repairStaleCrossProviderLimits（指纹匹配式的坏默认值修复）已被"方案乙"的
// limitsSource 来源标记取代：settings/index.ts 的 normalizeProviderModelConfig
// 按存量的 catalog/fallback/provider/user 来源判断是否重解析，不再靠数值指纹
// 猜测。对应的来源感知测试见 crates/agent-gui/test/settings/normalization.test.mjs
// 里的 "limitsSource" 相关用例。

test("resolveModelLimits returns repaired catalog limits and undefined on miss", () => {
  // grok-4.5 是本次重构的起因：上游记 500K/500K，快照里已修复为 500K/32K。
  assert.deepEqual(catalog.resolveModelLimits("xai", "grok-4.5"), {
    contextWindow: 500_000,
    maxOutputToken: 32_000,
  });
  assert.equal(catalog.resolveModelLimits("xai", "grok-unknown"), undefined);
});

test("provider fallback limits use total-window semantics and return copies", () => {
  assert.deepEqual(catalog.getProviderFallbackLimits("claude_code"), {
    contextWindow: 200_000,
    maxOutputToken: 32_000,
  });
  // codex/xai 兜底为总窗口语义：258K 输入预算 + 142K 输出 = 400K。
  assert.deepEqual(catalog.getProviderFallbackLimits("codex"), {
    contextWindow: 400_000,
    maxOutputToken: 142_000,
  });
  assert.deepEqual(catalog.getProviderFallbackLimits("gemini"), {
    contextWindow: 1_048_576,
    maxOutputToken: 65_536,
  });
  assert.deepEqual(catalog.getProviderFallbackLimits("xai"), {
    contextWindow: 400_000,
    maxOutputToken: 142_000,
  });
  const first = catalog.getProviderFallbackLimits("xai");
  first.maxOutputToken = 1;
  assert.equal(catalog.getProviderFallbackLimits("xai").maxOutputToken, 142_000);
});
