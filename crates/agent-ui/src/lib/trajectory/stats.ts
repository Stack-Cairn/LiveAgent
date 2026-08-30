/**
 * 会话累计统计的聚合层。
 *
 * 吃 `buildTrajectoryLedger` 的收敛产物——去重、乱序、重复回放的脏活全在账本层
 * 做完了，这里只做纯算术。运行中的 step/tool 不把 `now` 折进已完成时长，而是回传
 * `*RunningSinceAt` 让展示层用心跳补齐，聚合结果因此保持纯函数、可缓存。
 */

import type { TrajectoryLedger } from "./types";

export type ConversationStats = {
  turns: number;
  steps: number;
  /** 已完成 step 的累计时长，不含运行中的那段。 */
  llmMs: number;
  /** 运行中 step 的起点；展示层用 `now − 该值` 补齐。 */
  llmRunningSinceAt: number | null;
  toolMs: number;
  toolRunningSinceAt: number | null;
  ttftAvgMs: number | null;
  ttftSamples: number;
  decodeTokPerSec: number | null;
  cacheHitRatio: number | null;
  /** prompt 总量：input + cacheRead + cacheWrite，与账单口径一致。 */
  inputTokens: number;
  outputTokens: number;
  compactions: number;
  /** 事件被截断或未加载完时为 true，展示层加 "≈" 前缀。 */
  approximate: boolean;
};

export const EMPTY_CONVERSATION_STATS: ConversationStats = {
  turns: 0,
  steps: 0,
  llmMs: 0,
  llmRunningSinceAt: null,
  toolMs: 0,
  toolRunningSinceAt: null,
  ttftAvgMs: null,
  ttftSamples: 0,
  decodeTokPerSec: null,
  cacheHitRatio: null,
  inputTokens: 0,
  outputTokens: 0,
  compactions: 0,
  approximate: false,
};

function positiveSpan(from: number | null, to: number | null): number {
  if (from === null || to === null) return 0;
  const span = to - from;
  return span > 0 ? span : 0;
}

/** 多个运行段取最早起点：展示的是「已经跑了多久」，不是最后一段跑了多久。 */
function earlier(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return candidate < current ? candidate : current;
}

function tokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function aggregateTrajectoryStats(
  ledger: TrajectoryLedger,
  options: { approximate?: boolean } = {},
): ConversationStats {
  let steps = 0;
  let llmMs = 0;
  let llmRunningSinceAt: number | null = null;
  let toolMs = 0;
  let toolRunningSinceAt: number | null = null;
  let ttftTotalMs = 0;
  let ttftSamples = 0;
  let decodeTokens = 0;
  let decodeMs = 0;
  let promptTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let compactions = ledger.standaloneCompactions.length;

  for (const turn of ledger.turns) {
    compactions += turn.compactions.length;
    for (const step of turn.steps) {
      steps += 1;

      // 只有 status 才能开心跳：账本把崩溃遗留的 step 收敛成 aborted 却不补
      // endedAt，按 endedAt 判定会让已死会话永远走秒表。
      if (step.status === "running") {
        llmRunningSinceAt = earlier(llmRunningSinceAt, step.startedAt);
      } else {
        llmMs += positiveSpan(step.startedAt, step.endedAt);
      }

      if (step.firstTokenAt !== null && step.startedAt !== null) {
        const ttft = positiveSpan(step.startedAt, step.firstTokenAt);
        ttftTotalMs += ttft;
        ttftSamples += 1;
      }

      for (const tool of step.tools) {
        if (tool.status === "running") {
          toolRunningSinceAt = earlier(toolRunningSinceAt, tool.startedAt);
        } else {
          toolMs += positiveSpan(tool.startedAt, tool.endedAt);
        }
      }

      const usage = step.usage;
      if (usage === undefined) continue;

      const input = tokenCount(usage.input);
      const cacheRead = tokenCount(usage.cacheRead);
      const cacheWrite = tokenCount(usage.cacheWrite);
      const output = tokenCount(usage.output);

      promptTokens += input + cacheRead + cacheWrite;
      cacheReadTokens += cacheRead;
      outputTokens += output;

      // 解码窗口：首 token 之后到结束。缺 firstTokenAt 时退回整段，非正数不计入。
      if (output > 0 && step.endedAt !== null) {
        const window =
          step.firstTokenAt !== null
            ? positiveSpan(step.firstTokenAt, step.endedAt)
            : positiveSpan(step.startedAt, step.endedAt);
        if (window > 0) {
          decodeTokens += output;
          decodeMs += window;
        }
      }
    }
  }

  return {
    turns: ledger.turns.length,
    steps,
    llmMs,
    llmRunningSinceAt,
    toolMs,
    toolRunningSinceAt,
    ttftAvgMs: ttftSamples > 0 ? ttftTotalMs / ttftSamples : null,
    ttftSamples,
    decodeTokPerSec: decodeMs > 0 ? (decodeTokens * 1000) / decodeMs : null,
    cacheHitRatio: promptTokens > 0 ? cacheReadTokens / promptTokens : null,
    inputTokens: promptTokens,
    outputTokens,
    compactions,
    approximate: options.approximate === true,
  };
}

/** 状态栏是否有任何可展示内容——全零（老会话、text 模式）时整条隐藏。 */
export function hasConversationStats(stats: ConversationStats | null): boolean {
  if (stats === null) return false;
  return stats.turns > 0 || stats.steps > 0;
}

/** 把运行段按 `now` 折算进显示用时长。 */
export function resolveStatDurations(
  stats: ConversationStats,
  now: number,
): { llmMs: number; toolMs: number } {
  return {
    llmMs: stats.llmMs + positiveSpan(stats.llmRunningSinceAt, now),
    toolMs: stats.toolMs + positiveSpan(stats.toolRunningSinceAt, now),
  };
}

/** `< 60s → 42s`、`< 60min → 12m34s`、`≥ 60min → 5h06m`。 */
export function formatStatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/** TTFT 保留一位小数：`20.9s`；不足 1s 时用毫秒避免显示成 `0.0s`。 */
export function formatStatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatStatTokens(value: number, locale: string): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: value < 1000 ? 0 : 1,
  }).format(Math.round(value));
}

export function formatStatCount(value: number, locale: string): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return new Intl.NumberFormat(locale).format(Math.round(value));
}

export function formatStatThroughput(tokPerSec: number): string {
  if (!Number.isFinite(tokPerSec) || tokPerSec <= 0) return "0";
  return String(Math.round(tokPerSec));
}

export function formatStatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "0";
  return String(Math.round(ratio * 100));
}
