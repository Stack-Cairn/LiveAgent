import { invoke } from "@tauri-apps/api/core";
import { isGatewayWebuiRuntime } from "../../lib/runtimeEnv";
import {
  createProviderModelConfig,
  normalizeProviderModelConfigs,
  type ProviderId,
  type ProviderModelConfig,
  USAGE_QUERY_TIMEOUT_DEFAULT_SECS,
  USAGE_QUERY_TIMEOUT_MAX_SECS,
  USAGE_QUERY_TIMEOUT_MIN_SECS,
  type UsageQueryCodingPlanProvider,
  type UsageQueryConfig,
  type UsageQueryMode,
} from "../../lib/settings";
import { normalizeBaseUrl } from "../../lib/settings/normalize";

const CODEX_MODELS_SUFFIXES = ["/chat/completions", "/responses", "/response"];
const GEMINI_GENERATE_SUFFIXES = [":streamGenerateContent", ":generateContent"];

// Gateway WebUI 判定移至 lib/runtimeEnv 单一真源；此处再导出保持既有调用方不变。
export { isGatewayWebuiRuntime };

const REDACTED_USAGE_QUERY_SECRET_DISPLAY = "••••••••";

// KEEP IN SYNC:general/newapi 预设与桌面端 Rust services/provider_usage.rs 的
// GENERAL_SCRIPT / NEWAPI_SCRIPT 逐字符一致(脚本为空的存量配置由 Rust 兜底执行);
// custom 骨架仅前端填充(Rust 对空的 custom 脚本直接报错,无兜底)。三者内容
// 一比一复刻 cc-switch UsageScriptModal 的模板。
export const USAGE_QUERY_PRESET_SCRIPTS: Partial<Record<UsageQueryMode, string>> = {
  custom: `({
  request: {
    url: "",
    method: "GET",
    headers: {}
  },
  extractor: function(response) {
    return {
      remaining: 0,
      unit: "USD"
    };
  }
})`,
  general: `({
  request: {
    url: "{{baseUrl}}/user/balance",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "User-Agent": "LiveAgent/1.0"
    }
  },
  extractor: function(response) {
    return {
      isValid: response.is_active || true,
      remaining: response.balance,
      unit: "USD"
    };
  }
})`,
  newapi: `({
  request: {
    url: "{{baseUrl}}/api/user/self",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer {{accessToken}}",
      "User-Agent": "LiveAgent/1.0",
      "New-Api-User": "{{userId}}"
    },
  },
  extractor: function (response) {
    if (response.success && response.data) {
      return {
        planName: response.data.group || "Balance",
        remaining: response.data.quota / 500000,
        used: response.data.used_quota / 500000,
        total: (response.data.quota + response.data.used_quota) / 500000,
        unit: "USD",
      };
    }
    return {
      isValid: false,
      invalidMessage: response.message || "NewAPI usage query failed"
    };
  },
})`,
};

const USAGE_QUERY_SCRIPT_MODES = ["custom", "general", "newapi"] as const;
type UsageQueryScriptMode = (typeof USAGE_QUERY_SCRIPT_MODES)[number];

// Token Plan 供应商路由表(一比一复刻 cc-switch codingPlanProviders.ts):
// pattern 与 Rust prepare_coding_plan_query 的 host 检测同效;智谱团队与个人版
// base_url 相同,必须靠显式选择路由(pattern 仅占位,不参与自动检测——个人版
// 排在前面,首匹配恒命中个人版)。
export const USAGE_QUERY_CODING_PLAN_PROVIDERS: readonly {
  id: Exclude<UsageQueryCodingPlanProvider, "">;
  label: string;
  pattern: RegExp;
}[] = [
  { id: "kimi", label: "Kimi For Coding", pattern: /api\.kimi\.com\/coding/i },
  { id: "zhipu", label: "Zhipu GLM (智谱)", pattern: /bigmodel\.cn|api\.z\.ai/i },
  { id: "zhipu_team", label: "Zhipu GLM Team (智谱团队)", pattern: /bigmodel\.cn/i },
  { id: "minimax", label: "MiniMax", pattern: /api\.minimaxi?\.com|api\.minimax\.io/i },
  { id: "zenmux", label: "ZenMux", pattern: /zenmux\./i },
  { id: "volcengine", label: "火山方舟 (Volcengine)", pattern: /volces\.com\/api\/coding/i },
];

/** 根据 Base URL 自动检测 Token Plan 供应商;未命中返回 ""。 */
export function detectCodingPlanProvider(
  baseUrl: string | undefined | null,
): UsageQueryCodingPlanProvider {
  if (!baseUrl) return "";
  for (const entry of USAGE_QUERY_CODING_PLAN_PROVIDERS) {
    if (entry.pattern.test(baseUrl)) return entry.id;
  }
  return "";
}

