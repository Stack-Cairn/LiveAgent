import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// inputModalities（模型输入模态用户覆盖）的反漂移锁：
// 1. normalizer 的过滤/补齐/规范顺序契约；
// 2. 设置加载往返不丢字段；
// 3. modelFactory 只在附件发送确实受 model.input 门控的分支（codex/gemini）
//    应用覆盖，deepseek/anthropic 不适用（避免虚假能力声明）。
const loader = createTsModuleLoader();
const { normalizeInputModalities, normalizeProviderModelConfig, normalizeProviderModelConfigs } =
  loader.loadModule("src/lib/settings/index.ts");
const { createModelFromConfig } = loader.loadModule(
  "src/lib/providers/runtime/modelFactory.ts",
);
// providerUtils 依赖 tauri invoke；normalizeFetchedModels 本身不触发网络，
// mock 仅为满足模块加载。
const providerUtilsLoader = createTsModuleLoader({
  mocks: { "@tauri-apps/api/core": { invoke: async () => ({}) } },
});
const {
  applyModelInputModalitiesMode,
  getModelInputModalitiesMode,
  normalizeFetchedModels,
  providerSupportsModelInputModalitiesOverride,
} = providerUtilsLoader.loadModule("@liveagent/ui/pages/settings/providerUtils.ts");

test("normalizeInputModalities rejects non-arrays and empty/fully-invalid arrays", () => {
  assert.equal(normalizeInputModalities(undefined), undefined);
  assert.equal(normalizeInputModalities(null), undefined);
  assert.equal(normalizeInputModalities("image"), undefined);
  assert.equal(normalizeInputModalities({ 0: "image" }), undefined);
  assert.equal(normalizeInputModalities([]), undefined);
  assert.equal(normalizeInputModalities(["audio"]), undefined);
  assert.equal(normalizeInputModalities([" image "]), undefined);
});

test("normalizeInputModalities filters mixed arrays and dedupes", () => {
  assert.deepEqual(normalizeInputModalities(["image", 123, "future"]), ["text", "image"]);
  assert.deepEqual(normalizeInputModalities(["image", "image", "text"]), ["text", "image"]);
});

test("normalizeInputModalities auto-adds text and emits canonical order", () => {
  // 聊天协议始终发送文本：image-only 覆盖自动补齐 text
  assert.deepEqual(normalizeInputModalities(["image"]), ["text", "image"]);
  assert.deepEqual(normalizeInputModalities(["image", "text"]), ["text", "image"]);
  assert.deepEqual(normalizeInputModalities(["text"]), ["text"]);
});

test("normalizeProviderModelConfig preserves a valid inputModalities override", () => {
  const normalized = normalizeProviderModelConfig(
    {
      id: "k3",
      contextWindow: 258000,
      maxOutputToken: 32000,
      limitsSource: "user",
      inputModalities: ["text", "image"],
    },
    "codex",
  );
  assert.deepEqual(normalized.inputModalities, ["text", "image"]);
});

test("normalizeProviderModelConfig drops malformed inputModalities and legacy archives", () => {
  const malformed = normalizeProviderModelConfig(
    { id: "k3", contextWindow: 258000, maxOutputToken: 32000, inputModalities: "image" },
    "codex",
  );
  assert.equal("inputModalities" in malformed, false);
  const legacy = normalizeProviderModelConfig(
    { id: "k3", contextWindow: 258000, maxOutputToken: 32000 },
    "codex",
  );
  assert.equal("inputModalities" in legacy, false);
});

test("modelFactory: codex completions custom model honors the override", () => {
  const base = ["codex", "k3", "https://api.kimi.com/coding/v1", "openai-completions"];
  const withoutOverride = createModelFromConfig(...base);
  assert.deepEqual(withoutOverride.input, ["text"]);
  const withOverride = createModelFromConfig(...base, {
    id: "k3",
    contextWindow: 258000,
    maxOutputToken: 32000,
    inputModalities: ["text", "image"],
  });
  // 构造带覆盖的模型不能反向污染此前创建的无覆盖模型实例。
  assert.deepEqual(withoutOverride.input, ["text"]);
  assert.deepEqual(withOverride.input, ["text", "image"]);
});

