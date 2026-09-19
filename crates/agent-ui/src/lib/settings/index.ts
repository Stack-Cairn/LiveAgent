import { detectSystemLocale, normalizeLocale } from "@liveagent/app/i18n/config";
import {
  ANTHROPIC_LONG_CONTEXT_WINDOW,
  ANTHROPIC_STANDARD_CONTEXT_WINDOW,
  hasAnthropicLongContextSuffix,
  isAnthropicAdaptiveModelId,
  resolveAnthropicContextWindow,
  resolveAnthropicKnownModelLimits,
  shouldSendAnthropicLongContextHeader,
} from "@liveagent/ui/lib/models/anthropicContext";
import {
  extractProviderDeclaredLimits,
  getProviderFallbackLimits,
  type ModelLimits,
  normalizeModelLimits,
  resolveModelLimits,
  resolveModelLimitsAcrossProviders,
} from "@liveagent/ui/lib/models/modelCatalog";
import { normalizeModelParameters } from "@liveagent/ui/lib/models/modelParameters";
import {
  clampThinkingLevelToList,
  resolveModelThinking,
  type ThinkingLevel,
} from "@liveagent/ui/lib/models/modelThinking";
// --- image generation (begin) -----------------------------------------------
import { isImageGenerationModel } from "@liveagent/ui/lib/models/modelType";
// --- image generation (end) -------------------------------------------------
import { isEndpointIdentity } from "@liveagent/ui/lib/providers/customHeaders";
import {
  CUSTOM_PRESET_ID,
  coerceDialectForProtocol,
  findProviderPreset,
  inferDialectFromBaseUrl,
  inferEndpointQuirksFromBaseUrl,
  isProviderChatProtocol,
  isProviderWireDialect,
  legacyTypeForPreset,
  matchPresetModelRule,
  normalizeOrigin,
  type PresetModelRule,
  type ProviderPreset,
  presetIdForLegacyProvider,
  presetMatchesBaseUrl,
  resolveEndpointRequestBase,
  resolveModelFamily,
  stripModelVendorPrefix,
} from "@liveagent/ui/lib/providers/registry";
import {
  normalizeApiKey,
  normalizeBaseUrl,
  normalizeModels,
} from "@liveagent/ui/lib/settings/normalize";
import { normalizeFontFamily } from "@liveagent/ui/lib/shared/fontFamily";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { mergeAlwaysEnabledSkillNames } from "@liveagent/ui/lib/skills/builtin";
import {
  DEFAULT_CHAT_TRANSCRIPT_WIDTH,
  MAX_CHAT_TRANSCRIPT_WIDTH,
  MIN_CHAT_TRANSCRIPT_WIDTH,
} from "@liveagent/ui/lib/transcript-width/transcriptWidthModel";
import { normalizeModelFailoverSettings } from "./modelFailover";
import {
  normalizeChatTranscriptSettings,
  normalizeFontScaleSettings,
  normalizeIntegerInRange,
  normalizePositiveInteger,
  normalizeStringArray,
} from "./normalizers";
import { normalizeRetryErrorSettings } from "./retryError";
import {
  DEFAULT_RIGHT_DOCK_FILE_TREE_STATE,
  normalizeRightDockFileTreeExpandedPaths,
  normalizeRightDockFileTreeSearchQuery,
  normalizeRightDockFileTreeState,
  normalizeRightDockProjectState,
  normalizeRightDockSettings,
  RIGHT_DOCK_SINGLETON_TAB_IDS,
} from "./rightDockNormalization";
import { normalizeSidebarShortcuts } from "./sidebarShortcuts";
import {
  computeNextMemoryOrganizerRunAt,
  normalizeMemoryOrganizerMode,
  normalizeMemoryOrganizerSchedule,
  normalizeMemoryOrganizerScope,
  normalizeOptionalTimestamp,
  normalizeTheme,
} from "./themeAndMemory";
import type {
  AgentPromptTemplate,
  AppSettings,
  BrowserAutomationMode,
  CapabilityState,
  ChatCapabilityName,
  ChatRuntimeControls,
  ChatRuntimeReasoningProviderKey,
  CloseWindowBehavior,
  CodexRequestFormat,
  CommandSafetyMode,
  CustomProvider,
  CustomSettings,
  EffectivePromptSettings,
  EffectiveWorkspaceResources,
  ExecutionMode,
  // --- image generation (begin) ---
  ImageGenerationSettings,
  McpAuthConfig,
  McpServerConfig,
  McpSettings,
  McpTransport,
  MemorySettings,
  ModelInputModalitiesOverride,
  ModelInputModality,
  ModelLimitsSource,
  ModelType,
  // --- image generation (end) ---
  ProjectPromptStrategy,
  PromptCacheHintMode,
  ProviderChatProtocol,
  ProviderCredential,
  ProviderCredentialScope,
  ProviderDeclaredModelMeta,
  ProviderEndpointAuth,
  ProviderEndpointConfig,
  ProviderEndpointProbe,
  ProviderEndpointQuirks,
  ProviderFailoverSettings,
  ProviderId,
  ProviderModelConfig,
  ProviderOrigin,
  ProviderProtocolFamily,
  ProviderRetryPolicy,
  ProviderRouteCredentialSource,
  ProviderRouteProtocolSource,
  ProviderThinkingFormat,
  ProviderWireDialect,
  ReasoningLevel,
  RemoteSettings,
  ResolvedProviderChatRoute,
  RightDockFileTreeState,
  RightDockFileTreeStatePatch,
  RightDockProjectState,
  RightDockToolKind,
  RightDockToolTab,
  SelectedModel,
  SkillsSettings,
  SshAuthType,
  SshHostConfig,
  SshProxyConfig,
  SshProxyType,
  SshSettings,
  SttProviderId,
  SttProviderSettings,
  SttSettings,
  SystemProxyConfig,
  SystemSettings,
  ToolPolicy,
  UpdateSettings,
  UsageQueryCodingPlanProvider,
  UsageQueryConfig,
  UsageQueryMode,
  UsageQueryScripts,
  WorkspaceResourceSettings,
} from "./types";
import {
  BROWSER_AUTOMATION_MODES,
  CHAT_CAPABILITY_NAMES,
  COMMAND_SAFETY_MODES,
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  endpointUsesOrigin,
  expandProviderOriginUrl,
  getDefaultUsageQueryConfig,
  getLegacyProviderChatProtocol,
  getProviderImplicitChatProtocol,
  getProviderPrimaryOrigin,
  isProviderChatProtocolEnabled,
  MODEL_INPUT_MODALITIES,
  // --- image generation (begin) ---
  MODEL_TYPES,
  // --- image generation (end) ---
  PROMPT_CACHE_HINT_MODES,
  PROVIDER_CHAT_PROTOCOLS,
  PROVIDER_PROTOCOL_FAMILY,
  PROVIDER_RETRY_MAX_RETRIES_LIMITS,
  PROVIDER_THINKING_FORMATS,
  RIGHT_DOCK_BACKGROUND_TASKS_TAB_ID,
  RIGHT_DOCK_TOOL_KINDS,
  USAGE_QUERY_TIMEOUT_DEFAULT_SECS,
  USAGE_QUERY_TIMEOUT_MAX_SECS,
  USAGE_QUERY_TIMEOUT_MIN_SECS,
} from "./types";
import {
  assignNormalizedProjectKeyValue,
  normalizeArchivedWorkspaceProjectPaths,
  normalizeHiddenWorkspaceProjectPaths,
  normalizeMissingWorkspaceProjectPaths,
  normalizeRightDockFileTreePath,
  normalizeWorkdir,
  normalizeWorkspaceProjectGroups,
  normalizeWorkspaceProjects,
  normalizeWorkspaceResourceSettings,
  normalizeWorkspaceResourceSettingsEntry,
  workspaceProjectPathKey,
} from "./workspaceProjects";

export { normalizeFontFamily } from "@liveagent/ui/lib/shared/fontFamily";
export type { WorkspaceProjectGroup } from "@liveagent/ui/lib/workspaceProjectTypes";
export {
  hasProviderFailoverConfiguration,
  normalizeModelFailoverSettings,
  normalizeProviderFailoverSettings,
  providerFailoverFamilies,
} from "./modelFailover";
export {
  normalizeChatTranscriptSettings,
  normalizeFontScale,
  normalizeFontScaleSettings,
} from "./normalizers";
export { normalizeRetryErrorSettings } from "./retryError";
export {
  DEFAULT_RIGHT_DOCK_FILE_TREE_STATE,
  normalizeRightDockBackgroundTasksState,
  normalizeRightDockFileTreeState,
  normalizeRightDockProjectState,
  normalizeRightDockSettings,
  normalizeRightDockTabOrder,
  RIGHT_DOCK_SINGLETON_TAB_IDS,
  rightDockToolKindForTabId,
} from "./rightDockNormalization";
export {
  computeNextMemoryOrganizerRunAt,
  getDefaultMemoryOrganizerSchedule,
  getNextTheme,
  normalizeTheme,
  resolveEffectiveTheme,
  subscribeToSystemThemePreference,
} from "./themeAndMemory";
export * from "./types";
export {
  normalizeArchivedWorkspaceProjectPaths,
  normalizeHiddenWorkspaceProjectPaths,
  normalizeMissingWorkspaceProjectPaths,
  normalizeRightDockFileTreePath,
  normalizeWorkspaceProjectPath,
  normalizeWorkspaceResourceSettings,
  resolveWorkspaceProjects,
  workspaceProjectPathKey,
} from "./workspaceProjects";

export function isThinkingAlwaysOnForModel(
  providerId: ProviderId,
  modelId: string | undefined,
): boolean {
  return resolveModelThinking(providerId, modelId).alwaysOn;
}

// Bounds live with the geometry that enforces them; re-exported here so
// settings consumers keep a single import site.
export { DEFAULT_CHAT_TRANSCRIPT_WIDTH, MAX_CHAT_TRANSCRIPT_WIDTH, MIN_CHAT_TRANSCRIPT_WIDTH };

const CODEX_RESPONSES_SUFFIX = "/responses";
const CODEX_RESPONSE_SUFFIX = "/response";
const CODEX_CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const DEFAULT_MCP_TIMEOUT_MS = 60_000;

function normalizeCodexRequestFormat(input: unknown): CodexRequestFormat | undefined {
  switch (input) {
    case "openai-completions":
    case "openai-responses":
      return input;
    default:
      return undefined;
  }
}

export function normalizeProviderChatProtocol(input: unknown): ProviderChatProtocol | undefined {
  return normalizeLegacyProtocolInput(input)?.protocol;
}

/**
 * 接口取值归一化。开发分支曾用 "deepseek-responses" 表示"Responses + DeepSeek 方言"，
 * 现在改写为四类接口之一并带出方言。
 */
export function normalizeLegacyProtocolInput(
  input: unknown,
): { protocol: ProviderChatProtocol; dialect?: ProviderWireDialect } | undefined {
  if (input === "deepseek-responses") return { protocol: "openai-responses", dialect: "deepseek" };
  return isProviderChatProtocol(input) ? { protocol: input } : undefined;
}

export function normalizeProviderWireDialect(input: unknown): ProviderWireDialect | undefined {
  return isProviderWireDialect(input) ? input : undefined;
}

/** 旧供应商类型隐含的方言（xAI / DeepSeek 原生渠道、Codex 分组的 OpenAI 官方语义）。 */
export function getLegacyProviderDialect(providerId: ProviderId): ProviderWireDialect | undefined {
  if (providerId === "xai") return "xai";
  if (providerId === "deepseek") return "deepseek";
  if (providerId === "codex") return "openai";
  return undefined;
}

/**
 * （协议, 方言）→ 旧适配器家族。过渡期运行时仍按 ProviderId 分支选择鉴权、payload
 * 策略与模型工厂；新读取点应改读 protocol 与 dialect。
 */
export function getProviderChatProtocolAdapter(
  protocol: ProviderChatProtocol,
  dialect: ProviderWireDialect,
): ProviderId {
  switch (protocol) {
    case "anthropic-messages":
      return "claude_code";
    case "google-generative-ai":
      return "gemini";
    case "openai-responses":
      if (dialect === "xai") return "xai";
      if (dialect === "deepseek") return "deepseek";
      return "codex";
    case "openai-completions":
      return "codex";
  }
}

type RouteProvider = Pick<CustomProvider, "type" | "baseUrl" | "isFullUrl"> &
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
      | "customHeaders"
      | "apiKey"
      | "apiKeyConfigured"
      | "credentials"
      | "origins"
    >
  >;

export type ResolvedProviderEndpoint = {
  protocol: ProviderChatProtocol;
  /** false = 主连接充当该协议的隐式端点（config 由 baseUrl / isFullUrl / modelsUrl 物化） */
  explicit: boolean;
  /** 地址已按源展开（`{origin}` 占位替换成选中源的地址）；存档里的模板不变。 */
  config: ProviderEndpointConfig;
  /** 端点地址由哪个源展开；绝对地址的端点没有。 */
  originId?: string;
  originUrl?: string;
};

/**
 * 端点地址按源展开。地址不含 `{origin}` 时原样返回（不带源）；含占位而没有可用的源时
 * 返回 undefined（端点不可用）。
 */
function expandEndpointConfigOrigin(
  provider: Pick<RouteProvider, "origins">,
  config: ProviderEndpointConfig,
  originId?: string,
): { config: ProviderEndpointConfig; origin?: ProviderOrigin } | undefined {
  if (!endpointUsesOrigin(config.baseUrl) && !endpointUsesOrigin(config.modelsUrl)) {
    return { config };
  }
  const origin = getProviderPrimaryOrigin(provider, originId);
  if (!origin) return undefined;
  const baseUrl = expandProviderOriginUrl(config.baseUrl, origin);
  const modelsUrl = expandProviderOriginUrl(config.modelsUrl, origin);
  return {
    config: { ...config, baseUrl, ...(modelsUrl ? { modelsUrl } : { modelsUrl: undefined }) },
    origin,
  };
}

function providerLegacyProtocol(provider: RouteProvider): ProviderChatProtocol {
  return getLegacyProviderChatProtocol(provider.type, provider.requestFormat);
}

/**
 * 主连接物化成一条端点配置。隐式端点与显式端点从此走同一条读取路径，界面与路由
 * 不再各自拼接主连接字段。
 */
function primaryConnectionEndpoint(
  provider: RouteProvider,
  isFullUrl: boolean = provider.isFullUrl,
): ProviderEndpointConfig {
  // 主连接归一化后总是绝对地址；这里再展开一次只为容错未归一化的快照。
  const origin = getProviderPrimaryOrigin(provider);
  const modelsUrl = expandProviderOriginUrl(provider.modelsUrl, origin);
  return {
    baseUrl: expandProviderOriginUrl(provider.baseUrl, origin),
    ...(isFullUrl ? { isFullUrl: true } : {}),
    ...(modelsUrl ? { modelsUrl } : {}),
    source: "user",
  };
}

/**
 * 某协议在该供应商上的端点：显式端点未关闭时返回它；没有显式端点但它是隐式接口
 * （`defaultChatProtocol ?? 旧推导`）时返回由主连接物化的配置；否则不可用。
 */
export function resolveProviderEndpoint(
  provider: RouteProvider,
  protocol: ProviderChatProtocol,
  implicitProtocol: ProviderChatProtocol = getProviderImplicitChatProtocol(provider),
  options?: { originId?: string },
): ResolvedProviderEndpoint | undefined {
  if (!isProviderChatProtocolEnabled(provider, protocol, implicitProtocol)) return undefined;
  const stored = provider.endpointConfigs?.[protocol];
  const expanded = expandEndpointConfigOrigin(
    provider,
    stored ?? primaryConnectionEndpoint(provider),
    options?.originId,
  );
  if (!expanded) return undefined;
  return {
    protocol,
    explicit: stored !== undefined,
    config: expanded.config,
    ...(expanded.origin ? { originId: expanded.origin.id, originUrl: expanded.origin.url } : {}),
  };
}

/** 供应商已启用的接口（有序：默认接口在前，其余按四类固定顺序）。 */
export function getProviderEnabledProtocols(provider: RouteProvider): ProviderChatProtocol[] {
  const implicitProtocol = getProviderImplicitChatProtocol(provider);
  const out: ProviderChatProtocol[] = [];
  for (const protocol of [implicitProtocol, ...PROVIDER_CHAT_PROTOCOLS]) {
    if (out.includes(protocol)) continue;
    if (isProviderChatProtocolEnabled(provider, protocol, implicitProtocol)) out.push(protocol);
  }
  return out;
}

