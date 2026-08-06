import type { CatalogThinkingLevel } from "./catalog.generated";
import {
  type CatalogAppProviderId,
  findCatalogModel,
  findCatalogModelAcrossProviders,
} from "./modelCatalog";

// ---------------------------------------------------------------------------
// 模型思考能力（档位可用性的单一真源）
// ---------------------------------------------------------------------------
// 数据来自 catalog.generated.ts 的 thinking 字段（OpenAI 重名模型优先采用
// Codex supported_reasoning_levels，其余由 models.dev reasoning_options 补充并
// 在生成期归一化）。本模块只回答"这个模型有哪些思考档、能否关闭"——UI 档位
// 列表与请求期钳制都从这里派生，保证两者永不漂移。每档发什么请求参数
// （adaptive/budget、effort 字段名、值改写）是流式运行时的领域，不归这里管。

export type ThinkingLevel = CatalogThinkingLevel;

/** 升序标准梯子；目录 levels 恒为其子集（生成期归一化保证）。 */
export const THINKING_LEVEL_LADDER: readonly ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type ModelThinkingCapability = {
  /** false = 非思考模型（无档位、无开关，UI 隐藏整组控件）。 */
  reasoning: boolean;
  /** 可选档位（不含 off）；reasoning 为 true 且为空 = 思考恒开且不可调。 */
  levels: ThinkingLevel[];
  /** true = 思考不可关闭。 */
  alwaysOn: boolean;
  /** 目录命中 or 兜底推断（调试/测试用途）。 */
  fromCatalog: boolean;
};

// ---------------------------------------------------------------------------
// Anthropic 世代启发式（目录未命中的三方改名 id 兜底，两端共用的唯一实现）
// ---------------------------------------------------------------------------

function isClaudeFamilyVersionAtLeast(
  normalizedModelId: string,
  family: "opus" | "sonnet",
  minimumMinor: number,
) {
  // minor 限定 1-2 位数字，避免把日期后缀（如 claude-sonnet-4-20250514）误读成
  // 小版本号；同时接受三方中转的倒序命名（claude-4.6-sonnet）。
  const match = normalizedModelId.match(
    new RegExp(`(?:${family}[-.]4[-.](\\d{1,2})(?!\\d)|4[-.](\\d{1,2})(?!\\d)[-.]${family})`),
  );
  if (!match) return false;
  const minor = Number(match[1] ?? match[2]);
  return Number.isFinite(minor) && minor >= minimumMinor;
}

// Claude 5 起（sonnet-5 / fable-5 / mythos-5 等）整个家族都是 adaptive thinking 且
// 支持 xhigh。倒序写法（claude-5-sonnet）用负向后行断言排除 3-5-sonnet 这类旧
// 世代小版本号。
function isClaudeFamilyMajorVersionAtLeast(normalizedModelId: string, minimumMajor: number) {
  const match = normalizedModelId.match(
    /(?:(?:opus|sonnet|haiku|fable|mythos)[-.](\d{1,2})(?!\d)|(?<!\d[-.])(\d{1,2})[-.](?:opus|sonnet|haiku|fable|mythos))/,
  );
  if (!match) return false;
  const major = Number(match[1] ?? match[2]);
  return Number.isFinite(major) && major >= minimumMajor;
}

/** adaptive 世代（Opus/Sonnet 4.6+、Claude 5、Mythos Preview）即 1M GA 世代。 */
export function isAnthropicAdaptiveModelId(modelId: string): boolean {
  const normalizedModelId = modelId.trim().toLowerCase();
  return (
    normalizedModelId.includes("mythos-preview") ||
    isClaudeFamilyVersionAtLeast(normalizedModelId, "opus", 6) ||
    isClaudeFamilyVersionAtLeast(normalizedModelId, "sonnet", 6) ||
    isClaudeFamilyMajorVersionAtLeast(normalizedModelId, 5)
  );
}

/** xhigh：Opus 4.7+ 与 Claude 5 家族；Mythos Preview / Opus 4.6 / Sonnet 4.6 只到 max。 */
export function anthropicModelSupportsXHigh(modelId: string): boolean {
  const normalizedModelId = modelId.trim().toLowerCase();
  return (
    isClaudeFamilyVersionAtLeast(normalizedModelId, "opus", 7) ||
    isClaudeFamilyMajorVersionAtLeast(normalizedModelId, 5)
  );
}

// ---------------------------------------------------------------------------
// 能力解析
// ---------------------------------------------------------------------------

// 目录未命中的自定义模型无法从 id 可靠判断推理能力，按可推理处理：标准四档、
// 可关闭（与目录 budget 型模型同形）；xhigh/max 需目录或 Anthropic 世代启发式
// opt-in。是否真的下发思考由用户的开关决定。
const FALLBACK_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high"];

