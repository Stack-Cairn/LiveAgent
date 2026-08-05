import {
  type ChatRuntimeControls,
  type CustomProvider,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  normalizeChatRuntimeControlsForProvider,
} from "../../settings";
import type { CliIdentitySettings } from "../cliIdentityCore";
import { resolveProviderCustomHeaders } from "../customHeaders";
import type { ProviderRuntimeConfig } from "./types";

/**
 * ProviderRuntimeConfig 的唯一构造点——全仓仅此一处注入品牌。任何调用方都只能
 * 拿到完整对象并整体传递（需要改档位等请用展开派生），不得再逐字段转抄。
 *
 * providerIdentities 有意设为必填：PR #289 的成因正是"每个调用点各自记得传"，
 * 漏传只会静默丢头而不报错。设为必填后新增调用点会直接编译失败。
 */
export function createProviderRuntimeConfig(
  provider: CustomProvider,
  model: string,
  controlsInput: ChatRuntimeControls | undefined,
  providerIdentities: CliIdentitySettings,
): ProviderRuntimeConfig {
  const reasoningParams = {
    providerId: provider.type,
    requestFormat: provider.requestFormat,
    modelId: model,
  };
  const controls = normalizeChatRuntimeControlsForProvider(controlsInput, reasoningParams);
  const reasoningSupported = getChatRuntimeReasoningLevelsForProvider(reasoningParams).length > 0;
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    customHeaders: resolveProviderCustomHeaders(provider, providerIdentities),
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