// 官方余额供应商检测表(一比一复刻 cc-switch BALANCE_PROVIDERS)。
export const USAGE_QUERY_BALANCE_PROVIDERS: readonly {
  id: string;
  label: string;
  pattern: RegExp;
}[] = [
  { id: "deepseek", label: "DeepSeek", pattern: /api\.deepseek\.com/i },
  { id: "stepfun", label: "StepFun", pattern: /api\.stepfun\.(ai|com)/i },
  { id: "siliconflow", label: "SiliconFlow", pattern: /api\.siliconflow\.(cn|com)/i },
  { id: "openrouter", label: "OpenRouter", pattern: /openrouter\.ai/i },
  { id: "novita", label: "Novita AI", pattern: /api\.novita\.ai/i },
];

/** 官方余额模式:按 Base URL 匹配到的供应商徽章列表。 */
export function matchBalanceProviders(baseUrl: string | undefined | null) {
  if (!baseUrl) return [];
  return USAGE_QUERY_BALANCE_PROVIDERS.filter((entry) => entry.pattern.test(baseUrl));
}

export function isUsageQueryScriptMode(mode: UsageQueryMode): mode is UsageQueryScriptMode {
  return (USAGE_QUERY_SCRIPT_MODES as readonly string[]).includes(mode);
}

/**
 * 切换查询方式:脚本按模式各自独立——离开脚本模式时把编辑器内容存回
 * scripts[旧模式],进入脚本模式时恢复 scripts[新模式],没填写过的显示模板预设
 * (custom 为空骨架)。打开弹窗时以 (draft, draft.mode) 调用,为存量单 script
 * 配置做 seeding。balance/coding-plan 无脚本,不动编辑器内容。
 */
export function applyUsageQueryModePreset(
  previous: UsageQueryConfig,
  mode: UsageQueryMode,
): UsageQueryConfig {
  const scripts = { ...previous.scripts };
  if (isUsageQueryScriptMode(previous.mode) && previous.script.trim()) {
    scripts[previous.mode] = previous.script;
  }
  const next = { ...previous, mode, scripts };
  if (isUsageQueryScriptMode(mode)) {
    const saved = scripts[mode];
    next.script = saved?.trim() ? saved : (USAGE_QUERY_PRESET_SCRIPTS[mode] ?? "");
  }
  return next;
}

/** 编辑器内容变更:同步写入当前模式的独立脚本槽位。 */
export function setUsageQueryScript(previous: UsageQueryConfig, script: string): UsageQueryConfig {
  const next = { ...previous, script };
  if (isUsageQueryScriptMode(previous.mode)) {
    next.scripts = { ...previous.scripts, [previous.mode]: script };
  }
  return next;
}

function clampUsageQueryInt(value: number, min: number, max: number, fallback: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, rounded));
}

export function clampUsageQueryTimeoutSecs(value: number): number {
  return clampUsageQueryInt(
    value,
    USAGE_QUERY_TIMEOUT_MIN_SECS,
    USAGE_QUERY_TIMEOUT_MAX_SECS,
    USAGE_QUERY_TIMEOUT_DEFAULT_SECS,
  );
}

export function createUsageQueryDraft(
  usageQuery: UsageQueryConfig,
  useRedactedSecrets: boolean,
): UsageQueryConfig {
  const apiKeyIsRedacted =
    useRedactedSecrets && !usageQuery.apiKey && usageQuery.apiKeyConfigured === true;
  const accessTokenIsRedacted =
    useRedactedSecrets && !usageQuery.accessToken && usageQuery.accessTokenConfigured === true;
  const secretAccessKeyIsRedacted =
    useRedactedSecrets &&
    !usageQuery.secretAccessKey &&
    usageQuery.secretAccessKeyConfigured === true;

  return {
    ...usageQuery,
    apiKey: apiKeyIsRedacted ? REDACTED_USAGE_QUERY_SECRET_DISPLAY : usageQuery.apiKey,
    accessToken: accessTokenIsRedacted
      ? REDACTED_USAGE_QUERY_SECRET_DISPLAY
      : usageQuery.accessToken,
    secretAccessKey: secretAccessKeyIsRedacted
      ? REDACTED_USAGE_QUERY_SECRET_DISPLAY
      : usageQuery.secretAccessKey,
  };
}

