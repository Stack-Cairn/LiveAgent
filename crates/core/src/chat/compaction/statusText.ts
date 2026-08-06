import type { ToolStatus } from "../../protocol/wireEvents";
import { type CompactionPressure, isNearModelLimit } from "./policy";
import type { CompactionDecision } from "./types";

export const PRUNE_FALLBACK_NOTICE = "压缩失败，已回退到 prune 降级";

export function buildCompactionRunningStatus(
  decision: CompactionDecision,
  pressure: CompactionPressure,
): ToolStatus {
  return {
    kind: "compaction_running",
    threshold_mode: decision.thresholdMode,
    intent: decision.intent,
    total_tokens: decision.totalTokens,
    context_window: decision.contextWindow,
    // 升级阶梯顶格时前端追加建议性提示（替代旧硬顶的强制"开启新会话"），但从不阻断。
    near_model_limit: isNearModelLimit(pressure),
  };
}

export function buildPruneFallbackStatus(prunedMessageCount: number): ToolStatus {
  return { kind: "compaction_prune_fallback", pruned_message_count: prunedMessageCount };
}
