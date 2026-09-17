import type { ProviderFailoverLayer } from "../../../lib/providers/runtime/providerFailover";
import { createProviderRuntimeConfig } from "../../../lib/providers/runtime/providerRuntimeConfig";
import type { ProviderRuntimeConfig } from "../../../lib/providers/runtime/types";
import { resolveRuntimeWireRoute } from "../../../lib/providers/runtime/wireRoute";
import {
  type AppSettings,
  type ChatRuntimeControls,
  type CustomProvider,
  credentialCoversModel,
  DEFAULT_PROVIDER_FAILOVER_SETTINGS,
  getProviderCredentials,
  getProviderEnabledOrigins,
  getProviderEnabledProtocols,
  PROVIDER_CHAT_PROTOCOL_LABELS,
  PROVIDER_PROTOCOL_FAMILY,
  type ProviderChatProtocol,
  type ProviderProtocolFamily,
  resolvePromptClarifyModel,
  type SelectedModel,
} from "../../../lib/settings";
import { type EffectiveChatModelSelection, isProviderModelAvailable } from "./modelSelection";

export function resolveMemorySummaryModelSelection(
  settings: AppSettings,
): EffectiveChatModelSelection | null {
  const summaryModel = settings.memory.summaryModel;
  if (!summaryModel) {
    return null;
  }

  const provider = settings.customProviders.find(
    (item) => item.id === summaryModel.customProviderId,
  );
  // 停用供应商与未启用模型同判：失效即走调用方既有回退（此处为 null）。
  if (!provider || !isProviderModelAvailable(provider, summaryModel.model)) {
    return null;
  }

  return {
    selectedModel: summaryModel,
    provider,
    providerId: provider.type,
    model: summaryModel.model,
  };
}

export function resolveConversationTitleModelSelection(
  settings: AppSettings,
  fallback: EffectiveChatModelSelection,
): EffectiveChatModelSelection {
  const titleModel = settings.customSettings.conversationTitleModel;
  if (!titleModel) {
    return fallback;
  }

  const provider = settings.customProviders.find((item) => item.id === titleModel.customProviderId);
  if (!provider || !isProviderModelAvailable(provider, titleModel.model)) {
    return fallback;
  }

  return {
    selectedModel: titleModel,
    provider,
    providerId: provider.type,
    model: titleModel.model,
  };
}

// Commit-message generation model for the Git review dock. Returns null when
// the setting is unset or points at a provider/model that is no longer active,
// so the caller falls back to the current conversation model.
export function resolveCommitMessageModelSelection(
  settings: AppSettings,
): EffectiveChatModelSelection | null {
  const commitModel = settings.customSettings.commitMessageModel;
  if (!commitModel) {
    return null;
  }

  const provider = settings.customProviders.find(
    (item) => item.id === commitModel.customProviderId,
  );
  if (!provider || !isProviderModelAvailable(provider, commitModel.model)) {
    return null;
  }

  return {
    selectedModel: commitModel,
    provider,
    providerId: provider.type,
    model: commitModel.model,
  };
}

// Prompt-clarify model override (设置抽屉「澄清对话模型」). Returns null when
// unset or stale so the caller falls back to the current conversation model —
// same contract as resolveCommitMessageModelSelection, validation shared with
// the web surface via resolvePromptClarifyModel.
export function resolvePromptClarifyModelSelection(
  settings: AppSettings,
): EffectiveChatModelSelection | null {
  const resolved = resolvePromptClarifyModel(settings);
  if (!resolved) {
    return null;
  }
  return {
    selectedModel: { customProviderId: resolved.provider.id, model: resolved.model },
    provider: resolved.provider,
    providerId: resolved.provider.type,
    model: resolved.model,
  };
}

export function selectedModelsMatch(
  left: SelectedModel | undefined,
  right: SelectedModel | undefined,
) {
  return (
    Boolean(left) &&
    Boolean(right) &&
    left?.customProviderId === right?.customProviderId &&
    left?.model === right?.model
  );
}

