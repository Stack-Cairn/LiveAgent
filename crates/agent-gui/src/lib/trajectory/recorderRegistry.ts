/**
 * 会话级 recorder 与 prompt 分段持有者的注册表。
 *
 * recorder 必须跨轮存活：header 去重靠的就是「上一份 refs」这份状态，每轮新建
 * 会让每一轮都产生一份全新快照，分段去重立刻失效。
 *
 * 用模块级注册表而不是 React state，与 `memoryExtraction` 控制器同构——运行时
 * 状态不该随组件重渲染重建。
 */

import {
  createPreparedSystemPromptSlotHolder,
  type PreparedSystemPromptSlots,
} from "../../pages/chat/runtime/conversationContextBuilders";
import { appendDesktopLiveTrajectory, clearDesktopLiveTrajectory } from "./liveTrajectory";
import {
  createTrajectoryRecorder,
  scopeTrajectoryRecorder,
  type TrajectoryRecorder,
} from "./recorder";
import {
  createTauriTrajectoryPorts,
  resolvePersistedTrajectoryTurnNumber,
  type TrajectoryPublish,
} from "./tauriPorts";

type Entry = {
  recorder: TrajectoryRecorder;
  slots: ReturnType<typeof createPreparedSystemPromptSlotHolder>;
  /** 当前活动 segment；每轮更新，recorder 通过闭包读它。 */
  segmentIndex: number;
  /** 当前回合的实时下发通道；同样每轮更新。 */
  publish: TrajectoryPublish | undefined;
};

const entries = new Map<string, Entry>();

/**
 * 取得（必要时创建）某会话的 recorder 与分段持有者。
 *
 * segmentIndex 与 publish 都走可变字段而不是构造期的闭包：recorder 跨轮存活，
 * 构造期闭包会把第一轮的 state 与 bridge 钉死，后续轮次的事件就会写进错误的
 * segment、或者发到已经关掉的通道上。
 *
 * @param conversationId - 会话 id。
 * @param segmentIndex - 本轮的活动 segment 下标。
 * @param publish - 本轮的实时下发回调；未连 Gateway 时可省略。
 * @returns 该会话的 recorder 与分段读取器。
 */
export function acquireTrajectoryRecorder(
  conversationId: string,
  segmentIndex: number,
  publish?: TrajectoryPublish,
  turn?: number,
): { recorder: TrajectoryRecorder; readSlots: () => PreparedSystemPromptSlots } {
  const existing = entries.get(conversationId);
  if (existing !== undefined) {
    existing.segmentIndex = segmentIndex;
    existing.publish = publish;
    return {
      recorder:
        turn === undefined
          ? existing.recorder
          : scopeTrajectoryRecorder(existing.recorder, turn, () => {
              // Recorder calls are synchronous. Select the matching bridge immediately before
              // each event so an old run cannot publish late events through a replacement run.
              existing.publish = publish;
            }),
      readSlots: existing.slots.read,
    };
  }
  const slots = createPreparedSystemPromptSlotHolder();
  const entry: Entry = {
    slots,
    segmentIndex,
    publish,
    recorder: createTrajectoryRecorder({
      conversationId,
      getSegmentIndex: () => entries.get(conversationId)?.segmentIndex ?? segmentIndex,
      ports: createTauriTrajectoryPorts((events) => {
        appendDesktopLiveTrajectory(conversationId, events);
        entries.get(conversationId)?.publish?.(events);
      }),
    }),
  };
  entries.set(conversationId, entry);
  return {
    recorder:
      turn === undefined
        ? entry.recorder
        : scopeTrajectoryRecorder(entry.recorder, turn, () => {
            entry.publish = publish;
          }),
    readSlots: slots.read,
  };
}

/** 供上下文构建器写入分段原文。 */
export function trajectorySlotCapture(
  conversationId: string,
): ((slots: PreparedSystemPromptSlots) => void) | undefined {
  return entries.get(conversationId)?.slots.capture;
}

/** Move subsequent events to the segment produced by a completed compaction. */
export function updateTrajectoryRecorderSegment(
  conversationId: string,
  segmentIndex: number,
): void {
  const entry = entries.get(conversationId);
  if (entry === undefined || !Number.isFinite(segmentIndex)) return;
  entry.segmentIndex = Math.max(0, Math.trunc(segmentIndex));
}

/** 会话关闭或 edit-resend 前释放；最后一次落盘由 recorder 自己完成。 */
export async function releaseTrajectoryRecorder(conversationId: string): Promise<void> {
  const key = conversationId.trim();
  const entry = entries.get(key);
  if (entry === undefined) return;
  entries.delete(key);
  await entry.recorder.dispose();
  // dispose 已把缓冲落盘；本进程不再持有该会话的实时尾巴。清掉 live 缓存后，
  // 视图层会把持久化里仍 running 的遗留条目收敛为 aborted，而不是永远挂运行中。
  clearDesktopLiveTrajectory(key);
}

/** 会话已删除或缓存被淘汰时直接废弃，避免向已删除 segment 做最后一次写入。 */
export function discardTrajectoryRecorder(conversationId: string): void {
  const key = conversationId.trim();
  const entry = entries.get(key);
  if (entry !== undefined) {
    entries.delete(key);
    entry.recorder.discard();
  }
  clearDesktopLiveTrajectory(key);
}

/**
 * Resolve the absolute turn number from all persisted segments.
 *
 * A history window may contain only the tail, so counting visible transcript rows can reuse
 * an old turn number and merge unrelated events. The backend also advances past the highest
 * persisted trajectory turn, so a high fallback turn remains monotonic after IPC recovers.
 */
export async function resolveTrajectoryTurnNumber(params: {
  conversationId: string;
  currentUserPersisted: boolean;
  fallbackTurn: number;
}): Promise<number> {
  try {
    return await resolvePersistedTrajectoryTurnNumber(
      params.conversationId,
      params.currentUserPersisted,
    );
  } catch (error) {
    console.warn("[trajectory] failed to resolve persisted turn; using safe fallback", error);
    return Math.max(1, Math.trunc(params.fallbackTurn) || 1);
  }
}
