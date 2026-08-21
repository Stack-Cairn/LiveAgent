// 上下文用量的两端单一真源：颜色分档阈值、手动压缩门槛，以及 WebUI 从
// transcript 倒扫补算 trailing 消息的口径。GUI 直接使用运行时 TokenLedger，
// WebUI 使用这里的同源估算与桌面同步的 checkpoint 权威快照。
//
// CJK 感知的文本 token 估算也定义在此（原 agent-gui compaction/tokenLedger.ts，
// 迁入共享层供压缩检查点估值复用；tokenLedger 从这里 re-export 保持旧调用方不动）。

/** 黄色起点，同时是手动压缩可用的起点（issue #359：占用 ≥50% 才允许压缩）。 */
export const CONTEXT_USAGE_WARN_RATIO = 0.5;
/** 红色起点。 */
export const CONTEXT_USAGE_DANGER_RATIO = 0.8;

export type ContextUsageLevel = "ok" | "warn" | "danger";

export function contextUsageLevel(ratio: number): ContextUsageLevel {
  if (ratio >= CONTEXT_USAGE_DANGER_RATIO) return "danger";
  if (ratio >= CONTEXT_USAGE_WARN_RATIO) return "warn";
  return "ok";
}

export function canManualCompact(ratio: number): boolean {
  return ratio >= CONTEXT_USAGE_WARN_RATIO;
}

export function contextUsageRatio(
  totalTokens: number | undefined,
  contextWindow: number | undefined,
): number {
  if (
    typeof totalTokens !== "number" ||
    !Number.isFinite(totalTokens) ||
    totalTokens <= 0 ||
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return 0;
  }
  return totalTokens / contextWindow;
}

const CHARS_PER_TOKEN = 4;
// CJK 文字的 token 密度远高于西文：主流 tokenizer（o200k/cl100k/Claude）大约
// 每 1.4~1.7 个汉字 1 token。按 chars/4 估会低估约 2.5~3 倍，导致压缩触发
// 严重偏晚甚至撞上下文上限。取 0.7 token/字作为偏保守（宁早勿晚）的估计。
const CJK_TOKENS_PER_CHAR = 0.7;

// CJK 统一表意文字（含扩展 A）、假名、谚文、兼容表意/形式与全角标点。
// 这些区段全部落在 BMP，按 UTF-16 code unit 判断即可；增补平面字符
// （emoji 等）按两个西文字符计入 chars/4 路径。
function isCjkCodeUnit(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * 文本的分数 token 估算（不 trim、不取整）。按字符类别累加：CJK 字符按
 * CJK_TOKENS_PER_CHAR，其余按 1/CHARS_PER_TOKEN。可加性成立：对任意切分，
 * 分段估算之和恒等于整体估算，因此流式增量可按 delta 累加。
 */
export function estimateTextTokenUnits(text: string): number {
  let cjkChars = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isCjkCodeUnit(text.charCodeAt(index))) cjkChars += 1;
  }
  return (text.length - cjkChars) / CHARS_PER_TOKEN + cjkChars * CJK_TOKENS_PER_CHAR;
}

export function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.ceil(estimateTextTokenUnits(normalized));
}

// 两端 transcript 项的最小结构投影：GUI RenderTimelineItem（检查点 kind:"summary"）
// 与 WebUI TranscriptRow（检查点 kind:"checkpoint"）经结构化类型直接传入。
// attachments 两端同为 PendingUploadedFile 投影（GUI 时间线项 / WebUI user 行）。
export type ContextUsageScanItem = {
  kind: string;
  text?: string;
  attachments?: readonly unknown[];
  rounds?: readonly {
    meta?: {
      usageTotalTokens?: number;
      contextUsageTokens?: number;
      contextRelevant?: boolean;
    };
    blocks?: readonly {
      kind?: string;
      text?: string;
      item?: unknown;
    }[];
  }[];
  content?: string;
  contextUsageTokens?: number;
};

export type ContextUsageLiveTail = {
  liveRounds: NonNullable<ContextUsageScanItem["rounds"]>;
  draftAssistantText: string;
};

export function buildContextUsageScanItems(
  historyItems: readonly ContextUsageScanItem[],
  live: ContextUsageLiveTail | null,
): readonly ContextUsageScanItem[] {
  if (!live) return historyItems;
  if (live.liveRounds.length > 0) {
    return [...historyItems, { kind: "assistant", rounds: live.liveRounds }];
  }
  if (live.draftAssistantText) {
    return [
      ...historyItems,
      {
        kind: "assistant",
        rounds: [{ blocks: [{ kind: "text", text: live.draftAssistantText }] }],
      },
    ];
  }
  return historyItems;
}

// 逐消息估算只统计正文字符，补一个小常量近似 JSON 包裹（role/键名/引号）的
// 开销。两端（GUI TokenLedger 与 WebUI 倒扫）共用此口径，调参只改这里。
export const MESSAGE_ENVELOPE_TOKENS = 8;

