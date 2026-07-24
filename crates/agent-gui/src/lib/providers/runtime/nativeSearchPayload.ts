import type { Model } from "@earendil-works/pi-ai";
import type { ProviderId } from "../../settings";
import {
  hasAnthropicWebSearchTool,
  hasOpenAIResponsesWebSearchTool,
  providerSupportsNativeWebSearch,
  resolveAnthropicWebSearchToolType,
} from "../nativeWebSearch";
import { isRecord } from "./common";
import { appendGeminiGoogleSearchToolToPayload } from "./geminiToolPayload";
import type { StreamOptionsEx } from "./types";

function isOfficialOpenAIBaseUrl(baseUrl: string | undefined) {
  if (!baseUrl?.trim()) return false;
  try {
    const url = new URL(baseUrl);
    return url.hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function hasOpenAIChatCompletionsWebSearchOptions(payload: Record<string, unknown>) {
  return isRecord(payload.web_search_options);
}

function appendUniqueTool(
  payload: Record<string, unknown>,
  tool: Record<string, unknown>,
  matches: (tool: unknown) => boolean,
) {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (tools.some(matches)) return payload;
  return {
    ...payload,
    tools: [...tools, tool],
  };
}

function appendOpenAIChatCompletionsWebSearchOptions(payload: Record<string, unknown>) {
  if (hasOpenAIChatCompletionsWebSearchOptions(payload)) return payload;
  return {
    ...payload,
    web_search_options: {
      search_context_size: "medium",
    },
  };
}

function hasOpenAIChatCompletionsWebSearchFunctionTool(tool: unknown) {
  if (!isRecord(tool) || tool.type !== "function") return false;
  const fn = isRecord(tool.function) ? tool.function : {};
  const name = typeof fn.name === "string" ? fn.name.trim().toLowerCase() : "";
  return name === "web_search" || name === "web_search_preview";
}

function hasOpenAIChatCompletionsNativeWebSearchTool(tool: unknown) {
  return (
    hasOpenAIResponsesWebSearchTool(tool) || hasOpenAIChatCompletionsWebSearchFunctionTool(tool)
  );
}

function buildOpenAIChatCompletionsWebSearchFunctionTool() {
  return {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for current information when the answer needs recent or external context.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The web search query.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  };
}

function supportsOpenAIChatCompletionsWebSearchOptions(params: {
  baseUrl?: string;
  modelId: string;
}) {
  return (
    isOfficialOpenAIBaseUrl(params.baseUrl) &&
    params.modelId.trim().toLowerCase().includes("search-preview")
  );
}

function appendOpenAIChatCompletionsNativeWebSearch(
  payload: Record<string, unknown>,
  params: {
    baseUrl?: string;
    model: Model<any>;
  },
) {
  if (
    supportsOpenAIChatCompletionsWebSearchOptions({
      baseUrl: params.baseUrl,
      modelId: params.model.id,
    })
  ) {
    return appendOpenAIChatCompletionsWebSearchOptions(payload);
  }

  return appendUniqueTool(
    payload,
    buildOpenAIChatCompletionsWebSearchFunctionTool(),
    hasOpenAIChatCompletionsNativeWebSearchTool,
  );
}

function isOpenAIWebSearchMinimalReasoningUnsupportedModel(modelId: string) {
  const normalized = modelId.trim().toLowerCase();
  return normalized === "gpt-5" || normalized.startsWith("gpt-5-");
}

function normalizeOpenAIWebSearchReasoning(payload: Record<string, unknown>, model: Model<any>) {
  if (!isOpenAIWebSearchMinimalReasoningUnsupportedModel(model.id)) return payload;
  if (!isRecord(payload.reasoning) || payload.reasoning.effort !== "minimal") return payload;
  return {
    ...payload,
    reasoning: {
      ...payload.reasoning,
      effort: "low",
    },
  };
}

export function attachProviderNativeWebSearch(
  providerId: ProviderId,
  options: StreamOptionsEx,
  enabled?: boolean,
  params?: {
    baseUrl?: string;
  },
): StreamOptionsEx {
  if (!enabled) return options;

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;

      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      if (
        !isRecord(nextPayload) ||
        !providerSupportsNativeWebSearch(providerId, model.api, {
          baseUrl: params?.baseUrl,
          modelId: model.id,
        })
      ) {
        return nextPayload;
      }

      if (providerId === "codex" || providerId === "xai") {
        if (model.api === "openai-completions") {
          return appendOpenAIChatCompletionsNativeWebSearch(nextPayload, {
            baseUrl: params?.baseUrl,
            model,
          });
        }

        return appendUniqueTool(
          normalizeOpenAIWebSearchReasoning(nextPayload, model),
          { type: "web_search" },
          hasOpenAIResponsesWebSearchTool,
        );
      }

      if (providerId === "claude_code") {
        return appendUniqueTool(
          nextPayload,
          { type: resolveAnthropicWebSearchToolType(model), name: "web_search" },
          hasAnthropicWebSearchTool,
        );
      }

      if (providerId === "gemini") {
        return appendGeminiGoogleSearchToolToPayload(nextPayload, {
          modelId: model.id,
          baseUrl: params?.baseUrl,
        });
      }

      return nextPayload;
    },
  };
}
