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
import {
  clampThinkingLevelToList,
  resolveModelThinking,
  type ThinkingLevel,
} from "@liveagent/ui/lib/models/modelThinking";
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
import {
  DEFAULT_RIGHT_DOCK_FILE_TREE_STATE,
  normalizeRightDockFileTreeExpandedPaths,
  normalizeRightDockFileTreeSearchQuery,
  normalizeRightDockFileTreeState,
  normalizeRightDockProjectState,
  normalizeRightDockSettings,
  RIGHT_DOCK_SINGLETON_TAB_IDS,
} from "./rightDockNormalization";
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
  ChatRuntimeControls,
  ChatRuntimeReasoningProviderKey,
  CloseWindowBehavior,
  CodexRequestFormat,
  CustomProvider,
  CustomSettings,
  EffectiveWorkspaceResources,
  ExecutionMode,
  McpServerConfig,
  McpSettings,
  McpTransport,
  MemorySettings,
  ModelLimitsSource,
  PromptCacheHintMode,
  ProviderFailoverSettings,
  ProviderId,
  ProviderModelConfig,
  ReasoningLevel,
  RemoteSettings,
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
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  getDefaultUsageQueryConfig,
  PROMPT_CACHE_HINT_MODES,
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
  normalizeModelFailoverSettings,
  normalizeProviderFailoverSettings,
} from "./modelFailover";
export {
  normalizeChatTranscriptSettings,
  normalizeFontScale,
  normalizeFontScaleSettings,
} from "./normalizers";
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
      nativeWebSearchEnabled: false,
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
    enableWebAutomation: obj.enableWebAutomation === true,
  };
}

function getKnownModelLimits(
  providerId: ProviderId,
  modelId: string | undefined,
  baseUrl?: string,
): Pick<ProviderModelConfig, "contextWindow" | "maxOutputToken"> | undefined {
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

export function getProviderModelDefaults(
  providerId: ProviderId,
  modelId?: string,
  baseUrl?: string,
): Pick<ProviderModelConfig, "contextWindow" | "maxOutputToken"> & { source: ModelLimitsSource } {
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
    maxOutputToken: defaults.maxOutputToken,
    limitsSource: defaults.source,
  };
}

const VALID_LIMITS_SOURCES: readonly ModelLimitsSource[] = ["catalog", "provider", "fallback", "user"];

function normalizeLimitsSource(value: unknown): ModelLimitsSource | undefined {
  return typeof value === "string" &&
    (VALID_LIMITS_SOURCES as readonly string[]).includes(value)
    ? (value as ModelLimitsSource)
    : undefined;
}

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
      limits = { contextWindow: catalogDefaults.contextWindow, maxOutputToken: catalogDefaults.maxOutputToken };
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
  return {
    id,
    ...(ownedBy ? { ownedBy } : {}),
    contextWindow: limits.contextWindow,
    maxOutputToken: limits.maxOutputToken,
    limitsSource,
    ...(promptCacheHintMode ? { promptCacheHintMode } : {}),
  };
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