export function serializeUsageQueryDraft(
  usageQuery: UsageQueryConfig,
  useRedactedSecrets: boolean,
): UsageQueryConfig {
  const apiKeyIsRedacted =
    useRedactedSecrets && usageQuery.apiKey === REDACTED_USAGE_QUERY_SECRET_DISPLAY;
  const accessTokenIsRedacted =
    useRedactedSecrets && usageQuery.accessToken === REDACTED_USAGE_QUERY_SECRET_DISPLAY;
  const secretAccessKeyIsRedacted =
    useRedactedSecrets && usageQuery.secretAccessKey === REDACTED_USAGE_QUERY_SECRET_DISPLAY;
  const apiKey = apiKeyIsRedacted ? "" : usageQuery.apiKey.trim();
  const accessToken = accessTokenIsRedacted ? "" : usageQuery.accessToken.trim();
  const secretAccessKey = secretAccessKeyIsRedacted ? "" : usageQuery.secretAccessKey.trim();
  // 编辑器当前内容并入所属模式槽位后逐项 trim,空脚本槽位不落盘。
  const mergedScripts = {
    ...usageQuery.scripts,
    ...(isUsageQueryScriptMode(usageQuery.mode) ? { [usageQuery.mode]: usageQuery.script } : {}),
  };
  const scripts: UsageQueryConfig["scripts"] = {};
  for (const mode of USAGE_QUERY_SCRIPT_MODES) {
    const value = mergedScripts[mode];
    if (typeof value === "string" && value.trim()) {
      scripts[mode] = value.trim();
    }
  }

  return {
    ...usageQuery,
    script: usageQuery.script.trim(),
    scripts,
    baseUrl: usageQuery.baseUrl.trim(),
    apiKey,
    apiKeyConfigured: apiKey.length > 0 || apiKeyIsRedacted,
    accessToken,
    accessTokenConfigured: accessToken.length > 0 || accessTokenIsRedacted,
    userId: usageQuery.userId.trim(),
    accessKeyId: usageQuery.accessKeyId.trim(),
    teamOrganizationId: usageQuery.teamOrganizationId.trim(),
    teamProjectId: usageQuery.teamProjectId.trim(),
    secretAccessKey,
    secretAccessKeyConfigured: secretAccessKey.length > 0 || secretAccessKeyIsRedacted,
    timeoutSecs: clampUsageQueryTimeoutSecs(usageQuery.timeoutSecs),
  };
}

export function getPersistedUsageQueryProviderId(provider: { id?: string } | null | undefined) {
  const id = provider?.id?.trim();
  return id || null;
}

export function requiresCustomUsageQueryConfirmation(
  usageQuery: Pick<UsageQueryConfig, "enabled" | "mode">,
  customUsageQueryConfirmed: boolean,
) {
  return usageQuery.enabled && usageQuery.mode === "custom" && !customUsageQueryConfirmed;
}

