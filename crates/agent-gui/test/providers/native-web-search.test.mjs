import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  ANTHROPIC_WEB_SEARCH_TOOL_TYPE,
  hasAnthropicWebSearchTool,
  hasOpenAIResponsesWebSearchTool,
  hasGeminiGoogleSearchTool,
  isProviderNativeWebSearchToolName,
  isProviderNativeWebFetchToolName,
  HIDDEN_PROVIDER_NATIVE_WEB_SEARCH_TOOL_NAMES,
  HIDDEN_PROVIDER_NATIVE_WEB_FETCH_TOOL_NAMES,
  buildProviderNativeWebFetchBridgeResult,
} = loader.loadModule("src/lib/providers/nativeWebSearch.ts");

test("Anthropic native search uses the stable GA version", () => {
  assert.equal(ANTHROPIC_WEB_SEARCH_TOOL_TYPE, "web_search_20250305");
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