export type ProtocolDecision = {
  protocol: ProviderChatProtocol;
  source: ProviderRouteProtocolSource;
};

/** 路由各步骤共用的上下文：预设、模型规则、旧推导与隐式接口在入口只算一次。 */
export type ProviderRouteContext = {
  preset: ProviderPreset | undefined;
  rule: PresetModelRule | undefined;
  legacyProtocol: ProviderChatProtocol;
  implicitProtocol: ProviderChatProtocol;
};

export function buildProviderRouteContext(
  provider: RouteProvider,
  modelId: string,
): ProviderRouteContext {
  const preset = findProviderPreset(provider.presetId);
  const legacyProtocol = providerLegacyProtocol(provider);
  return {
    preset,
    rule: matchPresetModelRule(preset, modelId),
    legacyProtocol,
    implicitProtocol: provider.defaultChatProtocol ?? legacyProtocol,
  };
}

/**
 * 接口的决定顺序（设计文档 4.2）：模型显式列表 > 预设按模型规则 > 模型家族偏好 ∩
 * 已启用渠道 > 供应商默认接口 > 旧推导。每一步都跳过被关闭的渠道。
 */
export function resolveModelRouteProtocol(
  provider: RouteProvider,
  modelId: string,
  model?: Pick<ProviderModelConfig, "chatProtocol">,
  context: ProviderRouteContext = buildProviderRouteContext(provider, modelId),
): ProtocolDecision {
  const { implicitProtocol } = context;
  const available = (protocol: ProviderChatProtocol | undefined) =>
    protocol && isProviderChatProtocolEnabled(provider, protocol, implicitProtocol)
      ? protocol
      : undefined;
  const firstAvailable = (list: readonly ProviderChatProtocol[] | undefined) =>
    list?.map((item) => available(item)).find((item) => item !== undefined);

  const explicit = available(model?.chatProtocol);
  if (explicit) return { protocol: explicit, source: "model" };

  const fromPreset = firstAvailable(context.rule?.chatProtocols);
  if (fromPreset) return { protocol: fromPreset, source: "preset" };

  const fromFamily = firstAvailable(resolveModelFamily(modelId).prefer);
  if (fromFamily) return { protocol: fromFamily, source: "family" };

  const fromProvider = available(provider.defaultChatProtocol);
  if (fromProvider) return { protocol: fromProvider, source: "provider" };

  const legacy = context.legacyProtocol;
  return { protocol: available(legacy) ?? legacy, source: "legacy" };
}

/**
 * 模型在该渠道可显式选用的接口集合（设计文档 4.10）：
 * - 原生渠道（Anthropic / OpenAI / Gemini / xAI / DeepSeek）：预设声明的接口。Anthropic 与
 *   Gemini 各只有一个，OpenAI 与 xAI 在 Completions / Responses 之间切换。
 * - 其它渠道（厂商、中转、自建、自定义）：OpenAI 两类 + Anthropic Messages；只有 Gemini
 *   系列模型再加 google-generative-ai。
 * 返回顺序与 PROVIDER_CHAT_PROTOCOLS 一致；是否已配置地址由调用方另行判断。
 */
export function modelSelectableProtocols(
  provider: Pick<CustomProvider, "presetId">,
  modelId: string,
): ProviderChatProtocol[] {
  const preset = findProviderPreset(provider.presetId);
  if (preset?.native) {
    const declared = PROVIDER_CHAT_PROTOCOLS.filter((protocol) => preset.endpoints[protocol]);
    if (declared.length > 0) return declared;
  }
  const gemini = resolveModelFamily(modelId).key === "gemini";
  return PROVIDER_CHAT_PROTOCOLS.filter((protocol) =>
    protocol === "google-generative-ai" ? gemini : true,
  );
}

export function resolveProviderDialect(
  provider: RouteProvider,
  protocol: ProviderChatProtocol,
  options?: {
    model?: Pick<ProviderModelConfig, "dialect">;
    endpoint?: Pick<ProviderEndpointConfig, "dialect" | "baseUrl">;
    /** 调用方已算好的路由上下文；缺省按 presetId 查一次预设 */
    context?: Pick<ProviderRouteContext, "preset">;
  },
): ProviderWireDialect {
  const preset = options?.context ? options.context.preset : findProviderPreset(provider.presetId);
  // Codex 分组的"OpenAI 官方语义"只是缺省：直连 api.x.ai / api.deepseek.com 的旧配置
  // 仍按域名取 xai / deepseek 方言（与改造前 isXaiProviderTarget 的行为一致）。
  // 旧分组方言只对原生渠道与自定义 / 中转实例有意义；厂商预设（智谱、Kimi 等）
  // 的 codex 分组只是历史遗留，不该被当成"OpenAI 官方"语义。
  const legacyApplies = !preset || preset.native || preset.id === CUSTOM_PRESET_ID;
  const legacyDialect = legacyApplies ? getLegacyProviderDialect(provider.type) : undefined;
  const inferredDialect = inferDialectFromBaseUrl(
    protocol,
    options?.endpoint?.baseUrl || provider.baseUrl,
  );
  // "openai" 只表示 OpenAI 官方语义的缺省：预设或旧分组给出 openai 时，端点域名
  // 若明确是 xAI / DeepSeek 官方，以域名为准。
  // 只有 xAI 保留"域名推翻 openai 缺省"的旧行为（改造前 isXaiProviderTarget 就按
  // api.x.ai 识别）；DeepSeek 官方地址挂在 OpenAI 分组下时维持标准 OpenAI 链路，
  // 避免存量会话的 provider 身份变化。
  const softOpenAI = (dialect: ProviderWireDialect | undefined) =>
    dialect === "openai" && inferredDialect === "xai" ? inferredDialect : dialect;
  const candidate =
    options?.model?.dialect ??
    options?.endpoint?.dialect ??
    provider.dialect ??
    softOpenAI(preset?.dialect) ??
    softOpenAI(legacyDialect) ??
    inferredDialect ??
    "generic";
  return coerceDialectForProtocol(protocol, candidate);
}

const DEFAULT_CREDENTIAL_ID = "default";

/** 凭据列表；旧存档只有 apiKey 时视为单把默认凭据。 */
export function getProviderCredentials(
  provider: Partial<Pick<CustomProvider, "apiKey" | "apiKeyConfigured" | "credentials">>,
): ProviderCredential[] {
  if (provider.credentials && provider.credentials.length > 0) return provider.credentials;
  return [
    {
      id: DEFAULT_CREDENTIAL_ID,
      label: "",
      apiKey: provider.apiKey ?? "",
      apiKeyConfigured: provider.apiKeyConfigured === true || Boolean(provider.apiKey),
      enabled: true,
    },
  ];
}

function credentialScopeMatches(pattern: string, id: string, stripped: string): boolean {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return id.startsWith(prefix) || stripped.startsWith(prefix);
  }
  return id === pattern || stripped === pattern;
}

/** auto 范围的 lastModels 是精确 ID 集合：按对象缓存 Set，避免每次线性扫描。 */
const CREDENTIAL_LAST_MODELS_SETS = new WeakMap<
  NonNullable<ProviderCredential["lastModels"]>,
  ReadonlySet<string>
>();

function credentialLastModelSet(
  lastModels: NonNullable<ProviderCredential["lastModels"]>,
): ReadonlySet<string> {
  let set = CREDENTIAL_LAST_MODELS_SETS.get(lastModels);
  if (!set) {
    set = new Set(lastModels.models);
    CREDENTIAL_LAST_MODELS_SETS.set(lastModels, set);
  }
  return set;
}

/** 该 Key 的模型范围是否包含该模型（设计文档 5.6）。 */
export function credentialCoversModel(credential: ProviderCredential, modelId: string): boolean {
  const scope = credential.modelScope ?? { mode: "auto" };
  if (scope.mode === "all") return true;
  const id = modelId.trim();
  const stripped = stripModelVendorPrefix(id);
  if (scope.mode === "manual") {
    return scope.models.some((pattern) => credentialScopeMatches(pattern, id, stripped));
  }
  const lastModels = credential.lastModels;
  if (!lastModels || lastModels.models.length === 0) return true;
  const known = credentialLastModelSet(lastModels);
  return known.has(id) || known.has(stripped);
}

export function selectProviderCredential(
  provider: Partial<Pick<CustomProvider, "apiKey" | "apiKeyConfigured" | "credentials">>,
  modelId: string,
  preferred?: { credentialId?: string; source: ProviderRouteCredentialSource }[],
): { credential: ProviderCredential; source: ProviderRouteCredentialSource } {
  const all = getProviderCredentials(provider);
  const enabled = all.filter((credential) => credential.enabled);
  if (enabled.length === 0) {
    // 全部 Key 都被停用：不能拿被停用的 Key 发请求，交给运行时按"未配置 Key"报错。
    return {
      credential: { ...all[0], apiKey: "", apiKeyConfigured: false },
      source: "fallback",
    };
  }
  for (const item of preferred ?? []) {
    if (!item.credentialId) continue;
    const hit = enabled.find((credential) => credential.id === item.credentialId);
    if (hit && credentialCoversModel(hit, modelId)) return { credential: hit, source: item.source };
  }
  const inScope = enabled.find((credential) => credentialCoversModel(credential, modelId));
  if (inScope) return { credential: inScope, source: "scope" };
  return { credential: enabled[0], source: "fallback" };
}

function mergeHeaderLists(
  ...layers: (readonly { key: string; value: string }[] | undefined)[]
): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const layer of layers) {
    for (const header of layer ?? []) {
      const key = header.key.trim();
      if (!key) continue;
      const index = out.findIndex((item) => item.key.toLowerCase() === key.toLowerCase());
      if (index >= 0) out.splice(index, 1);
      out.push({ key, value: header.value });
    }
  }
  return out;
}

/**
 * 解析一个模型的唯一路由（设计文档 4.1）。纯函数：输出协议、方言、地址、远端模型 ID、
 * 凭据与合并后的用户头；凭据值不进入结果，运行时按 credentialId 取值。
 * 在 createProviderRuntimeConfig 构造运行时配置时调用一次；界面侧只读
 * protocol / dialect / protocolSource。
 */
export function resolveProviderChatRoute(
  provider: RouteProvider,
  modelId: string,
  options?: {
    protocol?: ProviderChatProtocol;
    credentialId?: string;
    /** 故障转移源层：强制用指定的源展开 `{origin}` 端点；缺省主源 */
    originId?: string;
  },
): ResolvedProviderChatRoute {
  // Some gateway call sites can still receive a pre-normalization provider
  // snapshot (and older snapshots did not require `models`). Keep this
  // resolver tolerant at that boundary.
  const model = provider.models?.find((item) => item.id === modelId);
  const context = buildProviderRouteContext(provider, modelId);
  const decision = options?.protocol
    ? { protocol: options.protocol, source: "model" as const }
    : resolveModelRouteProtocol(provider, modelId, model, context);
  const protocol = decision.protocol;
  // 端点是唯一真相：显式端点或由主连接物化的隐式端点。被强制指定的接口未配置 /
  // 渠道全部关闭时退回主连接，完整 URL 模式只对主连接自己的接口有意义。
  const endpoint = resolveProviderEndpoint(provider, protocol, context.implicitProtocol, {
    originId: options?.originId,
  });
  const config =
    endpoint?.config ??
    primaryConnectionEndpoint(
      provider,
      protocol === context.implicitProtocol && provider.isFullUrl,
    );
  const dialect = resolveProviderDialect(provider, protocol, { model, endpoint: config, context });
  const presetEndpoint = context.preset?.endpoints[protocol];
  const credential = selectProviderCredential(provider, modelId, [
    { credentialId: options?.credentialId, source: "model" },
    { credentialId: model?.credentialId, source: "model" },
    { credentialId: config.credentialId, source: "endpoint" },
  ]);
  // 存档保留用户原值；路由结果给出已按接口补齐版本段（或按 # 原样）的请求根地址。
  const requestBase = resolveEndpointRequestBase(
    protocol,
    config.baseUrl,
    config.isFullUrl === true,
  );
  return {
    protocol,
    protocolSource: decision.source,
    family: PROVIDER_PROTOCOL_FAMILY[protocol],
    dialect,
    adapterProviderId: getProviderChatProtocolAdapter(protocol, dialect),
    baseUrl: requestBase.base,
    isFullUrl: config.isFullUrl === true,
    ...(requestBase.verbatim ? { baseUrlVerbatim: true as const } : {}),
    ...(config.modelsUrl ? { modelsUrl: config.modelsUrl } : {}),
    ...(endpoint?.originId ? { originId: endpoint.originId, originUrl: endpoint.originUrl } : {}),
    ...(protocol === "openai-completions" || protocol === "openai-responses"
      ? { requestFormat: protocol }
      : {}),
    wireModelId: model?.wireModelId?.trim() || context.rule?.wireModelId || modelId,
    credentialId: credential.credential.id,
    credentialSource: credential.source,
    headers: mergeHeaderLists(provider.customHeaders, config.headers),
    quirks: {
      ...inferEndpointQuirksFromBaseUrl(protocol, config.baseUrl),
      ...presetEndpoint?.quirks,
      ...config.quirks,
    },
    ...((config.auth ?? presetEndpoint?.auth)
      ? { auth: { ...presetEndpoint?.auth, ...config.auth } }
      : {}),
    ...(config.identity ? { identity: config.identity } : {}),
  };
}

function normalizePromptCacheHintMode(input: unknown): PromptCacheHintMode | undefined {
  return PROMPT_CACHE_HINT_MODES.find((mode) => mode === input);
}

function normalizeCodexRouting(
  baseUrlInput: unknown,
  requestFormatInput: unknown,
  isFullUrl = false,
): {
  baseUrl: string;
  requestFormat: CodexRequestFormat;
} {
  let baseUrl = normalizeBaseUrl(typeof baseUrlInput === "string" ? baseUrlInput : "");
  let requestFormat = normalizeCodexRequestFormat(requestFormatInput);
  const lower = baseUrl.toLowerCase();
  let routePath = lower;
  if (isFullUrl) {
    try {
      routePath = new URL(baseUrl).pathname.replace(/\/+$/, "").toLowerCase();
    } catch {
      // URL validation is handled by the request proxy; keep legacy suffix inference here.
    }
  }

  if (routePath.endsWith(CODEX_CHAT_COMPLETIONS_SUFFIX)) {
    if (!isFullUrl) baseUrl = baseUrl.slice(0, -CODEX_CHAT_COMPLETIONS_SUFFIX.length);
    requestFormat ??= "openai-completions";
  } else if (routePath.endsWith(CODEX_RESPONSES_SUFFIX)) {
    if (!isFullUrl) baseUrl = baseUrl.slice(0, -CODEX_RESPONSES_SUFFIX.length);
    requestFormat ??= "openai-responses";
  } else if (routePath.endsWith(CODEX_RESPONSE_SUFFIX)) {
    if (!isFullUrl) baseUrl = baseUrl.slice(0, -CODEX_RESPONSE_SUFFIX.length);
    requestFormat ??= "openai-responses";
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    requestFormat: requestFormat ?? "openai-responses",
  };
}

export function getBuiltinCustomProviders(): CustomProvider[] {
  return [
    {
      id: "builtin-claude_code",
      name: "Anthropic",
      type: "claude_code",
      baseUrl: "https://api.anthropic.com/v1",
      isFullUrl: false,
      apiKey: "",
      customHeaders: [],
      models: [],
      activeModels: [],
      reasoning: "off",
      promptCachingEnabled: true,
      nativeWebSearchEnabled: true,
      useSystemProxy: false,
      usageQuery: getDefaultUsageQueryConfig(),
    },
    {
      id: "builtin-codex",
      name: "OpenAI",
      type: "codex",
      baseUrl: "https://api.openai.com/v1",
      isFullUrl: false,
      apiKey: "",
      customHeaders: [],
      models: [],
      activeModels: [],
      requestFormat: "openai-responses",
      reasoning: "off",
      promptCachingEnabled: true,
      promptCacheHintMode: "auto",
      nativeWebSearchEnabled: true,
      useSystemProxy: false,
      usageQuery: getDefaultUsageQueryConfig(),
    },
    {
      id: "builtin-gemini",
      name: "Gemini",
      type: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      isFullUrl: false,
      apiKey: "",
      customHeaders: [],
      models: [],
      activeModels: [],
      reasoning: "off",
      promptCachingEnabled: false,
      nativeWebSearchEnabled: true,
      useSystemProxy: false,
      usageQuery: getDefaultUsageQueryConfig(),
    },
    {
      id: "builtin-xai",
      name: "Grok",
      type: "xai",
      baseUrl: "https://api.x.ai/v1",
      isFullUrl: false,
      apiKey: "",
      customHeaders: [],
      models: [],
      activeModels: [],
      requestFormat: "openai-responses",
      reasoning: "high",
      promptCachingEnabled: false,
      nativeWebSearchEnabled: true,
      useSystemProxy: false,
      usageQuery: getDefaultUsageQueryConfig(),
    },
    {
      id: "builtin-deepseek",
      name: "DeepSeek",
      type: "deepseek",
      baseUrl: "https://api.deepseek.com",
      isFullUrl: false,
      apiKey: "",
      customHeaders: [],
      models: [],
      activeModels: [],
      reasoning: "high",
      promptCachingEnabled: false,
      nativeWebSearchEnabled: true,
      useSystemProxy: false,
      usageQuery: getDefaultUsageQueryConfig(),
    },
  ];
}

