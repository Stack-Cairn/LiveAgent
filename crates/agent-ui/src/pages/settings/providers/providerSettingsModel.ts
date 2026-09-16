// 供应商设置页的纯函数层：把 CustomProvider 的读写收敛到这里，界面组件只描述
// 布局与交互。所有写入都经 normalizeCustomProvider，保证与存档格式一致
// （设计文档 2.3 / 5.4 / 5.5 / 7）。

import {
  type AppSettings,
  type CapabilityState,
  type ChatCapabilityName,
  type CustomProvider,
  credentialCoversModel,
  getDefaultUsageQueryConfig,
  getProviderChatProtocolAdapter,
  getProviderCredentials,
  getProviderEnabledProtocols,
  getProviderImplicitChatProtocol,
  hasProviderFailoverConfiguration,
  normalizeCustomProvider,
  PROVIDER_CHAT_PROTOCOLS,
  PROVIDER_PROTOCOL_FAMILY,
  type ProviderChatProtocol,
  type ProviderCredential,
  type ProviderEndpointConfig,
  type ProviderEndpointProbe,
  type ProviderId,
  type ProviderModelConfig,
  type ProviderModelDefaults,
  type ProviderProtocolFamily,
  type ResolvedProviderChatRoute,
  resolveProviderChatRoute,
  resolveProviderDialect,
  resolveProviderEndpoint,
} from "@liveagent/app/lib/settings";
import {
  type ResolvedCapability,
  resolveModelCapabilities,
  resolveModelCatalogInfo,
  resolveModelInputModalitiesResolved,
} from "@liveagent/ui/lib/models/modelCapabilities";
import type { CatalogModelEntry, CatalogProviderId } from "@liveagent/ui/lib/models/modelCatalog";
import {
  CUSTOM_PRESET_ID,
  findProviderPreset,
  normalizeOrigin,
  type ProviderPreset,
  resolveModelGroup,
} from "@liveagent/ui/lib/providers/registry";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import {
  type AutoConfiguration,
  buildEndpointCandidates,
  type EndpointCandidate,
  type ProviderProbeResult,
  summarizeEndpointStatus,
} from "@liveagent/ui/pages/settings/providerProbe";
import {
  createDraftModelConfig,
  mergeFetchedModels,
} from "@liveagent/ui/pages/settings/providerUtils";

export type ProviderSelection =
  | { kind: "provider"; id: string }
  | { kind: "preset"; id: string }
  | null;

export type ProviderDrawerState =
  | { kind: "request"; focus?: ProviderChatProtocol }
  | { kind: "keys" }
  | { kind: "model"; modelId: string }
  /** 模型目录浏览（只读）；returnTo = 从别的抽屉跳来时关闭后回到哪 */
  | {
      kind: "catalog";
      sectionId?: CatalogProviderId;
      query?: string;
      returnTo?: ProviderDrawerState;
    }
  | null;

export const DEFAULT_CREDENTIAL_ID = "default";

export function customPreset(): ProviderPreset {
  const preset = findProviderPreset(CUSTOM_PRESET_ID);
  if (!preset) throw new Error("custom preset missing from registry");
  return preset;
}

export function presetForProvider(provider: Pick<CustomProvider, "presetId">): ProviderPreset {
  return findProviderPreset(provider.presetId) ?? customPreset();
}

/** 默认接口 = 隐式接口（defaultChatProtocol ?? 旧类型推导），与路由层同一口径。 */
export function providerDefaultProtocol(
  provider: Pick<CustomProvider, "type" | "defaultChatProtocol" | "requestFormat">,
): ProviderChatProtocol {
  return getProviderImplicitChatProtocol(provider);
}

export type EndpointView = {
  protocol: ProviderChatProtocol;
  /** false = 主连接充当该协议的隐式端点（尚未物化成 endpointConfigs 条目） */
  explicit: boolean;
  config: ProviderEndpointConfig;
};

/**
 * 读取某协议的端点（含被停用的显式端点，供配置界面列出）：显式配置原样返回；
 * 没有显式配置时只有隐式接口由主连接物化（source: user，与路由层
 * resolveProviderEndpoint 同一份物化）。
 */
export function readEndpoint(
  provider: CustomProvider,
  protocol: ProviderChatProtocol,
): EndpointView | undefined {
  const explicit = provider.endpointConfigs?.[protocol];
  if (explicit) return { protocol, explicit: true, config: explicit };
  return resolveProviderEndpoint(provider, protocol);
}

/** 已配置的接口（默认接口在前，其余按四类固定顺序），含被停用的。 */
export function providerConfiguredProtocols(provider: CustomProvider): ProviderChatProtocol[] {
  const preferred = providerDefaultProtocol(provider);
  const out: ProviderChatProtocol[] = [];
  for (const protocol of [preferred, ...PROVIDER_CHAT_PROTOCOLS]) {
    if (out.includes(protocol)) continue;
    if (readEndpoint(provider, protocol)) out.push(protocol);
  }
  return out;
}

export function providerEnabledProtocols(provider: CustomProvider): ProviderChatProtocol[] {
  return getProviderEnabledProtocols(provider);
}

/**
 * 显式 + 隐式端点合成的一份 endpointConfigs，供探测候选与请求配置抽屉使用。
 * 隐式端点（旧存档主连接）是用户手填的地址，物化后来源为 user，探测并入时不会
 * 被当成自动值改写或停用。
 */
