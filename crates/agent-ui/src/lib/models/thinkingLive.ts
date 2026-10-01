import type { CatalogThinkingLevel } from "./catalog.generated";
import { normalizeModelIdCandidates } from "./modelCatalog";

// ---------------------------------------------------------------------------
// 思考能力运行期补充（models.dev 实时数据）
// ---------------------------------------------------------------------------
// 构建期快照（catalog.generated.ts）每天由 CI 刷新一次，但快照日期与发版日期
// 之间的窗口里，上游新收录/补录的模型（glm-5.3-flashx、deepseek-flash 这类）
// 在本端只能落到通用兜底档位。本模块在运行期拉取一次与生成器同源的
// models.dev/api.json，提取与 scripts/generate-model-catalog.mjs
// normalizeThinking 同规则的 thinking 数据，作为快照未命中时的补充层：
//
//   快照命中（有 thinking） → 快照；快照未命中/无 thinking → 本模块 → 通用兜底。
//
// 只补「思考能力」，不补限额/模态——限额已有供应商 /v1/models 实时声明路径
// （extractProviderDeclaredLimits），且跨分区限额裁决（官方优先于托管）是
// 生成期职责，运行期复制一份会漂移。归一化规则与生成器逐条镜像（含
// client-side-off、toggle-only 单档、"none" 折入 off）；生成器的
// THINKING_OVERRIDES 不在此复制——被 override 的 id 一定在快照里，快照命中
// 时根本走不到本模块。两端（GUI/WebUI）共用，失败静默降级为快照+兜底。

export const LIVE_THINKING_SOURCE_URL = "https://models.dev/api.json";

/** 默认刷新间隔：上游一天一更（生成器 CI 同节奏），缓存 24h 足够新鲜。 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const STORAGE_KEY = "liveagent.thinkingLive.v1";
const STORAGE_SCHEMA_VERSION = 1;

export type LiveThinking = {
  levels: CatalogThinkingLevel[];
  off: boolean;
};

// 与生成器 THINKING_LEVELS / BUDGET_DEFAULT_LEVELS / TOGGLE_ONLY_LEVELS 同值。
const THINKING_LADDER: readonly CatalogThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const BUDGET_DEFAULT_LEVELS: readonly CatalogThinkingLevel[] = ["minimal", "low", "medium", "high"];
const TOGGLE_ONLY_LEVELS: readonly CatalogThinkingLevel[] = ["high"];

// 与生成器 CLIENT_SIDE_OFF_SECTIONS 同值：anthropic-messages 协议 omission 即关。
const CLIENT_SIDE_OFF_SECTION = "anthropic";

// 生成器 SECTIONS[].sources 的顺序展开（scripts/generate-model-catalog.mjs，
// 两处需同步维护）：同名 id 跨分区重复时，官方/一方分区按此序先注册，聚合商
// 与托管分区只能补官方没有的模型。api.json 顶层键序把 200 多个聚合商分区排
// 在官方分区之前，若按键序先到先得，快照窗口期的新模型会拿到聚合商改写过的
// 档位形态（实测 kimi-k3 被聚合商记成四档 budget 型，官方是 low/high/max）——
// 这正是补充层要消灭的那类错误，因此裁决顺序必须显式固定。
const OFFICIAL_SECTION_ORDER: readonly string[] = [
  "anthropic",
  "google",
  "openai",
  "xai",
  "deepseek",
  "zai",
  "zhipuai",
  "zai-coding-plan",
  "zhipuai-coding-plan",
  "moonshotai-cn",
  "moonshotai",
  "kimi-code-plan-cn",
  "kimi-code-plan-global",
  "minimax-cn",
  "minimax",
  "minimax-cn-coding-plan",
  "minimax-coding-plan",
  "stepfun",
  "stepfun-ai",
  "stepfun-step-plan",
  "stepfun-ai-step-plan",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
  "longcat",
  "sensenova",
  "volcengine",
  "volcengine-coding-plan",
  "alibaba-cn",
  "alibaba",
  "alibaba-coding-plan-cn",
  "alibaba-coding-plan",
  "alibaba-token-plan-cn",
  "alibaba-token-plan",
  "tencent-tokenhub",
  "tencent-coding-plan",
  "tencent-token-plan",
];
const OFFICIAL_SECTION_SET: ReadonlySet<string> = new Set(OFFICIAL_SECTION_ORDER);

/**
 * 单个 models.dev 模型条目 → 思考能力。与生成器 normalizeThinking 同规则：
 * reasoning 非 true = 非思考模型（undefined）；空 options = 恒开不可调
 * （levels 空 + off false）；effort 梯子与标准梯子取交；budget 型给标准四档；
 * toggle-only 给单档 high；"none" 折入 off；未知档位值丢弃。
 */