function normalizeExecutionMode(input: unknown): ExecutionMode {
  switch (input) {
    case "text":
    case "tools":
    case "agent-dev":
      return input;
    default:
      return "tools";
  }
}

export function isAgentExecutionMode(mode: ExecutionMode): boolean {
  return mode !== "text";
}

export function isAgentDevMode(mode: ExecutionMode): boolean {
  return mode === "agent-dev";
}

const REASONING_LEVELS: ReasoningLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function normalizeReasoningLevel(input: unknown): ReasoningLevel {
  return typeof input === "string" && (REASONING_LEVELS as string[]).includes(input)
    ? (input as ReasoningLevel)
    : "off";
}

export function normalizeChatRuntimeReasoning(input: unknown): ReasoningLevel {
  return typeof input === "string" && (REASONING_LEVELS as string[]).includes(input)
    ? (input as ReasoningLevel)
    : DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning;
}

const CHAT_RUNTIME_REASONING_PROVIDER_KEYS: ChatRuntimeReasoningProviderKey[] = [
  "claude_code",
  "codex_openai_responses",
  "codex_openai_completions",
  "gemini",
  "xai",
  "deepseek",
];

export function getChatRuntimeReasoningProviderKey(params: {
  providerId?: ProviderId;
  requestFormat?: CodexRequestFormat;
}): ChatRuntimeReasoningProviderKey {
  if (!params.providerId || params.providerId === "claude_code") {
    return "claude_code";
  }
  if (params.providerId === "gemini") {
    return "gemini";
  }
  if (params.providerId === "xai") {
    return "xai";
  }
  if (params.providerId === "deepseek") {
    return "deepseek";
  }
  if (params.providerId === "codex" && params.requestFormat === "openai-completions") {
    return "codex_openai_completions";
  }
  return "codex_openai_responses";
}

function normalizeChatRuntimeReasoningForLevels(
  input: unknown,
  levels: ReasoningLevel[],
): ReasoningLevel {
  if (levels.length === 0) {
    return DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning;
  }
  const reasoning = normalizeChatRuntimeReasoning(input);
  if (levels.includes(reasoning)) return reasoning;
  // 存量档位不在该模型档位表内：先回默认档，默认档也不可用（如单档 toggle
  // 模型、gpt-5.2-chat-latest 只有 medium）时钳到最近档，绝不返回表外档位。
  const fallback = DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning;
  if (levels.includes(fallback)) return fallback;
  const clampSource = (reasoning === "off" ? fallback : reasoning) as ThinkingLevel;
  return clampThinkingLevelToList(clampSource, levels as ThinkingLevel[]) ?? fallback;
}

function normalizeChatRuntimeReasoningByProvider(
  input: unknown,
  fallbackReasoning: ReasoningLevel,
): Partial<Record<ChatRuntimeReasoningProviderKey, ReasoningLevel>> {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const normalized: Partial<Record<ChatRuntimeReasoningProviderKey, ReasoningLevel>> = {
    ...DEFAULT_CHAT_RUNTIME_CONTROLS.reasoningByProvider,
  };
  CHAT_RUNTIME_REASONING_PROVIDER_KEYS.forEach((key) => {
    normalized[key] = normalizeChatRuntimeReasoning(
      Object.hasOwn(obj, key) ? obj[key] : fallbackReasoning,
    );
  });
  return normalized;
}

export function normalizeChatRuntimeControls(input: unknown): ChatRuntimeControls {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const reasoning = normalizeChatRuntimeReasoning(obj.reasoning);
  return {
    thinkingEnabled: obj.thinkingEnabled !== false,
    nativeWebSearchEnabled: obj.nativeWebSearchEnabled !== false,
    // Plan mode 是限制性开关,归一化取向与联网/思考相反:仅显式 true 生效,
    // 旧配置/远端缺失字段一律回落 false,绝不把历史会话意外锁进只读。
    planModeEnabled: obj.planModeEnabled === true,
    reasoning,
    reasoningByProvider: normalizeChatRuntimeReasoningByProvider(
      obj.reasoningByProvider,
      reasoning,
    ),
  };
}

export function getChatRuntimeReasoningLevelsForProvider(params: {
  providerId?: ProviderId;
  requestFormat?: CodexRequestFormat;
  modelId?: string;
}): ReasoningLevel[] {
  return getKnownModelThinkingLevels(params.providerId ?? "claude_code", params.modelId);
}

export function getKnownModelThinkingLevels(
  providerId: ProviderId,
  modelId: string | undefined,
): ReasoningLevel[] {
  return resolveModelThinking(providerId, modelId).levels;
}

export function normalizeChatRuntimeControlsForProvider(
  input: unknown,
  params: {
    providerId?: ProviderId;
    requestFormat?: CodexRequestFormat;
    modelId?: string;
  },
): ChatRuntimeControls {
  const controls = normalizeChatRuntimeControls(input);
  const key = getChatRuntimeReasoningProviderKey(params);
  const levels = getChatRuntimeReasoningLevelsForProvider(params);
  const reasoningByProvider = {
    ...DEFAULT_CHAT_RUNTIME_CONTROLS.reasoningByProvider,
    ...controls.reasoningByProvider,
  };
  const reasoning = normalizeChatRuntimeReasoningForLevels(
    reasoningByProvider[key] ?? controls.reasoning,
    levels,
  );
  return {
    ...controls,
    reasoning,
    reasoningByProvider: {
      ...reasoningByProvider,
      [key]: reasoning,
    },
  };
}

export function updateChatRuntimeControlsForProvider(
  input: unknown,
  patch: Partial<ChatRuntimeControls>,
  params: {
    providerId?: ProviderId;
    requestFormat?: CodexRequestFormat;
    modelId?: string;
  },
): ChatRuntimeControls {
  const key = getChatRuntimeReasoningProviderKey(params);
  const levels = getChatRuntimeReasoningLevelsForProvider(params);
  const controls = normalizeChatRuntimeControls({
    ...normalizeChatRuntimeControls(input),
    ...patch,
  });
  const reasoningByProvider = {
    ...DEFAULT_CHAT_RUNTIME_CONTROLS.reasoningByProvider,
    ...controls.reasoningByProvider,
  };
  if (patch.reasoning !== undefined) {
    reasoningByProvider[key] = normalizeChatRuntimeReasoningForLevels(patch.reasoning, levels);
  }
  return normalizeChatRuntimeControlsForProvider(
    {
      ...controls,
      reasoningByProvider,
    },
    params,
  );
}

function normalizeOptionalText(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function normalizeRecordStringString(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object") return undefined;

  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = String(rawKey).trim();
    const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "").trim();
    if (!key || !value) continue;
    out[key] = value;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeMcpTransport(input: unknown): McpTransport {
  if (input === "http" || input === "sse" || input === "stdio") return input;
  return "stdio";
}

/** 工具策略表:丢弃空键与非法值;空表返回 undefined(与"无覆盖"语义一致)。 */
export function normalizeToolPolicies(input: unknown): Record<string, ToolPolicy> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Record<string, ToolPolicy> = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = String(rawKey).trim();
    if (!key) continue;
    if (rawValue === "allow" || rawValue === "ask" || rawValue === "deny") {
      out[key] = rawValue;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeMcpSelection(input: unknown, servers: McpServerConfig[]): string[] {
  const valid = new Set(servers.map((server) => server.id).filter(Boolean));
  const out: string[] = [];

  for (const item of normalizeStringArray(input)) {
    if (!valid.has(item)) continue;
    if (out.includes(item)) continue;
    out.push(item);
  }

  return out;
}

function normalizeTimeoutMs(input: unknown): number {
  const numeric =
    typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  const timeoutMs = Number.isFinite(numeric) ? Math.floor(numeric) : DEFAULT_MCP_TIMEOUT_MS;
  return timeoutMs > 0 ? timeoutMs : DEFAULT_MCP_TIMEOUT_MS;
}

export function normalizeRemoteSettings(input: unknown): RemoteSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    enabled: obj.enabled === true,
    gatewayUrl: normalizeBaseUrl(typeof obj.gatewayUrl === "string" ? obj.gatewayUrl : ""),
    gatewayPort: normalizeIntegerInRange(obj.gatewayPort, 1, 65_535, 443),
    token: normalizeApiKey(typeof obj.token === "string" ? obj.token : ""),
    agentId: normalizeOptionalText(obj.agentId),
    autoReconnect: obj.autoReconnect !== false,
    heartbeatInterval: normalizePositiveInteger(obj.heartbeatInterval, 30),
    enableWebTerminal: obj.enableWebTerminal === true,
    enableWebSshTerminal: obj.enableWebSshTerminal === true,
    enableWebGit: obj.enableWebGit === true,
    enableWebTunnels: obj.enableWebTunnels === true,
  };
}

export const STT_PROVIDER_IDS: readonly SttProviderId[] = [
  "tencent_cloud",
  "volcengine_seed_v3",
  "aliyun_dashscope",
  "baidu_cloud",
];

function defaultSttProvider(id: SttProviderId): SttProviderSettings {
  const providerDefaults: Partial<SttProviderSettings> =
    id === "aliyun_dashscope"
      ? {
          websocketUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
          model: "paraformer-realtime-v2",
        }
      : id === "volcengine_seed_v3"
        ? {
            websocketUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
          }
        : id === "baidu_cloud"
          ? { websocketUrl: "wss://vop.baidu.com/realtime_asr" }
          : {};
  return {
    id,
    configured: false,
    websocketUrl: "",
    model: "",
    apiKey: "",
    appId: "",
    secretId: "",
    secretKey: "",
    accessToken: "",
    cluster: "",
    resourceId: "",
    engineModelType: "16k_zh",
    baiduAppId: "",
    baiduApiKey: "",
    devPid: "",
    ...providerDefaults,
  };
}

export function getDefaultSttSettings(): SttSettings {
  return {
    enabled: false,
    provider: null,
    providers: Object.fromEntries(
      STT_PROVIDER_IDS.map((id) => [id, defaultSttProvider(id)]),
    ) as Record<SttProviderId, SttProviderSettings>,
  };
}

export function normalizeSttSettings(input: unknown): SttSettings {
  const defaults = getDefaultSttSettings();
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const provider = STT_PROVIDER_IDS.includes(obj.provider as SttProviderId)
    ? (obj.provider as SttProviderId)
    : null;
  const rawProviders =
    obj.providers && typeof obj.providers === "object"
      ? (obj.providers as Record<string, unknown>)
      : {};
  const providers = Object.fromEntries(
    STT_PROVIDER_IDS.map((id) => {
      const raw =
        rawProviders[id] && typeof rawProviders[id] === "object"
          ? (rawProviders[id] as Record<string, unknown>)
          : {};
      const base = defaults.providers[id];
      const text = (key: string) => (typeof raw[key] === "string" ? raw[key].trim() : "");
      return [
        id,
        {
          ...base,
          configured: raw.configured === true,
          websocketUrl: text("websocketUrl") || base.websocketUrl,
          model:
            text("model") === "paraformer-realtime-8k-v2"
              ? "paraformer-realtime-v2"
              : text("model") || base.model,
          apiKey: text("apiKey"),
          appId: text("appId"),
          secretId: text("secretId"),
          secretKey: text("secretKey"),
          accessToken: text("accessToken"),
          cluster: text("cluster"),
          resourceId: text("resourceId"),
          engineModelType: text("engineModelType") || base.engineModelType,
          baiduAppId: text("baiduAppId"),
          baiduApiKey: text("baiduApiKey"),
          devPid: text("devPid"),
          ...(raw.clearSecrets === true ? { clearSecrets: true } : {}),
        } satisfies SttProviderSettings,
      ];
    }),
  ) as Record<SttProviderId, SttProviderSettings>;
  return {
    enabled: obj.enabled === true,
    provider,
    providers,
    ...(obj.allowIncomplete === true ? { allowIncomplete: true } : {}),
  };
}

function getKnownModelLimits(
  providerId: ProviderId,
  modelId: string | undefined,
  baseUrl?: string,
): Pick<ProviderModelConfig, "contextWindow" | "maxInputTokens" | "maxOutputToken"> | undefined {
  const trimmedId = modelId?.trim();
  if (!trimmedId) return undefined;
  // Anthropic 的有效窗口叠加了 1M beta/adaptive 世代的请求侧策略
  // （contextWindow > 200K 即请求侧启用 1M beta 的开关），走策略层回查；
  // 其余供应商直接读目录（数据已在生成期过统一语义规则）。
  if (providerId === "claude_code") {
    return resolveAnthropicKnownModelLimits(trimmedId, baseUrl);
  }
  return resolveModelLimits(providerId, trimmedId);
}

export type ProviderModelDefaults = Pick<
  ProviderModelConfig,
  "contextWindow" | "maxInputTokens" | "maxOutputToken"
> & { source: ModelLimitsSource };

/**
 * 模型限额初值：目录（供应商作用域 → 跨分区回查）→ 供应商兜底。目录命中时带
 * 上目录发布的输入侧预算 maxInputTokens（models.dev limit.input / Codex 输入
 * 预算）；目录未发布时不伪造。
 */
export function getProviderModelDefaults(
  providerId: ProviderId,
  modelId?: string,
  baseUrl?: string,
): ProviderModelDefaults {
  const known = getKnownModelLimits(providerId, modelId, baseUrl);
  if (known) return { ...known, source: "catalog" };

  if (
    providerId === "claude_code" &&
    modelId &&
    (hasAnthropicLongContextSuffix(modelId) || isAnthropicAdaptiveModelId(modelId))
  ) {
    return {
      contextWindow:
        hasAnthropicLongContextSuffix(modelId) &&
        baseUrl &&
        !shouldSendAnthropicLongContextHeader(baseUrl)
          ? ANTHROPIC_STANDARD_CONTEXT_WINDOW
          : ANTHROPIC_LONG_CONTEXT_WINDOW,
      maxOutputToken: getProviderFallbackLimits(providerId).maxOutputToken,
      source: "catalog",
    };
  }

  // 中转聚合把别家模型挂在本供应商下（如 Anthropic 兼容中转供 grok）：按 id
  // 跨供应商回查真实限额，避免吃错本供应商兜底值。Anthropic 的 1M/adaptive
  // 窗口策略只约束目录内的 Anthropic 模型，跨供应商命中直接透传目录值。
  const crossProvider = resolveModelLimitsAcrossProviders(modelId);
  if (crossProvider) return { ...crossProvider, source: "catalog" };

  return { ...getProviderFallbackLimits(providerId), source: "fallback" };
}

export function createProviderModelConfig(
  providerId: ProviderId,
  modelId: string,
): ProviderModelConfig {
  const id = modelId.trim();
  const defaults = getProviderModelDefaults(providerId, id);
  return {
    id,
    contextWindow: defaults.contextWindow,
    ...(defaults.maxInputTokens ? { maxInputTokens: defaults.maxInputTokens } : {}),
    maxOutputToken: defaults.maxOutputToken,
    limitsSource: defaults.source,
  };
}

const VALID_LIMITS_SOURCES: readonly ModelLimitsSource[] = [
  "catalog",
  "provider",
  "fallback",
  "user",
];

function normalizeLimitsSource(value: unknown): ModelLimitsSource | undefined {
  return typeof value === "string" && (VALID_LIMITS_SOURCES as readonly string[]).includes(value)
    ? (value as ModelLimitsSource)
    : undefined;
}