export function materializedEndpointConfigs(
  provider: CustomProvider,
): NonNullable<CustomProvider["endpointConfigs"]> {
  const out: NonNullable<CustomProvider["endpointConfigs"]> = {};
  for (const protocol of providerConfiguredProtocols(provider)) {
    const view = readEndpoint(provider, protocol);
    if (view?.config.baseUrl) out[protocol] = view.config;
  }
  return out;
}

function syncMainConnection(provider: CustomProvider): CustomProvider {
  const view = readEndpoint(provider, providerDefaultProtocol(provider));
  if (!view?.explicit) return provider;
  return {
    ...provider,
    baseUrl: view.config.baseUrl,
    isFullUrl: view.config.isFullUrl === true,
    ...(view.config.modelsUrl ? { modelsUrl: view.config.modelsUrl } : { modelsUrl: undefined }),
  };
}

export function finalizeProvider(provider: CustomProvider): CustomProvider {
  return normalizeCustomProvider(syncMainConnection(provider));
}

/**
 * 写端点：隐式端点先物化；用户改动标 user；默认接口同步回主连接。
 * 地址被清空时不写入（保留旧值），避免输入框清空失焦后整条端点连同方言、鉴权、
 * quirks 与请求头一起消失。
 */
export function writeEndpoint(
  provider: CustomProvider,
  protocol: ProviderChatProtocol,
  patch:
    | Partial<ProviderEndpointConfig>
    | ((current: ProviderEndpointConfig) => ProviderEndpointConfig),
  options?: { source?: "auto" | "user" },
): CustomProvider {
  const current = readEndpoint(provider, protocol)?.config ?? { baseUrl: "" };
  const next =
    typeof patch === "function"
      ? patch(current)
      : { ...current, ...patch, source: options?.source ?? ("user" as const) };
  if (!next.baseUrl.trim() && current.baseUrl.trim()) return provider;
  return finalizeProvider({
    ...provider,
    endpointConfigs: { ...provider.endpointConfigs, [protocol]: next },
  });
}

export function removeEndpoint(
  provider: CustomProvider,
  protocol: ProviderChatProtocol,
): CustomProvider {
  if (protocol === providerDefaultProtocol(provider)) return provider;
  const next = { ...provider.endpointConfigs };
  delete next[protocol];
  return finalizeProvider({ ...provider, endpointConfigs: next });
}

export function setDefaultProtocol(
  provider: CustomProvider,
  protocol: ProviderChatProtocol,
): CustomProvider {
  const view = readEndpoint(provider, protocol);
  if (!view) return provider;
  // 旧默认接口的主连接值先物化，否则切换后它会失去地址。
  const previous = providerDefaultProtocol(provider);
  const previousView = readEndpoint(provider, previous);
  const endpointConfigs = { ...provider.endpointConfigs };
  if (previousView && !previousView.explicit && previousView.config.baseUrl) {
    endpointConfigs[previous] = { ...previousView.config, source: "auto" };
  }
  if (!view.explicit) endpointConfigs[protocol] = { ...view.config, source: "auto" };
  return finalizeProvider({
    ...provider,
    endpointConfigs,
    defaultChatProtocol: protocol,
    requestFormat:
      protocol === "openai-completions" || protocol === "openai-responses"
        ? protocol
        : provider.requestFormat,
  });
}

export function setEndpointEnabled(
  provider: CustomProvider,
  protocol: ProviderChatProtocol,
  enabled: boolean,
): CustomProvider {
  return writeEndpoint(provider, protocol, (current) => ({
    ...current,
    ...(enabled ? { enabled: undefined } : { enabled: false }),
  }));
}

export function recordEndpointProbe(
  provider: CustomProvider,
  protocol: ProviderChatProtocol,
  probe: ProviderEndpointProbe,
): CustomProvider {
  if (!readEndpoint(provider, protocol)) return provider;
  return writeEndpoint(provider, protocol, (current) => ({ ...current, lastProbe: probe }));
}

// ---------------------------------------------------------------------------
// 凭据
// ---------------------------------------------------------------------------

export function providerCredentials(provider: CustomProvider): ProviderCredential[] {
  return getProviderCredentials(provider);
}

export function primaryCredential(provider: CustomProvider): ProviderCredential {
  return providerCredentials(provider)[0];
}

export function setCredentials(
  provider: CustomProvider,
  credentials: ProviderCredential[],
): CustomProvider {
  const primary = credentials[0];
  return finalizeProvider({
    ...provider,
    credentials,
    apiKey: primary?.apiKey ?? "",
    apiKeyConfigured: primary ? primary.apiKeyConfigured === true || !!primary.apiKey : false,
  });
}

/** 改默认 Key。空值 + keepConfigured（WebUI 脱敏态）表示保留已存密钥。 */
export function setPrimaryApiKey(
  provider: CustomProvider,
  apiKey: string,
  options?: { keepConfigured?: boolean },
): CustomProvider {
  const credentials = providerCredentials(provider).map((credential, index) =>
    index === 0
      ? {
          ...credential,
          apiKey,
          apiKeyConfigured: apiKey.trim().length > 0 || options?.keepConfigured === true,
        }
      : credential,
  );
  return setCredentials(provider, credentials);
}

