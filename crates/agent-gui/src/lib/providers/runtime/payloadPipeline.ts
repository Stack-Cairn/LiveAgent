import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { StreamDebugLogger } from "../../debug/agentDebug";
import type { PromptCacheHintMode, ProviderId } from "../../settings";
import {
  attachAnthropicMessagesNativeAttachments,
  attachGeminiGenerativeAINativeAttachments,
  attachOpenAICompletionsNativeAttachments,
  attachOpenAIResponsesNativeAttachments,
} from "../nativeResponsesAttachments";
import {
  composePayloadInterceptorChain,
  installDefaultPayloadInterceptors,
  type PayloadInterceptor,
} from "../service/interceptors";
import { attachAnthropicAutomaticCaching } from "./anthropicCache";
import { attachAnthropicLongContextBeta } from "./anthropicLongContext";
import { attachCodexPromptCacheHint } from "./codexPromptCache";
import { attachCodexResponsesStorage } from "./codexStorage";
import { attachDeepSeekResponsesPayloadCompat } from "./deepSeekResponsesPayload";
import { attachGeminiThoughtSignatureGuard } from "./geminiToolPayload";
import { attachProviderNativeWebSearch } from "./nativeSearchPayload";
import type { StreamOptionsEx } from "./types";
import { attachXaiResponsesPayloadCompat } from "./xaiResponsesPayload";

export type ProviderPayloadMiddleware = (
  options: StreamOptionsEx,
  params: FinalizeProviderStreamOptionsParams,
) => StreamOptionsEx;

export type FinalizeProviderStreamOptionsParams = {
  providerId: ProviderId;
  baseUrl: string;
  options: StreamOptionsEx;
  context?: Context;
  model?: Model<Api>;
  workdir?: string;
  nativeWebSearch?: boolean;
  promptCacheHintMode?: PromptCacheHintMode;
  debugLogger?: StreamDebugLogger;
  extra?: {
    phase?: string;
    round?: number;
    sessionId?: string;
  };
};

export function composePayloadMiddlewares(
  middlewares: ProviderPayloadMiddleware[],
): ProviderPayloadMiddleware {
  return (options, params) =>
    middlewares.reduce((next, middleware) => middleware(next, params), options);
}

export function attachPayloadDebugLogging(
  options: StreamOptionsEx,
  debugLogger?: StreamDebugLogger,
  extra?: {
    phase?: string;
    round?: number;
    sessionId?: string;
  },
): StreamOptionsEx {
  const previousOnPayload = options.onPayload;
  if (!debugLogger && !previousOnPayload) return options;

  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(payload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      debugLogger?.logRequest({
        phase: extra?.phase ?? "provider_payload",
        round: extra?.round,
        sessionId: extra?.sessionId,
        api: model.api,
        provider: model.provider,
        payload: nextPayload,
      });

      return nextPayload;
    },
  };
}

/**
 * 现有 10 个中间件的具名默认拦截器（PR-3 注册化）。顺序与注册化前的
 * finalizePayloadMiddlewares 数组逐项一致——顺序即协议正确性的一部分
 * （如 native attachments 必须先于 gemini thought guard），由顺序快照
 * 测试锁定。payload-debug-logging 是钉住的链尾：自定义拦截器插入在默认
 * 拦截器之后、它之前，保证自定义改动仍被调试日志观测到。
 */
const DEFAULT_PAYLOAD_INTERCEPTORS: readonly PayloadInterceptor[] = [
  {
    name: "anthropic-automatic-caching",
    intercept: (options, params) =>
      attachAnthropicAutomaticCaching(params.providerId, params.baseUrl, options),
  },
  {
    name: "anthropic-long-context-beta",
    intercept: (options, params) =>
      attachAnthropicLongContextBeta(options, {
        providerId: params.providerId,
        baseUrl: params.baseUrl,
        model: params.model,
        context: params.context,
      }),
  },
  {
    name: "codex-responses-storage",
    intercept: (options, params) => attachCodexResponsesStorage(params.providerId, options),
  },
  {
    name: "codex-prompt-cache-hint",
    intercept: (options, params) =>
      attachCodexPromptCacheHint(
        params.providerId,
        params.baseUrl,
        params.promptCacheHintMode,
        params.model,
        options,
      ),
  },
  {
    name: "provider-native-web-search",
    intercept: (options, params) =>
      attachProviderNativeWebSearch(params.providerId, options, params.nativeWebSearch, {
        baseUrl: params.baseUrl,
      }),
  },
  {
    name: "xai-responses-payload-compat",
    intercept: (options, params) =>
      attachXaiResponsesPayloadCompat(options, {
        providerId: params.providerId,
        baseUrl: params.baseUrl,
      }),
  },
  {
    name: "deepseek-responses-payload-compat",
    intercept: (options, params) =>
      attachDeepSeekResponsesPayloadCompat(options, {
        providerId: params.providerId,
        model: params.model,
        context: params.context,
      }),
  },
  {
    name: "native-attachments",
    intercept: (options, params) => {
      if (!params.context || !params.model) return options;
      let nextOptions = attachOpenAIResponsesNativeAttachments(options, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
      });
      nextOptions = attachOpenAICompletionsNativeAttachments(nextOptions, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
      });
      nextOptions = attachAnthropicMessagesNativeAttachments(nextOptions, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
      });
      return attachGeminiGenerativeAINativeAttachments(nextOptions, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
      });
    },
  },
  {
    name: "gemini-thought-signature-guard",
    intercept: (options, params) =>
      attachGeminiThoughtSignatureGuard(options, {
        providerId: params.providerId,
        baseUrl: params.baseUrl,
      }),
  },
  {
    name: "payload-debug-logging",
    intercept: (options, params) =>
      attachPayloadDebugLogging(options, params.debugLogger, params.extra),
  },
];

installDefaultPayloadInterceptors(DEFAULT_PAYLOAD_INTERCEPTORS);

export function finalizeProviderStreamOptions(
  params: FinalizeProviderStreamOptionsParams,
): StreamOptionsEx {
  return composePayloadInterceptorChain()(params.options, params);
}