// ---------------------------------------------------------------------------
// 设计 §6.2：供应商声明的模型元数据（provider 候选）
// ---------------------------------------------------------------------------
// 来源有两处，形状不同但都进同一个 providerMeta：
//   1. 刷新模型列表时上游 /models 的原始条目（context_length、top_provider.*、
//      architecture.input_modalities、supports_image_in 等），过去只被
//      extractProviderDeclaredLimits 读走限额就丢掉；
//   2. 已落库的 providerMeta（存量读回，不因加载而丢失）。
// 只保留声明本身，不参与"有效值"的自动覆盖——冲突由界面提示并由用户采纳。

function extractProviderDeclaredMeta(
  obj: Record<string, unknown>,
  fetchedAt?: number,
): ProviderDeclaredModelMeta | undefined {
  const stored = obj.providerMeta;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const source = stored as Record<string, unknown>;
    const out: ProviderDeclaredModelMeta = {};
    const contextWindow = normalizePositiveInteger(source.contextWindow, 0);
    const maxOutputToken = normalizePositiveInteger(source.maxOutputToken, 0);
    const maxInputTokens = normalizePositiveInteger(source.maxInputTokens, 0);
    const modalities = normalizeInputModalities(source.inputModalities);
    const at = normalizePositiveInteger(source.fetchedAt, 0);
    if (contextWindow > 0) out.contextWindow = contextWindow;
    if (maxOutputToken > 0) out.maxOutputToken = maxOutputToken;
    if (maxInputTokens > 0) out.maxInputTokens = maxInputTokens;
    if (modalities) out.inputModalities = modalities;
    if (at > 0) out.fetchedAt = at;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  const topProvider =
    obj.top_provider && typeof obj.top_provider === "object"
      ? (obj.top_provider as Record<string, unknown>)
      : undefined;
  const architecture =
    obj.architecture && typeof obj.architecture === "object"
      ? (obj.architecture as Record<string, unknown>)
      : undefined;

  const contextWindow =
    normalizePositiveInteger(obj.context_length, 0) ||
    normalizePositiveInteger(topProvider?.context_length, 0);
  const maxOutputToken =
    normalizePositiveInteger(topProvider?.max_completion_tokens, 0) ||
    normalizePositiveInteger(obj.max_completion_tokens, 0);
  const maxInputTokens =
    normalizePositiveInteger(obj.max_input_tokens, 0) ||
    normalizePositiveInteger(topProvider?.max_input_tokens, 0);
  // 模态声明：OpenRouter 用 architecture.input_modalities，部分中转用
  // supports_image_in 布尔位。本应用的模态覆盖只有 text / text+image 两形态。
  // 只认上游的 snake_case 字段——camelCase 的 inputModalities 是本地的用户覆盖，
  // 读回存档时绝不能被当成供应商声明。
  const declaredModalities = architecture?.input_modalities ?? obj.input_modalities;
  const modalityList = Array.isArray(declaredModalities)
    ? declaredModalities.filter((item): item is string => typeof item === "string")
    : undefined;
  const supportsImage =
    modalityList?.includes("image") ??
    (typeof obj.supports_image_in === "boolean" ? obj.supports_image_in : undefined);

  const out: ProviderDeclaredModelMeta = {};
  if (contextWindow > 0) out.contextWindow = contextWindow;
  if (maxOutputToken > 0) out.maxOutputToken = maxOutputToken;
  if (maxInputTokens > 0) out.maxInputTokens = maxInputTokens;
  if (supportsImage !== undefined)
    out.inputModalities = supportsImage ? ["text", "image"] : ["text"];
  if (Object.keys(out).length === 0) return undefined;
  out.fetchedAt = fetchedAt ?? Date.now();
  return out;
}
// --- §6.2 供应商元数据结束 ---

export function normalizeProviderModelConfig(
  input: unknown,
  providerId: ProviderId,
): ProviderModelConfig | null {
  if (typeof input === "string") {
    const id = input.trim();
    return id ? createProviderModelConfig(providerId, id) : null;
  }

  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const id =
    typeof obj.id === "string"
      ? obj.id.trim()
      : typeof obj.model === "string"
        ? obj.model.trim()
        : "";
  if (!id) return null;

  const ownedBy =
    (typeof obj.ownedBy === "string" ? obj.ownedBy.trim() : "") ||
    (typeof obj.owned_by === "string" ? obj.owned_by.trim() : "");

  // 供应商 /v1/models 接口本次响应自带的真实限额（如 OpenRouter 的
  // context_length）直接采信记 provider，不比对存量——这是唯一比落库
  // 目录/兜底值更新鲜的数据源。
  const providerDeclared = extractProviderDeclaredLimits(obj);
  const catalogDefaults = getProviderModelDefaults(providerId, id);

  let limits: ModelLimits;
  let limitsSource: ModelLimitsSource;

  if (providerDeclared) {
    limits = providerDeclared;
    limitsSource = "provider";
  } else {
    const storedSource = normalizeLimitsSource(obj.limitsSource);
    // 退化限额（输出吃满窗口）可能来自坏目录数据落库期或手工配置，读侧统一
    // 修复；规则与目录生成期同源（normalizeModelLimits），对所有来源一视同仁。
    const storedLimits = normalizeModelLimits({
      contextWindow: normalizePositiveInteger(obj.contextWindow, catalogDefaults.contextWindow),
      maxOutputToken: normalizePositiveInteger(
        obj.maxOutputToken ?? obj.maxTokens,
        catalogDefaults.maxOutputToken,
      ),
    });
    const hasStoredNumbers =
      obj.contextWindow != null || obj.maxOutputToken != null || obj.maxTokens != null;
    const fallbackPair = getProviderFallbackLimits(providerId);

    // 存量（无 limitsSource 字段）一次性推断：落库值等于当前目录解析结果→
    // catalog；等于当前供应商兜底常量→fallback（多为跨供应商回查上线前落
    // 库的坏默认值，下方 catalog/fallback 分支会立即重解析修复）；其余→
    // user（无法证明不是用户手改的，保守当作用户配置）。
    const resolvedSource: ModelLimitsSource =
      storedSource ??
      (!hasStoredNumbers
        ? catalogDefaults.source
        : storedLimits.contextWindow === catalogDefaults.contextWindow &&
            storedLimits.maxOutputToken === catalogDefaults.maxOutputToken
          ? "catalog"
          : storedLimits.contextWindow === fallbackPair.contextWindow &&
              storedLimits.maxOutputToken === fallbackPair.maxOutputToken
            ? "fallback"
            : "user");

    if (resolvedSource === "catalog" || resolvedSource === "fallback") {
      // 加载时按当前目录/兜底重新解析，让目录更新自动传导。
      limits = {
        contextWindow: catalogDefaults.contextWindow,
        maxOutputToken: catalogDefaults.maxOutputToken,
      };
      limitsSource = catalogDefaults.source;
    } else {
      // provider：供应商实时数据只在“刷新模型列表”那次抓取时存在，加载阶段
      // 没有这份数据可用，保持落库值。user：永不自动覆盖。两者都原样保留。
      limits = storedLimits;
      limitsSource = resolvedSource;
    }
  }

  const promptCacheHintMode =
    providerId === "codex" ? normalizePromptCacheHintMode(obj.promptCacheHintMode) : undefined;
  const inputModalities = normalizeInputModalities(obj.inputModalities);
  const legacyProtocol = normalizeLegacyProtocolInput(obj.chatProtocol);
  // 旧存档的有序 chatProtocols 只取首项：模型只显式选一个接口，端点层故障转移候选
  // 改为按供应商已启用的同家族接口自动展开。
  const chatProtocol =
    legacyProtocol?.protocol ?? normalizeModelChatProtocols(obj.chatProtocols, undefined)?.[0];
  const dialect = normalizeProviderWireDialect(obj.dialect) ?? legacyProtocol?.dialect;
  const wireModelId = typeof obj.wireModelId === "string" ? obj.wireModelId.trim() : "";
  const displayName = typeof obj.displayName === "string" ? obj.displayName.trim() : "";
  const group = typeof obj.group === "string" ? obj.group.trim() : "";
  const credentialId = typeof obj.credentialId === "string" ? obj.credentialId.trim() : "";
  // 输入侧预算：落库值优先；限额来自目录时按目录补齐（目录更新自动传导），
  // provider/user 来源不触碰，目录未发布则保持缺省。
  const maxInputTokens =
    normalizePositiveInteger(obj.maxInputTokens, 0) ||
    (limitsSource === "catalog" ? (catalogDefaults.maxInputTokens ?? 0) : 0);
  const reasoning =
    obj.reasoning === undefined ? undefined : normalizeReasoningLevel(obj.reasoning);
  const capabilities = normalizeModelCapabilities(obj.capabilities);
  // --- 设计 §6.2 / §6.3 新增：供应商声明与模型级参数覆盖 ---
  const providerMeta = extractProviderDeclaredMeta(obj);
  const parameters = normalizeModelParameters(obj.parameters, {
    maxOutputToken: limits.maxOutputToken,
  });
  // --- §6.2 / §6.3 新增结束 ---
  // --- image generation (begin) ---------------------------------------------
  const modelType = normalizeModelType(obj.modelType);
  // --- image generation (end) -----------------------------------------------
  return {
    id,
    ...(wireModelId && wireModelId !== id ? { wireModelId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(group ? { group } : {}),
    ...(ownedBy ? { ownedBy } : {}),
    contextWindow: limits.contextWindow,
    ...(maxInputTokens > 0 ? { maxInputTokens } : {}),
    maxOutputToken: limits.maxOutputToken,
    limitsSource,
    ...(promptCacheHintMode ? { promptCacheHintMode } : {}),
    // 用户手动的输入模态覆盖（如给未识别的多模态模型强制开启图片输入）；
    // 经 normalizeInputModalities 归一化后透传（可能过滤非法值/补齐 text/
    // 重排顺序），合法覆盖永不被自动删除。
    ...(inputModalities ? { inputModalities } : {}),
    ...(chatProtocol ? { chatProtocol } : {}),
    ...(dialect ? { dialect } : {}),
    ...(credentialId ? { credentialId } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(typeof obj.nativeWebSearch === "boolean" ? { nativeWebSearch: obj.nativeWebSearch } : {}),
    ...(capabilities ? { capabilities } : {}),
    // --- 设计 §6.2 / §6.3 新增字段 ---
    ...(providerMeta ? { providerMeta } : {}),
    ...(parameters ? { parameters } : {}),
    // --- §6.2 / §6.3 新增结束 ---
    // --- image generation (begin) -------------------------------------------
    ...(modelType ? { modelType } : {}),
    // --- image generation (end) ---------------------------------------------
    ...(obj.source === "user"
      ? { source: "user" as const }
      : obj.source === "auto"
        ? { source: "auto" as const }
        : {}),
  };
}

function normalizeModelChatProtocols(
  input: unknown,
  legacySingle: ProviderChatProtocol | undefined,
): ProviderChatProtocol[] | undefined {
  const out: ProviderChatProtocol[] = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      const legacy = normalizeLegacyProtocolInput(item);
      if (legacy && !out.includes(legacy.protocol)) out.push(legacy.protocol);
    }
  }
  if (out.length === 0 && legacySingle) out.push(legacySingle);
  return out.length > 0 ? out : undefined;
}

function normalizeModelCapabilities(
  input: unknown,
): Partial<Record<ChatCapabilityName, CapabilityState>> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const out: Partial<Record<ChatCapabilityName, CapabilityState>> = {};
  for (const name of CHAT_CAPABILITY_NAMES) {
    const value = source[name];
    if (value === "supported" || value === "unsupported" || value === "unknown") out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// --- image generation (begin) -----------------------------------------------
/** 模型用途覆盖：只认 "chat" / "image"，其余（含缺省）返回 undefined 走推断。 */
export function normalizeModelType(input: unknown): ModelType | undefined {
  return MODEL_TYPES.find((value) => value === input);
}
// --- image generation (end) -------------------------------------------------

/**
 * 输入模态覆盖的运行时归一化（设置加载与 modelFactory 共用的唯一校验）：
 * - 非数组、空数组、全部非法 -> undefined（等价于“无覆盖，用内置推断”）；
 * - 混合非法项采用“过滤合法项”的容错策略；
 * - 本应用的聊天协议始终发送文本，因此含 "image" 缺 "text" 时自动补齐；
 * - 输出固定为 ["text","image"] 规范顺序，避免同义配置产生持久化差异。
 */
export function normalizeInputModalities(input: unknown): ModelInputModalitiesOverride | undefined {
  if (!Array.isArray(input)) return undefined;
  const valid = new Set<string>(
    input.filter(
      (item): item is ModelInputModality =>
        typeof item === "string" && (MODEL_INPUT_MODALITIES as readonly string[]).includes(item),
    ),
  );
  if (valid.size === 0) return undefined;
  return valid.has("image") ? ["text", "image"] : ["text"];
}
export function normalizeProviderModelConfigs(
  input: unknown,
  providerId: ProviderId,
): ProviderModelConfig[] {
  if (!Array.isArray(input)) return [];

  const out: ProviderModelConfig[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    const normalized = normalizeProviderModelConfig(item, providerId);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }

  return out;
}

export function findProviderModelConfig(
  provider: Pick<CustomProvider, "models" | "type"> & { baseUrl?: string },
  modelId: string,
): ProviderModelConfig {
  const normalizedId = modelId.trim();
  const matched = provider.models.find((item) => item.id === normalizedId);
  if (!matched) {
    const defaults = getProviderModelDefaults(provider.type, normalizedId, provider.baseUrl);
    return {
      id: normalizedId,
      contextWindow: defaults.contextWindow,
      ...(defaults.maxInputTokens ? { maxInputTokens: defaults.maxInputTokens } : {}),
      maxOutputToken: defaults.maxOutputToken,
      limitsSource: defaults.source,
    };
  }
  if (provider.type !== "claude_code") return matched;
  return {
    ...matched,
    contextWindow: resolveAnthropicContextWindow(
      normalizedId,
      matched.contextWindow,
      provider.baseUrl,
    ),
  };
}

function isProviderId(input: unknown): input is ProviderId {
  return (
    input === "codex" ||
    input === "claude_code" ||
    input === "gemini" ||
    input === "xai" ||
    input === "deepseek"
  );
}

function normalizeProviderId(input: unknown): ProviderId {
  switch (input) {
    case "codex":
    case "gemini":
    case "xai":
    case "deepseek":
      return input;
    default:
      return "claude_code";
  }
}

function normalizeProviderName(id: string, input: unknown): string {
  const name = typeof input === "string" && input.trim() ? input.trim() : "未命名供应商";
  if (id === "builtin-claude_code" && name === "Claude Code") return "Anthropic";
  if (id === "builtin-codex" && name === "Codex") return "OpenAI";
  if (id === "builtin-xai" && (name === "xAI" || name === "XAI")) return "Grok";
  return name;
}

function normalizeCustomHeaders(input: unknown): { key: string; value: string }[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const header = item as Record<string, unknown>;
    const key = typeof header.key === "string" ? header.key.trim() : "";
    if (!key) return [];
    return [{ key, value: typeof header.value === "string" ? header.value : "" }];
  });
}

function normalizeProviderModelOrder(
  input: unknown,
  models: readonly ProviderModelConfig[],
): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const validIds = new Set(models.map((model) => model.id));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of normalizeStringArray(input)) {
    if (!validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    order.push(model.id);
  }
  return order;
}

function normalizeUsageQueryMode(input: unknown): UsageQueryMode {
  switch (input) {
    case "coding-plan":
    case "balance":
    case "general":
    case "custom":
      return input;
    default:
      // 缺省与未知模式统一回退 NewAPI 模板(默认查询方式)。
      return "newapi";
  }
}

function normalizeUsageQueryCodingPlanProvider(input: unknown): UsageQueryCodingPlanProvider {
  switch (input) {
    case "kimi":
    case "zhipu":
    case "zhipu_team":
    case "minimax":
    case "zenmux":
    case "volcengine":
      return input;
    default:
      return "";
  }
}

function normalizeUsageQueryScripts(input: unknown): UsageQueryScripts {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const scripts: UsageQueryScripts = {};
  for (const mode of ["custom", "general", "newapi"] as const) {
    const value = obj[mode];
    if (typeof value === "string" && value.trim()) {
      scripts[mode] = value.trim();
    }
  }
  return scripts;
}

