import type { Context, Model } from "@earendil-works/pi-ai";
import type { StreamDebugLogger } from "../../debug/agentDebug";
import type { ProviderId } from "../../settings";
import { attachDeepSeekProviderPayloadAdapter } from "../deepSeekProviderAdapter";
import {
  attachAnthropicMessagesNativeAttachments,
  attachGeminiGenerativeAINativeAttachments,
  attachOpenAICompletionsNativeAttachments,
  attachOpenAIResponsesNativeAttachments,
} from "../nativeResponsesAttachments";
import { attachAnthropicAutomaticCaching } from "./anthropicCache";
import { attachAnthropicLongContextBeta } from "./anthropicLongContext";
import { attachCodexPromptCacheKey } from "./codexPromptCache";
import { attachCodexResponsesStorage } from "./codexStorage";
import { attachGeminiThoughtSignatureGuard } from "./geminiToolPayload";
import { attachProviderNativeWebSearch } from "./nativeSearchPayload";
import { attachOpenAICompletionsFinishReasonCompatibility } from "./openAICompletionsStream";
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
  (options, params) => attachCodexPromptCacheKey(params.providerId, options),
  (options, params) =>
    attachOpenAICompletionsFinishReasonCompatibility(options, {
      providerId: params.providerId,
      baseUrl: params.baseUrl,
      modelApi: params.model?.api,
    }),
  (options, params) =>
    attachProviderNativeWebSearch(params.providerId, options, params.nativeWebSearch, {
      baseUrl: params.baseUrl,
    }),
  (options, params) =>
    attachXaiResponsesPayloadCompat(options, {
      providerId: params.providerId,
      baseUrl: params.baseUrl,
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
    attachDeepSeekProviderPayloadAdapter(options, {
      providerId: params.providerId,
      baseUrl: params.baseUrl,
      model: params.model,
    }),
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
