import type { ProviderId, ProviderModelConfig } from "../../settings";
import type { CompactionDecision, CompactionIntent } from "./types";

export const OPTIMIZATION_THRESHOLD_FACTOR = 1.5;
export const PROTECTION_THRESHOLD_FACTOR = 1.2;
export const MIN_COMPACTION_INTERVAL_MS = 60_000;
export const MIN_COMPACTION_USER_MESSAGES = 3;
export const RECENT_COMPACTION_WINDOW_MS = 5 * 60_000;
// 压缩后仍高于阈值的 90% 视为"低效压缩"，推动压力升级。
export const INEFFECTIVE_COMPACTION_RATIO = 0.9;
export const MAX_PRESSURE_LEVEL = 2;

export const PRUNE_MINIMUM_TOKENS = 20_000;
const PRUNE_PROTECT_TOKENS_BY_LEVEL = [40_000, 20_000, 10_000] as const;
const PRUNE_PROTECT_USER_TURNS_BY_LEVEL = [2, 2, 1] as const;

export type PressureLevel = 0 | 1 | 2;

/**
 * 压力升级阶梯：替代旧的 MAX_SESSION_COMPACTIONS 硬顶。连续低效压缩推高
 * level（加大 prune 力度、收紧保护阈值、给出建议性提示），但永不硬性拒绝。
 * 纯数据 + 纯转移函数，由 controller 持有并推进。
 */
export type CompactionPressure = {
  level: PressureLevel;
  consecutiveIneffective: number;
  compactionsApplied: number;
  lastCompactionAt: number;
};

export function createCompactionPressure(): CompactionPressure {
  return {
    level: 0,
    consecutiveIneffective: 0,
    compactionsApplied: 0,
    lastCompactionAt: 0,
  };
}

export function normalizeCompactionPressure(
  pressure: CompactionPressure,
  now: number,
): CompactionPressure {
  if (
    pressure.lastCompactionAt > 0 &&
    now - pressure.lastCompactionAt > RECENT_COMPACTION_WINDOW_MS &&
    (pressure.level > 0 || pressure.consecutiveIneffective > 0)
  ) {
    return { ...pressure, level: 0, consecutiveIneffective: 0 };
  }
  return pressure;
}

export function notePressureAfterCompaction(
  pressure: CompactionPressure,
  params: { totalTokensAfter: number; threshold: number; now: number },
): CompactionPressure {
  const ineffective =
    params.threshold > 0 &&
    params.totalTokensAfter > params.threshold * INEFFECTIVE_COMPACTION_RATIO;
  const consecutiveIneffective = ineffective ? pressure.consecutiveIneffective + 1 : 0;
  return {
    level: Math.min(MAX_PRESSURE_LEVEL, consecutiveIneffective) as PressureLevel,
    consecutiveIneffective,
    compactionsApplied: pressure.compactionsApplied + 1,
    lastCompactionAt: params.now,
  };
}

export function shouldPruneBeforeCompaction(pressure: CompactionPressure, now: number): boolean {
  if (pressure.level >= 1) return true;
  return (
    pressure.lastCompactionAt > 0 && now - pressure.lastCompactionAt <= RECENT_COMPACTION_WINDOW_MS
  );
}

export function isNearModelLimit(pressure: CompactionPressure): boolean {
  return pressure.level >= MAX_PRESSURE_LEVEL;
}

export type PruneOptions = {
  minimumReleasedTokens: number;
  protectedToolTokens: number;
  protectedRecentUserTurns: number;
};

export function resolvePruneOptions(pressure: CompactionPressure): PruneOptions {
  return {
    minimumReleasedTokens: PRUNE_MINIMUM_TOKENS,
    protectedToolTokens: PRUNE_PROTECT_TOKENS_BY_LEVEL[pressure.level],
    protectedRecentUserTurns: PRUNE_PROTECT_USER_TURNS_BY_LEVEL[pressure.level],
  };
}

export function resolveCompactionThreshold(params: {
  providerId: ProviderId;
  intent: CompactionIntent;
  contextWindow: number;
  maxOutputToken: number;
  pressureLevel: PressureLevel;
}): { threshold: number; thresholdMode: CompactionDecision["thresholdMode"] } {
  if (params.providerId === "codex") {
    return { threshold: params.contextWindow, thresholdMode: "context-window" };
  }

  const factor =
    params.intent === "optimization" ? OPTIMIZATION_THRESHOLD_FACTOR : PROTECTION_THRESHOLD_FACTOR;
  const effectiveFactor =
    params.intent === "protection" && params.pressureLevel >= MAX_PRESSURE_LEVEL ? 1.0 : factor;
  return {
    threshold: Math.max(
      1024,
      Math.floor(params.contextWindow - params.maxOutputToken * effectiveFactor),
    ),
    thresholdMode: "buffered-reserve",
  };
}

export function decideCompaction(params: {
  providerId: ProviderId;
  intent: CompactionIntent;
  totalTokens: number;
  modelConfig?: ProviderModelConfig;
  activeMessageCount: number;
  userMessageCount: number;
  // 上一次 checkpoint 的时间（无则 0）；controller 传 max(段 summary 时间, 压力 lastCompactionAt)。
  lastCompactionAt: number;
  pressure: CompactionPressure;
  inFlight: boolean;
  now: number;
}): CompactionDecision {
  const contextWindow = Math.max(0, Math.floor(params.modelConfig?.contextWindow ?? 0));
  const maxOutputToken = Math.max(0, Math.floor(params.modelConfig?.maxOutputToken ?? 0));

  const base = {
    intent: params.intent,
    totalTokens: Math.max(0, Math.floor(params.totalTokens)),
    contextWindow,
    maxOutputToken,
  };

  if (contextWindow <= 0 || maxOutputToken <= 0) {
    return {
      ...base,
      shouldCompact: false,
      reason: "disabled",
      threshold: 0,
      thresholdMode: "buffered-reserve",
    };
  }

  const { threshold, thresholdMode } = resolveCompactionThreshold({
    providerId: params.providerId,
    intent: params.intent,
    contextWindow,
    maxOutputToken,
    pressureLevel: params.pressure.level,
  });

  if (params.activeMessageCount <= 0) {
    return {
      ...base,
      shouldCompact: false,
      reason: "no-active-messages",
      threshold,
      thresholdMode,
    };
  }

  if (params.inFlight) {
    return { ...base, shouldCompact: false, reason: "in-flight", threshold, thresholdMode };
  }

  if (base.totalTokens < threshold) {
    return { ...base, shouldCompact: false, reason: "below-threshold", threshold, thresholdMode };
  }

  // 冷却窗只拦"刚压缩完又立即越阈值"的超大单轮；正常自触发已被账本重置阻断。
  if (
    params.lastCompactionAt > 0 &&
    params.now - params.lastCompactionAt < MIN_COMPACTION_INTERVAL_MS &&
    params.userMessageCount < MIN_COMPACTION_USER_MESSAGES
  ) {
    return { ...base, shouldCompact: false, reason: "cooldown", threshold, thresholdMode };
  }

  return { ...base, shouldCompact: true, reason: "threshold-exceeded", threshold, thresholdMode };
}
