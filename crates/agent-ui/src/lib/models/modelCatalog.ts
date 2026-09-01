import {
  type CatalogInputModality,
  type CatalogModelEntry,
  type CatalogProviderId,
  MODEL_CATALOG,
} from "./catalog.generated";

// ---------------------------------------------------------------------------
// 模型元信息目录（限额的单一真源）
// ---------------------------------------------------------------------------
// 数据来自 catalog.generated.ts（构建期由 scripts/generate-model-catalog.mjs
// 对 OpenAI 采用 Codex models.json 优先、models.dev 补充，其余供应商来自
// models.dev；由 update-model-catalog.yml 定时刷新）。本文件与生成文件均由共享包提供。
// 思考档位/API 选择/compat 等请求路径行为不归这里管——那些是流式运行时
// （pi-ai）的领域；这里只回答"这个模型的窗口/输出上限与输入模态是什么"。

export { MODEL_CATALOG, MODEL_CATALOG_SNAPSHOT_DATE } from "./catalog.generated";
export type { CatalogInputModality, CatalogModelEntry, CatalogProviderId };

// 与 settings 的 ProviderId 结构相同；本模块不 import settings（避免环）。
export type CatalogAppProviderId = "claude_code" | "codex" | "gemini" | "xai" | "deepseek";

export type ModelLimits = { contextWindow: number; maxOutputToken: number };

/** 应用供应商类型 → 目录 provider 的唯一映射点。 */
export const CATALOG_PROVIDER_BY_APP_PROVIDER: Record<CatalogAppProviderId, CatalogProviderId> = {
  claude_code: "anthropic",
  codex: "openai",
  gemini: "google",
  xai: "xai",
  deepseek: "deepseek",
};

/**
 * 目录未命中时的供应商兜底限额（xai 与 codex 同为 OpenAI 兼容生态，共用兜底值）。
 * contextWindow 一律为含输出的总窗口语义（与目录一致）：codex/xai 的 400K =
 * 258K 输入侧预算 + 142K 输出，与生成期对 Codex context_window 的换算同源。
 * 旧值直接存 258K 输入预算，"窗口 − 输出预留"型的压缩阈值会被 142K 的大输出
 * 挤到 45K，几乎每轮都触发压缩。
 */
export const PROVIDER_FALLBACK_LIMITS: Record<CatalogAppProviderId, ModelLimits> = {
  claude_code: { contextWindow: 200_000, maxOutputToken: 32_000 },
  codex: { contextWindow: 400_000, maxOutputToken: 142_000 },
  gemini: { contextWindow: 1_048_576, maxOutputToken: 65_536 },
  xai: { contextWindow: 400_000, maxOutputToken: 142_000 },
  deepseek: { contextWindow: 128_000, maxOutputToken: 32_000 },
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
  // 中转聚合商常在模型 id 前加自家路径前缀（bailian/deepseek-v4-pro、
  // openrouter/xxx 等），目录里存的是裸 id。放链尾——所有精确形态、
  // 全部分区都查空后才尝试剥前缀，避免裸段误撞目录里无关的同名模型。
  const lastSegment = withoutContextSuffix.split("/").pop() ?? "";
  if (lastSegment !== withoutContextSuffix) {
    push(lastSegment);
    push(lastSegment.replace(/-20\d{6}$/, ""));
  }
  return candidates;
}

const catalogIndexByProvider = new Map<CatalogProviderId, Map<string, CatalogModelEntry>>();

