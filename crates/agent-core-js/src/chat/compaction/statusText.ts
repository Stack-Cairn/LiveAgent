import { type CompactionPressure, isNearModelLimit } from "./policy";
import type { CompactionDecision } from "./types";

export const PRUNE_FALLBACK_NOTICE = "压缩失败，已回退到 prune 降级";

export function buildCompactionRunningStatus(
  decision: CompactionDecision,
  pressure: CompactionPressure,
) {
  const detail = `（判定 ${decision.totalTokens}/${decision.contextWindow} tokens）`;
  const base =
    decision.thresholdMode === "context-window"
      ? `上下文已达到窗口上限${detail}，正在压缩${decision.intent === "optimization" ? "历史" : "并恢复"}...`
      : decision.intent === "optimization"
        ? `上下文接近上限${detail}，正在压缩历史...`
        : `上下文接近保护阈值${detail}，正在压缩并恢复...`;
  // 升级阶梯顶格时给建议性提示（替代旧硬顶的强制"开启新会话"），但从不阻断。
  return isNearModelLimit(pressure) ? `${base} 上下文已接近模型极限，建议适时开启新会话。` : base;
}

export function buildPruneFallbackStatus(prunedMessageCount: number) {
  return `上下文压缩失败，已裁剪 ${prunedMessageCount} 个旧工具输出后继续...`;
}
