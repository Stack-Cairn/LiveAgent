import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 模型列表工具栏的纯函数层：搜索 / 过滤的可见集合、过滤计数、文档地址来源与
// docUrl 归一化。
const loader = createTsModuleLoader({
  mocks: { "@tauri-apps/api/core": { invoke: async () => ({}) } },
});
const model = loader.loadModule("@liveagent/ui/pages/settings/providers/providerSettingsModel.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

const models = [
  { id: "gpt-5", displayName: "GPT-5", contextWindow: 1, maxOutputToken: 1 },
  { id: "gpt-5-mini", wireModelId: "openai/gpt-5-mini", contextWindow: 1, maxOutputToken: 1 },
  { id: "claude-sonnet-4", displayName: "Sonnet", contextWindow: 1, maxOutputToken: 1 },
  { id: "gemini-2.5-pro", contextWindow: 1, maxOutputToken: 1 },
  { id: "orphan", contextWindow: 1, maxOutputToken: 1 },
];

function info(overrides) {
  return {
    active: true,
    vision: false,
    file: false,
    reasoning: false,
    tools: false,
    search: false,
    protocol: "openai-responses",
    ...overrides,
  };
}

const infoById = new Map([
  ["gpt-5", info({ vision: true, tools: true, reasoning: true })],
  ["gpt-5-mini", info({ tools: true, active: false })],
  ["claude-sonnet-4", info({ vision: true, file: true, tools: true, protocol: "anthropic-messages" })],
  ["gemini-2.5-pro", info({ vision: true, search: true, protocol: "google-generative-ai", active: false })],
]);

function filter(overrides = {}) {
  return { ...model.EMPTY_MODEL_LIST_FILTER, ...overrides };
}

function visible(overrides) {
  return [...model.filterProviderModels(models, infoById, filter(overrides))].sort();
}

test("empty filter shows every model that has row info; unknown rows stay hidden", () => {
  assert.deepEqual(visible(), ["claude-sonnet-4", "gemini-2.5-pro", "gpt-5", "gpt-5-mini"]);
  assert.equal(model.modelListFilterActive(filter()), false);
  assert.equal(model.modelListFilterCount(filter()), 0);
});

test("query matches id, display name and wire id case-insensitively as a substring", () => {
  assert.deepEqual(visible({ query: "GPT" }), ["gpt-5", "gpt-5-mini"]);
  assert.deepEqual(visible({ query: "sonnet" }), ["claude-sonnet-4"]);
  assert.deepEqual(visible({ query: "OPENAI/" }), ["gpt-5-mini"]);
  // 首尾空白忽略；"mini" 也命中 ge-mini-2.5-pro（纯子串，不按词边界）
  assert.deepEqual(visible({ query: "  mini  " }), ["gemini-2.5-pro", "gpt-5-mini"]);
  assert.deepEqual(visible({ query: "nothing" }), []);
  // 只有空白的搜索词不算生效
  assert.equal(model.modelListFilterActive(filter({ query: "   " })), false);
  assert.equal(model.modelListFilterActive(filter({ query: "g" })), true);
});

test("capabilities narrow with AND; status and protocol widen with OR", () => {
  assert.deepEqual(visible({ capabilities: ["vision"] }), [
    "claude-sonnet-4",
    "gemini-2.5-pro",
    "gpt-5",
  ]);
  assert.deepEqual(visible({ capabilities: ["vision", "tools"] }), ["claude-sonnet-4", "gpt-5"]);
  assert.deepEqual(visible({ capabilities: ["search", "file"] }), []);
  assert.deepEqual(visible({ enabled: ["disabled"] }), ["gemini-2.5-pro", "gpt-5-mini"]);
  assert.deepEqual(visible({ enabled: ["enabled", "disabled"] }), [
    "claude-sonnet-4",
    "gemini-2.5-pro",
    "gpt-5",
    "gpt-5-mini",
  ]);
  assert.deepEqual(visible({ protocols: ["anthropic-messages", "google-generative-ai"] }), [
    "claude-sonnet-4",
    "gemini-2.5-pro",
  ]);
});

test("query and filter facets intersect; count only counts facets", () => {
  const combined = filter({
    query: "g",
    capabilities: ["vision"],
    enabled: ["enabled"],
    protocols: ["openai-responses"],
  });
  assert.deepEqual([...model.filterProviderModels(models, infoById, combined)], ["gpt-5"]);
  assert.equal(model.modelListFilterCount(combined), 3);
  assert.equal(model.modelListFilterActive(combined), true);
});

test("providerDocUrl prefers the provider's own docUrl, then the preset doc", () => {
  assert.equal(
    model.providerDocUrl({ presetId: "openai", docUrl: "https://relay.example/docs" }),
    "https://relay.example/docs",
  );
  assert.equal(
    model.providerDocUrl({ presetId: "openai" }),
    "https://platform.openai.com/docs/models",
  );
  assert.equal(model.providerDocUrl({ presetId: "custom" }), undefined);
  assert.equal(model.providerDocUrl({ presetId: undefined, docUrl: "" }), undefined);
});

test("docUrl normalization keeps only absolute http(s) URLs", () => {
  const base = { id: "p", type: "codex", baseUrl: "https://relay.example/v1" };
  assert.equal(
    settings.normalizeCustomProvider({ ...base, docUrl: "  https://relay.example/docs  " }).docUrl,
    "https://relay.example/docs",
  );
  assert.equal(
    settings.normalizeCustomProvider({ ...base, docUrl: "http://relay.example/docs" }).docUrl,
    "http://relay.example/docs",
  );
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "relay.example/docs", "", 42]) {
    assert.equal(
      settings.normalizeCustomProvider({ ...base, docUrl: bad }).docUrl,
      undefined,
      `rejects ${String(bad)}`,
    );
  }
  assert.equal("docUrl" in settings.normalizeCustomProvider(base), false);
});