test(
  "ProviderModal input capability mode preserves auto/text/image semantics and provider boundary",
  () => {
    const baseModel = { id: "k3", contextWindow: 258000, maxOutputToken: 32000 };
    const textOnly = applyModelInputModalitiesMode(baseModel, "text");
    const textAndImage = applyModelInputModalitiesMode(textOnly, "text-image");
    const automatic = applyModelInputModalitiesMode(textAndImage, "auto");

    assert.equal(getModelInputModalitiesMode(baseModel), "auto");
    assert.equal(getModelInputModalitiesMode(textOnly), "text");
    assert.equal(getModelInputModalitiesMode(textAndImage), "text-image");
    assert.equal("inputModalities" in automatic, false);

    assert.equal(providerSupportsModelInputModalitiesOverride("codex"), true);
    assert.equal(providerSupportsModelInputModalitiesOverride("xai"), true);
    assert.equal(providerSupportsModelInputModalitiesOverride("gemini"), true);
    assert.equal(providerSupportsModelInputModalitiesOverride("deepseek"), false);
    assert.equal(providerSupportsModelInputModalitiesOverride("claude_code"), false);
  },
);

test("modelFactory: codex custom model ignores a malformed override", () => {
  const model = createModelFromConfig(
    "codex",
    "k3",
    "https://api.kimi.com/coding/v1",
    "openai-completions",
    { id: "k3", contextWindow: 258000, maxOutputToken: 32000, inputModalities: ["audio"] },
  );
  assert.deepEqual(model.input, ["text"]);
});

test("modelFactory: gemini custom model honors the override", () => {
  const model = createModelFromConfig(
    "gemini",
    "some-custom-proxy-model",
    "https://gemini-proxy.example.com",
    undefined,
    {
      id: "some-custom-proxy-model",
      contextWindow: 128000,
      maxOutputToken: 32000,
      inputModalities: ["text"],
    },
  );
  assert.deepEqual(model.input, ["text"]);
});

test("modelFactory: deepseek keeps the hard text-only constraint despite the override", () => {
  const model = createModelFromConfig(
    "deepseek",
    "deepseek-v4-pro",
    "https://api.deepseek.com",
    undefined,
    {
      id: "deepseek-v4-pro",
      contextWindow: 128000,
      maxOutputToken: 32000,
      inputModalities: ["text", "image"],
    },
  );
  assert.deepEqual(model.input, ["text"]);
});

test("modelFactory: anthropic custom model does not apply the override (attachments ignore model.input upstream)", () => {
  const model = createModelFromConfig(
    "claude_code",
    "unknown-relay-claude-model",
    "https://claude-relay.example.com",
    undefined,
    {
      id: "unknown-relay-claude-model",
      contextWindow: 200000,
      maxOutputToken: 32000,
      inputModalities: ["text", "image"],
    },
  );
  assert.deepEqual(model.input, ["text"]);
});

test("gemini persisted model survives the ProviderModal open/save round trip", () => {
  const persisted = [
    {
      id: "gemini-custom",
      contextWindow: 123456,
      maxOutputToken: 789,
      limitsSource: "user",
      inputModalities: ["text", "image"],
    },
  ];
  // ProviderModal 初始化（持久化归一化）：所有用户字段原样往返
  const viaModal = normalizeProviderModelConfigs(persisted, "gemini");
  assert.deepEqual(viaModal[0], {
    id: "gemini-custom",
    contextWindow: 123456,
    maxOutputToken: 789,
    limitsSource: "user",
    inputModalities: ["text", "image"],
  });
});

test("gemini fetch-path normalization preserves the inputModalities override", () => {
  // API 响应形状的条目（inputTokenLimit/outputTokenLimit）混有用户覆盖字段时，
  // 刷新后覆盖不得丢失（此前 normalizeGeminiFetchedModels 重建对象会洗掉它）。
  const fetched = [
    {
      name: "models/gemini-custom",
      inputTokenLimit: 123456,
      outputTokenLimit: 789,
      inputModalities: ["image"],
    },
  ];
  const viaFetch = normalizeFetchedModels(fetched, "gemini");
  assert.equal(viaFetch.length, 1);
  assert.deepEqual(viaFetch[0].inputModalities, ["text", "image"]);
});
