import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  type GoogleOptions,
  stream as streamGoogle,
} from "@earendil-works/pi-ai/api/google-generative-ai";
import {
  type OpenAICodexResponsesOptions,
  stream as streamOpenAICodexResponses,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import {
  type OpenAICompletionsOptions,
  stream as streamOpenAICompletions,
} from "@earendil-works/pi-ai/api/openai-completions";
import {
  type OpenAIResponsesOptions,
  stream as streamOpenAIResponses,
} from "@earendil-works/pi-ai/api/openai-responses";
import { installCodexWebSocketProxy } from "../runtime/codexWebSocketProxy";
import { resolveMaxTokens } from "../runtime/common";
import { streamCpaResponsesWithFallback } from "../runtime/cpaResponsesWebSocket";
import { rejectEmptyOpenAICompletionsResponse } from "../runtime/openAICompletionsStream";
import { withStreamRetry } from "../runtime/streamRetry";
import {
  clampOpenAIReasoningEffort,
  resolveAnthropicThinkingRuntime,
  resolveGeminiThinkingRuntime,
} from "../runtime/thinkingLevels";
import type {
  StreamOptionsEx,
  StreamTransportFallbackInfo,
  ToolChoice,
} from "../runtime/types";
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
    transport: options.transport,
    websocketConnectTimeoutMs: options.websocketConnectTimeoutMs,
  };
}

function findCodexWebSocketFallback(
  message: { diagnostics?: Array<{ type?: string; error?: { message?: string }; details?: Record<string, unknown> }> },
): StreamTransportFallbackInfo | undefined {
  const diagnostic = message.diagnostics?.find(
    (entry) =>
      entry.type === "provider_transport_failure" && entry.details?.fallbackTransport === "sse",
  );
  if (!diagnostic) return undefined;
  return {
    from: "websocket",
    to: "sse",
    // pi-ai 只在诊断里标记「已回退」，不区分握手失败与帧超限，故统一归为建连失败。
    reason: "handshake-failed",
    // Keep provider error bodies and credentials out of UI/trajectory diagnostics.
    errorMessage: "Codex WebSocket connection failed before content; SSE fallback is active",
  };
}

function withCodexFallbackNotification(
  source: AssistantMessageEventStream,
  callback: StreamOptionsEx["onTransportFallback"],
): AssistantMessageEventStream {
  if (!callback) return source;
  const output = createAssistantMessageEventStream();
  let notified = false;
  void (async () => {
    for await (const event of source) {
      if (!notified) {
        const message =
          event.type === "start"
            ? event.partial
            : event.type === "done"
              ? event.message
              : event.type === "error"
                ? event.error
                : undefined;
        const fallback = message ? findCodexWebSocketFallback(message) : undefined;
        if (fallback) {
          notified = true;
          try {
            callback(fallback);
          } catch (error) {
            console.warn("Codex WebSocket fallback observer failed; continuing with SSE", error);
          }
        }
      }
      output.push(event);
    }
    output.end(await source.result());
  })().catch((error) => {
    console.warn("Codex WebSocket fallback observer stream failed", error);
    void source.result().then((message) => output.end(message));
  });
  return output;
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

function hasChatGptCodexCredential(apiKey: string | undefined): boolean {
  const parts = apiKey?.trim().split(".") ?? [];
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1])) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    return Boolean(auth && typeof auth === "object" && "chatgpt_account_id" in auth);
  } catch {
    return false;
  }
}

function isChatGptCodexEndpoint(model: Model<Api>, options: StreamOptionsEx): boolean {
  const configuredOrigin = Object.entries(options.headers ?? {}).find(
    ([key]) => key.toLowerCase() === "x-liveagent-upstream-origin",
  )?.[1];
  try {
    const hostname = new URL(configuredOrigin || model.baseUrl).hostname.toLowerCase();
    return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com");
  } catch {
    return false;
  }
}

function toCodexTransportModel(model: Model<Api>): Model<"openai-codex-responses"> {
  const baseUrl = model.baseUrl.replace(/\/v1\/?$/i, "");
  return {
    ...model,
    api: "openai-codex-responses",
    baseUrl,
  } as Model<"openai-codex-responses">;
}

/**
 * WebSocket 通路选择。开关只表达「愿意用 WS」，走哪条通路由端点与凭证形态决定：
 *
 * - `chatgpt-codex`：官方 chatgpt.com + 带 chatgpt_account_id 的 JWT，走 pi-ai 的
 *   Codex transport（拼 /codex/responses、注入 chatgpt-account-id）。
 * - `cpa-responses`：其余 Responses 端点（CPA / 自建 / OpenAI 兼容），普通 Bearer
 *   Key，走本仓库的 CPA transport（同路径 GET 升级到 /v1/responses）。
 *
 * 关键：这两个判据是**分支依据**而不是准入依据。此前把它们当准入用，导致所有非
 * chatgpt.com 端点在资格检查阶段就被排除，压根没发起过连接。
 */
type ResponsesWebSocketRoute = "chatgpt-codex" | "cpa-responses";

function resolveResponsesWebSocketRoute(
  model: Model<Api>,
  options: StreamOptionsEx,
): ResponsesWebSocketRoute {
  return isChatGptCodexEndpoint(model, options) && hasChatGptCodexCredential(options.apiKey)
    ? "chatgpt-codex"
    : "cpa-responses";
}

function streamOpenAIResponsesApi(model: Model<Api>, context: Context, options: StreamOptionsEx) {
  const openAIOptions: OpenAIResponsesOptions = {
    ...buildOpenAIBaseOptions(model, options),
    reasoningEffort: clampOpenAIReasoningEffort(model, options.reasoning),
  };
  const codexOptions: OpenAICodexResponsesOptions = {
    ...buildOpenAIBaseOptions(model, options),
    reasoningEffort: clampOpenAIReasoningEffort(model, options.reasoning),
  };
  const streamSse = () =>
    streamOpenAIResponses(model as Model<"openai-responses">, context, openAIOptions);
  const websocketRequested = model.provider === "openai" && options.transport === "auto";
  if (!websocketRequested) {
    return withStreamRetry(streamSse, { signal: options.signal, ...options.streamRetry });
  }

  const route = resolveResponsesWebSocketRoute(model, options);
  if (route === "chatgpt-codex") {
    installCodexWebSocketProxy();
    return withStreamRetry(
      () =>
        withCodexFallbackNotification(
          streamOpenAICodexResponses(toCodexTransportModel(model), context, codexOptions),
          options.onTransportFallback,
        ),
      { signal: options.signal, ...options.streamRetry },
    );
  }

  // CPA / 自建 Responses 端点：WS 升级打在与 SSE 相同的路径上（GET vs POST），
  // 凭证是普通 Bearer Key。首个内容产生前失败时由该 transport 自己回退 SSE。
  return withStreamRetry(
    () =>
      streamCpaResponsesWithFallback(
        model,
        context,
        { ...openAIOptions, onTransportFallback: options.onTransportFallback },
        streamSse,
      ),
    { signal: options.signal, ...options.streamRetry },
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