export function createCredential(label: string): ProviderCredential {
  return { id: createUuid(), label, apiKey: "", enabled: true, modelScope: { mode: "auto" } };
}

export function credentialsCoveringModel(
  provider: CustomProvider,
  modelId: string,
): ProviderCredential[] {
  return providerCredentials(provider).filter(
    (credential) => credential.enabled && credentialCoversModel(credential, modelId),
  );
}

export function enabledCredentials(provider: CustomProvider): ProviderCredential[] {
  return providerCredentials(provider).filter((credential) => credential.enabled);
}

export function credentialConfigured(credential: ProviderCredential): boolean {
  return credential.apiKeyConfigured === true || credential.apiKey.trim().length > 0;
}

/** 已配置（有 Key 或 WebUI 的 configured 标记）的凭据。 */
export function configuredCredentials(provider: CustomProvider): ProviderCredential[] {
  return providerCredentials(provider).filter(credentialConfigured);
}

/** 实例是否有可用的 Key：至少一把启用且已配置；免鉴权预设视为已配置。 */
export function providerKeyReady(provider: CustomProvider): boolean {
  if (presetForProvider(provider).authOptional) return true;
  return enabledCredentials(provider).some(credentialConfigured);
}

function sortedModelSet(credential: ProviderCredential): string {
  return [...(credential.lastModels?.models ?? [])].sort().join("\n");
}

/** 多把启用的 Key 观测到的模型集合是否一致（一致 = 可互换）。 */
export function credentialScopesMatch(provider: CustomProvider): boolean {
  const enabled = enabledCredentials(provider);
  if (enabled.length < 2) return true;
  const first = sortedModelSet(enabled[0]);
  return enabled.every((credential) => sortedModelSet(credential) === first);
}