export function extractLiveThinking(model: unknown): LiveThinking | undefined {
  const record = (model ?? {}) as Record<string, unknown>;
  if (record.reasoning !== true) return undefined;
  const options = Array.isArray(record.reasoning_options) ? record.reasoning_options : [];
  if (options.length === 0) return { levels: [], off: false };

  const effort = options.find((option) => (option as Record<string, unknown>)?.type === "effort") as
    | { values?: unknown }
    | undefined;
  const hasToggle = options.some(
    (option) => (option as Record<string, unknown>)?.type === "toggle",
  );
  const hasBudget = options.some(
    (option) => (option as Record<string, unknown>)?.type === "budget_tokens",
  );

  let off = hasToggle;
  let levels: CatalogThinkingLevel[] = [];
  if (effort && Array.isArray(effort.values)) {
    const values = new Set<string>();
    for (const value of effort.values) {
      if (value === "none") {
        off = true;
      } else if (THINKING_LADDER.includes(value as CatalogThinkingLevel)) {
        values.add(value);
      }
      // 未知值静默丢弃（生成器带 note，运行期不打扰日志）。
    }
    levels = THINKING_LADDER.filter((level) => values.has(level));
  } else if (hasBudget) {
    levels = [...BUDGET_DEFAULT_LEVELS];
  } else if (hasToggle) {
    levels = [...TOGGLE_ONLY_LEVELS];
  }
  return { levels, off };
}

// ---------------------------------------------------------------------------
// 内存存储 + 订阅（UI 通过版本号感知补充数据到达后重算档位）
// ---------------------------------------------------------------------------

const liveEntries = new Map<string, LiveThinking>();
let liveVersion = 0;
const listeners = new Set<() => void>();

export function getThinkingLiveVersion(): number {
  return liveVersion;
}

