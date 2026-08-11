// 上下文用量的两端单一真源：颜色分档阈值、手动压缩门槛、以及从 transcript
// 倒扫得出"当前上下文占用 token"的口径。GUI 与 WebUI 的用量环都从这里取数，
// 保证读数与可压缩判定不因宿主而漂移。
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
export type ContextUsageScanItem = {
  kind: string;
  rounds?: readonly { meta?: { usageTotalTokens?: number } }[];
  content?: string;
};

/**
 * 倒扫 transcript 求当前上下文占用：最近一个 assistant 轮次的真实 API usage
 * 即读数（usage.totalTokens 已含 system/tools/全部历史）。若先遇到压缩检查点，
 * 说明检查点之后尚无新回复——用检查点摘要正文的估算值兜底（方向正确不误导，
 * 下一轮真实 usage 到来后自动校准），而不是让环归零/消失。
 */
export function deriveContextUsageTokens(
  items: readonly ContextUsageScanItem[],
): number | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "summary" || item.kind === "checkpoint") {
      return typeof item.content === "string" ? estimateTextTokens(item.content) : undefined;
    }
    if (item.kind !== "assistant" || !item.rounds) continue;
    for (let roundIndex = item.rounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
      const totalTokens = item.rounds[roundIndex]?.meta?.usageTotalTokens;
      if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
        return totalTokens;
      }
    }
  }
  return undefined;
}
