import type { Context, Model } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  type GoogleOptions,
  stream as streamGoogle,
} from "@earendil-works/pi-ai/api/google-generative-ai";
import {
  type OpenAICompletionsOptions,
  stream as streamOpenAICompletions,
} from "@earendil-works/pi-ai/api/openai-completions";
import {
  type OpenAIResponsesOptions,
  stream as streamOpenAIResponses,
} from "@earendil-works/pi-ai/api/openai-responses";
import { DEEPSEEK_CHAT_COMPLETIONS_API, streamDeepSeekNative } from "../deepSeekNative";
import { resolveMaxTokens } from "./common";
import { rejectEmptyOpenAICompletionsResponse } from "./openAICompletionsStream";
import { withStreamRetry } from "./streamRetry";
import {
  clampOpenAIReasoningEffort,
  resolveAnthropicThinkingRuntime,
  resolveGeminiThinkingRuntime,
} from "./thinkingLevels";
import type { StreamOptionsEx, ToolChoice } from "./types";

function mapToolChoiceToOpenAI(
  toolChoice: ToolChoice | undefined,
): OpenAICompletionsOptions["toolChoice"] | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "any") return "required";
  if (toolChoice === "auto" || toolChoice === "none") return toolChoice;
  return {
    type: "function",
    function: {
      name: toolChoice.name,
    },
  };
}

function mapToolChoiceToGoogle(
  toolChoice: ToolChoice | undefined,
): GoogleOptions["toolChoice"] | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "any") {
    return toolChoice;
  }
  return "auto";
}

function buildOpenAIBaseOptions(model: Model<any>, options: StreamOptionsEx) {
  return {
    temperature: options.temperature,
    maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
    signal: options.signal,
    apiKey: options.apiKey,
    cacheRetention: options.cacheRetention,
    sessionId: options.sessionId,
    headers: options.headers,
    onPayload: options.onPayload,
    maxRetryDelayMs: options.maxRetryDelayMs,
    metadata: options.metadata,
  };
}

export function streamSimpleByApi(model: Model<any>, context: Context, options: StreamOptionsEx) {
  switch (model.api) {
    case "anthropic-messages": {
      // Anthropic：需要我们自己调用 streamAnthropic()，以便显式传 toolChoice（以及启用/禁用 thinking）。
      const anthropicThinking = resolveAnthropicThinkingRuntime(model, options);
      return withStreamRetry(
        () => {
          return streamAnthropic(model as any, context, {
            temperature: options.temperature,
            maxTokens: anthropicThinking.maxTokens,
            signal: options.signal,
            apiKey: options.apiKey,
            cacheRetention: options.cacheRetention,
            sessionId: options.sessionId,
            headers: options.headers,
            onPayload: options.onPayload,
            maxRetryDelayMs: options.maxRetryDelayMs,
            metadata: options.metadata,
            thinkingEnabled: anthropicThinking.thinkingEnabled,
            ...(anthropicThinking.effort ? { effort: anthropicThinking.effort } : {}),
            ...(anthropicThinking.thinkingBudgetTokens !== undefined
              ? { thinkingBudgetTokens: anthropicThinking.thinkingBudgetTokens }
              : {}),
            toolChoice: options.toolChoice ?? "none",
          });
        },
        { signal: options.signal, ...options.streamRetry },
      );
    }
    case "openai-completions": {
      // 严格校验的 OpenAI 兼容端点（xAI/各类中转网关）对「带 tool_choice 但没带
      // tools」的请求直接 400（"A tool_choice was set on the request but no tools
      // were specified"）——compaction 摘要、标题生成等 text-only 请求没有工具，
      // 会踩中。tool_choice 在无工具时本就无意义，只在请求真正携带 tools 时下发。
      const openAIOptions: OpenAICompletionsOptions = {
        ...buildOpenAIBaseOptions(model, options),
        reasoningEffort: clampOpenAIReasoningEffort(model, options.reasoning),
        toolChoice: context.tools?.length ? mapToolChoiceToOpenAI(options.toolChoice) : undefined,
      };
      return withStreamRetry(
        () => {
          return rejectEmptyOpenAICompletionsResponse(
            streamOpenAICompletions(model as any, context, openAIOptions),
          );
        },
        { signal: options.signal, ...options.streamRetry },
      );
    }
    case DEEPSEEK_CHAT_COMPLETIONS_API:
      return withStreamRetry(() => streamDeepSeekNative(model, context, options), {
        signal: options.signal,
        ...options.streamRetry,
      });
    case "openai-responses": {
      const openAIOptions: OpenAIResponsesOptions = {
        ...buildOpenAIBaseOptions(model, options),
        reasoningEffort: clampOpenAIReasoningEffort(model, options.reasoning),
      };
      return withStreamRetry(() => streamOpenAIResponses(model as any, context, openAIOptions), {
        signal: options.signal,
        ...options.streamRetry,
      });
    }
    case "google-generative-ai": {
      const googleOptions: GoogleOptions = {
        temperature: options.temperature,
        maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
        signal: options.signal,
        apiKey: options.apiKey,
        headers: options.headers,
        onPayload: options.onPayload,
        maxRetryDelayMs: options.maxRetryDelayMs,
        metadata: options.metadata,
        thinking: resolveGeminiThinkingRuntime(model, options.reasoning),
        toolChoice: mapToolChoiceToGoogle(options.toolChoice) ?? "none",
      };
      return withStreamRetry(() => streamGoogle(model as any, context, googleOptions), {
        signal: options.signal,
        ...options.streamRetry,
      });
    }
    default:
      throw new Error(`Unsupported model API: ${model.api}`);
  }
}