export type ModelFailoverLayer = ProviderFailoverLayer;

export type ModelFailoverPlan = {
  config: {
    maxSwitches: number;
    failureThreshold: number;
    cooldownSeconds: number;
  };
  primary: { selectedModel: SelectedModel; label: string };
  fallbacks: {
    selectedModel: SelectedModel;
    providerId: AppSettings["customProviders"][number]["type"];
    model: string;
    label: string;
    runtime: ProviderRuntimeConfig;
    /** 候选来自哪一层（设计文档 8.2）；四层共用一份切换预算。 */
    layer: ModelFailoverLayer;
  }[];
};

export function failoverTargetLabel(providerName: string, model: string) {
  return `${providerName} · ${model}`;
}

/**
 * 端点层候选：供应商已启用的同家族其它渠道。当前路由所走的接口不重复列入。
 */
function resolveEndpointLayerProtocols(
  provider: CustomProvider,
  family: ProviderProtocolFamily,
  activeProtocol: ProviderChatProtocol,
): ProviderChatProtocol[] {
  const out: ProviderChatProtocol[] = [];
  for (const protocol of getProviderEnabledProtocols(provider)) {
    if (protocol === activeProtocol || out.includes(protocol)) continue;
    if (PROVIDER_PROTOCOL_FAMILY[protocol] !== family) continue;
    out.push(protocol);
  }
  return out;
}