export function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${String(Math.round(value / 1_000))}K`;
  const millions = value / 1_000_000;
  return `${Number.isInteger(millions) ? String(millions) : millions.toFixed(1)}M`;
}

function normalizeModelBaseUrl(type: ProviderId, baseUrl: string) {
  let normalizedUrl = normalizeBaseUrl(baseUrl);

  if (type !== "codex" && type !== "xai" && type !== "gemini") {
    return normalizedUrl;
  }

  const lower = normalizedUrl.toLowerCase();

  if (type === "codex" || type === "xai") {
    for (const suffix of CODEX_MODELS_SUFFIXES) {
      if (lower.endsWith(suffix)) {
        normalizedUrl = normalizedUrl.slice(0, -suffix.length);
        break;
      }
    }
  } else {
    for (const suffix of GEMINI_GENERATE_SUFFIXES) {
      if (lower.endsWith(suffix.toLowerCase())) {
        normalizedUrl = normalizedUrl.slice(0, -suffix.length);
        break;
      }
    }
    const modelsIndex = normalizedUrl.toLowerCase().lastIndexOf("/models");
    if (modelsIndex >= 0) {
      const afterModels = normalizedUrl.slice(modelsIndex + "/models".length);
      if (!afterModels || afterModels.startsWith("/")) {
        normalizedUrl = normalizedUrl.slice(0, modelsIndex);
      }
    }
  }

  return normalizeBaseUrl(normalizedUrl);
}

function extractModelListItems(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  const payload = data as { data?: unknown; models?: unknown } | null;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  return null;
}

export function normalizeFetchedModels(
  items: unknown,
  providerType: ProviderId,
): ProviderModelConfig[] {
  if (providerType === "gemini") {
    return normalizeGeminiFetchedModels(items);
  }
  return normalizeProviderModelConfigs(items, providerType);
}

function normalizeApiFetchedModels(
  items: unknown,
  providerType: ProviderId,
): ProviderModelConfig[] {
  const models = normalizeFetchedModels(items, providerType);
  if (providerType !== "claude_code") return models;

  return models.map((model) => {
    const defaults = createProviderModelConfig(providerType, model.id);
    const roundsToOneMillion =
      model.contextWindow < 1_000_000 && Math.round(model.contextWindow / 1_000) === 1_000;
    return defaults.contextWindow === 1_000_000 && roundsToOneMillion
      ? { ...model, contextWindow: defaults.contextWindow }
      : model;
  });
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.floor(numeric);
}

function normalizeGeminiModelId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.startsWith("models/") ? raw.slice("models/".length) : raw;
}

function normalizeGeminiFetchedModels(items: unknown): ProviderModelConfig[] {
  if (!Array.isArray(items)) return [];

  const out: ProviderModelConfig[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const obj = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const supportedMethods = Array.isArray(obj.supportedGenerationMethods)
      ? obj.supportedGenerationMethods.filter((value): value is string => typeof value === "string")
      : [];
    if (supportedMethods.length > 0 && !supportedMethods.includes("generateContent")) {
      continue;
    }

    const id = normalizeGeminiModelId(obj.name ?? obj.id ?? obj.model);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const draft = createProviderModelConfig("gemini", id);
    const ownedBy =
      (typeof obj.ownedBy === "string" ? obj.ownedBy.trim() : "") ||
      (typeof obj.owned_by === "string" ? obj.owned_by.trim() : "");
    out.push({
      id,
      ...(ownedBy ? { ownedBy } : {}),
      contextWindow: normalizePositiveInteger(obj.inputTokenLimit) ?? draft.contextWindow,
      maxOutputToken: normalizePositiveInteger(obj.outputTokenLimit) ?? draft.maxOutputToken,
    });
  }

  return out;
}

export function mergeFetchedModels(
  fetched: ProviderModelConfig[],
  existing: ProviderModelConfig[],
): ProviderModelConfig[] {
  const merged: ProviderModelConfig[] = [];
  const existingById = new Map(existing.map((model) => [model.id, model]));
  const seen = new Set<string>();

  for (const model of fetched) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const existingModel = existingById.get(model.id);
    const shouldNormalizeOneMillion =
      existingModel !== undefined &&
      model.contextWindow === 1_000_000 &&
      existingModel.contextWindow < 1_000_000 &&
      Math.round(existingModel.contextWindow / 1_000) === 1_000;
    merged.push(
      existingModel
        ? {
            ...existingModel,
            ...(shouldNormalizeOneMillion ? { contextWindow: model.contextWindow } : {}),
            ...(model.ownedBy ? { ownedBy: model.ownedBy } : {}),
          }
        : model,
    );
  }

  for (const model of existing) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }

  return merged;
}

export function getModelBulkActionCounts(
  selectedModels: ReadonlySet<string>,
  activeModels: ReadonlySet<string>,
): { enableCount: number; disableCount: number } {
  let enableCount = 0;
  let disableCount = 0;
  for (const modelId of selectedModels) {
    if (activeModels.has(modelId)) disableCount += 1;
    else enableCount += 1;
  }
  return { enableCount, disableCount };
}

export function applyModelBulkActiveState(
  activeModels: ReadonlySet<string>,
  selectedModels: ReadonlySet<string>,
  enabled: boolean,
): Set<string> {
  const next = new Set(activeModels);
  for (const modelId of selectedModels) {
    if (enabled) next.add(modelId);
    else next.delete(modelId);
  }
  return next;
}

export function createDraftModelConfig(
  providerType: ProviderId,
  modelId: string,
): ProviderModelConfig {
  return createProviderModelConfig(providerType, modelId);
}

export function buildProviderModelsFetchKey(
  baseUrl: string,
  apiKey: string,
  useSystemProxy: boolean,
): string {
  return `${baseUrl.trim()}||${apiKey.trim()}||${useSystemProxy ? "proxy" : "direct"}`;
}

export async function fetchModelsFromApi(
  type: ProviderId,
  baseUrl: string,
  apiKey: string,
  options?: { useSystemProxy?: boolean },
): Promise<ProviderModelConfig[]> {
  // 网络请求收在后端（唯一网络入口）：/v1/models 首选、各家官方形式回退的
  // 尝试序列由 backend services/provider_models.rs 实现并被测试锁定。
  const data = await invoke<unknown>("provider_models_fetch", {
    provider_type: type,
    base_url: normalizeModelBaseUrl(type, baseUrl),
    api_key: apiKey.trim(),
    use_system_proxy: options?.useSystemProxy === true,
  });

  const items = extractModelListItems(data);
  if (items !== null) {
    return normalizeApiFetchedModels(items, type);
  }

  const maybeError =
    data && typeof data === "object" && "error" in (data as Record<string, unknown>)
      ? (data as Record<string, unknown>).error
      : null;
  if (typeof maybeError === "string" && maybeError.trim() !== "") {
    throw new Error(maybeError);
  }

  return [];
}
