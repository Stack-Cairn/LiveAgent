import {
  resolveModelCapabilities,
  resolveModelInputModalitiesResolved,
} from "@liveagent/ui/lib/models/modelCapabilities";
import { resolveModelParametersForProtocol } from "@liveagent/ui/lib/models/modelParameters";
import {
  clampThinkingLevelToList,
  type ThinkingLevel,
} from "@liveagent/ui/lib/models/modelThinking";
import {
  type ChatRuntimeControls,
  type CustomProvider,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  getProviderCredentials,
  normalizeChatRuntimeControlsForProvider,
  type ProviderChatProtocol,
  type ReasoningLevel,
  resolveProviderChatRoute,
} from "../../settings";
import type { ProviderRuntimeConfig } from "./types";

export type CreateProviderRuntimeConfigOptions = {
  /** 故障转移端点层：强制走指定接口（须为该供应商已启用渠道）。 */
  protocol?: ProviderChatProtocol;
  /** 故障转移凭据层：强制使用指定凭据。 */
  credentialId?: string;
  /** 故障转移源层：强制用指定的源展开 `{origin}` 端点。 */
  originId?: string;
};

/**
 * 模型级默认档覆盖供应商 / 会话档：取值钳到该模型可用档位内（越界按梯子就近），
 * "off" 直接关闭；未声明时沿用会话控制里的档位。
 */
function resolveRuntimeReasoning(params: {
  controls: ChatRuntimeControls;
  levels: ReasoningLevel[];
  modelDefault: ReasoningLevel | undefined;
}): ReasoningLevel | undefined {
  if (params.levels.length === 0) return undefined;
  if (!params.controls.thinkingEnabled) return "off";
  const modelDefault = params.modelDefault;
  if (modelDefault === undefined) return params.controls.reasoning;
  if (modelDefault === "off") return "off";
  const thinkingLevels = params.levels.filter((level): level is ThinkingLevel => level !== "off");
  return clampThinkingLevelToList(modelDefault, thinkingLevels) ?? params.controls.reasoning;
}

/**
 * ProviderRuntimeConfig 的唯一构造点——全仓仅此一处注入品牌。任何调用方都只能
 * 拿到完整对象并整体传递（需要改档位等请用展开派生），不得再逐字段转抄。
 *
 * 路由（接口、方言、地址、远端模型名、凭据、合并后的用户头、quirks、鉴权覆盖）
 * 由 resolveProviderChatRoute 一次算出并整体写入；运行时其余读取点只读这份结果。
 */
export function createProviderRuntimeConfig(
  provider: CustomProvider,
  model: string,
  controlsInput: ChatRuntimeControls | undefined,
  options?: CreateProviderRuntimeConfigOptions,
): ProviderRuntimeConfig {
  const modelConfig = findProviderModelConfig(provider, model);
  const route = resolveProviderChatRoute(provider, model, {
    ...(options?.protocol ? { protocol: options.protocol } : {}),
    ...(options?.credentialId ? { credentialId: options.credentialId } : {}),
    ...(options?.originId ? { originId: options.originId } : {}),
  });
  const reasoningParams = {
    providerId: route.adapterProviderId,
    requestFormat: route.requestFormat,
    modelId: model,
  };
  const controls = normalizeChatRuntimeControlsForProvider(controlsInput, reasoningParams);
  const levels = getChatRuntimeReasoningLevelsForProvider(reasoningParams);
  // 凭据值不进入路由结果：按 credentialId 取值；找不到（不应发生）退回默认 Key。
  const credential = getProviderCredentials(provider).find(
    (item) => item.id === route.credentialId,
  );
  return {
    baseUrl: route.baseUrl,
    isFullUrl: route.isFullUrl,
    ...(route.baseUrlVerbatim ? { baseUrlVerbatim: true } : {}),
    adapterProviderId: route.adapterProviderId,
    chatProtocol: route.protocol,
    protocol: route.protocol,
    dialect: route.dialect,
    family: route.family,
    modelId: model,
    wireModelId: route.wireModelId,
    credentialId: route.credentialId,
    ...(route.originId ? { originId: route.originId, originUrl: route.originUrl } : {}),
    apiKey: credential?.apiKey ?? provider.apiKey,
    customHeaders: route.headers,
    ...(Object.keys(route.quirks).length > 0 ? { quirks: route.quirks } : {}),
    ...(route.auth ? { authOverride: route.auth } : {}),
    ...(route.identity ? { identity: route.identity } : {}),
    requestFormat: route.requestFormat,
    reasoning: resolveRuntimeReasoning({
      controls,
      levels,
      modelDefault: modelConfig.reasoning,
    }),
    promptCachingEnabled: provider.promptCachingEnabled,
    promptCacheHintMode: provider.promptCacheHintMode,
    promptCacheRetention: provider.promptCacheRetention,
    nativeWebSearchEnabled: modelConfig.nativeWebSearch ?? controls.nativeWebSearchEnabled,
    useSystemProxy: provider.useSystemProxy,
    ...(provider.retryPolicy ? { retryPolicy: provider.retryPolicy } : {}),
    modelConfig,
    capabilities: resolveModelCapabilities(provider, model, route),
    inputModalities: resolveModelInputModalitiesResolved(provider, model, route),
    // --- 设计 §6.3：模型级参数按本次路由的接口过滤与钳制后带上 ---
    ...(() => {
      const parameters = resolveModelParametersForProtocol(
        route.protocol,
        modelConfig.parameters,
        modelConfig.maxOutputToken,
      );
      return parameters ? { parameters } : {};
    })(),
    // --- §6.3 结束 ---
  } as ProviderRuntimeConfig;
}
