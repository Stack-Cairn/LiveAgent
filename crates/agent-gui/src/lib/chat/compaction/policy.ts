import { canManualCompact, contextUsageRatio } from "@liveagent/ui/lib/chat/contextUsage";
import type { ProviderModelConfig, ReasoningLevel } from "../../settings";
import type { CompactionDecisionReason, CompactionTrigger } from "./types";

// ============================================================================
// 限额与决策。
//
// W = 目录 contextWindow（含输出），O = maxOutputToken（主请求 max_tokens = O）：
//   inputCap = W − O                       Anthropic 要求 input + max_tokens ≤ W；OpenAI 有独立输入上限
//   reserve  = clamp(⌊0.05W⌋, 4k, 20k)     两次 usage 锚点之间的估算漂移
//   hard     = inputCap − reserve          达到即 mustProgress
//   soft     = hard − clamp(⌊0.05W⌋, 4k, 16k)   唯一的自动触发线
// ============================================================================

export type CompactionLimits = {
  inputCap: number;
  reserve: number;
  hard: number;
  soft: number;
};

// fork 在主请求上下文之后追加一条指令：给它留出余量，同一窗口才不会拒收。
const FORK_INSTRUCTION_RESERVE_TOKENS = 2_000;
// fixed（system + tools + 边界追加段）距 soft 不足这么多时，压缩腾不出有效空间。
const PREFIX_HEADROOM_TOKENS = 20_000;
// 连续失败达到它即熔断（仅 [soft, hard) 区间）。
const CIRCUIT_FAILURE_STREAK = 2;
// 保留原话的总预算上限（Codex 风格）；调用方给出的预算一律钳到 [0, 上限]。
export const RETAINED_USER_MESSAGES_MAX_TOKENS = 20_000;

/** 摘要流的空闲看门狗：有内容之后两个事件间的最长间隔。 */
export const IDLE_TIMEOUT_MS = 180_000;
/** 手动压缩的总时限：低于 WebUI 5 分钟的 pending 超时。 */
export const DEADLINE_MANUAL_MS = 270_000;
export const DEADLINE_AUTO_MS = 600_000;
/** 距总时限不足它时不再进入 transcript 档。 */
export const TRANSCRIPT_MIN_REMAINING_MS = 45_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveCompactionLimits(params: {
  contextWindow: number;
  maxOutputToken: number;
}): CompactionLimits {
  const contextWindow = Math.max(0, Math.floor(params.contextWindow));
  const margin = Math.floor(0.05 * contextWindow);
  const inputCap = contextWindow - Math.max(0, Math.floor(params.maxOutputToken));
  const reserve = clamp(margin, 4_000, 20_000);
  const hard = inputCap - reserve;
  return { inputCap, reserve, hard, soft: hard - clamp(margin, 4_000, 16_000) };
}

export function forkFits(totalTokens: number, limits: CompactionLimits): boolean {
  return totalTokens + FORK_INSTRUCTION_RESERVE_TOKENS <= limits.inputCap;
}

export type CompactionStage = "fork" | "transcript";

export type CompactionVerdict =
  | {
      shouldCompact: false;
      reason: CompactionDecisionReason;
      totalTokens: number;
      limits: CompactionLimits;
    }
  | {
      shouldCompact: true;
      reason: "threshold-exceeded";
      totalTokens: number;
      limits: CompactionLimits;
      /** ≥ hard 或溢出：必须产出 checkpoint，自动触发的降级梯可走到 deterministic。 */
      mustProgress: boolean;
      startAt: CompactionStage;
    };

/**
 * 纯决策，按序判断：disabled → no-active-messages → in-flight → manual（50% 门槛）
 * → overflow（mustProgress，从 transcript 开始）→ below-threshold → prefix-too-large
 * → circuit-open → 压缩。熔断与防抖动只拦 [soft, hard)：≥ hard 不受它们拦截
 *（prefix-too-large 除外，压缩腾不出空间），never hard-reject。
 */