function clampInt(input: unknown, min: number, max: number, fallback: number): number {
  const value = typeof input === "number" && Number.isFinite(input) ? Math.round(input) : fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeUsageQueryConfig(input: unknown): UsageQueryConfig {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const apiKey = normalizeApiKey(typeof obj.apiKey === "string" ? obj.apiKey : "");
  const accessToken = normalizeApiKey(typeof obj.accessToken === "string" ? obj.accessToken : "");
  const secretAccessKey = normalizeApiKey(
    typeof obj.secretAccessKey === "string" ? obj.secretAccessKey : "",
  );

  return {
    enabled: obj.enabled === true,
    mode: normalizeUsageQueryMode(obj.mode),
    script: typeof obj.script === "string" ? obj.script.trim() : "",
    scripts: normalizeUsageQueryScripts(obj.scripts),
    baseUrl: normalizeBaseUrl(typeof obj.baseUrl === "string" ? obj.baseUrl : ""),
    apiKey,
    apiKeyConfigured: apiKey.length > 0 || obj.apiKeyConfigured === true,
    accessToken,
    accessTokenConfigured: accessToken.length > 0 || obj.accessTokenConfigured === true,
    userId: typeof obj.userId === "string" ? obj.userId.trim() : "",
    accessKeyId: typeof obj.accessKeyId === "string" ? obj.accessKeyId.trim() : "",
    secretAccessKey,
    secretAccessKeyConfigured: secretAccessKey.length > 0 || obj.secretAccessKeyConfigured === true,
    codingPlanProvider: normalizeUsageQueryCodingPlanProvider(obj.codingPlanProvider),
    teamOrganizationId:
      typeof obj.teamOrganizationId === "string" ? obj.teamOrganizationId.trim() : "",
    teamProjectId: typeof obj.teamProjectId === "string" ? obj.teamProjectId.trim() : "",
    timeoutSecs: clampInt(
      obj.timeoutSecs,
      USAGE_QUERY_TIMEOUT_MIN_SECS,
      USAGE_QUERY_TIMEOUT_MAX_SECS,
      USAGE_QUERY_TIMEOUT_DEFAULT_SECS,
    ),
  };
}

/**
 * 供应商级重试策略归一化。default 态在持久层不落字段（返回 undefined），
 * 保证旧配置零迁移；非法输入（未知 mode、custom 无有效次数）一律视为
 * default。custom 的 maxRetries（不含首次请求的重试次数）钳位 1..10。
 */
export function normalizeProviderRetryPolicy(input: unknown): ProviderRetryPolicy | undefined {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (obj.mode === "off") return { mode: "off" };
  if (obj.mode === "custom") {
    const raw = obj.maxRetries;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
    return {
      mode: "custom",
      maxRetries: clampInt(
        raw,
        PROVIDER_RETRY_MAX_RETRIES_LIMITS.min,
        PROVIDER_RETRY_MAX_RETRIES_LIMITS.max,
        PROVIDER_RETRY_MAX_RETRIES_LIMITS.min,
      ),
    };
  }
  return undefined;
}

function normalizeEndpointHeaders(input: unknown): { key: string; value: string }[] | undefined {
  const headers = normalizeCustomHeaders(input);
  return headers.length > 0 ? headers : undefined;
}

function normalizeEndpointQuirks(input: unknown): ProviderEndpointQuirks | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const quirks: ProviderEndpointQuirks = {};
  for (const key of [
    "supportsUsageInStreaming",
    "supportsDeveloperRole",
    "supportsReasoningEffort",
    "supportsStore",
  ] as const) {
    if (typeof source[key] === "boolean") quirks[key] = source[key] as boolean;
  }
  if (
    typeof source.thinkingFormat === "string" &&
    (PROVIDER_THINKING_FORMATS as readonly string[]).includes(source.thinkingFormat)
  ) {
    quirks.thinkingFormat = source.thinkingFormat as ProviderThinkingFormat;
  }
  if (source.maxTokensField === "max_tokens" || source.maxTokensField === "max_completion_tokens") {
    quirks.maxTokensField = source.maxTokensField;
  }
  return Object.keys(quirks).length > 0 ? quirks : undefined;
}

function normalizeEndpointAuth(input: unknown): ProviderEndpointAuth | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const headerName = typeof source.headerName === "string" ? source.headerName.trim() : "";
  const prefix = typeof source.prefix === "string" ? source.prefix : undefined;
  if (!headerName && prefix === undefined) return undefined;
  return { ...(headerName ? { headerName } : {}), ...(prefix !== undefined ? { prefix } : {}) };
}

/** 探测错误文本的落盘上限；超出部分截断并标注。 */
const PROBE_ERROR_MAX_LENGTH = 400;

export function truncateProbeError(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= PROBE_ERROR_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, PROBE_ERROR_MAX_LENGTH)}…`;
}

function normalizeEndpointProbe(input: unknown): ProviderEndpointProbe | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const status = source.status;
  if (
    status !== "ok" &&
    status !== "catalog" &&
    status !== "missing" &&
    status !== "unauthorized" &&
    status !== "unknown"
  ) {
    return undefined;
  }
  const at = typeof source.at === "number" && Number.isFinite(source.at) ? source.at : 0;
  const latencyMs =
    typeof source.latencyMs === "number" && Number.isFinite(source.latencyMs)
      ? Math.max(0, Math.round(source.latencyMs))
      : undefined;
  // 上游失败时常回整页 HTML（Cloudflare 拦截页等）。观测值只用于界面提示，截断到
  // PROBE_ERROR_MAX_LENGTH，避免把几 KB 的页面源码写进配置库与同步负载。
  const rawError = typeof source.error === "string" ? source.error.trim() : "";
  const error = rawError ? truncateProbeError(rawError) : undefined;
  return {
    at,
    status,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(error ? { error } : {}),
  };
}

export function normalizeProviderEndpointConfig(
  protocol: ProviderChatProtocol,
  input: unknown,
  credentialIds?: ReadonlySet<string>,
): ProviderEndpointConfig | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const baseUrl = normalizeBaseUrl(typeof raw.baseUrl === "string" ? raw.baseUrl : "");
  if (!baseUrl) return undefined;
  const dialect = normalizeProviderWireDialect(raw.dialect);
  const modelsUrl = typeof raw.modelsUrl === "string" ? raw.modelsUrl.trim() : "";
  const credentialId = typeof raw.credentialId === "string" ? raw.credentialId.trim() : "";
  const quirks = normalizeEndpointQuirks(raw.quirks);
  const auth = normalizeEndpointAuth(raw.auth);
  const headers = normalizeEndpointHeaders(raw.headers);
  const identity = isEndpointIdentity(raw.identity) ? raw.identity : undefined;
  const lastProbe = normalizeEndpointProbe(raw.lastProbe);
  return {
    ...(raw.enabled === false ? { enabled: false } : {}),
    baseUrl,
    ...(raw.isFullUrl === true ? { isFullUrl: true } : {}),
    ...(modelsUrl ? { modelsUrl } : {}),
    ...(dialect ? { dialect: coerceDialectForProtocol(protocol, dialect) } : {}),
    ...(quirks ? { quirks } : {}),
    ...(auth ? { auth } : {}),
    ...(credentialId && (!credentialIds || credentialIds.has(credentialId))
      ? { credentialId }
      : {}),
    ...(headers ? { headers } : {}),
    ...(identity ? { identity } : {}),
    ...(lastProbe ? { lastProbe } : {}),
    ...(raw.source === "user"
      ? { source: "user" as const }
      : raw.source === "auto"
        ? { source: "auto" as const }
        : {}),
  };
}

/**
 * 端点表归一化。返回保留下来的端点，以及"声明过但因地址为空等原因被丢弃"的接口，
 * 供默认接口守卫判断默认接口是否已不复存在。
 */
function normalizeProviderEndpointConfigs(
  input: unknown,
  credentialIds?: ReadonlySet<string>,
): { configs: CustomProvider["endpointConfigs"] | undefined; dropped: Set<ProviderChatProtocol> } {
  const dropped = new Set<ProviderChatProtocol>();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { configs: undefined, dropped };
  }
  const source = input as Record<string, unknown>;
  const configs: NonNullable<CustomProvider["endpointConfigs"]> = {};
  for (const [key, raw] of Object.entries(source)) {
    const legacy = normalizeLegacyProtocolInput(key);
    if (!legacy) continue;
    const config = normalizeProviderEndpointConfig(legacy.protocol, raw, credentialIds);
    if (!config) {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) dropped.add(legacy.protocol);
      continue;
    }
    if (legacy.dialect && !config.dialect) config.dialect = legacy.dialect;
    // 旧键与新键同时存在时保留新键。
    if (!configs[legacy.protocol] || key === legacy.protocol) configs[legacy.protocol] = config;
  }
  for (const protocol of Object.keys(configs) as ProviderChatProtocol[]) dropped.delete(protocol);
  return { configs: Object.keys(configs).length > 0 ? configs : undefined, dropped };
}

const CREDENTIAL_MODELS_LIMIT = 1000;

function normalizeCredentialScope(input: unknown): ProviderCredentialScope | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  if (source.mode === "all") return { mode: "all" };
  if (source.mode === "auto") return { mode: "auto" };
  if (source.mode === "manual") {
    const models = normalizeStringArray(source.models)
      .map((item) => item.trim())
      .filter(Boolean);
    return { mode: "manual", models: [...new Set(models)] };
  }
  return undefined;
}

export function normalizeProviderCredential(input: unknown): ProviderCredential | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const apiKey = normalizeApiKey(typeof source.apiKey === "string" ? source.apiKey : "");
  const id = typeof source.id === "string" && source.id.trim() ? source.id.trim() : createUuid();
  const modelScope = normalizeCredentialScope(source.modelScope);
  const lastModelsRaw =
    source.lastModels && typeof source.lastModels === "object" && !Array.isArray(source.lastModels)
      ? (source.lastModels as Record<string, unknown>)
      : undefined;
  const lastModels = lastModelsRaw
    ? {
        at:
          typeof lastModelsRaw.at === "number" && Number.isFinite(lastModelsRaw.at)
            ? lastModelsRaw.at
            : 0,
        models: [
          ...new Set(
            normalizeStringArray(lastModelsRaw.models)
              .map((item) => item.trim())
              .filter(Boolean),
          ),
        ].slice(0, CREDENTIAL_MODELS_LIMIT),
      }
    : undefined;
  return {
    id,
    label: typeof source.label === "string" ? source.label.trim() : "",
    apiKey,
    apiKeyConfigured: apiKey.length > 0 || source.apiKeyConfigured === true,
    enabled: source.enabled !== false,
    ...(modelScope ? { modelScope } : {}),
    ...(lastModels ? { lastModels } : {}),
  };
}

/**
 * 凭据列表归一化：首把即旧字段 apiKey。旧存档只有 apiKey → 单把默认凭据；
 * 新存档 credentials[0].apiKey 与 apiKey 双向同步，谁非空用谁。
 */
function normalizeProviderCredentials(
  input: unknown,
  apiKey: string,
  apiKeyConfigured: boolean,
): ProviderCredential[] {
  const list: ProviderCredential[] = [];
  const seen = new Set<string>();
  if (Array.isArray(input)) {
    for (const item of input) {
      const credential = normalizeProviderCredential(item);
      if (!credential || seen.has(credential.id)) continue;
      seen.add(credential.id);
      list.push(credential);
    }
  }
  if (list.length === 0) {
    return [
      {
        id: DEFAULT_CREDENTIAL_ID,
        label: "",
        apiKey,
        apiKeyConfigured: apiKeyConfigured || apiKey.length > 0,
        enabled: true,
      },
    ];
  }
  const primary = list[0];
  if (!primary.apiKey && apiKey) {
    primary.apiKey = apiKey;
    primary.apiKeyConfigured = true;
  } else if (apiKeyConfigured && !primary.apiKey) {
    primary.apiKeyConfigured = true;
  }
  return list;
}

/** 只接受 http(s) 绝对地址的可选字段（文档页等外链）：其它值一律丢弃。 */
export function normalizeHttpUrl(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = input.trim();
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return value;
}

/**
 * 源地址列表归一化：地址按 normalizeOrigin 规范化（补 scheme、去 query 与尾部版本段），
 * 空或非法丢弃，按规范化值去重（保留先出现的），enabled 只在显式 false 时落盘。
 * 一条都没有时返回 undefined（等价旧存档的单源）。
 */
export function normalizeProviderOrigins(input: unknown): ProviderOrigin[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: ProviderOrigin[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const source = raw as Record<string, unknown>;
    const url = normalizeOrigin(typeof source.url === "string" ? source.url : "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const id = typeof source.id === "string" && source.id.trim() ? source.id.trim() : createUuid();
    const lastProbe = normalizeEndpointProbe(source.lastProbe);
    out.push({
      id,
      url,
      ...(source.enabled === false ? { enabled: false } : {}),
      ...(lastProbe ? { lastProbe } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

export function normalizeCustomProvider(input: unknown): CustomProvider {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const origins = normalizeProviderOrigins(obj.origins);
  // 主连接始终落绝对地址（旧读取点直接读 baseUrl）：模板按主源展开；没有可用的源时为空。
  const primaryOrigin = origins ? getProviderPrimaryOrigin({ origins }) : undefined;
  const baseUrlInput = expandProviderOriginUrl(
    typeof obj.baseUrl === "string" ? obj.baseUrl : "",
    primaryOrigin,
  );
  const modelsUrlInput = expandProviderOriginUrl(
    typeof obj.modelsUrl === "string" ? obj.modelsUrl : "",
    primaryOrigin,
  );
  const legacyDefault = normalizeLegacyProtocolInput(obj.defaultChatProtocol);
  const presetIdInput = typeof obj.presetId === "string" ? obj.presetId.trim() : "";
  const presetFromInput = findProviderPreset(presetIdInput);
  // 新建的非原生渠道实例可能没有 type：按默认接口家族回填，保证旧读取点行为不变。
  const type = isProviderId(obj.type)
    ? obj.type
    : legacyDefault
      ? legacyTypeForPreset(presetFromInput, legacyDefault.protocol)
      : normalizeProviderId(obj.type);
  const isFullUrl = obj.isFullUrl === true;
  const codexRouting =
    type === "codex" || type === "xai"
      ? normalizeCodexRouting(
          baseUrlInput,
          // xAI / Grok 固定走 Responses；忽略历史配置中的 completions。
          type === "xai" ? "openai-responses" : obj.requestFormat,
          isFullUrl,
        )
      : undefined;
  const models = normalizeProviderModelConfigs(obj.models, type);
  const modelOrder = normalizeProviderModelOrder(obj.modelOrder, models);
  const validModelIds = new Set(models.map((model) => model.id));
  const apiKey = normalizeApiKey(typeof obj.apiKey === "string" ? obj.apiKey : "");
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : createUuid();
  const promptCacheHintMode =
    type === "codex"
      ? (normalizePromptCacheHintMode(obj.promptCacheHintMode) ??
        (obj.promptCachingEnabled === false ? "none" : "auto"))
      : undefined;
  const credentials = normalizeProviderCredentials(
    obj.credentials,
    apiKey,
    obj.apiKeyConfigured === true,
  );
  const credentialIds = new Set(credentials.map((credential) => credential.id));
  const { configs: endpointConfigs, dropped: droppedEndpoints } = normalizeProviderEndpointConfigs(
    obj.endpointConfigs,
    credentialIds,
  );
  // 默认接口不能是被关闭的渠道，也不能是刚被丢弃（空地址）的端点：自动切到第一个
  // 已启用的显式端点；一个都没有时保留原值，由主连接充当隐式端点（设计文档 5.4 / 9）。
  const defaultChatProtocol = (() => {
    const requested = legacyDefault?.protocol;
    if (!requested) return undefined;
    const requestedUsable = endpointConfigs?.[requested]
      ? endpointConfigs[requested]?.enabled !== false
      : !droppedEndpoints.has(requested);
    if (requestedUsable) return requested;
    const fallback = PROVIDER_CHAT_PROTOCOLS.find(
      (protocol) => endpointConfigs?.[protocol] && endpointConfigs[protocol]?.enabled !== false,
    );
    return fallback ?? requested;
  })();
  const dialect = normalizeProviderWireDialect(obj.dialect) ?? legacyDefault?.dialect;
  const primaryBaseUrl = codexRouting ? codexRouting.baseUrl : normalizeBaseUrl(baseUrlInput);
  // 预设归属以地址为准：声明了绝对官方主机的预设，地址不在其主机内时降级为自定义，
  // 避免把中转的 Key 发到官方地址。
  const presetId =
    presetFromInput && presetMatchesBaseUrl(presetFromInput, primaryBaseUrl)
      ? presetFromInput.id
      : presetIdForLegacyProvider(type, primaryBaseUrl);
  const primaryKey = credentials[0]?.apiKey ?? apiKey;

  return {
    id,
    name: normalizeProviderName(id, obj.name),
    type,
    presetId,
    ...(obj.enabled === false ? { enabled: false } : {}),
    baseUrl: primaryBaseUrl,
    isFullUrl,
    ...(type !== "gemini" && modelsUrlInput.trim() ? { modelsUrl: modelsUrlInput.trim() } : {}),
    ...(origins ? { origins } : {}),
    ...((): { docUrl?: string } => {
      const docUrl = normalizeHttpUrl(obj.docUrl);
      return docUrl ? { docUrl } : {};
    })(),
    apiKey: primaryKey,
    apiKeyConfigured: primaryKey.length > 0 || credentials[0]?.apiKeyConfigured === true,
    credentials,
    customHeaders: normalizeCustomHeaders(obj.customHeaders),
    models,
    ...(modelOrder ? { modelOrder } : {}),
    activeModels: normalizeModels(normalizeStringArray(obj.activeModels)).filter((modelId) =>
      validModelIds.has(modelId),
    ),
    // requestFormat 是 codex 分组的旧字段，必须与默认接口同步：默认接口是 OpenAI 家族
    // 时就取它（xAI 固定 Responses），否则沿用地址后缀推导；其它类型不落这个字段。
    requestFormat:
      type === "xai"
        ? "openai-responses"
        : type === "codex" &&
            defaultChatProtocol &&
            PROVIDER_PROTOCOL_FAMILY[defaultChatProtocol] === "openai"
          ? (defaultChatProtocol as CodexRequestFormat)
          : codexRouting?.requestFormat,
    ...(defaultChatProtocol ? { defaultChatProtocol } : {}),
    ...(dialect ? { dialect } : {}),
    ...(endpointConfigs ? { endpointConfigs } : {}),
    reasoning: normalizeReasoningLevel(obj.reasoning),
    // Anthropic 默认开启显式缓存；Codex 的布尔值仅保留旧设置兼容，实际 wire
    // 行为由 promptCacheHintMode 决定。Gemini / xAI / DeepSeek 不使用这里的缓存控制。
    promptCachingEnabled:
      type === "codex"
        ? promptCacheHintMode !== "none"
        : type === "gemini" || type === "xai" || type === "deepseek"
          ? false
          : obj.promptCachingEnabled !== false,
    ...(promptCacheHintMode ? { promptCacheHintMode } : {}),
    ...(type === "claude_code" && obj.promptCacheRetention === "long"
      ? { promptCacheRetention: "long" as const }
      : {}),
    nativeWebSearchEnabled: obj.nativeWebSearchEnabled !== false,
    useSystemProxy: obj.useSystemProxy === true,
    ...((): { retryPolicy?: ProviderRetryPolicy } => {
      const retryPolicy = normalizeProviderRetryPolicy(obj.retryPolicy);
      return retryPolicy ? { retryPolicy } : {};
    })(),
    usageQuery: normalizeUsageQueryConfig(obj.usageQuery),
  };
}

export function normalizeAgentPromptTemplate(input: unknown): AgentPromptTemplate {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : createUuid(),
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "未命名模板",
    description: normalizeOptionalText(obj.description),
    prompt: normalizeOptionalText(obj.prompt),
    enabled: obj.enabled === true,
  };
}

function normalizeSshAuthType(input: unknown): SshAuthType {
  switch (input) {
    case "privateKey":
    case "keyboardInteractive":
      return input;
    default:
      return "password";
  }
}

function normalizeSshPort(input: unknown): number {
  const value = typeof input === "number" || typeof input === "string" ? Number(input) : 22;
  if (!Number.isFinite(value)) return 22;
  const port = Math.floor(value);
  return port >= 1 && port <= 65535 ? port : 22;
}

function normalizeSshProxyPort(input: unknown): number {
  const value = typeof input === "number" || typeof input === "string" ? Number(input) : 0;
  if (!Number.isFinite(value)) return 0;
  const port = Math.floor(value);
  return port >= 1 && port <= 65535 ? port : 0;
}

function normalizeSshProxyType(input: unknown): SshProxyType {
  return input === "http" ? "http" : "socks5";
}

export function normalizeSshProxyConfig(input: unknown): SshProxyConfig {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const password = normalizeOptionalText(obj.password);
  return {
    type: normalizeSshProxyType(obj.type),
    url: normalizeOptionalText(obj.url),
    port: normalizeSshProxyPort(obj.port),
    username: typeof obj.username === "string" ? obj.username.trim() : "",
    password,
    passwordConfigured: password.length > 0 || obj.passwordConfigured === true,
    useSystemProxy: obj.useSystemProxy === true,
  };
}

export function normalizeSshHostConfig(input: unknown): SshHostConfig {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const host = typeof obj.host === "string" ? obj.host.trim() : "";
  const name =
    typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : host || "未命名 SSH";
  const authType = normalizeSshAuthType(obj.authType);
  const password = authType === "keyboardInteractive" ? "" : normalizeOptionalText(obj.password);
  const privateKey =
    authType === "keyboardInteractive" ? "" : normalizeOptionalText(obj.privateKey);
  const privateKeyPath =
    authType === "keyboardInteractive" ? "" : normalizeOptionalText(obj.privateKeyPath);
  const privateKeyPassphrase =
    authType === "keyboardInteractive" ? "" : normalizeOptionalText(obj.privateKeyPassphrase);
  const passwordConfigured =
    authType !== "keyboardInteractive" && (password.length > 0 || obj.passwordConfigured === true);
  const privateKeyConfigured =
    authType !== "keyboardInteractive" &&
    (privateKey.length > 0 || privateKeyPath.length > 0 || obj.privateKeyConfigured === true);
  const privateKeyPassphraseConfigured =
    authType !== "keyboardInteractive" &&
    (privateKeyPassphrase.length > 0 || obj.privateKeyPassphraseConfigured === true);

  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : createUuid(),
    name,
    description: normalizeOptionalText(obj.description),
    host,
    port: normalizeSshPort(obj.port),
    username: typeof obj.username === "string" ? obj.username.trim() : "",
    authType,
    password,
    passwordConfigured,
    privateKey,
    privateKeyPath,
    privateKeyConfigured,
    privateKeyPassphrase,
    privateKeyPassphraseConfigured,
    proxy: normalizeSshProxyConfig(obj.proxy),
  };
}

export function normalizeSshSettings(input: unknown): SshSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const sourceHosts = Array.isArray(obj.hosts) ? obj.hosts : [];
  const seenIds = new Set<string>();
  const hosts = sourceHosts.map((host) => {
    const normalized = normalizeSshHostConfig(host);
    if (!seenIds.has(normalized.id)) {
      seenIds.add(normalized.id);
      return normalized;
    }
    const id = createUuid();
    seenIds.add(id);
    return { ...normalized, id };
  });
  const hostIds = new Set(hosts.map((host) => host.id));

  return {
    hosts,
    projectHostAssociations: normalizeSshProjectHostAssociations(
      obj.projectHostAssociations,
      hostIds,
    ),
  };
}

function normalizeSshProjectHostAssociations(
  input: unknown,
  hostIds: ReadonlySet<string>,
): Record<string, string[]> {
  const rawAssociations = (
    input && typeof input === "object" && !Array.isArray(input) ? input : {}
  ) as Record<string, unknown>;
  const associations: Record<string, string[]> = {};
  const canonicalKeys = new Set<string>();
  for (const [pathKey, rawHostIds] of Object.entries(rawAssociations)) {
    if (!Array.isArray(rawHostIds)) continue;
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const rawHostId of rawHostIds) {
      if (typeof rawHostId !== "string") continue;
      const hostId = rawHostId.trim();
      if (!hostId || !hostIds.has(hostId) || seen.has(hostId)) continue;
      seen.add(hostId);
      ids.push(hostId);
      if (ids.length >= 64) break;
    }
    if (ids.length === 0) continue;
    assignNormalizedProjectKeyValue(associations, canonicalKeys, pathKey, ids);
    if (Object.keys(associations).length >= 100) break;
  }
  return associations;
}

export function getDefaultSystemProxyConfig(): SystemProxyConfig {
  return {
    enabled: false,
    type: "http",
    host: "",
    port: 0,
    username: "",
    password: "",
  };
}

export function isValidSystemProxyHost(input: string): boolean {
  const host = input.trim();
  if (!host || /[\s/\\@#?%]/.test(host)) return false;
  const bracketed = host.startsWith("[") && host.endsWith("]");
  const hostForUrl = host.includes(":") && !bracketed ? `[${host}]` : host;
  try {
    const parsed = new URL(`http://${hostForUrl}`);
    return parsed.hostname.length > 0 && parsed.port === "";
  } catch {
    return false;
  }
}