function getCatalogIndex(catalogProvider: CatalogProviderId): Map<string, CatalogModelEntry> {
  let index = catalogIndexByProvider.get(catalogProvider);
  if (!index) {
    index = new Map();
    for (const entry of MODEL_CATALOG[catalogProvider]) {
      index.set(entry.id, entry);
      // 目录含混合大小写 id（MiniMax-M2/LongCat-2.0 等）：补小写别名，让候选链
      // 的 lower 候选可命中；生成期按小写去重保证别名不会跨条目歧义。
      const lower = entry.id.toLowerCase();
      if (!index.has(lower)) index.set(lower, entry);
    }
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

// 中转聚合常把 A 家模型挂在 B 家供应商类型下（grok/deepseek/glm/qwen 等挂在
// Anthropic/OpenAI 兼容中转），供应商作用域查不到时按 id 跨供应商回查，避免
// 真实限额被本供应商兜底值顶掉。国内厂商分区（deepseek/zhipuai/alibaba 等）
// 没有对应的应用供应商类型，只经这里消费。目录 id 全局小写唯一（生成期跨
// 分区去重+目录不变量测试锁死）；候选链放外层——更精确的 id 形态优先于
// 供应商声明序。已有正式应用供应商的模型也允许出现在通用中转端点中，因此仍可
// 经这条协议无关的元数据回查路径命中。
const CATALOG_PROVIDER_IDS = Object.keys(MODEL_CATALOG) as CatalogProviderId[];

export function findCatalogModelAcrossProviders(
  modelId: string | undefined,
): CatalogModelEntry | undefined {
  const trimmedId = modelId?.trim();
  if (!trimmedId) return undefined;
  for (const candidate of normalizeModelIdCandidates(trimmedId)) {
    for (const catalogProvider of CATALOG_PROVIDER_IDS) {
      const entry = getCatalogIndex(catalogProvider).get(candidate);
      if (entry) return entry;
    }
  }
  return undefined;
}

// 展示用的输入模态查询：先按供应商作用域查，未命中再跨供应商回查（与限额
// 解析同一回查策略——中转聚合常把别家模型挂在本供应商类型下）。返回目录
// 快照数据；用户的 inputModalities 覆盖是否优先由调用方决定（覆盖只表达
// text/image 门控，与目录的完整模态集合语义不同）。
export function resolveModelInputModalities(
  providerId: CatalogAppProviderId,
  modelId: string | undefined,
): readonly CatalogInputModality[] | undefined {
  const entry = findCatalogModel(providerId, modelId) ?? findCatalogModelAcrossProviders(modelId);
  return entry?.inputModalities;
}

export function resolveModelLimitsAcrossProviders(
  modelId: string | undefined,
): ModelLimits | undefined {
  const entry = findCatalogModelAcrossProviders(modelId);
  if (!entry) return undefined;
  return { contextWindow: entry.contextWindow, maxOutputToken: entry.maxOutputToken };
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

// 供应商 /v1/models 接口自带的真实限额字段——比本地静态目录更新、更准（目录是
// 构建期快照，供应商接口是该次部署的实时数据）。识别几种真实世界常见写法：
// OpenRouter 风格顶层 context_length，以及嵌套在 top_provider 下的同名字段。
// 只在这些字段解析为正整数时才采信，识别不出来的字段名回退到目录/兜底流程，
// 与 normalizeGeminiFetchedModels 读 inputTokenLimit/outputTokenLimit 同一思路。
export function extractProviderDeclaredLimits(
  obj: Record<string, unknown>,
): ModelLimits | undefined {
  const asPositiveInt = (value: unknown): number | undefined => {
    const numeric =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
  };
  const topProvider =
    obj.top_provider && typeof obj.top_provider === "object"
      ? (obj.top_provider as Record<string, unknown>)
      : undefined;

  const contextWindow =
    asPositiveInt(obj.context_length) ?? asPositiveInt(topProvider?.context_length);
  if (!contextWindow) return undefined;

  const maxOutputToken =
    asPositiveInt(topProvider?.max_completion_tokens) ??
    asPositiveInt(obj.max_completion_tokens) ??
    // 部分中转商不单独公布输出上限，仅给窗口——按目录同一规则钳到保守预留值。
    normalizeModelLimits({ contextWindow, maxOutputToken: contextWindow }).maxOutputToken;

  return normalizeModelLimits({ contextWindow, maxOutputToken });
}
