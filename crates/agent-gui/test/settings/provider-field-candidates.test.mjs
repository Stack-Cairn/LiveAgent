// 设计文档 §6.2（字段候选、冲突与采纳）与 §6.3（模型级参数的读写）的反漂移锁。
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  mocks: { "@tauri-apps/api/core": { invoke: async () => ({}) } },
});
const model = loader.loadModule("@liveagent/ui/pages/settings/providers/providerSettingsModel.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

function openaiProvider(extra = {}) {
  return settings.normalizeCustomProvider({
    id: "oa",
    name: "OpenAI",
    type: "codex",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    models: [{ id: "gpt-5.2" }, { id: "my-finetune" }],
    activeModels: ["gpt-5.2", "my-finetune"],
    ...extra,
  });
}

test("供应商 /models 的限额与模态声明被留存为 providerMeta 候选", () => {
  const provider = settings.normalizeCustomProvider({
    id: "or",
    name: "OpenRouter",
    type: "codex",
    presetId: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk",
    // 上游原始条目形状（刷新模型列表那一次拿到的就是它）。
    models: [
      {
        id: "anthropic/claude-sonnet-4.5",
        context_length: 300_000,
        top_provider: { max_completion_tokens: 32_000 },
        architecture: { input_modalities: ["text", "image"] },
      },
    ],
  });
  const stored = provider.models[0];
  assert.equal(stored.providerMeta.contextWindow, 300_000);
  assert.equal(stored.providerMeta.maxOutputToken, 32_000);
  assert.deepEqual(stored.providerMeta.inputModalities, ["text", "image"]);
  assert.ok(stored.providerMeta.fetchedAt > 0);

  // 再读一次（加载存档）：providerMeta 原样保留，不丢失也不刷新时间戳。
  const reloaded = settings.normalizeCustomProvider(provider).models[0];
  assert.deepEqual(reloaded.providerMeta, stored.providerMeta);
});

test("用户的 inputModalities 覆盖不会被误当成供应商声明", () => {
  const provider = openaiProvider({
    models: [{ id: "my-finetune", inputModalities: ["text", "image"] }],
  });
  assert.deepEqual(provider.models[0].inputModalities, ["text", "image"]);
  assert.equal("providerMeta" in provider.models[0], false);
});

test("限额候选按 目录 > 供应商 > 启发式 排列，目录与供应商不同即冲突", () => {
  const defaults = { contextWindow: 200_000, maxOutputToken: 64_000, source: "catalog" };
  const infos = model.modelLimitFieldInfos(
    {
      id: "m",
      contextWindow: 200_000,
      maxOutputToken: 64_000,
      limitsSource: "catalog",
      providerMeta: { contextWindow: 300_000, maxOutputToken: 64_000, fetchedAt: 1 },
    },
    defaults,
  );
  assert.deepEqual(infos.contextWindow.candidates, [
    { value: 200_000, source: "catalog" },
    { value: 300_000, source: "provider" },
  ]);
  assert.deepEqual(infos.contextWindow.conflict, { catalog: 200_000, provider: 300_000 });
  // 值相同 → 有候选但不冲突。
  assert.equal(infos.maxOutputToken.conflict, undefined);
  assert.equal(infos.maxOutputToken.candidates.length, 2);

  // 没有供应商声明时只有目录候选。
  const catalogOnly = model.modelLimitFieldInfos(
    { id: "m", contextWindow: 200_000, maxOutputToken: 64_000, limitsSource: "catalog" },
    defaults,
  );
  assert.deepEqual(catalogOnly.contextWindow.candidates, [{ value: 200_000, source: "catalog" }]);
  assert.equal(catalogOnly.contextWindow.conflict, undefined);

  // 兜底来源记 heuristic。
  const fallback = model.modelLimitFieldInfos(
    { id: "m", contextWindow: 128_000, maxOutputToken: 8_192, limitsSource: "fallback" },
    { contextWindow: 128_000, maxOutputToken: 8_192, source: "fallback" },
  );
  assert.deepEqual(fallback.contextWindow.candidates, [{ value: 128_000, source: "heuristic" }]);
});

test("采纳供应商值写成用户覆盖，供应商元数据本身不自动改有效值", () => {
  const before = {
    id: "m",
    contextWindow: 200_000,
    maxOutputToken: 64_000,
    limitsSource: "catalog",
    providerMeta: { contextWindow: 300_000, fetchedAt: 1 },
  };
  const after = model.adoptModelLimitCandidate(before, "contextWindow", 300_000);
  assert.equal(after.contextWindow, 300_000);
  assert.equal(after.limitsSource, "user");
  // 原对象未被改写，providerMeta 仍在。
  assert.equal(before.contextWindow, 200_000);
  assert.deepEqual(after.providerMeta, before.providerMeta);

  // 能力行的采纳走同一条覆盖写入路径。
  const capability = model.adoptModelCapabilityCandidate({ id: "m" }, "tools", "unsupported");
  assert.deepEqual(capability.capabilities, { tools: "unsupported" });
  // unknown 不是可写覆盖，采纳是空操作。
  const noop = { id: "m" };
  assert.equal(model.adoptModelCapabilityCandidate(noop, "tools", "unknown"), noop);
});

test("providerMeta 的模态声明进入视觉能力候选，目录优先", () => {
  const provider = openaiProvider({
    models: [
      { id: "gpt-5.2", providerMeta: { inputModalities: ["text"], fetchedAt: 1 } },
      { id: "my-finetune", providerMeta: { inputModalities: ["text", "image"], fetchedAt: 1 } },
    ],
  });
  const rows = Object.fromEntries(
    model
      .modelCapabilityRows(
        provider,
        "gpt-5.2",
        settings.resolveProviderChatRoute(provider, "gpt-5.2"),
      )
      .map((row) => [row.key, row]),
  );
  // 目录说支持图片、供应商说只有文本 → 冲突；有效值仍是目录值（不自动采纳）。
  assert.equal(rows.imageUnderstanding.effective.state, "supported");
  assert.equal(rows.imageUnderstanding.effective.source, "catalog");
  assert.deepEqual(rows.imageUnderstanding.conflict, {
    catalog: "supported",
    provider: "unsupported",
  });

  // 目录未命中时供应商声明直接生效。
  const missRows = Object.fromEntries(
    model
      .modelCapabilityRows(
        provider,
        "my-finetune",
        settings.resolveProviderChatRoute(provider, "my-finetune"),
      )
      .map((row) => [row.key, row]),
  );
  assert.equal(missRows.imageUnderstanding.effective.state, "supported");
  assert.equal(missRows.imageUnderstanding.effective.source, "provider");
  assert.equal(missRows.imageUnderstanding.conflict, undefined);
});

test("setModelParameter 逐项写入并在清空后删除整键", () => {
  const base = { id: "m", contextWindow: 128_000, maxOutputToken: 8_192 };
  const withTemp = model.setModelParameter(base, "temperature", 0.3);
  assert.deepEqual(withTemp.parameters, { temperature: 0.3 });
  const withTopP = model.setModelParameter(withTemp, "topP", 0.9);
  assert.deepEqual(withTopP.parameters, { temperature: 0.3, topP: 0.9 });
  const cleared = model.setModelParameter(
    model.setModelParameter(withTopP, "topP", undefined),
    "temperature",
    undefined,
  );
  assert.equal("parameters" in cleared, false);
  // 越界值被归一化丢弃，不会写进配置。
  assert.equal("parameters" in model.setModelParameter(base, "temperature", 9), false);
  // maxTokens 不能超过模型输出上限。
  assert.equal("parameters" in model.setModelParameter(base, "maxTokens", 99_999), false);
  assert.deepEqual(model.setModelParameter(base, "maxTokens", 4_096).parameters, {
    maxTokens: 4_096,
  });
});

test("modelParameterApplies 与接口白名单一致", () => {
  assert.equal(model.modelParameterApplies("openai-responses", "topP"), true);
  assert.equal(model.modelParameterApplies("anthropic-messages", "topP"), false);
  assert.equal(model.modelParameterApplies("google-generative-ai", "temperature"), true);
  assert.equal(model.modelParameterApplies("anthropic-messages", "maxTokens"), true);
});

test("parallelTools 旧存档里的能力键被静默丢弃", () => {
  const provider = openaiProvider({
    models: [
      { id: "gpt-5.2", capabilities: { parallelTools: "supported", tools: "unsupported" } },
    ],
  });
  assert.deepEqual(provider.models[0].capabilities, { tools: "unsupported" });
});
