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
import { wrapDeepSeekDsmlToolCallStream } from "../deepSeekDsmlToolCallStream";
import {
  attachDeepSeekProviderPayloadAdapter,
  isDeepSeekAnthropicTarget,
  isDeepSeekTarget,
  mapDeepSeekReasoningEffort,
} from "../deepSeekProviderAdapter";
import { resolveMaxTokens } from "./common";
import { recoverOpenAICompletionsMissingFinishReason } from "./openAICompletionsStream";
import { withStreamRetry } from "./streamRetry";
import { normalizeStructuredToolCallHistoryForDeepSeek } from "./textModeToolRecovery";
import {
  type AnthropicEffort,
  type AnthropicThinkingRuntime,
  clampOpenAIReasoningEffort,
  resolveAnthropicThinkingRuntime,
  resolveGeminiThinkingRuntime,
} from "./thinkingLevels";
import type { StreamOptionsEx, ToolChoice } from "./types";

function resolveDeepSeekAnthropicThinkingRuntime(
  model: Model<any>,
  options: StreamOptionsEx,
): AnthropicThinkingRuntime {
  const effort = mapDeepSeekReasoningEffort(options.reasoning) as AnthropicEffort | undefined;
  return {
    thinkingEnabled: Boolean(effort),
    mode: effort ? "adaptive" : "disabled",
    maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
    ...(effort ? { effort } : {}),
  };
}

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
  // 多 Key 故障转移：当次尝试的 apiKey/headers 由 attemptAuth holder 提供，
  // withStreamRetry 在重试前 rotate；缺省时回退到 options.apiKey/options.headers。
  const auth = options.attemptAuth;
  return {
    temperature: options.temperature,
    maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
    signal: options.signal,
    apiKey: auth?.apiKey ?? options.apiKey,
    cacheRetention: options.cacheRetention,
    sessionId: options.sessionId,
    headers: auth?.headers ?? options.headers,
    onPayload: options.onPayload,
    maxRetryDelayMs: options.maxRetryDelayMs,
    metadata: options.metadata,
  };
}

/**
 * 鉴权头名：与 proxy.ts 的 UPSTREAM_HEADER_OVERRIDE_EXCLUDED_KEYS 同源——这些头
 * 不进覆盖包、由 SDK/常规通道下发，故障转移时按 Key 重建即可替换。
 */
const PROVIDER_AUTH_HEADER_KEYS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
]);

/** 当次尝试的鉴权凭据：优先 attemptAuth holder（故障转移会 rotate），回退 options。 */
function resolveAttemptApiKey(options: StreamOptionsEx): string | undefined {
  return options.attemptAuth?.apiKey ?? options.apiKey;
}
/**
 * 当次尝试的 headers：保留 options.headers 里的代理路由/会话/自定义头，
 * 仅把鉴权头（authorization/x-api-key/x-goog-api-key）替换为 attemptAuth 里的当次 Key 版本。
 * 未配置 attemptAuth 时回退到 options.headers（兼容单 Key 旧链路）。
 */
function resolveAttemptHeaders(options: StreamOptionsEx): Record<string, string> | undefined {
  const authHeaders = options.attemptAuth?.headers;
  if (!authHeaders) return options.headers as Record<string, string> | undefined;
  const base = (options.headers ?? {}) as Record<string, string>;
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!PROVIDER_AUTH_HEADER_KEYS.has(key.toLowerCase())) merged[key] = value;
  }
  for (const [key, value] of Object.entries(authHeaders)) {
    if (PROVIDER_AUTH_HEADER_KEYS.has(key.toLowerCase())) merged[key] = value;
  }
  return merged;
}

