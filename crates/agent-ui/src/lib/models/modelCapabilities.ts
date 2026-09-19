import { findProviderPreset, presetIdForLegacyType } from "@liveagent/ui/lib/providers/registry";
import { resolveProviderChatRoute } from "@liveagent/ui/lib/settings";
import {
  type CapabilityState,
  CHAT_CAPABILITY_NAMES,
  type ChatCapabilityName,
  type CustomProvider,
  type ProviderChatProtocol,
  type ProviderId,
  type ProviderModelConfig,
  type ResolvedProviderChatRoute,
} from "@liveagent/ui/lib/settings/types";
import {
  type CatalogInputModality,
  type CatalogModelMatch,
  findCatalogModelInSection,
  findCatalogModelMatchAcrossProviders,
} from "./modelCatalog";
import { resolveModelThinking } from "./modelThinking";

// ---------------------------------------------------------------------------
// 模型能力默认值（设置页能力芯片与"目录信息"面板的单一解析入口）
// ---------------------------------------------------------------------------
// 优先级：用户覆盖（model.capabilities）> 目录（models.dev 布尔字段：缺省即
// false，因此目录命中而字段缺失 = unsupported）> 供应商/适配器规则（原生搜索
// 按接口家族；推理按 resolveModelThinking 的世代启发式）> unknown。
// parallelTools / promptCaching 目前没有消费者，保留在类型里但一律 unknown。
// 目录查找先按预设的分区（渠道自己的列表），再跨分区回查（中转挂载的别家模型）。

export type FieldSource = "user" | "catalog" | "provider" | "heuristic" | "unknown";

export type ResolvedCapability = { state: CapabilityState; source: FieldSource };

export type ResolvedModelCapabilities = Record<ChatCapabilityName, ResolvedCapability>;

export type ResolvedModelInputModalities = {
  modalities: readonly CatalogInputModality[];
  source: FieldSource;
};

/** 目录命中信息：条目、所在分区与命中的 id 形态（供"目录信息"面板展示）。 */
export type ResolvedModelCatalogInfo = CatalogModelMatch;

type CapabilityProvider = Pick<CustomProvider, "type" | "baseUrl" | "isFullUrl"> &
  Partial<
    Pick<
      CustomProvider,
      | "presetId"
      | "modelsUrl"
      | "requestFormat"
      | "models"
      | "defaultChatProtocol"
      | "dialect"
      | "endpointConfigs"
      | "credentials"
      | "apiKey"
      | "customHeaders"
      | "nativeWebSearchEnabled"
    >
  >;

const UNKNOWN: ResolvedCapability = { state: "unknown", source: "unknown" };

function findModelConfig(
  provider: CapabilityProvider,
  modelId: string,
): ProviderModelConfig | undefined {
  const id = modelId.trim();
  return provider.models?.find((item) => item.id === id);
}

/**
 * 模型在目录里的命中：先查预设自己的分区（渠道列表），再跨分区回查。
 * 无预设（旧存档）时按旧供应商类型映射到原生预设的分区。
 */
export function resolveModelCatalogInfo(
  provider: Pick<CustomProvider, "type"> & Partial<Pick<CustomProvider, "presetId">>,
  modelId: string,
): ResolvedModelCatalogInfo | undefined {
  const preset = findProviderPreset(provider.presetId ?? presetIdForLegacyType(provider.type));
  const scoped = preset?.catalogProviderId
    ? findCatalogModelInSection(preset.catalogProviderId, modelId)
    : undefined;
  return scoped ?? findCatalogModelMatchAcrossProviders(modelId);
}

/**
 * 接口家族级的原生搜索可用性——与运行时 providerSupportsNativeWebSearch 同一
 * 规则（按旧适配器家族 + 接口判断；Completions 只在非官方 OpenAI 地址或
 * search-preview 模型上可用）。设置层不依赖运行时包，故在此镜像一份。
 */
export function protocolSupportsNativeWebSearch(
  adapterProviderId: ProviderId,
  protocol: ProviderChatProtocol,
  options?: { baseUrl?: string; modelId?: string },
): boolean {
  if (adapterProviderId === "codex" && protocol === "openai-completions") {
    const baseUrl = options?.baseUrl?.trim();
    if (!baseUrl) return false;
    if (isOfficialOpenAIBaseUrl(baseUrl)) {
      return (options?.modelId ?? "").trim().toLowerCase().includes("search-preview");
    }
    return true;
  }
  return (
    (adapterProviderId === "codex" && protocol === "openai-responses") ||
    (adapterProviderId === "xai" && protocol === "openai-responses") ||
    (adapterProviderId === "deepseek" && protocol === "openai-responses") ||
    (adapterProviderId === "claude_code" && protocol === "anthropic-messages") ||
    (adapterProviderId === "gemini" && protocol === "google-generative-ai")
  );
}