// 非文本值的估算口径（字符串直估，其余 JSON 序列化后估）。GUI TokenLedger
// 与 WebUI 倒扫共用，保证两端对同一负载的估算一致。
export function stringifiedTokenUnits(value: unknown): number {
  if (typeof value === "string") return estimateTextTokenUnits(value);
  if (value == null) return 0;
  try {
    const serialized = JSON.stringify(value);
    return serialized ? estimateTextTokenUnits(serialized) : 0;
  } catch {
    return estimateTextTokenUnits(String(value));
  }
}

function messageTokensFromUnits(units: number): number {
  return Math.ceil(Math.max(0, units)) + MESSAGE_ENVELOPE_TOKENS;
}

// 两端 store 都按不可变更新替换工具结果对象，估算结果可按对象身份缓存；
// 流式期间倒扫逐帧执行，没有这层缓存会对大工具结果每帧重复 JSON.stringify。
const toolResultTokenCache = new WeakMap<object, number>();

function estimateToolResultTokens(result: { content?: unknown; details?: unknown }): number {
  const cached = toolResultTokenCache.get(result);
  if (cached !== undefined) return cached;
  const tokens = messageTokensFromUnits(
    stringifiedTokenUnits(result.content) + stringifiedTokenUnits(result.details),
  );
  toolResultTokenCache.set(result, tokens);
  return tokens;
}

function estimateRoundTokens(
  round: NonNullable<ContextUsageScanItem["rounds"]>[number],
  onlyToolResults: boolean,
): number {
  let assistantUnits = 0;
  let toolResultTokens = 0;
  for (const block of round.blocks ?? []) {
    if (block.kind === "tool") {
      const item =
        block.item && typeof block.item === "object"
          ? (block.item as {
              toolCall?: { name?: string; arguments?: unknown };
              toolResult?: { content?: unknown; details?: unknown };
            })
          : undefined;
      const toolCall = item?.toolCall;
      if (!onlyToolResults && toolCall) {
        assistantUnits +=
          stringifiedTokenUnits(toolCall.name) + stringifiedTokenUnits(toolCall.arguments);
      }
      const toolResult = item?.toolResult;
      if (toolResult) toolResultTokens += estimateToolResultTokens(toolResult);
      continue;
    }
    if (!onlyToolResults) {
      assistantUnits +=
        typeof block.text === "string"
          ? estimateTextTokenUnits(block.text)
          : stringifiedTokenUnits(block);
    }
  }
  if (onlyToolResults) return toolResultTokens;
  return (assistantUnits > 0 ? messageTokensFromUnits(assistantUnits) : 0) + toolResultTokens;
}

// "有效 token 计数"的两端单一校验口径（floor 且必须是有限正数）。
export function positiveTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * 倒扫 transcript 求当前上下文占用：最近一个 assistant 轮次的真实 API usage
 * 是锚点（usage.totalTokens 已含该 assistant 输出及其之前的 system/tools/历史），
 * 再累加锚点之后的用户消息（正文 + 附件元数据）、后续 assistant 内容与工具
 * 结果。压缩检查点优先使用桌面端同步的权威 contextUsageTokens；旧历史没有
 * 该字段时才退回摘要正文估算。
 */
export function deriveContextUsageTokens(
  items: readonly ContextUsageScanItem[],
): number | undefined {
  let trailingTokens = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "summary" || item.kind === "checkpoint") {
      const checkpointTokens =
        positiveTokenCount(item.contextUsageTokens) ??
        (typeof item.content === "string" ? estimateTextTokens(item.content) : undefined);
      return checkpointTokens === undefined ? undefined : checkpointTokens + trailingTokens;
    }
    if (item.kind === "user") {
      let units = typeof item.text === "string" ? estimateTextTokenUnits(item.text.trim()) : 0;
      // 附件按元数据序列化估算（路径/文件名/规模等即运行时注入的指令行量级；
      // 原生 base64 附件路径下这是下界）。不计会让"检查点后发大批附件"的
      // 空闲读数两端一致偏低，且纯附件消息此前完全计零。
      for (const attachment of item.attachments ?? []) {
        units += stringifiedTokenUnits(attachment);
      }
      if (units > 0) {
        trailingTokens += messageTokensFromUnits(units);
      }
      continue;
    }
    if (item.kind !== "assistant" || !item.rounds) continue;
    for (let roundIndex = item.rounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
      const round = item.rounds[roundIndex];
      if (round?.meta?.contextRelevant === false) continue;
      const totalTokens =
        positiveTokenCount(round?.meta?.contextUsageTokens) ??
        positiveTokenCount(round?.meta?.usageTotalTokens);
      if (totalTokens !== undefined) {
        return totalTokens + trailingTokens + estimateRoundTokens(round, true);
      }
      trailingTokens += estimateRoundTokens(round, false);
    }
  }
  return trailingTokens > 0 ? trailingTokens : undefined;
}
