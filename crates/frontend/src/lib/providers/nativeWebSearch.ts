// provider 原生搜索/抓取工具的**名字识别**。引擎在 crates/core，前端只需要认出
// 这些工具调用好把它们折叠进托管搜索卡片，不再构造任何 provider 载荷。

export const HIDDEN_PROVIDER_NATIVE_WEB_SEARCH_TOOL_NAMES = [
  "WebSearch",
  "web_search",
  "builtin_web_search",
  "web_search_20250305",
  "web_search_20260209",
  "web_search_20260318",
  "web_search_preview",
] as const;

// Anthropic's web_fetch server tool pairs with web_search: models trained on it
// emit web_fetch tool calls whenever native search is on. Endpoints that don't
// execute it server-side (Bedrock-style relays) leak those calls to the client
// as plain tool_use blocks, so the same hidden-bridge treatment applies.
export const HIDDEN_PROVIDER_NATIVE_WEB_FETCH_TOOL_NAMES = [
  "WebFetch",
  "web_fetch",
  "builtin_web_fetch",
  "web_fetch_20250910",
  "web_fetch_20260209",
  "web_fetch_20260309",
  "web_fetch_20260318",
] as const;

export function isProviderNativeWebSearchToolName(toolName: string | undefined) {
  const normalized = toolName?.trim().toLowerCase() ?? "";
  return (
    normalized === "builtin_web_search" ||
    normalized === "websearch" ||
    normalized === "web_search" ||
    normalized === "web_search_20250305" ||
    normalized === "web_search_20260209" ||
    normalized === "web_search_20260318" ||
    normalized === "web_search_preview" ||
    normalized.startsWith("web_search_call") ||
    normalized === "x_search" ||
    normalized === "x_keyword_search" ||
    normalized === "x_semantic_search" ||
    normalized.startsWith("x_search_call")
  );
}

export function isProviderNativeWebFetchToolName(toolName: string | undefined) {
  const normalized = toolName?.trim().toLowerCase() ?? "";
  return (
    normalized === "builtin_web_fetch" ||
    normalized === "webfetch" ||
    normalized === "web_fetch" ||
    normalized.startsWith("web_fetch_2") ||
    normalized.startsWith("web_fetch_call")
  );
}