export function normalizeSystemProxyConfig(input: unknown): SystemProxyConfig {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const port = Number(obj.port);
  const password = typeof obj.password === "string" ? obj.password : "";
  return {
    enabled: obj.enabled === true,
    type: obj.type === "socks5" ? "socks5" : "http",
    host: typeof obj.host === "string" ? obj.host.trim() : "",
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0,
    username: typeof obj.username === "string" ? obj.username.trim() : "",
    password,
    passwordConfigured: password.trim().length > 0 || obj.passwordConfigured === true,
  };
}

/**
 * 命令安全模式归一。
 *
 * - 缺失 / null / 空串:沿用默认 `auto`(全新配置与旧快照的正常形态)。
 * - **存在但无法识别:收敛到最严格的 `ask`**(P2#6)。该设置全部意义在于约束,
 *   未来新增的模式值、回退到旧版本、手改配置的笔误若静默降级成最宽松的非 ask 值,
 *   等于悄悄放宽用户的约束选择;Rust 侧 normalize_command_safety_mode_value 同语义。
 */
export function normalizeCommandSafetyMode(input: unknown): CommandSafetyMode {
  if (input === undefined || input === null) return "auto";
  if (typeof input !== "string") {
    console.warn(`[settings] non-string commandSafetyMode; failing closed to "ask"`, input);
    return "ask";
  }
  const mode = input.trim();
  if (mode === "") return "auto";
  if ((COMMAND_SAFETY_MODES as readonly string[]).includes(mode)) {
    return mode as CommandSafetyMode;
  }
  console.warn(`[settings] unrecognized commandSafetyMode "${mode}"; failing closed to "ask"`);
  return "ask";
}

/**
 * 严格度序:`auto` < `sandbox` < `sandboxOffline` < `ask`(逐次人工放行最严)。
 * 供“取更严格者”的钳制使用,不参与持久化。
 */
const COMMAND_SAFETY_MODE_STRICTNESS: Record<CommandSafetyMode, number> = {
  auto: 0,
  sandbox: 1,
  sandboxOffline: 2,
  ask: 3,
};

/**
 * 取更严格的一方(P3#9)。远端(WebUI / 网关)与排队快照携带的模式只允许“收紧”本地
 * 设置,绝不允许用一份陈旧快照把桌面用户刻意选择的 `sandboxOffline` 放宽成 `auto`
 * —— 桌面端是工具唯一执行处,约束强度不能由远端取值决定。
 */
export function strictestCommandSafetyMode(
  a: CommandSafetyMode,
  b: CommandSafetyMode,
): CommandSafetyMode {
  return COMMAND_SAFETY_MODE_STRICTNESS[a] >= COMMAND_SAFETY_MODE_STRICTNESS[b] ? a : b;
}

/**
 * 浏览器接入模式归一。缺失/空串/未知值一律回 `auto`:该设置是行为选择而非
 * 安全约束(登录态使用与否由 group:browser 审批把关),未知值不需要 fail-closed。
 */
export function normalizeBrowserAutomationMode(input: unknown): BrowserAutomationMode {
  if (typeof input !== "string") return "auto";
  const mode = input.trim();
  return (BROWSER_AUTOMATION_MODES as readonly string[]).includes(mode)
    ? (mode as BrowserAutomationMode)
    : "auto";
}

export function normalizeSystemSettings(input: unknown): SystemSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    executionMode: normalizeExecutionMode(obj.executionMode),
    workdir: normalizeWorkdir(obj.workdir),
    toolPolicies: normalizeToolPolicies(obj.toolPolicies),
    // 安全侧开关：任何非 true 的值都收敛成 false。
    cuaAllowSelfTargeting: obj.cuaAllowSelfTargeting === true,
    commandSafetyMode: normalizeCommandSafetyMode(obj.commandSafetyMode),
    browserAutomationMode: normalizeBrowserAutomationMode(obj.browserAutomationMode),
    workspaceProjects: normalizeWorkspaceProjects(obj.workspaceProjects),
    workspaceProjectGroups: normalizeWorkspaceProjectGroups(obj.workspaceProjectGroups),
    workspaceProjectOrder: [
      ...new Set(normalizeStringArray(obj.workspaceProjectOrder).map(workspaceProjectPathKey)),
    ],
    sidebarPinnedOrder: [...new Set(normalizeStringArray(obj.sidebarPinnedOrder))],
    activeWorkspaceProjectId:
      typeof obj.activeWorkspaceProjectId === "string" && obj.activeWorkspaceProjectId.trim()
        ? obj.activeWorkspaceProjectId.trim()
        : undefined,
    hiddenWorkspaceProjectPaths: normalizeHiddenWorkspaceProjectPaths(
      obj.hiddenWorkspaceProjectPaths,
    ),
    missingWorkspaceProjectPaths: normalizeMissingWorkspaceProjectPaths(
      obj.missingWorkspaceProjectPaths,
    ),
    archivedWorkspaceProjectPaths: normalizeArchivedWorkspaceProjectPaths(
      obj.archivedWorkspaceProjectPaths,
    ),
    workspaceResourceSettings: normalizeWorkspaceResourceSettings(obj.workspaceResourceSettings),
    systemProxy: normalizeSystemProxyConfig(obj.systemProxy),
  };
}

function normalizeMcpAuthConfig(input: unknown): McpAuthConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  if (obj.type !== "oauth") return undefined; // "none"/未知值 = 现状，不存壳对象
  const scope = typeof obj.scope === "string" ? obj.scope.trim() : "";
  const clientId = typeof obj.clientId === "string" ? obj.clientId.trim() : "";
  return {
    type: "oauth",
    ...(scope ? { scope } : {}),
    ...(clientId ? { clientId } : {}),
  };
}

export function normalizeMcpServerConfig(input: unknown): McpServerConfig {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  const docsUrl = typeof obj.docsUrl === "string" ? obj.docsUrl.trim() : "";
  const cwd = typeof obj.cwd === "string" ? obj.cwd.trim() : "";
  const messageUrl = typeof obj.messageUrl === "string" ? obj.messageUrl.trim() : "";
  const auth = normalizeMcpAuthConfig(obj.auth);

  return {
    id,
    ...(description ? { description } : {}),
    ...(docsUrl ? { docsUrl } : {}),
    enabled: Boolean(obj.enabled),
    transport: normalizeMcpTransport(obj.transport),
    command: typeof obj.command === "string" ? obj.command.trim() : "",
    args: normalizeStringArray(obj.args),
    url: typeof obj.url === "string" ? obj.url.trim() : "",
    env: normalizeRecordStringString(obj.env),
    cwd: cwd || undefined,
    headers: normalizeRecordStringString(obj.headers),
    timeoutMs: normalizeTimeoutMs(obj.timeoutMs),
    messageUrl: messageUrl || undefined,
    ...(auth ? { auth } : {}),
  };
}

export function normalizeMcpSettings(input: unknown): McpSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const servers = Array.isArray(obj.servers)
    ? obj.servers.map((server) => normalizeMcpServerConfig(server))
    : [];

  return {
    servers,
    selected: normalizeMcpSelection(obj.selected, servers),
  };
}

export function normalizeAgentPromptTemplates(input: unknown): AgentPromptTemplate[] {
  if (!Array.isArray(input)) return [];
  let hasEnabled = false;
  return input.map((template) => {
    const normalized = normalizeAgentPromptTemplate(template);
    if (!normalized.enabled) return normalized;
    if (hasEnabled) return { ...normalized, enabled: false };
    hasEnabled = true;
    return normalized;
  });
}

