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
// 优先级（设计 §6.2）：用户覆盖（model.capabilities）> 目录（models.dev 布尔
// 字段：缺省即 false，因此目录命中而字段缺失 = unsupported）> 供应商元数据
// （探测拉回的 /models 声明 + 供应商级开关）> 适配器声明（接口层面的可用性）>
// 启发式 > unknown。
// 目录查找先按预设的分区（渠道自己的列表），再跨分区回查（中转挂载的别家模型）。

export type FieldSource = "user" | "catalog" | "provider" | "adapter" | "heuristic" | "unknown";

// ---------------------------------------------------------------------------
// §6.2 字段候选：同一字段上所有非用户来源的取值，按合并顺序排列。
// ---------------------------------------------------------------------------

/** 候选来源不含 user（用户覆盖不是候选，是结论）与 unknown（不是取值）。 */
export type FieldCandidateSource = Exclude<FieldSource, "user" | "unknown">;

export type FieldCandidate<T> = { value: T; source: FieldCandidateSource };

/** 合并顺序：目录 > 供应商 > 适配器 > 启发式（设计 §6.2）。 */
export const FIELD_CANDIDATE_ORDER: readonly FieldCandidateSource[] = [
  "catalog",
  "provider",
  "adapter",
  "heuristic",
];

/** 按 §6.2 顺序排好的候选列表；undefined 项表示该来源没有声明。 */
export function orderFieldCandidates<T>(
  entries: Partial<Record<FieldCandidateSource, T | undefined>>,
): FieldCandidate<T>[] {
  const out: FieldCandidate<T>[] = [];
  for (const source of FIELD_CANDIDATE_ORDER) {
    const value = entries[source];
    if (value !== undefined) out.push({ value, source });
  }
  return out;
}

/** 目录值与供应商值都存在且不同——界面显示"冲突"芯片并给出采纳入口。 */
export function findFieldCandidateConflict<T>(
  candidates: readonly FieldCandidate<T>[],
): { catalog: T; provider: T } | undefined {
  const catalog = candidates.find((item) => item.source === "catalog");
  const provider = candidates.find((item) => item.source === "provider");
  if (!catalog || !provider || catalog.value === provider.value) return undefined;
  return { catalog: catalog.value, provider: provider.value };
}

export type ResolvedCapability = {
  state: CapabilityState;
  source: FieldSource;
  /** 非用户来源的全部候选，按 §6.2 顺序；只列实际存在的来源。 */
  candidates: readonly FieldCandidate<CapabilityState>[];
};

export type ResolvedModelCapabilities = Record<ChatCapabilityName, ResolvedCapability>;

