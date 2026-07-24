import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  ANTHROPIC_WEB_SEARCH_TOOL_TYPES,
  resolveAnthropicWebSearchToolType,
  supportsAnthropicDynamicFilteringWebSearch,
  hasAnthropicWebSearchTool,
  hasOpenAIResponsesWebSearchTool,
  hasGeminiGoogleSearchTool,
  isProviderNativeWebSearchToolName,
  HIDDEN_PROVIDER_NATIVE_WEB_SEARCH_TOOL_NAMES,
} = loader.loadModule("src/lib/providers/nativeWebSearch.ts");

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

test("resolveAnthropicWebSearchToolType returns the dynamic-filtering version for adaptive-thinking models", () => {
  const model = createAnthropicModel("claude-fable-5", { compat: { forceAdaptiveThinking: true } });
  assert.equal(supportsAnthropicDynamicFilteringWebSearch(model), true);
  assert.equal(resolveAnthropicWebSearchToolType(model), ANTHROPIC_WEB_SEARCH_TOOL_TYPES.dynamicFiltering);
  assert.equal(resolveAnthropicWebSearchToolType(model), "web_search_20260318");
});

test("resolveAnthropicWebSearchToolType returns the legacy version for non-adaptive-thinking models", () => {
  const model = createAnthropicModel("claude-opus-4-6", { compat: { forceAdaptiveThinking: false } });
  assert.equal(supportsAnthropicDynamicFilteringWebSearch(model), false);
  assert.equal(resolveAnthropicWebSearchToolType(model), ANTHROPIC_WEB_SEARCH_TOOL_TYPES.legacy);
  assert.equal(resolveAnthropicWebSearchToolType(model), "web_search_20250305");
});

test("resolveAnthropicWebSearchToolType defaults to legacy when compat is absent", () => {
  const model = createAnthropicModel("claude-custom-x");
  assert.equal(resolveAnthropicWebSearchToolType(model), ANTHROPIC_WEB_SEARCH_TOOL_TYPES.legacy);
});

test("hasAnthropicWebSearchTool recognizes every live tool-type version plus the bare name", () => {
  assert.equal(hasAnthropicWebSearchTool({ type: "web_search_20250305", name: "web_search" }), true);
  assert.equal(hasAnthropicWebSearchTool({ type: "web_search_20260209", name: "web_search" }), true);
  assert.equal(hasAnthropicWebSearchTool({ type: "web_search_20260318", name: "web_search" }), true);
  assert.equal(hasAnthropicWebSearchTool({ type: "something_else", name: "web_search" }), true);
  assert.equal(hasAnthropicWebSearchTool({ type: "function", name: "unrelated" }), false);
  assert.equal(hasAnthropicWebSearchTool(null), false);
  assert.equal(hasAnthropicWebSearchTool("web_search"), false);
});

test("hasOpenAIResponsesWebSearchTool recognizes current and legacy preview tool types", () => {
  assert.equal(hasOpenAIResponsesWebSearchTool({ type: "web_search" }), true);
  assert.equal(hasOpenAIResponsesWebSearchTool({ type: "web_search_2025_08_26" }), true);
  assert.equal(hasOpenAIResponsesWebSearchTool({ type: "web_search_preview" }), true);
  assert.equal(hasOpenAIResponsesWebSearchTool({ type: "web_search_preview_2025_03_11" }), true);
  assert.equal(hasOpenAIResponsesWebSearchTool({ type: "function" }), false);
});

test("hasGeminiGoogleSearchTool recognizes camelCase and snake_case tool shapes", () => {
  assert.equal(hasGeminiGoogleSearchTool({ googleSearch: {} }), true);
  assert.equal(hasGeminiGoogleSearchTool({ google_search: {} }), true);
  assert.equal(hasGeminiGoogleSearchTool({ googleSearchRetrieval: {} }), true);
  assert.equal(hasGeminiGoogleSearchTool({ functionDeclarations: [] }), false);
});

test("isProviderNativeWebSearchToolName matches every hidden tool name, case-insensitively", () => {
  for (const name of HIDDEN_PROVIDER_NATIVE_WEB_SEARCH_TOOL_NAMES) {
    assert.equal(isProviderNativeWebSearchToolName(name), true);
    assert.equal(isProviderNativeWebSearchToolName(name.toUpperCase()), true);
  }
  assert.equal(isProviderNativeWebSearchToolName("web_search_call_12345"), true);
  assert.equal(isProviderNativeWebSearchToolName("unrelated_tool"), false);
  assert.equal(isProviderNativeWebSearchToolName(undefined), false);
});

test("isProviderNativeWebSearchToolName recognizes xAI server-side search tool names", () => {
  assert.equal(isProviderNativeWebSearchToolName("x_search"), true);
  assert.equal(isProviderNativeWebSearchToolName("x_keyword_search"), true);
  assert.equal(isProviderNativeWebSearchToolName("x_semantic_search"), true);
  assert.equal(isProviderNativeWebSearchToolName("X_Keyword_Search"), true);
  assert.equal(isProviderNativeWebSearchToolName("x_search_call"), true);
  assert.equal(isProviderNativeWebSearchToolName("x_search_call_output"), true);
  assert.equal(isProviderNativeWebSearchToolName("x_searcher"), false);
  assert.equal(isProviderNativeWebSearchToolName("x_unrelated_tool"), false);
});