function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function fromCatalogFlag(value: true | undefined): ResolvedCapability {
  return { state: value ? "supported" : "unsupported", source: "catalog" };
}

/**
 * 解析模型全部聊天能力的状态与来源。route 缺省时按供应商配置解析路由（只用
 * 到 adapterProviderId / protocol / baseUrl，用于原生搜索的接口规则）。
 */
export function resolveModelCapabilities(
  provider: CapabilityProvider,
  modelId: string,
  route?: Pick<ResolvedProviderChatRoute, "adapterProviderId" | "protocol" | "baseUrl">,
): ResolvedModelCapabilities {
  const id = modelId.trim();
  const model = findModelConfig(provider, id);
  const resolvedRoute = route ?? resolveProviderChatRoute(provider, id);
  const catalog = resolveModelCatalogInfo(provider, id)?.entry;
  const input = catalog?.inputModalities;

  const defaults: ResolvedModelCapabilities = {
    reasoning: catalog
      ? fromCatalogFlag(catalog.thinking ? true : undefined)
      : {
          state: resolveModelThinking(resolvedRoute.adapterProviderId, id).reasoning
            ? "supported"
            : "unsupported",
          source: "heuristic",
        },
    tools: catalog ? fromCatalogFlag(catalog.toolCall) : UNKNOWN,
    parallelTools: UNKNOWN,
    structuredOutput: catalog ? fromCatalogFlag(catalog.structuredOutput) : UNKNOWN,
    nativeWebSearch:
      typeof model?.nativeWebSearch === "boolean"
        ? { state: model.nativeWebSearch ? "supported" : "unsupported", source: "user" }
        : {
            state:
              provider.nativeWebSearchEnabled !== false &&
              protocolSupportsNativeWebSearch(
                resolvedRoute.adapterProviderId,
                resolvedRoute.protocol,
                { baseUrl: resolvedRoute.baseUrl, modelId: id },
              )
                ? "supported"
                : "unsupported",
            source: "provider",
          },
    promptCaching: UNKNOWN,
    fileInput: catalog
      ? catalog.attachment || input?.includes("pdf")
        ? { state: "supported", source: "catalog" }
        : input
          ? { state: "unsupported", source: "catalog" }
          : UNKNOWN
      : UNKNOWN,
    imageUnderstanding: catalog
      ? input
        ? { state: input.includes("image") ? "supported" : "unsupported", source: "catalog" }
        : UNKNOWN
      : UNKNOWN,
    // --- image generation (begin) -------------------------------------------
    // 目录的 outputModalities 含 "image" 即支持出图；目录没命中时留 unknown
    // （id 启发式只用于 resolveModelType 的路由判定，不冒充能力事实）。
    imageGeneration: catalog
      ? {
          state: catalog.outputModalities?.includes("image") ? "supported" : "unsupported",
          source: "catalog",
        }
      : UNKNOWN,
    // --- image generation (end) ---------------------------------------------
  };

  const out = { ...defaults };
  for (const name of CHAT_CAPABILITY_NAMES) {
    const override = model?.capabilities?.[name];
    if (override) out[name] = { state: override, source: "user" };
  }
  return out;
}

/**
 * 展示/门控用的输入模态：用户覆盖 > 目录 inputModalities > 由已解析的
 * imageUnderstanding / fileInput 能力反推 > 启发式仅文本。
 */
export function resolveModelInputModalitiesResolved(
  provider: CapabilityProvider,
  modelId: string,
  route?: Pick<ResolvedProviderChatRoute, "adapterProviderId" | "protocol" | "baseUrl">,
): ResolvedModelInputModalities {
  const id = modelId.trim();
  const override = findModelConfig(provider, id)?.inputModalities;
  if (override && override.length > 0) return { modalities: override, source: "user" };

  const catalog = resolveModelCatalogInfo(provider, id)?.entry;
  if (catalog?.inputModalities) return { modalities: catalog.inputModalities, source: "catalog" };

  const capabilities = resolveModelCapabilities(provider, id, route);
  const image = capabilities.imageUnderstanding;
  const file = capabilities.fileInput;
  if (image.state === "supported" || file.state === "supported") {
    const modalities: CatalogInputModality[] = ["text"];
    if (image.state === "supported") modalities.push("image");
    if (file.state === "supported") modalities.push("pdf");
    return {
      modalities,
      source: image.state === "supported" ? image.source : file.source,
    };
  }
  return { modalities: ["text"], source: "heuristic" };
}