export type ResolvedModelInputModalities = {
  modalities: readonly CatalogInputModality[];
  source: FieldSource;
  candidates: readonly FieldCandidate<readonly CatalogInputModality[]>[];
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

const UNKNOWN: ResolvedCapability = { state: "unknown", source: "unknown", candidates: [] };

// ---------------------------------------------------------------------------
// §6.2 适配器层声明：四类接口在 pi-ai 0.84.2 上的实际可用性
// ---------------------------------------------------------------------------

/**
 * 工具调用：anthropic-messages / openai-completions / openai-responses /
 * google-generative-ai 四个适配器都会把 tools 转成各自的 wire 形态，接口层面一律可用。
 */
function adapterSupportsTools(_protocol: ProviderChatProtocol): CapabilityState {
  return "supported";
}

/**
 * 结构化输出：pi-ai 0.84.2 在这四类接口上都不发 response_format / responseSchema
 * （唯一有该字段的是本应用不使用的 mistral-conversations），结构化输出一律由
 * 工具调用模拟。因此接口层面的结论与 tools 一致：四类都可用。
 */
function adapterSupportsStructuredOutput(_protocol: ProviderChatProtocol): CapabilityState {
  return "supported";
}

/**
 * Prompt 缓存：Anthropic Messages 由 anthropicCache 中间件下断点、OpenAI Responses
 * 走 Codex 的 prompt_cache_key / store 语义，两者接口层面可用；其余接口 pi-ai 没有
 * 缓存通路，按 unknown 处理（不声称不支持，中转网关可能自带隐式缓存）。
 */
export function protocolSupportsPromptCaching(
  protocol: ProviderChatProtocol,
): CapabilityState | undefined {
  return protocol === "anthropic-messages" || protocol === "openai-responses"
    ? "supported"
    : undefined;
}

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

function catalogFlagState(value: true | undefined): CapabilityState {
  return value ? "supported" : "unsupported";
}

/** 候选列表 → 有效值：首项即结论；空列表落 unknown。 */
function resolveFromCandidates(
  candidates: readonly FieldCandidate<CapabilityState>[],
): ResolvedCapability {
  const winner = candidates[0];
  return winner
    ? { state: winner.value, source: winner.source, candidates }
    : { ...UNKNOWN, candidates };
}

/**
 * 解析模型全部聊天能力的状态、来源与候选。route 缺省时按供应商配置解析路由
 * （只用到 adapterProviderId / protocol / baseUrl，用于原生搜索与适配器层规则）。
 */
export function resolveModelCapabilities(
  provider: CapabilityProvider,
  modelId: string,
  route?: Pick<ResolvedProviderChatRoute, "adapterProviderId" | "protocol" | "baseUrl">,
): ResolvedModelCapabilities {
  const id = modelId.trim();
  const model = findModelConfig(provider, id);
  const resolvedRoute = route ?? resolveProviderChatRoute(provider, id);
  const protocol = resolvedRoute.protocol;
  const catalog = resolveModelCatalogInfo(provider, id)?.entry;
  const input = catalog?.inputModalities;
  // 探测拉回的供应商声明：目前只带模态，限额走 modelLimitFieldInfos。
  const providerModalities = model?.providerMeta?.inputModalities;

  const fileInputCatalog: CapabilityState | undefined = catalog
    ? catalog.attachment || input?.includes("pdf")
      ? "supported"
      : input
        ? "unsupported"
        : undefined
    : undefined;
  const imageCatalog: CapabilityState | undefined =
    catalog && input ? (input.includes("image") ? "supported" : "unsupported") : undefined;

  const defaults: ResolvedModelCapabilities = {
    reasoning: resolveFromCandidates(
      orderFieldCandidates<CapabilityState>({
        catalog: catalog ? catalogFlagState(catalog.thinking ? true : undefined) : undefined,
        heuristic: resolveModelThinking(resolvedRoute.adapterProviderId, id).reasoning
          ? "supported"
          : "unsupported",
      }),
    ),
    tools: resolveFromCandidates(
      orderFieldCandidates<CapabilityState>({
        catalog: catalog ? catalogFlagState(catalog.toolCall) : undefined,
        adapter: adapterSupportsTools(protocol),
      }),
    ),
    structuredOutput: resolveFromCandidates(
      orderFieldCandidates<CapabilityState>({
        catalog: catalog ? catalogFlagState(catalog.structuredOutput) : undefined,
        adapter: adapterSupportsStructuredOutput(protocol),
      }),
    ),
    // 原生搜索：供应商总开关关掉是 provider 层的事实，接口能否发起是 adapter 层的。
    nativeWebSearch: resolveFromCandidates(
      orderFieldCandidates<CapabilityState>({
        provider: provider.nativeWebSearchEnabled === false ? "unsupported" : undefined,
        adapter: protocolSupportsNativeWebSearch(resolvedRoute.adapterProviderId, protocol, {
          baseUrl: resolvedRoute.baseUrl,
          modelId: id,
        })
          ? "supported"
          : "unsupported",
      }),
    ),
    promptCaching: resolveFromCandidates(
      orderFieldCandidates<CapabilityState>({ adapter: protocolSupportsPromptCaching(protocol) }),
    ),
    fileInput: resolveFromCandidates(
      orderFieldCandidates<CapabilityState>({ catalog: fileInputCatalog }),
    ),
    imageUnderstanding: resolveFromCandidates(
      orderFieldCandidates<CapabilityState>({
        catalog: imageCatalog,
        provider: providerModalities
          ? (providerModalities as readonly string[]).includes("image")
            ? "supported"
            : "unsupported"
          : undefined,
      }),
    ),
  };

  const out = { ...defaults };
  // 模型级 nativeWebSearch 布尔是独立字段，语义等同用户覆盖（候选仍保留）。
  if (typeof model?.nativeWebSearch === "boolean") {
    out.nativeWebSearch = {
      state: model.nativeWebSearch ? "supported" : "unsupported",
      source: "user",
      candidates: out.nativeWebSearch.candidates,
    };
  }
  for (const name of CHAT_CAPABILITY_NAMES) {
    const override = model?.capabilities?.[name];
    if (override) out[name] = { state: override, source: "user", candidates: out[name].candidates };
  }
  return out;
}

/**
 * 展示/门控用的输入模态：用户覆盖 > 目录 inputModalities > 供应商声明
 * （providerMeta.inputModalities）> 由已解析的 imageUnderstanding / fileInput
 * 能力反推 > 启发式仅文本。
 */
export function resolveModelInputModalitiesResolved(
  provider: CapabilityProvider,
  modelId: string,
  route?: Pick<ResolvedProviderChatRoute, "adapterProviderId" | "protocol" | "baseUrl">,
): ResolvedModelInputModalities {
  const id = modelId.trim();
  const model = findModelConfig(provider, id);
  const catalog = resolveModelCatalogInfo(provider, id)?.entry;
  const candidates = orderFieldCandidates<readonly CatalogInputModality[]>({
    catalog: catalog?.inputModalities,
    provider: model?.providerMeta?.inputModalities,
  });

  const override = model?.inputModalities;
  if (override && override.length > 0) {
    return { modalities: override, source: "user", candidates };
  }
  const winner = candidates[0];
  if (winner) return { modalities: winner.value, source: winner.source, candidates };

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
      candidates,
    };
  }
  return { modalities: ["text"], source: "heuristic", candidates };
}