export function decideCompaction(params: {
  trigger: CompactionTrigger;
  totalTokens: number;
  /** 账本的 fixed（system + tools + 边界追加段）。 */
  fixedTokens: number;
  modelConfig?: ProviderModelConfig;
  activeMessageCount: number;
  inFlight: boolean;
  failureStreak: number;
  thrashing: boolean;
}): CompactionVerdict {
  const contextWindow = Math.max(0, Math.floor(params.modelConfig?.contextWindow ?? 0));
  const maxOutputToken = Math.max(0, Math.floor(params.modelConfig?.maxOutputToken ?? 0));
  const totalTokens = Math.max(0, Math.floor(params.totalTokens));
  const limits = resolveCompactionLimits({ contextWindow, maxOutputToken });
  const skip = (reason: CompactionDecisionReason): CompactionVerdict => ({
    shouldCompact: false,
    reason,
    totalTokens,
    limits,
  });
  const compact = (mustProgress: boolean, startAt: CompactionStage): CompactionVerdict => ({
    shouldCompact: true,
    reason: "threshold-exceeded",
    totalTokens,
    limits,
    mustProgress,
    startAt,
  });

  if (contextWindow <= 0 || maxOutputToken <= 0) return skip("disabled");
  if (params.activeMessageCount <= 0) return skip("no-active-messages");
  if (params.inFlight) return skip("in-flight");
  const startAt = forkFits(totalTokens, limits) ? "fork" : "transcript";
  if (params.trigger === "manual") {
    return canManualCompact(contextUsageRatio(totalTokens, contextWindow))
      ? compact(false, startAt)
      : skip("below-manual-threshold");
  }
  // 同样的输入必然再次溢出，fork 没有意义。
  if (params.trigger === "overflow") return compact(true, "transcript");
  if (totalTokens < limits.soft) return skip("below-threshold");
  // 压缩帮不上忙：让溢出错误自然暴露。
  if (params.fixedTokens + PREFIX_HEADROOM_TOKENS >= limits.soft) return skip("prefix-too-large");
  if (
    totalTokens < limits.hard &&
    (params.failureStreak >= CIRCUIT_FAILURE_STREAK || params.thrashing)
  ) {
    return skip("circuit-open");
  }
  return compact(totalTokens >= limits.hard, startAt);
}

/**
 * 保留原话预算 B = clamp(⌊0.5·soft⌋ − fixed − summary, 0, 20k)：压缩后上下文
 * ≈ fixed + summary + B 稳在 soft 一半以下；thrashing 时为 0，否则保留集被逐次
 * 带进下一份 checkpoint 压在阈值上。
 */
export function retainedBudgetTokens(
  soft: number,
  fixedTokens: number,
  summaryTokens: number,
  thrashing: boolean,
): number {
  if (thrashing) return 0;
  const budget = Math.floor(0.5 * soft) - Math.max(0, fixedTokens) - Math.max(0, summaryTokens);
  return Number.isFinite(budget) ? clamp(budget, 0, RETAINED_USER_MESSAGES_MAX_TOKENS) : 0;
}

/**
 * 首个内容事件的预算：按冷缓存保守估算（post-tool fork 在不跨轮保留 thinking 的
 * Claude 上只能命中到最后一条真实用户消息；首 token 前的 ping / SSE 注释也不产生
 * 事件）。60s + 30s/100k 输入，high 及以上推理再加 60s，上限 300s。
 */
export function firstEventBudgetMs(
  inputTokens: number,
  reasoningLevel: ReasoningLevel | undefined,
): number {
  const perHundredK = Math.ceil(Math.max(0, inputTokens) / 100_000);
  const reasoningMs =
    reasoningLevel === "high" || reasoningLevel === "xhigh" || reasoningLevel === "max"
      ? 60_000
      : 0;
  return Math.min(300_000, 60_000 + 30_000 * perHundredK + reasoningMs);
}

const FATAL_PROVIDER_ERROR_PATTERN =
  /\b40[123]\b|unauthori[sz]ed|forbidden|payment required|invalid.{0,10}api.?key|insufficient_quota|quota exceeded|billing/i;

/** 鉴权 / 配额类错误：主请求同样会失败，有损的 deterministic checkpoint 换不来任何东西。 */
export function isFatalProviderError(message: string | undefined): boolean {
  return FATAL_PROVIDER_ERROR_PATTERN.test(message ?? "");
}
