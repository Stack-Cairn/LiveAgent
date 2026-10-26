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
} from "@liveagent/app/lib/settings";
import type { CustomHeader } from "../../lib/providers/customHeaders";

const REDACTED_USAGE_QUERY_SECRET_DISPLAY = "••••••••";

export function applyProviderModelDraft(
  models: ProviderModelConfig[],
  draft: ProviderModelConfig,
  contextWindow: number | null,
  maxOutputToken: number | null,
): ProviderModelConfig[] | null {
  if (contextWindow === null || maxOutputToken === null) return null;
  const limitsChanged =
    contextWindow !== draft.contextWindow || maxOutputToken !== draft.maxOutputToken;
  const nextModel: ProviderModelConfig = {
    ...draft,
    contextWindow,
    maxOutputToken,
    limitsSource: limitsChanged ? "user" : draft.limitsSource,
  };
  return models.map((model) => (model.id === draft.id ? nextModel : model));
}

export type ModelInputModalitiesMode = "auto" | "text" | "text-image";

export function providerSupportsModelInputModalitiesOverride(providerId: ProviderId): boolean {
  return (
    providerId === "codex" ||
    providerId === "xai" ||
    providerId === "gemini" ||
    // deepseek：Responses wire 已接受 input_image（官方《图像理解》指南），模型
    // 能力默认按 id 推断（flash 家族吃图、Pro 纯文本），中转端点不吃图时用覆盖
    // 改回 ["text"]。
    providerId === "deepseek"
  );
}

export function getModelInputModalitiesMode(model: ProviderModelConfig): ModelInputModalitiesMode {
  if (!model.inputModalities) return "auto";
  return model.inputModalities.length === 2 ? "text-image" : "text";
}

export function applyModelInputModalitiesMode(
  model: ProviderModelConfig,
  mode: ModelInputModalitiesMode,
): ProviderModelConfig {
  const modelWithoutOverride = { ...model };
  delete modelWithoutOverride.inputModalities;
  if (mode === "auto") return modelWithoutOverride;
  return {
    ...modelWithoutOverride,
    inputModalities: mode === "text-image" ? ["text", "image"] : ["text"],
  };
}

export type ModelImageMode = "auto" | "on" | "off";

export function getModelImageMode(model: ProviderModelConfig): ModelImageMode {
  if (!model.imageAdapter) return "auto";
  return model.imageAdapter === "disabled" ? "off" : "on";
}

/** "auto" 在草稿里就是没有 imageAdapter；保存时由 withImageAdapter / Gateway 补成空串。 */
export function applyModelImageMode(
  model: ProviderModelConfig,
  mode: ModelImageMode,
): ProviderModelConfig {
  const next = { ...model };
  delete next.imageAdapter;
  if (mode === "auto") return next;
  return { ...next, imageAdapter: mode === "on" ? "enabled" : "disabled" };
}

/** 列表行的生图标签：用户选择优先，自动时用 K-brain 回传的识别结果。 */
export function modelIsImage(model: ProviderModelConfig): boolean {
  const mode = getModelImageMode(model);
  return mode === "auto" ? model.imageModel === true : mode === "on";
}

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

export function normalizeFetchedModels(
  items: unknown,
  providerType: ProviderId,
): ProviderModelConfig[] {
  return normalizeProviderModelConfigs(items, providerType);
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
    // 供应商本次响应自带真实限额字段（provider 来源）：比落库的目录/兜底值
    // 更新鲜，直接采信；用户手改（user）来源任何时候都不被自动覆盖。
    const shouldAdoptFreshProviderLimits =
      existingModel !== undefined &&
      model.limitsSource === "provider" &&
      existingModel.limitsSource !== "user";
    merged.push(
      existingModel
        ? {
            ...existingModel,
            ...(shouldNormalizeOneMillion ? { contextWindow: model.contextWindow } : {}),
            ...(shouldAdoptFreshProviderLimits
              ? {
                  contextWindow: model.contextWindow,
                  maxOutputToken: model.maxOutputToken,
                  limitsSource: "provider",
                }
              : {}),
            ...(model.displayName ? { displayName: model.displayName } : {}),
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

// 供“列表总开关”一次性设置一批模型的启用状态：enabled=true 时并集，false 时差集。
export function applyModelsActiveState(
  activeModels: ReadonlySet<string>,
  targetModels: Iterable<string>,
  enabled: boolean,
): Set<string> {
  const next = new Set(activeModels);
  for (const modelId of targetModels) {
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
  isFullUrl = false,
  modelsUrl = "",
  customHeaders?: readonly CustomHeader[],
): string {
  const routing = useSystemProxy ? "proxy" : "direct";
  const override = modelsUrl.trim();
  // 请求头进 key：这些头参与上游鉴权，改完不重新拉一次的话，用户看到的仍是上一套
  // 头留下的失败结果，与「改了没生效」无法区分。
  const headers = (customHeaders ?? []).length
    ? JSON.stringify((customHeaders ?? []).map((header) => [header.key, header.value]))
    : "";
  return `${baseUrl.trim()}||${apiKey.trim()}||${routing}${isFullUrl ? "||full-url" : ""}${override ? `||models:${override}` : ""}${headers ? `||headers:${headers}` : ""}`;
}