export function normalizeCustomProvider(input: unknown): CustomProvider {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const type = normalizeProviderId(obj.type);
  const isFullUrl = obj.isFullUrl === true;
  const codexRouting =
    type === "codex" || type === "xai"
      ? normalizeCodexRouting(
          obj.baseUrl,
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

  return {
    id,
    name: normalizeProviderName(id, obj.name),
    type,
    baseUrl: codexRouting
      ? codexRouting.baseUrl
      : normalizeBaseUrl(typeof obj.baseUrl === "string" ? obj.baseUrl : ""),
    isFullUrl,
    ...(type !== "gemini" && typeof obj.modelsUrl === "string" && obj.modelsUrl.trim()
      ? { modelsUrl: obj.modelsUrl.trim() }
      : {}),
    apiKey,
    apiKeyConfigured: apiKey.length > 0 || obj.apiKeyConfigured === true,
    customHeaders: normalizeCustomHeaders(obj.customHeaders),
    models,
    ...(modelOrder ? { modelOrder } : {}),
    activeModels: normalizeModels(normalizeStringArray(obj.activeModels)).filter((modelId) =>
      validModelIds.has(modelId),
    ),
    requestFormat: type === "xai" ? "openai-responses" : codexRouting?.requestFormat,
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
    nativeWebSearchEnabled: type === "deepseek" ? false : obj.nativeWebSearchEnabled !== false,
    useSystemProxy: obj.useSystemProxy === true,
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

export function normalizeSystemSettings(input: unknown): SystemSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    executionMode: normalizeExecutionMode(obj.executionMode),
    workdir: normalizeWorkdir(obj.workdir),
    toolPolicies: normalizeToolPolicies(obj.toolPolicies),
    workspaceProjects: normalizeWorkspaceProjects(obj.workspaceProjects),
    workspaceProjectGroups: normalizeWorkspaceProjectGroups(obj.workspaceProjectGroups),
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

export function normalizeMcpServerConfig(input: unknown): McpServerConfig {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  const docsUrl = typeof obj.docsUrl === "string" ? obj.docsUrl.trim() : "";
  const cwd = typeof obj.cwd === "string" ? obj.cwd.trim() : "";
  const messageUrl = typeof obj.messageUrl === "string" ? obj.messageUrl.trim() : "";

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
    enabled: obj.enabled === false ? false : true,
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
  if (!provider) {
    return undefined;
  }

  return provider.activeModels.includes(selectedModel.model) ? selectedModel : undefined;
}

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
    chatSidebar: {
      projectsCollapsed: chatSidebar.projectsCollapsed === true,
      recentCollapsed: chatSidebar.recentCollapsed === true,
    },
    chatTranscript: normalizeChatTranscriptSettings(obj.chatTranscript),
    rightDock: normalizeRightDockSettings(obj.rightDock),
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
      workspaceProjects: [],
      workspaceProjectGroups: [],
      activeWorkspaceProjectId: undefined,
      hiddenWorkspaceProjectPaths: [],
      missingWorkspaceProjectPaths: [],
      archivedWorkspaceProjectPaths: [],
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
      enableWebAutomation: false,
    },
    memory: normalizeMemorySettings({}, customProviders),
    customSettings: normalizeCustomSettings({}, customProviders),
    modelFailover: normalizeModelFailoverSettings({}, customProviders),
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
    memory: normalizeMemorySettings(obj.memory ?? defaults.memory, customProviders),
    customSettings: normalizeCustomSettings(
      obj.customSettings ?? defaults.customSettings,
      customProviders,
    ),
    modelFailover: normalizeModelFailoverSettings(
      obj.modelFailover ?? defaults.modelFailover,
      customProviders,
    ),
    updates: normalizeUpdateSettings(obj.updates ?? defaults.updates),
    skills: normalizeSkillsSettings(obj.skills ?? defaults.skills),
    chatRuntimeControls: normalizeChatRuntimeControls(
      obj.chatRuntimeControls ?? defaults.chatRuntimeControls,
    ),
    selectedModel,
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
  patch: Pick<WorkspaceResourceSettings, "mode" | "skillNames" | "mcpServerIds">,
): AppSettings {
  const pathKey = workspaceProjectPathKey(workdir);
  if (!pathKey) return prev;
  const entries = { ...prev.system.workspaceResourceSettings };
  const current = entries[pathKey];
  entries[pathKey] = normalizeWorkspaceResourceSettingsEntry({
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

export function updateModelFailover(
  prev: AppSettings,
  providerType: ProviderId,
  patch: Partial<ProviderFailoverSettings>,
): AppSettings {
  return normalizeSettings({
    ...prev,
    modelFailover: {
      ...prev.modelFailover,
      [providerType]: {
        ...prev.modelFailover[providerType],
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