export function subscribeThinkingLive(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function applyStore(next: Map<string, LiveThinking>): void {
  liveEntries.clear();
  for (const [key, value] of next) liveEntries.set(key, value);
  liveVersion += 1;
  for (const listener of listeners) listener();
}

/**
 * 解析整个 models.dev/api.json 形状的数据并重建补充层：顶层为供应商分区映射，
 * 分区下 models 为 id → 条目。id 全表按小写唯一（与目录同不变量），跨分区
 * 重复时按 OFFICIAL_SECTION_ORDER 裁决——官方分区先注册，其余分区按上游键序
 * 只补官方没有的 id；anthropic 分区条目一律可客户端关闭（omission 即 off，
 * 与生成器 client-side-off 规则同源）。至少解析出一个思考条目才算成功——
 * 防御上游 schema 变更时用空数据顶掉旧缓存。
 */
export function ingestLiveThinkingCatalog(upstream: unknown): boolean {
  if (!upstream || typeof upstream !== "object") return false;
  const sections = upstream as Record<string, unknown>;
  const orderedSectionKeys = [
    ...OFFICIAL_SECTION_ORDER.filter((key) => Object.hasOwn(sections, key)),
    ...Object.keys(sections).filter((key) => !OFFICIAL_SECTION_SET.has(key)),
  ];
  const next = new Map<string, LiveThinking>();
  for (const sectionKey of orderedSectionKeys) {
    const models = (sections[sectionKey] as Record<string, unknown> | null)?.models;
    if (!models || typeof models !== "object") continue;
    for (const [id, model] of Object.entries(models as Record<string, unknown>)) {
      const thinking = extractLiveThinking(model);
      if (!thinking) continue;
      const normalized =
        sectionKey === CLIENT_SIDE_OFF_SECTION ? { ...thinking, off: true } : thinking;
      const lower = id.toLowerCase();
      if (!next.has(lower)) next.set(lower, normalized);
    }
  }
  if (next.size === 0) return false;
  applyStore(next);
  return true;
}

/** 快照未命中时的查询：与目录同款候选链（大小写/@版本/[1m]/日期后缀/末段路径）。 */
export function resolveLiveThinking(modelId: string | undefined): LiveThinking | undefined {
  const trimmedId = modelId?.trim();
  if (!trimmedId || liveEntries.size === 0) return undefined;
  for (const candidate of normalizeModelIdCandidates(trimmedId)) {
    const entry = liveEntries.get(candidate);
    if (entry) return entry;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 持久化 + 加载（localStorage 只缓存 thinking 条目子集；原始 api.json 数 MB
// 不落盘，避免挤占配额）
// ---------------------------------------------------------------------------

type StoredPayload = {
  v: number;
  fetchedAt: number;
  entries: Record<string, { l: CatalogThinkingLevel[]; o: boolean }>;
};

let lastFetchedAt = 0;
let inflight: Promise<boolean> | null = null;

function readStoredPayload(): StoredPayload | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPayload | null;
    if (
      !parsed ||
      parsed.v !== STORAGE_SCHEMA_VERSION ||
      typeof parsed.fetchedAt !== "number" ||
      !parsed.entries ||
      typeof parsed.entries !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredPayload(payload: StoredPayload): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 隐私模式/配额满：写失败只影响下次冷启动的新鲜度，不阻塞本次生效。
  }
}

function rebuildStoreFromPayload(payload: StoredPayload): boolean {
  const next = new Map<string, LiveThinking>();
  for (const [id, entry] of Object.entries(payload.entries)) {
    if (!Array.isArray(entry?.l) || typeof entry?.o !== "boolean") continue;
    next.set(id.toLowerCase(), { levels: entry.l, off: entry.o });
  }
  if (next.size === 0) return false;
  applyStore(next);
  return true;
}

function isFresh(ttlMs: number): boolean {
  return liveVersion > 0 && Date.now() - lastFetchedAt < ttlMs;
}

/**
 * 拉取并生效运行期补充。幂等：TTL 内重复调用直接命中已有数据；并发调用共享
 * 同一 in-flight。任何失败（离线、schema 变更、解析为空）静默返回 false，
 * 保留旧数据——补充层永远不能比快照+兜底的现状更糟。
 */
export async function loadThinkingLiveSupplement(options?: {
  force?: boolean;
  ttlMs?: number;
}): Promise<boolean> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  if (!options?.force && isFresh(ttlMs)) return true;
  if (inflight) return inflight;
  inflight = (async () => {
    // 1) 先用磁盘缓存热身（哪怕已过期）：冷启动先有数据，网络刷新在后台追赶。
    const stored = readStoredPayload();
    if (stored && liveVersion === 0 && rebuildStoreFromPayload(stored)) {
      lastFetchedAt = stored.fetchedAt;
      if (isFresh(ttlMs)) return true;
    }
    // 2) 过期/强制 → 拉上游。
    try {
      const response = await fetch(LIVE_THINKING_SOURCE_URL, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return false;
      const upstream: unknown = await response.json();
      if (!ingestLiveThinkingCatalog(upstream)) return false;
      lastFetchedAt = Date.now();
      const entries: StoredPayload["entries"] = {};
      for (const [id, thinking] of liveEntries) {
        entries[id] = { l: thinking.levels, o: thinking.off };
      }
      writeStoredPayload({ v: STORAGE_SCHEMA_VERSION, fetchedAt: lastFetchedAt, entries });
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