export function normalizeSkillsSettings(input: unknown): SkillsSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    enabled: obj.enabled !== false,
    selected: mergeAlwaysEnabledSkillNames(normalizeStringArray(obj.selected)),
  };
}

export function normalizeSelectedModel(input: unknown): SelectedModel | undefined {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const customProviderId =
    typeof obj.customProviderId === "string" ? obj.customProviderId.trim() : "";
  const model = typeof obj.model === "string" ? obj.model.trim() : "";

  if (!customProviderId || !model) return undefined;
  return { customProviderId, model };
}

export function parseSelectedModelJson(json: string | null | undefined): SelectedModel | undefined {
  if (!json?.trim()) return undefined;
  try {
    return normalizeSelectedModel(JSON.parse(json));
  } catch {
    return undefined;
  }
}

export function serializeSelectedModelJson(
  selectedModel: SelectedModel | undefined,
): string | undefined {
  const normalized = normalizeSelectedModel(selectedModel);
  return normalized ? JSON.stringify(normalized) : undefined;
}

export function normalizeCloseWindowBehavior(input: unknown): CloseWindowBehavior {
  return input === "exit" ? "exit" : "minimize";
}

export function normalizeSelectedModelForProviders(
  selectedModel: SelectedModel | undefined,
  customProviders: CustomProvider[],
): SelectedModel | undefined {
  if (!selectedModel) {
    return undefined;
  }

  const provider = customProviders.find((item) => item.id === selectedModel.customProviderId);
  if (!provider || provider.enabled === false) {
    return undefined;
  }

  return provider.activeModels.includes(selectedModel.model) ? selectedModel : undefined;
}

// --- image generation (begin) -----------------------------------------------
/**
 * 图像生成设置的归一化：默认生图模型必须指向一个仍然存在、仍被启用、
 * 且确实是 image 类型的模型，否则整条丢弃（回落到"第一个可用生图模型"）。
 */
export function normalizeImageGenerationSettings(
  input: unknown,
  customProviders: CustomProvider[],
): ImageGenerationSettings | undefined {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const selected = normalizeSelectedModel(obj.defaultModel);
  if (!selected) return undefined;
  const provider = customProviders.find((item) => item.id === selected.customProviderId);
  if (!provider || provider.enabled === false) return undefined;
  if (!provider.activeModels.includes(selected.model)) return undefined;
  if (!isImageGenerationModel(provider, selected.model)) return undefined;
  return { defaultModel: selected };
}
// --- image generation (end) -------------------------------------------------

export function normalizeMemorySettings(
  input: unknown,
  customProviders: CustomProvider[],
): MemorySettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const organizerModel = normalizeSelectedModelForProviders(
    normalizeSelectedModel(obj.organizerModel),
    customProviders,
  );
  const organizerSchedule = normalizeMemoryOrganizerSchedule(obj.organizerSchedule);
  const organizerEnabled =
    obj.organizerEnabled === true &&
    Boolean(organizerModel) &&
    organizerSchedule.frequency !== "none";
  const organizerNextRunAt = organizerEnabled
    ? (normalizeOptionalTimestamp(obj.organizerNextRunAt) ??
      computeNextMemoryOrganizerRunAt(organizerSchedule) ??
      undefined)
    : undefined;
  return {
    organizerModel,
    summaryModel: normalizeSelectedModelForProviders(
      normalizeSelectedModel(obj.summaryModel),
      customProviders,
    ),
    organizerEnabled,
    organizerSchedule,
    organizerScope: normalizeMemoryOrganizerScope(obj.organizerScope),
    organizerMode: normalizeMemoryOrganizerMode(obj.organizerMode),
    organizerLastRunAt: normalizeOptionalTimestamp(obj.organizerLastRunAt),
    organizerNextRunAt,
  };
}

export function normalizeCustomSettings(
  input: unknown,
  customProviders: CustomProvider[],
): CustomSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const chatSidebar = (
    obj.chatSidebar && typeof obj.chatSidebar === "object" ? obj.chatSidebar : {}
  ) as Record<string, unknown>;
  return {
    conversationTitleModel: normalizeSelectedModelForProviders(
      normalizeSelectedModel(obj.conversationTitleModel),
      customProviders,
    ),
    commitMessageModel: normalizeSelectedModelForProviders(
      normalizeSelectedModel(obj.commitMessageModel),
      customProviders,
    ),
    // 缺省开启：老配置无此字段时保持澄清按钮可见（与上线前行为一致）。
    promptClarifyEnabled: obj.promptClarifyEnabled !== false,
    promptClarifyModel: normalizeSelectedModelForProviders(
      normalizeSelectedModel(obj.promptClarifyModel),
      customProviders,
    ),
    chatSidebar: {
      projectsCollapsed: chatSidebar.projectsCollapsed === true,
      recentCollapsed: chatSidebar.recentCollapsed === true,
    },
    sidebarShortcuts: normalizeSidebarShortcuts(obj.sidebarShortcuts),
    chatTranscript: normalizeChatTranscriptSettings(obj.chatTranscript),
    rightDock: normalizeRightDockSettings(obj.rightDock),
    // 三档枚举：历史配置无此字段或值不合法（含曾设想过的 "auto"）一律落回默认的统计状态栏。
    composerContextDisplay:
      obj.composerContextDisplay === "ring" || obj.composerContextDisplay === "both"
        ? obj.composerContextDisplay
        : "statsBar",
    // fontFamily was the single pre-split preference. Read it only to migrate
    // saved local settings into the new interface-specific field.
    interfaceFontFamily: normalizeFontFamily(obj.interfaceFontFamily ?? obj.fontFamily),
    chatFontFamily: normalizeFontFamily(obj.chatFontFamily),
    codeFontFamily: normalizeFontFamily(obj.codeFontFamily),
    fontScale: normalizeFontScaleSettings(obj.fontScale),
  };
}

export function normalizeUpdateSettings(input: unknown): UpdateSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    includePrereleases: obj.includePrereleases === true,
  };
}

export function getDefaultSettings(): AppSettings {
  const customProviders = getBuiltinCustomProviders();
  return {
    system: {
      executionMode: "tools",
      workdir: "",
      commandSafetyMode: "auto",
      browserAutomationMode: "auto",
      workspaceProjects: [],
      workspaceProjectGroups: [],
      activeWorkspaceProjectId: undefined,
      hiddenWorkspaceProjectPaths: [],
      missingWorkspaceProjectPaths: [],
      archivedWorkspaceProjectPaths: [],
      workspaceProjectOrder: [],
      sidebarPinnedOrder: [],
      workspaceResourceSettings: {},
      systemProxy: getDefaultSystemProxyConfig(),
    },
    customProviders,
    mcp: {
      servers: [],
      selected: [],
    },
    agents: [],
    ssh: {
      hosts: [],
      projectHostAssociations: {},
    },
    remote: {
      enabled: false,
      gatewayUrl: "",
      gatewayPort: 443,
      token: "",
      agentId: "",
      autoReconnect: true,
      heartbeatInterval: 30,
      enableWebTerminal: false,
      enableWebSshTerminal: false,
      enableWebGit: false,
      enableWebTunnels: false,
    },
    stt: getDefaultSttSettings(),
    memory: normalizeMemorySettings({}, customProviders),
    customSettings: normalizeCustomSettings({}, customProviders),
    modelFailover: normalizeModelFailoverSettings({}, customProviders),
    retryErrorSettings: normalizeRetryErrorSettings({}),
    updates: normalizeUpdateSettings({}),
    skills: {
      enabled: true,
      selected: mergeAlwaysEnabledSkillNames([]),
    },
    chatRuntimeControls: DEFAULT_CHAT_RUNTIME_CONTROLS,
    selectedModel: undefined,
    theme: "light",
    locale: detectSystemLocale(),
    closeWindowBehavior: "minimize",
  };
}

export function normalizeSettings(input?: Partial<AppSettings> | null): AppSettings {
  const defaults = getDefaultSettings();
  const obj = (input && typeof input === "object" ? input : {}) as Partial<AppSettings>;
  const customProviders = Array.isArray(obj.customProviders)
    ? obj.customProviders.map((provider) => normalizeCustomProvider(provider))
    : defaults.customProviders;
  const selectedModel = normalizeSelectedModelForProviders(
    normalizeSelectedModel(obj.selectedModel),
    customProviders,
  );
  const locale = Object.hasOwn(obj, "locale") ? obj.locale : defaults.locale;

  return {
    system: normalizeSystemSettings(obj.system ?? defaults.system),
    customProviders,
    mcp: normalizeMcpSettings(obj.mcp ?? defaults.mcp),
    agents: normalizeAgentPromptTemplates(obj.agents ?? defaults.agents),
    ssh: normalizeSshSettings(obj.ssh ?? defaults.ssh),
    remote: normalizeRemoteSettings(obj.remote ?? defaults.remote),
    stt: normalizeSttSettings(obj.stt ?? defaults.stt),
    memory: normalizeMemorySettings(obj.memory ?? defaults.memory, customProviders),
    customSettings: normalizeCustomSettings(
      obj.customSettings ?? defaults.customSettings,
      customProviders,
    ),
    modelFailover: normalizeModelFailoverSettings(
      obj.modelFailover ?? defaults.modelFailover,
      customProviders,
    ),
    retryErrorSettings: normalizeRetryErrorSettings(
      obj.retryErrorSettings ?? defaults.retryErrorSettings,
    ),
    updates: normalizeUpdateSettings(obj.updates ?? defaults.updates),
    skills: normalizeSkillsSettings(obj.skills ?? defaults.skills),
    chatRuntimeControls: normalizeChatRuntimeControls(
      obj.chatRuntimeControls ?? defaults.chatRuntimeControls,
    ),
    selectedModel,
    // --- image generation (begin) -------------------------------------------
    ...(() => {
      const imageGeneration = normalizeImageGenerationSettings(
        obj.imageGeneration,
        customProviders,
      );
      return imageGeneration ? { imageGeneration } : {};
    })(),
    // --- image generation (end) ---------------------------------------------
    theme: normalizeTheme(obj.theme),
    locale: normalizeLocale(locale),
    closeWindowBehavior: normalizeCloseWindowBehavior(obj.closeWindowBehavior),
  };
}

export function updateSystem(prev: AppSettings, patch: Partial<SystemSettings>): AppSettings {
  return normalizeSettings({
    ...prev,
    system: {
      ...prev.system,
      ...patch,
    },
  });
}

export function updateExecutionModeFromChatSelection(
  prev: AppSettings,
  mode: "text" | "tools",
): AppSettings {
  const current = prev.system.executionMode;
  if (mode === "text") {
    return current === "text" ? prev : updateSystem(prev, { executionMode: "text" });
  }
  return current === "text" ? updateSystem(prev, { executionMode: "tools" }) : prev;
}

export function updateMcp(prev: AppSettings, patch: Partial<McpSettings>): AppSettings {
  return normalizeSettings({
    ...prev,
    mcp: {
      ...prev.mcp,
      ...patch,
    },
  });
}

export function updateAgents(prev: AppSettings, agents: AgentPromptTemplate[]): AppSettings {
  return normalizeSettings({
    ...prev,
    agents,
  });
}

export function updateSsh(prev: AppSettings, patch: Partial<SshSettings>): AppSettings {
  return normalizeSettings({
    ...prev,
    ssh: {
      ...prev.ssh,
      ...patch,
    },
  });
}

function normalizeSshProjectHostIdList(ssh: SshSettings, hostIds: readonly string[]): string[] {
  const availableHostIds = new Set(ssh.hosts.map((host) => host.id));
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const rawHostId of hostIds) {
    const hostId = rawHostId.trim();
    if (!hostId || !availableHostIds.has(hostId) || seen.has(hostId)) continue;
    seen.add(hostId);
    ids.push(hostId);
    if (ids.length >= 64) break;
  }
  return ids;
}

export function getSshProjectHostIds(ssh: SshSettings, projectPathKey: string): string[] {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return [];
  return normalizeSshProjectHostIdList(ssh, ssh.projectHostAssociations[normalizedPathKey] ?? []);
}

export function updateSshProjectHostIds(
  prev: AppSettings,
  projectPathKey: string,
  hostIds: readonly string[],
): AppSettings {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return prev;
  const nextHostIds = normalizeSshProjectHostIdList(prev.ssh, hostIds);
  const currentHostIds = getSshProjectHostIds(prev.ssh, normalizedPathKey);
  if (
    currentHostIds.length === nextHostIds.length &&
    currentHostIds.every((hostId, index) => hostId === nextHostIds[index])
  ) {
    return prev;
  }
  const projectHostAssociations = { ...prev.ssh.projectHostAssociations };
  if (nextHostIds.length > 0) {
    projectHostAssociations[normalizedPathKey] = nextHostIds;
  } else {
    delete projectHostAssociations[normalizedPathKey];
  }
  return updateSsh(prev, { projectHostAssociations });
}

export function removeSshHostFromProjectAssociations(
  prev: AppSettings,
  hostId: string,
): AppSettings {
  const normalizedHostId = hostId.trim();
  if (!normalizedHostId) return prev;
  let changed = false;
  const projectHostAssociations: Record<string, string[]> = {};
  for (const [pathKey, hostIds] of Object.entries(prev.ssh.projectHostAssociations)) {
    const nextHostIds = hostIds.filter((item) => item !== normalizedHostId);
    if (nextHostIds.length !== hostIds.length) {
      changed = true;
    }
    if (nextHostIds.length > 0) {
      projectHostAssociations[pathKey] = nextHostIds;
    }
  }
  return changed ? updateSsh(prev, { projectHostAssociations }) : prev;
}

export function updateSkills(prev: AppSettings, patch: Partial<SkillsSettings>): AppSettings {
  return normalizeSettings({
    ...prev,
    skills: {
      ...prev.skills,
      ...patch,
    },
  });
}

export function resolveWorkspaceResources(
  settings: AppSettings,
  workdir: string,
): EffectiveWorkspaceResources {
  const pathKey = workspaceProjectPathKey(workdir);
  const entry = pathKey ? settings.system.workspaceResourceSettings[pathKey] : undefined;
  const mode = entry?.mode ?? "inherit";
  if (mode === "off") {
    return { mode, skillsEnabled: false, skillNames: [], mcpServerIds: [], mcpServers: [] };
  }

  const skillNames =
    mode === "custom"
      ? mergeAlwaysEnabledSkillNames(entry?.skillNames ?? [])
      : mergeAlwaysEnabledSkillNames(settings.skills.selected);
  const mcpServerIds =
    mode === "custom"
      ? [...(entry?.mcpServerIds ?? [])]
      : settings.mcp.servers.map((server) => server.id).filter(Boolean);
  const selectedMcpIds = mode === "custom" ? new Set(mcpServerIds) : null;
  const mcpServers = settings.mcp.servers.filter(
    (server) =>
      server.enabled && server.id.trim() && (!selectedMcpIds || selectedMcpIds.has(server.id)),
  );
  return {
    mode,
    skillsEnabled: settings.skills.enabled,
    skillNames: settings.skills.enabled ? skillNames : [],
    mcpServerIds,
    mcpServers,
  };
}

export function resolveEffectivePromptSettings(
  settings: AppSettings,
  workdir: string,
): EffectivePromptSettings {
  const globalTemplate = settings.agents.find(
    (template) => template.enabled && template.prompt.trim(),
  );
  const globalTemplates = globalTemplate ? [globalTemplate] : [];
  const globalPrompt = globalTemplate?.prompt.trim() ?? "";
  const pathKey = workspaceProjectPathKey(workdir);
  const entry = pathKey ? settings.system.workspaceResourceSettings[pathKey] : undefined;
  const projectPrompt = entry?.projectPrompt.trim() ?? "";
  const projectPromptStrategy = entry?.projectPromptStrategy ?? "append";
  const prompt = projectPrompt
    ? projectPromptStrategy === "replace" || !globalPrompt
      ? projectPrompt
      : `${globalPrompt}\n\n${projectPrompt}`
    : globalPrompt;
  return {
    globalTemplates,
    globalPrompt,
    projectPrompt,
    projectPromptStrategy,
    prompt,
  };
}

export function filterMcpSettingsForWorkspace(
  mcp: McpSettings,
  resources: Pick<EffectiveWorkspaceResources, "mode" | "mcpServerIds">,
): McpSettings {
  if (resources.mode === "inherit") return mcp;
  if (resources.mode === "off") return { ...mcp, servers: [] };
  const allowedIds = new Set(resources.mcpServerIds);
  return { ...mcp, servers: mcp.servers.filter((server) => allowedIds.has(server.id)) };
}

