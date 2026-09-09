import {
  type ChatRuntimeControls,
  type CustomProvider,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  normalizeChatRuntimeControlsForProvider,
  resolveProviderChatRoute,
} from "../../settings";
import type { ProviderRuntimeConfig } from "./types";

/**
 * ProviderRuntimeConfig 的唯一构造点——全仓仅此一处注入品牌。任何调用方都只能
 * 拿到完整对象并整体传递（需要改档位等请用展开派生），不得再逐字段转抄。
 */
export function createProviderRuntimeConfig(
  provider: CustomProvider,
  model: string,
  controlsInput: ChatRuntimeControls | undefined,
): ProviderRuntimeConfig {
  const modelConfig = findProviderModelConfig(provider, model);
  const route = resolveProviderChatRoute(provider, model);
  const reasoningParams = {
    providerId: route.adapterProviderId,
    requestFormat: route.requestFormat,
    modelId: model,
  };
  const controls = normalizeChatRuntimeControlsForProvider(controlsInput, reasoningParams);
  const reasoningSupported = getChatRuntimeReasoningLevelsForProvider(reasoningParams).length > 0;
  return {
    baseUrl: route.baseUrl,
    isFullUrl: route.isFullUrl,
    adapterProviderId: route.adapterProviderId,
    chatProtocol: route.protocol,
    apiKey: provider.apiKey,
    customHeaders: provider.customHeaders,
    requestFormat: route.requestFormat,
    reasoning: reasoningSupported
      ? controls.thinkingEnabled
        ? controls.reasoning
        : "off"
      : undefined,
    promptCachingEnabled: provider.promptCachingEnabled,
    promptCacheHintMode: provider.promptCacheHintMode,
    promptCacheRetention: provider.promptCacheRetention,
    nativeWebSearchEnabled: controls.nativeWebSearchEnabled,
    useSystemProxy: provider.useSystemProxy,
    ...(provider.retryPolicy ? { retryPolicy: provider.retryPolicy } : {}),
    modelConfig,
  } as ProviderRuntimeConfig;
}