/** 源层候选的展示名：主机（含端口）；解析失败退回原串。 */
export function originDisplayName(originUrl: string): string {
  try {
    return new URL(originUrl).host;
  } catch {
    return originUrl.replace(/^https?:\/\//i, "");
  }
}

/**
 * Resolves settings.modelFailover into concrete fallback targets for one turn.
 *
 * 分组按接口家族（Anthropic / OpenAI / Gemini），家族取自主选的路由结果；跨家族
 * 绝不互为候选。候选按四层展开并共用一份 maxSwitches 预算（设计文档 8.2）：
 *
 * 1. 凭据层：同供应商下其它启用且范围覆盖该模型的 Key，各自独立熔断。
 * 2. 源层：同 Key、同接口，端点以 `{origin}` 占位时的其它已启用源。运行时只对连接 /
 *    超时 / 5xx 类失败换源，鉴权类错误跳过这一层。
 * 3. 端点层：同供应商内同家族的其它已启用渠道。
 * 4. 供应商层：家族队列里的其它供应商，须启用同名模型且解析后同家族。只有这一层
 *    受 `enabled` 开关控制；前三层随配置自动生效。
 *
 * Each fallback re-sends the conversation's *own model id* (cc-switch semantics:
 * switch target, keep model). The active selection stays first; queue entries
 * that duplicate the active provider are dropped. Returns undefined when nothing
 * remains to fail over to.
 */
export function buildModelFailoverPlan(
  settings: AppSettings,
  primary: EffectiveChatModelSelection,
  controlsInput?: ChatRuntimeControls,
): ModelFailoverPlan | undefined {
  const primaryRuntime = createProviderRuntimeConfig(
    primary.provider,
    primary.model,
    controlsInput,
  );
  // 家族与接口一律读路由视图（resolveRuntimeWireRoute）：手写 runtime 的回退链
  // （requestFormat → adapterProviderId 旧推导）只在那一处维护。
  const primaryWire = resolveRuntimeWireRoute(primary.providerId, primaryRuntime);
  const family = primaryWire.family;
  const failover = settings.modelFailover?.[family] ?? DEFAULT_PROVIDER_FAILOVER_SETTINGS;
  const fallbacks: ModelFailoverPlan["fallbacks"] = [];
  const seen = new Set<string>();
  const candidateIdentity = (
    provider: CustomProvider,
    runtime: ProviderRuntimeConfig,
    protocol: ProviderChatProtocol,
  ) => `${provider.id}::${runtime.credentialId ?? ""}::${runtime.originId ?? ""}::${protocol}`;
  const pushFallback = (
    provider: CustomProvider,
    runtime: ProviderRuntimeConfig,
    layer: ModelFailoverLayer,
    labelSuffix?: string,
  ) => {
    if (!runtime.baseUrl.trim() || !runtime.apiKey.trim()) return;
    const wire = resolveRuntimeWireRoute(provider.type, runtime);
    // 解析后仍须同家族：端点 / 队列条目可能指向别的接口家族。
    if (wire.family !== family) return;
    const identity = candidateIdentity(provider, runtime, wire.protocol);
    if (seen.has(identity)) return;
    seen.add(identity);
    fallbacks.push({
      selectedModel: { customProviderId: provider.id, model: primary.model },
      providerId: provider.type,
      model: primary.model,
      label: `${failoverTargetLabel(provider.name, primary.model)}${labelSuffix ?? ""}`,
      runtime,
      layer,
    });
  };
  seen.add(candidateIdentity(primary.provider, primaryRuntime, primaryWire.protocol));

  // 1. 凭据层：按凭据列表顺序，跳过当前 Key、停用的 Key 与范围不含该模型的 Key。
  getProviderCredentials(primary.provider).forEach((credential, index) => {
    if (!credential.enabled || credential.id === primaryRuntime.credentialId) return;
    if (!credential.apiKey.trim() || !credentialCoversModel(credential, primary.model)) return;
    pushFallback(
      primary.provider,
      createProviderRuntimeConfig(primary.provider, primary.model, controlsInput, {
        credentialId: credential.id,
      }),
      "credential",
      ` · ${credential.label.trim() || `Key ${index + 1}`}`,
    );
  });

  // 2. 源层：当前端点由源展开时，按源列表顺序换到其它已启用的源（同 Key、同接口）。
  if (primaryRuntime.originId) {
    for (const origin of getProviderEnabledOrigins(primary.provider)) {
      if (origin.id === primaryRuntime.originId) continue;
      pushFallback(
        primary.provider,
        createProviderRuntimeConfig(primary.provider, primary.model, controlsInput, {
          originId: origin.id,
        }),
        "origin",
        ` · ${originDisplayName(origin.url)}`,
      );
    }
  }

  // 3. 端点层：同家族其它已启用渠道。
  for (const protocol of resolveEndpointLayerProtocols(
    primary.provider,
    family,
    primaryWire.protocol,
  )) {
    pushFallback(
      primary.provider,
      createProviderRuntimeConfig(primary.provider, primary.model, controlsInput, { protocol }),
      "endpoint",
      ` · ${PROVIDER_CHAT_PROTOCOL_LABELS[protocol]}`,
    );
  }

  // 4. 供应商层：只有这一层受 enabled 控制。
  if (failover.enabled) {
    for (const providerId of failover.queue) {
      if (providerId === primary.selectedModel.customProviderId) continue;
      const provider = settings.customProviders.find((item) => item.id === providerId);
      // The fallback must host the conversation's model: failover keeps the
      // model id and only changes which provider serves it.
      if (!provider || provider.enabled === false) continue;
      if (!provider.activeModels.includes(primary.model)) continue;
      pushFallback(
        provider,
        createProviderRuntimeConfig(provider, primary.model, controlsInput),
        "provider",
      );
    }
  }

  if (fallbacks.length === 0) {
    return undefined;
  }

  return {
    config: {
      maxSwitches: failover.maxSwitches,
      failureThreshold: failover.failureThreshold,
      cooldownSeconds: failover.cooldownSeconds,
    },
    primary: {
      selectedModel: primary.selectedModel,
      label: failoverTargetLabel(primary.provider.name, primary.model),
    },
    fallbacks,
  };
}
