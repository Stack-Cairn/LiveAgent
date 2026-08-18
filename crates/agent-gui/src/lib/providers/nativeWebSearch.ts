import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { HostedSearchBlock } from "@liveagent/ui/lib/chat/hostedSearch";
import type { ProviderId } from "../settings";
import { isRecord } from "./runtime/common";

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

// Keep the Anthropic server tool on the stable GA contract. Dated dynamic
// versions are intentionally not sent because compatible Claude relays do not
// expose a reliable capability signal and reject unsupported versions with 400.
export const ANTHROPIC_WEB_SEARCH_TOOL_TYPE = "web_search_20250305" as const;

// ---------------------------------------------------------------------------
// Request-payload tool detectors (single catalog source; consumed by
// runtime/nativeSearchPayload.ts to avoid a second drifting copy).
// ---------------------------------------------------------------------------

export function hasAnthropicWebSearchTool(tool: unknown) {
  if (!isRecord(tool)) return false;
  const type = tool.type;
  const name = tool.name;
  return (
    name === "web_search" ||
    type === ANTHROPIC_WEB_SEARCH_TOOL_TYPE ||
    type === "web_search_20260209" ||
    type === "web_search_20260318"
  );
}

export function hasOpenAIResponsesWebSearchTool(tool: unknown) {
  if (!isRecord(tool)) return false;
  const type = tool.type;
  return (
    type === "web_search" ||
    type === "web_search_2025_08_26" ||
    type === "web_search_preview" ||
    type === "web_search_preview_2025_03_11"
  );
}

export function hasGeminiGoogleSearchTool(tool: unknown) {
  if (!isRecord(tool)) return false;
  return Boolean(tool.googleSearch || tool.google_search || tool.googleSearchRetrieval);
}

function readToolCallStringArgument(toolCall: ToolCall, name: string) {
  const args = toolCall.arguments;
  if (!args || typeof args !== "object") return "";
  const value = (args as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

export function readProviderNativeWebSearchQuery(toolCall: ToolCall) {
  return (
    readToolCallStringArgument(toolCall, "query") ||
    readToolCallStringArgument(toolCall, "search_query") ||
    readToolCallStringArgument(toolCall, "additionalContext")
  );
}

export function readProviderNativeWebFetchUrl(toolCall: ToolCall) {
  return readToolCallStringArgument(toolCall, "url") || readToolCallStringArgument(toolCall, "uri");
}

export function buildProviderNativeWebSearchBridgeResult(params: {
  toolCall: ToolCall;
  hostedSearchBlocks: HostedSearchBlock[];
  sourcesIntro: string;
  fallbackText: string;
  extraInstructions?: string[];
}): ToolResultMessage {
  const query = readProviderNativeWebSearchQuery(params.toolCall);
  const sources = params.hostedSearchBlocks
    .flatMap((block) => block.sources)
    .filter((source, index, all) => all.findIndex((item) => item.url === source.url) === index)
    .slice(0, 10);
  const sourceLines = sources.map((source, index) => {
    const title = source.title?.trim() || source.url;
    return `${index + 1}. ${title} - ${source.url}`;
  });
  const text = [
    "Recovered a provider-native web search request that was emitted as raw tool-call markup instead of a structured provider tool call.",
    query ? `Requested query: ${query}` : "",
    sourceLines.length > 0 ? [params.sourcesIntro, ...sourceLines].join("\n") : params.fallbackText,
    ...(params.extraInstructions ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: [{ type: "text", text }],
    details: {
      recoveredProviderNativeWebSearch: true,
      query,
      sourceCount: sources.length,
      sources,
    },
    isError: false,
    timestamp: Date.now(),
  };
}

// Bridge for provider-native web_fetch calls that the endpoint did not execute
// server-side (it leaked them to the client as plain tool_use blocks). We have
// no fetch executor of our own, so answer with a non-error teaching result —
// an error here sends Claude into a retry loop of further web_fetch calls.
export function buildProviderNativeWebFetchBridgeResult(params: {
  toolCall: ToolCall;
  hostedSearchBlocks: HostedSearchBlock[];
  sourcesIntro: string;
  fallbackText: string;
  extraInstructions?: string[];
}): ToolResultMessage {
  const url = readProviderNativeWebFetchUrl(params.toolCall);
  const sources = params.hostedSearchBlocks
    .flatMap((block) => block.sources)
    .filter((source, index, all) => all.findIndex((item) => item.url === source.url) === index)
    .slice(0, 10);
  const sourceLines = sources.map((source, index) => {
    const title = source.title?.trim() || source.url;
    return `${index + 1}. ${title} - ${source.url}`;
  });
  const text = [
    "This endpoint did not execute the provider-native web_fetch request, so the page content is unavailable.",
    url ? `Requested URL: ${url}` : "",
    sourceLines.length > 0 ? [params.sourcesIntro, ...sourceLines].join("\n") : params.fallbackText,
    "Do not retry web_fetch for this URL. Answer from the web search results and other context you already have.",
    ...(params.extraInstructions ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: [{ type: "text", text }],
    details: {
      recoveredProviderNativeWebFetch: true,
      url,
      sourceCount: sources.length,
      sources,
    },
    isError: false,
    timestamp: Date.now(),
  };
}

export function providerSupportsNativeWebSearch(
  providerId: ProviderId,
  api: string | undefined,
  options?: {
    baseUrl?: string;
    modelId?: string;
  },
) {
  if (providerId === "codex" && api === "openai-completions") {
    if (!options?.baseUrl?.trim()) return false;
    if (isOfficialOpenAIBaseUrl(options.baseUrl)) {
      return supportsOpenAIChatCompletionsNativeWebSearchModel(options.modelId);
    }
    return true;
  }

  return (
    (providerId === "codex" && api === "openai-responses") ||
    (providerId === "xai" && api === "openai-responses") ||
    (providerId === "claude_code" && api === "anthropic-messages") ||
    (providerId === "gemini" && api === "google-generative-ai")
  );
}

function isOfficialOpenAIBaseUrl(baseUrl: string | undefined) {
  if (!baseUrl?.trim()) return false;
  try {
    const url = new URL(baseUrl);
    return url.hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function supportsOpenAIChatCompletionsNativeWebSearchModel(modelId: string | undefined) {
  const normalized = modelId?.trim().toLowerCase() ?? "";
  return normalized.includes("search-preview");
}