function fallbackCapability(providerId: CatalogAppProviderId, modelId: string) {
  if (providerId === "claude_code" && isAnthropicAdaptiveModelId(modelId)) {
    // adaptive 世代目录形态：无 minimal 档；xhigh 按家族判定。
    const levels: ThinkingLevel[] = anthropicModelSupportsXHigh(modelId)
      ? ["low", "medium", "high", "xhigh", "max"]
      : ["low", "medium", "high", "max"];
    return { reasoning: true, levels, alwaysOn: false, fromCatalog: false };
  }
  return { reasoning: true, levels: [...FALLBACK_LEVELS], alwaysOn: false, fromCatalog: false };
}

/**
 * 解析模型的思考能力。目录查找与限额同路径：供应商作用域优先，未命中按 id
 * 跨供应商回查（中转挂载的 glm/kimi/deepseek 等命中真实档位），最后才落兜底。
 *
 * xAI 例外：思考恒不可关（omit reasoning_effort ≠ 关闭，wire 无法表达 off），
 * 目录的 off 声明对 xai 供应商不生效——与请求侧行为保持一致，勿单独放开。
 */
export function resolveModelThinking(
  providerId: CatalogAppProviderId,
  modelId: string | undefined,
): ModelThinkingCapability {
  const trimmedId = modelId?.trim();
  if (!trimmedId) return { reasoning: false, levels: [], alwaysOn: false, fromCatalog: false };

  const entry =
    findCatalogModel(providerId, trimmedId) ?? findCatalogModelAcrossProviders(trimmedId);
  const capability = entry
    ? entry.thinking
      ? {
          reasoning: true,
          levels: [...entry.thinking.levels],
          alwaysOn: !entry.thinking.off,
          fromCatalog: true,
        }
      : { reasoning: false, levels: [], alwaysOn: false, fromCatalog: true }
    : fallbackCapability(providerId, trimmedId);

  if (providerId === "xai" && capability.reasoning) {
    return { ...capability, alwaysOn: true };
  }
  return capability;
}

// ---------------------------------------------------------------------------
// pi-ai ThinkingLevelMap 派生（GUI 请求路径消费；与 pi-ai 类型结构兼容）
// ---------------------------------------------------------------------------
// pi-ai getSupportedThinkingLevels 语义：null = 不支持；xhigh/max 必须显式声明
// 才存在；minimal..high 缺省即支持（值透传）。本函数保证
// getSupportedThinkingLevels(带此 map 的模型) ≡ capability.levels（+off）。

export type ThinkingLevelMap = Partial<Record<"off" | ThinkingLevel, string | null>>;

const BASE_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high"];
const OPT_IN_LEVELS: readonly ThinkingLevel[] = ["xhigh", "max"];

/**
 * @param wireValues 档位 → 请求值的改写表（如 xai 的 minimal→low、pi-ai 目录
 * 自带的 off→"none"、low→"LOW"），只对 capability 中存在的档位生效——wire 表
 * 不得复活目录裁掉的档，null（pi-ai 的"不支持"标记）一律忽略，可用性只听
 * capability 的。
 */
export function toThinkingLevelMap(
  capability: ModelThinkingCapability,
  wireValues?: ThinkingLevelMap,
): ThinkingLevelMap | undefined {
  if (!capability.reasoning) return undefined;
  const wireOf = (level: "off" | ThinkingLevel) => {
    const wire = wireValues?.[level];
    return typeof wire === "string" ? wire : undefined;
  };
  const map: ThinkingLevelMap = {};
  if (capability.alwaysOn) {
    map.off = null;
  } else {
    const wire = wireOf("off");
    if (wire !== undefined) map.off = wire;
  }
  for (const level of BASE_LEVELS) {
    if (!capability.levels.includes(level)) {
      map[level] = null;
    } else {
      const wire = wireOf(level);
      if (wire !== undefined && wire !== level) map[level] = wire;
    }
  }
  for (const level of OPT_IN_LEVELS) {
    if (capability.levels.includes(level)) map[level] = wireOf(level) ?? level;
  }
  return map;
}

/**
 * 把（历史设置里的）档位钳到列表内最近档：先向上找、再向下找——与 pi-ai
 * clampThinkingLevel 同算法，供 UI 归一化已保存档位使用。
 */
export function clampThinkingLevelToList(
  level: ThinkingLevel,
  levels: readonly ThinkingLevel[],
): ThinkingLevel | undefined {
  if (levels.length === 0) return undefined;
  if (levels.includes(level)) return level;
  const requestedIndex = THINKING_LEVEL_LADDER.indexOf(level);
  if (requestedIndex === -1) return levels[0];
  for (let i = requestedIndex + 1; i < THINKING_LEVEL_LADDER.length; i += 1) {
    const candidate = THINKING_LEVEL_LADDER[i];
    if (levels.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i -= 1) {
    const candidate = THINKING_LEVEL_LADDER[i];
    if (levels.includes(candidate)) return candidate;
  }
  return levels[0];
}
