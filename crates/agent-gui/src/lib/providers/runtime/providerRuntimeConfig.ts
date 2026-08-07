import {
  type ChatRuntimeControls,
  type CustomProvider,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  normalizeChatRuntimeControlsForProvider,
} from "../../settings";
import type { ProviderRuntimeConfig } from "./types";

/**
 * ProviderRuntimeConfig 的唯一构造点——全仓仅此一处注入品牌。任何调用方都只能
 * 拿到完整对象并整体传递（需要改档位等请用展开派生），不得再逐字段转抄。
 */

/** 故障转移候选 Key 列表：主 Key 在前，请求失败（限额/鉴权）时逐一切换。 */
function resolveProviderApiKeys(provider: CustomProvider): string[] {
  if (Array.isArray(provider.apiKeys)) {
    const keys = provider.apiKeys
      .map((key) => (typeof key === "string" ? key.trim() : ""))
      .filter(Boolean);
    if (keys.length > 0) return keys;
  }
  return provider.apiKey.trim() ? [provider.apiKey.trim()] : [];
}

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
  const apiKeys = resolveProviderApiKeys(provider);
  // 主 Key 优先：apiKey 恒为首项，单 Key 链路（用量查询/Go 模型拉取）零回归；
  // 多 Key 故障转移在 streamByApi 的 withStreamRetry 里按重试切换。
  return {
    baseUrl: provider.baseUrl,
    apiKey: apiKeys[0] ?? provider.apiKey,
    apiKeys,
    customHeaders: provider.customHeaders,
    requestFormat: provider.requestFormat,
    reasoning: reasoningSupported
      ? controls.thinkingEnabled
        ? controls.reasoning
        : "off"
      : undefined,
    promptCachingEnabled: provider.promptCachingEnabled,
    promptCacheRetention: provider.promptCacheRetention,
    nativeWebSearchEnabled: controls.nativeWebSearchEnabled,
    useSystemProxy: provider.useSystemProxy,
    modelConfig: findProviderModelConfig(provider, model),
  } as ProviderRuntimeConfig;
}
