import { type CatalogModelEntry, type CatalogProviderId, MODEL_CATALOG } from "./catalog.generated";

// ---------------------------------------------------------------------------
// 模型元信息目录（限额的单一真源）
// ---------------------------------------------------------------------------
// 数据来自 catalog.generated.ts（构建期由 scripts/generate-model-catalog.mjs
// 从 models.dev 生成，刷新走 make update-model-catalog）。本文件与生成文件
// 均在 scripts/mirror-manifest.json 中，两端逐字节镜像。
// 思考档位/API 选择/compat 等请求路径行为不归这里管——那些是流式运行时
// （pi-ai）的领域；这里只回答"这个模型的窗口和输出上限是多少"。

export { MODEL_CATALOG, MODEL_CATALOG_SNAPSHOT_DATE } from "./catalog.generated";
export type { CatalogModelEntry, CatalogProviderId };

// 与 settings 的 ProviderId 结构相同；本模块不 import settings（避免环）。
export type CatalogAppProviderId = "claude_code" | "codex" | "gemini" | "xai";

export type ModelLimits = { contextWindow: number; maxOutputToken: number };

/** 应用供应商类型 → 目录 provider 的唯一映射点。 */
export const CATALOG_PROVIDER_BY_APP_PROVIDER: Record<CatalogAppProviderId, CatalogProviderId> = {
  claude_code: "anthropic",
  codex: "openai",
  gemini: "google",
  xai: "xai",
};

/** 目录未命中时的供应商兜底限额（xai 与 codex 同为 OpenAI 兼容生态，共用兜底值）。 */
export const PROVIDER_FALLBACK_LIMITS: Record<CatalogAppProviderId, ModelLimits> = {
  claude_code: { contextWindow: 200_000, maxOutputToken: 32_000 },
  codex: { contextWindow: 258_000, maxOutputToken: 142_000 },
  gemini: { contextWindow: 1_048_576, maxOutputToken: 65_536 },
  xai: { contextWindow: 258_000, maxOutputToken: 142_000 },
};

// 唯一的目录数据语义规则：社区目录对不公布独立输出上限的供应商一律记
// "输出 == 窗口"（models.dev/LiteLLM 皆然），照单全收会把"窗口 − 输出预留"
// 型的输入预算挤成零。凡输出吃满窗口视为退化数据，钳到统一预留上限
// （与 OpenCode 的 OUTPUT_TOKEN_MAX 同值），并保底给输入留出 3/4 窗口。
// 生成脚本在生成期应用同一规则，目录不变量测试锁两处一致。
export const MAX_OUTPUT_TOKEN_CAP = 32_000;

export function normalizeModelLimits(limits: ModelLimits): ModelLimits {
  if (limits.contextWindow <= 0 || limits.maxOutputToken < limits.contextWindow) return limits;
  return {
    contextWindow: limits.contextWindow,
    maxOutputToken: Math.min(
      MAX_OUTPUT_TOKEN_CAP,
      Math.max(1, Math.floor(limits.contextWindow / 4)),
    ),
  };
}

// 中转/网关常给官方模型 id 加装饰（日期后缀、@版本、大小写变化、AnyRouter 系
// 的 [1m] 长上下文后缀），逐字匹配会漏检目录。先精确查，再按候选链回查；
// 命中方保留用户配置的原始 id（是否剥 [1m] 由请求侧策略决定，与目录无关）。
export function normalizeModelIdCandidates(modelId: string): string[] {
  const candidates: string[] = [];
  const push = (value: string) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  push(modelId);
  const lower = modelId.toLowerCase();
  push(lower);
  const withoutAtVersion = lower.split("@")[0];
  push(withoutAtVersion);
  const withoutContextSuffix = withoutAtVersion.replace(/\[1m\]$/i, "");
  push(withoutContextSuffix);
  push(withoutContextSuffix.replace(/-20\d{6}$/, ""));
  return candidates;
}

const catalogIndexByProvider = new Map<CatalogProviderId, Map<string, CatalogModelEntry>>();

function getCatalogIndex(catalogProvider: CatalogProviderId): Map<string, CatalogModelEntry> {
  let index = catalogIndexByProvider.get(catalogProvider);
  if (!index) {
    index = new Map(MODEL_CATALOG[catalogProvider].map((entry) => [entry.id, entry]));
    catalogIndexByProvider.set(catalogProvider, index);
  }
  return index;
}

export function findCatalogModel(
  providerId: CatalogAppProviderId,
  modelId: string | undefined,
): CatalogModelEntry | undefined {
  const trimmedId = modelId?.trim();
  if (!trimmedId) return undefined;
  const index = getCatalogIndex(CATALOG_PROVIDER_BY_APP_PROVIDER[providerId]);
  for (const candidate of normalizeModelIdCandidates(trimmedId)) {
    const entry = index.get(candidate);
    if (entry) return entry;
  }
  return undefined;
}

export function resolveModelLimits(
  providerId: CatalogAppProviderId,
  modelId: string | undefined,
): ModelLimits | undefined {
  const entry = findCatalogModel(providerId, modelId);
  if (!entry) return undefined;
  // 目录数据在生成期已过 normalizeModelLimits，直接透传。
  return { contextWindow: entry.contextWindow, maxOutputToken: entry.maxOutputToken };
}

export function getProviderFallbackLimits(providerId: CatalogAppProviderId): ModelLimits {
  const fallback = PROVIDER_FALLBACK_LIMITS[providerId];
  return { contextWindow: fallback.contextWindow, maxOutputToken: fallback.maxOutputToken };
}
