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


const loader = createTsModuleLoader();
const {
  ANTHROPIC_WEB_SEARCH_TOOL_TYPES,
  ANTHROPIC_WEB_FETCH_TOOL_TYPES,
  resolveAnthropicWebSearchToolType,
  resolveAnthropicWebFetchToolType,
  supportsAnthropicDynamicFilteringWebSearch,
  supportsAnthropicNativeWebFetch,
  hasAnthropicWebSearchTool,
  hasAnthropicWebFetchTool,
  hasOpenAIResponsesWebSearchTool,
  hasGeminiGoogleSearchTool,
  isProviderNativeWebSearchToolName,
  isProviderNativeWebFetchToolName,
  HIDDEN_PROVIDER_NATIVE_WEB_SEARCH_TOOL_NAMES,
  HIDDEN_PROVIDER_NATIVE_WEB_FETCH_TOOL_NAMES,
  buildProviderNativeWebFetchBridgeResult,
} = loader.loadModule(coreSrc("providers/nativeWebSearch.ts"));

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

test("resolveAnthropicWebFetchToolType mirrors the web_search dynamic-filtering gate", () => {
  const modern = createAnthropicModel("claude-sonnet-5", {
    compat: { forceAdaptiveThinking: true },
  });
  assert.equal(supportsAnthropicNativeWebFetch(modern), true);
  assert.equal(
    resolveAnthropicWebFetchToolType(modern),
    ANTHROPIC_WEB_FETCH_TOOL_TYPES.dynamicFiltering,
  );
  assert.equal(resolveAnthropicWebFetchToolType(modern), "web_fetch_20260318");

  const legacy = createAnthropicModel("claude-opus-4-6", {
    compat: { forceAdaptiveThinking: false },
  });
  assert.equal(supportsAnthropicNativeWebFetch(legacy), false);
  assert.equal(resolveAnthropicWebFetchToolType(legacy), ANTHROPIC_WEB_FETCH_TOOL_TYPES.legacy);
  assert.equal(resolveAnthropicWebFetchToolType(legacy), "web_fetch_20250910");
});

test("hasAnthropicWebFetchTool recognizes every live tool-type version plus the bare name", () => {
  assert.equal(hasAnthropicWebFetchTool({ type: "web_fetch_20250910", name: "web_fetch" }), true);
  assert.equal(hasAnthropicWebFetchTool({ type: "web_fetch_20260209", name: "web_fetch" }), true);
  assert.equal(hasAnthropicWebFetchTool({ type: "web_fetch_20260309", name: "web_fetch" }), true);
  assert.equal(hasAnthropicWebFetchTool({ type: "web_fetch_20260318", name: "web_fetch" }), true);
  assert.equal(hasAnthropicWebFetchTool({ type: "something_else", name: "web_fetch" }), true);
  assert.equal(hasAnthropicWebFetchTool({ type: "function", name: "unrelated" }), false);
  assert.equal(hasAnthropicWebFetchTool(null), false);
  assert.equal(hasAnthropicWebFetchTool("web_fetch"), false);
});

test("isProviderNativeWebFetchToolName matches every hidden tool name, case-insensitively", () => {
  for (const name of HIDDEN_PROVIDER_NATIVE_WEB_FETCH_TOOL_NAMES) {
    assert.equal(isProviderNativeWebFetchToolName(name), true);
    assert.equal(isProviderNativeWebFetchToolName(name.toUpperCase()), true);
  }
  assert.equal(isProviderNativeWebFetchToolName("web_fetch_call_12345"), true);
  assert.equal(isProviderNativeWebFetchToolName("web_fetch_20991231"), true);
  assert.equal(isProviderNativeWebFetchToolName("web_search"), false);
  assert.equal(isProviderNativeWebFetchToolName("unrelated_tool"), false);
  assert.equal(isProviderNativeWebFetchToolName(undefined), false);
});

test("buildProviderNativeWebFetchBridgeResult teaches instead of erroring", () => {
  const result = buildProviderNativeWebFetchBridgeResult({
    toolCall: {
      type: "toolCall",
      id: "toolu_fetch_bridge",
      name: "web_fetch",
      arguments: { url: "https://www.weather.com.cn/weather1d/101250101.shtml", mode: "truncated" },
    },
    hostedSearchBlocks: [
      {
        type: "hostedSearch",
        id: "srvtoolu_1",
        status: "completed",
        queries: ["changsha weather"],
        sources: [{ url: "https://weather.cma.cn/57687.html", title: "CMA", sourceType: "source" }],
      },
    ],
    sourcesIntro: "Hosted search sources already captured in this round:",
    fallbackText: "No hosted search sources were captured in this round.",
  });

  assert.equal(result.isError, false);
  assert.equal(result.toolCallId, "toolu_fetch_bridge");
  assert.equal(result.details.recoveredProviderNativeWebFetch, true);
  assert.equal(result.details.url, "https://www.weather.com.cn/weather1d/101250101.shtml");
  assert.match(result.content[0].text, /did not execute the provider-native web_fetch/);
  assert.match(result.content[0].text, /https:\/\/www\.weather\.com\.cn\/weather1d\/101250101\.shtml/);
  assert.match(result.content[0].text, /CMA - https:\/\/weather\.cma\.cn\/57687\.html/);
  assert.match(result.content[0].text, /Do not retry web_fetch/);
});
