/**
 * 存量会话的降级推导：`UiMessage[]` → 账本。
 *
 * 轨迹功能上线前的会话没有事件日志。这条路径从消息本身重建结构——turn 按用户消息
 * 边界切，step 按 round 切，工具按 callId 配对——但**没有任何时间信息**。
 *
 * `hasTiming: false` 是给 UI 的硬信号：甘特图必须锁在 sequence 投影，Duration 按钮
 * 置灰。绝不伪造耗时：从消息 timestamp 差分推出来的「耗时」在并行工具批次上是错的，
 * 一个看起来精确但实际错误的数字比一个诚实的空值有害得多。
 */

import type { UiMessage } from "../chat/uiMessages";
import { getRoundToolTrace } from "../chat/uiMessages";
import { trajectoryTurnByMessageId, walkTrajectoryTurns } from "./contentIndex";
import type {
  LedgerStep,
  LedgerToolCall,
  LedgerTurn,
  TrajectoryLedger,
  TrajectoryUsage,
} from "./types";

type UsageLike = {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
};

function normalizeUsage(value: unknown): TrajectoryUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const usage = value as UsageLike;
  const picked: TrajectoryUsage = {};
  if (typeof usage.totalTokens === "number") picked.totalTokens = usage.totalTokens;
  if (typeof usage.input === "number") picked.input = usage.input;
  if (typeof usage.output === "number") picked.output = usage.output;
  if (typeof usage.cacheRead === "number") picked.cacheRead = usage.cacheRead;
  if (typeof usage.cacheWrite === "number") picked.cacheWrite = usage.cacheWrite;
  if (typeof usage.reasoning === "number") picked.reasoning = usage.reasoning;
  return Object.keys(picked).length === 0 ? undefined : picked;
}

/**
 * 从消息序列推导降级账本。
 *
 * @param messages - 会话的 UI 消息序列。
 * @returns 结构完整、时间全为 null 的账本。
 */
export function deriveLedgerFromMessages(
  messages: readonly UiMessage[],
  authoritativeLedger?: TrajectoryLedger,
): TrajectoryLedger {
  const turns: LedgerTurn[] = [];
  const authoritativeTurns = trajectoryTurnByMessageId(authoritativeLedger);

  for (const entry of walkTrajectoryTurns(messages, authoritativeTurns)) {
    const steps: LedgerStep[] = [];
    for (const assistant of entry.assistants) {
      for (const round of assistant.rounds ?? []) {
        const tools: LedgerToolCall[] = getRoundToolTrace(round).map((item) => ({
          callId: item.toolCall.id,
          name: item.toolCall.name,
          startedAt: null,
          endedAt: null,
          // 消息里只有终态，没有中间态：有结果即完成，无结果即被中断。
          status:
            item.toolResult === undefined
              ? "aborted"
              : item.toolResult.isError
                ? "error"
                : "complete",
          isError: item.toolResult?.isError === true,
          subagentRunIds: [],
        }));
        const usage = normalizeUsage(round.meta?.usage);
        steps.push({
          turn: entry.turn,
          step: round.round,
          startedAt: null,
          firstTokenAt: null,
          endedAt: null,
          status: "complete",
          ...(round.meta?.provider === undefined ? {} : { provider: round.meta.provider }),
          ...(round.meta?.model === undefined ? {} : { model: round.meta.model }),
          ...(round.meta?.api === undefined ? {} : { api: round.meta.api }),
          ...(round.meta?.stopReason === undefined ? {} : { stopReason: round.meta.stopReason }),
          ...(usage === undefined ? {} : { usage }),
          retries: [],
          tools,
        });
      }
    }

    turns.push({
      turn: entry.turn,
      startedAt: null,
      endedAt: null,
      status: "complete",
      inputs:
        entry.user === undefined
          ? []
          : [
              {
                kind: "user",
                turn: entry.turn,
                at: null,
                ...(entry.user.messageIndex === undefined
                  ? {}
                  : { messageIndex: entry.user.messageIndex }),
                ...(entry.user.messageId === undefined ? {} : { messageId: entry.user.messageId }),
                ...(entry.user.text === "" ? {} : { text: entry.user.text }),
              },
            ],
      steps,
      compactions: [],
    });
  }

  return {
    turns,
    headers: new Map(),
    standaloneCompactions: [],
    hasTiming: false,
  };
}

/**
 * Preserve pre-trajectory turns from loaded messages while using recorded events as authority for
 * every turn they cover. This matters when an old conversation receives new turns after upgrade.
 */
export function mergeTrajectoryLedgerWithMessages(
  recorded: TrajectoryLedger,
  messages: readonly UiMessage[],
): TrajectoryLedger {
  const derived = deriveLedgerFromMessages(messages, recorded);
  const recordedTurns = new Map(recorded.turns.map((turn) => [turn.turn, turn]));
  for (const turn of derived.turns) {
    if (!recordedTurns.has(turn.turn)) recordedTurns.set(turn.turn, turn);
  }
  return {
    ...recorded,
    turns: [...recordedTurns.values()].sort((left, right) => left.turn - right.turn),
  };
}
