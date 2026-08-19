import type { Context, Model } from "@earendil-works/pi-ai";
import type { StreamDebugLogger } from "../../debug/agentDebug";
import type { PromptCacheHintMode, ProviderId } from "../../settings";
import {
  attachAnthropicMessagesNativeAttachments,
  attachGeminiGenerativeAINativeAttachments,
  attachOpenAICompletionsNativeAttachments,
  attachOpenAIResponsesNativeAttachments,
} from "../nativeResponsesAttachments";
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
  model?: Model<any>;
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

const finalizePayloadMiddlewares = composePayloadMiddlewares([
  (options, params) => attachAnthropicAutomaticCaching(params.providerId, params.baseUrl, options),
  (options, params) =>
    attachAnthropicLongContextBeta(options, {
      providerId: params.providerId,
      baseUrl: params.baseUrl,
      model: params.model,
      context: params.context,
    }),
  (options, params) => attachCodexResponsesStorage(params.providerId, options),
  (options, params) =>
    attachCodexPromptCacheHint(
      params.providerId,
      params.baseUrl,
      params.promptCacheHintMode,
      params.model,
      options,
    ),
  (options, params) =>
    attachProviderNativeWebSearch(params.providerId, options, params.nativeWebSearch, {
      baseUrl: params.baseUrl,
    }),
  (options, params) =>
    attachXaiResponsesPayloadCompat(options, {
      providerId: params.providerId,
      baseUrl: params.baseUrl,
    }),
  (options, params) =>
    attachDeepSeekResponsesPayloadCompat(options, {
      providerId: params.providerId,
      model: params.model,
      context: params.context,
    }),
  (options, params) => {
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
  (options, params) =>
    attachGeminiThoughtSignatureGuard(options, {
      providerId: params.providerId,
      baseUrl: params.baseUrl,
    }),
  (options, params) => attachPayloadDebugLogging(options, params.debugLogger, params.extra),
]);

export function finalizeProviderStreamOptions(
  params: FinalizeProviderStreamOptionsParams,
): StreamOptionsEx {
  return finalizePayloadMiddlewares(params.options, params);
}
