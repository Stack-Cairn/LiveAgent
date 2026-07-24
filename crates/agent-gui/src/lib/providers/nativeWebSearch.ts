import type { Model, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { HostedSearchBlock } from "../chat/messages/hostedSearch";
import type { ProviderId } from "../settings";
import { isRecord } from "./runtime/common";
import { supportsAdaptiveAnthropicThinking } from "./runtime/thinkingLevels";

export const HIDDEN_PROVIDER_NATIVE_WEB_SEARCH_TOOL_NAMES = [
  "WebSearch",
  "web_search",
  "builtin_web_search",
  "web_search_20250305",
  "web_search_20260209",
  "web_search_20260318",
  "web_search_preview",
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

// ---------------------------------------------------------------------------
// Anthropic web search tool version: model-aware adaptive upgrade.
// `dynamicFiltering` (20260318) is a superset of the 20260209 dynamic-filtering
// capability plus `response_inclusion` control, and is the version the official
// docs currently document/exemplify. Eligibility mirrors adaptive-thinking
// support (`compat.forceAdaptiveThinking`) since both track the same "modern
// Anthropic model" catalog boundary.
// ---------------------------------------------------------------------------

export const ANTHROPIC_WEB_SEARCH_TOOL_TYPES = {
  legacy: "web_search_20250305",
  dynamicFiltering: "web_search_20260318",
} as const;

export function supportsAnthropicDynamicFilteringWebSearch(model: Model<any>): boolean {
  return supportsAdaptiveAnthropicThinking(model);
}

export function resolveAnthropicWebSearchToolType(
  model: Model<any>,
): (typeof ANTHROPIC_WEB_SEARCH_TOOL_TYPES)[keyof typeof ANTHROPIC_WEB_SEARCH_TOOL_TYPES] {
  return supportsAnthropicDynamicFilteringWebSearch(model)
    ? ANTHROPIC_WEB_SEARCH_TOOL_TYPES.dynamicFiltering
    : ANTHROPIC_WEB_SEARCH_TOOL_TYPES.legacy;
}

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
    type === ANTHROPIC_WEB_SEARCH_TOOL_TYPES.legacy ||
    type === "web_search_20260209" ||
    type === ANTHROPIC_WEB_SEARCH_TOOL_TYPES.dynamicFiltering
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
