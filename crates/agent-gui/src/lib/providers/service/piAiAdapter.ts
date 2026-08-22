import type { Api, Context, Model } from "@earendil-works/pi-ai";
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
import { resolveMaxTokens } from "../runtime/common";
import { rejectEmptyOpenAICompletionsResponse } from "../runtime/openAICompletionsStream";
import { withStreamRetry } from "../runtime/streamRetry";
import {
  clampOpenAIReasoningEffort,
  resolveAnthropicThinkingRuntime,
  resolveGeminiThinkingRuntime,
} from "../runtime/thinkingLevels";
import type { StreamOptionsEx, ToolChoice } from "../runtime/types";
import type { LlmAdapter } from "./types";

// ============================================================================
// pi-ai 四协议适配器。
//
// 各分支为 streamByApi.ts 原实现的原样搬移（PR-1 行为等价不变量）：分支内的
// withStreamRetry 包装位置、toolChoice 映射、thinking runtime 解析、注释
// 一并保留，不做任何重写。判定基准是 PR-0 golden 快照零修改通过。
// ============================================================================

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

function buildOpenAIBaseOptions(model: Model<Api>, options: StreamOptionsEx) {
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

function streamAnthropicMessages(model: Model<Api>, context: Context, options: StreamOptionsEx) {
  // Anthropic：需要我们自己调用 streamAnthropic()，以便显式传 toolChoice（以及启用/禁用 thinking）。
  const anthropicThinking = resolveAnthropicThinkingRuntime(model, options);
  // Anthropic 拒绝 extended thinking 与强制工具（"any"/{type:"tool"}）同请求
  // （400）。降级为 auto：有界强制的调用方（plan mode 补提交轮）同时注入了
  // 消息级提醒，语义仍然成立；直接 400 反而会进重试/failover 循环。
  const requestedToolChoice = options.toolChoice ?? "none";
  const anthropicToolChoice =
    anthropicThinking.thinkingEnabled &&
    requestedToolChoice !== "none" &&
    requestedToolChoice !== "auto"
      ? "auto"
      : requestedToolChoice;
  return withStreamRetry(
    () => {
      return streamAnthropic(model as Model<"anthropic-messages">, context, {
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
        toolChoice: anthropicToolChoice,
      });
    },
    { signal: options.signal, ...options.streamRetry },
  );
}

function streamOpenAICompletionsApi(model: Model<Api>, context: Context, options: StreamOptionsEx) {
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
        streamOpenAICompletions(model as Model<"openai-completions">, context, openAIOptions),
      );
    },
    { signal: options.signal, ...options.streamRetry },
  );
}

function streamOpenAIResponsesApi(model: Model<Api>, context: Context, options: StreamOptionsEx) {
  const openAIOptions: OpenAIResponsesOptions = {
    ...buildOpenAIBaseOptions(model, options),
    reasoningEffort: clampOpenAIReasoningEffort(model, options.reasoning),
  };
  return withStreamRetry(
    () => streamOpenAIResponses(model as Model<"openai-responses">, context, openAIOptions),
    {
      signal: options.signal,
      ...options.streamRetry,
    },
  );
}

function streamGoogleGenerativeAi(model: Model<Api>, context: Context, options: StreamOptionsEx) {
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
  return withStreamRetry(
    () => streamGoogle(model as Model<"google-generative-ai">, context, googleOptions),
    {
      signal: options.signal,
      ...options.streamRetry,
    },
  );
}

export const piAiAdapter: LlmAdapter = {
  apis: [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "google-generative-ai",
  ] as const,
  stream(model, context, options) {
    switch (model.api) {
      case "anthropic-messages":
        return streamAnthropicMessages(model, context, options);
      case "openai-completions":
        return streamOpenAICompletionsApi(model, context, options);
      case "openai-responses":
        return streamOpenAIResponsesApi(model, context, options);
      case "google-generative-ai":
        return streamGoogleGenerativeAi(model, context, options);
      default:
        // 注册表按 apis 路由到这里，正常不可达；防御分支保持同一错误文案。
        throw new Error(`Unsupported model API: ${model.api}`);
    }
  },
};
