import {
  providerSupportsNativeWebSearch,
  resolveProviderApi,
} from "@liveagent/ui/lib/providers/providerCapabilities";
import {
  type ChatRuntimeControls,
  type CustomProvider,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  normalizeChatRuntimeControlsForProvider,
} from "../../settings";
import type { ProviderRuntimeBackend, ProviderRuntimeConfig } from "./types";

export function getProviderRuntimeBackend(): ProviderRuntimeBackend {
  return "kbrain";
}

/**
 * ProviderRuntimeConfig 的唯一构造点——全仓仅此一处注入品牌。任何调用方都只能
 * 拿到完整对象并整体传递（需要改档位等请用展开派生），不得再逐字段转抄。
 */
export function createProviderRuntimeConfig(
  provider: CustomProvider,
  model: string,
  controlsInput: ChatRuntimeControls | undefined,
): ProviderRuntimeConfig {
  const reasoningParams = {
    providerId: provider.type,
    requestFormat: provider.requestFormat,
    modelId: model,
  };
  const controls = normalizeChatRuntimeControlsForProvider(controlsInput, reasoningParams);
  const reasoningSupported = getChatRuntimeReasoningLevelsForProvider(reasoningParams).length > 0;
  const backend = getProviderRuntimeBackend();
  return {
    backend,
    // K-brain owns upstream routing and credentials, including header/query secrets.
    backendModelProvider: provider.id,
    baseUrl: "",
    isFullUrl: false,
    apiKey: "",
    customHeaders: undefined,
    requestFormat: provider.requestFormat,
    reasoning: reasoningSupported
      ? controls.thinkingEnabled
        ? controls.reasoning
        : "off"
      : undefined,
    promptCachingEnabled: provider.promptCachingEnabled,
    promptCacheHintMode: provider.promptCacheHintMode,
    promptCacheRetention: provider.promptCacheRetention,
    nativeWebSearchEnabled:
      controls.nativeWebSearchEnabled &&
      providerSupportsNativeWebSearch(
        provider.type,
        resolveProviderApi(provider.type, provider.requestFormat),
      ),
    useSystemProxy: provider.useSystemProxy,
    ...(provider.retryPolicy ? { retryPolicy: provider.retryPolicy } : {}),
    modelConfig: findProviderModelConfig(provider, model),
  } as ProviderRuntimeConfig;
}