/** 与主 Key 的模型集合差异；任一方尚未拉取时返回 null（无从比较）。 */
export function credentialModelDiff(
  credential: ProviderCredential,
  primary: ProviderCredential,
): { more: number; less: number } | null {
  if (!credential.lastModels || !primary.lastModels) return null;
  const own = new Set(credential.lastModels.models);
  const base = new Set(primary.lastModels.models);
  let more = 0;
  let less = 0;
  for (const id of own) if (!base.has(id)) more += 1;
  for (const id of base) if (!own.has(id)) less += 1;
  return { more, less };
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

export function modelGroupKey(model: Pick<ProviderModelConfig, "id" | "group">): string {
  return model.group?.trim() || resolveModelGroup(model.id);
}

export function modelGroupIsUser(model: Pick<ProviderModelConfig, "id" | "group">): boolean {
  const group = model.group?.trim();
  return Boolean(group) && group !== resolveModelGroup(model.id);
}

export type ProviderModelGroup = { key: string; models: ProviderModelConfig[] };

/** 按 modelOrder 排序后按分组折叠；分组顺序取首次出现。 */
export function groupProviderModels(provider: CustomProvider): ProviderModelGroup[] {
  const byId = new Map(provider.models.map((model) => [model.id, model]));
  const ordered: ProviderModelConfig[] = [];
  const seen = new Set<string>();
  for (const id of provider.modelOrder ?? []) {
    const model = byId.get(id);
    if (!model || seen.has(id)) continue;
    seen.add(id);
    ordered.push(model);
  }
  for (const model of provider.models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    ordered.push(model);
  }
  const groups = new Map<string, ProviderModelGroup>();
  for (const model of ordered) {
    const key = modelGroupKey(model);
    const group = groups.get(key) ?? { key, models: [] };
    group.models.push(model);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * 分组内拖拽排序：把该分组换成新顺序，再按当前显示顺序把各分组拼接成全局
 * modelOrder（分组顺序不变）。
 */
export function reorderProviderModels(
  provider: CustomProvider,
  groupKey: string,
  orderedIds: readonly string[],
): CustomProvider {
  const groups = groupProviderModels(provider);
  const target = groups.find((group) => group.key === groupKey);
  if (!target) return provider;
  const current = target.models.map((model) => model.id);
  const valid =
    orderedIds.length === current.length && orderedIds.every((id) => current.includes(id));
  if (!valid) return provider;
  const modelOrder = groups.flatMap((group) =>
    group.key === groupKey ? [...orderedIds] : group.models.map((model) => model.id),
  );
  return finalizeProvider({ ...provider, modelOrder });
}

export function updateProviderModel(
  provider: CustomProvider,
  modelId: string,
  updater: (model: ProviderModelConfig) => ProviderModelConfig,
): CustomProvider {
  return finalizeProvider({
    ...provider,
    models: provider.models.map((model) => (model.id === modelId ? updater(model) : model)),
  });
}

export function addProviderModel(provider: CustomProvider, modelIdInput: string): CustomProvider {
  const id = modelIdInput.trim();
  if (!id) return provider;
  const exists = provider.models.some((model) => model.id === id);
  const models = exists
    ? provider.models
    : [
        ...provider.models,
        {
          ...createDraftModelConfig(provider.type, id),
          group: resolveModelGroup(id),
          source: "user" as const,
        },
      ];
  return finalizeProvider({
    ...provider,
    models,
    activeModels: provider.activeModels.includes(id)
      ? provider.activeModels
      : [...provider.activeModels, id],
  });
}

export function removeProviderModel(provider: CustomProvider, modelId: string): CustomProvider {
  return finalizeProvider({
    ...provider,
    models: provider.models.filter((model) => model.id !== modelId),
    activeModels: provider.activeModels.filter((id) => id !== modelId),
    modelOrder: provider.modelOrder?.filter((id) => id !== modelId),
  });
}

export function setProviderModelActive(
  provider: CustomProvider,
  modelId: string,
  active: boolean,
): CustomProvider {
  const has = provider.activeModels.includes(modelId);
  if (has === active) return provider;
  return finalizeProvider({
    ...provider,
    activeModels: active
      ? [...provider.activeModels, modelId]
      : provider.activeModels.filter((id) => id !== modelId),
  });
}

// ---------------------------------------------------------------------------
// 能力芯片 / 限额来源 / 列表行图标（纯函数，界面只做渲染）
// ---------------------------------------------------------------------------

export type CapabilityChipView = {
  /** 三态：支持 = 实心绿点，不支持 = 空心圆 + 虚线边框，未知 = 问号图标 */
  state: ResolvedCapability["state"];
  /** 用户覆盖：芯片外加一圈细主色描边，不改底色 */
  overridden: boolean;
  /** 供应商规则 / 启发式得出的值（只影响 tooltip 里的来源说明） */
  muted: boolean;
};

/**
 * 能力芯片的视觉：状态取有效值、用形状区分（不再用颜色 / 删除线 / 文字问号），
 * 来源只体现为"用户覆盖加描边"与 tooltip 文案。
 */
export function capabilityChipView(resolved: ResolvedCapability): CapabilityChipView {
  return {
    state: resolved.state,
    overridden: resolved.source === "user",
    muted: resolved.source === "heuristic" || resolved.source === "provider",
  };
}

// ---------------------------------------------------------------------------
// 能力与模态表（编辑模型抽屉）：每个属性一行 = 目录值 / 有效值 / 用户覆盖
// ---------------------------------------------------------------------------
// 视觉 / 文件 / 推理 / 工具 / 结构化输出 / 原生搜索对应 ChatCapabilityName；音频 /
// 视频只有模态没有能力位，运行时也不读覆盖，故只读。视觉行的覆盖同时写
// capabilities.imageUnderstanding 与 inputModalities（附件门控读的是后者）。

export type ModelCapabilityRowKey =
  | "imageUnderstanding"
  | "fileInput"
  | "audioInput"
  | "videoInput"
  | "reasoning"
  | "tools"
  | "structuredOutput"
  | "nativeWebSearch";

export const MODEL_CAPABILITY_ROWS: readonly ModelCapabilityRowKey[] = [
  "imageUnderstanding",
  "fileInput",
  "audioInput",
  "videoInput",
  "reasoning",
  "tools",
  "structuredOutput",
  "nativeWebSearch",
];

/** 用户覆盖只有两态；undefined = 继承（目录 / 规则 / 启发式）。 */
export type ModelCapabilityOverride = "supported" | "unsupported";

export type ModelCapabilityRow = {
  key: ModelCapabilityRowKey;
  /** 目录条目的原始值；目录未收录或该位未公布为 undefined（显示"—"） */
  catalog: ModelCapabilityOverride | undefined;
  /** 有效值与来源（用户覆盖 > 目录 > 供应商规则 / 启发式） */
  effective: ResolvedCapability;
  /** 用户覆盖；undefined = 继承 */
  override: ModelCapabilityOverride | undefined;
  /** 音频 / 视频运行时不支持覆盖 */
  editable: boolean;
};

const CAPABILITY_ROW_TO_NAME: Partial<Record<ModelCapabilityRowKey, ChatCapabilityName>> = {
  imageUnderstanding: "imageUnderstanding",
  fileInput: "fileInput",
  reasoning: "reasoning",
  tools: "tools",
  structuredOutput: "structuredOutput",
  nativeWebSearch: "nativeWebSearch",
};

function toOverride(state: CapabilityState | undefined): ModelCapabilityOverride | undefined {
  return state === "supported" || state === "unsupported" ? state : undefined;
}

/**
 * 目录条目对某一行的原始值：与 resolveModelCapabilities 读目录的规则一致
 * （文件 = attachment 位或 pdf 模态；推理 = 有 thinking；原生搜索目录不收录）。
 */
export function catalogCapabilityValue(
  entry: CatalogModelEntry | undefined,
  key: ModelCapabilityRowKey,
): ModelCapabilityOverride | undefined {
  if (!entry) return undefined;
  const input = entry.inputModalities;
  const fromModality = (modality: "image" | "audio" | "video") =>
    input ? (input.includes(modality) ? "supported" : "unsupported") : undefined;
  switch (key) {
    case "imageUnderstanding":
      return fromModality("image");
    case "audioInput":
      return fromModality("audio");
    case "videoInput":
      return fromModality("video");
    case "fileInput":
      if (entry.attachment || input?.includes("pdf")) return "supported";
      return input ? "unsupported" : undefined;
    case "reasoning":
      return entry.thinking ? "supported" : "unsupported";
    case "tools":
      return entry.toolCall ? "supported" : "unsupported";
    case "structuredOutput":
      return entry.structuredOutput ? "supported" : "unsupported";
    case "nativeWebSearch":
      return undefined;
  }
}

/** 某一行的用户覆盖；视觉行兼容只写了 inputModalities 的旧存档。 */
export function modelCapabilityOverride(
  model: Pick<ProviderModelConfig, "capabilities" | "inputModalities">,
  key: ModelCapabilityRowKey,
): ModelCapabilityOverride | undefined {
  const name = CAPABILITY_ROW_TO_NAME[key];
  if (!name) return undefined;
  const explicit = toOverride(model.capabilities?.[name]);
  if (explicit) return explicit;
  if (key === "imageUnderstanding" && model.inputModalities) {
    return model.inputModalities.some((modality) => modality === "image")
      ? "supported"
      : "unsupported";
  }
  return undefined;
}

export function modelCapabilityRows(
  provider: CustomProvider,
  modelId: string,
  route: Pick<ResolvedProviderChatRoute, "adapterProviderId" | "protocol" | "baseUrl">,
): ModelCapabilityRow[] {
  const model = provider.models.find((item) => item.id === modelId.trim());
  const entry = resolveModelCatalogInfo(provider, modelId)?.entry;
  const capabilities = resolveModelCapabilities(provider, modelId, route);
  const input = resolveModelInputModalitiesResolved(provider, modelId, route);
  return MODEL_CAPABILITY_ROWS.map((key) => {
    const name = CAPABILITY_ROW_TO_NAME[key];
    const effective: ResolvedCapability = name
      ? capabilities[name]
      : {
          state: input.modalities.includes(key === "audioInput" ? "audio" : "video")
            ? "supported"
            : "unsupported",
          source: input.source,
        };
    return {
      key,
      catalog: catalogCapabilityValue(entry, key),
      effective,
      override: model ? modelCapabilityOverride(model, key) : undefined,
      editable: name !== undefined,
    };
  });
}

/**
 * 写入 / 清除某一行的用户覆盖。视觉行同时维护 inputModalities（支持 →
 * ["text","image"]，不支持 → ["text"]，继承 → 删除）；capabilities 清空后整键删除。
 */
export function setModelCapabilityOverride(
  model: ProviderModelConfig,
  key: ModelCapabilityRowKey,
  override: ModelCapabilityOverride | undefined,
): ProviderModelConfig {
  const name = CAPABILITY_ROW_TO_NAME[key];
  if (!name) return model;
  const next: ProviderModelConfig = { ...model };
  const capabilities = { ...model.capabilities };
  if (override) capabilities[name] = override;
  else delete capabilities[name];
  if (Object.keys(capabilities).length > 0) next.capabilities = capabilities;
  else delete next.capabilities;
  if (key === "imageUnderstanding") {
    if (override === "supported") next.inputModalities = ["text", "image"];
    else if (override === "unsupported") next.inputModalities = ["text"];
    else delete next.inputModalities;
  }
  return next;
}

/** 还原全部为目录值：清掉 capabilities 与 inputModalities 两处覆盖。 */
export function resetModelCapabilityOverrides(model: ProviderModelConfig): ProviderModelConfig {
  const next: ProviderModelConfig = { ...model };
  delete next.capabilities;
  delete next.inputModalities;
  return next;
}

export function hasModelCapabilityOverrides(
  model: Pick<ProviderModelConfig, "capabilities" | "inputModalities">,
): boolean {
  return (
    (model.capabilities !== undefined && Object.keys(model.capabilities).length > 0) ||
    model.inputModalities !== undefined
  );
}

export type ModelLimitField = "contextWindow" | "maxInputTokens" | "maxOutputToken";
export type ModelLimitFieldSource = "user" | "catalog" | "auto" | "heuristic";

const MODEL_LIMIT_FIELDS: readonly ModelLimitField[] = [
  "contextWindow",
  "maxInputTokens",
  "maxOutputToken",
];

function limitsSourceTag(source: ProviderModelConfig["limitsSource"]): ModelLimitFieldSource {
  return source === "catalog" ? "catalog" : source === "provider" ? "auto" : "heuristic";
}

/**
 * 三个限额输入框各自的来源徽标：limitsSource 是模型级的一份标记，用户改过任一
 * 项后整体变 user；这里按"值是否仍等于默认值"把它拆回逐字段——与默认值相同的
 * 字段仍显示默认值来源（目录 / 供应商 / 兜底）。最大输入未设置且目录也没给时
 * 不显示徽标。
 */
export function modelLimitFieldSources(
  model: Pick<ProviderModelConfig, ModelLimitField | "limitsSource">,
  defaults: ProviderModelDefaults,
): Record<ModelLimitField, ModelLimitFieldSource | undefined> {
  const base = limitsSourceTag(model.limitsSource);
  const baseline = limitsSourceTag(defaults.source);
  const fieldSource = (field: ModelLimitField): ModelLimitFieldSource | undefined => {
    const value = model[field];
    const fallback = defaults[field];
    if (field === "maxInputTokens" && value === undefined && fallback === undefined) {
      return undefined;
    }
    if (model.limitsSource === "user") return value === fallback ? baseline : "user";
    return base;
  };
  return {
    contextWindow: fieldSource("contextWindow"),
    maxInputTokens: fieldSource("maxInputTokens"),
    maxOutputToken: fieldSource("maxOutputToken"),
  };
}

/** 单项还原为默认值；全部回到默认值后 limitsSource 也回到默认值来源。 */
export function resetModelLimitField(
  model: ProviderModelConfig,
  defaults: ProviderModelDefaults,
  field: ModelLimitField,
): ProviderModelConfig {
  const next: ProviderModelConfig = { ...model };
  if (field === "maxInputTokens") {
    if (defaults.maxInputTokens) next.maxInputTokens = defaults.maxInputTokens;
    else delete next.maxInputTokens;
  } else {
    next[field] = defaults[field];
  }
  const allDefault = MODEL_LIMIT_FIELDS.every((key) => next[key] === defaults[key]);
  next.limitsSource = allDefault ? defaults.source : "user";
  return next;
}

export type ModelCapabilityFlags = {
  vision: boolean;
  file: boolean;
  reasoning: boolean;
  tools: boolean;
  /** 只有用户显式打开才亮：供应商规则级的可用性在能力芯片里看 */
  search: boolean;
};

/**
 * 模型列表行的能力小图标：按有效能力与有效输入模态一次算好。图片 / 文件在
 * 能力未被声明不支持时也看模态（目录只给模态不给 attachment 位的模型）。
 */
export function modelCapabilityFlags(
  provider: CustomProvider,
  modelId: string,
  route: Pick<ResolvedProviderChatRoute, "adapterProviderId" | "protocol" | "baseUrl">,
): ModelCapabilityFlags {
  const capabilities = resolveModelCapabilities(provider, modelId, route);
  const input = resolveModelInputModalitiesResolved(provider, modelId, route).modalities;
  const allows = (capability: ResolvedCapability, modality: "image" | "pdf") =>
    capability.state === "supported" ||
    (capability.state !== "unsupported" && input.includes(modality));
  return {
    vision: allows(capabilities.imageUnderstanding, "image"),
    file: allows(capabilities.fileInput, "pdf"),
    reasoning: capabilities.reasoning.state === "supported",
    tools: capabilities.tools.state === "supported",
    search:
      capabilities.nativeWebSearch.source === "user" &&
      capabilities.nativeWebSearch.state === "supported",
  };
}

export function adapterProviderIdForModel(provider: CustomProvider, modelId: string): ProviderId {
  return resolveProviderChatRoute(provider, modelId).adapterProviderId;
}

export function defaultAdapterProviderId(provider: CustomProvider): ProviderId {
  const protocol = providerDefaultProtocol(provider);
  return getProviderChatProtocolAdapter(protocol, resolveProviderDialect(provider, protocol));
}

// ---------------------------------------------------------------------------
// 故障转移候选（设计文档 6.4 / 8.2，与运行时 buildModelFailoverPlan 同一判定）
// ---------------------------------------------------------------------------

export type ModelFailoverCandidates = {
  family: ProviderProtocolFamily;
  /** 供应商层是否启用（前两层随配置自动生效） */
  providerLayerEnabled: boolean;
  /** 凭据层：同供应商其它启用、已配置且范围覆盖该模型的 Key */
  credentials: ProviderCredential[];
  /** 端点层：供应商已启用的同家族其它接口（当前路由接口除外） */
  endpoints: ProviderChatProtocol[];
  /** 供应商层：家族队列里启用同名模型且解析后同家族的其它供应商 */
  providers: CustomProvider[];
};

export function modelFailoverCandidates(
  settings: AppSettings,
  provider: CustomProvider,
  modelId: string,
  route: ResolvedProviderChatRoute,
): ModelFailoverCandidates {
  const family = route.family;
  const credentials = providerCredentials(provider).filter(
    (credential) =>
      credential.enabled &&
      credential.id !== route.credentialId &&
      credentialConfigured(credential) &&
      credentialCoversModel(credential, modelId),
  );
  const endpoints: ProviderChatProtocol[] = [];
  for (const protocol of providerEnabledProtocols(provider)) {
    if (protocol === route.protocol || endpoints.includes(protocol)) continue;
    if (PROVIDER_PROTOCOL_FAMILY[protocol] !== family) continue;
    endpoints.push(protocol);
  }
  const failover = settings.modelFailover[family];
  const providers = failover.enabled
    ? failover.queue.flatMap((providerId) => {
        if (providerId === provider.id) return [];
        const candidate = settings.customProviders.find((item) => item.id === providerId);
        if (!candidate || candidate.enabled === false) return [];
        if (!candidate.activeModels.includes(modelId)) return [];
        if (!hasProviderFailoverConfiguration(candidate)) return [];
        if (resolveProviderChatRoute(candidate, modelId).family !== family) return [];
        return [candidate];
      })
    : [];
  return { family, providerLayerEnabled: failover.enabled, credentials, endpoints, providers };
}

// ---------------------------------------------------------------------------
// 探测候选与自动配置的采纳
// ---------------------------------------------------------------------------

export function providerOrigin(provider: CustomProvider): string {
  const view = readEndpoint(provider, providerDefaultProtocol(provider));
  return normalizeOrigin(view?.config.baseUrl ?? provider.baseUrl);
}

/** 检测并配置：注册表声明的接口 + 已配置端点。 */
export function providerProbeCandidates(provider: CustomProvider): EndpointCandidate[] {
  const preset = presetForProvider(provider);
  const existing = materializedEndpointConfigs(provider);
  const origin = providerOrigin(provider);
  const baseUrl = readEndpoint(provider, providerDefaultProtocol(provider))?.config.baseUrl;
  return buildEndpointCandidates({
    preset: preset.id === CUSTOM_PRESET_ID ? undefined : preset,
    origin,
    baseUrl,
    existing,
  });
}

/** 获取模型列表 / 检测：只跑已启用的现有端点。 */
export function providerExistingCandidates(
  provider: CustomProvider,
  options?: { includeDisabled?: boolean },
): EndpointCandidate[] {
  const protocols = options?.includeDisabled
    ? providerConfiguredProtocols(provider)
    : providerEnabledProtocols(provider);
  return protocols.flatMap((protocol) => {
    const view = readEndpoint(provider, protocol);
    if (!view?.config.baseUrl) return [];
    return [
      {
        protocol,
        baseUrl: view.config.baseUrl,
        modelsUrl: view.config.modelsUrl,
        isFullUrl: view.config.isFullUrl,
        dialect: view.config.dialect,
        quirks: view.config.quirks,
        auth: view.config.auth,
        origin: "existing" as const,
      },
    ];
  });
}

export function probeSummaryFor(
  probe: ProviderProbeResult,
  protocol: ProviderChatProtocol,
): ProviderEndpointProbe {
  const summary = summarizeEndpointStatus(probe, protocol);
  return {
    at: probe.at,
    status: summary.status,
    ...(summary.latencyMs !== undefined ? { latencyMs: summary.latencyMs } : {}),
    ...(summary.error ? { error: summary.error } : {}),
  };
}

/**
 * 把探测与自动配置结果并入现有实例（设计文档 5.5）：
 * - 用户值（user 来源端点、手工模型、用户覆盖字段）不被覆盖；
 * - 已配置端点只写入观测：探测失败不停用、不切默认；启停只由用户决定
 *   （configure 采纳摘要页取消的接口为停用；refresh 不改启停）；
 * - 新模型追加并激活，已有模型保留全部字段；
 * - 每把 Key 的 lastModels 刷新。
 */
export function applyProbeToProvider(
  provider: CustomProvider,
  params: {
    candidates: readonly EndpointCandidate[];
    probe: ProviderProbeResult;
    auto: AutoConfiguration;
    mode: "configure" | "refresh";
  },
): CustomProvider {
  const { candidates, probe, auto, mode } = params;
  const endpointConfigs = { ...materializedEndpointConfigs(provider) };
  for (const candidate of candidates) {
    const protocol = candidate.protocol;
    const lastProbe = probeSummaryFor(probe, protocol);
    const existing = endpointConfigs[protocol];
    const autoConfig = auto.endpointConfigs[protocol];
    if (!autoConfig) {
      if (existing) endpointConfigs[protocol] = { ...existing, lastProbe };
      continue;
    }
    const { enabled: autoEnabled, ...autoRest } = autoConfig;
    endpointConfigs[protocol] = {
      ...existing,
      ...autoRest,
      ...(existing?.headers ? { headers: existing.headers } : {}),
      ...(existing?.credentialId ? { credentialId: existing.credentialId } : {}),
      ...(mode === "configure" && autoEnabled === false ? { enabled: false } : {}),
      source: existing?.source ?? autoConfig.source,
      lastProbe,
    };
  }

  const models = mergeFetchedModels(auto.models, provider.models);
  const knownIds = new Set(provider.models.map((model) => model.id));
  const newIds = models.map((model) => model.id).filter((id) => !knownIds.has(id));
  const seenByCredential = new Map(
    auto.credentials.map((credential) => [credential.id, credential.lastModels]),
  );
  const credentials = providerCredentials(provider).map((credential) => {
    const lastModels = seenByCredential.get(credential.id);
    return lastModels
      ? {
          ...credential,
          modelScope: credential.modelScope ?? { mode: "auto" as const },
          lastModels,
        }
      : credential;
  });

  const draft: CustomProvider = {
    ...provider,
    endpointConfigs,
    credentials,
    models,
    activeModels: [...provider.activeModels, ...newIds],
    ...(auto.dialect && !provider.dialect ? { dialect: auto.dialect } : {}),
  };
  const enabled = getProviderEnabledProtocols(draft);
  const currentDefault = providerDefaultProtocol(draft);
  const nextDefault = enabled.includes(currentDefault) ? currentDefault : auto.defaultChatProtocol;
  return finalizeProvider(
    nextDefault === currentDefault && draft.defaultChatProtocol
      ? draft
      : {
          ...draft,
          defaultChatProtocol: nextDefault,
          requestFormat:
            nextDefault === "openai-completions" || nextDefault === "openai-responses"
              ? nextDefault
              : draft.requestFormat,
        },
  );
}

export function instanceNameForPreset(
  preset: ProviderPreset,
  providers: readonly CustomProvider[],
  origin?: string,
): string {
  const host = origin ? origin.replace(/^https?:\/\//i, "") : "";
  const base =
    preset.id === CUSTOM_PRESET_ID
      ? host || preset.name
      : preset.input === "key" || !host
        ? preset.name
        : `${preset.name} · ${host}`;
  const duplicates = providers.filter((provider) => provider.name === base).length;
  return duplicates > 0 ? `${base} · ${duplicates + 1}` : base;
}

/** 从探测结果创建新实例（未配置渠道的"检测并启用"）。 */
export function createProviderFromAutoConfiguration(params: {
  preset: ProviderPreset;
  name: string;
  apiKey: string;
  auto: AutoConfiguration;
}): CustomProvider {
  const { preset, auto } = params;
  const defaultEndpoint = auto.endpointConfigs[auto.defaultChatProtocol];
  const credentials = auto.credentials.length
    ? auto.credentials
    : [
        {
          id: DEFAULT_CREDENTIAL_ID,
          label: "",
          apiKey: params.apiKey,
          apiKeyConfigured: params.apiKey.length > 0,
          enabled: true,
          modelScope: { mode: "auto" as const },
        },
      ];
  return normalizeCustomProvider({
    id: createUuid(),
    name: params.name,
    presetId: preset.id,
    enabled: true,
    baseUrl: defaultEndpoint?.baseUrl ?? "",
    isFullUrl: defaultEndpoint?.isFullUrl === true,
    apiKey: credentials[0]?.apiKey ?? "",
    apiKeyConfigured: Boolean(credentials[0]?.apiKey),
    credentials,
    customHeaders: [],
    models: auto.models,
    activeModels: auto.activeModels,
    defaultChatProtocol: auto.defaultChatProtocol,
    ...(auto.dialect ? { dialect: auto.dialect } : {}),
    endpointConfigs: auto.endpointConfigs,
    reasoning: "off",
    promptCachingEnabled: true,
    nativeWebSearchEnabled: true,
    useSystemProxy: false,
    usageQuery: getDefaultUsageQueryConfig(),
  });
}

/** "添加渠道"对话框：按用户填写的端点直接创建实例，模型待探测。 */
export type NewProviderApiKey = { key: string; label?: string };

/**
 * 添加渠道对话框的多 Key 输入 → credentials[]：空 Key 行剔除，第一把即主 Key
 *（provider.apiKey 与 credentials[0].apiKey 同步），modelScope 缺省 auto。
 * 一把都没填时仍生成一条空的默认凭据（本地服务可无 Key）。
 */
export function credentialsFromApiKeys(
  apiKeys: readonly NewProviderApiKey[] | undefined,
  fallbackApiKey = "",
): ProviderCredential[] {
  const filled = (apiKeys ?? [])
    .map((item) => ({ apiKey: item.key.trim(), label: item.label?.trim() ?? "" }))
    .filter((item) => item.apiKey.length > 0);
  const primary = filled[0]?.apiKey ?? fallbackApiKey.trim();
  const rows = filled.length > 0 ? filled : [{ apiKey: primary, label: "" }];
  return rows.map((item, index) => ({
    id: index === 0 ? DEFAULT_CREDENTIAL_ID : createUuid(),
    label: item.label,
    apiKey: item.apiKey,
    apiKeyConfigured: item.apiKey.length > 0,
    enabled: true,
    modelScope: { mode: "auto" as const },
  }));
}

export function createProviderFromEndpoints(params: {
  name: string;
  preset: ProviderPreset | undefined;
  /** 单 Key 旧调用；与 apiKeys 同时给时只在 apiKeys 全空时兜底 */
  apiKey?: string;
  /** 多 Key：第一把即主 Key */
  apiKeys?: readonly NewProviderApiKey[];
  endpoints: Partial<Record<ProviderChatProtocol, string>>;
}): CustomProvider {
  const { preset } = params;
  const filled = PROVIDER_CHAT_PROTOCOLS.filter((protocol) => params.endpoints[protocol]?.trim());
  const order: ProviderChatProtocol[] = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ];
  const defaultChatProtocol =
    preset && filled.includes(preset.defaultChatProtocol)
      ? preset.defaultChatProtocol
      : (order.find((protocol) => filled.includes(protocol)) ?? "openai-completions");
  const endpointConfigs: NonNullable<CustomProvider["endpointConfigs"]> = {};
  for (const protocol of filled) {
    const presetEndpoint = preset?.endpoints[protocol];
    const dialect = presetEndpoint?.dialect;
    const quirks = presetEndpoint?.quirks;
    const auth = presetEndpoint?.auth;
    const modelsUrl = presetEndpoint?.modelsUrl;
    endpointConfigs[protocol] = {
      baseUrl: params.endpoints[protocol]?.trim() ?? "",
      ...(dialect ? { dialect } : {}),
      ...(quirks ? { quirks } : {}),
      ...(auth ? { auth } : {}),
      ...(modelsUrl ? { modelsUrl } : {}),
      source: presetEndpoint ? "auto" : "user",
    };
  }
  const providerDialect = preset?.dialect;
  const credentials = credentialsFromApiKeys(params.apiKeys, params.apiKey ?? "");
  const apiKey = credentials[0].apiKey;
  return normalizeCustomProvider({
    id: createUuid(),
    name: params.name.trim(),
    presetId: preset?.id ?? CUSTOM_PRESET_ID,
    enabled: true,
    baseUrl: endpointConfigs[defaultChatProtocol]?.baseUrl ?? "",
    isFullUrl: false,
    apiKey,
    apiKeyConfigured: apiKey.length > 0,
    credentials,
    customHeaders: [],
    models: [],
    activeModels: [],
    defaultChatProtocol,
    ...(providerDialect ? { dialect: providerDialect } : {}),
    endpointConfigs,
    reasoning: "off",
    promptCachingEnabled: true,
    nativeWebSearchEnabled: true,
    useSystemProxy: false,
    usageQuery: getDefaultUsageQueryConfig(),
  });
}
