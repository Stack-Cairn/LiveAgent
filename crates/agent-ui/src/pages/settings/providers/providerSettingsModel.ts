// 供应商设置页的纯函数层：把 CustomProvider 的读写收敛到这里，界面组件只描述
// 布局与交互。所有写入都经 normalizeCustomProvider，保证与存档格式一致
// （设计文档 2.3 / 5.4 / 5.5 / 7）。

import {
  type CustomProvider,
  credentialCoversModel,
  getDefaultUsageQueryConfig,
  getLegacyProviderChatProtocol,
  getProviderChatProtocolAdapter,
  getProviderCredentials,
  getProviderEnabledProtocols,
  normalizeCustomProvider,
  PROVIDER_CHAT_PROTOCOLS,
  type ProviderChatProtocol,
  type ProviderCredential,
  type ProviderEndpointConfig,
  type ProviderEndpointProbe,
  type ProviderId,
  type ProviderModelConfig,
  resolveProviderChatRoute,
  resolveProviderDialect,
} from "@liveagent/app/lib/settings";
import type { CliIdentityProviderId } from "@liveagent/ui/lib/providers/customHeaders";
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

export function providerDefaultProtocol(
  provider: Pick<CustomProvider, "type" | "defaultChatProtocol" | "requestFormat">,
): ProviderChatProtocol {
  return (
    provider.defaultChatProtocol ??
    getLegacyProviderChatProtocol(provider.type, provider.requestFormat)
  );
}

export type EndpointView = {
  protocol: ProviderChatProtocol;
  /** false = 主连接充当该协议的隐式端点（尚未物化成 endpointConfigs 条目） */
  explicit: boolean;
  config: ProviderEndpointConfig;
};

/** 读取某协议的端点：显式配置，或默认协议由主连接充当的隐式端点。 */
export function readEndpoint(
  provider: CustomProvider,
  protocol: ProviderChatProtocol,
): EndpointView | undefined {
  const explicit = provider.endpointConfigs?.[protocol];
  if (explicit) return { protocol, explicit: true, config: explicit };
  if (protocol !== providerDefaultProtocol(provider)) return undefined;
  return {
    protocol,
    explicit: false,
    config: {
      baseUrl: provider.baseUrl,
      ...(provider.isFullUrl ? { isFullUrl: true } : {}),
      ...(provider.modelsUrl ? { modelsUrl: provider.modelsUrl } : {}),
    },
  };
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

/** 显式 + 隐式端点合成的一份 endpointConfigs，供探测候选与请求配置抽屉使用。 */
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

/** 写端点：隐式端点先物化；用户改动标 user；默认接口同步回主连接。 */
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

export function credentialModelDiff(
  credential: ProviderCredential,
  primary: ProviderCredential,
): { more: number; less: number } {
  const own = new Set(credential.lastModels?.models ?? []);
  const base = new Set(primary.lastModels?.models ?? []);
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

export function adapterProviderIdForModel(provider: CustomProvider, modelId: string): ProviderId {
  return resolveProviderChatRoute(provider, modelId).adapterProviderId;
}

export function defaultAdapterProviderId(provider: CustomProvider): ProviderId {
  const protocol = providerDefaultProtocol(provider);
  return getProviderChatProtocolAdapter(protocol, resolveProviderDialect(provider, protocol));
}

/** "模拟 CLI"按钮的推荐身份档：按默认接口与方言决定。 */
export function identityForProvider(provider: CustomProvider): CliIdentityProviderId {
  const protocol = providerDefaultProtocol(provider);
  if (protocol === "anthropic-messages") return "claude_code";
  const dialect = resolveProviderDialect(provider, protocol, {
    endpoint: readEndpoint(provider, protocol)?.config,
  });
  return dialect === "xai" ? "xai" : "codex";
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
 * - configure 模式下探测失败且为自动来源的端点停用；refresh 只记录观测；
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
    if (autoConfig) {
      endpointConfigs[protocol] = {
        ...existing,
        ...autoConfig,
        ...(existing?.headers ? { headers: existing.headers } : {}),
        ...(existing?.credentialId ? { credentialId: existing.credentialId } : {}),
        ...(existing?.enabled === false && mode === "refresh" ? { enabled: false } : {}),
        source: existing?.source ?? autoConfig.source,
        lastProbe,
      };
      continue;
    }
    if (!existing) continue;
    const disable = mode === "configure" && existing.source !== "user" && lastProbe.status !== "ok";
    endpointConfigs[protocol] = {
      ...existing,
      ...(disable ? { enabled: false } : {}),
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
  category?: CustomProvider["category"];
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
    category: params.category ?? preset.category,
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
export function createProviderFromEndpoints(params: {
  name: string;
  preset: ProviderPreset | undefined;
  category: CustomProvider["category"];
  apiKey: string;
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
    endpointConfigs[protocol] = {
      baseUrl: params.endpoints[protocol]?.trim() ?? "",
      ...(presetEndpoint?.dialect ? { dialect: presetEndpoint.dialect } : {}),
      ...(presetEndpoint?.quirks ? { quirks: presetEndpoint.quirks } : {}),
      ...(presetEndpoint?.auth ? { auth: presetEndpoint.auth } : {}),
      ...(presetEndpoint?.modelsUrl ? { modelsUrl: presetEndpoint.modelsUrl } : {}),
      source: presetEndpoint ? "auto" : "user",
    };
  }
  const apiKey = params.apiKey.trim();
  return normalizeCustomProvider({
    id: createUuid(),
    name: params.name.trim(),
    presetId: preset?.id ?? CUSTOM_PRESET_ID,
    category: params.category,
    enabled: true,
    baseUrl: endpointConfigs[defaultChatProtocol]?.baseUrl ?? "",
    isFullUrl: false,
    apiKey,
    apiKeyConfigured: apiKey.length > 0,
    credentials: [
      {
        id: DEFAULT_CREDENTIAL_ID,
        label: "",
        apiKey,
        apiKeyConfigured: apiKey.length > 0,
        enabled: true,
        modelScope: { mode: "auto" },
      },
    ],
    customHeaders: [],
    models: [],
    activeModels: [],
    defaultChatProtocol,
    ...(preset?.dialect ? { dialect: preset.dialect } : {}),
    endpointConfigs,
    reasoning: "off",
    promptCachingEnabled: true,
    nativeWebSearchEnabled: true,
    useSystemProxy: false,
    usageQuery: getDefaultUsageQueryConfig(),
  });
}