export function updateWorkspaceResourceSettings(
  prev: AppSettings,
  workdir: string,
  patch: Pick<WorkspaceResourceSettings, "mode" | "skillNames" | "mcpServerIds"> &
    Partial<Pick<WorkspaceResourceSettings, "projectPrompt" | "projectPromptStrategy">>,
): AppSettings {
  const pathKey = workspaceProjectPathKey(workdir);
  if (!pathKey) return prev;
  const entries = { ...prev.system.workspaceResourceSettings };
  const current = entries[pathKey];
  entries[pathKey] = normalizeWorkspaceResourceSettingsEntry({
    ...current,
    ...patch,
    stateVersion: (current?.stateVersion ?? 0) + 1,
    writerId: getRightDockWriterId(),
    updatedAt: Date.now(),
  });
  return normalizeSettings({
    ...prev,
    system: { ...prev.system, workspaceResourceSettings: entries },
  });
}

export function updateWorkspacePromptSettings(
  prev: AppSettings,
  workdir: string,
  patch: { projectPrompt: string; projectPromptStrategy: ProjectPromptStrategy },
): AppSettings {
  const pathKey = workspaceProjectPathKey(workdir);
  if (!pathKey) return prev;
  const entries = { ...prev.system.workspaceResourceSettings };
  const current = entries[pathKey];
  entries[pathKey] = normalizeWorkspaceResourceSettingsEntry({
    ...current,
    mode: current?.mode ?? "inherit",
    skillNames: current?.skillNames ?? [],
    mcpServerIds: current?.mcpServerIds ?? [],
    ...patch,
    stateVersion: (current?.stateVersion ?? 0) + 1,
    writerId: getRightDockWriterId(),
    updatedAt: Date.now(),
  });
  return normalizeSettings({
    ...prev,
    system: { ...prev.system, workspaceResourceSettings: entries },
  });
}

export function resetWorkspaceResourceSettings(prev: AppSettings, workdir: string): AppSettings {
  return updateWorkspaceResourceSettings(prev, workdir, {
    mode: "inherit",
    skillNames: [],
    mcpServerIds: [],
    projectPrompt: "",
    projectPromptStrategy: "append",
  });
}

export function removeWorkspaceResourceReferences(
  prev: AppSettings,
  references: { skillNames?: readonly string[]; mcpServerIds?: readonly string[] },
): AppSettings {
  const removedSkillNames = new Set(
    references.skillNames?.map((name) => name.trim()).filter(Boolean),
  );
  const removedMcpServerIds = new Set(
    references.mcpServerIds?.map((id) => id.trim()).filter(Boolean),
  );
  if (removedSkillNames.size === 0 && removedMcpServerIds.size === 0) return prev;

  let changed = false;
  const entries = { ...prev.system.workspaceResourceSettings };
  const writerId = getRightDockWriterId();
  const updatedAt = Date.now();
  for (const [pathKey, entry] of Object.entries(entries)) {
    if (entry.mode !== "custom") continue;
    const skillNames = entry.skillNames.filter((name) => !removedSkillNames.has(name));
    const mcpServerIds = entry.mcpServerIds.filter((id) => !removedMcpServerIds.has(id));
    if (
      skillNames.length === entry.skillNames.length &&
      mcpServerIds.length === entry.mcpServerIds.length
    ) {
      continue;
    }
    changed = true;
    entries[pathKey] = normalizeWorkspaceResourceSettingsEntry({
      ...entry,
      skillNames,
      mcpServerIds,
      stateVersion: entry.stateVersion + 1,
      writerId,
      updatedAt,
    });
  }
  if (!changed) return prev;
  return normalizeSettings({
    ...prev,
    system: { ...prev.system, workspaceResourceSettings: entries },
  });
}

export function updateMemorySettings(
  prev: AppSettings,
  patch: Partial<MemorySettings>,
): AppSettings {
  return normalizeSettings({
    ...prev,
    memory: {
      ...prev.memory,
      ...patch,
    },
  });
}

export function updateCustomSettings(
  prev: AppSettings,
  patch: Partial<CustomSettings>,
): AppSettings {
  return normalizeSettings({
    ...prev,
    customSettings: {
      ...prev.customSettings,
      ...patch,
    },
  });
}

/**
 * 澄清提示词的模型覆盖解析（两端共用）。返回 null 表示「跟随当前对话模型」：
 * 未选择、供应商已删或模型已停用（与 commitMessageModel 同一回退契约——
 * normalize 已在落库时清掉失效选择，这里再挡一次会话内的时序空窗）。
 */
export function resolvePromptClarifyModel(
  settings: AppSettings,
): { provider: CustomProvider; model: string } | null {
  const selected = settings.customSettings.promptClarifyModel;
  if (!selected) {
    return null;
  }
  const provider = settings.customProviders.find((item) => item.id === selected.customProviderId);
  if (!provider?.activeModels.includes(selected.model)) {
    return null;
  }
  return { provider, model: selected.model };
}

export function updateModelFailover(
  prev: AppSettings,
  family: ProviderProtocolFamily,
  patch: Partial<ProviderFailoverSettings>,
): AppSettings {
  return normalizeSettings({
    ...prev,
    modelFailover: {
      ...prev.modelFailover,
      [family]: {
        ...prev.modelFailover[family],
        ...patch,
      },
    },
  });
}

const RIGHT_DOCK_WRITER_ID_STORAGE_KEY = "liveagent.client-id";

let cachedRightDockWriterId = "";

function generateRightDockWriterId(): string {
  return createUuid().replace(/-/g, "").slice(0, 12);
}

// Stable per-client id used to break stateVersion ties deterministically in
// mergeSyncedRightDockSettings: both sides of a merge evaluate the same
// (stateVersion, writerId) order, so concurrent writers converge without the
// old "+2 beats the echo" version-bump tricks.
export function getRightDockWriterId(): string {
  if (cachedRightDockWriterId) return cachedRightDockWriterId;
  let stored = "";
  try {
    stored = globalThis.localStorage?.getItem(RIGHT_DOCK_WRITER_ID_STORAGE_KEY) ?? "";
  } catch {
    stored = "";
  }
  const normalized = stored.trim().slice(0, 32);
  if (normalized) {
    cachedRightDockWriterId = normalized;
    return normalized;
  }
  const generated = generateRightDockWriterId();
  try {
    globalThis.localStorage?.setItem(RIGHT_DOCK_WRITER_ID_STORAGE_KEY, generated);
  } catch {
    // Ephemeral id for environments without storage (e.g. tests).
  }
  cachedRightDockWriterId = generated;
  return generated;
}

// Version fields are stamped centrally by updateRightDockProjectState; content
// is everything a user can observe or reorder.
function rightDockProjectContentKey(state: RightDockProjectState): string {
  return JSON.stringify({
    activeTabId: state.activeTabId ?? "",
    tabOrder: state.tabOrder,
    tools: RIGHT_DOCK_TOOL_KINDS.map((kind) => [kind, state.tools[kind] ?? null]),
    backgroundTasks: state.backgroundTasks,
    openVersion: state.openVersion,
  });
}

function rightDockFileTreeStateEqual(
  left: RightDockFileTreeState,
  right: RightDockFileTreeState,
): boolean {
  return (
    left.query === right.query &&
    left.selectedPath === right.selectedPath &&
    left.showHidden === right.showHidden &&
    left.revision === right.revision &&
    left.expandedPaths.length === right.expandedPaths.length &&
    left.expandedPaths.every((path, index) => path === right.expandedPaths[index])
  );
}

export function getRightDockProjectState(
  customSettings: CustomSettings,
  projectPathKey: string,
): RightDockProjectState {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  return normalizeRightDockProjectState(
    normalizedPathKey ? customSettings.rightDock.projects[normalizedPathKey] : {},
  );
}

export function updateChatTranscriptWidth(prev: AppSettings, width: number): AppSettings {
  const nextWidth = normalizeChatTranscriptSettings({ width }).width;
  if (prev.customSettings.chatTranscript.width === nextWidth) return prev;
  return updateCustomSettings(prev, { chatTranscript: { width: nextWidth } });
}

export function updateRightDockWidth(prev: AppSettings, width: number): AppSettings {
  const nextWidth = normalizeIntegerInRange(width, 320, 1280, 420);
  if (prev.customSettings.rightDock.width === nextWidth) return prev;
  return updateCustomSettings(prev, {
    rightDock: {
      ...prev.customSettings.rightDock,
      width: nextWidth,
    },
  });
}

// All persisted dock mutations funnel through here: the updater describes
// content only, and version stamping (stateVersion / writerId / lastUsedAt)
// happens centrally so no call site can get the merge bookkeeping wrong.
export function updateRightDockProjectState(
  prev: AppSettings,
  projectPathKey: string,
  updater: (current: RightDockProjectState) => RightDockProjectState,
): AppSettings {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return prev;
  const current = getRightDockProjectState(prev.customSettings, normalizedPathKey);
  const next = normalizeRightDockProjectState(updater(current));
  if (rightDockProjectContentKey(current) === rightDockProjectContentKey(next)) return prev;
  return updateCustomSettings(prev, {
    rightDock: {
      ...prev.customSettings.rightDock,
      projects: {
        ...prev.customSettings.rightDock.projects,
        [normalizedPathKey]: {
          ...next,
          stateVersion: current.stateVersion + 1,
          writerId: getRightDockWriterId(),
          lastUsedAt: Date.now(),
        },
      },
    },
  });
}

export function createRightDockToolTab(kind: RightDockToolKind): RightDockToolTab {
  return {
    openedAt: Date.now(),
    ...(kind === "fileTree" ? { uiState: DEFAULT_RIGHT_DOCK_FILE_TREE_STATE } : {}),
  };
}

export function openRightDockToolTabState(
  current: RightDockProjectState,
  kind: RightDockToolKind,
): RightDockProjectState {
  const tabId = RIGHT_DOCK_SINGLETON_TAB_IDS[kind];
  const alreadyOpen = Boolean(current.tools[kind]);
  if (alreadyOpen && current.activeTabId === tabId && current.tabOrder.includes(tabId)) {
    return current;
  }
  return {
    ...current,
    activeTabId: tabId,
    tabOrder: current.tabOrder.includes(tabId) ? current.tabOrder : [...current.tabOrder, tabId],
    tools: alreadyOpen ? current.tools : { ...current.tools, [kind]: createRightDockToolTab(kind) },
    openVersion: current.openVersion + (alreadyOpen ? 0 : 1),
  };
}

export function openRightDockSingletonTab(
  prev: AppSettings,
  projectPathKey: string,
  kind: RightDockToolKind,
): AppSettings {
  return updateRightDockProjectState(prev, projectPathKey, (current) =>
    openRightDockToolTabState(current, kind),
  );
}

export function isRightDockSingletonTabOpen(
  customSettings: CustomSettings,
  projectPathKey: string,
  kind: RightDockToolKind,
): boolean {
  const state = getRightDockProjectState(customSettings, projectPathKey);
  return Boolean(state.tools[kind]);
}

// Open gesture for the background-tasks tab: pin it visible everywhere and
// clear any dismissal snapshot so previously hidden records reappear.
export function openRightDockBackgroundTasksTabState(
  current: RightDockProjectState,
): RightDockProjectState {
  const tabId = RIGHT_DOCK_BACKGROUND_TASKS_TAB_ID;
  return {
    ...current,
    activeTabId: tabId,
    tabOrder: current.tabOrder.includes(tabId) ? current.tabOrder : [...current.tabOrder, tabId],
    backgroundTasks: { opened: true, dismissedIds: [] },
  };
}

// Close gesture: hide-only. The visible process ids are snapshotted so a
// process outside the snapshot (a newly started one) re-derives the tab on
// every client. The persisted activeTabId stays put — render-time resolution
// falls back while the tab is hidden.
export function closeRightDockBackgroundTasksTabState(
  current: RightDockProjectState,
  visibleProcessIds: readonly string[],
): RightDockProjectState {
  return {
    ...current,
    backgroundTasks: { opened: false, dismissedIds: [...visibleProcessIds] },
  };
}

export function removeRightDockProjectState(
  prev: AppSettings,
  projectPathKey: string,
): AppSettings {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return prev;
  const hasRightDockProject = Object.hasOwn(
    prev.customSettings.rightDock.projects,
    normalizedPathKey,
  );
  const hasSshProjectAssociation = Object.hasOwn(
    prev.ssh.projectHostAssociations,
    normalizedPathKey,
  );
  if (!hasRightDockProject && !hasSshProjectAssociation) return prev;
  const currentRightDockProject = getRightDockProjectState(prev.customSettings, normalizedPathKey);
  const hasRightDockTools =
    Object.keys(currentRightDockProject.tools).length > 0 ||
    currentRightDockProject.backgroundTasks.opened ||
    currentRightDockProject.backgroundTasks.dismissedIds.length > 0;
  if (hasRightDockProject && !hasRightDockTools && !hasSshProjectAssociation) return prev;

  const projects = hasRightDockProject
    ? { ...prev.customSettings.rightDock.projects }
    : prev.customSettings.rightDock.projects;
  if (hasRightDockProject && hasRightDockTools) {
    projects[normalizedPathKey] = {
      tabOrder: [],
      tools: {},
      backgroundTasks: { opened: false, dismissedIds: [] },
      openVersion: currentRightDockProject.openVersion + 1,
      stateVersion: currentRightDockProject.stateVersion + 1,
      writerId: getRightDockWriterId(),
      lastUsedAt: Date.now(),
    };
  }
  const projectHostAssociations = hasSshProjectAssociation
    ? { ...prev.ssh.projectHostAssociations }
    : prev.ssh.projectHostAssociations;
  if (hasSshProjectAssociation) delete projectHostAssociations[normalizedPathKey];

  return normalizeSettings({
    ...prev,
    ssh: {
      ...prev.ssh,
      projectHostAssociations,
    },
    customSettings: {
      ...prev.customSettings,
      rightDock: {
        ...prev.customSettings.rightDock,
        projects,
      },
    },
  });
}

export function getRightDockFileTreeState(
  customSettings: CustomSettings,
  projectPathKey: string,
): RightDockFileTreeState {
  const projectState = getRightDockProjectState(customSettings, projectPathKey);
  const state = projectState.tools.fileTree?.uiState;
  return state ? normalizeRightDockFileTreeState(state) : DEFAULT_RIGHT_DOCK_FILE_TREE_STATE;
}

export function updateRightDockFileTreeState(
  prev: AppSettings,
  projectPathKey: string,
  patch: RightDockFileTreeStatePatch,
): AppSettings {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return prev;
  const current = getRightDockFileTreeState(prev.customSettings, normalizedPathKey);
  const next: RightDockFileTreeState = {
    query:
      patch.query !== undefined
        ? normalizeRightDockFileTreeSearchQuery(patch.query)
        : current.query,
    selectedPath:
      patch.selectedPath !== undefined
        ? normalizeRightDockFileTreePath(patch.selectedPath)
        : current.selectedPath,
    expandedPaths:
      patch.expandedPaths !== undefined
        ? normalizeRightDockFileTreeExpandedPaths(patch.expandedPaths)
        : current.expandedPaths,
    showHidden: patch.showHidden ?? current.showHidden,
    revision: patch.bumpRevision
      ? current.revision + 1
      : patch.revision !== undefined
        ? normalizeIntegerInRange(patch.revision, 0, Number.MAX_SAFE_INTEGER, 0)
        : current.revision,
  };
  if (rightDockFileTreeStateEqual(current, next)) return prev;
  return updateRightDockProjectState(prev, normalizedPathKey, (projectState) => {
    const tab = projectState.tools.fileTree ?? createRightDockToolTab("fileTree");
    return {
      ...projectState,
      tools: {
        ...projectState.tools,
        fileTree: { ...tab, uiState: next },
      },
    };
  });
}

export function updateUpdateSettings(
  prev: AppSettings,
  patch: Partial<UpdateSettings>,
): AppSettings {
  return normalizeSettings({
    ...prev,
    updates: {
      ...prev.updates,
      ...patch,
    },
  });
}

export function updateCustomProviders(
  prev: AppSettings,
  customProviders: CustomProvider[],
): AppSettings {
  return normalizeSettings({
    ...prev,
    customProviders,
  });
}

export function setSelectedModel(
  prev: AppSettings,
  selectedModel: SelectedModel | undefined,
): AppSettings {
  return normalizeSettings({
    ...prev,
    selectedModel,
  });
}