export function streamSimpleByApi(model: Model<any>, context: Context, options: StreamOptionsEx) {
  switch (model.api) {
    case "anthropic-messages": {
      // Anthropic：需要我们自己调用 streamAnthropic()，以便显式传 toolChoice（以及启用/禁用 thinking）。
      const isDeepSeekAnthropic =
        Boolean(options.deepSeekProviderAdapter || options.deepSeekDsmlToolCallRepair) ||
        isDeepSeekAnthropicTarget({
          api: model.api,
          baseUrl: model.baseUrl,
          modelId: model.id,
        });
      const anthropicThinking = isDeepSeekAnthropic
        ? resolveDeepSeekAnthropicThinkingRuntime(model, options)
        : resolveAnthropicThinkingRuntime(model, options);
      const anthropicOptions = isDeepSeekAnthropic
        ? attachDeepSeekProviderPayloadAdapter(options, {
            providerId: "claude_code",
            baseUrl: model.baseUrl,
            model,
          })
        : options;
      const anthropicContext = isDeepSeekAnthropic
        ? normalizeStructuredToolCallHistoryForDeepSeek(context)
        : context;
      return withStreamRetry(
        () => {
          const stream = streamAnthropic(model as any, anthropicContext, {
            temperature: anthropicOptions.temperature,
            maxTokens: anthropicThinking.maxTokens,
            signal: anthropicOptions.signal,
            // 故障转移：每次 factory() 调用都重新读取当次 Key/headers。
            apiKey: resolveAttemptApiKey(anthropicOptions),
            cacheRetention: anthropicOptions.cacheRetention,
            sessionId: anthropicOptions.sessionId,
            headers: resolveAttemptHeaders(anthropicOptions),
            onPayload: anthropicOptions.onPayload,
            maxRetryDelayMs: anthropicOptions.maxRetryDelayMs,
            metadata: anthropicOptions.metadata,
            thinkingEnabled: anthropicThinking.thinkingEnabled,
            ...(anthropicThinking.effort ? { effort: anthropicThinking.effort } : {}),
            ...(anthropicThinking.thinkingBudgetTokens !== undefined
              ? { thinkingBudgetTokens: anthropicThinking.thinkingBudgetTokens }
              : {}),
            toolChoice: anthropicOptions.toolChoice ?? "none",
          });
          return isDeepSeekAnthropic || anthropicOptions.deepSeekDsmlToolCallRepair
            ? wrapDeepSeekDsmlToolCallStream(stream)
            : stream;
        },
        { signal: anthropicOptions.signal, ...anthropicOptions.streamRetry },
      );
    }
    case "openai-completions": {
      const openAICompletionsOptions = isDeepSeekTarget({
        baseUrl: model.baseUrl,
        modelId: model.id,
      })
        ? attachDeepSeekProviderPayloadAdapter(options, {
            providerId: "codex",
            baseUrl: model.baseUrl,
            model,
          })
        : options;
      const openAICompletionsContext = openAICompletionsOptions.deepSeekProviderAdapter
        ? normalizeStructuredToolCallHistoryForDeepSeek(context)
        : context;
      // 严格校验的 OpenAI 兼容端点（xAI/各类中转网关）对「带 tool_choice 但没带
      // tools」的请求直接 400（"A tool_choice was set on the request but no tools
      // were specified"）——compaction 摘要、标题生成等 text-only 请求没有工具，
      // 会踩中。tool_choice 在无工具时本就无意义，只在请求真正携带 tools 时下发。
      return withStreamRetry(
        () => {
          // 故障转移：每次 factory() 调用都重新构建 options，读取当次 Key/headers。
          const openAIOptions: OpenAICompletionsOptions = {
            ...buildOpenAIBaseOptions(model, openAICompletionsOptions),
            reasoningEffort: clampOpenAIReasoningEffort(model, openAICompletionsOptions.reasoning),
            toolChoice: openAICompletionsContext.tools?.length
              ? mapToolChoiceToOpenAI(openAICompletionsOptions.toolChoice)
              : undefined,
          };
          const source = streamOpenAICompletions(
            model as any,
            openAICompletionsContext,
            openAIOptions,
          );
          return openAICompletionsOptions.recoverMissingFinishReason
            ? recoverOpenAICompletionsMissingFinishReason(source)
            : source;
        },
        { signal: openAICompletionsOptions.signal, ...openAICompletionsOptions.streamRetry },
      );
    }
    case "openai-responses": {
      return withStreamRetry(
        () => {
          const openAIOptions: OpenAIResponsesOptions = {
            ...buildOpenAIBaseOptions(model, options),
            reasoningEffort: clampOpenAIReasoningEffort(model, options.reasoning),
          };
          return streamOpenAIResponses(model as any, context, openAIOptions);
        },
        { signal: options.signal, ...options.streamRetry },
      );
    }
    case "google-generative-ai": {
      return withStreamRetry(
        () => {
          const googleOptions: GoogleOptions = {
            temperature: options.temperature,
            maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
            signal: options.signal,
            apiKey: resolveAttemptApiKey(options),
            headers: resolveAttemptHeaders(options),
            onPayload: options.onPayload,
            maxRetryDelayMs: options.maxRetryDelayMs,
            metadata: options.metadata,
            thinking: resolveGeminiThinkingRuntime(model, options.reasoning),
            toolChoice: mapToolChoiceToGoogle(options.toolChoice) ?? "none",
          };
          return streamGoogle(model as any, context, googleOptions);
        },
        { signal: options.signal, ...options.streamRetry },
      );
    }
    default:
      throw new Error(`Unsupported model API: ${model.api}`);
  }
}
